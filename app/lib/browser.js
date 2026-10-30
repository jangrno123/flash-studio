'use strict';
// 작업 브라우저: Edge(없으면 Chrome)를 화면 없이 띄우고 DevTools 프로토콜로 조작한다. 외부 패키지 없음.
// 모델은 browser_* 도구로, 사용자는 오른쪽 패널의 "브라우저" 탭으로 같은 창을 본다.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const VIEW = { width: 1280, height: 800 };
const IDLE_CLOSE_MS = 20 * 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 새 창·새 탭으로 열리는 링크를 같은 창에서 열게 한다 (헤드리스라 탭 전환을 볼 수 없으므로)
const BOOT_SCRIPT = `
window.open = function (u) { if (u) location.href = u; return window; };
document.addEventListener('click', function (e) { var a = e.target && e.target.closest && e.target.closest('a[target]'); if (a) a.removeAttribute('target'); }, true);
`;

// 클릭할 수 있는 요소에 번호를 붙이고 목록을 돌려준다
const ELEMENTS_SCRIPT = `(() => {
  const out = []; let n = 0;
  document.querySelectorAll('[data-fs-id]').forEach((e) => e.removeAttribute('data-fs-id'));
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[onclick],[contenteditable=""],[contenteditable=true]';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < -innerHeight || r.top > innerHeight * 3) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none') continue;
    n++; el.setAttribute('data-fs-id', String(n));
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('alt') || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    out.push({ id: n, tag: el.tagName.toLowerCase() + (el.type && el.tagName !== 'BUTTON' ? '[' + el.type + ']' : ''), label, href: el.href ? String(el.href).slice(0, 140) : '', view: r.top >= 0 && r.bottom <= innerHeight });
    if (n >= 150) break;
  }
  return out;
})()`;

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }
};

class WorkBrowser {
  constructor(profileDir) {
    this.profileDir = profileDir;
    this.proc = null;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.waiters = [];
    this.state = { running: false, url: '', title: '', version: 0, busy: false, lastAction: '', error: '' };
    this.shot = null;      // 최근 화면 (jpeg Buffer)
    this.shotAt = 0;
    this.starting = null;
    this.idleTimer = null;
    this.queue = Promise.resolve();
  }

  exe() { return CANDIDATES.find((p) => fs.existsSync(p)) || null; }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
  }

  // 동작은 한 번에 하나씩
  exclusive(label, fn) {
    const run = this.queue.then(async () => {
      this.state.busy = true;
      this.state.lastAction = label;
      this.state.version++;
      try { return await fn(); } finally { this.state.busy = false; this.state.version++; this.touch(); }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async ensure() {
    if (this.ws && this.ws.readyState === 1) return;
    if (!this.starting) this.starting = this.launch().finally(() => { this.starting = null; });
    await this.starting;
  }

  async launch() {
    const exe = this.exe();
    if (!exe) throw new Error('Edge 나 Chrome 을 찾지 못했습니다');
    fs.mkdirSync(this.profileDir, { recursive: true });
    try { fs.unlinkSync(path.join(this.profileDir, 'DevToolsActivePort')); } catch { /* 없음 */ }
    this.proc = spawn(exe, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${this.profileDir}`,
      `--window-size=${VIEW.width},${VIEW.height}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--mute-audio', '--hide-scrollbars', '--lang=ko-KR', 'about:blank'
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', () => { this.proc = null; this.ws = null; this.state.running = false; this.state.version++; });

    // 디버깅 포트는 프로필 폴더의 DevToolsActivePort 에 적힌다
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(150);
      try { port = Number(fs.readFileSync(path.join(this.profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); } catch { /* 아직 */ }
    }
    if (!port) { this.close(); throw new Error('브라우저 디버깅 포트를 열지 못했습니다'); }
    let target = null;
    for (let i = 0; i < 30 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* 재시도 */ }
      if (!target) await sleep(200);
    }
    if (!target) { this.close(); throw new Error('브라우저 페이지를 찾지 못했습니다'); }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = () => reject(new Error('브라우저에 연결하지 못했습니다'));
      ws.onclose = () => { this.ws = null; for (const [, p] of this.pending) p.reject(new Error('브라우저 연결이 끊겼습니다')); this.pending.clear(); };
      ws.onmessage = (ev) => this.onMessage(ev.data);
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT_SCRIPT });
    this.state.running = true;
    this.state.error = '';
    this.state.version++;
    this.touch();
  }

  onMessage(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Page.javascriptDialogOpening') this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    if (msg.method === 'Page.frameNavigated' && msg.params.frame && !msg.params.frame.parentId) { this.state.url = msg.params.frame.url; this.state.version++; }
    for (const w of this.waiters.slice()) if (w.method === msg.method) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg.params); }
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('브라우저가 꺼져 있습니다'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 시간 초과`)); } }, 30000);
    });
  }

  waitFor(method, ms) {
    return new Promise((resolve) => {
      const w = { method, resolve };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i !== -1) { this.waiters.splice(i, 1); resolve(null); } }, ms);
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '스크립트 오류');
    return r.result.value;
  }

  // 페이지가 안정될 때까지 잠깐 기다린다 (클릭 뒤 이동 등)
  async settle(maxMs = 8000) {
    await sleep(400);
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      let ready = 'loading';
      try { ready = await this.evaluate('document.readyState'); } catch { /* 이동 중 */ }
      if (ready === 'complete') break;
      await sleep(250);
    }
    await sleep(300);
    await this.refreshInfo();
  }

  async refreshInfo() {
    try {
      const info = await this.evaluate('({ url: location.href, title: document.title })');
      Object.assign(this.state, info);
    } catch { /* 무시 */ }
    await this.capture();
  }

  async capture() {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
      this.shot = Buffer.from(r.data, 'base64');
      this.shotAt = Date.now();
      this.state.version++;
    } catch { /* 무시 */ }
    return this.shot;
  }

  // 패널이 보고 있을 때 가끔 새로 찍는다
  async freshShot(maxAgeMs = 1500) {
    if (this.state.running && !this.state.busy && Date.now() - this.shotAt > maxAgeMs) await this.capture();
    return this.shot;
  }

  // ---------------- 동작 ----------------
  open(url) {
    return this.exclusive(`열기 ${url}`, async () => {
      await this.ensure();
      let u = String(url || '').trim();
      if (!/^[a-z]+:/i.test(u)) u = /\s/.test(u) || !/\./.test(u) ? `https://www.bing.com/search?q=${encodeURIComponent(u)}` : `https://${u}`;
      if (!/^(https?|about|data|file):/i.test(u)) throw new Error('http(s) 주소만 열 수 있습니다');
      const loaded = this.waitFor('Page.loadEventFired', 20000);
      const r = await this.send('Page.navigate', { url: u });
      if (r.errorText) throw new Error(`열지 못했습니다: ${r.errorText}`);
      await loaded;
      await this.settle(4000);
      return this.state;
    });
  }

  async pointOf(element) {
    const p = await this.evaluate(`(() => { const el = document.querySelector('[data-fs-id="${Number(element)}"]'); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!p) throw new Error(`${element}번 요소가 없습니다. browser_read 로 번호를 다시 확인하세요`);
    return p;
  }

  async mouse(x, y, clickCount = 1) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
  }

  click({ element, x, y, double } = {}) {
    return this.exclusive('클릭', async () => {
      await this.ensure();
      const pt = element != null ? await this.pointOf(element) : { x: Number(x), y: Number(y) };
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) throw new Error('element 번호나 x, y 좌표가 필요합니다');
      await this.mouse(pt.x, pt.y, 1);
      if (double) await this.mouse(pt.x, pt.y, 2);
      await this.settle(6000);
      return this.state;
    });
  }

  type({ element, text, clear, submit } = {}) {
    return this.exclusive('입력', async () => {
      await this.ensure();
      if (element != null) {
        const pt = await this.pointOf(element);
        await this.mouse(pt.x, pt.y, 1);
        await sleep(100);
      }
      if (clear) await this.evaluate(`(() => { const el = document.activeElement; if (!el) return; if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } else if (el.isContentEditable) el.textContent = ''; })()`);
      if (text) await this.send('Input.insertText', { text: String(text) });
      if (submit) await this.pressKey('Enter');
      await this.settle(submit ? 8000 : 1500);
      return this.state;
    });
  }

  async pressKey(name) {
    const k = KEYS[name];
    if (!k) throw new Error(`지원하지 않는 키: ${name} (가능: ${Object.keys(KEYS).join(', ')})`);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined });
  }

  key(name) {
    return this.exclusive(`키 ${name}`, async () => {
      await this.ensure();
      await this.pressKey(name);
      await this.settle(name === 'Enter' ? 8000 : 1500);
      return this.state;
    });
  }

  scroll({ direction = 'down', amount = 1, x, y } = {}) {
    return this.exclusive('스크롤', async () => {
      await this.ensure();
      const dy = (direction === 'up' ? -1 : 1) * Math.max(1, Math.min(20, Number(amount) || 1)) * 600;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(x) || VIEW.width / 2, y: Number(y) || VIEW.height / 2, deltaX: 0, deltaY: dy });
      await sleep(500);
      await this.refreshInfo();
      return this.state;
    });
  }

  wheel(deltaY, x, y) {
    return this.exclusive('스크롤', async () => {
      await this.ensure();
      await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(x) || VIEW.width / 2, y: Number(y) || VIEW.height / 2, deltaX: 0, deltaY: Number(deltaY) || 0 });
      await sleep(250);
      await this.capture();
      return this.state;
    });
  }

  history(dir) {
    return this.exclusive(dir === 'reload' ? '새로고침' : '뒤로', async () => {
      await this.ensure();
      if (dir === 'reload') await this.send('Page.reload');
      else await this.evaluate(dir === 'forward' ? 'history.forward()' : 'history.back()');
      await this.settle(8000);
      return this.state;
    });
  }

  // 모델이 읽을 페이지 내용: 본문 텍스트 + 번호 붙은 요소 목록
  read({ offset = 0, maxChars = 8000, maxElements = 100 } = {}) {
    return this.exclusive('읽기', async () => {
      await this.ensure();
      const text = String(await this.evaluate('(document.body ? document.body.innerText : "")') || '').replace(/\n{3,}/g, '\n\n');
      const els = (await this.evaluate(ELEMENTS_SCRIPT)) || [];
      await this.refreshInfo();
      const part = text.slice(offset, offset + maxChars);
      const lines = els.slice(0, maxElements).map((e) => `[${e.id}] ${e.tag}${e.view ? '' : ' (화면 밖)'} ${e.label ? `"${e.label}"` : ''}${e.href && e.tag === 'a' ? ` → ${e.href}` : ''}`);
      return [
        `# ${this.state.title || '(제목 없음)'}\n${this.state.url}`,
        `## 본문 (${offset.toLocaleString()}~${(offset + part.length).toLocaleString()} / ${text.length.toLocaleString()}자)${offset + part.length < text.length ? ` — 더 보려면 offset ${offset + part.length}` : ''}\n${part || '(본문 텍스트 없음)'}`,
        `## 누를 수 있는 요소 ${els.length}개${els.length > maxElements ? ` (앞 ${maxElements}개만)` : ''} — browser_click / browser_type 의 element 에 번호를 넣는다\n${lines.join('\n') || '(없음)'}`
      ].join('\n\n');
    });
  }

  async screenshotBuffer() {
    await this.ensure();
    return this.exclusive('화면 캡처', () => this.capture());
  }

  close() {
    clearTimeout(this.idleTimer);
    try { if (this.ws) this.ws.close(); } catch { /* 무시 */ }
    try { if (this.proc) this.proc.kill(); } catch { /* 무시 */ }
    this.ws = null;
    this.proc = null;
    this.state.running = false;
    this.state.version++;
  }
}

module.exports = { WorkBrowser, VIEW };
