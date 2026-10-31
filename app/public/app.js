/* Flash Studio 프런트엔드 (의존성 없음) */
'use strict';

// ============================================================
// 기본 유틸
// ============================================================
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  prompt: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  skill: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  clip: '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2.5"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  pin: '<path d="M12 17v5M9 10.8V4h6v6.8l3 3.2H6z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  note: '<path d="M4 4h16v12l-4 4H4z"/><path d="M16 20v-4h4M8 9h8M8 13h5"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  power: '<path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  code: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>'
};

const $ = (s, el = document) => el.querySelector(s);

function icon(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return t.content.firstChild;
}

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const iconBtn = (name, onclick, title, cls = '') => h('button', { class: `icon-btn ${cls}`, onclick, title, 'aria-label': title }, icon(name));

async function api(method, url, body) {
  const opt = { method, headers: { 'x-flash-client': '1' } };
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opt); }
  catch (cause) { throw new Error('Flash 로컬 서버와 연결되지 않았습니다. 요청을 자동으로 다시 제출하지 않습니다. 연결 복구 후 기존 작업 상태를 확인하세요.', { cause }); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const e = new Error((data && data.error) || `HTTP ${res.status}`);
    e.details = data && data.details;
    throw e;
  }
  return data;
}

function toast(msg, type = '') {
  const t = h('div', { class: `toast ${type}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 2600);
}

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtDur = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`);
const clone = (o) => JSON.parse(JSON.stringify(o));

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('복사했어요'); }
  catch { toast('복사하지 못했어요', 'error'); }
}

function parseVars(content) {
  const out = [];
  const seen = new Set();
  const re = /\{\{\s*([^}:]+?)\s*(?::([^}]*))?\}\}/g;
  let m;
  while ((m = re.exec(content))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ name: m[1], def: m[2] || '' });
  }
  return out;
}
const fillVars = (content, values) => content.replace(/\{\{\s*([^}:]+?)\s*(?::([^}]*))?\}\}/g, (_, n, d) => values[n] ?? d ?? '');

// ============================================================
// 상태
// ============================================================
const S = {
  settings: null, convs: [], prompts: [], skills: [], mcp: [], dirs: {}, root: '', version: '',
  conv: null, convCache: new Map(),
  route: { view: 'chat', id: null },
  run: null,
  draft: { text: '', attachments: [], skills: [] },
  opts: { thinking: false, imageMode: false, tools: true },
  search: '',
  open: new Set(),
  slash: { open: false, items: [], sel: 0, mode: 'all' },
  modals: [],
  pop: null,
  editing: null,
  toolList: null,
  projects: [], routines: null, queue: null, queueFilter: 'open', routinesRunning: [], pendingProjectId: null,
  side: { open: false, tab: 'artifacts', preview: null, file: null, timer: null, shotUrl: null, shotVer: -1, termVer: -1, history: [], hIdx: -1 }
};

const main = () => $('#main');
const busy = () => !!(S.run && !S.run.done);
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

function currentSel() {
  const st = S.settings;
  const c = S.conv;
  const providerId = (c && c.providerId) || st.activeProviderId;
  const provider = st.providers.find((p) => p.id === providerId) || st.providers[0];
  const model = (c && c.model) || st.activeModel || provider.models[0].id;
  const def = provider.models.find((m) => m.id === model) || { id: model, label: model };
  return { provider, model, def };
}

function applyAppearance() {
  const a = S.settings.appearance;
  const root = document.documentElement;
  if (a.theme === 'system') delete root.dataset.theme; else root.dataset.theme = a.theme;
  root.dataset.size = a.fontSize;
  root.dataset.font = a.responseFont;
}

// ============================================================
// 초기화 / 라우팅
// ============================================================
async function init() {
  try {
    const saved = sessionStorage.getItem('fs.handoff-repair-draft');
    if (saved) {
      const draft = JSON.parse(saved);
      if (typeof draft.text === 'string' && Array.isArray(draft.attachments) && Array.isArray(draft.skills)) S.draft = draft;
      sessionStorage.removeItem('fs.handoff-repair-draft');
    }
  } catch { /* 서버 수정 적용 시에도 기존 입력은 유효한 형식으로만 복구한다. */ }
  try {
    const st = await api('GET', '/api/state');
    Object.assign(S, { settings: st.settings, convs: st.conversations, prompts: st.prompts, skills: st.skills, mcp: st.mcp, dirs: st.dirs, root: st.root, version: st.version, imageInputPolicy: st.imageInputPolicy || null });
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">서버에 연결하지 못했습니다: ${e.message}</div>`;
    return;
  }
  await refreshProjects();
  await loadQueue();
  // 대기열 배지는 어느 화면에서든 가끔 새로 고친다
  setInterval(async () => { if (S.route.view === 'queue') return; const before = JSON.stringify((S.queue.jobs || []).map((j) => j.status)); await loadQueue(); if (JSON.stringify(S.queue.jobs.map((j) => j.status)) !== before) renderSidebar(); }, 10000);
  S.opts.thinking = S.settings.generation.thinking;
  try { if (localStorage.getItem('fs.collapsed') === '1') $('#app').classList.add('collapsed'); } catch { /* 무시 */ }
  applyAppearance();
  window.addEventListener('hashchange', route);
  bindGlobal();
  route();
  setInterval(() => fetch('/api/ping').catch(() => {}), 15000);
  setInterval(refreshMcpQuiet, 20000);
  window.addEventListener('pagehide', () => navigator.sendBeacon('/api/bye'));
  window.addEventListener('resize', () => { const ta = $('#composer-input'); if (ta) autoGrow(ta); });
}

function parseHash() {
  const p = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (p[0] === 'c' && p[1]) return { view: 'chat', id: p[1] };
  if (p[0] === 'p' && p[1]) return { view: 'project', id: p[1] };
  if (['prompts', 'skills', 'mcp', 'images', 'media', 'requests', 'projects', 'archive', 'routines', 'queue'].includes(p[0])) return { view: p[0], id: p[1] || null };
  return { view: 'chat', id: null };
}

async function route() {
  const r = parseHash();
  S.route = r;
  closePopover();
  if (r.view === 'chat') {
    if (r.id) S.pendingProjectId = null;
    if (r.id) {
      if (!S.conv || S.conv.id !== r.id) {
        try {
          S.conv = (S.run && S.run.convId === r.id && S.convCache.get(r.id)) || await api('GET', `/api/conversations/${r.id}`);
          S.convCache.set(r.id, S.conv);
        } catch (e) { toast(e.message, 'error'); location.hash = '#/'; return; }
      }
    } else S.conv = null;
  }
  renderSidebar();
  renderMain();
}

function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function newChat(prefill, projectId = null) {
  S.conv = null;
  S.pendingProjectId = projectId;
  if (prefill) Object.assign(S.draft, prefill);
  go('#/');
  setTimeout(() => $('#composer-input')?.focus(), 30);
}

// ============================================================
// 사이드바
// ============================================================
function groupLabel(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return '오늘';
  if (diff <= 1) return '어제';
  if (diff <= 7) return '지난 7일';
  if (diff <= 30) return '지난 30일';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}

function renderSidebar() {
  const sb = $('#sidebar');
  const r = S.route;
  const nav = (ico, label, hash, active, extra) => h('button', { class: `nav-item${active ? ' active' : ''}`, onclick: () => go(hash) }, icon(ico), h('span', null, label), extra);
  const connected = S.mcp.filter((s) => s.status === 'connected').length;

  const list = h('div', { class: 'sb-list' });
  const q = S.search.trim().toLowerCase();
  // 보관된 대화는 목록·검색에서 뺀다 (CONTEXT.md §10)
  const convs = S.convs.filter((c) => !c.archived && (!q || c.title.toLowerCase().includes(q)));
  const projects = (S.projects || []).filter((p) => !p.archived && (!q || p.name.toLowerCase().includes(q)));
  if (projects.length) {
    list.append(h('div', { class: 'sb-group' }, '프로젝트'));
    for (const p of projects.slice(0, 8)) {
      const active = (r.view === 'project' && r.id === p.id) || (r.view === 'chat' && S.conv && S.conv.projectId === p.id);
      list.append(h('div', { class: `conv-item proj${active ? ' active' : ''}`, onclick: () => go(`#/p/${p.id}`), title: p.description || p.name },
        projectDot(p), h('span', { class: 't' }, p.name),
        h('span', { class: 'count' }, S.convs.filter((c) => c.projectId === p.id && !c.archived).length)));
    }
    if (projects.length > 8) list.append(h('button', { class: 'sb-more', onclick: () => go('#/projects') }, `프로젝트 ${projects.length - 8}개 더 보기`));
  }
  if (!convs.length) list.append(h('div', { class: 'sb-empty' }, q ? '검색 결과가 없어요' : '아직 대화가 없어요'));
  const pinned = convs.filter((c) => c.pinned);
  const rest = convs.filter((c) => !c.pinned);
  const addItem = (c) => {
    const active = r.view === 'chat' && S.conv && S.conv.id === c.id;
    const streaming = S.run && S.run.convId === c.id;
    const p = projectById(c.projectId);
    list.append(h('div', { class: `conv-item${active ? ' active' : ''}`, onclick: () => go(`#/c/${c.id}`), title: p ? `${p.name} · ${c.title}` : c.title },
      p ? projectDot(p, 7) : null,
      h('span', { class: 't' }, c.title || '새 대화'),
      c.watch ? h('span', { class: 'watch-ic', title: '자동 점검이 켜져 있어요' }, icon('refresh')) : null,
      streaming ? h('span', { class: 'dot' }) : null,
      iconBtn('more', (e) => { e.stopPropagation(); convMenu(e.currentTarget, c); }, '더보기')));
  };
  if (pinned.length) { list.append(h('div', { class: 'sb-group' }, '고정됨')); pinned.forEach(addItem); }
  let last = '';
  for (const c of rest) {
    const g = groupLabel(c.updatedAt);
    if (g !== last) { list.append(h('div', { class: 'sb-group' }, g)); last = g; }
    addItem(c);
  }

  const search = h('input', { type: 'search', placeholder: '대화 검색', value: S.search, id: 'sb-search' });
  search.addEventListener('input', () => { S.search = search.value; const pos = search.selectionStart; renderSidebar(); const n = $('#sb-search'); n.focus(); n.setSelectionRange(pos, pos); });

  sb.replaceChildren(
    h('div', { class: 'sb-top' },
      h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), 'Flash Studio'),
      iconBtn('sidebar', toggleSidebar, '사이드바 접기 (Ctrl+B)')),
    h('div', { class: 'sb-nav' },
      h('button', { class: 'nav-item new', onclick: () => newChat() }, h('span', { class: 'plus' }, icon('plus')), h('span', null, '새 채팅')),
      nav('folder', '프로젝트', '#/projects', r.view === 'projects' || r.view === 'project', h('span', { class: 'count' }, (S.projects || []).filter((p) => !p.archived).length)),
      nav('refresh', '루틴', '#/routines', r.view === 'routines'),
      nav('bolt', '작업 대기열', '#/queue', r.view === 'queue', queueBadge()),
      nav('prompt', '프롬프트', '#/prompts', r.view === 'prompts', h('span', { class: 'count' }, S.prompts.length)),
      nav('skill', '스킬', '#/skills', r.view === 'skills', h('span', { class: 'count' }, S.skills.length)),
      nav('plug', 'MCP 커넥터', '#/mcp', r.view === 'mcp', h('span', { class: 'count' }, `${connected}/${S.mcp.length}`)),
      nav('image', '이미지 갤러리', '#/images', r.view === 'images'),
      nav('bolt', 'Grok · ANIMA 제작', '#/media', r.view === 'media'),
      nav('hash', '요청 기록', '#/requests', r.view === 'requests')),
    h('div', { class: 'sb-search' }, icon('search'), search),
    list,
    h('div', { class: 'sb-foot' },
      nav('download', '보관함', '#/archive', r.view === 'archive', h('span', { class: 'count' }, S.convs.filter((c) => c.archived).length || '')),
      h('button', { class: 'nav-item', onclick: () => openSettings() }, icon('settings'), h('span', null, '설정'))));
}

function toggleSidebar() {
  const app = $('#app');
  app.classList.toggle('collapsed');
  try { localStorage.setItem('fs.collapsed', app.classList.contains('collapsed') ? '1' : '0'); } catch { /* 무시 */ }
  renderMain();
}

function convMenu(anchor, c) {
  popover(anchor, [
    menuItem('edit', '이름 바꾸기', () => renameConv(c)),
    menuItem('pin', c.pinned ? '고정 해제' : '고정하기', () => patchConv(c.id, { pinned: !c.pinned })),
    menuItem('folder', c.projectId ? '다른 프로젝트로 옮기기' : '프로젝트로 옮기기', () => setTimeout(() => moveToProject(anchor, c), 0)),
    menuItem('download', '보관하기', () => archiveConv(c, true)),
    menuItem('file', '마크다운으로 내보내기', () => exportConv(c.id)),
    h('div', { class: 'menu-sep' }),
    menuItem('trash', '삭제', () => deleteConv(c), 'danger')
  ]);
}

async function refreshConvs() {
  try { S.convs = await api('GET', '/api/conversations'); renderSidebar(); } catch { /* 무시 */ }
}

async function patchConv(id, patch) {
  try {
    const c = await api('PATCH', `/api/conversations/${id}`, patch);
    if (S.conv && S.conv.id === id) Object.assign(S.conv, patch);
    S.convCache.set(id, S.conv && S.conv.id === id ? S.conv : c);
    await refreshConvs();
    if (S.conv && S.conv.id === id) renderMain();
  } catch (e) { toast(e.message, 'error'); }
}

async function renameConv(c) {
  const t = await inputDialog('대화 이름 바꾸기', c.title);
  if (t && t.trim()) patchConv(c.id, { title: t.trim().slice(0, 200) });
}

async function deleteConv(c) {
  if (!(await confirmDialog('대화 삭제', `"${c.title}" 대화를 삭제할까요? 되돌릴 수 없어요.`, '삭제', true))) return;
  try {
    await api('DELETE', `/api/conversations/${c.id}`);
    S.convCache.delete(c.id);
    if (S.conv && S.conv.id === c.id) { S.conv = null; go('#/'); }
    await refreshConvs();
  } catch (e) { toast(e.message, 'error'); }
}

function exportConv(id) {
  fetch(`/api/conversations/${id}/export`, { headers: { 'x-flash-client': '1' } })
    .then(async (r) => {
      const blob = await r.blob();
      const name = decodeURIComponent((r.headers.get('content-disposition') || '').split("''")[1] || 'chat.md');
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }).catch((e) => toast(e.message, 'error'));
}

// ============================================================
// 메인 영역
// ============================================================
function renderMain() {
  const v = S.route.view;
  if (v === 'prompts') return renderPrompts();
  if (v === 'skills') return S.route.id ? renderSkillDetail(S.route.id) : renderSkills();
  if (v === 'mcp') return renderMcp();
  if (v === 'images') return renderImages();
  if (v === 'media') {
    if (document.querySelector('#main .media-studio')) return; // Sidebar toggles must preserve the form and playing media.
    return window.FlashMedia.render(document.getElementById('main'));
  }
  if (v === 'requests') return renderRequests();
  if (v === 'projects') return renderProjects();
  if (v === 'project') return renderProject(S.route.id);
  if (v === 'archive') return renderArchive();
  if (v === 'routines') return renderRoutines();
  if (v === 'queue') return renderQueue();
  return renderChat();
}

function topbar(...kids) {
  const collapsed = $('#app').classList.contains('collapsed');
  return h('div', { class: 'topbar' },
    collapsed ? iconBtn('sidebar', toggleSidebar, '사이드바 열기 (Ctrl+B)') : null,
    collapsed ? iconBtn('plus', () => newChat(), '새 채팅') : null,
    ...kids);
}

function greeting() {
  const hr = new Date().getHours();
  if (hr < 5) return '늦은 시간까지 고생이 많아요';
  if (hr < 11) return '좋은 아침이에요';
  if (hr < 17) return '오늘은 무엇을 해볼까요?';
  if (hr < 22) return '좋은 저녁이에요';
  return '오늘 하루도 수고했어요';
}

function renderChat() {
  const m = main();
  const c = S.conv;
  const empty = !c || !c.messages.length;

  const convSkills = (c && c.skills) || [];
  const bar = topbar(
    (() => { const p = projectById(c ? c.projectId : S.pendingProjectId); return p ? h('button', { class: 'chip proj-chip', onclick: () => go(`#/p/${p.id}`), title: '프로젝트 열기' }, projectDot(p), p.name) : null; })(),
    c ? h('button', { class: 'title-btn', onclick: () => renameConv(c), title: '이름 바꾸기' }, c.title) : null,
    c && c.archived ? h('button', { class: 'chip', onclick: () => archiveConv(c, false), title: '누르면 보관 해제' }, icon('download'), '보관된 대화') : null,
    c && c.queueJobId ? h('button', { class: 'chip accent', onclick: () => go('#/queue'), title: '대기열이 자동으로 처리하는 대화예요' }, icon('bolt'), '대기열 작업') : null,
    c && !c.queueJobId ? watchChip(c) : null,
    c && (c.bgWaits || []).length ? bgChip(c) : null,
    ...convSkills.map((n) => h('span', { class: 'chip accent', title: '이 대화에 적용 중인 스킬' }, icon('skill'), n)),
    c && c.systemPrompt ? h('span', { class: 'chip', title: c.systemPrompt.slice(0, 300) }, icon('note'), '대화 지침') : null,
    h('span', { class: 'spacer' }),
    iconBtn('sidebar', () => toggleSide(), '작업 패널 (결과물 · 브라우저 · 터미널)', S.side.open ? 'on' : ''),
    c ? iconBtn('more', (e) => chatMenu(e.currentTarget), '대화 메뉴') : null);
  // 대기열 작업이 이 대화를 처리 중이면 진행 상황을 계속 받아 온다
  if (c && (c.queueJobId || (c.watch && c.watch.enabled) || (c.bgWaits || []).length || c.handoff?.autoResume || c.handedOffTo || needsHandoffResume(c))) watchQueueConversation();
  if (needsHandoffResume(c) && !busy()) queueMicrotask(() => resumePendingHandoff(c));
  // 결과물 목록은 대화가 바뀌면 다시 그린다
  if (S.side.open && S.side.tab === 'artifacts' && !S.side.preview && !S.side.file) setTimeout(renderSide, 0);

  if (empty) {
    const { provider } = currentSel();
    const needKey = !provider.hasKey && !/127\.0\.0\.1|localhost/.test(provider.baseUrl);
    m.replaceChildren(bar, h('div', { class: 'hero' },
      h('h1', null, h('img', { src: 'icon.svg', alt: '' }), greeting()),
      needKey ? h('div', { class: 'err-box', style: { maxWidth: '780px', margin: '0 auto 14px', width: '100%' } },
        `${provider.name} API 키가 아직 없어요. 설정 → 모델 공급자에서 키를 넣거나, 환경변수 ${provider.apiKeyEnv || '(이름 지정 필요)'} 를 등록한 뒤 앱을 다시 켜 주세요. `,
        h('button', { class: 'btn sm', onclick: () => openSettings('providers') }, '설정 열기')) : null,
      h('div', { class: 'composer-wrap centered' }, renderComposer()),
      h('div', { class: 'suggest' },
        ...S.prompts.slice(0, 3).map((p) => h('button', { onclick: () => usePrompt(p) }, icon('prompt'), p.title)),
        h('button', { onclick: () => { S.opts.imageMode = true; renderMain(); $('#composer-input').focus(); } }, icon('image'), '이미지 만들기'),
        h('button', { onclick: () => go('#/skills') }, icon('skill'), '스킬 둘러보기'))));
    return;
  }

  const thread = h('div', { class: 'thread', id: 'thread' });
  if (c.handoff) thread.append(handoffCard(c));
  const lastIdx = c.messages.length - 1;
  c.messages.forEach((msg, i) => {
    thread.append(renderMessage(msg, i === lastIdx));
    if (c.compaction && msg.id === c.compaction.upToMessageId) thread.append(compactionDivider(c));
  });
  if (c.handedOffTo) thread.append(h('div', { class: 'handoff-note' }, icon('right'), h('span', null, '이 대화는 새 대화로 이어졌어요'), h('button', { class: 'compact-btn', onclick: () => go(`#/c/${c.handedOffTo}`) }, '이어진 대화로 가기')));
  const scroll = h('div', { class: 'scroll', id: 'scroll' }, thread);
  const jump = h('button', { class: 'jump', hidden: true, onclick: () => { scroll.scrollTop = scroll.scrollHeight; } }, icon('arrowDown'));
  scroll.addEventListener('scroll', () => { jump.hidden = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 200; });
  m.replaceChildren(bar, scroll, jump, h('div', { class: 'composer-wrap' }, h('div', { class: 'handoff-hint', id: 'handoff-hint', hidden: true }), renderComposer(), h('div', { class: 'comp-hint' }, 'AI는 실수할 수 있어요. 중요한 내용은 한 번 더 확인하세요.')));
  requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}

// 자동 점검 (CONTEXT.md §14): 채팅방에서 켜고 끈다. 작업이 중간에 끊기면 다시 가동하고, 끝나면 스스로 꺼진다
const WATCH_STATE = { watching: '점검 중', running: '다시 가동 중', busy: '작업 중', idle: '답 기다리는 중', paused: '멈춤', done: '완료', off: '꺼짐' };
function watchChip(c) {
  const w = c.watch;
  const on = !!(w && w.enabled);
  const next = on && w.nextCheckAt ? new Date(w.nextCheckAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
  const label = on ? `자동 점검 · ${WATCH_STATE[w.state] || '점검 중'}` : w && w.state === 'done' ? '자동 점검 · 끝나서 꺼짐' : '자동 점검';
  const tip = on
    ? [`${w.intervalMin || 30}분마다 이 대화를 확인해요. 작업이 중간에 끊겼으면 다시 가동하고, 끝나면 스스로 꺼져요.`, next ? `다음 점검: ${next}` : '', w.note ? `최근: ${w.note}` : ''].filter(Boolean).join('\n')
    : (w && w.note ? `${w.note}\n` : '') + '켜 두면 주기적으로 이 대화를 확인해서, 작업이 중간에 끊겼을 때 다시 가동해요';
  return h('button', { class: `chip${on ? ' accent' : ''}`, title: tip, onclick: (e) => watchMenu(e.currentTarget, c) }, icon(on ? 'check' : 'refresh'), label);
}

// 백그라운드 확인 (CONTEXT.md §15): 서버가 대신 상태를 보고 있는 작업들
function bgChip(c) {
  const waits = c.bgWaits || [];
  const tip = ['서버가 상태를 대신 확인하고 있어요. 끝나면 결과가 이 대화에 들어오고 이어서 진행해요.', ...waits.map((w) => `· ${w.label} (${new Date(w.startedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}부터)`)].join('\n');
  return h('button', { class: 'chip', title: tip, onclick: (e) => bgMenu(e.currentTarget, c) }, icon('refresh'), `백그라운드 확인 ${waits.length}건`);
}

function bgMenu(anchor, c) {
  popover(anchor, (c.bgWaits || []).map((w) => menuItem('x', `확인 그만두기 · ${w.label}`, async () => {
    try {
      await api('DELETE', `/api/conversations/${c.id}/bgwaits/${w.id}`);
      c.bgWaits = c.bgWaits.filter((x) => x.id !== w.id);
      renderMain();
      toast('확인을 그만뒀어요. 그 작업 결과는 따로 알려 드리지 않아요');
    } catch (e) { toast(e.message, 'error'); }
  })), { align: 'left' });
}

function watchMenu(anchor, c) {
  const w = c.watch || {};
  const on = !!w.enabled;
  const set = async (body) => {
    try {
      const r = await api('PUT', `/api/conversations/${c.id}/watch`, body);
      c.watch = r.watch;
      const meta = S.convs.find((x) => x.id === c.id);
      if (meta) meta.watch = r.watch.enabled ? r.watch.state : null;
      renderMain();
      renderSidebar();
      toast(r.watch.enabled ? `자동 점검을 켰어요. ${r.watch.intervalMin}분마다 확인해요` : '자동 점검을 껐어요');
    } catch (e) { toast(e.message, 'error'); }
  };
  popover(anchor, [
    on ? menuItem('x', '자동 점검 끄기', () => set({ enabled: false })) : menuItem('check', '자동 점검 켜기 (30분마다)', () => set({ enabled: true, intervalMin: w.intervalMin || 30 })),
    h('div', { class: 'menu-sep' }),
    ...[15, 30, 60].map((m) => menuItem('refresh', `${m}분마다 확인${on && (w.intervalMin || 30) === m ? ' (지금 설정)' : ''}`, () => set({ enabled: true, intervalMin: m })))
  ], { align: 'left' });
}

function chatMenu(anchor) {
  const c = S.conv;
  popover(anchor, [
    menuItem('edit', '이름 바꾸기', () => renameConv(c)),
    menuItem('pin', c.pinned ? '고정 해제' : '고정하기', () => patchConv(c.id, { pinned: !c.pinned })),
    menuItem('note', '대화 지침 (시스템 프롬프트)', () => editConvSystem()),
    menuItem('refresh', '대화 정리 (앞부분 요약)', () => compactConv()),
    menuItem('right', '새 대화로 이어가기 (인계서)', () => startHandoff()),
    menuItem('folder', c.projectId ? '다른 프로젝트로 옮기기' : '프로젝트로 옮기기', () => setTimeout(() => moveToProject(anchor, c), 0)),
    menuItem('download', c.archived ? '보관 해제' : '보관하기', () => archiveConv(c, !c.archived)),
    menuItem('skill', '대화에 스킬 적용', () => editConvSkills()),
    menuItem('download', '마크다운으로 내보내기', () => exportConv(c.id)),
    h('div', { class: 'menu-sep' }),
    menuItem('trash', '삭제', () => deleteConv(c), 'danger')
  ], { align: 'right' });
}

// 입력창 컨텍스트 표시기 (CONTEXT.md §5)
function ctxMeter() {
  const el = h('button', { class: 'ctx-meter', id: 'ctx-meter', hidden: true, onclick: async () => {
    if (!S.conv || busy()) return;
    if (await confirmDialog('대화 정리', '지금 앞부분을 요약해서 컨텍스트를 비울까요? 원래 메시지는 화면에 그대로 남아요.', '정리')) compactConv();
  } }, h('span', { class: 'ctx-bar' }, h('span', { class: 'ctx-fill' }), h('span', { class: 'ctx-mark' })), h('span', { class: 'ctx-lbl' }));
  setTimeout(() => {
    if (S.conv && S.ctxInfo && S.ctxInfo.convId === S.conv.id) paintCtxMeter(S.ctxInfo);
    if (!busy()) refreshCtxMeter();
  }, 0);
  return el;
}

async function refreshCtxMeter() {
  const c = S.conv;
  if (!c || !c.messages.length) { paintCtxMeter(null); return; }
  const { provider, model } = currentSel();
  try {
    const info = await api('GET', `/api/conversations/${c.id}/context?provider=${encodeURIComponent(provider.id)}&model=${encodeURIComponent(model)}`);
    if (S.conv && S.conv.id === c.id) { S.ctxInfo = { convId: c.id, ...info }; paintCtxMeter(S.ctxInfo); }
  } catch { paintCtxMeter(null); }
}

function paintCtxMeter(info) {
  const el = $('#ctx-meter');
  if (!el) return;
  paintHandoffHint(info);
  if (!info || !info.tokens) { el.hidden = true; return; }
  const n = (v) => Math.round(v).toLocaleString();
  const pctOf = (v, base) => { const p = (v / base) * 100; return p < 10 ? Math.round(p * 10) / 10 : Math.round(p); };
  const base = info.window || info.threshold;
  const left = Math.max(0, Math.round((1 - info.tokens / info.threshold) * 100));
  el.hidden = false;
  el.className = `ctx-meter${info.tokens >= info.threshold ? ' full' : info.tokens >= info.threshold * 0.8 || info.handoffAdvice ? ' warn' : ''}`;
  $('.ctx-fill', el).style.width = `${Math.min(100, (info.tokens / base) * 100)}%`;
  $('.ctx-mark', el).style.left = `${Math.min(100, (info.threshold / base) * 100)}%`;
  $('.ctx-lbl', el).textContent = (info.window ? `${pctOf(info.tokens, info.window)}%` : `${Math.round(info.tokens / 1000)}K`) + (info.archiveTokens != null ? ` · 원문 ${Math.round(info.archiveTokens / 10000)}만 / ${Math.round(info.handoffThreshold / 10000)}만` : '');
  const auto = info.autoCompact
    ? `자동 정리: ${info.window ? `${pctOf(info.threshold, info.window)}% 지점, ` : ''}${n(info.threshold)} 토큰${info.limitBy === 'cap' ? ' (설정한 요청 예산)' : ''} · ${left}% 남음`
    : '자동 정리 꺼짐';
  el.title = [
    info.window ? `컨텍스트 ${n(info.tokens)} / ${n(info.window)} 토큰 (${pctOf(info.tokens, info.window)}%)` : `컨텍스트 약 ${n(info.tokens)} 토큰 (모델 컨텍스트 창 미설정)`,
    info.source === 'estimated' ? '다음 요청 전까지는 추정치예요' : '',
    auto,
    info.archiveTokens != null ? `원문 누적 추정 ${n(info.archiveTokens)} / 전환 ${n(info.handoffThreshold)} 토큰 (반복 입력 과금 제외)` : '',
    info.handoffAdvice ? `${info.handoffAdvice} — '새 대화로 이어가기'를 권해요` : '',
    '누르면 지금 정리해요'
  ].filter(Boolean).join('\n');
}

// 컨텍스트 정리 표시: 이 선 위쪽은 모델에게 요약으로만 전달된다
function compactionDivider(c) {
  const k = c.compaction;
  return h('div', { class: 'compact-divider' },
    h('span', null, `여기까지 메시지 ${k.summarizedCount}개는 요약으로 모델에 전달돼요`),
    h('button', { class: 'compact-btn', onclick: () => modal({ title: '이전 대화 요약', wide: true, body: h('div', { class: 'md', html: Markdown.render(k.summary) }) }) }, '요약 보기'),
    h('button', { class: 'compact-btn', onclick: async () => {
      if (!(await confirmDialog('정리 해제', '요약을 없애고 전체 대화를 다시 원문으로 보낼까요? 요청이 커질 수 있어요.', '해제'))) return;
      try { await api('DELETE', `/api/conversations/${c.id}/compact`); c.compaction = null; renderMain(); } catch (e) { toast(e.message, 'error'); }
    } }, '정리 해제'));
}

// ---------------- 핸드오프 (CONTEXT.md §9) ----------------
// 인계서 초안을 만들고, 사용자가 확인·수정한 뒤 새 대화를 연다
async function startHandoff() {
  const c = S.conv;
  if (!c || busy()) { toast('응답이 끝난 뒤에 이어갈 수 있어요'); return; }
  if (!c.messages.length) { toast('인계할 대화가 없어요'); return; }
  const body = h('div', { class: 'handoff-edit' }, h('p', { class: 'help' }, h('span', { class: 'spin' }), ' 지금까지의 대화로 인계서를 쓰는 중이에요. 대화가 길면 1분쯤 걸려요.'));
  let draft = null;
  const startBtn = h('button', { class: 'btn primary', disabled: true, onclick: async () => {
    startBtn.disabled = true;
    try {
      const r = await api('POST', `/api/conversations/${c.id}/handoff`, { summary: ta.value, files: draft.files });
      c.handedOffTo = r.conversation.id;
      S.convCache.set(r.conversation.id, r.conversation);
      md.close();
      await refreshConvs();
      S.draft = { text: '인계서를 확인하고 "다음 할 일"의 첫 번째부터 이어서 진행해 줘.', attachments: [], skills: [] };
      history.replaceState(null, '', `#/c/${r.conversation.id}`);
      await route();
      toast('새 대화로 넘어왔어요. 원문과 인계서를 대조해 자동으로 이어갑니다');
      await send();
    } catch (e) { startBtn.disabled = false; toast(e.message, 'error'); }
  } }, '새 대화에서 이어가기');
  const ta = h('textarea', { class: 'input mono', rows: 20 });
  const md = modal({ title: '새 대화로 이어가기', wide: true, body, foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'), startBtn] });
  try {
    draft = await api('POST', `/api/conversations/${c.id}/handoff/draft`);
    ta.value = draft.summary;
    body.replaceChildren(
      h('p', { class: 'help' }, '연결된 대화의 지침·작업별 상태를 대조한 인계서입니다. 원문은 보존되고 새 대화에서도 검색·복구할 수 있어요. 공급자·모델·대화 지침·스킬은 그대로 옮겨 가며 전환 후 자동으로 이어갑니다.'),
      ta,
      draft.files.length ? h('details', { class: 'handoff-files' }, h('summary', null, `자동으로 붙는 파일 ${draft.files.length}개`), h('ul', null, ...draft.files.map((x) => h('li', null, h('span', { class: 'muted' }, `${x.label}: `), h('code', null, x.ref))))) : null);
    startBtn.disabled = false;
  } catch (e) {
    body.replaceChildren(h('p', { class: 'help' }, `인계서를 만들지 못했어요: ${e.message}`));
  }
}

function handoffCard(c) {
  const k = c.handoff;
  return h('div', { class: 'handoff-card' },
    h('div', { class: 'handoff-head' }, icon('note'), h('b', null, '이전 대화에서 이어받음'), h('span', { class: 'muted' }, k.fromTitle)),
    h('div', { class: 'handoff-actions' },
      h('button', { class: 'compact-btn', onclick: () => go(`#/c/${k.fromConversationId}`) }, '원래 대화 열기'),
      h('button', { class: 'compact-btn', onclick: () => editHandoff(c) }, '인계서 보기·고치기')));
}

function editHandoff(c) {
  const ta = h('textarea', { class: 'input mono', rows: 22, value: c.handoff.summary });
  const md = modal({
    title: '인계서', wide: true,
    body: h('div', { class: 'handoff-edit' }, h('p', { class: 'help' }, '이 대화의 모든 요청에 이 내용이 함께 들어가요. 고치면 다음 요청부터 적용돼요.'), ta),
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '닫기'),
      h('button', { class: 'btn primary', onclick: async () => {
        try { const r = await api('PUT', `/api/conversations/${c.id}/handoff`, { summary: ta.value }); c.handoff = r.handoff; md.close(); toast('인계서를 저장했어요'); } catch (e) { toast(e.message, 'error'); }
      } }, '저장')]
  });
}

function paintHandoffHint(info) {
  const el = $('#handoff-hint');
  if (!el) return;
  const c = S.conv;
  if (S.run?.handoffProgress && S.run.convId === c?.id) {
    const p = S.run.handoffProgress;
    el.hidden = false;
    el.replaceChildren(h('span', null, p.total ? `인계 작성 ${p.completed}/${p.total} · 완료한 조각은 저장됩니다. 끝나면 새 대화에서 자동 재개합니다.` : '인계 원문을 확인하고 있습니다. 끝나면 새 대화에서 자동 재개합니다.'));
    return;
  }
  // 이미 인계된 대화: 보내면 새 대화에서 이어진다 (서버가 따라간다)
  if (c && c.handedOffTo && !busy()) {
    el.hidden = false;
    el.replaceChildren(h('span', null, '이 대화는 새 대화로 인계됐어요. 여기서 보내도 새 대화에서 이어져요.'),
      h('button', { class: 'compact-btn', onclick: () => go(`#/c/${c.handedOffTo}`) }, '새 대화 보기'));
    return;
  }
  if (!info || !info.handoffAdvice || busy()) { el.hidden = true; return; }
  el.hidden = false;
  // 자동 인계가 켜져 있으면 누를 것 없이 다음 메시지부터 새 대화로 이어진다
  if (S.settings.generation.autoHandoff !== false) {
    el.replaceChildren(h('span', null, `${info.handoffAdvice}. 다음 메시지를 보내면 인계서를 만들어 자동으로 새 대화에서 이어가요.`));
    return;
  }
  el.replaceChildren(h('span', null, `${info.handoffAdvice}. 새 대화로 이어가면 더 빠르고 정확해요.`),
    h('button', { class: 'compact-btn', onclick: () => startHandoff() }, '새 대화로 이어가기'),
    iconBtn('x', () => { el.hidden = true; }, '닫기'));
}

async function compactConv() {
  const c = S.conv;
  if (!c || busy()) { toast('응답이 끝난 뒤에 정리할 수 있어요'); return; }
  toast('앞부분을 요약하는 중이에요…');
  try {
    const r = await api('POST', `/api/conversations/${c.id}/compact`);
    c.compaction = r.compaction;
    toast(`메시지 ${r.compaction.summarizedCount}개를 요약했어요 (약 ${r.compaction.tokensBefore.toLocaleString()} → ${(r.compaction.tokensAfter || 0).toLocaleString()} 토큰)`);
    renderMain();
  } catch (e) { toast(e.message, 'error'); }
}

function editConvSystem() {
  const c = S.conv;
  const ta = h('textarea', { class: 'input', rows: 10, value: c.systemPrompt, placeholder: '예: 너는 10년 차 영상 연출가야. 답은 짧고 실무적으로.' });
  const md = modal({
    title: '대화 지침',
    body: [h('p', { class: 'page-desc' }, '이 대화에서만 쓰이는 시스템 프롬프트예요. 설정의 기본 지침 뒤에 붙습니다.'), ta],
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'), h('button', { class: 'btn primary', onclick: () => { patchConv(c.id, { systemPrompt: ta.value }); md.close(); } }, '저장')]
  });
  ta.focus();
}

function editConvSkills() {
  const c = S.conv;
  const sel = new Set(c.skills || []);
  const list = S.skills.map((s) => h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked: sel.has(s.name), onchange: (e) => (e.target.checked ? sel.add(s.name) : sel.delete(s.name)) }),
    h('span', null, s.name, h('span', { class: 'd' }, s.description.slice(0, 120)))));
  const md = modal({
    title: '대화에 스킬 적용',
    body: [h('p', { class: 'page-desc' }, '체크한 스킬은 이 대화의 모든 메시지에 전체 지침이 포함돼요. 체크하지 않은 스킬도 모델이 필요할 때 스스로 불러올 수 있어요.'), list.length ? list : h('div', { class: 'empty' }, '스킬이 없어요')],
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'), h('button', { class: 'btn primary', onclick: () => { patchConv(c.id, { skills: [...sel] }); md.close(); } }, '저장')]
  });
}

// ============================================================
// 메시지 렌더링
// ============================================================
function attChip(a, removable) {
  const isImg = a.kind === 'image';
  const src = a.preview || a.url;
  const ext = (a.name.split('.').pop() || '').slice(0, 4);
  return h('div', { class: `att${a.uploading ? ' uploading' : ''}`, title: a.name },
    isImg && src ? h('img', { src, alt: '', onclick: () => lightbox(src) }) : h('div', { class: 'ficon' }, ext || 'file'),
    h('div', { class: 'meta' }, h('b', null, a.name), h('small', null, a.uploading ? '올리는 중…' : fmtSize(a.size))),
    removable ? h('button', { class: 'x', onclick: () => { S.draft.attachments = S.draft.attachments.filter((x) => x !== a); refreshComposer(); }, title: '빼기' }, icon('x')) : null);
}

function renderMessage(m, isLast) {
  return m.role === 'user' ? renderUserMsg(m) : renderAssistantMsg(m, isLast);
}

function renderUserMsg(m) {
  const el = h('div', { class: 'msg user', 'data-id': m.id });
  if (S.editing === m.id) {
    const ta = h('textarea', { value: m.content, rows: 3 });
    const box = h('div', { class: 'edit-box' }, ta, h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: () => { S.editing = null; renderMain(); } }, '취소'),
      h('button', { class: 'btn sm primary', onclick: () => resendEdited(m, ta.value) }, '보내기')));
    el.append(box);
    setTimeout(() => { ta.focus(); ta.style.height = `${ta.scrollHeight}px`; }, 10);
    return el;
  }
  if (m.attachments && m.attachments.length) el.append(h('div', { class: 'atts' }, m.attachments.map((a) => attChip(a, false))));
  if (m.skills && m.skills.length) el.append(h('div', { class: 'atts' }, m.skills.map((s) => h('span', { class: 'chip accent' }, icon('skill'), s))));
  if (m.content) el.append(h('div', { class: 'bubble' }, m.content));
  el.append(h('div', { class: 'msg-actions' },
    iconBtn('copy', () => copyText(m.content), '복사'),
    !busy() ? iconBtn('edit', () => { S.editing = m.id; renderMain(); }, '고쳐서 다시 보내기') : null));
  return el;
}

function groupParts(parts) {
  const blocks = [];
  for (const p of parts || []) {
    if (p.type === 'image') {
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'gallery') last.items.push(p); else blocks.push({ type: 'gallery', items: [p] });
    } else blocks.push(p);
  }
  return blocks;
}

function blockSig(b, live) {
  if (b.type === 'video') return `v${b.url}`;
  if (b.type === 'gallery') return `g${b.items.length}`;
  if (b.type === 'steer') return `s${b.id || ''}${b.delivery || ''}${b.text.length}${(b.attachments || []).map(a => a.id).join(',')}`;
  if (b.type === 'tool_call') return `c${b.id}${b.status}${b.deadline ? 'd' : ''}${(b.result || '').length}`;
  return `${b.type[0]}${b.text.length}${live ? 'L' : ''}${b.durationMs || ''}`;
}

function renderBlock(b, m, idx, live) {
  if (b.type === 'video') return h('div', {class:'media-video-block'},h('video',{src:b.url,controls:true,preload:'metadata',style:{width:'100%',maxHeight:'560px'},'aria-label':b.prompt||'생성 영상'}),h('div',{class:'muted'},b.model||'생성 영상'),h('a',{href:b.url,download:'',class:'btn sm'},'영상 저장'));
  if (b.type === 'text') {
    return h('div', { class: 'md', html: Markdown.render(b.text) });
  }
  if (b.type === 'steer') return h('div', { class: 'steer-note' }, icon('right'), h('span', { class: 'lbl' }, b.delivery === 'pending' ? '추가 지시 · 반영 대기' : '추가 지시 · 반영됨'), h('span', { class: 'txt' }, b.text), ...(b.attachments || []).map(a => attChip(a, false)));
  if (b.type === 'reasoning') {
    const key = `${m.id}:${idx}`;
    const d = h('details', { class: `think${live ? ' live' : ''}` });
    if (S.open.has(key)) d.open = true;
    d.addEventListener('toggle', () => (d.open ? S.open.add(key) : S.open.delete(key)));
    d.append(h('summary', null, icon('right', 'chev'), h('span', { class: 'lbl' }, live ? '생각하는 중…' : `생각 과정${b.durationMs ? ` · ${fmtDur(b.durationMs)}` : ''}`)),
      h('div', { class: 'think-body' }, b.text));
    return d;
  }
  if (b.type === 'steer') return `s${b.id || ''}${b.delivery || ''}${b.text.length}${(b.attachments || []).map(a => a.id).join(',')}`;
  if (b.type === 'tool_call') return renderTool(b, m);
  if (b.type === 'gallery') {
    return h('div', { class: 'gallery' }, b.items.map((p) => h('figure', null,
      h('img', { src: p.url, alt: p.prompt || '', loading: 'lazy', onclick: () => lightbox(p.url, p.prompt) }),
      h('figcaption', null, h('span', { title: p.prompt || '' }, p.prompt || ''),
        p.requestId ? iconBtn('hash', () => copyText(p.requestId), `Request ID 복사: ${p.requestId}`) : null,
        h('a', { class: 'icon-btn', href: p.url, download: '', title: '저장' }, icon('download'))))));
  }
  return h('div');
}

const STATUS_LABEL = { pending: '대기', awaiting_approval: '승인 필요', running: '실행 중', done: '완료', error: '오류', denied: '거부됨' };

// ask_user 질문 카드: 보기 버튼 + 직접 입력 + 자동 선택까지 남은 시간
function decisionMemoCard(item, redraw) {
  const card = h('div', { class: 'mem-item', style: { display: 'block' } });
  card.append(h('b', null, item.question), h('div', { class: 'muted' }, `${item.title} · ${new Date(item.createdAt).toLocaleString('ko-KR')} · ${item.status === 'pending' ? '미답변' : '답변됨'}`));
  if (item.blockedTasks.length) card.append(h('p', null, `보류: ${item.blockedTasks.join(' / ')}`));
  if (item.independentTasks.length) card.append(h('p', null, `계속 진행: ${item.independentTasks.join(' / ')}`));
  if (item.status === 'answered') { card.append(h('p', null, `사용자 답: ${item.answer}`)); return card; }
  let submitting = false;
  const submit = async payload => {
    if(submitting) return;
    submitting = true;
    card.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
    try {
      await api('POST', `/api/decisions/${item.id}/answer`, payload);
      if (redraw) redraw();
      else { const latest = (await api('GET', '/api/decisions')).find(d => d.id === item.id); card.replaceWith(decisionMemoCard(latest)); }
      toast('답을 저장했습니다. 진행 중인 관련 작업 또는 다음 재개에 반영됩니다.');
    } catch(e) { toast(e.message, 'error'); }
    finally { submitting = false; card.querySelectorAll('button, input').forEach(el => { el.disabled = false; }); }
  };
  card.append(h('div', { class: 'ask-opts' }, ...item.options.map((o,i) => h('button', { class: 'btn sm', onclick: () => submit({ choice: i }) }, o.label))));
  const input = h('input', { class: 'input', placeholder: '나중에 직접 답하기' });
  input.addEventListener('keydown', e => { if(e.key === 'Enter' && input.value.trim()) submit({ text: input.value.trim() }); });
  card.append(h('label', null, '사용자 답', input), h('button', { class: 'btn sm', onclick: () => submit({ text: input.value.trim() }) }, '답 저장'));
  return card;
}

function renderQuestion(p) {
  let q = {};
  try { q = JSON.parse(p.arguments || '{}'); } catch { /* 아직 인자를 받는 중 */ }
  const options = (q.options || []).map((o) => (typeof o === 'string' ? { label: o } : o)).filter((o) => o && o.label);
  const rec = Math.min(Math.max(0, Number(q.recommended) || 0), Math.max(0, options.length - 1));
  const waiting = p.status === 'awaiting_answer' && S.run && S.run.runId;
  const card = h('div', { class: `ask-card${waiting ? ' live' : ''}${q.critical ? ' critical' : ''}` });
  const head = h('div', { class: 'ask-q' }, icon('bulb'), h('span', null, q.question || '질문을 준비하는 중…'), q.critical ? h('span', { class: 'chip ask-crit' }, '중요한 결정') : null);
  card.append(head);
  if (waiting) {
    const answer = (payload) => {
      card.classList.remove('live');
      card.querySelectorAll('button, input').forEach((x) => { x.disabled = true; });
      api('POST', `/api/runs/${S.run.runId}/answer`, { callId: p.id, ...payload }).catch((e) => toast(e.message, 'error'));
    };
    card.append(h('div', { class: 'ask-opts' }, ...options.map((o, i) => h('button', { class: `ask-opt${i === rec ? ' rec' : ''}`, onclick: () => answer({ choice: i }) },
      h('span', { class: 'ask-n' }, i + 1),
      h('span', { class: 'ask-body' }, h('b', null, o.label, i === rec ? h('span', { class: 'ask-rec' }, '권장') : null), o.description ? h('span', null, o.description) : null)))));
    // 화면이 다시 그려져도 입력하던 글은 남긴다
    const other = h('input', { type: 'text', placeholder: '직접 입력하고 Enter', value: p.askDraft || '' });
    other.addEventListener('input', () => { p.askDraft = other.value; });
    if (p.askFocus) setTimeout(() => { other.focus(); other.setSelectionRange(other.value.length, other.value.length); }, 0);
    other.addEventListener('focus', () => { p.askFocus = true; });
    other.addEventListener('blur', () => { p.askFocus = false; });
    other.addEventListener('keydown', (e) => { if (e.key === 'Enter' && other.value.trim()) answer({ text: other.value.trim() }); });
    // 직접 입력을 시작하면 자동 진행을 멈추고 기다린다
    other.addEventListener('input', () => {
      if (p.askHold) return;
      p.askHold = true;
      api('POST', `/api/runs/${S.run.runId}/answer`, { callId: p.id, hold: true }).catch(() => {});
    }, { once: false });
    card.append(h('div', { class: 'ask-other' }, other));
    if (p.deadline) {
      const bar = h('div', { class: 'ask-timer' }, h('span', { class: 'fill' }));
      const label = h('div', { class: 'ask-left' });
      card.append(bar, label);
      const total = Math.max(1, p.deadline - (p.shownAt || (p.shownAt = Date.now())));
      const tick = () => {
        if (!card.isConnected || p.status !== 'awaiting_answer') { clearInterval(iv); return; }
        const left = Math.max(0, p.deadline - Date.now());
        $('.fill', bar).style.width = `${(left / total) * 100}%`;
        label.textContent = `${Math.ceil(left / 1000)}초 뒤 권장안 "${options[rec] ? options[rec].label : ''}"으로 진행해요`;
      };
      const iv = setInterval(tick, 250);
      tick();
    } else {
      card.append(h('div', { class: 'ask-left' }, q.critical ? '비용이 들거나 구조가 크게 바뀌는 결정이라 답할 때까지 기다려요' : '입력하는 동안 자동 진행을 멈췄어요. 다 쓰면 Enter'));
    }
  } else if (p.result) {
    card.append(h('div', { class: 'ask-done' }, icon('check'), h('span', null, p.result)));
    if (q.critical) api('GET', '/api/decisions').then(items => {
      const item = items.find(d => d.callId === p.id);
      if (item) card.append(decisionMemoCard(item));
    }).catch(e => toast(e.message, 'error'));
  }
  return card;
}

function renderTool(p, m) {
  if (p.name === 'ask_user') return renderQuestion(p);
  const key = `tool:${p.id}`;
  let server = '', name = p.name;
  const mm = p.name.match(/^mcp__(.+?)__(.+)$/);
  if (mm) { server = mm[1]; name = mm[2]; }
  let args = p.arguments;
  try { args = JSON.stringify(JSON.parse(p.arguments || '{}'), null, 2); } catch { /* 원문 */ }
  const d = h('details', { class: 'tool' });
  if (S.open.has(key) || p.status === 'awaiting_approval') d.open = true;
  d.addEventListener('toggle', () => (d.open ? S.open.add(key) : S.open.delete(key)));
  const st = h('span', { class: `st ${p.status}` },
    p.status === 'running' || p.status === 'pending' ? h('span', { class: 'spin' }) : p.status === 'done' ? icon('check') : null,
    STATUS_LABEL[p.status] || p.status, p.durationMs ? ` · ${fmtDur(p.durationMs)}` : '');
  d.append(h('summary', null, icon('right', 'chev'), icon('wrench'), server ? h('span', { class: 'srv' }, server) : null, h('span', { class: 'tname' }, name), st));
  d.append(h('div', { class: 'tbody' },
    h('div', { class: 'tlabel' }, '입력'), h('pre', null, args || '{}'),
    p.result ? [h('div', { class: 'tlabel' }, '결과'), h('pre', null, p.result)] : null));
  if (p.status === 'awaiting_approval' && S.run && S.run.runId) {
    const decide = (decision) => api('POST', `/api/runs/${S.run.runId}/approve`, { callId: p.id, decision }).catch((e) => toast(e.message, 'error'));
    d.append(h('div', { class: 'approval' },
      h('span', { class: 'grow' }, server ? `MCP 서버 "${server}" 의 도구를 실행하려고 해요.` : '이 도구를 실행하려고 해요.'),
      h('button', { class: 'btn sm', onclick: () => decide('deny') }, '거부'),
      h('button', { class: 'btn sm', onclick: () => decide('allow_all') }, '이 대화에서 항상 허용'),
      h('button', { class: 'btn sm accent', onclick: () => decide('allow') }, '허용')));
  }
  return d;
}

function renderAssistantMsg(m, isLast) {
  const live = !!(S.run && S.run.msg === m);
  const el = h('div', { class: 'msg assistant', 'data-id': m.id });
  const body = h('div', { class: 'body' });
  el.append(body);
  updateAssistantBody(el, m, live);
  const actions = h('div', { class: 'msg-actions' });
  el.append(actions);
  fillAssistantActions(actions, m, isLast, live);
  return el;
}

function imagePixelErrorNote(m) {
  if (!S.imageInputPolicy || S.imageInputPolicy.oversizedReferences !== 'proportional-copy' || !/expected the pixel to be at most/i.test(m.error || '')) return null;
  const when = new Date(m.createdAt).toLocaleString('ko-KR');
  return h('div', { style: { marginTop: '8px', lineHeight: '1.5' } },
    '실패 기록 · ' + when + '. 원본 업로드와 로컬 편집은 가능합니다. 현재 적용된 버전은 새 AI 편집 요청에서 공급자 한도에 맞는 전송용 사본을 준비합니다. 원본은 그대로 보존됩니다.');
}

function updateAssistantBody(el, m, live) {
  const body = $('.body', el);
  const blocks = groupParts(m.parts);
  blocks.forEach((b, i) => {
    const isLiveBlock = live && i === blocks.length - 1;
    const sig = blockSig(b, isLiveBlock);
    const cur = body.children[i];
    if (cur && cur.dataset.sig === sig) return;
    const n = renderBlock(b, m, i, isLiveBlock);
    n.dataset.sig = sig;
    if (cur) body.replaceChild(n, cur); else body.append(n);
  });
  while (body.children.length > blocks.length) body.lastChild.remove();

  let tail = $('.tail', el);
  if (!tail) { tail = h('div', { class: 'tail' }); body.after(tail); }
  put(tail,
    live && (!blocks.length || blocks[blocks.length - 1].type !== 'reasoning') ? h('span', { class: 'cursor' }) : null,
    m.error ? h('div', { class: 'err-box' }, m.error, imagePixelErrorNote(m), requestIdIn(m.error) ? h('div', { style: { marginTop: '6px' } }, h('button', { class: 'btn sm', onclick: () => copyText(requestIdIn(m.error)) }, icon('hash'), 'Request ID 복사')) : null) : null,
    m.status === 'stopped' ? h('div', { class: 'chip' }, '응답을 중단했어요') : null);
}

function fillAssistantActions(actions, m, isLast, live) {
  if (live) { actions.replaceChildren(); return; }
  const text = (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
  const u = m.usage;
  const meta = [m.model, fmtDur(m.durationMs), u && u.total_tokens ? `${u.total_tokens.toLocaleString()} 토큰` : ''].filter(Boolean).join(' · ');
  put(actions,
    // 호출 한도에 닿아 보고로 끝난 응답이면 새 응답에서 이어 간다 (CONTEXT.md §12)
    isLast && !busy() && m.stopReason === 'max_rounds' ? h('button', { class: 'btn sm primary continue-btn', onclick: () => { S.draft.text = '이어서 계속 진행해 줘. 위 보고의 "아직 못 한 일"부터 순서대로.'; send(); } }, icon('right'), '이어서 계속') : null,
    text ? iconBtn('copy', () => copyText(text), '복사') : null,
    isLast && !busy() ? iconBtn('refresh', regenerate, '다시 생성') : null,
    (m.requestIds || []).length ? iconBtn('hash', (e) => requestIdMenu(e.currentTarget, m.requestIds), `Request ID ${m.requestIds.length}개`) : null,
    h('span', { class: 'meta' }, meta));
}

// 스트리밍 중 렌더링 (프레임당 1회)
let renderQueued = false;
function scheduleLiveRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const run = S.run;
    if (!run || !run.msg || !S.conv || S.conv.id !== run.convId || S.route.view !== 'chat') return;
    const scroll = $('#scroll');
    const el = $(`.msg[data-id="${run.msg.id}"]`);
    if (!scroll || !el) return;
    const stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
    updateAssistantBody(el, run.msg, true);
    if (stick) scroll.scrollTop = scroll.scrollHeight;
  });
}

// ============================================================
// 전송 / 스트리밍
// ============================================================
async function send() {
  const text = S.draft.text.trim();
  const atts = S.draft.attachments;
  if (busy()) return;
  if (!text && !atts.length) return;
  if (atts.some((a) => a.uploading)) { toast('파일을 올리는 중이에요. 잠시만 기다려 주세요.'); return; }
  closeSlash();

  if (!S.conv) {
    const { provider, model } = currentSel();
    try {
      const c = await api('POST', '/api/conversations', { providerId: provider.id, model, projectId: S.pendingProjectId });
      S.pendingProjectId = null;
      S.conv = c;
      S.convCache.set(c.id, c);
      S.convs.unshift({ id: c.id, title: c.title, updatedAt: c.updatedAt, createdAt: c.createdAt, pinned: false, count: 0, projectId: c.projectId, archived: false });
      history.replaceState(null, '', `#/c/${c.id}`);
      S.route = { view: 'chat', id: c.id };
    } catch (e) { toast(e.message, 'error'); return; }
  }
  const conv = S.conv;
  const body = {
    conversationId: conv.id,
    content: text,
    attachments: atts.map(({ id, name, mime, size, kind, file, url }) => ({ id, name, mime, size, kind, file, url })),
    skills: [...S.draft.skills],
    options: { ...runOptions() }
  };
  const optimistic = { id: `tmp${Date.now()}`, role: 'user', content: text, attachments: atts, skills: [...S.draft.skills], parts: [], createdAt: new Date().toISOString() };
  conv.messages.push(optimistic);
  const saved = { ...S.draft };
  S.draft = { text: '', attachments: [], skills: [] };
  if (S.opts.imageMode) S.opts.imageMode = false;
  renderSidebar();
  renderMain();
  await runStream(body, conv, optimistic, saved);
}

function runOptions() {
  const { provider, model } = currentSel();
  return { providerId: provider.id, model, thinking: S.opts.thinking, imageMode: S.opts.imageMode, tools: S.opts.tools };
}

async function regenerate() {
  const c = S.conv;
  if (!c || busy()) return;
  while (c.messages.length && c.messages[c.messages.length - 1].role === 'assistant') c.messages.pop();
  renderMain();
  await runStream({ conversationId: c.id, regenerate: true, options: { ...runOptions(), imageMode: false } }, c, null, null);
}

async function resendEdited(m, newText) {
  const c = S.conv;
  S.editing = null;
  if (!newText.trim()) { renderMain(); return; }
  try {
    const updated = await api('POST', `/api/conversations/${c.id}/truncate`, { messageId: m.id });
    c.messages = updated.messages;
  } catch (e) { toast(e.message, 'error'); return; }
  S.draft = { text: newText, attachments: m.attachments || [], skills: m.skills || [] };
  await send();
}

// 스티어링: 응답이 진행 중일 때 보낸 글은 다음 단계(도구 결과 뒤 또는 답변 직후)에 반영된다
async function steerRun(immediate = false) {
  const run = S.run;
  const text = S.draft.text.trim();
  const attachments = S.draft.attachments;
  if (!run || !run.runId || (!text && !attachments.length) || S.steerBusy) return;
  if (attachments.some(a => !a.file)) { toast('첨부 업로드가 끝난 뒤 보내 주세요'); return; }
  S.steerBusy = true;
  try {
    await api('POST', `/api/runs/${run.runId}/steer`, { text, attachments: attachments.map(({ id, name, mime, size, kind, file, url }) => ({ id, name, mime, size, kind, file, url })), mode: immediate ? 'immediate' : 'next' });
    S.draft.text = ''; S.draft.attachments = [];
    fillComposerParts();
    const ta = $('#composer-input');
    if (ta) { ta.value = ''; autoGrow(ta); }
    updateSendBtn();
    paintSteerQueue();
  } catch (e) { toast(e.message, 'error'); } finally { S.steerBusy = false; updateSendBtn(); }
}

// 아직 반영 전인 추가 지시를 진행 중인 답변 아래에 보여 준다
function paintSteerQueue() {
  const thread = $('#thread');
  if (!thread) return;
  let box = $('#steer-queue');
  const list = (S.run && !S.run.done && S.conv && S.run.convId === S.conv.id && S.run.pendingSteer) || [];
  if (!list.length) { if (box) box.remove(); return; }
  if (!box) { box = h('div', { id: 'steer-queue', class: 'steer-queue' }); thread.append(box); }
  else thread.append(box);
  box.replaceChildren(...list.map((t) => h('div', { class: 'steer-note pending' }, icon('right'), h('span', { class: 'lbl' }, '추가 지시 · 대기 중'), h('span', { class: 'txt' }, t))));
}

// 대기열(무인) 작업이 이 대화를 처리 중인지
function queueJobRunning(c) {
  if (!c || !c.queueJobId || !S.queue) return false;
  const j = S.queue.jobs.find((x) => x.id === c.queueJobId);
  return !!(j && j.status === 'running' && j.conversationId === c.id);
}

// 대기열 작업이 도는 대화는 화면 없이 진행되므로, 보고 있는 동안 몇 초마다 새로 받아 온다
let queueConvTimer = null;
function watchQueueConversation() {
  if (queueConvTimer) return;
  queueConvTimer = setInterval(async () => {
    const c = S.conv;
    if (!c || !(c.queueJobId || (c.watch && c.watch.enabled) || (c.bgWaits || []).length || c.handoff?.autoResume || c.handedOffTo || needsHandoffResume(c)) || S.route.view !== 'chat' || document.hidden) { clearInterval(queueConvTimer); queueConvTimer = null; return; }
    if (busy()) return;
    // 입력 중이면 화면을 다시 그리지 않는다 (포커스·입력이 끊기지 않게)
    const ta = $('#composer-input');
    if (ta && document.activeElement === ta && ta.value.trim()) return;
    try {
      const fresh = await api('GET', `/api/conversations/${c.id}`);
      if (!S.conv || S.conv.id !== c.id) return;
      if (fresh.updatedAt === c.updatedAt && fresh.messages.length === c.messages.length && JSON.stringify(fresh.watch) === JSON.stringify(c.watch) && (fresh.bgWaits || []).length === (c.bgWaits || []).length && fresh.handedOffTo === c.handedOffTo && fresh.handoff?.resumeState === c.handoff?.resumeState) return;
      const sc = $('#scroll');
      const atBottom = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
      S.conv = fresh;
      S.convCache.set(fresh.id, fresh);
      // 연결이 끊긴 사이 자동 인계가 끝났으면 열린 작업의 다음 방을 따른다.
      // 작성 중인 지시나 수동 인계는 화면 이동으로 방해하지 않는다.
      if (fresh.handedOffTo && !S.draft.text.trim() && !S.draft.attachments.length) {
        const next = await api('GET', `/api/conversations/${fresh.handedOffTo}`);
        if (S.conv?.id !== fresh.id) return;
        if (next.handoff?.autoResume) { S.convCache.set(next.id, next); go(`#/c/${next.id}`); return; }
      }
      renderMain();
      if (!atBottom) { const n = $('#scroll'); if (n) n.scrollTop = n.scrollHeight - (sc.scrollHeight - sc.scrollTop); }
    } catch { /* 다음에 다시 */ }
  }, 5000);
}

async function stopRun() {
  const run = S.run;
  if (!run) return;
  if (run.runId) api('POST', `/api/runs/${run.runId}/stop`).catch(() => {});
  else run.ctrl.abort();
}

const handoffRecovering = new Set();
const handoffRecoveryTried = new Set();
function needsHandoffResume(conv) {
  if (!conv || conv.handedOffTo || conv.queueJobId || S.settings?.generation.autoHandoff === false) return false;
  if (conv.handoff?.autoResume && conv.handoff.resumeState === 'pending') return true;
  const last = [...conv.messages].reverse().find(m => m.role === 'assistant');
  return last?.status === 'complete' && last.stopReason === 'context_handoff';
}
async function resumePendingHandoff(conv) {
  if (handoffRecovering.has(conv.id) || handoffRecoveryTried.has(conv.id) || busy() || S.conv?.id !== conv.id || !needsHandoffResume(conv)) return;
  handoffRecovering.add(conv.id);
  handoffRecoveryTried.add(conv.id);
  try { await runStream({ options: { tools: S.opts.tools !== false, thinking: S.opts.thinking === true } }, conv, null, null, `/api/conversations/${conv.id}/handoff/resume`); }
  finally { handoffRecovering.delete(conv.id); }
}

async function runStream(body, conv, optimistic, savedDraft, endpoint = '/api/chat') {
  const ctrl = new AbortController();
  S.run = { convId: conv.id, runId: null, msg: null, ctrl };
  refreshComposer();
  renderSidebar();
  let started = false;
  try {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flash-client': '1' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    // 이 대화에서 이미 작업(대기열 등)이 돌고 있으면 서버가 새로 실행하지 않고 추가 지시로 넘긴다
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const j = await res.json().catch(() => ({}));
      if (optimistic) conv.messages = conv.messages.filter((x) => x !== optimistic);
      if (j.steered) toast('이 대화에서 작업이 진행 중이라, 보낸 내용을 추가 지시로 전달했어요');
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === 'start') started = true;
          onEvent(ev, conv, optimistic);
        }
      }
    }
  } catch (e) {
    if (!started) {
      // 서버가 받기 전에 실패 → 낙관적 메시지 제거, 입력 복원
      if (optimistic) conv.messages = conv.messages.filter((x) => x !== optimistic);
      if (savedDraft) S.draft = savedDraft;
      if (e.name !== 'AbortError') toast(e.message, 'error');
    } else if (S.run && S.run.msg && e.name !== 'AbortError') {
      S.run.msg.error = S.run.msg.error || `연결이 끊어졌어요: ${e.message}`;
    }
  } finally {
    // A lost SSE connection does not prove that a tool or server write failed.
    // Read back persisted state; never replay the POST on a network error.
    try {
      const fresh = await api('GET', `/api/conversations/${conv.id}`);
      S.convCache.set(fresh.id, fresh);
      if (S.conv?.id === fresh.id) S.conv = fresh;
    } catch { /* Retain local partial output and unsent draft until the server returns. */ }
    S.run = null;
    if (S.conv && S.conv.id === conv.id && S.route.view === 'chat') renderMain();
    refreshConvs();
  }
}

function onEvent(ev, conv, optimistic) {
  const run = S.run;
  if (!run) return;
  const msg = run.msg;
  switch (ev.type) {
    case 'start': {
      run.runId = ev.runId;
      run.done = false;
      run.handoffProgress = null;
      if (ev.userMessage && optimistic) {
        const i = conv.messages.indexOf(optimistic);
        if (i !== -1) conv.messages[i] = ev.userMessage;
        else conv.messages.push(ev.userMessage);
      }
      else if (ev.userMessage) conv.messages.push(ev.userMessage);
      run.msg = ev.assistantMessage;
      conv.messages.push(run.msg);
      if (S.conv && S.conv.id === conv.id) renderMain();
      return;
    }
    case 'text':
    case 'reasoning': {
      const last = msg.parts[msg.parts.length - 1];
      if (last && last.type === ev.type) last.text += ev.delta;
      else msg.parts.push({ type: ev.type, text: ev.delta });
      break;
    }
    case 'tool_call': msg.parts.push(ev.part); sideAutoOpen(ev.part, run); break;
    case 'image': msg.parts.push(ev.part); break;
    case 'video': msg.parts.push(ev.part); break;
    case 'tool_status': {
      const p = msg.parts.find((x) => x.type === 'tool_call' && x.id === ev.id);
      if (p) Object.assign(p, { status: ev.status }, ev.result !== undefined ? { result: ev.result } : {}, ev.isError !== undefined ? { isError: ev.isError } : {}, ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}, ev.deadline !== undefined ? { deadline: ev.deadline, shownAt: Date.now() } : {});
      break;
    }
    case 'usage': msg.usage = ev.usage; return;
    case 'context': {
      S.ctxInfo = { convId: conv.id, ...ev.context };
      if (S.conv && S.conv.id === conv.id) paintCtxMeter(S.ctxInfo);
      return;
    }
    case 'request': (msg.requestIds = msg.requestIds || []).push(ev.requestId); return;
    case 'retry': {
      const why = ev.reason === 'network' ? '모델 서버 연결이 끊겨' : ev.reason === 'server' ? '모델 서버가 일시적으로 응답하지 않아' : '요청 한도에 걸려';
      toast(`${why} ${ev.wait}초 뒤 다시 시도합니다 (${ev.attempt}/${ev.max})`);
      return;
    }
    case 'reset': msg.parts = ev.parts; break;
    case 'compacting': toast(`대화가 길어져 앞부분 메시지 ${ev.messages}개를 요약하는 중이에요…`); return;
    case 'compacted': {
      conv.compaction = ev.compaction;
      toast(`앞부분을 요약했어요 (약 ${ev.compaction.tokensBefore.toLocaleString()} → ${(ev.compaction.tokensAfter || 0).toLocaleString()} 토큰)`);
      if (S.ctxInfo && S.ctxInfo.convId === conv.id) {
        S.ctxInfo = { ...S.ctxInfo, tokens: ev.compaction.tokensAfter || 0, source: 'estimated', compacted: true };
        if (S.conv && S.conv.id === conv.id) paintCtxMeter(S.ctxInfo);
      }
      return;
    }
    case 'error': msg.error = ev.message; break;
    case 'steer': {
      const existing = ev.part.id ? msg.parts.findIndex(p => p.type === 'steer' && p.id === ev.part.id) : -1;
      if (existing >= 0) msg.parts[existing] = ev.part; else msg.parts.push(ev.part);
      if (run && run.pendingSteer) { const i = run.pendingSteer.indexOf(ev.part.text); if (i !== -1) run.pendingSteer.splice(i, 1); }
      paintSteerQueue();
      break;
    }
    // 자동 인계: 서버가 인계서를 만들어 새 대화로 옮겼다. 이 응답은 새 대화에서 이어진다
    case 'handoff_start': run.done = false; run.runId = ev.runId || run.runId; run.handoffProgress = { completed: 0, total: 0 }; paintHandoffHint(); toast(`${ev.reason || '대화가 길어졌어요'} — 인계서를 만들어 새 대화로 옮기는 중이에요…`); return;
    // 응답이 끝난 뒤 미리 인계: 다음 메시지는 새 대화에서 이어진다
    case 'handoff_prepare': run.done = false; run.handoffProgress = { completed: 0, total: 0 }; paintHandoffHint(); toast('인계서를 저장한 뒤 다음 대화에서 바로 재개합니다.'); return;
    case 'handoff_progress': run.handoffProgress = ev; paintHandoffHint(); return;
    case 'handoff_ready': {
      conv.handedOffTo = ev.conversation.id;
      toast(`인계서 저장 완료. "${ev.conversation.title}"에서 작업을 재개합니다.`);
      refreshConvs();
      return;
    }
    case 'handoff_failed': run.handoffProgress = null; toast(`인계 오류: ${ev.message}. 완료한 원문 조각은 보존됩니다.`, 'error'); return;
    case 'handoff': {
      const oldId = conv.id;
      S.convCache.delete(oldId);
      const msgs = [...ev.conversation.messages];
      if (optimistic && !run.done) msgs.push(optimistic);
      for (const k of Object.keys(conv)) delete conv[k];
      Object.assign(conv, ev.conversation, { messages: msgs });
      run.convId = conv.id;
      S.convCache.set(conv.id, conv);
      if (S.conv === conv) { history.replaceState(null, '', `#/c/${conv.id}`); S.route = { view: 'chat', id: conv.id }; }
      toast('인계서를 만들고 새 대화로 옮겼어요. 여기서 이어서 답해요');
      refreshConvs();
      if (S.conv === conv) renderMain();
      return;
    }
    case 'steer_dropped': {
      if (run) run.pendingSteer = [];
      paintSteerQueue();
      const atts = ev.attachments || [];
      for (const a of atts) if (!S.draft.attachments.some(item => item.id === a.id)) S.draft.attachments.push(a);
      fillComposerParts();
      const back = ev.texts.join('\n');
      S.draft.text = S.draft.text ? `${back}\n${S.draft.text}` : back;
      const ta = $('#composer-input');
      if (ta) { ta.value = S.draft.text; autoGrow(ta); }
      updateSendBtn();
      toast('반영하지 못한 추가 지시를 입력창에 돌려놨어요');
      return;
    }
    case 'done': {
      const i = conv.messages.indexOf(msg);
      if (i !== -1) conv.messages[i] = ev.message;
      run.msg = ev.message;
      run.done = true;
      run.msg = null;
      if (S.conv && S.conv.id === conv.id && S.route.view === 'chat') renderMain();
      return;
    }
    case 'title': {
      conv.title = ev.title;
      const meta = S.convs.find((c) => c.id === conv.id);
      if (meta) meta.title = ev.title;
      renderSidebar();
      if (S.conv && S.conv.id === conv.id && S.route.view === 'chat') { const t = $('.topbar .title-btn'); if (t) t.textContent = ev.title; }
      return;
    }
    default: return;
  }
  scheduleLiveRender();
}

// ============================================================
// 입력창
// ============================================================
function renderComposer() {
  const ta = h('textarea', { id: 'composer-input', rows: 1, value: S.draft.text, placeholder: S.opts.imageMode ? '만들고 싶은 이미지를 설명해 주세요' : '무엇이든 물어보세요  ·  / 로 프롬프트·스킬 불러오기' });
  ta.addEventListener('input', () => { S.draft.text = ta.value; autoGrow(ta); updateSlash(ta); updateSendBtn(); });
  ta.addEventListener('keydown', onComposerKey);
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  });

  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { uploadFiles([...e.target.files]); e.target.value = ''; } });
  const box = h('div', { class: 'composer', id: 'composer' },
    h('div', { class: 'comp-skills', id: 'comp-skills' }),
    h('div', { class: 'comp-atts', id: 'comp-atts' }),
    ta,
    h('div', { class: 'comp-row' },
      h('button', { class: 'tbtn', title: '첨부 · 프롬프트 · 스킬', onclick: (e) => plusMenu(e.currentTarget, fileInput) }, icon('plus')),
      h('button', { class: `tbtn${S.opts.tools ? ' on' : ''}`, id: 'tools-btn', title: '도구', onclick: (e) => toolsMenu(e.currentTarget) }, icon('wrench'), h('span', { id: 'tools-count' }, '')),
      h('button', { class: `tbtn${S.opts.thinking ? ' on' : ''}`, title: '확장 사고 (추론)', onclick: (e) => { S.opts.thinking = !S.opts.thinking; e.currentTarget.classList.toggle('on', S.opts.thinking); } }, icon('bulb'), h('span', { class: 'lbl' }, '사고')),
      h('button', { class: `tbtn${S.opts.imageMode ? ' on' : ''}`, title: '이미지 모드: 입력한 내용으로 바로 이미지를 만듭니다', onclick: () => { S.opts.imageMode = !S.opts.imageMode; refreshComposer(true); } }, icon('image'), h('span', { class: 'lbl' }, '이미지')),
      h('span', { class: 'spacer' }),
      ctxMeter(),
      modelButton(),
      h('button', { class: 'tbtn', id: 'steer-now-btn', hidden: true, title: '현재 모델 응답을 멈추고 추가 지시와 이미지를 바로 반영합니다. 이미 실행 중인 외부 작업은 보존합니다.', onclick: () => steerRun(true) }, icon('right'), '지금 반영'),
      h('button', { class: 'send-btn stop', id: 'stop-btn', hidden: true, title: '중단', onclick: () => stopRun() }, icon('stop')),
      h('button', { class: 'send-btn', id: 'send-btn', onclick: () => (busy() ? ((S.draft.text.trim() || S.draft.attachments.length) ? steerRun() : stopRun()) : send()) })),
    fileInput);

  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drag'); uploadFiles([...e.dataTransfer.files]); });
  setTimeout(() => { fillComposerParts(); autoGrow(ta); updateSendBtn(); updateToolCount(); }, 0);
  return box;
}

function refreshComposer(full) {
  if (full) {
    const old = $('#composer');
    if (old) { const n = renderComposer(); old.replaceWith(n); $('#composer-input').focus(); }
    return;
  }
  fillComposerParts();
  updateSendBtn();
}

function fillComposerParts() {
  const atts = $('#comp-atts');
  if (atts) atts.replaceChildren(...S.draft.attachments.map((a) => attChip(a, true)));
  const sk = $('#comp-skills');
  if (sk) sk.replaceChildren(...S.draft.skills.map((n) => h('span', { class: 'chip accent' }, icon('skill'), n,
    h('button', { onclick: () => { S.draft.skills = S.draft.skills.filter((x) => x !== n); fillComposerParts(); }, title: '빼기' }, icon('x')))));
}

function updateSendBtn() {
  const b = $('#send-btn');
  if (!b) return;
  const hasSteer = !!(S.draft.text.trim() || S.draft.attachments.length);
  const pendingUpload = S.draft.attachments.some(a => !a.file);
  const nowBtn = $('#steer-now-btn');
  if (nowBtn) { nowBtn.hidden = !(busy() && hasSteer); nowBtn.disabled = S.steerBusy || pendingUpload; }
  const stopBtn = $('#stop-btn');
  if (stopBtn) stopBtn.hidden = !(busy() && hasSteer);
  const ta = $('#composer-input');
  if (ta && !S.opts.imageMode) ta.placeholder = busy() ? '추가 지시·이미지: Enter는 다음 단계, 지금 반영 버튼은 즉시' : queueJobRunning(S.conv) ? '대기열 작업이 이 대화를 처리 중이에요 — 입력하면 추가 지시로 전달돼요' : '무엇이든 물어보세요  ·  / 로 프롬프트·스킬 불러오기';
  if (busy()) {
    // 응답 중에 글을 쓰면 보내기 버튼이 '추가 지시'로 바뀐다 (스티어링)
    if (hasSteer) { b.className = 'send-btn steer'; b.replaceChildren(icon('up')); b.title = '추가 지시와 첨부 보내기 (Enter) · 다음 단계 / 지금 반영 버튼 · 즉시'; b.disabled = S.steerBusy || pendingUpload; return; }
    b.className = 'send-btn stop'; b.replaceChildren(icon('stop')); b.title = '중단'; b.disabled = false; return;
  }
  b.className = 'send-btn';
  b.replaceChildren(icon('up'));
  b.title = '보내기 (Enter)';
  b.disabled = !S.draft.text.trim() && !S.draft.attachments.length;
}

function autoGrow(ta) {
  if (!ta.value) { ta.style.height = ''; return; }
  if (!ta.isConnected || !ta.clientWidth) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
}

function onComposerKey(e) {
  if (S.slash.open) {
    if (e.key === 'ArrowDown') { e.preventDefault(); S.slash.sel = (S.slash.sel + 1) % S.slash.items.length; drawSlash(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); S.slash.sel = (S.slash.sel - 1 + S.slash.items.length) % S.slash.items.length; drawSlash(); return; }
    if ((e.key === 'Enter' || e.key === 'Tab') && S.slash.items.length) { e.preventDefault(); pickSlash(S.slash.items[S.slash.sel]); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy()) send(); else if (S.draft.text.trim() || S.draft.attachments.length) steerRun(); }
}

function modelButton() {
  const { def } = currentSel();
  return h('button', { class: 'model-btn', onclick: (e) => modelMenu(e.currentTarget), title: '모델 선택' }, h('span', null, def.label || def.id), icon('down'));
}

async function modelMenu(anchor) {
  try { S.settings = await api('GET', '/api/settings'); } catch { /* 가진 목록으로 표시 */ }
  const { provider, model } = currentSel();
  const items = [];
  for (const p of S.settings.providers) {
    items.push(h('div', { class: 'menu-head' }, p.name, p.hasKey || /127\.0\.0\.1|localhost/.test(p.baseUrl) ? '' : ' · 키 없음'));
    for (const m of p.models) {
      const on = p.id === provider.id && m.id === model;
      items.push(h('button', { class: 'menu-item', onclick: () => { closePopover(); selectModel(p.id, m.id); } },
        h('span', { class: 'txt' }, m.label || m.id, h('span', { class: 'sub' }, [m.id, m.vision ? '비전' : '', m.tools ? '도구' : ''].filter(Boolean).join(' · '))),
        on ? icon('check', 'check') : null));
    }
  }
  items.push(h('div', { class: 'menu-sep' }), menuItem('settings', '모델·공급자 관리', () => openSettings('providers')));
  popover(anchor, items, { above: true, align: 'right' });
}

async function selectModel(providerId, model) {
  if (S.conv) { S.conv.providerId = providerId; S.conv.model = model; api('PATCH', `/api/conversations/${S.conv.id}`, { providerId, model }).catch(() => {}); }
  try { S.settings = await api('GET', '/api/settings'); } catch { /* 최신 설정을 못 받으면 가진 것으로 */ }
  const next = clone(S.settings);
  next.activeProviderId = providerId;
  next.activeModel = model;
  try { S.settings = await api('PUT', '/api/settings', next); } catch (e) { toast(e.message, 'error'); }
  const b = $('.model-btn');
  if (b) b.replaceWith(modelButton());
  if (!S.conv) renderMain();
}

async function updateToolCount() {
  try {
    S.toolList = await api('GET', '/api/tools');
    const el = $('#tools-count');
    if (el) el.textContent = S.opts.tools ? String(S.toolList.builtin.length + S.toolList.mcp.length) : '끔';
  } catch { /* 무시 */ }
}

function toolsMenu(anchor) {
  const t = S.toolList || { builtin: [], mcp: [] };
  const byServer = {};
  for (const x of t.mcp) { const s = x.name.split('__')[1]; (byServer[s] = byServer[s] || []).push(x); }
  const sw = h('input', { type: 'checkbox', checked: S.opts.tools, onchange: (e) => { S.opts.tools = e.target.checked; $('#tools-btn').classList.toggle('on', S.opts.tools); updateToolCount(); } });
  popover(anchor, [
    h('label', { class: 'switch', style: { padding: '6px 10px' } }, sw, h('span', null, '도구 사용', h('span', { class: 'd' }, '끄면 모델이 대화만 합니다'))),
    h('div', { class: 'menu-sep' }),
    h('div', { class: 'menu-head' }, `내장 도구 ${t.builtin.length}`),
    ...t.builtin.map((x) => h('div', { class: 'menu-item', title: x.description }, icon('bolt'), h('span', { class: 'txt' }, x.name, h('span', { class: 'sub' }, x.description)))),
    h('div', { class: 'menu-head' }, `MCP 도구 ${t.mcp.length}`),
    ...Object.entries(byServer).map(([s, list]) => h('div', { class: 'menu-item' }, icon('plug'), h('span', { class: 'txt' }, s, h('span', { class: 'sub' }, list.map((x) => x.name.split('__').slice(2).join('__')).join(', '))))),
    h('div', { class: 'menu-sep' }),
    menuItem('plug', 'MCP 커넥터 관리', () => go('#/mcp'))
  ], { above: true });
}

function plusMenu(anchor, fileInput) {
  popover(anchor, [
    menuItem('clip', '파일 첨부', () => fileInput.click()),
    menuItem('prompt', '프롬프트 불러오기', () => openSlash('prompts')),
    menuItem('skill', '스킬 첨부', () => openSlash('skills')),
    S.conv ? menuItem('note', '대화 지침 편집', () => editConvSystem()) : null
  ].filter(Boolean), { above: true });
}

async function uploadFiles(files) {
  for (const f of files) {
    if (f.size > 2 * 1024 * 1024 * 1024) { toast(`${f.name}: 2GB 이하 파일만 올릴 수 있어요`, 'error'); continue; }
    const tmp = { name: f.name, size: f.size, kind: f.type.startsWith('image/') ? 'image' : 'file', uploading: true, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
    S.draft.attachments.push(tmp);
    refreshComposer();
    try {
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'x-flash-client': '1', 'x-filename': encodeURIComponent(f.name), 'content-type': f.type || 'application/octet-stream' }, body: f });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      Object.assign(tmp, j, { uploading: false });
        if (j.kind === 'image' && S.imageInputPolicy) {
          try {
            const info = await api('GET', '/api/image-input/' + encodeURIComponent(j.file));
            if (info.generationInput.resized) toast(j.name + ': 원본 ' + info.original.width + '×' + info.original.height + ' 보존. 로컬 편집은 원본, AI 편집은 전송용 사본을 사용합니다.');
          } catch { /* Upload is successful even if preflight info is unavailable. */ }
        }
    } catch (e) {
      S.draft.attachments = S.draft.attachments.filter((x) => x !== tmp);
      toast(`${f.name} 업로드 실패: ${e.message}`, 'error');
    }
    refreshComposer();
  }
}

// ---------- 슬래시 팔레트 ----------
async function slashSource(mode) {
  const items = [];
  if (mode !== 'skills') for (const p of S.prompts) items.push({ kind: 'prompt', title: p.title, sub: p.description || p.content.slice(0, 80), data: p });
  if (mode !== 'prompts') for (const s of S.skills) items.push({ kind: 'skill', title: s.name, sub: s.description, data: s });
  if (mode === 'all') for (const srv of S.mcp) for (const p of srv.prompts || []) items.push({ kind: 'mcp', title: `${srv.name}: ${p.name}`, sub: p.description, data: { server: srv.name, ...p } });
  return items;
}

async function updateSlash(ta) {
  const m = ta.value.match(/^\/(\S*)$/);
  if (!m) { if (S.slash.open && S.slash.mode === 'all') closeSlash(); else if (S.slash.open) { S.slash.q = ta.value; filterSlash(); } return; }
  if (!S.slash.open) { S.slash.open = true; S.slash.mode = 'all'; S.slash.source = await slashSource('all'); }
  S.slash.q = m[1];
  filterSlash();
}

async function openSlash(mode) {
  S.slash.open = true;
  S.slash.mode = mode;
  S.slash.q = '';
  S.slash.source = await slashSource(mode);
  filterSlash();
  $('#composer-input')?.focus();
}

function filterSlash() {
  const q = (S.slash.q || '').toLowerCase();
  S.slash.items = S.slash.source.filter((x) => !q || x.title.toLowerCase().includes(q) || (x.sub || '').toLowerCase().includes(q)).slice(0, 40);
  S.slash.sel = 0;
  drawSlash();
}

function drawSlash() {
  $('#slash')?.remove();
  if (!S.slash.open) return;
  const box = $('#composer');
  if (!box) return;
  const kindIcon = { prompt: 'prompt', skill: 'skill', mcp: 'plug' };
  const kindLabel = { prompt: '프롬프트', skill: '스킬', mcp: 'MCP' };
  const list = S.slash.items.map((it, i) => h('button', { class: `menu-item${i === S.slash.sel ? ' sel' : ''}`, onmousedown: (e) => { e.preventDefault(); pickSlash(it); } },
    icon(kindIcon[it.kind]), h('span', { class: 'txt' }, it.title, h('span', { class: 'sub' }, it.sub || '')), h('span', { class: 'chip' }, kindLabel[it.kind])));
  const pop = h('div', { class: 'popover slash', id: 'slash' }, list.length ? list : h('div', { class: 'menu-head' }, '일치하는 항목이 없어요'));
  box.append(pop);
  pop.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

function closeSlash() { S.slash.open = false; $('#slash')?.remove(); }

async function pickSlash(it) {
  closeSlash();
  const ta = $('#composer-input');
  const clearCmd = () => { if (/^\/\S*$/.test(S.draft.text)) S.draft.text = ''; };
  if (it.kind === 'skill') {
    clearCmd();
    if (!S.draft.skills.includes(it.title)) S.draft.skills.push(it.title);
  } else if (it.kind === 'prompt') {
    clearCmd();
    const text = await fillPromptVars(it.data);
    if (text == null) return;
    S.draft.text = S.draft.text ? `${S.draft.text}\n\n${text}` : text;
  } else if (it.kind === 'mcp') {
    clearCmd();
    const args = {};
    if ((it.data.arguments || []).length) {
      const vals = await formDialog(`MCP 프롬프트: ${it.data.name}`, it.data.arguments.map((a) => ({ name: a.name, label: `${a.name}${a.required ? ' *' : ''}`, help: a.description })));
      if (!vals) return;
      Object.assign(args, vals);
    }
    try {
      const r = await api('POST', `/api/mcp/${encodeURIComponent(it.data.server)}/prompt`, { name: it.data.name, arguments: args });
      S.draft.text = r.text;
    } catch (e) { toast(e.message, 'error'); }
  }
  if (ta) { ta.value = S.draft.text; autoGrow(ta); ta.focus(); }
  refreshComposer();
}

async function fillPromptVars(p) {
  const vars = parseVars(p.content);
  if (!vars.length) return p.content;
  const vals = await formDialog(p.title, vars.map((v) => ({ name: v.name, label: v.name, value: v.def, multiline: /본문|코드|내용|text|code/i.test(v.name) })));
  return vals ? fillVars(p.content, vals) : null;
}

async function usePrompt(p) {
  const text = await fillPromptVars(p);
  if (text == null) return;
  if (S.route.view !== 'chat') newChat();
  S.draft.text = text;
  setTimeout(() => { const ta = $('#composer-input'); if (ta) { ta.value = text; autoGrow(ta); ta.focus(); updateSendBtn(); } }, 40);
}

// ============================================================
// 프롬프트 화면
// ============================================================
function renderPrompts() {
  const q = h('input', { type: 'search', placeholder: '프롬프트 검색' });
  const grid = h('div', { class: 'cards' });
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const list = S.prompts.filter((p) => !s || `${p.title} ${p.description} ${p.content} ${p.tags.join(' ')}`.toLowerCase().includes(s));
    grid.replaceChildren(...(list.length ? list.map((p) => h('div', { class: 'card', onclick: () => editPrompt(p) },
      h('h3', null, icon('prompt'), h('span', null, p.title)),
      h('p', null, p.description || p.content),
      h('div', { class: 'foot' }, ...p.tags.map((t) => h('span', { class: 'chip' }, t)),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); usePrompt(p); } }, '사용')))) : [h('div', { class: 'empty' }, '프롬프트가 없어요')]));
  };
  q.addEventListener('input', draw);
  draw();
  main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h2', null, '프롬프트'), h('button', { class: 'btn primary', onclick: () => editPrompt(null) }, icon('plus'), '새 프롬프트')),
    h('p', { class: 'page-desc' }, '자주 쓰는 요청을 저장해 두고 입력창에서 / 로 불러오세요. {{변수}} 나 {{변수:기본값}} 을 넣으면 쓸 때마다 값을 물어봅니다.'),
    h('div', { class: 'toolbar' }, q), grid)));
}

function editPrompt(p) {
  const title = h('input', { type: 'text', value: p ? p.title : '', placeholder: '예: 유튜브 썸네일 문구' });
  const desc = h('input', { type: 'text', value: p ? p.description : '', placeholder: '어떤 상황에서 쓰는지 한 줄로' });
  const content = h('textarea', { class: 'input', rows: 10, value: p ? p.content : '', placeholder: '프롬프트 내용. 예: {{주제}}에 대한 썸네일 문구를 5개 써줘.' });
  const tags = h('input', { type: 'text', value: p ? p.tags.join(', ') : '', placeholder: '쉼표로 구분' });
  const varsEl = h('div', { class: 'help' });
  const showVars = () => { const v = parseVars(content.value); varsEl.textContent = v.length ? `변수: ${v.map((x) => x.name + (x.def ? `(기본값 ${x.def})` : '')).join(', ')}` : '변수 없음'; };
  content.addEventListener('input', showVars);
  showVars();
  const save = async () => {
    const body = { title: title.value.trim(), description: desc.value.trim(), content: content.value, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean) };
    if (!body.title || !body.content.trim()) { toast('제목과 내용을 입력해 주세요', 'error'); return; }
    try {
      if (p) await api('PUT', `/api/prompts/${p.id}`, body); else await api('POST', '/api/prompts', body);
      S.prompts = await api('GET', '/api/prompts');
      md.close();
      renderSidebar();
      renderMain();
    } catch (e) { toast(e.message, 'error'); }
  };
  const del = async () => {
    if (!(await confirmDialog('프롬프트 삭제', `"${p.title}" 을(를) 삭제할까요?`, '삭제', true))) return;
    await api('DELETE', `/api/prompts/${p.id}`);
    S.prompts = await api('GET', '/api/prompts');
    md.close(); renderSidebar(); renderMain();
  };
  const md = modal({
    title: p ? '프롬프트 편집' : '새 프롬프트',
    body: [field('제목', title), field('설명', desc), field('내용', content, varsEl), field('태그', tags)],
    foot: [p ? h('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: del }, '삭제') : null, h('button', { class: 'btn', onclick: () => md.close() }, '취소'), h('button', { class: 'btn primary', onclick: save }, '저장')]
  });
  title.focus();
}

// ============================================================
// 스킬 화면
// ============================================================
async function reloadSkills() {
  try { S.skills = await api('GET', '/api/skills'); } catch (e) { toast(e.message, 'error'); }
}

function renderSkills() {
  const q = h('input', { type: 'search', placeholder: '스킬 검색' });
  const grid = h('div', { class: 'cards' });
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const list = S.skills.filter((k) => !s || `${k.name} ${k.description}`.toLowerCase().includes(s));
    grid.replaceChildren(...(list.length ? list.map((k) => h('div', { class: 'card', onclick: () => go(`#/skills/${encodeURIComponent(k.name)}`) },
      h('h3', null, icon('skill'), h('span', null, k.name)),
      h('p', null, k.description || '(설명 없음)'),
      h('div', { class: 'foot' }, h('span', { class: `chip${k.source === 'local' ? ' accent' : ''}` }, k.source === 'local' ? '로컬' : '외부 폴더'), k.files.length ? h('span', { class: 'chip' }, `참고 파일 ${k.files.length}`) : null))) : [h('div', { class: 'empty' }, '스킬이 없어요')]));
  };
  q.addEventListener('input', draw);
  draw();
  main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h2', null, '스킬'),
      h('button', { class: 'btn', onclick: async () => { await reloadSkills(); renderSidebar(); renderMain(); toast('스킬을 다시 읽었어요'); } }, icon('refresh'), '다시 읽기'),
      h('button', { class: 'btn', onclick: () => api('POST', '/api/open', { which: 'skills' }) }, icon('folder'), '폴더 열기'),
      h('button', { class: 'btn primary', onclick: () => newSkill() }, icon('plus'), '새 스킬')),
    h('p', { class: 'page-desc' }, '스킬은 SKILL.md 한 장에 담긴 작업 지침이에요. 모델은 목록을 보고 필요할 때 스스로 불러오고, 입력창에서 / 로 직접 첨부할 수도 있어요. Claude 스킬 폴더를 그대로 넣어도 동작합니다.'),
    h('div', { class: 'toolbar' }, q), grid)));
}

async function renderSkillDetail(name) {
  main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner' }, h('div', { class: 'empty' }, '불러오는 중…'))));
  let s;
  try { s = await api('GET', `/api/skills/${encodeURIComponent(name)}`); } catch (e) { toast(e.message, 'error'); go('#/skills'); return; }
  main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('button', { class: 'btn sm', onclick: () => go('#/skills'), style: { marginBottom: '14px' } }, icon('left'), '스킬 목록'),
    h('div', { class: 'page-head' }, h('h2', null, s.name),
      h('button', { class: 'btn accent', onclick: () => newChat({ skills: [s.name] }) }, icon('chat'), '새 채팅에서 쓰기'),
      h('button', { class: 'btn', onclick: () => editExistingSkill(s) }, icon('edit'), '스킬 수정'),
      s.source === 'local' ? h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog('스킬 삭제', `"${s.name}" 스킬 폴더를 지울까요?`, '삭제', true))) return;
        try { S.skills = await api('DELETE', `/api/skills/${encodeURIComponent(s.name)}`); go('#/skills'); } catch (e) { toast(e.message, 'error'); }
      } }, icon('trash')) : null),
    h('p', { class: 'page-desc' }, s.description),
    h('p', { class: 'page-desc' }, h('span', { class: 'chip' }, s.source === 'local' ? '로컬' : '외부 폴더'), ' ', h('code', null, s.dir)),
    s.files.length ? h('details', { class: 'tool', style: { marginBottom: '14px' } }, h('summary', null, icon('right', 'chev'), `참고 파일 ${s.files.length}개`), h('div', { class: 'tbody' }, h('pre', null, s.files.join('\n')))) : null,
    h('div', { class: 'skill-doc md', html: Markdown.render(s.body) }))));
}

function editExistingSkill(skill) {
  const raw = h('textarea', { class: 'input mono', rows: 20, value: skill.raw, 'aria-label': '스킬 원문' });
  const md = modal({
    title: `스킬 수정 · ${skill.name}`,
    body: [h('p', { class: 'help' }, 'SKILL.md 원문을 수정합니다. 이름과 지적되지 않은 기존 지침은 유지하세요. 저장 전 원문은 자동 보관합니다.'), raw],
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'), h('button', { class: 'btn primary', onclick: async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        await api('PUT', `/api/skills/${encodeURIComponent(skill.name)}`, { raw: raw.value, expectedRaw: skill.raw });
        S.skills = await api('GET', '/api/skills'); md.close(); renderSidebar(); renderSkillDetail(skill.name); toast('스킬을 수정하고 이전 원문을 보관했어요');
      } catch (error) { toast(error.message, 'error'); button.disabled = false; }
    } }, '저장')]
  });
}

function newSkill() {
  const name = h('input', { type: 'text', placeholder: '예: youtube-thumbnail', class: 'mono' });
  const desc = h('textarea', { class: 'input', rows: 3, placeholder: '언제 이 스킬을 써야 하는지. 모델이 이 설명을 보고 스킬을 고릅니다.' });
  const body = h('textarea', { class: 'input mono', rows: 12, placeholder: '# 스킬 제목\n\n## 작업 순서\n1. ...' });
  const md = modal({
    title: '새 스킬',
    body: [field('이름', name, h('div', { class: 'help' }, '영문 소문자, 숫자, 하이픈만 쓸 수 있어요.')), field('설명', desc), field('지침 (마크다운)', body)],
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'), h('button', { class: 'btn primary', onclick: async () => {
      try {
        S.skills = await api('POST', '/api/skills', { name: name.value.trim(), description: desc.value.trim(), body: body.value });
        md.close(); renderSidebar(); go(`#/skills/${encodeURIComponent(name.value.trim())}`);
      } catch (e) { toast(e.message, 'error'); }
    } }, '만들기')]
  });
  name.focus();
}

// ============================================================
// MCP 화면
// ============================================================
async function refreshMcpQuiet() {
  try {
    const r = await api('GET', '/api/mcp');
    const changed = JSON.stringify(r.servers.map((s) => [s.name, s.status, s.tools.length])) !== JSON.stringify(S.mcp.map((s) => [s.name, s.status, s.tools.length]));
    S.mcp = r.servers;
    if (changed) { renderSidebar(); if (S.route.view === 'mcp') renderMcp(); updateToolCount(); }
  } catch { /* 무시 */ }
}

async function renderMcp() {
  let data;
  try { data = await api('GET', '/api/mcp'); S.mcp = data.servers; } catch (e) { toast(e.message, 'error'); return; }
  const cfg = data.config;
  const saveCfg = async (next, msg) => {
    try { const r = await api('PUT', '/api/mcp', next); S.mcp = r.servers; renderSidebar(); renderMcp(); updateToolCount(); if (msg) toast(msg); }
    catch (e) { toast(e.message, 'error'); }
  };
  const list = S.mcp.map((s) => {
    const key = `mcp:${s.name}`;
    const d = h('details', { class: 'server' });
    if (S.open.has(key)) d.open = true;
    d.addEventListener('toggle', () => (d.open ? S.open.add(key) : S.open.delete(key)));
    const sc = cfg.mcpServers[s.name] || {};
    const statusText = { connected: `연결됨 · 도구 ${s.tools.length}개`, error: '오류', connecting: '연결 중…', disabled: '꺼짐', stopped: '중지됨' }[s.status] || s.status;
    d.append(h('summary', { class: 'server-head' },
      h('span', { class: `sdot ${s.status}` }),
      h('span', { class: 'name' }, s.name), h('span', { class: 'type' }, s.type),
      h('span', { class: 'grow', style: { color: 'var(--text-3)', fontSize: '13px' } }, statusText),
      !s.disabled ? h('button', { class: 'btn sm', onclick: async (e) => { e.preventDefault(); try { const r = await api('POST', `/api/mcp/${encodeURIComponent(s.name)}/restart`); S.mcp = r.servers; renderMcp(); renderSidebar(); updateToolCount(); } catch (err) { toast(err.message, 'error'); } } }, icon('refresh'), '재시작') : null,
      h('button', { class: 'btn sm', onclick: (e) => { e.preventDefault(); const n = clone(cfg); n.mcpServers[s.name].disabled = !s.disabled; saveCfg(n, s.disabled ? `${s.name} 켜는 중` : `${s.name} 껐어요`); } }, icon('power'), s.disabled ? '켜기' : '끄기'),
      h('button', { class: 'btn sm', onclick: (e) => { e.preventDefault(); editServer(s.name, sc, cfg, saveCfg); } }, icon('edit')),
      h('button', { class: 'btn sm danger', onclick: async (e) => { e.preventDefault(); if (!(await confirmDialog('MCP 서버 삭제', `"${s.name}" 설정을 지울까요?`, '삭제', true))) return; const n = clone(cfg); delete n.mcpServers[s.name]; saveCfg(n); } }, icon('trash'))));
    d.append(h('div', { class: 'server-body' },
      s.error ? h('div', { class: 'err-box' }, s.error) : null,
      s.serverInfo ? h('p', { style: { margin: '0 0 8px', color: 'var(--text-3)' } }, `${s.serverInfo.name || ''} ${s.serverInfo.version || ''}`) : null,
      s.tools.length ? h('div', { class: 'tl' }, s.tools.map((t) => [h('code', null, t.name), h('span', null, t.description.slice(0, 200))])) : h('div', { style: { color: 'var(--text-4)' } }, '도구 없음'),
      s.prompts.length ? [h('div', { class: 'tlabel', style: { margin: '12px 0 4px' } }, '프롬프트'), h('div', { class: 'tl' }, s.prompts.map((p) => [h('code', null, p.name), h('span', null, p.description)]))] : null,
      s.logs.length ? h('div', { class: 'logs' }, s.logs.join('\n')) : null));
    return d;
  });
  main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h2', null, 'MCP 커넥터'),
      h('button', { class: 'btn', onclick: () => importClaude(saveCfg) }, icon('download'), 'Claude Desktop에서 가져오기'),
      h('button', { class: 'btn', onclick: () => editMcpJson(cfg, saveCfg) }, icon('code'), 'JSON 편집'),
      h('button', { class: 'btn primary', onclick: () => editServer(null, {}, cfg, saveCfg) }, icon('plus'), '서버 추가')),
    h('p', { class: 'page-desc' }, 'MCP 서버를 연결하면 그 도구를 모델이 바로 쓸 수 있어요. stdio(npx, uvx, node, python), Streamable HTTP, SSE 방식을 지원하고 설정 형식은 Claude Desktop과 같습니다.'),
    list.length ? list : h('div', { class: 'empty' }, '연결된 MCP 서버가 없어요'))));
}

function editServer(name, sc, cfg, saveCfg) {
  const isRemote = !!sc.url;
  const nameIn = h('input', { type: 'text', value: name || '', placeholder: '예: filesystem', class: 'mono' });
  const typeSel = h('select', null, ...[['stdio', 'stdio (로컬 프로그램)'], ['http', 'Streamable HTTP'], ['sse', 'SSE (레거시)']].map(([v, l]) => h('option', { value: v }, l)));
  typeSel.value = isRemote ? (sc.type === 'sse' ? 'sse' : 'http') : 'stdio';
  const cmd = h('input', { type: 'text', value: sc.command || '', placeholder: 'npx', class: 'mono' });
  const args = h('textarea', { class: 'input mono', rows: 4, value: (sc.args || []).join('\n'), placeholder: '-y\n@modelcontextprotocol/server-filesystem\nD:\\작업폴더' });
  const env = h('textarea', { class: 'input mono', rows: 3, value: Object.entries(sc.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'), placeholder: 'API_KEY=...' });
  const url = h('input', { type: 'url', value: sc.url || '', placeholder: 'https://example.com/mcp', class: 'mono' });
  const headers = h('textarea', { class: 'input mono', rows: 3, value: Object.entries(sc.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'), placeholder: 'Authorization: Bearer ...' });
  const auto = h('input', { type: 'checkbox', checked: !!sc.autoApprove });
  const stdioBox = h('div', null, field('실행 명령', cmd), field('인자 (한 줄에 하나)', args), field('환경변수 (KEY=VALUE)', env));
  const remoteBox = h('div', null, field('URL', url), field('헤더 (Key: Value)', headers));
  const sync = () => { stdioBox.hidden = typeSel.value !== 'stdio'; remoteBox.hidden = typeSel.value === 'stdio'; };
  typeSel.addEventListener('change', sync);
  sync();
  const md = modal({
    title: name ? `MCP 서버 편집: ${name}` : 'MCP 서버 추가',
    body: [h('div', { class: 'row2' }, field('이름', nameIn), field('연결 방식', typeSel)), stdioBox, remoteBox,
      h('label', { class: 'switch' }, auto, h('span', null, '도구 실행 자동 승인', h('span', { class: 'd' }, '끄면 도구를 실행할 때마다 허용 여부를 물어봅니다')))],
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'), h('button', { class: 'btn primary', onclick: () => {
      const n = nameIn.value.trim();
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(n)) { toast('이름은 영문, 숫자, _ . - 만 쓸 수 있어요', 'error'); return; }
      const next = clone(cfg);
      if (name && name !== n) delete next.mcpServers[name];
      const base = { disabled: !!sc.disabled, autoApprove: auto.checked, ...(sc.alwaysAllow ? { alwaysAllow: sc.alwaysAllow } : {}), ...(sc.timeoutMs ? { timeoutMs: sc.timeoutMs } : {}) };
      if (typeSel.value === 'stdio') {
        const e = {};
        env.value.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => { const i = l.indexOf('='); if (i > 0) e[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
        next.mcpServers[n] = { command: cmd.value.trim(), args: args.value.split('\n').map((l) => l.trim()).filter(Boolean), ...(Object.keys(e).length ? { env: e } : {}), ...base };
      } else {
        const hd = {};
        headers.value.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => { const i = l.indexOf(':'); if (i > 0) hd[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
        next.mcpServers[n] = { type: typeSel.value, url: url.value.trim(), ...(Object.keys(hd).length ? { headers: hd } : {}), ...base };
      }
      md.close();
      saveCfg(next, `${n} 저장, 연결 중…`);
    } }, '저장')]
  });
}

function editMcpJson(cfg, saveCfg) {
  const ta = h('textarea', { class: 'input mono', rows: 22, value: JSON.stringify(cfg, null, 2), spellcheck: 'false' });
  const md = modal({
    title: 'MCP 설정 JSON', wide: true,
    body: [h('p', { class: 'page-desc' }, 'Claude Desktop 설정의 mcpServers 부분을 그대로 붙여넣어도 됩니다. 저장할 때 스키마(schemas/mcp.schema.json)로 검사해요.'), ta],
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'), h('button', { class: 'btn primary', onclick: () => {
      let j;
      try { j = JSON.parse(ta.value); } catch (e) { toast(`JSON 형식 오류: ${e.message}`, 'error'); return; }
      if (!j.mcpServers) j = { mcpServers: j };
      md.close();
      saveCfg(j, '저장했어요. 서버를 다시 연결하는 중…');
    } }, '저장')]
  });
}

async function importClaude() {
  try {
    const r = await api('POST', '/api/mcp/import-claude');
    S.mcp = r.servers;
    toast(r.added.length ? `${r.added.length}개를 가져왔어요 (꺼진 상태). 필요한 것만 켜 주세요.${r.skipped.length ? `\n건너뜀: ${r.skipped.join(', ')}` : ''}` : `새로 가져올 서버가 없어요${r.skipped.length ? ` (이미 있음: ${r.skipped.join(', ')})` : ''}`);
    renderSidebar(); renderMcp();
  } catch (e) { toast(e.message, 'error'); }
}

// ============================================================
// 이미지 갤러리
// ============================================================
// 공급자 request id
const requestIdIn = (text) => (String(text || '').match(/Request id:\s*([A-Za-z0-9_-]+)/i) || [])[1] || null;

function requestIdMenu(anchor, ids) {
  popover(anchor, [
    h('div', { class: 'menu-head' }, '바이트댄스 Request ID'),
    ...ids.map((id, i) => h('button', { class: 'menu-item', title: '복사', onclick: () => { closePopover(); copyText(id); } },
      h('span', { class: 'txt' }, h('code', { class: 'reqid' }, id), h('span', { class: 'sub' }, ids.length > 1 ? `${i + 1}번째 호출` : '')), icon('copy'))),
    h('div', { class: 'menu-sep' }),
    menuItem('hash', '요청 기록에서 보기', () => go(`#/requests/${encodeURIComponent(ids[0])}`))
  ], { above: true });
}

const KIND_LABEL = { chat: '채팅', image: '이미지', title: '제목', test: '연결 테스트', models: '모델 목록', complete: '짧은 응답' };

async function renderRequests() {
  const q = h('input', { type: 'search', placeholder: 'Request ID, 모델, 오류 내용으로 검색', value: S.route.id ? decodeURIComponent(S.route.id) : '' });
  const kind = h('select', null, h('option', { value: '' }, '전체 종류'), ...Object.entries(KIND_LABEL).map(([v, l]) => h('option', { value: v }, l)));
  const status = h('select', null, h('option', { value: '' }, '전체 상태'), h('option', { value: 'ok' }, '성공'), h('option', { value: 'error' }, '실패'), h('option', { value: 'aborted' }, '중단'));
  const body = h('div');
  let timer;
  const load = async () => {
    const params = new URLSearchParams({ q: q.value.trim(), kind: kind.value, status: status.value, limit: '300' });
    let list = [];
    try { list = await api('GET', `/api/requests?${params}`); } catch (e) { toast(e.message, 'error'); }
    if (!list.length) { body.replaceChildren(h('div', { class: 'empty' }, q.value.trim() ? '일치하는 요청이 없어요' : '아직 기록된 요청이 없어요')); return; }
    const rows = list.map((e) => {
      const t = new Date(e.time);
      const tok = e.usage && (e.usage.total_tokens || e.usage.totalTokens);
      return h('tr', { class: e.status === 'error' ? 'req-err' : '' },
        h('td', { class: 'nowrap' }, `${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')} ${[t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')}`),
        h('td', { class: 'nowrap' }, KIND_LABEL[e.kind] || e.kind, e.source === 'mcp' ? h('span', { class: 'chip', style: { marginLeft: '4px' } }, 'OpenCode') : null),
        h('td', { class: 'mono small' }, e.model || '-'),
        h('td', { class: 'nowrap' }, e.status === 'ok' ? '성공' : e.status === 'aborted' ? '중단' : '실패', e.httpStatus ? ` · ${e.httpStatus}` : ''),
        h('td', null, e.requestId
          ? h('div', { class: 'reqid-cell' }, h('code', { class: 'reqid' }, e.requestId), iconBtn('copy', () => copyText(e.requestId), '복사'))
          : h('span', { class: 'muted' }, '없음'),
          e.error ? h('div', { class: 'req-error' }, e.error) : null),
        h('td', { class: 'nowrap small' }, e.durationMs != null ? fmtDur(e.durationMs) : '', tok ? h('div', { class: 'muted' }, `${tok.toLocaleString()} 토큰`) : null),
        h('td', { class: 'nowrap' }, e.conversationId ? h('a', { href: `#/c/${e.conversationId}` }, '대화 열기') : ''));
    });
    body.replaceChildren(h('div', { class: 'table-wrap req-table' }, h('table', null,
      h('thead', null, h('tr', null, ...['시간', '종류', '모델', '상태', 'Request ID', '시간·토큰', ''].map((x) => h('th', null, x)))),
      h('tbody', null, rows))));
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  kind.addEventListener('change', load);
  status.addEventListener('change', load);
  main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner wide' },
    h('div', { class: 'page-head' }, h('h2', null, '요청 기록'), h('button', { class: 'btn', onclick: load }, icon('refresh'), '새로고침')),
    h('p', { class: 'page-desc' }, '바이트댄스(ModelArk)로 보낸 채팅·이미지 요청과 응답의 Request ID를 모아 둔 곳이에요. 콘솔이나 고객지원에 문의할 때 이 ID를 알려 주면 해당 요청을 바로 찾을 수 있어요. OpenCode에서 flash-studio MCP로 보낸 요청도 함께 기록돼요.'),
    h('div', { class: 'toolbar' }, q, kind, status),
    body)));
  load();
}

// 이미지 모델 목록과 예상 비용 (USD, 장당)
const USD_KRW = 1400;
const IMAGE_MODELS = [
  {
    id: 'dola-seedream-5-0-pro-260628',
    name: 'Seedream 5.0 Pro',
    desc: '품질이 가장 좋아요. 1K·2K 지원, 여러 장 연속 생성은 안 돼요.',
    cost: (px) => (px <= 2359296 ? 0.045 : 0.09),
    note: '236만 픽셀 이하 $0.045 · 초과 $0.09 · 참조 이미지는 2장째부터 장당 $0.003'
  }
];

function sizePixels(size) {
  const s = String(size || '').trim().toUpperCase();
  const wh = s.match(/^(\d+)\s*[X×*]\s*(\d+)$/);
  if (wh) return Number(wh[1]) * Number(wh[2]);
  const k = s.match(/^(\d+(?:\.\d+)?)K$/);
  if (k) { const side = Math.round(Number(k[1]) * 1024); return side * side; }
  return 2048 * 2048;
}

const fmtCost = (usd) => `$${usd.toFixed(3).replace(/0$/, '')} (약 ${Math.round(usd * USD_KRW).toLocaleString()}원)`;

async function renderImages() {
  let list = [];
  try { list = await api('GET', '/api/images'); } catch (e) { toast(e.message, 'error'); }
  main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h2', null, '이미지 갤러리'),
      h('button', { class: 'btn', onclick: () => api('POST', '/api/open', { which: 'images' }) }, icon('folder'), '폴더 열기'),
      h('button', { class: 'btn primary', onclick: () => { S.opts.imageMode = true; newChat(); } }, icon('image'), '새 이미지')),
    h('p', { class: 'page-desc' }, `생성한 이미지는 ${S.dirs.images} 에 저장돼요.`),
    list.length ? h('div', { class: 'images-grid' }, list.map((u) => h('img', { src: u, loading: 'lazy', onclick: () => lightbox(u) }))) : h('div', { class: 'empty' }, '아직 만든 이미지가 없어요'))));
}

// ============================================================
// 설정
// ============================================================
const PRESETS = [
  { id: 'modelark', name: 'BytePlus ModelArk', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3', apiKeyEnv: 'ARK_API_KEY', thinkingStyle: 'thinking_object', models: [{ id: 'deepseek-v4-flash-ga-260731', label: 'DeepSeek V4 Flash' }, { id: 'deepseek-v4-1-flash-260910', label: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro-ga-260813', label: 'DeepSeek V4 Pro' }] },
  { id: 'volcengine', name: 'Volcengine Ark (중국)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKeyEnv: 'ARK_API_KEY', thinkingStyle: 'thinking_object', models: [{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }] },
  { id: 'deepseek', name: 'DeepSeek 공식', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', thinkingStyle: 'thinking_object', models: [{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }] },
  { id: 'ollama', name: 'Ollama (로컬)', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: '', thinkingStyle: 'none', models: [{ id: 'deepseek-r1:8b', label: 'DeepSeek R1 8B' }] },
  { id: 'lmstudio', name: 'LM Studio (로컬)', baseUrl: 'http://127.0.0.1:1234/v1', apiKeyEnv: '', thinkingStyle: 'none', models: [{ id: 'local-model', label: 'LM Studio 모델' }] },
  { id: 'custom', name: '사용자 지정', baseUrl: 'https://', apiKeyEnv: '', thinkingStyle: 'none', models: [{ id: 'model-id', label: '' }] }
];

async function openSettings(tab = 'general') {
  try { S.settings = await api('GET', '/api/settings'); } catch { /* 최신 설정을 못 받으면 가진 것으로 */ }
  const draft = clone(S.settings);
  let current = tab;
  const nav = h('nav');
  const pane = h('div', { class: 'pane' });
  const tabs = [['general', '일반'], ['providers', '모델 공급자'], ['image', '이미지 생성'], ['tools', '도구·권한'], ['skills', '스킬'], ['memory', '메모리'], ['about', '정보']];
  const drawNav = () => nav.replaceChildren(...tabs.map(([id, label]) => h('button', { class: `nav-item${current === id ? ' active' : ''}`, onclick: () => { current = id; drawNav(); drawPane(); } }, label)));

  const sw = (obj, key, label, desc) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: obj[key], onchange: (e) => { obj[key] = e.target.checked; } }), h('span', null, label, desc ? h('span', { class: 'd' }, desc) : null));
  const txt = (obj, key, attrs = {}) => h('input', { type: 'text', value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value; }, ...attrs });
  const num = (obj, key, attrs = {}) => h('input', { type: 'number', value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value === '' ? null : Number(e.target.value); }, ...attrs });
  const sel = (obj, key, options) => { const s = h('select', { onchange: (e) => { obj[key] = e.target.value; } }, ...options.map(([v, l]) => h('option', { value: v }, l))); s.value = obj[key]; return s; };
  const lines = (obj, key, attrs = {}) => h('textarea', { class: 'input mono', rows: 3, value: (obj[key] || []).join('\n'), oninput: (e) => { obj[key] = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean); }, ...attrs });
  const jsonArea = (obj, key) => {
    const ta = h('textarea', { class: 'input mono', rows: 3, value: JSON.stringify(obj[key] || {}, null, 2) });
    ta.addEventListener('input', () => { try { obj[key] = JSON.parse(ta.value || '{}'); ta.style.borderColor = ''; } catch { ta.style.borderColor = 'var(--danger)'; } });
    return ta;
  };

  const drawPane = () => {
    const g = draft.generation, ap = draft.appearance, ig = draft.imageGen, t = draft.tools, sk = draft.skills;
    let content = [];
    if (current === 'general') {
      content = [
        h('h4', null, '화면'),
        h('div', { class: 'row2' }, field('테마', sel(ap, 'theme', [['system', '시스템 설정 따르기'], ['light', '밝게'], ['dark', '어둡게']])), field('글자 크기', sel(ap, 'fontSize', [['small', '작게'], ['medium', '보통'], ['large', '크게']]))),
        field('응답 글꼴', sel(ap, 'responseFont', [['sans', '고딕 (산세리프)'], ['serif', '명조 (세리프)']])),
        h('h4', null, '응답'),
        field('기본 지침 (시스템 프롬프트)', h('textarea', { class: 'input', rows: 7, value: draft.systemPrompt, oninput: (e) => { draft.systemPrompt = e.target.value; } }), h('div', { class: 'help' }, '모든 대화에 들어가는 지침이에요. 대화별 지침은 대화 메뉴에서 따로 정할 수 있어요.')),
        h('div', { class: 'row2' }, field('Temperature', num(g, 'temperature', { step: '0.1', min: 0, max: 2, placeholder: '모델 기본값' })), field('최대 출력 토큰', num(g, 'maxTokens', { min: 1, placeholder: '모델 기본값' }))),
        sw(g, 'thinking', '확장 사고를 기본으로 켜기', '추론 모델이 답하기 전에 생각 과정을 거칩니다. 입력창의 "사고" 버튼으로 매번 바꿀 수 있어요.'),
        sw(g, 'resendReasoningInToolLoop', '도구 루프에서 생각 과정 다시 보내기', 'DeepSeek 사고 모드에서 도구를 연달아 쓸 때 필요합니다. 오류가 나면 꺼 보세요.'),
        sw(g, 'autoTitle', '대화 제목 자동 생성'),
        h('h4', null, '컨텍스트 정리'),
        sw(g, 'autoCompact', '대화가 길어지면 앞부분을 자동으로 요약', '원래 메시지는 화면에 그대로 남고, 모델에게 보내는 내용만 요약으로 바뀝니다. 요청 한도(429)와 비용을 줄여 줍니다.'),
        sw(g, 'autoHandoff', '누적 기준에 도달하면 새 대화로 전환·자동 재개', '요청이 길어지면 같은 방에서 정리합니다. 원문이 누적 300만 토큰에 도달하면 전체 지침과 남은 일을 대조한 뒤 새 방으로 이동해 이어갑니다.'),
        h('div', { class: 'row2' },
          field('컨텍스트 사용 비율 (%)', num(g, 'compactAtPercent', { min: 10, max: 99, step: 1 }), h('div', { class: 'help' }, '기본 99%입니다. 창이 작은 모델은 이 비율에 도달하면 먼저 전환합니다.')),
          field('요청 정리 토큰 기준', num(g, 'compactAtTokens', { min: 10000, max: 1048576, step: 10000 }), h('div', { class: 'help' }, '기본 1,000,000토큰. 한 번의 요청이 이 기준에 닿으면 같은 채팅방에서 앞부분을 요약해 이어갑니다. 분당 TPM 제한과는 별개예요.'))),
        field('채팅방 전환 누적 토큰', num(g, 'handoffAtTokens', { min: 100000, max: 20000000, step: 100000 }), h('div', { class: 'help' }, '기본 3,000,000. 원문 텍스트의 추정 누적이며 반복 입력 과금 합계가 아닙니다. 원문은 삭제하지 않습니다.')),
        field('원문으로 남길 최근 턴 수', num(g, 'compactKeepTurns', { min: 1, max: 20 }))
      ];
    } else if (current === 'providers') {
      content = [
        h('p', { class: 'page-desc' }, 'OpenAI 호환 API라면 어디든 연결할 수 있어요. API 키는 직접 넣거나, 비워 두고 환경변수 이름만 적어도 됩니다(Windows 사용자 환경변수도 읽어요).'),
        ...draft.providers.map((p, pi) => providerCard(p, pi)),
        h('button', { class: 'btn', onclick: (e) => popover(e.currentTarget, PRESETS.map((pr) => menuItem('plus', pr.name, () => {
          let id = pr.id, n = 2;
          while (draft.providers.some((x) => x.id === id)) id = `${pr.id}-${n++}`;
          draft.providers.push({ ...clone(pr), id, apiKey: '', extraBody: {}, headers: {}, models: pr.models.map((m) => ({ vision: false, tools: true, reasoning: true, contextWindow: null, ...m })) });
          drawPane();
        }))) }, icon('plus'), '공급자 추가')
      ];
    } else if (current === 'image') {
      content = [
        h('p', { class: 'page-desc' }, '이미지 버튼과 generate_image 도구에서 사용할 생성 엔진입니다. Grok은 구독 로그인, ANIMA는 로컬 모델을 사용합니다. API 공급자 설정은 API 엔진을 선택할 때만 사용합니다.'),
        field('생성 엔진', sel(ig, 'engine', [['grok-cli','Grok 구독'],['anima-local','ANIMA 로컬 · 텍스트→이미지'],['api','기존 API 공급자']])),
        sw(ig, 'enabled', '이미지 생성 사용'),
        field('공급자', sel(ig, 'providerId', draft.providers.map((p) => [p.id, p.name]))),
        imageModelPicker(ig),
        sw(ig, 'watermark', '워터마크 넣기'),
        field('추가 요청 파라미터 (JSON)', jsonArea(ig, 'extraBody'), h('div', { class: 'help' }, '예: {"sequential_image_generation":"auto"}')),
        // 변환 검수 (convert_panels · check_conversion)
        ...(() => {
          const qa = draft.qa || (draft.qa = { enabled: true, providerId: 'modelark', model: 'seed-2-0-lite-260428', maxAttempts: 3, passScore: 85, concurrency: 3 });
          return [
            h('h4', null, '변환 검수 (원본 대조)'),
            sw(qa, 'enabled', '16:9 변환 뒤 원본과 대조해 검수하고, 문제가 있으면 다시 생성', '인물·얼굴·머리색·옷·소품이 빠지거나 바뀌었는지, 원본에 없던 게 생겼는지, 글자가 남았는지를 확인해요. 에셋이 컷마다 흔들리지 않게 해 줘요.'),
            h('div', { class: 'row2' },
              field('검수 모델 공급자', sel(qa, 'providerId', draft.providers.map((p) => [p.id, p.name]))),
              field('검수 모델 ID', txt(qa, 'model', { class: 'mono', placeholder: 'seed-2-0-lite-260428' }), h('div', { class: 'help' }, '이미지를 읽을 수 있는 모델이어야 해요. 기본: Seed 2.0 lite (더 꼼꼼하게는 seed-2-0-pro-260328)'))),
            h('div', { class: 'row2' },
              field('컷당 최대 생성 횟수', num(qa, 'maxAttempts', { min: 1, max: 5 }), h('div', { class: 'help' }, '처음 1회 + 불합격 시 재생성. 재생성도 비용이 들어요')),
              field('합격 점수', num(qa, 'passScore', { min: 0, max: 100 }), h('div', { class: 'help' }, '이 점수 이상이고 심각한 문제가 없어야 합격'))),
            field('동시에 처리할 컷 수', num(qa, 'concurrency', { min: 1, max: 6 }))
          ];
        })()
      ];
    } else if (current === 'tools') {
      content = [
        field('도구 실행 승인', sel(t, 'approval', [['ask', '쓰기·삭제·업로드·명령·MCP 도구는 물어보기'], ['auto', '모두 자동 실행']])),
        sw(t, 'enableWorkspace', '파일·문서 도구', '파일 찾기·검색·정보(SHA-256)·읽기·쓰기·수정·복사·이동·이름 바꾸기·휴지통 삭제·열기, Word·Excel·PowerPoint·PDF 읽기, zip'),
        sw(t, 'enableWeb', '웹 도구', '웹 검색, 파일 다운로드, HTTP 요청(API 호출·업로드 URL 로 파일 전송)'),
        sw(t, 'enableFetch', '웹 페이지 가져오기 (fetch_url)'),
        sw(t, 'enableBrowser', '작업 브라우저', '모델이 웹 페이지를 열고 누르고 입력해요. 화면은 오른쪽 작업 패널에 실시간으로 떠요.'),
        field('질문 자동 진행 시간 (초)', num(t, 'askTimeoutSec', { min: 5, max: 600 }), h('div', { class: 'help' }, '모델이 보기를 주고 물었을 때 이 시간 안에 답이 없으면 권장안으로 진행해요. 중요한 결정은 메모에 남기고 해당 의존 작업만 보류합니다. 독립 작업은 계속 진행합니다.')),
        sw(t, 'enableCode', '계산 실행 (run_javascript)', '파일·네트워크 접근이 없는 격리 환경에서 계산·데이터 가공'),
        sw(t, 'enableMemory', '메모리', '기억해 달라고 한 내용을 대화가 바뀌어도 유지합니다. 설정 → 메모리에서 보고 지울 수 있어요.'),
        sw(t, 'enableShell', 'PowerShell 명령 실행 (run_command)', '모델이 PC에서 명령을 실행할 수 있게 됩니다. 승인 모드를 "물어보기"로 두는 걸 권해요.'),
        h('div', { class: 'row2' }, field('도구 호출 최대 횟수', num(t, 'maxRounds', { min: 1, max: 50 })), field('도구 결과 최대 글자 수', num(t, 'resultLimit', { min: 1000 }))),
        field('추가 허용 폴더 (한 줄에 하나)', lines(t, 'allowedDirs', { placeholder: 'D:\\프로젝트' }), h('div', { class: 'help' }, `작업 폴더(${S.dirs.workspace}) 외에 파일을 읽고 쓰고, 복사·이동·삭제할 수 있는 폴더예요. 앱 이미지 폴더(/files/images)와 첨부 폴더는 읽기만 됩니다.`)),
        h('button', { class: 'btn', onclick: () => api('POST', '/api/open', { which: 'workspace' }) }, icon('folder'), '작업 폴더 열기')
      ];
    } else if (current === 'skills') {
      content = [
        field('외부 스킬 폴더 (한 줄에 하나)', lines(sk, 'extraDirs', { rows: 4, placeholder: 'C:\\Users\\이름\\.claude\\skills' }), h('div', { class: 'help' }, `기본 스킬 폴더(${S.dirs.skills}) 외에 함께 읽을 폴더예요. 각 하위 폴더에 SKILL.md 가 있으면 스킬로 인식합니다.`)),
        field('사용하지 않을 스킬 (한 줄에 하나)', lines(sk, 'disabled', { rows: 4, placeholder: 'computer-use' }), h('div', { class: 'help' }, '외부 폴더에 있어도 이 이름의 스킬은 불러오지 않아요.')),
        field('모델에게 보여줄 스킬 목록 최대 개수', num(sk, 'maxCatalog', { min: 0, max: 500 }))
      ];
    } else if (current === 'memory') {
      const listBox = h('div');
      const decisionBox = h('div');
      const drawDecisions = () => api('GET', '/api/decisions').then(items => decisionBox.replaceChildren(...(items.length ? [...items].sort((a,b) => (a.status === 'answered') - (b.status === 'answered') || b.createdAt.localeCompare(a.createdAt)).map(item => decisionMemoCard(item, drawDecisions)) : [h('p', { class: 'muted' }, '미답변 결정이 없습니다.')]))).catch(e => toast(e.message, 'error'));
      drawDecisions();
      const input = h('textarea', { class: 'input', rows: 2, placeholder: '예: 바오 업로드는 항상 background 카테고리로 올린다' });
      const drawMem = (items) => listBox.replaceChildren(...(items.length
        ? items.map((m) => h('div', { class: 'mem-item' }, h('div', { class: 'mem-text' }, m.text, h('div', { class: 'muted' }, new Date(m.createdAt).toLocaleString('ko-KR'))),
          iconBtn('trash', async () => { try { drawMem(await api('DELETE', `/api/memory/${m.id}`)); } catch (e) { toast(e.message, 'error'); } }, '지우기')))
        : [h('div', { class: 'empty' }, '아직 기억해 둔 내용이 없어요')]));
      api('GET', '/api/memory').then(drawMem).catch((e) => toast(e.message, 'error'));
      content = [
        h('p', { class: 'page-desc' }, '여기 적힌 내용은 모든 대화의 시스템 프롬프트에 들어가요. 대화 중에 "이거 기억해"라고 하면 모델이 직접 추가하고, 여기서 바로 넣거나 지울 수도 있어요.'),
        h('div', { class: 'field' }, input, h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '6px' } },
          h('button', { class: 'btn sm primary', onclick: async () => { if (!input.value.trim()) return; try { drawMem(await api('POST', '/api/memory', { text: input.value })); input.value = ''; } catch (e) { toast(e.message, 'error'); } } }, icon('plus'), '추가'))),
        listBox, h('h4', null, '결정 메모 — 부재중 질문'), decisionBox
      ];
    } else if (current === 'about') {
      content = [
        h('h4', null, `Flash Studio ${S.version}`),
        h('p', { class: 'page-desc' }, '로컬에 설치해 쓰는 LLM 스튜디오. 서버와 데이터가 모두 이 PC에 있어요.'),
        h('div', { class: 'tl', style: { display: 'grid', gridTemplateColumns: '120px 1fr', gap: '6px 12px', fontSize: '13px' } },
          '설치 경로', h('code', null, S.root), '데이터', h('code', null, `${S.root}\\data`), '스키마', h('code', null, `${S.root}\\schemas`)),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', onclick: () => api('POST', '/api/open', { which: 'root' }) }, icon('folder'), '설치 폴더'),
          h('button', { class: 'btn', onclick: () => api('POST', '/api/open', { which: 'data' }) }, icon('folder'), '데이터 폴더'),
          h('button', { class: 'btn', onclick: () => api('POST', '/api/open', { which: 'logs' }) }, icon('folder'), '로그')),
        h('h4', null, '단축키'),
        h('div', { class: 'tl', style: { display: 'grid', gridTemplateColumns: '160px 1fr', gap: '6px 12px', fontSize: '13px' } },
          'Enter', '보내기', 'Shift + Enter', '줄바꿈', '/', '프롬프트·스킬 불러오기', 'Ctrl + Shift + O', '새 채팅', 'Ctrl + B', '사이드바 접기', 'Ctrl + K', '대화 검색', 'Esc', '창·메뉴 닫기')
      ];
    }
    pane.replaceChildren(...content);
  };

  const imageModelPicker = (ig) => {
    const list = IMAGE_MODELS.some((m) => m.id === ig.model) ? IMAGE_MODELS
      : [...IMAGE_MODELS, { id: ig.model, name: '현재 설정된 다른 모델', desc: ig.model, cost: null, note: '예상 비용 정보가 없어요' }];
    const cards = h('div', { class: 'img-models' });
    const sizeIn = h('input', { type: 'text', value: ig.size, placeholder: '2048x1152' });
    const sizeHelp = h('div', { class: 'help' });
    let freeSize = IMAGE_MODELS.some((m) => m.fixedSize === ig.size) ? '2048x1152' : ig.size;
    const draw = () => {
      const fixed = (list.find((m) => m.id === ig.model) || {}).fixedSize;
      if (fixed) { ig.size = fixed; sizeIn.value = list.find((m) => m.id === ig.model).fixedLabel; sizeIn.disabled = true; }
      else { if (sizeIn.disabled) { ig.size = freeSize; sizeIn.value = freeSize; } sizeIn.disabled = false; }
      sizeHelp.textContent = fixed ? '이 모델은 해상도와 상관없이 가격이 같아서 2K로 고정돼요.' : '16:9는 2048x1152, 1:1은 2048x2048처럼 가로x세로 픽셀로 적거나 1K·2K로 적어요.';
      const px = sizePixels(ig.size);
      cards.replaceChildren(...list.map((m) => h('label', { class: `img-model${ig.model === m.id ? ' on' : ''}` },
        h('input', { type: 'radio', name: 'img-model', checked: ig.model === m.id, onchange: () => { ig.model = m.id; draw(); } }),
        h('div', { class: 'im-body' },
          h('b', null, m.name),
          h('span', { class: 'im-desc' }, m.desc),
          h('span', { class: 'im-cost' }, m.cost ? `예상 비용: 장당 ${fmtCost(m.cost(px))}` : '예상 비용: 알 수 없음'),
          h('span', { class: 'im-note' }, m.note)))));
    };
    sizeIn.addEventListener('input', () => { ig.size = sizeIn.value.trim(); freeSize = ig.size; draw(); });
    draw();
    return h('div', null,
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, '이미지 모델'), cards,
        h('div', { class: 'help' }, `예상 비용은 기본 크기 기준, 환율 ${USD_KRW.toLocaleString()}원으로 계산했어요. 실제 청구 금액은 ModelArk 콘솔에서 확인하세요.`)),
      field('기본 크기', sizeIn, sizeHelp));
  };

  const providerCard = (p, pi) => {
    const isActive = draft.activeProviderId === p.id;
    const modelsBox = h('div');
    const drawModels = () => modelsBox.replaceChildren(
      h('div', { class: 'row3', style: { fontSize: '12px', color: 'var(--text-4)', marginBottom: '4px' } }, h('span', null, '모델 ID'), h('span', null, '표시 이름'), h('span', null, '컨텍스트 창'), h('span'), h('span'), h('span')),
      ...p.models.map((m, mi) => h('div', { class: 'row3', style: { marginBottom: '6px' } },
        txt(m, 'id', { class: 'mono', placeholder: 'deepseek-v4-flash 또는 ep-...' }),
        txt(m, 'label', { placeholder: '표시 이름' }),
        h('input', { type: 'number', min: 1, value: m.contextWindow ?? '', placeholder: '모름', title: '모델이 한 번에 받을 수 있는 최대 토큰. 입력창의 컨텍스트 %와 자동 정리 기준에 쓰여요. DeepSeek V4 계열은 1048576', oninput: (e) => { m.contextWindow = e.target.value === '' ? null : Number(e.target.value); } }),
        h('label', { class: 'check-sm', title: '이미지 입력 지원' }, h('input', { type: 'checkbox', checked: m.vision, onchange: (e) => { m.vision = e.target.checked; } }), '비전'),
        h('label', { class: 'check-sm', title: '도구 호출 지원' }, h('input', { type: 'checkbox', checked: m.tools, onchange: (e) => { m.tools = e.target.checked; } }), '도구'),
        iconBtn('x', () => { if (p.models.length > 1) { p.models.splice(mi, 1); drawModels(); } else toast('모델이 하나는 있어야 해요'); }, '모델 삭제'))),
      h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        h('button', { class: 'btn sm', onclick: () => { p.models.push({ id: '', label: '', vision: false, tools: true, reasoning: true, contextWindow: null }); drawModels(); } }, icon('plus'), '모델 추가'),
        h('button', { class: 'btn sm', onclick: (e) => fetchModels(p, e.currentTarget, drawModels) }, icon('download'), '모델 목록 불러오기'),
        h('button', { class: 'btn sm', onclick: () => testProvider(p) }, icon('bolt'), '연결 테스트')));
    drawModels();
    const keyState = p.keySource === 'env' ? h('span', { class: 'key-state ok' }, `환경변수 ${p.apiKeyEnv} 에서 키를 읽었어요`)
      : p.keySource === 'settings' ? h('span', { class: 'key-state ok' }, '키가 저장되어 있어요')
      : h('span', { class: 'key-state no' }, '키 없음');
    return h('div', { class: `prov${isActive ? ' active-prov' : ''}` },
      h('div', { class: 'prov-head' }, h('b', null, p.name || p.id),
        isActive ? h('span', { class: 'chip accent' }, '기본') : h('button', { class: 'btn sm', onclick: () => { draft.activeProviderId = p.id; draft.activeModel = p.models[0].id; drawPane(); } }, '기본으로'),
        iconBtn('trash', () => { if (draft.providers.length === 1) return toast('공급자가 하나는 있어야 해요'); draft.providers.splice(pi, 1); if (isActive) { draft.activeProviderId = draft.providers[0].id; draft.activeModel = draft.providers[0].models[0].id; } drawPane(); }, '공급자 삭제')),
      h('div', { class: 'row2' }, field('이름', txt(p, 'name')), field('ID', txt(p, 'id', { class: 'mono', disabled: true }))),
      field('Base URL', txt(p, 'baseUrl', { class: 'mono' })),
      h('div', { class: 'row2' },
        field('API 키', h('input', { type: 'password', value: p.apiKey || '', placeholder: '비우면 환경변수 사용', oninput: (e) => { p.apiKey = e.target.value; } }), keyState),
        field('환경변수 이름', txt(p, 'apiKeyEnv', { class: 'mono', placeholder: 'ARK_API_KEY' }))),
      field('사고(추론) 파라미터', sel(p, 'thinkingStyle', [['thinking_object', 'thinking: {type} — Ark · DeepSeek'], ['enable_thinking', 'enable_thinking: bool — Qwen 등'], ['none', '보내지 않음 — 로컬 모델']])),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, '모델'), modelsBox),
      h('details', null, h('summary', { style: { cursor: 'pointer', fontSize: '13px', color: 'var(--text-3)' } }, '고급: 추가 요청 파라미터 / 헤더'),
        field('추가 요청 파라미터 (JSON)', jsonArea(p, 'extraBody')), field('추가 헤더 (JSON)', jsonArea(p, 'headers'))));
  };

  const persist = async () => {
    for (const p of draft.providers) p.models = p.models.filter((m) => m.id.trim());
    S.settings = await api('PUT', '/api/settings', draft);
    applyAppearance();
    await reloadSkills();
  };

  const fetchModels = async (p, anchor, drawModels) => {
    try {
      await persist();
      const r = await api('POST', `/api/providers/${p.id}/models`);
      if (!r.models.length) return toast('불러온 모델이 없어요');
      const q = h('input', { type: 'search', placeholder: '검색 (예: deepseek, seedream)', style: { margin: '4px 0 6px' } });
      const box = h('div');
      const draw = () => box.replaceChildren(...r.models.filter((m) => m.id.toLowerCase().includes(q.value.toLowerCase())).slice(0, 100).map((m) => menuItem(p.models.some((x) => x.id === m.id) ? 'check' : 'plus', m.id, () => {
        if (!p.models.some((x) => x.id === m.id)) p.models.push({ id: m.id, label: '', vision: /vision|vl|seed-1|gpt-4o/i.test(m.id), tools: true, reasoning: true, contextWindow: m.contextWindow || null });
        drawModels();
      })));
      q.addEventListener('input', draw);
      draw();
      popover(anchor, [q, box]);
      setTimeout(() => q.focus(), 20);
    } catch (e) { toast(`모델 목록을 불러오지 못했어요: ${e.message}`, 'error'); }
  };

  const testProvider = async (p) => {
    try {
      await persist();
      const saved = S.settings.providers.find((x) => x.id === p.id);
      const model = saved.models[0].id;
      toast(`${model} 에 연결하는 중…`);
      const r = await api('POST', `/api/providers/${p.id}/test`, { model });
      toast(`연결 성공 (${r.ms}ms): ${r.reply || '(빈 응답)'}`);
      md.close();
      openSettings('providers');
    } catch (e) { toast(`연결 실패: ${e.message}`, 'error'); }
  };

  drawNav();
  drawPane();
  const md = modal({
    title: '설정', wide: true, raw: true,
    body: h('div', { class: 'settings' }, nav, pane),
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '닫기'), h('button', { class: 'btn primary', onclick: async () => {
      try { await persist(); toast('저장했어요'); md.close(); renderSidebar(); renderMain(); }
      catch (e) { toast(e.details ? `${e.message}` : e.message, 'error'); }
    } }, '저장')]
  });
}

// ============================================================
// 공용 UI: 모달, 팝오버, 필드, 대화상자, 미리보기 패널, 라이트박스
// ============================================================
function field(label, input, ...extra) {
  return h('div', { class: 'field' }, h('label', null, label), input, ...extra);
}

function menuItem(ico, label, onclick, cls = '') {
  return h('button', { class: `menu-item ${cls}`, onclick: () => { closePopover(); onclick(); } }, icon(ico), h('span', { class: 'txt' }, label));
}

function modal({ title, body, foot, wide, raw, onClose }) {
  const back = h('div', { class: 'backdrop' });
  const close = () => { back.remove(); S.modals = S.modals.filter((x) => x !== close); onClose && onClose(); };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  const m = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog' },
    h('div', { class: 'modal-head' }, h('h3', null, title), iconBtn('x', close, '닫기')),
    raw ? body : h('div', { class: 'modal-body' }, body),
    foot ? h('div', { class: 'modal-foot' }, foot) : null);
  back.append(m);
  $('#modal-root').append(back);
  S.modals.push(close);
  return { close, el: m };
}

function confirmDialog(title, text, okLabel = '확인', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const md = modal({
      title, body: h('p', { style: { margin: '4px 0' } }, text),
      onClose: () => { if (!done) resolve(false); },
      foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'),
        h('button', { class: `btn ${danger ? 'accent' : 'primary'}`, onclick: () => { done = true; resolve(true); md.close(); } }, okLabel)]
    });
  });
}

function inputDialog(title, value) {
  return new Promise((resolve) => {
    let done = false;
    const inp = h('input', { type: 'text', value: value || '' });
    const ok = () => { done = true; resolve(inp.value); md.close(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    const md = modal({
      title, body: inp, onClose: () => { if (!done) resolve(null); },
      foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'), h('button', { class: 'btn primary', onclick: ok }, '확인')]
    });
    setTimeout(() => { inp.focus(); inp.select(); }, 20);
  });
}

function formDialog(title, fields) {
  return new Promise((resolve) => {
    let done = false;
    const inputs = {};
    const body = fields.map((f) => {
      const el = f.multiline ? h('textarea', { class: 'input', rows: 5, value: f.value || '' }) : h('input', { type: 'text', value: f.value || '' });
      inputs[f.name] = el;
      return field(f.label, el, f.help ? h('div', { class: 'help' }, f.help) : null);
    });
    const ok = () => { done = true; resolve(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]))); md.close(); };
    const md = modal({
      title, body, onClose: () => { if (!done) resolve(null); },
      foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'), h('button', { class: 'btn primary', onclick: ok }, '넣기')]
    });
    setTimeout(() => Object.values(inputs)[0]?.focus(), 20);
  });
}

function popover(anchor, content, { align = 'left', above = false } = {}) {
  closePopover();
  const p = h('div', { class: 'popover' }, content);
  document.body.append(p);
  const r = anchor.getBoundingClientRect();
  const pw = p.offsetWidth, ph = p.offsetHeight;
  let top = above || r.bottom + ph + 8 > innerHeight ? r.top - ph - 6 : r.bottom + 6;
  if (top < 8) top = Math.min(r.bottom + 6, innerHeight - ph - 8);
  let left = align === 'right' ? r.right - pw : r.left;
  left = Math.max(8, Math.min(left, innerWidth - pw - 8));
  Object.assign(p.style, { top: `${top}px`, left: `${left}px` });
  S.pop = p;
  setTimeout(() => document.addEventListener('mousedown', outsidePop), 0);
}

function outsidePop(e) { if (S.pop && !S.pop.contains(e.target)) closePopover(); }
function closePopover() { if (S.pop) { S.pop.remove(); S.pop = null; } document.removeEventListener('mousedown', outsidePop); }

function lightbox(src, caption) {
  const lb = h('div', { class: 'lightbox', onclick: () => lb.remove() },
    h('img', { src, alt: caption || '' }),
    h('div', { class: 'lb-bar' }, h('a', { href: src, download: '', onclick: (e) => e.stopPropagation() }, '저장'), h('button', null, '닫기')));
  document.body.append(lb);
}

// ============================================================
// 전역 이벤트
// ============================================================
function bindGlobal() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.code-btn');
    if (btn) {
      const block = btn.closest('.code-block');
      const code = $('code', block);
      if (btn.dataset.act === 'copy') copyText(code.textContent);
      else if (btn.dataset.act === 'preview') openPanel(code.textContent, code.dataset.lang);
      return;
    }
    const img = e.target.closest('.md img, .skill-doc img');
    if (img) lightbox(img.src);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('.lightbox')) { $('.lightbox').remove(); return; }
      if (S.pop) { closePopover(); return; }
      if (S.modals.length) { S.modals[S.modals.length - 1](); return; }
      if (!$('#panel').hidden) { $('#panel').hidden = true; return; }
      if (busy()) stopRun();
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if ($('#app').classList.contains('collapsed')) toggleSidebar();
      $('#sb-search')?.focus();
    }
  });
  // 창 전체 드래그 앤 드롭
  document.addEventListener('dragover', (e) => { if (S.route.view === 'chat') e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (S.route.view !== 'chat' || e.target.closest('#composer')) return;
    e.preventDefault();
    if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
  });
}

init();
