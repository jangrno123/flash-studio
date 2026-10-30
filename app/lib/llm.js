'use strict';
// OpenAI 호환 Chat Completions 클라이언트 (Ark / DeepSeek / Ollama / LM Studio 등)
const { execFileSync } = require('child_process');

const envCache = new Map();

// `export ARK_API_KEY="..."`, `setx ARK_API_KEY "..."`, `Bearer ...`, 따옴표 등을 통째로 붙여넣어도 키만 남긴다
function cleanKey(raw) {
  let k = String(raw || '').trim().replace(/^bearer\s+/i, '');
  const assign = k.match(/^(?:export\s+|set\s+|\$env:)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.{8,})$/i);
  if (assign) k = assign[1];
  // 공백으로 나뉜 조각 중 가장 긴 것이 키다 (setx NAME "키", 남은 글자 + 키 등)
  const tokens = k.split(/\s+/).map((t) => t.replace(/^["'“”]+|["'“”;,]+$/g, '')).filter(Boolean);
  return tokens.length ? tokens.reduce((a, b) => (b.length > a.length ? b : a)) : '';
}

// 1) 설정에 직접 입력한 키 → 2) 현재 프로세스 환경변수 → 3) Windows 사용자/시스템 환경변수(레지스트리)
function resolveApiKey(provider) {
  if (provider.apiKey) return cleanKey(provider.apiKey);
  const name = provider.apiKeyEnv;
  if (!name) return '';
  if (process.env[name]) return cleanKey(process.env[name]);
  if (process.platform !== 'win32') return '';
  if (envCache.has(name)) return envCache.get(name);
  let val = '';
  for (const hive of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      const out = execFileSync('reg', ['query', hive, '/v', name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`));
      if (m) { val = cleanKey(m[1]); break; }
    } catch { /* 없음 */ }
  }
  if (val) envCache.set(name, val);
  return val;
}

function clearKeyCache() { envCache.clear(); }

function headersFor(provider) {
  const h = { 'content-type': 'application/json', ...(provider.headers || {}) };
  const key = resolveApiKey(provider);
  if (key) h.authorization = `Bearer ${key}`;
  return h;
}

const baseOf = (provider) => provider.baseUrl.replace(/\/+$/, '');

// ---------- API 요청 기록 (공급자 request id 조회용) ----------
let recorder = null;
function setRecorder(fn) { recorder = fn; }
function record(entry) {
  if (!recorder) return;
  try { recorder({ time: new Date().toISOString(), ...entry }); } catch { /* 기록 실패는 무시 */ }
}
const requestIdOf = (res) => res.headers.get('x-request-id') || res.headers.get('x-tt-logid') || null;
const requestIdFromText = (s) => (String(s || '').match(/Request id:\s*([A-Za-z0-9_-]+)/i) || [])[1] || null;

async function httpError(res) {
  let text = '';
  try { text = await res.text(); } catch { /* 무시 */ }
  let msg = text, code = '';
  try { const j = JSON.parse(text); msg = j.error?.message || j.message || text; code = j.error?.code || ''; } catch { /* 텍스트 그대로 */ }
  const hint = res.status === 401 ? ' (API 키를 확인하세요)'
    : res.status === 404 ? ' (Base URL 또는 모델 ID를 확인하세요)'
    : res.status === 429 ? ' (요청 한도 초과)' : '';
  const e = new Error(`HTTP ${res.status}${hint}: ${String(msg).slice(0, 800)}`);
  e.httpStatus = res.status;
  e.code = code;
  e.requestId = requestIdOf(res) || requestIdFromText(msg);
  return e;
}

// ---------- 요청 한도(429) 자동 재시도 ----------
const RETRY_WAITS = [20, 40, 60]; // 초. TPM 한도는 1분 단위로 풀리므로 분 단위로 기다린다

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('중단됨'); e.name = 'AbortError'; reject(e); }, { once: true });
  });
}

// ---------- 일시적 연결 오류(fetch failed) · 서버 5xx 자동 재시도 ----------
// 연결이 순간 끊기거나(ECONNRESET 등) 게이트웨이가 잠깐 죽는 경우. 한 번에 실행 전체가 멈추지 않게 한다
const NET_WAITS = [3, 8, 20, 45, 90]; // 초
const NET_CODES = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|ECONNABORTED|UND_ERR_/;
const netCause = (e) => (e && e.cause && (e.cause.code || e.cause.name)) || '';
function isNetError(e) {
  if (!e || e.name === 'AbortError' || e.httpStatus) return false;
  return e.network === true || e.message === 'fetch failed' || e.message === 'terminated' || NET_CODES.test(netCause(e)) || NET_CODES.test(String(e.code || ''));
}
// 원인 코드를 붙여 무엇이 끊겼는지 기록에 남긴다
function describeNet(e) {
  if (e.network) return e;
  const c = netCause(e);
  e.message = `${e.message}${c ? ` (${c})` : ''} — 모델 서버와의 연결이 끊겼습니다`;
  e.network = true;
  return e;
}

// fetch 를 보내고 429 · 연결 오류 · 5xx 면 기다렸다가 다시 보낸다. 응답이 오기 전 단계라 스트리밍 중복 출력은 생기지 않는다
async function postWithRetry(url, init, { signal, onRetry, log } = {}) {
  let limitTries = 0, netTries = 0;
  const retryLater = async (wait, attempt, max, reason, e) => {
    if (log) record({ ...log, status: 'error', httpStatus: e.httpStatus || null, requestId: e.requestId || null, error: `${String(e.message).slice(0, 300)} → ${wait}초 뒤 재시도 (${attempt}/${max})` });
    if (onRetry) onRetry({ wait, attempt, max, reason, requestId: e.requestId || null });
    await sleep(wait * 1000, signal);
  };
  for (;;) {
    let res;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (e) {
      if (signal?.aborted || !isNetError(e)) throw e;
      describeNet(e);
      if (netTries >= NET_WAITS.length) throw e;
      await retryLater(NET_WAITS[netTries++], netTries, NET_WAITS.length, 'network', e);
      continue;
    }
    if ([500, 502, 503, 504].includes(res.status) && netTries < 3) {
      await retryLater(NET_WAITS[netTries++], netTries, 3, 'server', await httpError(res));
      continue;
    }
    if (res.status !== 429 || limitTries >= RETRY_WAITS.length) return res;
    const e = await httpError(res);
    const header = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(header) && header > 0 ? Math.min(header, 120) : RETRY_WAITS[limitTries];
    await retryLater(wait, ++limitTries, RETRY_WAITS.length, 'limit', e);
  }
}

// 요청 하나를 실행하고 성공·실패를 기록한다
async function tracked(kind, provider, model, meta, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    record({ kind, providerId: provider.id, model, status: 'ok', httpStatus: out.httpStatus || 200, requestId: out.requestId || null, usage: out.usage || null, durationMs: Date.now() - t0, ...meta });
    return out;
  } catch (e) {
    const aborted = e.name === 'AbortError';
    if (!e.requestId) e.requestId = requestIdFromText(e.message);
    record({ kind, providerId: provider.id, model, status: aborted ? 'aborted' : 'error', httpStatus: e.httpStatus || null, requestId: e.requestId || null, error: aborted ? '중단됨' : String(e.message).slice(0, 600), durationMs: Date.now() - t0, ...meta });
    throw e;
  }
}

function thinkingParams(provider, model, thinking) {
  if (thinking == null || model?.reasoning === false) return {};
  if (provider.thinkingStyle === 'thinking_object') return { thinking: { type: thinking ? 'enabled' : 'disabled' } };
  if (provider.thinkingStyle === 'enable_thinking') return { enable_thinking: !!thinking };
  return {};
}

// <think>...</think> 를 content 에 섞어 보내는 로컬 모델 대응
class ThinkSplitter {
  constructor() { this.inThink = false; this.buf = ''; this.started = false; }
  push(chunk, onText, onReasoning) {
    this.buf += chunk;
    for (;;) {
      if (!this.inThink) {
        const idx = this.buf.indexOf('<think>');
        if (idx === -1) {
          const keep = this.partialTail(this.buf, '<think>');
          const out = this.buf.slice(0, this.buf.length - keep);
          if (out) onText(out);
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        if (idx > 0) onText(this.buf.slice(0, idx));
        this.buf = this.buf.slice(idx + 7);
        this.inThink = true;
      } else {
        const idx = this.buf.indexOf('</think>');
        if (idx === -1) {
          const keep = this.partialTail(this.buf, '</think>');
          const out = this.buf.slice(0, this.buf.length - keep);
          if (out) onReasoning(out);
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        if (idx > 0) onReasoning(this.buf.slice(0, idx));
        this.buf = this.buf.slice(idx + 8);
        this.inThink = false;
      }
    }
  }
  flush(onText, onReasoning) { if (this.buf) (this.inThink ? onReasoning : onText)(this.buf); this.buf = ''; }
  partialTail(s, tag) {
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n;
    return 0;
  }
}

async function* sseData(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trimStart();
}

// 스트림 도중 오류 객체를 Error 로 (request id 포함)
function streamError(err, requestId) {
  const e = new Error(err.message || JSON.stringify(err));
  e.code = err.code || '';
  e.requestId = requestIdFromText(e.message) || requestId;
  return e;
}

/**
 * 스트리밍 채팅. onText/onReasoning 콜백으로 조각을 전달하고, 최종 결과를 반환한다.
 * meta: 요청 기록에 함께 남길 정보 { kind, conversationId, messageId, source }
 */
async function streamChat({ provider, model, messages, tools, params = {}, signal, onText, onReasoning, onRetry, meta = {} }) {
  const modelDef = provider.models.find((m) => m.id === model) || { id: model };
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...thinkingParams(provider, modelDef, params.thinking),
    ...(params.temperature != null ? { temperature: params.temperature } : {}),
    ...(params.maxTokens != null ? { max_tokens: params.maxTokens } : {}),
    ...(tools && tools.length ? { tools, tool_choice: params.toolChoice || 'auto' } : {}),
    ...(provider.extraBody || {})
  };

  return tracked('chat', provider, model, meta, async () => {
   for (let streamTry = 0; ; streamTry++) {
    let emitted = false;
    try {
    const res = await postWithRetry(`${baseOf(provider)}/chat/completions`, {
      method: 'POST', headers: headersFor(provider), body: JSON.stringify(body)
    }, { signal, onRetry, log: { kind: 'chat', providerId: provider.id, model, ...meta } });
    if (!res.ok) throw await httpError(res);
    let requestId = requestIdOf(res);

    let content = '', reasoning = '', finishReason = null, usage = null;
    const calls = [];
    const splitter = new ThinkSplitter();
    const emitText = (t) => { emitted = true; content += t; onText && onText(t); };
    const emitReason = (t) => { emitted = true; reasoning += t; onReasoning && onReasoning(t); };

    const handleChoice = (choice) => {
      const delta = choice.delta || choice.message || {};
      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) emitReason(r);
      if (delta.content) splitter.push(delta.content, emitText, emitReason);
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? calls.length;
        const cur = calls[idx] || (calls[idx] = { id: '', name: '', arguments: '' });
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    try {
      const ctype = res.headers.get('content-type') || '';
      if (!ctype.includes('event-stream')) {
        const j = await res.json();
        if (!requestId && j.id) requestId = j.id;
        if (j.error) throw streamError(j.error, requestId);
        for (const c of j.choices || []) handleChoice(c);
        usage = j.usage || null;
      } else {
        for await (const data of sseData(res.body)) {
          if (!data || data === '[DONE]') continue;
          let j;
          try { j = JSON.parse(data); } catch { continue; }
          if (!requestId && j.id) requestId = j.id;
          if (j.error) throw streamError(j.error, requestId);
          for (const c of j.choices || []) handleChoice(c);
          if (j.usage) usage = j.usage;
        }
      }
    } catch (e) {
      if (!e.requestId) e.requestId = requestId;
      throw e;
    }
    splitter.flush(emitText, emitReason);

    const toolCalls = calls.filter((c) => c && c.name).map((c, i) => ({
      id: c.id || `call_${Date.now().toString(36)}_${i}`, name: c.name, arguments: c.arguments || '{}'
    }));
    return { content, reasoning, toolCalls, finishReason, usage, requestId };
    } catch (e) {
      if (signal?.aborted || !isNetError(e)) throw e;
      describeNet(e);
      if (emitted) { e.partial = true; throw e; }
      if (streamTry >= 2) throw e;
      const wait = NET_WAITS[streamTry];
      record({ kind: 'chat', providerId: provider.id, model, ...meta, status: 'error', httpStatus: null, requestId: e.requestId || null, error: `${e.message.slice(0, 300)} (응답 수신 중) → ${wait}초 뒤 재시도 (${streamTry + 1}/3)` });
      if (onRetry) onRetry({ wait, attempt: streamTry + 1, max: 3, reason: 'network', requestId: e.requestId || null });
      await sleep(wait * 1000, signal);
    }
   }
  });
}

async function complete({ provider, model, messages, maxTokens = 60, signal, meta = {} }) {
  const modelDef = provider.models.find((m) => m.id === model) || { id: model };
  const out = await tracked(meta.kind || 'complete', provider, model, meta, async () => {
    const res = await postWithRetry(`${baseOf(provider)}/chat/completions`, {
      method: 'POST',
      headers: headersFor(provider),
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false, ...thinkingParams(provider, modelDef, false), ...(provider.extraBody || {}) })
    }, { signal, log: { kind: meta.kind || 'complete', providerId: provider.id, model, ...meta } });
    if (!res.ok) throw await httpError(res);
    const j = await res.json();
    return { text: j.choices?.[0]?.message?.content || '', requestId: requestIdOf(res) || j.id || null, usage: j.usage || null };
  });
  return out.text;
}

async function listModels(provider) {
  const out = await tracked('models', provider, '', {}, async () => {
    const res = await fetch(`${baseOf(provider)}/models`, { headers: headersFor(provider), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw await httpError(res);
    const j = await res.json();
    return { requestId: requestIdOf(res), list: (j.data || j.models || []).map((m) => ({ id: m.id || m.name, owned_by: m.owned_by || '', created: m.created || null, contextWindow: (m.token_limits && m.token_limits.context_window) || m.context_length || m.context_window || null })) };
  });
  return out.list;
}

// OpenAI / Ark(Seedream) 호환 이미지 생성. 반환: { buffers, requestId }
async function generateImage({ provider, model, prompt, size, images, watermark, extraBody, signal, meta = {} }) {
  const body = {
    model, prompt, response_format: 'b64_json',
    ...(size ? { size } : {}),
    ...(watermark != null ? { watermark } : {}),
    ...(images && images.length ? { image: images.length === 1 ? images[0] : images } : {}),
    ...(extraBody || {})
  };
  return tracked('image', provider, model, meta, async () => {
    const res = await fetch(`${baseOf(provider)}/images/generations`, {
      method: 'POST', headers: headersFor(provider), body: JSON.stringify(body), signal
    });
    if (!res.ok) throw await httpError(res);
    const j = await res.json();
    const requestId = requestIdOf(res) || j.id || null;
    if (j.error) throw streamError(j.error, requestId);
    const buffers = [];
    for (const d of j.data || []) {
      if (d.b64_json) buffers.push(Buffer.from(d.b64_json, 'base64'));
      else if (d.url) {
        const r = await fetch(d.url, { signal });
        if (r.ok) buffers.push(Buffer.from(await r.arrayBuffer()));
      }
    }
    if (!buffers.length) { const e = new Error('이미지 응답이 비어 있습니다'); e.requestId = requestId; throw e; }
    return { buffers, requestId, usage: j.usage || null };
  });
}

module.exports = { isNetError, sleep, streamChat, complete, listModels, generateImage, resolveApiKey, clearKeyCache, cleanKey, setRecorder, requestIdFromText };
