'use strict';
// Flash Studio 로컬 서버 (Node 18+, 외부 의존성 없음)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const { SchemaRegistry } = require('./lib/schema');
const { Store, newId, now, SAFE_ID } = require('./lib/store');
const { McpManager } = require('./lib/mcp');
const { SkillLibrary } = require('./lib/skills');
const { ChatRunner, attachmentKind } = require('./lib/chat');
const llm = require('./lib/llm');
const tools = require('./lib/tools');
const imageInput = require('./lib/image-generation-input');
const { RequestLog } = require('./lib/requestlog');
const { RoutineScheduler } = require('./lib/routines');
const { ConvWatcher } = require('./lib/watch');
const { BackgroundWaits } = require('./lib/bgwait');
const { JobQueue } = require('./lib/queue');
const { WorkBrowser } = require('./lib/browser');
const { Terminal } = require('./lib/terminal');
const { readBody } = require('./lib/http-body');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const VERSION = '1.0.1';

const registry = new SchemaRegistry(path.join(ROOT, 'schemas'));
const store = new Store(ROOT, registry);
store.ensure();
const mcp = new McpManager();
const skills = new SkillLibrary(store.dirs.skills, registry);
const browser = new WorkBrowser(path.join(store.data, '.browser-profile'));
const terminal = new Terminal(store.dirs.workspace);
const runner = new ChatRunner({ store, mcp, skills, browser, terminal });
const queue = new JobQueue({ store, runner });
runner.queue = queue;
const scheduler = new RoutineScheduler({ store, runner, queue });
const watcher = new ConvWatcher({ store, runner });
const bgwaits = new BackgroundWaits({ store, runner });
runner.bg = bgwaits;
const requestLog = new RequestLog(store.dirs.logs, registry);
llm.setRecorder((e) => requestLog.append({ source: 'app', ...e }));

const rescanSkills = () => skills.scan(store.getSettings().skills.extraDirs, store.getSettings().skills.disabled);
rescanSkills();

// ---------------- 유틸 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.pdf': 'application/pdf'
};

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpErr(400, 'JSON 형식이 아닙니다'); }
}

function serveFile(res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, ...extraHeaders });
    fs.createReadStream(file).pipe(res);
  });
}

function maskSettings(s) {
  const c = structuredClone(s);
  for (const p of c.providers) {
    const envKey = !p.apiKey && p.apiKeyEnv ? llm.resolveApiKey(p) : '';
    p.hasKey = !!(p.apiKey || envKey);
    p.keySource = p.apiKey ? 'settings' : envKey ? 'env' : 'none';
    if (p.apiKey) p.apiKey = `••••${llm.cleanKey(p.apiKey).slice(-4)}`;
  }
  return c;
}

function unmaskSettings(next) {
  const cur = store.getSettings();
  for (const p of next.providers || []) {
    delete p.hasKey; delete p.keySource;
    if (typeof p.apiKey === 'string' && p.apiKey.startsWith('••••')) {
      p.apiKey = cur.providers.find((x) => x.id === p.id)?.apiKey || '';
    }
    if (typeof p.apiKey === 'string') p.apiKey = llm.cleanKey(p.apiKey);
  }
  return next;
}

function openInExplorer(target) {
  execFile(process.platform === 'win32' ? 'explorer.exe' : 'xdg-open', [target], () => {});
}

function conversationMarkdown(c) {
  const out = [`# ${c.title}`, '', `_${c.createdAt} · ${c.model || ''}_`, ''];
  for (const m of c.messages) {
    if (m.role === 'user') {
      out.push('## 사용자', '', m.content);
      for (const a of m.attachments) out.push(`- 첨부: ${a.name}`);
    } else {
      out.push('## 어시스턴트', '');
      for (const p of m.parts) {
        if (p.type === 'text') out.push(p.text);
        else if (p.type === 'tool_call') out.push(`> 도구 \`${p.name}\` ${p.status}\n>\n> \`\`\`\n> ${p.arguments}\n> \`\`\``);
        else if (p.type === 'image') out.push(`![${(p.prompt || '').slice(0, 60)}](${p.url})`);
      }
      if (m.error) out.push(`> 오류: ${m.error}`);
    }
    out.push('');
  }
  return out.join('\n');
}

// ---------------- 라우터 ----------------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler });
};

let lastSeen = Date.now();
let byeTimer = null;

route('GET', '/api/ping', () => ({ ok: true, app: 'flash-studio', version: VERSION, pollPolicyRevision:'editor-export-envelope-20261006', handoffPolicyRevision:'checkpoint-resume-20261006', editorServicesRevision:'local-worker-control-20261006', activeRuns:runner.activeCount() }));
route('POST', '/api/bye', () => {
  clearTimeout(byeTimer);
  if (process.env.FLASH_IDLE_EXIT === '1') byeTimer = setTimeout(() => { if (Date.now() - lastSeen > 12000 && !runner.activeCount() && !scheduler.keepsAlive() && !queue.keepsAlive() && !watcher.keepsAlive() && !bgwaits.keepsAlive()) shutdown('창 닫힘'); }, 15000);
  return { ok: true };
});

route('GET', '/api/state', () => ({
  version: VERSION,
  imageInputPolicy: { seedreamMaxPixels: imageInput.SEEDREAM_MAX_PIXELS, oversizedReferences: 'proportional-copy', originalUploadsPreserved: true, revision: 'seedream-pixels-20261004' },
  root: ROOT,
  dirs: store.dirs,
  settings: maskSettings(store.getSettings()),
  conversations: store.listConversations(),
  prompts: store.getPrompts().prompts,
  skills: skills.list(),
  mcp: mcp.status()
}));

// 설정
route('GET', '/api/settings', () => maskSettings(store.getSettings()));
route('PUT', '/api/settings', async (req) => {
  const next = unmaskSettings(await readJson(req));
  store.saveSettings(next);
  llm.clearKeyCache();
  rescanSkills();
  return maskSettings(store.getSettings());
});
route('GET', '/api/schemas/:id', (req, p) => registry.get(decodeURIComponent(p.id)));

route('POST', '/api/providers/:id/models', (req, p) => {
  const prov = store.getSettings().providers.find((x) => x.id === p.id);
  if (!prov) throw httpErr(404, '공급자를 찾을 수 없습니다');
  return llm.listModels(prov).then((models) => ({ models }));
});
route('POST', '/api/providers/:id/test', async (req, p) => {
  const prov = store.getSettings().providers.find((x) => x.id === p.id);
  if (!prov) throw httpErr(404, '공급자를 찾을 수 없습니다');
  const body = await readJson(req);
  const model = body.model || prov.models[0].id;
  const t0 = Date.now();
  const reply = await llm.complete({ provider: prov, model, maxTokens: 20, messages: [{ role: 'user', content: '"ok" 라고만 답해.' }], signal: AbortSignal.timeout(30000), meta: { kind: 'test' } });
  return { ok: true, model, reply: reply.slice(0, 200), ms: Date.now() - t0 };
});

// 대화
route('GET', '/api/conversations', () => store.listConversations());
route('POST', '/api/conversations', async (req) => {
  const b = await readJson(req);
  if (b.projectId && !store.getProject(b.projectId)) throw httpErr(400, '프로젝트를 찾을 수 없습니다');
  return store.createConversation({ providerId: b.providerId, model: b.model, systemPrompt: b.systemPrompt, skills: Array.isArray(b.skills) ? b.skills : [], projectId: b.projectId || null });
});
route('GET', '/api/conversations/:id', (req, p) => store.getConversation(p.id));
route('PATCH', '/api/conversations/:id', async (req, p) => {
  const c = store.getConversation(p.id);
  const b = await readJson(req);
  if (b.projectId && !store.getProject(b.projectId)) throw httpErr(400, '프로젝트를 찾을 수 없습니다');
  for (const k of ['title', 'systemPrompt', 'skills', 'pinned', 'model', 'providerId', 'projectId', 'archived']) if (b[k] !== undefined) c[k] = b[k];
  if (b.archived) c.pinned = false;
  store.saveConversation(c, b.title === undefined && b.pinned === undefined && b.projectId === undefined && b.archived === undefined);
  return c;
});
// 여러 대화를 한꺼번에 보관·복원·프로젝트 이동
route('POST', '/api/conversations/bulk', async (req) => {
  const b = await readJson(req);
  if (!Array.isArray(b.ids)) throw httpErr(400, 'ids 가 필요합니다');
  if (b.projectId && !store.getProject(b.projectId)) throw httpErr(400, '프로젝트를 찾을 수 없습니다');
  let n = 0;
  for (const id of b.ids) {
    let c;
    try { c = store.getConversation(id); } catch { continue; }
    if (b.archived !== undefined) { c.archived = !!b.archived; if (c.archived) c.pinned = false; }
    if (b.projectId !== undefined) c.projectId = b.projectId || null;
    store.saveConversation(c, false);
    n++;
  }
  return { ok: true, count: n };
});

// 프로젝트 (CONTEXT.md §10)
const projectFields = ['name', 'description', 'instructions', 'skills', 'files', 'color', 'archived'];
route('GET', '/api/projects', () => store.getProjects().projects);
route('POST', '/api/projects', async (req) => {
  const b = await readJson(req);
  const lib = store.getProjects();
  const item = { id: newId(), createdAt: now(), updatedAt: now() };
  for (const k of projectFields) if (b[k] !== undefined) item[k] = b[k];
  registry.applyDefaults('projects.schema.json#/$defs/project', item);
  registry.assert('projects.schema.json#/$defs/project', item);
  lib.projects.unshift(item);
  store.saveProjects(lib);
  return item;
});
route('PATCH', '/api/projects/:id', async (req, p) => {
  const b = await readJson(req);
  const lib = store.getProjects();
  const item = lib.projects.find((x) => x.id === p.id);
  if (!item) throw httpErr(404, '프로젝트를 찾을 수 없습니다');
  for (const k of projectFields) if (b[k] !== undefined) item[k] = b[k];
  item.updatedAt = now();
  registry.assert('projects.schema.json#/$defs/project', item);
  store.saveProjects(lib);
  return item;
});
route('DELETE', '/api/projects/:id', (req, p) => {
  const lib = store.getProjects();
  if (!lib.projects.some((x) => x.id === p.id)) throw httpErr(404, '프로젝트를 찾을 수 없습니다');
  lib.projects = lib.projects.filter((x) => x.id !== p.id);
  store.saveProjects(lib);
  // 대화는 지우지 않고 프로젝트에서만 뺀다
  for (const meta of store.listConversations()) {
    if (meta.projectId !== p.id) continue;
    const c = store.getConversation(meta.id);
    c.projectId = null;
    store.saveConversation(c, false);
  }
  const rl = store.getRoutines();
  for (const r of rl.routines) if (r.projectId === p.id) r.projectId = null;
  store.saveRoutines(rl);
  return { ok: true };
});

// ---------------- 오른쪽 작업 패널: 브라우저 · 터미널 · 결과물 ----------------
route('GET', '/api/browser/state', () => ({ ...browser.state, available: !!browser.exe() }));
route('GET', '/api/browser/shot', async (req, p, res) => {
  const buf = await browser.freshShot();
  if (!buf) throw httpErr(404, '브라우저 화면이 없습니다');
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'content-length': buf.length });
  res.end(buf);
  return undefined;
});
route('POST', '/api/browser/:action', async (req, p) => {
  const b = await readJson(req);
  switch (p.action) {
    case 'open': await browser.open(b.url); break;
    case 'click': await browser.click({ x: b.x, y: b.y, double: !!b.double }); break;
    case 'scroll': await browser.wheel(b.deltaY, b.x, b.y); break;
    case 'type': await browser.type({ text: b.text, submit: !!b.submit }); break;
    case 'key': await browser.key(String(b.key || 'Enter')); break;
    case 'nav': await browser.history(String(b.action || 'back')); break;
    case 'close': browser.close(); break;
    default: throw httpErr(404, '알 수 없는 동작');
  }
  return browser.state;
});

route('GET', '/api/terminal', (req) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  return terminal.snapshot(u.searchParams.get('conv') || null);
});
route('POST', '/api/terminal/run', async (req) => {
  const b = await readJson(req);
  const command = String(b.command || '').trim();
  if (!command) throw httpErr(400, '명령을 입력하세요');
  terminal.run(command, { source: 'user', timeoutMs: 10 * 60000 }).catch(() => {});
  return { ok: true };
});
route('POST', '/api/terminal/kill', async (req) => ({ ok: terminal.kill((await readJson(req)).id) }));
route('POST', '/api/terminal/clear', () => { terminal.clear(); return { ok: true }; });

// 결과물 탭: 파일 미리보기(텍스트 앞부분)와 탐색기에서 보기. 읽기 허용 폴더 안만
const panelCtx = () => ({ store, settings: store.getSettings() });
route('GET', '/api/files/preview', (req) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const full = tools.resolvePath(u.searchParams.get('path') || '', panelCtx(), 'read');
  if (!fs.existsSync(full)) throw httpErr(404, '파일이 없습니다');
  const st = fs.statSync(full);
  if (st.isDirectory()) return { path: full, dir: true, entries: fs.readdirSync(full).slice(0, 300) };
  const ext = path.extname(full).toLowerCase();
  const textLike = ['.txt', '.md', '.json', '.js', '.ts', '.css', '.html', '.htm', '.csv', '.tsv', '.xml', '.yml', '.yaml', '.py', '.ps1', '.bat', '.log', '.srt', '.svg', '.jsonl'].includes(ext);
  const out = { path: full, size: st.size, mtime: st.mtime.toISOString(), ext };
  if (textLike) {
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(Math.min(st.size, 200000));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    out.text = buf.toString('utf8');
    out.truncated = st.size > buf.length;
  }
  return out;
});
route('POST', '/api/files/reveal', async (req) => {
  const full = tools.resolvePath((await readJson(req)).path || '', panelCtx(), 'read');
  if (!fs.existsSync(full)) throw httpErr(404, '파일이 없습니다');
  execFile('explorer.exe', [fs.statSync(full).isDirectory() ? full : `/select,${full}`], { windowsHide: false }, () => {});
  return { ok: true };
});

// ---------------- 작업 대기열 (CONTEXT.md §13) ----------------
route('GET', '/api/queue', () => queue.snapshot());
// 한 건 또는 여러 건 등록. 템플릿 등록: { template:{title,prompt}, rows:[{변수:값}], common:{projectId,skills,approval,priority,sequential} }
route('POST', '/api/queue/jobs', async (req) => {
  const b = await readJson(req);
  let items = [];
  if (b.template && Array.isArray(b.rows)) {
    const fill = (t, row) => String(t || '').replace(/\{\{\s*([^}:]+?)\s*(?::([^}]*))?\}\}/g, (m, k, def) => (row[k] != null && row[k] !== '' ? String(row[k]) : def != null ? def : m));
    // 행마다 첨부(_attachments)를 줄 수 있다 — 이미지 1장 = 작업 1건
    items = b.rows.map((row) => ({ title: fill(b.template.title, row), prompt: fill(b.template.prompt, row), attachments: Array.isArray(row._attachments) ? row._attachments : [] }));
  } else items = Array.isArray(b.jobs) ? b.jobs : [b];
  const c = b.common || {};
  if (c.projectId && !store.getProject(c.projectId)) throw httpErr(400, '프로젝트를 찾을 수 없습니다');
  const batchId = items.length > 1 ? newId() : null;
  const added = [];
  let prev = null;
  for (const it of items) {
    const atts = [...(Array.isArray(it.attachments) ? it.attachments : []), ...(Array.isArray(c.attachments) ? c.attachments : [])];
    for (const a of atts) if (!a || !a.file || !fs.existsSync(path.join(store.dirs.uploads, path.basename(a.file)))) throw httpErr(400, `첨부 파일이 없습니다: ${a && a.name}`);
    const [job] = queue.add([{ ...it, attachments: atts, projectId: it.projectId || c.projectId || null, skills: it.skills || c.skills || [], approval: it.approval || c.approval || {}, priority: it.priority ?? c.priority ?? 0, dependsOn: c.sequential && prev ? [prev] : (it.dependsOn || []) }], { source: 'user', batchId });
    prev = job.id;
    added.push(job);
  }
  return { added: added.length, jobs: added };
});
route('PATCH', '/api/queue/jobs/:id', async (req, p) => {
  const b = await readJson(req);
  if (b.projectId && !store.getProject(b.projectId)) throw httpErr(400, '프로젝트를 찾을 수 없습니다');
  if (b.prompt !== undefined && !String(b.prompt).trim()) throw httpErr(400, '작업 내용이 비어 있습니다');
  for (const a of b.attachments || []) if (!a || !a.file || !fs.existsSync(path.join(store.dirs.uploads, path.basename(a.file)))) throw httpErr(400, `첨부 파일이 없습니다: ${a && a.name}`);
  // 시작한 작업이면 바뀐 점이 모델에게 전달된다 (진행 중이면 바로, 멈춰 있으면 다음 단계에)
  const r = queue.edit(p.id, b, { applyToBatch: !!b.applyToBatch });
  if (!r) throw httpErr(404, '작업을 찾을 수 없습니다');
  return { ...queue.get(p.id), changed: r.changed };
});
// 대기 중인 작업 순서 옮기기: top | up | down | bottom
route('POST', '/api/queue/jobs/:id/move', async (req, p) => {
  const job = queue.move(p.id, String((await readJson(req)).to || ''));
  if (!job) throw httpErr(404, '작업을 찾을 수 없습니다');
  return job;
});
route('POST', '/api/queue/jobs/:id/:action', (req, p) => {
  let job;
  if (p.action === 'pause') job = queue.stop(p.id, 'paused');
  else if (p.action === 'cancel') job = queue.stop(p.id, 'canceled');
  else if (p.action === 'retry' || p.action === 'resume') job = queue.retry(p.id);
  else if (p.action === 'restart') job = queue.restart(p.id);
  else throw httpErr(404, '알 수 없는 동작');
  if (!job) throw httpErr(404, '작업을 찾을 수 없습니다');
  setTimeout(() => queue.tick(), 200);
  return job;
});
route('DELETE', '/api/queue/jobs/:id', (req, p) => {
  if (queue.activeId === p.id) throw httpErr(409, '진행 중인 작업은 먼저 일시정지하거나 취소하세요');
  const q = store.getQueue();
  q.jobs = q.jobs.filter((j) => j.id !== p.id);
  queue.save(q);
  return { ok: true };
});
// 작업 등록 프리셋 (사용자 저장분)
route('POST', '/api/queue/presets', async (req) => {
  const b = await readJson(req);
  const q = store.getQueue();
  const item = { id: newId(), name: String(b.name || '').trim().slice(0, 80), kind: b.kind === 'webtoon' ? 'webtoon' : 'custom', form: b.form || {}, title: b.title || '', prompt: b.prompt || '', skills: b.skills || [], projectId: b.projectId || null, approval: b.approval || {}, priority: Number(b.priority) || 0, sequential: !!b.sequential, createdAt: now() };
  if (!item.name) throw httpErr(400, '프리셋 이름을 적어 주세요');
  registry.applyDefaults('queue.schema.json#/$defs/preset', item);
  registry.assert('queue.schema.json#/$defs/preset', item);
  q.presets = [...(q.presets || []).filter((x) => x.name !== item.name), item];
  queue.save(q);
  return item;
});
route('DELETE', '/api/queue/presets/:id', (req, p) => {
  const q = store.getQueue();
  q.presets = (q.presets || []).filter((x) => x.id !== p.id);
  queue.save(q);
  return { ok: true };
});
// 끝난 작업 정리
route('POST', '/api/queue/clear', async (req) => {
  const b = await readJson(req);
  const drop = new Set(Array.isArray(b.statuses) && b.statuses.length ? b.statuses : ['done', 'canceled']);
  const q = store.getQueue();
  const before = q.jobs.length;
  q.jobs = q.jobs.filter((j) => !drop.has(j.status));
  queue.save(q);
  return { removed: before - q.jobs.length };
});
// ---------------- 24시간 운영: 감시자 · 윈도우 시작 시 자동 실행 ----------------
const STARTUP_LNK = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Flash Studio 24h.lnk');
const LAUNCHER_24H = path.join(ROOT, 'Flash Studio 24h.vbs');
const supervisorPid = () => { try { const pid = Number(fs.readFileSync(path.join(store.data, '.cache', 'supervisor.pid'), 'utf8')); process.kill(pid, 0); return pid; } catch { return null; } };
route('GET', '/api/system/always-on', () => ({ autostart: fs.existsSync(STARTUP_LNK), supervisor: !!supervisorPid(), supervised: process.env.FLASH_SUPERVISED === '1', keepAwakeActive: queue.awake.active, launcher: LAUNCHER_24H }));
route('POST', '/api/system/always-on', async (req) => {
  const b = await readJson(req);
  const ps = (cmd) => new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true }, (e, out, err) => (e ? reject(new Error(err || e.message)) : resolve(out))));
  if (b.autostart === true && !fs.existsSync(STARTUP_LNK)) {
    const q = (x) => x.replace(/'/g, "''");
    await ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${q(STARTUP_LNK)}'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '"${q(LAUNCHER_24H)}"'; $s.WorkingDirectory = '${q(ROOT)}'; $s.Description = 'Flash Studio 24h'; $s.Save()`);
  } else if (b.autostart === false && fs.existsSync(STARTUP_LNK)) fs.unlinkSync(STARTUP_LNK);
  // 감시자를 지금 바로 띄운다 (이미 떠 있으면 스스로 끝남)
  if (b.startSupervisor && !supervisorPid()) execFile('wscript.exe', [LAUNCHER_24H], { windowsHide: true }, () => {});
  await new Promise((r2) => setTimeout(r2, b.startSupervisor ? 1500 : 0));
  return { autostart: fs.existsSync(STARTUP_LNK), supervisor: !!supervisorPid(), supervised: process.env.FLASH_SUPERVISED === '1' };
});
route('PATCH', '/api/queue/settings', async (req) => {
  const b = await readJson(req);
  const q = store.getQueue();
  Object.assign(q.settings, b);
  registry.applyDefaults('queue.schema.json', q);
  registry.assert('queue.schema.json', q);
  queue.save(q);
  queue.updateAwake(q);
  if (q.settings.running) setTimeout(() => queue.tick(), 200);
  return q.settings;
});

// 루틴 (예약 실행)
const routineFields = ['name', 'enabled', 'prompt', 'projectId', 'skills', 'schedule', 'target', 'providerId', 'model', 'catchUp'];
route('GET', '/api/routines', () => ({ routines: store.getRoutines().routines, running: [...scheduler.running] }));
route('POST', '/api/routines', async (req) => {
  const b = await readJson(req);
  const lib = store.getRoutines();
  const item = RoutineScheduler.create({});
  for (const k of routineFields) if (b[k] !== undefined) item[k] = b[k];
  registry.applyDefaults('routines.schema.json#/$defs/routine', item);
  scheduler.reschedule(item);
  registry.assert('routines.schema.json#/$defs/routine', item);
  lib.routines.unshift(item);
  store.saveRoutines(lib);
  return item;
});
route('PATCH', '/api/routines/:id', async (req, p) => {
  const b = await readJson(req);
  const lib = store.getRoutines();
  const item = lib.routines.find((x) => x.id === p.id);
  if (!item) throw httpErr(404, '루틴을 찾을 수 없습니다');
  for (const k of routineFields) if (b[k] !== undefined) item[k] = b[k];
  if (b.target === 'new') item.conversationId = null;
  registry.applyDefaults('routines.schema.json#/$defs/routine', item);
  if (b.schedule !== undefined || b.enabled !== undefined) scheduler.reschedule(item);
  item.updatedAt = now();
  registry.assert('routines.schema.json#/$defs/routine', item);
  store.saveRoutines(lib);
  return item;
});
route('DELETE', '/api/routines/:id', (req, p) => {
  const lib = store.getRoutines();
  lib.routines = lib.routines.filter((x) => x.id !== p.id);
  store.saveRoutines(lib);
  return { ok: true };
});
// 지금 실행: 끝날 때까지 기다리지 않고 바로 돌려준다
route('POST', '/api/routines/:id/run', (req, p) => {
  if (scheduler.running.has(p.id)) throw httpErr(409, '이미 실행 중인 루틴이에요');
  if (!store.getRoutines().routines.some((x) => x.id === p.id)) throw httpErr(404, '루틴을 찾을 수 없습니다');
  scheduler.run(p.id, 'manual').catch((e) => console.error('[routine]', e.message));
  return { ok: true };
});
// 자동 점검 켜기·끄기 (채팅방 토글). { enabled, intervalMin }
route('GET', '/api/conversations/:id/bgwaits', (req, p) => ({ waits: bgwaits.list(p.id) }));
route('DELETE', '/api/conversations/:id/bgwaits/:waitId', (req, p) => ({ ok: bgwaits.cancel(p.id, p.waitId) }));
route('PUT', '/api/conversations/:id/watch', async (req, p) => {
  const b = await readJson(req);
  return { watch: watcher.configure(p.id, { enabled: b.enabled !== false, intervalMin: b.intervalMin }) };
});
route('DELETE', '/api/conversations/:id', (req, p) => { store.deleteConversation(p.id); return { ok: true }; });
route('POST', '/api/conversations/:id/truncate', async (req, p) => {
  const c = store.getConversation(p.id);
  const { messageId } = await readJson(req);
  const idx = c.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) throw httpErr(404, '메시지를 찾을 수 없습니다');
  c.messages.splice(idx);
  if (c.compaction && !c.messages.some((m) => m.id === c.compaction.upToMessageId)) c.compaction = null;
  store.saveConversation(c);
  return c;
});
// 컨텍스트 정리: 지금 바로 요약 / 정리 해제 (CONTEXT.md §5)
route('POST', '/api/conversations/:id/compact', async (req, p) => ({ compaction: await runner.compactNow(p.id) }));
// 핸드오프 (CONTEXT.md §9): 인계서 초안 → 확인·수정 → 새 대화 생성
route('POST', '/api/conversations/:id/handoff/draft', (req, p) => runner.handoffDraft(p.id));
route('POST', '/api/conversations/:id/handoff', async (req, p) => {
  const b = await readJson(req);
  return { conversation: runner.createHandoff(p.id, { summary: b.summary, files: b.files }) };
});
route('POST', '/api/conversations/:id/handoff/resume', async (req, p, res) => {
  const conv = store.getConversation(p.id);
  const last = [...conv.messages].reverse().find(m => m.role === 'assistant');
  // 구형 서버가 전환 안내만 남기고 멈춘 열린 대화도 자동 인계로 복구한다.
  const legacyPending = !conv.handedOffTo && !conv.queueJobId && last?.status === 'complete' && last.stopReason === 'context_handoff' && store.getSettings().generation.autoHandoff !== false;
  if (legacyPending) {
    if (runner.isBusy(conv.id)) throw httpErr(409, '이 인계 작업은 이미 실행 중입니다.');
    const b = await readJson(req);
    const options = { tools: b.options?.tools === true, thinking: b.options?.thinking === true, imageMode: false };
    return runner.handle(req, res, { conversationId: conv.id, options, content: '[자동 인계 복구] 이전 응답이 컨텍스트 전환 안내에서 멈췄습니다. 기존 승인 범위와 원문을 보존하여 인계를 완료하고 직전 미완료 작업을 이어갑니다. 제출 결과부터 조회하며 유료 승인·범위를 확대하거나 완료 작업을 다시 실행하지 않습니다.' });
  }
  if (!conv.handoff?.autoResume || conv.handoff.resumeState !== 'pending') return { resumed: false, state: conv.handoff?.resumeState || null };
  if (runner.isBusy(conv.id)) throw httpErr(409, '이 인계 작업은 이미 실행 중입니다. 중복 재개하지 않습니다.');
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  await runner.resumeHandoff(req, res, conv, { tools: false, ...conv.handoff.resumeOptions, imageMode: false });
  if (!res.writableEnded) res.end();
});
route('PUT', '/api/conversations/:id/handoff', async (req, p) => {
  const b = await readJson(req);
  return { handoff: runner.updateHandoff(p.id, b.summary) };
});
// 입력창 컨텍스트 표시기: 지금 대화가 모델 컨텍스트 창을 얼마나 쓰는지
route('GET', '/api/conversations/:id/context', (req, p) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  return runner.contextInfo(store.getConversation(p.id), u.searchParams.get('provider') || '', u.searchParams.get('model') || '');
});
route('DELETE', '/api/conversations/:id/compact', (req, p) => {
  const c = store.getConversation(p.id);
  c.compaction = null;
  store.saveConversation(c, false);
  return { ok: true };
});
route('GET', '/api/conversations/:id/export', (req, p, res) => {
  const c = store.getConversation(p.id);
  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(c.title.replace(/[\\/:*?"<>|]/g, '_') || 'chat')}.md`
  });
  res.end(conversationMarkdown(c));
});

// Read-only upload preflight. Local editing always uses the full original.
route('GET', '/api/image-input/:file', (req, p) => {
  if (!/^[A-Za-z0-9._-]+$/.test(p.file) || p.file !== path.basename(p.file)) throw httpErr(400, '잘못된 파일명');
  const file = path.join(store.dirs.uploads, p.file);
  if (!fs.existsSync(file)) throw httpErr(404, '첨부 파일이 없습니다');
  const dimensions = extra.imageSize(file);
  if (!dimensions) throw httpErr(400, '이미지 픽셀 크기를 확인할 수 없습니다');
  const seedream = /seedream/i.test(store.getSettings().imageGen.model || '');
  const sent = seedream ? imageInput.referenceSize(dimensions.width, dimensions.height) : { ...dimensions, resized: false };
  return { original: dimensions, generationInput: sent, localEditUsesOriginal: true, originalPreserved: true };
});

// 업로드 (본문 = 파일 바이너리, 헤더 x-filename)
route('POST', '/api/upload', async (req) => {
  const name = decodeURIComponent(req.headers['x-filename'] || 'file').slice(0, 200) || 'file';
  const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
  const buf = await readBody(req, 2 * 1024 * 1024 * 1024); // 2GB — 첨부 업로드는 사실상 무제한
  const id = newId();
  const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,10}$/) || [''])[0];
  const file = `${id}${ext}`;
  fs.writeFileSync(path.join(store.dirs.uploads, file), buf);
  const att = { id, name, mime, size: buf.length, kind: attachmentKind(name, mime), file, url: `/files/uploads/${file}` };
  return registry.assert('attachment.schema.json', att);
});

// 채팅
route('POST', '/api/chat', async (req, p, res) => {
  const body = await readJson(req);
  registry.applyDefaults('chat-request.schema.json', body);
  registry.assert('chat-request.schema.json', body);
  for (const a of body.attachments) if (!fs.existsSync(path.join(store.dirs.uploads, path.basename(a.file)))) throw httpErr(400, `첨부 파일이 없습니다: ${a.name}`);
  // 한 대화에는 실행을 하나만: 이미 작업이 도는 대화에 보낸 메시지는 그 작업의 추가 지시로 넘긴다
  // (같은 체크포인트를 두 실행이 동시에 처리해 유료 생성이 겹치는 것을 막는다)
  const active = runner.activeRunFor(body.conversationId);
  if (active) {
    const text = String(body.content || '').trim();
    if (body.regenerate || (!text && !body.attachments.length)) throw httpErr(409, '이 대화에서 작업이 진행 중이에요. 추가 지시와 첨부를 보내거나 완료 후 다시 생성해 주세요');
    if (!runner.steer(active, text, { attachments: body.attachments })) throw httpErr(409, '이 대화에서 작업이 진행 중이에요. 끝난 뒤에 다시 보내 주세요');
    return { steered: true, runId: active };
  }
  await runner.handle(req, res, body);
  return undefined;
});
route('POST', '/api/runs/:id/approve', async (req, p) => {
  const b = await readJson(req);
  if (!['allow', 'deny', 'allow_all'].includes(b.decision)) throw httpErr(400, 'decision 값이 잘못되었습니다');
  return { ok: runner.approve(p.id, String(b.callId), b.decision) };
});
// ask_user 질문에 대한 답: choice(보기 번호) 또는 text(직접 입력)
route('POST', '/api/runs/:id/answer', async (req, p) => {
  const b = await readJson(req);
  const choice = Number.isInteger(b.choice) ? b.choice : null;
  return { ok: runner.answer(p.id, String(b.callId), b.hold ? { hold: true } : { choice, text: typeof b.text === 'string' ? b.text : '' }) };
});
// 스티어링: 응답 중에 보낸 추가 지시
route('POST', '/api/runs/:id/steer', async (req, p) => {
  const body = await readJson(req);
  registry.applyDefaults('steer-request.schema.json', body);
  registry.assert('steer-request.schema.json', body);
  if (!body.text.trim() && !body.attachments.length) throw httpErr(400, '보낼 내용이 없습니다');
  if (!runner.steer(p.id, body.text, { attachments: body.attachments, immediate: body.mode === 'immediate' })) throw httpErr(409, '이미 끝난 응답이에요. 새 메시지로 보내 주세요');
  return { ok: true };
});
route('POST', '/api/runs/:id/stop', (req, p) => ({ ok: runner.stop(p.id) }));

// 결정 메모: 질문은 즉시 보존하고 답 없는 의존 작업만 보류한다.
const decisions = require('./lib/decisions');
route('GET', '/api/decisions', () => decisions.load(store).items);
route('POST', '/api/decisions/:id/answer', async (req, p) => runner.answerDecision(p.id, await readJson(req)));

// 메모리 (대화를 넘어 유지)
const extra = require('./lib/tools-extra');
route('GET', '/api/memory', () => extra.loadMemory({ store }).items);
route('POST', '/api/memory', async (req) => {
  const b = await readJson(req);
  const text = String(b.text || '').trim();
  if (!text) throw httpErr(400, '내용을 입력하세요');
  const mem = extra.loadMemory({ store });
  mem.items.push({ id: newId().slice(0, 8), text: text.slice(0, 2000), createdAt: now() });
  extra.saveMemory({ store }, mem);
  return mem.items;
});
route('DELETE', '/api/memory/:id', (req, p) => {
  const mem = extra.loadMemory({ store });
  mem.items = mem.items.filter((m) => m.id !== p.id);
  extra.saveMemory({ store }, mem);
  return mem.items;
});

// 공급자 API 요청 기록 (request id 조회)
route('GET', '/api/requests', (req) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  return requestLog.list({ q: u.searchParams.get('q') || '', kind: u.searchParams.get('kind') || '', status: u.searchParams.get('status') || '', limit: Math.min(1000, Number(u.searchParams.get('limit')) || 200) });
});

// 이미지 목록
route('GET', '/api/images', () => fs.readdirSync(store.dirs.images).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().reverse().slice(0, 300).map((f) => `/files/images/${f}`));

// 프롬프트
route('GET', '/api/prompts', () => store.getPrompts().prompts);
route('POST', '/api/prompts', async (req) => {
  const b = await readJson(req);
  const lib = store.getPrompts();
  const item = { id: newId(), title: b.title, description: b.description || '', content: b.content, tags: b.tags || [], createdAt: now(), updatedAt: now() };
  registry.assert('prompts.schema.json#/$defs/prompt', item);
  lib.prompts.unshift(item);
  store.savePrompts(lib);
  return item;
});
route('PUT', '/api/prompts/:id', async (req, p) => {
  const b = await readJson(req);
  const lib = store.getPrompts();
  const i = lib.prompts.findIndex((x) => x.id === p.id);
  if (i === -1) throw httpErr(404, '프롬프트를 찾을 수 없습니다');
  const item = { ...lib.prompts[i], title: b.title, description: b.description || '', content: b.content, tags: b.tags || [], updatedAt: now() };
  registry.assert('prompts.schema.json#/$defs/prompt', item);
  lib.prompts[i] = item;
  store.savePrompts(lib);
  return item;
});
route('DELETE', '/api/prompts/:id', (req, p) => {
  const lib = store.getPrompts();
  lib.prompts = lib.prompts.filter((x) => x.id !== p.id);
  store.savePrompts(lib);
  return { ok: true };
});

// 스킬
route('GET', '/api/skills', () => rescanSkills());
route('GET', '/api/skills/:name', (req, p) => skills.read(decodeURIComponent(p.name)));
route('PUT', '/api/skills/:name', async (req, p) => {
  const body = await readJson(req);
  registry.assert('skill.schema.json#/$defs/updateRequest', body);
  const name = decodeURIComponent(p.name);
  const result = skills.writeFile(name, 'SKILL.md', body.raw, body.expectedRaw);
  rescanSkills();
  return { skill: skills.read(name), result };
});
route('POST', '/api/skills', async (req) => { skills.create(await readJson(req)); return rescanSkills(); });
route('DELETE', '/api/skills/:name', (req, p) => { skills.remove(decodeURIComponent(p.name)); return rescanSkills(); });

// MCP
route('GET', '/api/mcp', () => ({ config: store.getMcpConfig(), servers: mcp.status() }));
route('PUT', '/api/mcp', async (req) => {
  const cfg = await readJson(req);
  store.saveMcpConfig(cfg);
  await mcp.load(store.getMcpConfig());
  return { config: store.getMcpConfig(), servers: mcp.status() };
});
route('POST', '/api/mcp/:name/restart', async (req, p) => {
  const name = decodeURIComponent(p.name);
  const s = mcp.servers.get(name);
  if (!s) throw httpErr(404, 'MCP 서버를 찾을 수 없습니다');
  if (s.cfg.disabled) throw httpErr(400, '비활성화된 서버입니다');
  await mcp.start(name);
  return { servers: mcp.status() };
});
route('POST', '/api/mcp/:name/prompt', async (req, p) => {
  const b = await readJson(req);
  const r = await mcp.getPrompt(decodeURIComponent(p.name), b.name, b.arguments || {});
  const text = (r.messages || []).map((m) => (m.content?.type === 'text' ? m.content.text : Array.isArray(m.content) ? m.content.map((c) => c.text || '').join('\n') : '')).join('\n\n');
  return { text };
});
route('POST', '/api/mcp/import-claude', async () => {
  const file = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (!fs.existsSync(file)) throw httpErr(404, `Claude Desktop 설정 파일이 없습니다: ${file}`);
  const src = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {};
  const cfg = store.getMcpConfig();
  const added = [], skipped = [];
  for (const [name, s] of Object.entries(src)) {
    const key = name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
    if (cfg.mcpServers[key]) { skipped.push(key); continue; }
    const r = registry.validate('mcp.schema.json#/$defs/stdio', s).valid || registry.validate('mcp.schema.json#/$defs/remote', s).valid;
    if (!r) { skipped.push(key); continue; }
    cfg.mcpServers[key] = { ...s, disabled: true };
    added.push(key);
  }
  store.saveMcpConfig(cfg);
  await mcp.load(store.getMcpConfig());
  return { added, skipped, servers: mcp.status(), config: store.getMcpConfig() };
});

// 폴더 열기
route('POST', '/api/open', async (req) => {
  const { which } = await readJson(req);
  const map = { data: store.data, root: ROOT, ...store.dirs };
  if (!map[which]) throw httpErr(400, '알 수 없는 폴더');
  openInExplorer(map[which]);
  return { ok: true };
});

// 도구 목록 (UI 표시용)
route('GET', '/api/tools', () => ({
  builtin: tools.definitions(store.getSettings(), skills.list().length).map((t) => ({ name: t.function.name, description: t.function.description })),
  mcp: mcp.toolDefinitions().map((t) => ({ name: t.function.name, description: t.function.description }))
}));

// ---------------- HTTP 서버 ----------------
const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  // DNS 리바인딩 방지
  if (!HOST_OK.test(req.headers.host || '')) { res.writeHead(403); res.end('Forbidden host'); return; }

  if (pathname.startsWith('/api/')) {
    lastSeen = Date.now();
    // 다른 웹사이트가 로컬 API 를 호출하지 못하도록 사용자 정의 헤더 요구 (ping/bye 제외)
    if (!['/api/ping', '/api/bye'].includes(pathname) && req.headers['x-flash-client'] !== '1') {
      sendJson(res, 403, { error: '허용되지 않은 요청' });
      return;
    }
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) { sendJson(res, 404, { error: `없는 API: ${req.method} ${pathname}` }); return; }
    const m = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    try {
      const out = await r.handler(req, params, res);
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
    } catch (e) {
      if (!e.status) console.error(`[api] ${req.method} ${pathname}`, e);
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message || String(e), details: e.details });
      else if (!res.writableEnded) res.end();
    }
    return;
  }

  if (pathname.startsWith('/files/')) {
    const [, , kind, ...rest] = pathname.split('/');
    const dir = { uploads: store.dirs.uploads, images: store.dirs.images }[kind];
    const name = path.basename(rest.join('/'));
    if (!dir || !/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(404); res.end(); return; }
    serveFile(res, path.join(dir, name), { 'cache-control': 'private, max-age=31536000', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" });
    return;
  }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  serveFile(res, file, { 'cache-control': 'no-cache' });
});

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[flash] 종료: ${reason}`);
  try { await mcp.stopAll(); } catch { /* 무시 */ }
  try { browser.close(); } catch { /* 무시 */ }
  try { queue.awake.set(false); } catch { /* 무시 */ }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[flash] 처리되지 않은 오류', e));
process.on('unhandledRejection', (e) => console.error('[flash] 처리되지 않은 Promise 거부', e));

const port = Number(process.env.FLASH_PORT) || store.getSettings().server.port;
server.listen(port, '127.0.0.1', async () => {
  runner.recoverHandoffStates();
  scheduler.start();
  queue.start();
  watcher.start();
  bgwaits.start();
  console.log(`[flash] Flash Studio ${VERSION} — http://127.0.0.1:${port}  (${new Date().toLocaleString('ko-KR')})`);
  try { await mcp.load(store.getMcpConfig()); } catch (e) { console.error('[flash] MCP 설정 오류:', e.message); }
  const st = mcp.status();
  if (st.length) console.log(`[flash] MCP: ${st.map((s) => `${s.name}=${s.status}`).join(', ')}`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`[flash] 포트 ${port} 이(가) 이미 사용 중입니다. 이미 실행 중인지 확인하세요.`);
  else console.error('[flash] 서버 오류', e);
  process.exit(1);
});

if (process.env.FLASH_IDLE_EXIT === '1') {
  setInterval(() => {
    const idle = (Date.now() - lastSeen) / 1000;
    if (idle > store.getSettings().server.idleExitSeconds && !runner.activeCount() && !scheduler.keepsAlive() && !queue.keepsAlive() && !watcher.keepsAlive() && !bgwaits.keepsAlive()) shutdown(`유휴 ${Math.round(idle)}초`);
  }, 15000);
}

module.exports = { server, store, registry, SAFE_ID };
