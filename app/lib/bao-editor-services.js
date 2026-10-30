'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');

const execFile = promisify(childProcess.execFile);
const PROFILE_FILE = path.resolve(__dirname, '../../data/bao-editor-services.json');
const PROJECT_ID = /^(?:bao|bao-[a-f0-9]{32})$/;
const RUNNERS = { renderer: 'bao-editor-export-runner.mjs', decoder: 'bao-editor-video-frames-runner.mjs' };
const HINT = 'editor.export_queue uses the local renderer; editor.video_frames_queue uses the decoder. Provider production render_queue is separate. This tool submits no export, frame request or generation.';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fail = code => Object.assign(new Error(code), { code });
const key = value => path.resolve(value).replace(/\\/g, '/').toLowerCase();
const inside = (root, value) => key(value).startsWith(key(root) + '/');

function safeJson(file, maxBytes) {
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > maxBytes) throw fail('INVALID_PROFILE');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function profilesFrom(file) {
  let document;
  try { document = safeJson(file, 64 * 1024); } catch { throw fail('PROFILE_UNAVAILABLE'); }
  if (document.schemaVersion !== 1 || !document.profiles || Array.isArray(document.profiles)) throw fail('INVALID_PROFILE');
  const dataRoot = fs.realpathSync(path.dirname(file));
  const receiptDirectory = path.join(dataRoot, 'bao-editor-services');
  const managedReceipts = fs.existsSync(receiptDirectory) ? fs.realpathSync(receiptDirectory) : null;
  if (managedReceipts && !inside(dataRoot, managedReceipts)) throw fail('INVALID_PROFILE');
  const profiles = {};
  for (const service of Object.keys(RUNNERS)) {
    const raw = document.profiles[service];
    if (!raw || ['script', 'root', 'runtime', 'receipt', 'stdoutLog', 'stderrLog'].some(field => typeof raw[field] !== 'string' || !path.isAbsolute(raw[field]))) throw fail('INVALID_PROFILE');
    try {
      const root = fs.realpathSync(raw.root), script = fs.realpathSync(raw.script), runtime = fs.realpathSync(raw.runtime);
      if (!fs.statSync(root).isDirectory() || !fs.statSync(script).isFile() || !fs.statSync(runtime).isFile() ||
          !/^(node|node\.exe)$/i.test(path.basename(runtime)) || key(script) !== key(path.join(root, 'scripts', RUNNERS[service]))) throw fail('INVALID_PROFILE');
      const artifacts = fs.realpathSync(path.join(root, 'artifacts'));
      if (!inside(root, artifacts)) throw fail('INVALID_PROFILE');
      const profile = { service, root, script, runtime };
      for (const field of ['receipt', 'stdoutLog', 'stderrLog']) {
        const parent = fs.realpathSync(path.dirname(raw[field]));
        const artifactFile = key(parent) === key(artifacts) || inside(artifacts, parent);
        const managedReceipt = field === 'receipt' && managedReceipts && key(parent) === key(managedReceipts) && path.basename(raw[field]) === service + '.json';
        if (!artifactFile && !managedReceipt) throw fail('INVALID_PROFILE');
        if (fs.existsSync(raw[field]) && (fs.lstatSync(raw[field]).isSymbolicLink() || !fs.statSync(raw[field]).isFile())) throw fail('INVALID_PROFILE');
        profile[field] = path.join(parent, path.basename(raw[field]));
      }
      if (new Set([profile.receipt, profile.stdoutLog, profile.stderrLog].map(key)).size !== 3) throw fail('INVALID_PROFILE');
      profiles[service] = profile;
    } catch { throw fail('INVALID_PROFILE'); }
  }
  return profiles;
}

function receiptFrom(profile) {
  try {
    const value = safeJson(profile.receipt, 32 * 1024);
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || key(value.script || '') !== key(profile.script) ||
        key(value.root || '') !== key(profile.root)) return null;
    return { pid: value.pid, projectId: PROJECT_ID.test(value.projectId || '') ? value.projectId : null, startedAt: value.startedAt };
  } catch { return null; }
}

function commandTokens(command) {
  return [...String(command || '').matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]);
}

function inspect(profile, processes, requestedProject) {
  const receipt = receiptFrom(profile);
  const relative = 'scripts/' + RUNNERS[profile.service];
  const scriptMatches = token => {
    const script = token.replace(/\\/g, '/');
    return path.isAbsolute(script) ? key(script) === key(profile.script) : script.toLowerCase().replace(/^(\.\/)+/, '') === relative;
  };
  const candidates = processes.filter(process => {
    const tokens = commandTokens(process.commandLine);
    return tokens.slice(1).some(scriptMatches) || receipt?.pid === process.pid && (!process.commandLine || !process.executablePath || !process.name);
  });
  if (candidates.length > 1) return { service: profile.service, status: 'error', code: 'MULTIPLE_WORKERS', blocked: true };
  if (!candidates.length) return { service: profile.service, status: 'error', code: 'NOT_RUNNING', blocked: false };
  const worker = candidates[0];
  const tokens = commandTokens(worker.commandLine);
  if (!Number.isSafeInteger(worker.pid) || !worker.executablePath || key(worker.executablePath) !== key(profile.runtime) ||
      !/^node(?:\.exe)?$/i.test(worker.name || '') || tokens.length !== 2 || !scriptMatches(tokens[1] || '')) return { service: profile.service, status: 'error', code: 'WORKER_IDENTITY_UNCONFIRMED', pid: worker.pid, blocked: true };
  if (!receipt || receipt.pid !== worker.pid || !receipt.projectId) return { service: profile.service, status: 'error', code: 'UNREGISTERED_WORKER', pid: worker.pid, blocked: true };
  if (requestedProject && receipt.projectId !== requestedProject) return { service: profile.service, status: 'error', code: 'PROJECT_SCOPE_MISMATCH', pid: worker.pid, projectId: receipt.projectId, blocked: true };
  return { service: profile.service, status: 'healthy', pid: worker.pid, projectId: receipt.projectId, blocked: false };
}

function credentials(store) {
  let config;
  try { config = store.getMcpConfig().mcpServers['bao-production']; } catch { throw fail('BAO_AUTH_UNAVAILABLE'); }
  let endpoint;
  try { endpoint = new URL(config.url); } catch { throw fail('BAO_AUTH_UNAVAILABLE'); }
  const headers = Object.fromEntries(Object.entries(config.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
  const authorization = String(headers.authorization || ''), sites = String(headers['oai-sites-authorization'] || '');
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/api/lightbringer-mcp' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^Bearer\s+\S+/i.test(authorization) || !sites.trim()) throw fail('BAO_AUTH_UNAVAILABLE');
  return { endpoint: endpoint.href, token: authorization.replace(/^Bearer\s+/i, '').trim(), sites: sites.trim() };
}

function workerEnvironment(auth, projectId) {
  const environment = { ...process.env, BAO_MCP_URL: auth.endpoint, BAO_PRODUCTION_MCP_TOKEN: auth.token, BAO_SITES_AUTH_HEADER: auth.sites, BAO_EDITOR_PROJECT_IDS: projectId };
  for (const name of ['BAO_MCP_TOKEN_FILE', 'BAO_SITES_AUTH_FILE', 'BAO_EDITOR_RENDER_CLIENT_ID', 'BAO_FRAME_CLIENT_ID', 'NODE_OPTIONS', 'NODE_PATH']) delete environment[name];
  return environment;
}

function createProcessAdapter({ execFileImpl = execFile, spawnImpl = childProcess.spawn, platform = process.platform } = {}) { return {
  async listProcesses() {
    if (platform !== 'win32') throw fail('UNSUPPORTED_PLATFORM');
    const script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Select-Object @{n="pid";e={[int]$_.ProcessId}},@{n="name";e={$_.Name}},@{n="executablePath";e={$_.ExecutablePath}},@{n="commandLine";e={$_.CommandLine}}) | ConvertTo-Json -Compress';
    const result = await execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    const value = result.stdout.trim() ? JSON.parse(result.stdout.replace(/^\uFEFF/, '')) : [];
    return Array.isArray(value) ? value : [value];
  },
  async spawnWorker(profile, environment) {
    let stdout, stderr;
    try {
      stdout = fs.openSync(profile.stdoutLog, 'a'); stderr = fs.openSync(profile.stderrLog, 'a');
      const child = spawnImpl(profile.runtime, [profile.script], { cwd: profile.root, windowsHide: true, detached: true, stdio: ['ignore', stdout, stderr], env: environment });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      return child.pid;
    } finally { if (stdout !== undefined) fs.closeSync(stdout); if (stderr !== undefined) fs.closeSync(stderr); }
  }
}; }
const defaultAdapter = createProcessAdapter();

// Exclusive creation serializes separate stdio MCP processes too. An abandoned lock
// is retained: the spawn outcome may be unknown, so deleting it could duplicate work.
async function acquireStartLock(file, { timeoutMs = 5000, pollMs = 100, wait = sleep } = {}) {
  const token = crypto.randomUUID(), deadline = Date.now() + timeoutMs;
  while (true) {
    let handle;
    try {
      handle = await fs.promises.open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
      await handle.sync();
      await handle.close();
      return async () => {
        try { const value = safeJson(file, 4096); if (value.token === token) await fs.promises.unlink(file); } catch { /* retain uncertain lock */ }
      };
    } catch (error) {
      if (handle) { await handle.close().catch(() => {}); throw fail('START_LOCK_UNAVAILABLE'); }
      if (error.code !== 'EEXIST') throw fail('START_LOCK_UNAVAILABLE');
      if (Date.now() >= deadline) throw fail('START_LOCK_BUSY');
      await wait(pollMs);
    }
  }
}

async function saveReceipt(profile, pid, projectId) {
  const temporary = profile.receipt + '.' + crypto.randomUUID() + '.tmp';
  try {
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid, script: profile.script, root: profile.root, projectId, startedAt: new Date().toISOString() }, null, 2)); await handle.sync(); } finally { await handle.close(); }
    await fs.promises.rename(temporary, profile.receipt);
  } finally { await fs.promises.unlink(temporary).catch(() => {}); }
}

function publicReceipt(value) { const { blocked, ...receipt } = value; return receipt; }

function createBaoEditorServices({ profilePath = PROFILE_FILE, adapter = defaultAdapter, lockOptions, wait = sleep } = {}) {
  return async function baoEditorServices(args, ctx) {
    let release;
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(name => !['action', 'services', 'project_id'].includes(name)) || !['status', 'start'].includes(args.action)) throw fail('INVALID_ARGUMENTS');
      const services = args.services ?? ['renderer', 'decoder'];
      if (!Array.isArray(services) || !services.length || services.length > 2 || new Set(services).size !== services.length || services.some(service => !Object.hasOwn(RUNNERS, service))) throw fail('INVALID_ARGUMENTS');
      if ((args.action === 'start' || args.project_id !== undefined) && !PROJECT_ID.test(args.project_id || '')) throw fail('EXACT_PROJECT_ID_REQUIRED');
      const profiles = profilesFrom(profilePath);
      if (args.action === 'start') release = await acquireStartLock(profilePath + '.start.lock', lockOptions);
      const processes = await adapter.listProcesses();
      const states = services.map(service => inspect(profiles[service], processes, args.project_id));
      if (args.action === 'start' && states.some(state => state.blocked)) return result('error', states.map(publicReceipt));
      let auth;
      if (args.action === 'start' && states.some(state => state.status !== 'healthy')) auth = credentials(ctx.store);
      const receipts = [];
      for (const state of states) {
        if (args.action === 'status' || state.status === 'healthy') {
          receipts.push(publicReceipt(args.action === 'start' ? { ...state, status: 'already_running' } : state));
          continue;
        }
        const profile = profiles[state.service];
        let pid;
        try {
          pid = await adapter.spawnWorker(profile, workerEnvironment(auth, args.project_id));
          if (!Number.isSafeInteger(pid) || pid <= 0) throw fail('START_UNCONFIRMED');
          await saveReceipt(profile, pid, args.project_id);
          await wait(150);
          const verified = inspect(profile, await adapter.listProcesses(), args.project_id);
          receipts.push(verified.status === 'healthy' && verified.pid === pid ? { ...publicReceipt(verified), status: 'started' } : { service: state.service, status: 'error', code: 'START_UNCONFIRMED', pid });
        } catch { receipts.push({ service: state.service, status: 'error', code: pid ? 'START_UNCONFIRMED' : 'START_FAILED', ...(pid ? { pid } : {}) }); }
      }
      return result(receipts.some(receipt => receipt.status === 'error') ? 'error' : args.action === 'status' ? 'healthy' : receipts.some(receipt => receipt.status === 'started') ? 'started' : 'already_running', receipts);
    } catch (error) { return result('error', [], ['INVALID_ARGUMENTS', 'EXACT_PROJECT_ID_REQUIRED', 'PROFILE_UNAVAILABLE', 'INVALID_PROFILE', 'BAO_AUTH_UNAVAILABLE', 'START_LOCK_UNAVAILABLE', 'START_LOCK_BUSY', 'UNSUPPORTED_PLATFORM'].includes(error.code) ? error.code : 'PROCESS_INSPECTION_FAILED'); }
    finally { if (release) await release(); }
  };
}

function result(status, services, code) {
  const structure = { status, ...(code ? { code } : {}), services, hint: HINT };
  return { text: JSON.stringify(structure), structure, ...(status === 'error' ? { isError: true } : {}) };
}

module.exports = { baoEditorServices: createBaoEditorServices(), createBaoEditorServices, acquireStartLock, createProcessAdapter };
