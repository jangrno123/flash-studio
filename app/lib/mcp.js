'use strict';
// 의존성 없는 MCP 클라이언트: stdio / Streamable HTTP / 레거시 SSE
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'flash-studio', version: '1.0.0' };

function quoteWin(a) {
  if (a === '') return '""';
  return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

function sanitize(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }

class BaseClient extends EventEmitter {
  constructor(name, cfg) {
    super();
    this.name = name;
    this.cfg = cfg;
    this.nextId = 1;
    this.pending = new Map();
    this.logs = [];
    this.serverInfo = null;
    this.capabilities = {};
  }

  log(line) {
    const s = String(line).trimEnd();
    if (!s) return;
    this.logs.push(`[${new Date().toLocaleTimeString()}] ${s}`);
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 응답 시간 초과 (${Math.round((timeoutMs || 60000) / 1000)}초)`));
      }, timeoutMs || this.cfg.timeoutMs || 60000);
      this.pending.set(id, { resolve, reject, t });
      this.send(msg).catch((e) => { clearTimeout(t); this.pending.delete(id); reject(e); });
    });
  }

  notify(method, params) {
    return this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  handleMessage(msg) {
    if (Array.isArray(msg)) { msg.forEach((m) => this.handleMessage(m)); return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.t);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message || 'MCP 오류'}${msg.error.code ? ` (${msg.error.code})` : ''}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // 서버 → 클라이언트 요청
      let result, error;
      if (msg.method === 'ping') result = {};
      else if (msg.method === 'roots/list') result = { roots: [] };
      else error = { code: -32601, message: `지원하지 않는 메서드: ${msg.method}` };
      this.send({ jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) }).catch(() => {});
      return;
    }
    if (msg.method === 'notifications/tools/list_changed') this.emit('tools_changed');
    else if (msg.method === 'notifications/message') this.log(`[${msg.params?.level || 'log'}] ${JSON.stringify(msg.params?.data ?? '')}`);
  }

  failAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.t); p.reject(err); }
    this.pending.clear();
  }

  async initialize() {
    const r = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: CLIENT_INFO
    }, Math.max(30000, this.cfg.initTimeoutMs || 0)); // OAuth 로그인이 필요한 서버는 initTimeoutMs 로 기다리는 시간을 늘린다
    this.serverInfo = r.serverInfo || null;
    this.capabilities = r.capabilities || {};
    this.protocolVersion = r.protocolVersion || PROTOCOL_VERSION;
    await this.notify('notifications/initialized');
    return r;
  }
}

class StdioClient extends BaseClient {
  async connect() {
    const { command, args = [], env = {}, cwd } = this.cfg;
    const isWin = process.platform === 'win32';
    const opts = { cwd: cwd || undefined, env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
    // Windows 에서 npx/uvx 같은 .cmd 실행 파일을 쓰려면 셸이 필요하다
    this.proc = isWin
      ? spawn([command, ...args].map(quoteWin).join(' '), { ...opts, shell: true })
      : spawn(command, args, opts);

    this.buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try { this.handleMessage(JSON.parse(line)); } catch { this.log(`(stdout) ${line}`); }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => d.split(/\r?\n/).forEach((l) => this.log(l)));

    await new Promise((resolve, reject) => {
      const onErr = (e) => reject(new Error(`프로세스 실행 실패: ${e.message}`));
      this.proc.once('error', onErr);
      this.proc.once('spawn', () => { this.proc.off('error', onErr); resolve(); });
    });
    this.proc.on('exit', (code) => {
      this.log(`프로세스 종료 (코드 ${code})`);
      this.failAll(new Error(`MCP 서버 프로세스가 종료되었습니다 (코드 ${code})`));
      this.emit('closed', code);
    });
    await this.initialize();
  }

  send(msg) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin.writable) return reject(new Error('MCP 서버에 연결되어 있지 않습니다'));
      this.proc.stdin.write(`${JSON.stringify(msg)}\n`, (e) => (e ? reject(e) : resolve()));
    });
  }

  close() {
    if (!this.proc || this.proc.exitCode !== null) return;
    const pid = this.proc.pid;
    if (process.platform === 'win32' && pid) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    else this.proc.kill();
  }
}

async function* sseEvents(body) {
  const dec = new TextDecoder();
  let buf = '', event = 'message', data = [];
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line === '') {
        if (data.length) yield { event, data: data.join('\n') };
        event = 'message'; data = [];
      } else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length) yield { event, data: data.join('\n') };
}

class HttpClient extends BaseClient {
  async connect() {
    this.sessionId = null;
    await this.initialize();
  }

  headers() {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
      ...(this.cfg.headers || {})
    };
  }

  async send(msg) {
    const res = await fetch(this.cfg.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(msg) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      // 응답이 도착하면 스트림을 계속 읽되 결과는 handleMessage 로 전달
      (async () => {
        try {
          for await (const ev of sseEvents(res.body)) {
            if (!ev.data) continue;
            try { this.handleMessage(JSON.parse(ev.data)); } catch { /* 무시 */ }
          }
        } catch (e) { this.log(`SSE 읽기 오류: ${e.message}`); }
      })();
    } else if (ct.includes('application/json')) {
      const j = await res.json();
      this.handleMessage(j);
    }
  }

  close() {
    if (this.sessionId) fetch(this.cfg.url, { method: 'DELETE', headers: this.headers() }).catch(() => {});
  }
}

class SseClient extends BaseClient {
  async connect() {
    this.abort = new AbortController();
    const res = await fetch(this.cfg.url, { headers: { accept: 'text/event-stream', ...(this.cfg.headers || {}) }, signal: this.abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let resolveEndpoint;
    const endpointReady = new Promise((r, j) => { resolveEndpoint = r; setTimeout(() => j(new Error('endpoint 이벤트를 받지 못했습니다')), 15000); });
    (async () => {
      try {
        for await (const ev of sseEvents(res.body)) {
          if (ev.event === 'endpoint') { this.postUrl = new URL(ev.data, this.cfg.url).toString(); resolveEndpoint(); }
          else if (ev.data) { try { this.handleMessage(JSON.parse(ev.data)); } catch { /* 무시 */ } }
        }
      } catch (e) { if (e.name !== 'AbortError') this.log(`SSE 끊김: ${e.message}`); }
      this.failAll(new Error('SSE 연결이 끊어졌습니다'));
      this.emit('closed');
    })();
    await endpointReady;
    await this.initialize();
  }

  async send(msg) {
    const res = await fetch(this.postUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.cfg.headers || {}) }, body: JSON.stringify(msg) });
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`);
  }

  close() { this.abort?.abort(); }
}

class McpManager {
  constructor() {
    this.servers = new Map(); // name → { cfg, client, status, error, tools, prompts }
    // 연결에 실패한 서버는 30초마다 다시 붙어 본다 (예: 앱보다 늦게 켜진 바오 서버)
    this.retryTimer = setInterval(() => this.retryFailed().catch(() => {}), 30000);
    this.retryTimer.unref?.();
  }

  // 실패할수록 간격을 늘린다 (30초 → 1분 → 2분 … 최대 30분). 로그인 창이 계속 뜨지 않게 한다
  async retryFailed() {
    const now = Date.now();
    for (const s of this.servers.values()) {
      if (s.cfg.disabled || s.status !== 'error' || s.retrying) continue;
      if (s.nextRetry && now < s.nextRetry) continue;
      s.retrying = true;
      try { await this.start(s.name); } finally { s.retrying = false; }
      if (s.status === 'connected') { s.failCount = 0; s.nextRetry = 0; }
      else { s.failCount = (s.failCount || 0) + 1; s.nextRetry = Date.now() + Math.min(30 * 60000, 30000 * 2 ** s.failCount); }
    }
  }

  async load(config) {
    await this.stopAll();
    const entries = Object.entries(config.mcpServers || {});
    for (const [name, cfg] of entries) this.servers.set(name, { name, cfg, client: null, status: 'stopped', error: '', tools: [], prompts: [] });
    await Promise.all(entries.map(([name, cfg]) => (cfg.disabled ? null : this.start(name))));
  }

  async start(name) {
    const s = this.servers.get(name);
    if (!s) throw new Error(`MCP 서버 없음: ${name}`);
    if (s.client) s.client.close();
    s.status = 'connecting'; s.error = ''; s.tools = []; s.prompts = [];
    const type = s.cfg.url ? (s.cfg.type === 'sse' ? 'sse' : 'http') : 'stdio';
    const Client = type === 'sse' ? SseClient : type === 'http' ? HttpClient : StdioClient;
    const client = new Client(name, s.cfg);
    s.client = client;
    client.on('tools_changed', () => this.refresh(name).catch(() => {}));
    client.on('closed', () => { if (s.client === client && s.status !== 'stopped') { s.status = 'error'; s.error = s.error || '연결이 종료되었습니다'; } });
    try {
      await client.connect();
      await this.refresh(name);
      s.status = 'connected';
    } catch (e) {
      s.status = 'error';
      s.error = e.message;
      client.log(`연결 실패: ${e.message}`);
      client.close();
    }
    return this.describe(s);
  }

  async refresh(name) {
    const s = this.servers.get(name);
    const c = s.client;
    const tools = [];
    if (c.capabilities.tools !== undefined || !Object.keys(c.capabilities).length) {
      let cursor;
      do {
        const r = await c.request('tools/list', cursor ? { cursor } : {});
        tools.push(...(r.tools || []));
        cursor = r.nextCursor;
      } while (cursor);
    }
    s.tools = tools;
    if (c.capabilities.prompts !== undefined) {
      try { s.prompts = (await c.request('prompts/list', {})).prompts || []; } catch { s.prompts = []; }
    }
  }

  stop(name) {
    const s = this.servers.get(name);
    if (!s) return;
    s.status = 'stopped';
    if (s.client) s.client.close();
    s.client = null;
    s.tools = [];
  }

  async stopAll() {
    for (const name of this.servers.keys()) this.stop(name);
    this.servers.clear();
  }

  describe(s) {
    return {
      name: s.name,
      type: s.cfg.url ? (s.cfg.type === 'sse' ? 'sse' : 'http') : 'stdio',
      disabled: !!s.cfg.disabled,
      status: s.cfg.disabled ? 'disabled' : s.status,
      error: s.error,
      serverInfo: s.client?.serverInfo || null,
      tools: s.tools.map((t) => ({ name: t.name, description: t.description || '' })),
      prompts: s.prompts.map((p) => ({ name: p.name, description: p.description || '', arguments: p.arguments || [] })),
      logs: s.client ? s.client.logs.slice(-80) : []
    };
  }

  status() { return [...this.servers.values()].map((s) => this.describe(s)); }

  // LLM 에 넘길 도구 목록
  // 모델에 직접 넘길 서버를 고른다. 도구가 많으면 작은 서버만 직접 넘기고 나머지는 mcp_tools / mcp_call 로 쓰게 한다
  // opts: { limit: 직접 넘길 최대 도구 수, pinned: 항상 직접 넘길 서버 이름 }
  directServers(opts = {}) {
    const limit = opts.limit ?? 60;
    const pinned = new Set(opts.pinned || []);
    const live = [...this.servers.values()].filter((s) => s.status === 'connected' && s.tools.length);
    const total = live.reduce((a, s) => a + s.tools.length, 0);
    if (total <= limit) return new Set(live.map((s) => s.name));
    const direct = new Set();
    let used = 0;
    for (const s of live) if (pinned.has(s.name)) { direct.add(s.name); used += s.tools.length; }
    for (const s of [...live].sort((a, b) => a.tools.length - b.tools.length)) {
      if (direct.has(s.name) || s.tools.length > 20 || used + s.tools.length > limit) continue;
      direct.add(s.name); used += s.tools.length;
    }
    return direct;
  }

  // onlyServers 가 주어지면 그 서버 도구만 돌려준다 (인덱스는 항상 전체로 만든다)
  toolDefinitions(onlyServers) {
    const out = [];
    this.index = new Map();
    for (const s of this.servers.values()) {
      if (s.status !== 'connected') continue;
      for (const t of s.tools) {
        let fq = `mcp__${sanitize(s.name)}__${sanitize(t.name)}`;
        if (fq.length > 64) fq = fq.slice(0, 64);
        this.index.set(fq, { server: s.name, tool: t.name, cfg: s.cfg });
        if (onlyServers && !onlyServers.has(s.name)) continue;
        out.push({
          type: 'function',
          function: {
            name: fq,
            description: `[MCP:${s.name}] ${(t.description || t.title || t.name).slice(0, 4000)}`,
            parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }
          }
        });
      }
    }
    return out;
  }

  lookup(fq) { return this.index?.get(fq) || null; }

  // 서버·도구 이름으로 찾기 (mcp_call 용)
  find(server, tool) {
    const s = this.servers.get(server);
    if (!s) return null;
    const t = s.tools.find((x) => x.name === tool);
    if (!t) return null;
    let fq = `mcp__${sanitize(s.name)}__${sanitize(t.name)}`;
    if (fq.length > 64) fq = fq.slice(0, 64);
    if (!this.index) this.toolDefinitions();
    if (!this.index.has(fq)) this.index.set(fq, { server: s.name, tool: t.name, cfg: s.cfg });
    return { fq, server: s.name, tool: t.name, cfg: s.cfg, def: t };
  }

  // 도구 검색 (mcp_tools 용): 이름·설명에서 찾는다
  search(server, query, limit = 15) {
    const q = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const s of this.servers.values()) {
      if (s.status !== 'connected' || (server && s.name !== server)) continue;
      for (const t of s.tools) {
        const hay = `${t.name} ${t.description || ''}`.toLowerCase();
        if (q.length && !q.every((w) => hay.includes(w))) continue;
        out.push({ server: s.name, tool: t, score: q.reduce((a, w) => a + (t.name.toLowerCase().includes(w) ? 2 : 1), 0) });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async callTool(fq, args, timeoutMs) {
    const hit = this.lookup(fq);
    if (!hit) throw new Error(`알 수 없는 MCP 도구: ${fq}`);
    const s = this.servers.get(hit.server);
    if (!s || s.status !== 'connected') throw new Error(`MCP 서버 "${hit.server}" 가 연결되어 있지 않습니다`);
    return s.client.request('tools/call', { name: hit.tool, arguments: args || {} }, timeoutMs || s.cfg.timeoutMs || 180000);
  }

  async getPrompt(server, name, args) {
    const s = this.servers.get(server);
    if (!s || s.status !== 'connected') throw new Error(`MCP 서버 "${server}" 가 연결되어 있지 않습니다`);
    return s.client.request('prompts/get', { name, arguments: args || {} });
  }
}

module.exports = { McpManager };
