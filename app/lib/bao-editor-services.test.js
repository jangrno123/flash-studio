'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createBaoEditorServices, acquireStartLock, createProcessAdapter } = require('./bao-editor-services');

const PROJECT = 'bao-0443b11f18cd4a28aaf42c12cc964fdb';
const OTHER = 'bao-11111111111111111111111111111111';
const AUTH = 'neutral-token-secret', SITES = 'neutral-sites-secret';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-service-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, 'node.exe'); fs.writeFileSync(runtime, 'neutral runtime placeholder');
  const profiles = {};
  for (const service of ['renderer', 'decoder']) {
    const root = path.join(directory, service); fs.mkdirSync(path.join(root, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(root, 'artifacts'));
    const script = path.join(root, 'scripts', service === 'renderer' ? 'bao-editor-export-runner.mjs' : 'bao-editor-video-frames-runner.mjs');
    fs.writeFileSync(script, '// neutral placeholder; never executed');
    profiles[service] = { root, script, runtime, receipt: path.join(root, 'artifacts', 'service.json'), stdoutLog: path.join(root, 'artifacts', 'stdout.log'), stderrLog: path.join(root, 'artifacts', 'stderr.log') };
  }
  const profilePath = path.join(directory, 'profiles.json');
  fs.writeFileSync(profilePath, JSON.stringify({ schemaVersion: 1, profiles }));
  const processes = [], starts = []; let nextPid = 50000, authReads = 0;
  const adapter = {
    async listProcesses() { return structuredClone(processes); },
    async spawnWorker(profile, environment) {
      const pid = nextPid++; starts.push({ profile, environment, pid });
      processes.push({ pid, name: 'node.exe', executablePath: runtime, commandLine: `"${runtime}" "${profile.script}"` });
      return pid;
    }
  };
  const ctx = { store: { getMcpConfig() { authReads++; return { mcpServers: { 'bao-production': { url: 'https://neutral.example/api/lightbringer-mcp', headers: { Authorization: 'Bearer ' + AUTH, 'OAI-Sites-Authorization': 'Bearer ' + SITES } } } }; } } };
  function running(service, { relative = false, projectId = PROJECT, pid = nextPid++ } = {}) {
    const profile = profiles[service];
    fs.writeFileSync(profile.receipt, JSON.stringify({ pid, script: profile.script, root: profile.root, projectId, startedAt: new Date().toISOString() }));
    processes.push({ pid, name: 'node.exe', executablePath: runtime, commandLine: `"${runtime}" "${relative ? 'scripts/' + path.basename(profile.script) : profile.script}"` });
    return pid;
  }
  const manager = () => createBaoEditorServices({ profilePath, adapter, wait: async () => {}, lockOptions: { timeoutMs: 1000, pollMs: 5 } });
  return { directory, runtime, profiles, profilePath, processes, starts, adapter, ctx, running, manager, authReads: () => authReads };
}

test('status is read-only and recognizes current relative runners at receipt PID', async t => {
  const f = fixture(t), renderer = f.running('renderer', { relative: true }), decoder = f.running('decoder', { relative: true });
  const before = fs.readFileSync(f.profiles.renderer.receipt);
  const result = await f.manager()({ action: 'status', project_id: PROJECT }, f.ctx);
  assert.equal(result.structure.status, 'healthy');
  assert.deepEqual(result.structure.services.map(service => service.pid), [renderer, decoder]);
  assert.equal(f.authReads(), 0); assert.equal(f.starts.length, 0);
  assert.deepEqual(fs.readFileSync(f.profiles.renderer.receipt), before);
  assert.equal(fs.existsSync(f.profilePath + '.start.lock'), false);
});

test('start reuses live workers and does not read authentication or change receipts', async t => {
  const f = fixture(t); f.running('renderer', { relative: true }); f.running('decoder');
  const before = fs.readFileSync(f.profiles.renderer.receipt);
  const result = await f.manager()({ action: 'start', project_id: PROJECT }, f.ctx);
  assert.equal(result.structure.status, 'already_running');
  assert.ok(result.structure.services.every(service => service.status === 'already_running'));
  assert.equal(f.starts.length, 0); assert.equal(f.authReads(), 0);
  assert.deepEqual(fs.readFileSync(f.profiles.renderer.receipt), before);
});

test('start uses exact script and strict project env; receipts and output omit credentials', async t => {
  const f = fixture(t);
  const result = await f.manager()({ action: 'start', services: ['renderer'], project_id: PROJECT }, f.ctx);
  assert.equal(result.structure.status, 'started'); assert.equal(f.starts.length, 1);
  const started = f.starts[0];
  assert.equal(started.profile.script, f.profiles.renderer.script);
  assert.equal(started.environment.BAO_EDITOR_PROJECT_IDS, PROJECT);
  assert.equal(started.environment.BAO_PRODUCTION_MCP_TOKEN, AUTH);
  assert.equal(started.environment.BAO_SITES_AUTH_HEADER, 'Bearer ' + SITES);
  assert.equal(started.environment.BAO_MCP_URL, 'https://neutral.example/api/lightbringer-mcp');
  const receipt = fs.readFileSync(f.profiles.renderer.receipt, 'utf8');
  assert.equal(JSON.parse(receipt).projectId, PROJECT);
  assert.ok(!receipt.includes(AUTH) && !receipt.includes(SITES));
  assert.ok(!result.text.includes(AUTH) && !result.text.includes(SITES));
  assert.equal(fs.existsSync(f.profiles.decoder.receipt), false);
});

test('independent managers serialize simultaneous starts and create one worker per service', async t => {
  const f = fixture(t), first = f.manager(), second = f.manager();
  const results = await Promise.all([first({ action: 'start', project_id: PROJECT }, f.ctx), second({ action: 'start', project_id: PROJECT }, f.ctx)]);
  assert.deepEqual(results.map(result => result.structure.status).sort(), ['already_running', 'started']);
  assert.equal(f.starts.length, 2);
  assert.deepEqual(f.starts.map(start => start.profile.service).sort(), ['decoder', 'renderer']);
});

test('a different project scope blocks the complete start without touching live workers', async t => {
  const f = fixture(t); f.running('renderer', { projectId: OTHER });
  const result = await f.manager()({ action: 'start', project_id: PROJECT }, f.ctx);
  assert.equal(result.structure.status, 'error');
  assert.equal(result.structure.services[0].code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(f.starts.length, 0); assert.equal(f.authReads(), 0);
});

test('unregistered or duplicate live runners never cause an additional start', async t => {
  const f = fixture(t);
  f.processes.push({ pid: 77777, name: 'node.exe', executablePath: f.runtime, commandLine: `"${f.runtime}" "${f.profiles.renderer.script}"` });
  let result = await f.manager()({ action: 'start', services: ['renderer'], project_id: PROJECT }, f.ctx);
  assert.equal(result.structure.services[0].code, 'UNREGISTERED_WORKER');
  f.running('renderer');
  result = await f.manager()({ action: 'start', services: ['renderer'], project_id: PROJECT }, f.ctx);
  assert.equal(result.structure.services[0].code, 'MULTIPLE_WORKERS'); assert.equal(f.starts.length, 0);
});

test('a reused PID for an unrelated script is not treated as the registered worker', async t => {
  const f = fixture(t); const pid = f.running('renderer');
  f.processes.find(process => process.pid === pid).commandLine = `"${f.runtime}" "${path.join(f.directory, 'unrelated.js')}"`;
  const result = await f.manager()({ action: 'status', services: ['renderer'] }, f.ctx);
  assert.equal(result.structure.services[0].code, 'NOT_RUNNING');
  assert.equal(f.starts.length, 0);
});

test('Node flags, another runtime and unavailable process identity block duplicate starts', async t => {
  const f = fixture(t), pid = f.running('renderer');
  const process = f.processes.find(process => process.pid === pid), original = structuredClone(process);
  for (const change of [
    worker => { worker.commandLine = `"${f.runtime}" --no-warnings "${f.profiles.renderer.script}"`; },
    worker => { worker.executablePath = path.join(f.directory, 'other-node.exe'); },
    worker => { worker.executablePath = null; worker.commandLine = null; }
  ]) {
    Object.assign(process, original); change(process);
    const result = await f.manager()({ action: 'start', services: ['renderer'], project_id: PROJECT }, f.ctx);
    assert.equal(result.structure.services[0].code, 'WORKER_IDENTITY_UNCONFIRMED');
  }
  assert.equal(f.starts.length, 0);
});

test('known receipt PID can use ./scripts relative syntax while unregistered relative workers block starts', async t => {
  const f = fixture(t), pid = f.running('renderer', { relative: true });
  f.processes[0].commandLine = `"${f.runtime}" "./scripts/${path.basename(f.profiles.renderer.script)}"`;
  let result = await f.manager()({ action: 'start', services: ['renderer'], project_id: PROJECT }, f.ctx);
  assert.equal(result.structure.status, 'already_running');
  f.processes[0].pid = pid + 1;
  result = await f.manager()({ action: 'start', services: ['renderer'], project_id: PROJECT }, f.ctx);
  assert.equal(result.structure.services[0].code, 'UNREGISTERED_WORKER'); assert.equal(f.starts.length, 0);
});

test('fixed profile data receipt directory is allowed while arbitrary sibling files are rejected', async t => {
  const f = fixture(t), directory = path.join(f.directory, 'bao-editor-services'); fs.mkdirSync(directory);
  f.profiles.renderer.receipt = path.join(directory, 'renderer.json');
  fs.writeFileSync(f.profilePath, JSON.stringify({ schemaVersion: 1, profiles: f.profiles }));
  f.running('renderer', { relative: true });
  let result = await f.manager()({ action: 'status', services: ['renderer'] }, f.ctx);
  assert.equal(result.structure.status, 'healthy');
  f.profiles.renderer.receipt = path.join(directory, 'arbitrary.json');
  fs.writeFileSync(f.profilePath, JSON.stringify({ schemaVersion: 1, profiles: f.profiles }));
  result = await f.manager()({ action: 'status' }, f.ctx);
  assert.equal(result.structure.code, 'INVALID_PROFILE');
});

test('tool args cannot supply a command, path, invalid service or a project list', async t => {
  const f = fixture(t);
  for (const args of [
    { action: 'start' }, { action: 'start', project_id: PROJECT + ',' + OTHER },
    { action: 'start', project_id: PROJECT, command: 'anything' },
    { action: 'start', project_id: PROJECT, script: 'other.mjs' },
    { action: 'status', services: ['shell'] }, { action: 'status', services: ['renderer', 'renderer'] }, { action: 'restart', project_id: PROJECT }
  ]) assert.equal((await f.manager()(args, f.ctx)).structure.status, 'error');
  assert.equal(f.starts.length, 0); assert.equal(f.authReads(), 0);
});

test('profile path escape, a different script and runtime are rejected before process actions', async t => {
  const f = fixture(t); const original = JSON.parse(fs.readFileSync(f.profilePath));
  for (const change of [
    profile => { profile.script = path.join(f.directory, 'outside.mjs'); fs.writeFileSync(profile.script, '// neutral'); },
    profile => { profile.receipt = path.join(f.directory, 'outside.json'); },
    profile => { profile.runtime = path.join(f.directory, 'other.exe'); fs.writeFileSync(profile.runtime, 'neutral'); }
  ]) {
    const document = structuredClone(original); change(document.profiles.renderer); fs.writeFileSync(f.profilePath, JSON.stringify(document));
    assert.equal((await f.manager()({ action: 'start', project_id: PROJECT }, f.ctx)).structure.code, 'INVALID_PROFILE');
  }
  assert.equal(f.starts.length, 0);
});

test('missing authentication never starts a stopped worker and arbitrary errors stay redacted', async t => {
  const f = fixture(t); const bad = { store: { getMcpConfig() { throw new Error(AUTH); } } };
  let result = await f.manager()({ action: 'start', project_id: PROJECT }, bad);
  assert.equal(result.structure.code, 'BAO_AUTH_UNAVAILABLE'); assert.equal(f.starts.length, 0); assert.ok(!result.text.includes(AUTH));
  f.adapter.listProcesses = async () => { throw new Error(SITES); };
  result = await f.manager()({ action: 'status' }, f.ctx);
  assert.equal(result.structure.code, 'PROCESS_INSPECTION_FAILED'); assert.ok(!result.text.includes(SITES));
});

test('unknown spawn outcome returns an error and retains the receipt for safe reinspection', async t => {
  const f = fixture(t); f.adapter.spawnWorker = async () => 88888;
  const result = await f.manager()({ action: 'start', services: ['renderer'], project_id: PROJECT }, f.ctx);
  assert.equal(result.structure.services[0].code, 'START_UNCONFIRMED');
  assert.equal(JSON.parse(fs.readFileSync(f.profiles.renderer.receipt)).pid, 88888);
});

test('an uncertain live spawn is not duplicated by a follow-up start', async t => {
  const f = fixture(t); let spawnCount = 0;
  f.adapter.spawnWorker = async profile => {
    spawnCount++;
    f.processes.push({ pid: 88888, name: 'node.exe', executablePath: null, commandLine: `"${f.runtime}" "${profile.script}"` });
    return 88888;
  };
  const manager = f.manager();
  assert.equal((await manager({ action: 'start', services: ['renderer'], project_id: PROJECT }, f.ctx)).structure.services[0].code, 'START_UNCONFIRMED');
  assert.equal((await manager({ action: 'start', services: ['renderer'], project_id: PROJECT }, f.ctx)).structure.services[0].code, 'WORKER_IDENTITY_UNCONFIRMED');
  assert.equal(spawnCount, 1);
});

test('process adapter uses a fixed hidden detached executable and closes output handles', async t => {
  const f = fixture(t); let captured, unreferenced = false;
  const adapter = createProcessAdapter({ spawnImpl(runtime, args, options) {
    captured = { runtime, args, options }; const child = new EventEmitter(); child.pid = 88888; child.unref = () => { unreferenced = true; };
    process.nextTick(() => child.emit('spawn')); return child;
  } });
  const environment = { BAO_EDITOR_PROJECT_IDS: PROJECT };
  assert.equal(await adapter.spawnWorker(f.profiles.renderer, environment), 88888);
  assert.equal(captured.runtime, f.runtime); assert.deepEqual(captured.args, [f.profiles.renderer.script]);
  assert.equal(captured.options.windowsHide, true); assert.equal(captured.options.detached, true);
  assert.equal(captured.options.cwd, f.profiles.renderer.root); assert.equal(captured.options.stdio[0], 'ignore');
  assert.equal(captured.options.env, environment); assert.equal(captured.options.shell, undefined); assert.equal(unreferenced, true);
  assert.throws(() => fs.fstatSync(captured.options.stdio[1])); assert.throws(() => fs.fstatSync(captured.options.stdio[2]));
});

test('cross-process exclusive lock rejects overlap and retains an uncertain abandoned lock', async t => {
  const f = fixture(t), lock = f.profilePath + '.start.lock';
  const release = await acquireStartLock(lock);
  const modulePath = path.join(__dirname, 'bao-editor-services.js');
  const script = `require(process.argv[1]).acquireStartLock(process.argv[2],{timeoutMs:30,pollMs:5}).then(r=>r().then(()=>process.stdout.write('acquired'))).catch(e=>process.stdout.write(e.code))`;
  const child = spawn(process.execPath, ['-e', script, modulePath, lock], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(output, 'START_LOCK_BUSY');
  await release(); assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, token: 'uncertain-neutral', createdAt: '2020-01-01T00:00:00Z' }));
  await assert.rejects(acquireStartLock(lock, { timeoutMs: 15, pollMs: 5 }), error => error.code === 'START_LOCK_BUSY');
  assert.equal(JSON.parse(fs.readFileSync(lock)).token, 'uncertain-neutral');
});

test('stdio catalog retains all original ten tools and adds scoped worker recovery', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'bao-local-mcp.js')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  const response = new Promise((resolve, reject) => {
    child.stdout.on('data', data => { output += data; const line = output.split('\n')[0]; if (output.includes('\n')) { resolve(JSON.parse(line)); child.stdin.end(); } });
    child.once('error', reject);
    child.once('exit', () => { if (!output) reject(new Error('No neutral catalog response')); });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const tools = (await response).result.tools;
  assert.deepEqual(tools.slice(0, 10).map(tool => tool.name), ['bao_upload_to_canvas', 'bao_upload_images', 'bao_upload_files', 'bao_canvas_patch', 'bao_canvas_wire_video_batch', 'bao_canvas_video_inputs', 'bao_canvas_set_text', 'bao_canvas_inspect', 'bao_canvas_repair_media_bindings', 'bao_webtoon_upload']);
  assert.equal(tools.length, 11); const recovery = tools[10];
  assert.equal(recovery.name, 'bao_editor_services'); assert.equal(recovery.inputSchema.additionalProperties, false);
  assert.deepEqual(recovery.inputSchema.allOf[0].then.required, ['project_id']);
});
