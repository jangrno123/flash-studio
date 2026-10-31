'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const MEDIA_TOOLS = ['image_gen', 'image_edit', 'image_to_video', 'reference_to_video'];
const redact = value => String(value || '').replace(/xai-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+/g, '[redacted]').replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
function subscriptionEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/API_KEY$|API_TOKEN$|AUTH_TOKEN$|ACCESS_TOKEN$/i.test(key)) delete env[key];
  env.GROK_DISABLE_AUTOUPDATER = '1';
  return env;
}
function assertSubscriptionConfig(home = process.env.GROK_HOME || path.join(os.homedir(), '.grok')) {
  const config = path.join(home, 'config.toml');
  if (fs.existsSync(config)) {
    const bindings = fs.readFileSync(config, 'utf8').split(/\r?\n/).filter(line => !/^\s*#/.test(line) && /^\s*(api_key|env_key|api_key_env)\s*=/.test(line) && !/=\s*["']["']\s*(#.*)?$/.test(line));
    if (bindings.length) throw new Error('Grok 설정에 API 키 연결이 있습니다. 구독 전용 모드에서는 실행하지 않습니다. Grok의 API 키 설정을 해제하고 구독 계정으로 로그인하세요.');
  }
  return home;
}
function defaultCli() { return process.env.GROK_CLI_PATH || path.join(os.homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'); }
function mediaPermission(call, options, title = String(call.title || '')) {
  const variant = typeof call.rawInput?.variant === 'string' ? call.rawInput.variant : '';
  const explicit = MEDIA_TOOLS.find(tool => new RegExp('(^|[.\\s/])' + tool + '($|[\\s(:])').test(title));
  const byVariant = MEDIA_TOOLS.find(tool => tool.replace(/_/g, '') === variant.toLowerCase().replace(/[^a-z]/g, ''));
  const name = variant ? byVariant : explicit || (/^imagine:\s/i.test(title) ? 'image_gen' : undefined);
  const choice = options.find(option => String(option.kind).replace(/[^a-z]/gi, '').toLowerCase() === 'allowonce');
  return { name, choice, variant, allowed: !!name && !!choice };
}

class GrokClient extends EventEmitter {
  constructor({ cwd, cliPath = defaultCli(), timeoutMs = 900000 } = {}) {
    super(); this.cwd = cwd; this.cliPath = cliPath; this.timeoutMs = timeoutMs;
    this.nextId = 0; this.pending = new Map(); this.toolTitles = new Map(); this.stderr = ''; this.closed = false;
  }
  async connect() {
    assertSubscriptionConfig();
    if (!path.isAbsolute(this.cliPath) || !fs.existsSync(this.cliPath)) throw new Error('Grok CLI를 찾을 수 없습니다. 공식 Grok CLI를 설치한 뒤 연결하세요.');
    const args = ['--tools', MEDIA_TOOLS.join(','), '--permission-mode', 'default', '--deny', 'MCPTool', '--no-plan', '--no-subagents', '--disable-web-search', '--reasoning-effort', 'low', '--max-turns', '8', '--cwd', this.cwd, 'agent', 'stdio'];
    this.proc = spawn(this.cliPath, args, { cwd: this.cwd, env: subscriptionEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('error', error => this.fail(error));
    this.proc.on('exit', code => this.fail(new Error(`Grok CLI가 종료됐습니다 (${code}). ${this.stderr.slice(-800)}`)));
    this.proc.stderr.on('data', chunk => { this.stderr = redact((this.stderr + chunk.toString()).slice(-4000)); });
    this.lines = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!message.method && pending) {
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(redact(message.error.message || JSON.stringify(message.error)))); else pending.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        // Generation tools have explicit allow rules; never grant an unexpected tool or filesystem request.
        if (message.method === 'session/request_permission') {
          const call=message.params?.toolCall||{};
          const title=this.toolTitles.get(call.toolCallId||call.id)||String(call.title||'');
          const {name,choice,variant}=mediaPermission(call,message.params?.options||[],title);
          this.emit('permission',{tool:name||title,kind:call.kind,variant,id:call.toolCallId||call.id,knownTools:[...this.toolTitles.values()].slice(-3),inputKeys:Object.keys(call.rawInput||{}),allowed:!!name&&!!choice,options:(message.params?.options||[]).map(option=>({id:option.optionId,kind:option.kind}))});
          this.send({ id: message.id, result: { outcome: name&&choice ? {outcome:'selected',optionId:choice.optionId} : { outcome: 'cancelled' } } });
        } else this.send({ id: message.id, error: { code: -32601, message: 'This client only permits Grok built-in media generation.' } });
      } else if (message.method === 'session/update') {
        const update=message.params?.update;
        if(update?.toolCallId&&update.title)this.toolTitles.set(update.toolCallId,String(update.title));
        this.emit('update', message.params);
      }
    });
    const init = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'flash-studio-grok-subscription', version: '1.0.0' } }, 30000);
    const method = init.authMethods?.find(item => item.id === 'grok.com') || init.authMethods?.find(item => item.id === 'cached_token');
    if (!method) throw new Error('Grok CLI에서 구독 계정 로그인 방식을 제공하지 않습니다. API 방식으로 전환하지 않았습니다.');
    await this.request('authenticate', { methodId: method.id, _meta: { headless: true } }, 45000);
    this.authMethod = method.id;
    return init;
  }
  send(message) { if (this.proc?.stdin.writable) this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  request(method, params, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('Grok 연결이 닫혀 있습니다.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Grok ${method} 대기 시간이 초과됐습니다. 자동 재생성하지 않았습니다.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  async newSession() { const result = await this.request('session/new', { cwd: this.cwd, mcpServers: [] }, 45000); this.sessionId = result.sessionId; return result; }
  async prompt(text) { return this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }); }
  fail(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  close() {
    if (this.closed) return; this.closed = true;
    if (this.sessionId) this.send({ method: 'session/cancel', params: { sessionId: this.sessionId } });
    this.fail(new Error('Grok 작업이 취소됐습니다.'));
    this.lines?.close(); this.proc?.stdin.end();
    if (this.proc && this.proc.exitCode === null) {
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else this.proc.kill();
    }
  }
}
module.exports = { GrokClient, MEDIA_TOOLS, defaultCli, subscriptionEnvironment, assertSubscriptionConfig, redact, mediaPermission };
