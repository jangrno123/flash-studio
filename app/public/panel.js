'use strict';
/* global S, h, $, api, toast, icon, iconBtn, lightbox, copyText, busy */
// 오른쪽 작업 패널: 결과물 · 브라우저 · 터미널. 모델이 한 일을 채팅 옆에서 바로 본다.


const SIDE_TABS = [['artifacts', '결과물', 'folder'], ['browser', '브라우저', 'eye'], ['terminal', '터미널', 'code']];
const FILE_TOOLS = new Set(['write_file', 'edit_file', 'copy_files', 'zip_files', 'unzip_file', 'download_file', 'save_skill', 'write_skill_file', 'http_request', 'make_dir', 'rename_path', 'edit_image', 'crop_panels', 'pdf_pages']);
const FILE_KEYS = ['path', 'destination', 'dest', 'save_to', 'output', 'outputPath', 'out', 'file', 'target'];

function apiRaw(url) {
  return fetch(url, { headers: { 'X-Flash-Client': '1' } }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r; });
}

function openSide(tab, extra = {}) {
  Object.assign(S.side, { open: true, tab: tab || S.side.tab }, extra);
  renderSide();
}

function closeSide() {
  S.side.open = false;
  stopSideTimer();
  renderSide();
}

function toggleSide() { if (S.side.open) closeSide(); else openSide(S.side.tab); }

function stopSideTimer() { clearInterval(S.side.timer); S.side.timer = null; }

// 코드 블록 미리보기(기존 기능)도 결과물 탭 안에서 연다
function openPanel(code, lang) { openSide('artifacts', { preview: { code, lang }, file: null }); }

function renderSide() {
  const panel = $('#panel');
  stopSideTimer();
  if (!S.side.open) { panel.hidden = true; panel.replaceChildren(); document.body.classList.remove('side-open'); return; }
  panel.hidden = false;
  document.body.classList.add('side-open');
  const tabs = h('div', { class: 'side-tabs' }, ...SIDE_TABS.map(([k, label, ico]) => h('button', { class: S.side.tab === k ? 'on' : '', onclick: () => { S.side.tab = k; renderSide(); } }, icon(ico), label)));
  const body = h('div', { class: 'side-body' });
  panel.replaceChildren(h('div', { class: 'panel-head side-head' }, tabs, h('span', { class: 'spacer' }), iconBtn('x', closeSide, '패널 닫기')), body);
  if (S.side.tab === 'artifacts') drawArtifacts(body);
  else if (S.side.tab === 'browser') drawBrowser(body);
  else drawTerminal(body);
}

// ============================================================
// 결과물
// ============================================================
function collectArtifacts(conv) {
  const images = [];
  const files = new Map();
  const previews = [];
  if (!conv) return { images, files: [], previews };
  for (const m of conv.messages) {
    for (const a of m.attachments || []) files.set(`/files/uploads/${a.file}`, { ref: `/files/uploads/${a.file}`, label: a.name, kind: 'upload', image: a.kind === 'image' });
    for (const p of m.parts || []) {
      if (p.type === 'image' && p.url) images.push(p);
      if (p.type === 'tool_call' && p.status === 'done' && FILE_TOOLS.has(p.name)) {
        let args = {};
        try { args = JSON.parse(p.arguments || '{}'); } catch { continue; }
        for (const k of FILE_KEYS) if (typeof args[k] === 'string' && /[\\/.]/.test(args[k]) && !/^https?:/i.test(args[k])) files.set(args[k], { ref: args[k], label: p.name, kind: 'tool' });
      }
      if (p.type === 'text') {
        const re = /```(html|svg)\s*\n([\s\S]*?)```/g;
        let mm;
        while ((mm = re.exec(p.text))) previews.push({ lang: mm[1], code: mm[2] });
      }
    }
  }
  return { images: images.reverse(), files: [...files.values()].reverse(), previews: previews.reverse() };
}

function drawArtifacts(body) {
  // 미리보기 한 건을 보는 중
  if (S.side.preview) {
    const { code, lang } = S.side.preview;
    const isSvg = lang === 'svg' || /^\s*<svg/i.test(code);
    const doc = isSvg ? `<!doctype html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh">${code}</body></html>` : code;
    let mode = 'preview';
    const view = h('div', { class: 'side-fill' });
    const seg = h('div', { class: 'seg' });
    const draw = () => {
      seg.replaceChildren(h('button', { class: mode === 'preview' ? 'on' : '', onclick: () => { mode = 'preview'; draw(); } }, '미리보기'), h('button', { class: mode === 'code' ? 'on' : '', onclick: () => { mode = 'code'; draw(); } }, '코드'));
      view.replaceChildren(mode === 'preview' ? h('iframe', { sandbox: 'allow-scripts allow-modals allow-forms allow-popups', srcdoc: doc }) : h('pre', null, code));
    };
    draw();
    body.replaceChildren(h('div', { class: 'side-bar' },
      h('button', { class: 'btn sm', onclick: () => { S.side.preview = null; renderSide(); } }, icon('left'), '목록'),
      h('b', null, isSvg ? 'SVG' : 'HTML'), seg, h('span', { class: 'spacer' }),
      iconBtn('copy', () => copyText(code), '복사'),
      iconBtn('download', () => { const a = h('a', { href: URL.createObjectURL(new Blob([code], { type: 'text/html' })), download: isSvg ? 'image.svg' : 'page.html' }); a.click(); }, '저장')), view);
    return;
  }
  // 파일 하나를 보는 중
  if (S.side.file) { drawFileView(body, S.side.file); return; }

  const { images, files, previews } = collectArtifacts(S.conv);
  if (!images.length && !files.length && !previews.length) {
    body.replaceChildren(h('div', { class: 'side-empty' }, icon('folder'), h('p', null, '이 대화에서 만든 이미지, 파일, 웹 미리보기가 여기에 모여요.')));
    return;
  }
  body.replaceChildren(h('div', { class: 'side-scroll' },
    images.length ? h('section', { class: 'art-sec' }, h('h5', null, `이미지 ${images.length}`),
      h('div', { class: 'art-grid' }, ...images.map((im) => h('button', { class: 'art-thumb', title: im.prompt || im.url, onclick: () => lightbox(im.url, im.prompt) }, h('img', { src: im.url, loading: 'lazy', alt: '' }))))) : null,
    previews.length ? h('section', { class: 'art-sec' }, h('h5', null, `웹 미리보기 ${previews.length}`),
      ...previews.map((pv, i) => h('button', { class: 'art-row', onclick: () => { S.side.preview = pv; renderSide(); } }, icon('code'), h('span', { class: 't' }, `${pv.lang.toUpperCase()} ${previews.length - i}`), h('span', { class: 'muted' }, `${pv.code.length.toLocaleString()}자`)))) : null,
    files.length ? h('section', { class: 'art-sec' }, h('h5', null, `파일 ${files.length}`),
      ...files.map((f) => h('button', { class: 'art-row', title: f.ref, onclick: () => { S.side.file = f; renderSide(); } }, icon(f.image ? 'image' : 'file'), h('span', { class: 't' }, f.ref.split(/[\\/]/).pop()), h('span', { class: 'muted' }, f.kind === 'upload' ? '첨부' : f.label)))) : null));
}

async function drawFileView(body, f) {
  const head = h('div', { class: 'side-bar' },
    h('button', { class: 'btn sm', onclick: () => { S.side.file = null; renderSide(); } }, icon('left'), '목록'),
    h('b', { title: f.ref }, f.ref.split(/[\\/]/).pop()), h('span', { class: 'spacer' }),
    iconBtn('folder', () => api('POST', '/api/files/reveal', { path: f.ref }).catch((e) => toast(e.message, 'error')), '탐색기에서 보기'),
    iconBtn('copy', () => copyText(f.ref), '경로 복사'));
  const view = h('div', { class: 'side-fill' }, h('div', { class: 'side-empty' }, h('span', { class: 'spin' })));
  body.replaceChildren(head, view);
  if (f.image || /\.(png|jpe?g|webp|gif)$/i.test(f.ref)) {
    const src = f.ref.startsWith('/files/') ? f.ref : null;
    view.replaceChildren(src ? h('div', { class: 'side-img' }, h('img', { src, onclick: () => lightbox(src) })) : h('div', { class: 'side-empty' }, h('p', null, f.ref), h('p', { class: 'muted' }, '앱 폴더 밖 이미지는 탐색기에서 열어 주세요.')));
    return;
  }
  try {
    const r = await api('GET', `/api/files/preview?path=${encodeURIComponent(f.ref)}`);
    if (r.dir) view.replaceChildren(h('pre', null, `${r.path}\n\n${r.entries.join('\n')}`));
    else if (r.text != null) {
      const isHtml = /\.html?$/i.test(r.path);
      view.replaceChildren(isHtml
        ? h('iframe', { sandbox: 'allow-scripts', srcdoc: r.text })
        : h('pre', null, r.text + (r.truncated ? '\n\n…(앞부분만 표시)' : '')));
    } else view.replaceChildren(h('div', { class: 'side-empty' }, h('p', null, r.path), h('p', { class: 'muted' }, `${(r.size / 1024).toFixed(1)} KB · 미리보기를 지원하지 않는 형식이에요`)));
  } catch (e) {
    view.replaceChildren(h('div', { class: 'side-empty' }, h('p', null, e.message)));
  }
}

// ============================================================
// 브라우저
// ============================================================
function drawBrowser(body) {
  const url = h('input', { type: 'text', class: 'mono', placeholder: '주소나 검색어를 넣고 Enter' });
  const status = h('div', { class: 'br-status' });
  const img = h('img', { class: 'br-shot', alt: '', draggable: false });
  const empty = h('div', { class: 'side-empty' }, icon('eye'), h('p', null, '모델이 브라우저를 쓰면 여기에 화면이 실시간으로 떠요. 위에 주소를 넣어 직접 열 수도 있어요.'));
  const screen = h('div', { class: 'br-screen' }, empty, img);
  const typeIn = h('input', { type: 'text', placeholder: '화면을 누른 뒤 여기에 입력하면 브라우저로 들어가요' });
  const act = (path, payload, quiet) => api('POST', `/api/browser/${path}`, payload).then(() => poll(true)).catch((e) => { if (!quiet) toast(e.message, 'error'); });
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && url.value.trim()) { act('open', { url: url.value.trim() }); url.blur(); } });
  typeIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); act('type', { text: typeIn.value, submit: true }); typeIn.value = ''; }
  });
  img.addEventListener('click', (e) => {
    const r = img.getBoundingClientRect();
    act('click', { x: ((e.clientX - r.left) / r.width) * img.naturalWidth, y: ((e.clientY - r.top) / r.height) * img.naturalHeight });
  });
  let wheelAcc = 0;
  let wheelT = null;
  img.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheelAcc += e.deltaY;
    clearTimeout(wheelT);
    wheelT = setTimeout(() => { const d = wheelAcc; wheelAcc = 0; act('scroll', { deltaY: d * 1.5 }, true); }, 120);
  }, { passive: false });

  body.replaceChildren(
    h('div', { class: 'side-bar' },
      iconBtn('left', () => act('nav', { action: 'back' }), '뒤로'),
      iconBtn('right', () => act('nav', { action: 'forward' }), '앞으로'),
      iconBtn('refresh', () => act('nav', { action: 'reload' }), '새로고침'),
      url,
      iconBtn('power', () => act('close', {}), '브라우저 닫기')),
    status, screen,
    h('div', { class: 'side-bar br-type' }, typeIn,
      h('button', { class: 'btn sm', onclick: () => { act('type', { text: typeIn.value }); typeIn.value = ''; } }, '입력'),
      h('button', { class: 'btn sm', onclick: () => act('key', { key: 'Enter' }) }, 'Enter')));

  let lastUrl = '';
  const poll = async (force) => {
    let st;
    try { st = await api('GET', '/api/browser/state'); } catch { return; }
    if (!st.available) { empty.replaceChildren(h('p', null, 'Edge 나 Chrome 을 찾지 못해 작업 브라우저를 쓸 수 없어요.')); img.hidden = true; empty.hidden = false; return; }
    status.replaceChildren(
      st.busy ? h('span', { class: 'spin' }) : h('span', { class: `br-dot${st.running ? ' on' : ''}` }),
      h('span', { class: 't' }, st.running ? (st.busy ? `${st.lastAction}…` : (st.title || st.url || '빈 페이지')) : '꺼져 있음'));
    if (st.url !== lastUrl && document.activeElement !== url) { url.value = st.url && st.url !== 'about:blank' ? st.url : ''; lastUrl = st.url; }
    if (!st.running) { img.hidden = true; empty.hidden = false; return; }
    if (force || st.version !== S.side.shotVer || !st.busy) {
      try {
        const blob = await (await apiRaw(`/api/browser/shot?t=${Date.now()}`)).blob();
        if (S.side.shotUrl) URL.revokeObjectURL(S.side.shotUrl);
        S.side.shotUrl = URL.createObjectURL(blob);
        img.src = S.side.shotUrl;
        img.hidden = false;
        empty.hidden = true;
        S.side.shotVer = st.version;
      } catch { /* 아직 화면 없음 */ }
    }
  };
  poll(true);
  S.side.timer = setInterval(() => { if (!document.hidden) poll(false); }, 1200);
}

// ============================================================
// 터미널
// ============================================================
function drawTerminal(body) {
  const log = h('div', { class: 'term-log' });
  const promptEl = h('span', { class: 'term-ps' });
  const input = h('input', { type: 'text', class: 'term-in', placeholder: '명령을 입력하고 Enter (PowerShell)', spellcheck: false });
  input.addEventListener('keydown', async (e) => {
    const hist = S.side.history;
    if (e.key === 'ArrowUp') { e.preventDefault(); if (hist.length) { S.side.hIdx = Math.max(0, (S.side.hIdx < 0 ? hist.length : S.side.hIdx) - 1); input.value = hist[S.side.hIdx]; } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (S.side.hIdx >= 0) { S.side.hIdx = Math.min(hist.length, S.side.hIdx + 1); input.value = hist[S.side.hIdx] || ''; } return; }
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const cmd = input.value.trim();
    if (cmd === 'cls' || cmd === 'clear') { input.value = ''; await api('POST', '/api/terminal/clear', {}); poll(true); return; }
    hist.push(cmd);
    S.side.hIdx = -1;
    input.value = '';
    try { await api('POST', '/api/terminal/run', { command: cmd }); poll(true); } catch (err) { toast(err.message, 'error'); }
  });
  body.replaceChildren(
    h('div', { class: 'side-bar' }, h('b', null, 'PowerShell'), h('span', { class: 'muted' }, '모델이 실행한 명령도 여기에 보여요'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: async () => { await api('POST', '/api/terminal/clear', {}); poll(true); } }, '지우기')),
    log,
    h('div', { class: 'term-input', onclick: () => input.focus() }, promptEl, input));

  const poll = async (force) => {
    let snap;
    try { snap = await api('GET', `/api/terminal${S.conv ? `?conv=${S.conv.id}` : ''}`); } catch { return; }
    promptEl.textContent = `PS ${snap.cwd}>`;
    if (!force && snap.version === S.side.termVer) return;
    S.side.termVer = snap.version;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren(...(snap.entries.length ? snap.entries.map((e) => h('div', { class: `term-entry${e.running ? ' running' : ''}${e.code && e.code !== 0 ? ' fail' : ''}` },
      h('div', { class: 'term-cmd' }, h('span', { class: `term-src ${e.source}` }, e.source === 'model' ? '모델' : '나'), h('span', { class: 'term-ps' }, `PS ${e.cwd}>`), h('span', null, e.command),
        e.running ? h('button', { class: 'compact-btn', onclick: () => api('POST', '/api/terminal/kill', { id: e.id }).then(() => poll(true)) }, '중지') : null),
      e.out ? h('pre', null, e.out) : null,
      !e.running && e.code !== 0 ? h('div', { class: 'term-code' }, `종료 코드 ${e.code}`) : null)) : [h('div', { class: 'side-empty' }, h('p', null, '아직 실행한 명령이 없어요.'))]));
    if (atBottom || force) log.scrollTop = log.scrollHeight;
  };
  poll(true);
  S.side.timer = setInterval(() => { if (!document.hidden) poll(false); }, 1000);
  setTimeout(() => input.focus(), 30);
}

// 모델이 도구를 쓰면 해당 탭을 자동으로 연다 (한 응답에 한 번)
function sideAutoOpen(part, run) {
  const tab = part.name.startsWith('browser_') ? 'browser' : part.name === 'run_command' ? 'terminal' : null;
  if (!tab || (run && run.sideOpened)) return;
  if (run) run.sideOpened = true;
  if (!S.side.open || S.side.tab !== tab) openSide(tab, { preview: null, file: null });
}
