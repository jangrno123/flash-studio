'use strict';
/* global S, h, $, api, toast, icon, iconBtn, modal, confirmDialog, inputDialog, popover, closePopover, menuItem, main, topbar, go, field, renderMain, renderSidebar, refreshConvs, newChat, patchConv, deleteConv, busy */
// 프로젝트 · 보관함 · 루틴 화면 (CONTEXT.md §10). app.js 의 공용 헬퍼를 쓴다.

const PROJECT_COLORS = ['#c96442', '#3b7dd8', '#2f9e6e', '#9b59b6', '#d9a13b', '#d9573b', '#5c6b7a', '#1f9aa8'];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const projectById = (id) => (id ? (S.projects || []).find((p) => p.id === id) || null : null);
const projectDot = (p, size = 9) => h('span', { class: 'proj-dot', style: { background: p.color, width: `${size}px`, height: `${size}px` } });

async function refreshProjects() {
  try { S.projects = await api('GET', '/api/projects'); } catch { /* 무시 */ }
}

// ============================================================
// 프로젝트 목록
// ============================================================
function renderProjects() {
  const q = h('input', { type: 'search', placeholder: '프로젝트 검색' });
  const grid = h('div', { class: 'cards' });
  const showArchived = h('input', { type: 'checkbox' });
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const list = (S.projects || []).filter((p) => (showArchived.checked || !p.archived) && (!s || `${p.name} ${p.description}`.toLowerCase().includes(s)));
    grid.replaceChildren(...(list.length ? list.map((p) => {
      const convs = S.convs.filter((c) => c.projectId === p.id && !c.archived);
      return h('div', { class: `card${p.archived ? ' dim' : ''}`, onclick: () => go(`#/p/${p.id}`) },
        h('h3', null, projectDot(p, 10), h('span', null, p.name)),
        h('p', null, p.description || (p.instructions ? p.instructions.slice(0, 160) : '지침이 아직 없어요')),
        h('div', { class: 'foot' },
          h('span', { class: 'chip' }, `대화 ${convs.length}`),
          p.skills.length ? h('span', { class: 'chip accent' }, icon('skill'), `스킬 ${p.skills.length}`) : null,
          p.files.length ? h('span', { class: 'chip' }, icon('file'), `파일 ${p.files.length}`) : null,
          p.archived ? h('span', { class: 'chip' }, '보관됨') : null));
    }) : [h('div', { class: 'empty' }, s ? '검색 결과가 없어요' : '프로젝트가 없어요. 작업 단위로 하나 만들어 보세요.')]));
  };
  q.addEventListener('input', draw);
  showArchived.addEventListener('change', draw);
  draw();
  main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h2', null, '프로젝트'), h('button', { class: 'btn primary', onclick: () => editProject(null) }, icon('plus'), '새 프로젝트')),
    h('p', { class: 'page-desc' }, '대화를 작업별로 묶어 두는 곳이에요. 프로젝트 지침과 기본 스킬은 그 안의 모든 대화에 자동으로 들어가요.'),
    h('div', { class: 'toolbar' }, q, h('label', { class: 'check-sm' }, showArchived, '보관된 프로젝트도 보기')), grid)));
}

function editProject(p) {
  const name = h('input', { type: 'text', value: p ? p.name : '', placeholder: '예: 웹툰 예고편 60초' });
  const desc = h('input', { type: 'text', value: p ? p.description : '', placeholder: '무슨 작업인지 한 줄로' });
  let color = p ? p.color : PROJECT_COLORS[(S.projects || []).length % PROJECT_COLORS.length];
  const swatches = h('div', { class: 'swatches' });
  const drawSw = () => swatches.replaceChildren(...PROJECT_COLORS.map((c) => h('button', { class: `swatch${c === color ? ' on' : ''}`, style: { background: c }, title: c, onclick: () => { color = c; drawSw(); } })));
  drawSw();
  const md = modal({
    title: p ? '프로젝트 편집' : '새 프로젝트',
    body: [field('이름', name), field('설명', desc), field('색', swatches)],
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) return toast('이름을 적어 주세요');
        try {
          const body = { name: name.value.trim(), description: desc.value.trim(), color };
          const r = p ? await api('PATCH', `/api/projects/${p.id}`, body) : await api('POST', '/api/projects', body);
          md.close();
          await refreshProjects();
          renderSidebar();
          if (p) renderMain(); else go(`#/p/${r.id}`);
        } catch (e) { toast(e.message, 'error'); }
      } }, p ? '저장' : '만들기')]
  });
  setTimeout(() => name.focus(), 20);
}

// ============================================================
// 프로젝트 상세
// ============================================================
function renderProject(id) {
  const p = projectById(id);
  if (!p) { main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner' }, h('div', { class: 'empty' }, '프로젝트를 찾을 수 없어요')))); return; }
  const save = async (patch, msg) => {
    try {
      Object.assign(p, await api('PATCH', `/api/projects/${p.id}`, patch));
      if (msg) toast(msg);
    } catch (e) { toast(e.message, 'error'); }
  };

  // 지침
  const instr = h('textarea', { class: 'input', rows: 9, value: p.instructions, placeholder: '예: 결과물은 16:9 2K로 만든다. 캐릭터 이름은 원작 표기를 그대로 쓴다. 보고는 짧게.' });
  const counter = h('span', { class: 'muted' });
  const count = () => { counter.textContent = `${instr.value.length.toLocaleString()} / 20,000자`; };
  instr.addEventListener('input', count);
  count();

  // 스킬
  const skillBox = h('div', { class: 'chip-row' });
  const drawSkills = () => skillBox.replaceChildren(...p.skills.map((n) => h('span', { class: 'chip accent' }, icon('skill'), n,
    h('button', { title: '빼기', onclick: () => { save({ skills: p.skills.filter((x) => x !== n) }).then(drawSkills); } }, icon('x')))),
  h('button', { class: 'btn sm', onclick: (e) => {
    const avail = S.skills.filter((s) => !p.skills.includes(s.name));
    if (!avail.length) return toast('더 넣을 스킬이 없어요');
    popover(e.currentTarget, h('div', { class: 'menu-scroll' }, ...avail.map((s) => menuItem('skill', s.name, () => { save({ skills: [...p.skills, s.name] }).then(drawSkills); }))));
  } }, icon('plus'), '스킬 추가'));
  drawSkills();

  // 참고 파일
  const fileBox = h('div', { class: 'file-rows' });
  const drawFiles = () => {
    const label = h('input', { type: 'text', placeholder: '이름 (선택)' });
    const ref = h('input', { type: 'text', class: 'mono', placeholder: '경로 또는 URL (예: D:\\FlashStudio\\data\\workspace\\설정집.md)' });
    fileBox.replaceChildren(
      ...p.files.map((f, i) => h('div', { class: 'file-row' }, icon('file'), h('span', { class: 'lbl' }, f.label || '—'), h('code', null, f.ref),
        iconBtn('x', () => { const next = p.files.slice(); next.splice(i, 1); save({ files: next }).then(drawFiles); }, '빼기'))),
      h('div', { class: 'file-add' }, label, ref, h('button', { class: 'btn sm', onclick: () => {
        if (!ref.value.trim()) return toast('경로를 적어 주세요');
        save({ files: [...p.files, { label: label.value.trim(), ref: ref.value.trim() }] }).then(drawFiles);
      } }, '추가')));
  };
  drawFiles();

  // 대화
  const convs = S.convs.filter((c) => c.projectId === p.id);
  const live = convs.filter((c) => !c.archived);
  const archived = convs.filter((c) => c.archived);
  const old = live.filter((c) => !c.pinned && Date.now() - Date.parse(c.updatedAt) > 30 * 86400000);
  const convRow = (c) => h('div', { class: 'conv-row', onclick: () => go(`#/c/${c.id}`) },
    icon(c.routineId ? 'refresh' : 'chat'), h('span', { class: 't' }, c.title), h('span', { class: 'muted' }, fmtWhen(c.updatedAt)),
    iconBtn('more', (e) => { e.stopPropagation(); convMoreMenu(e.currentTarget, c); }, '더보기'));

  // 루틴
  const routines = (S.routines || []).filter((r) => r.projectId === p.id);

  main().replaceChildren(topbar(h('button', { class: 'title-btn', onclick: () => go('#/projects') }, '프로젝트'), h('span', { class: 'muted' }, '/'), h('span', { class: 'title-btn' }, p.name)),
    h('div', { class: 'page' }, h('div', { class: 'page-inner' },
      h('div', { class: 'page-head' }, projectDot(p, 14), h('h2', null, p.name),
        h('button', { class: 'btn primary', onclick: () => newChat(null, p.id) }, icon('plus'), '이 프로젝트에서 새 채팅'),
        iconBtn('more', (e) => popover(e.currentTarget, [
          menuItem('edit', '이름·설명·색 바꾸기', () => editProject(p)),
          menuItem('folder', p.archived ? '프로젝트 보관 해제' : '프로젝트 보관', async () => { await save({ archived: !p.archived }); renderSidebar(); renderMain(); }),
          h('div', { class: 'menu-sep' }),
          menuItem('trash', '프로젝트 삭제', () => removeProject(p), 'danger')], { align: 'right' }), '프로젝트 메뉴')),
      p.description ? h('p', { class: 'page-desc' }, p.description) : null,

      h('section', { class: 'proj-sec' },
        h('div', { class: 'sec-head' }, h('h4', null, '프로젝트 지침'), counter,
          h('button', { class: 'btn sm primary', onclick: () => save({ instructions: instr.value }, '지침을 저장했어요') }, '저장')),
        h('p', { class: 'help' }, '이 프로젝트의 모든 대화에 들어가요. 매 요청마다 실리니 꼭 필요한 규칙만 짧게 적어 주세요. 긴 자료는 아래 참고 파일로 두면 필요할 때만 읽어요.'),
        instr),

      h('section', { class: 'proj-sec' },
        h('div', { class: 'sec-head' }, h('h4', null, '기본 스킬')),
        h('p', { class: 'help' }, '이 프로젝트 대화에서 항상 켜 둘 스킬이에요.'),
        skillBox),

      h('section', { class: 'proj-sec' },
        h('div', { class: 'sec-head' }, h('h4', null, '참고 파일')),
        h('p', { class: 'help' }, '모델에게는 경로 목록만 가고, 내용은 필요할 때 읽어요. 설정집·기획서·규칙 문서를 여기 두세요.'),
        fileBox),

      h('section', { class: 'proj-sec' },
        h('div', { class: 'sec-head' }, h('h4', null, `대화 ${live.length}`),
          old.length ? h('button', { class: 'btn sm', onclick: async () => {
            if (!(await confirmDialog('오래된 대화 보관', `30일 넘게 쓰지 않은 대화 ${old.length}개를 보관함으로 옮길까요?`, '보관'))) return;
            try { await api('POST', '/api/conversations/bulk', { ids: old.map((c) => c.id), archived: true }); await refreshConvs(); renderMain(); toast(`${old.length}개를 보관했어요`); } catch (e) { toast(e.message, 'error'); }
          } }, `오래된 대화 ${old.length}개 보관`) : null),
        live.length ? h('div', { class: 'conv-rows' }, ...live.map(convRow)) : h('div', { class: 'empty sm' }, '아직 대화가 없어요'),
        archived.length ? h('details', { class: 'arch-list' }, h('summary', null, `보관된 대화 ${archived.length}개`), h('div', { class: 'conv-rows' }, ...archived.map(convRow))) : null),

      h('section', { class: 'proj-sec' },
        h('div', { class: 'sec-head' }, h('h4', null, `루틴 ${routines.length}`),
          h('button', { class: 'btn sm', onclick: () => editRoutine(null, { projectId: p.id }) }, icon('plus'), '루틴 추가')),
        routines.length ? h('div', { class: 'routine-rows' }, ...routines.map(routineRow)) : h('div', { class: 'empty sm' }, '이 프로젝트에 예약된 루틴이 없어요')))));
  if (!S.routines) loadRoutines().then(() => { if (S.route.view === 'project') renderMain(); });
}

async function removeProject(p) {
  if (!(await confirmDialog('프로젝트 삭제', `"${p.name}" 프로젝트를 삭제할까요? 대화는 지우지 않고 프로젝트에서만 빠져요.`, '삭제', true))) return;
  try {
    await api('DELETE', `/api/projects/${p.id}`);
    await Promise.all([refreshProjects(), refreshConvs(), loadRoutines()]);
    go('#/projects');
  } catch (e) { toast(e.message, 'error'); }
}

// 대화 → 프로젝트 이동
function moveToProject(anchor, c) {
  const items = (S.projects || []).filter((p) => !p.archived).map((p) => h('button', { class: 'menu-item', onclick: () => { closePopover(); patchConv(c.id, { projectId: p.id }); } },
    projectDot(p), h('span', { class: 'txt' }, p.name), c.projectId === p.id ? icon('check') : null));
  popover(anchor, [
    h('div', { class: 'menu-head' }, '프로젝트로 옮기기'),
    ...(items.length ? items : [h('div', { class: 'menu-empty' }, '프로젝트가 없어요')]),
    h('div', { class: 'menu-sep' }),
    c.projectId ? menuItem('x', '프로젝트에서 빼기', () => patchConv(c.id, { projectId: null })) : null,
    menuItem('plus', '새 프로젝트 만들기', () => editProject(null))
  ].filter(Boolean), { align: 'right' });
}

async function archiveConv(c, on) {
  await patchConv(c.id, { archived: on });
  toast(on ? '보관함으로 옮겼어요' : '보관을 풀었어요');
  if (on && S.conv && S.conv.id === c.id && S.route.view === 'chat') go('#/');
}

// 사이드바·프로젝트 목록 공용 대화 메뉴
function convMoreMenu(anchor, c) {
  popover(anchor, [
    menuItem('folder', c.projectId ? '다른 프로젝트로 옮기기' : '프로젝트로 옮기기', () => setTimeout(() => moveToProject(anchor, c), 0)),
    menuItem('download', c.archived ? '보관 해제' : '보관하기', () => archiveConv(c, !c.archived)),
    h('div', { class: 'menu-sep' }),
    menuItem('trash', '삭제', () => deleteConv(c), 'danger')
  ], { align: 'right' });
}

// ============================================================
// 보관함
// ============================================================
function renderArchive() {
  const list = S.convs.filter((c) => c.archived);
  const q = h('input', { type: 'search', placeholder: '보관된 대화 검색' });
  const box = h('div', { class: 'conv-rows' });
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const rows = list.filter((c) => !s || c.title.toLowerCase().includes(s));
    box.replaceChildren(...(rows.length ? rows.map((c) => {
      const p = projectById(c.projectId);
      return h('div', { class: 'conv-row', onclick: () => go(`#/c/${c.id}`) },
        icon('chat'), h('span', { class: 't' }, c.title), p ? h('span', { class: 'chip' }, projectDot(p), p.name) : null,
        h('span', { class: 'muted' }, fmtWhen(c.updatedAt)),
        h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); archiveConv(c, false).then(renderMain); } }, '복원'),
        iconBtn('trash', (e) => { e.stopPropagation(); deleteConv(c).then(renderMain); }, '삭제'));
    }) : [h('div', { class: 'empty' }, s ? '검색 결과가 없어요' : '보관된 대화가 없어요')]));
  };
  q.addEventListener('input', draw);
  draw();
  main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h2', null, '보관함'),
      list.length ? h('button', { class: 'btn', onclick: async () => {
        if (!(await confirmDialog('모두 복원', `보관된 대화 ${list.length}개를 모두 꺼낼까요?`, '복원'))) return;
        try { await api('POST', '/api/conversations/bulk', { ids: list.map((c) => c.id), archived: false }); await refreshConvs(); renderMain(); } catch (e) { toast(e.message, 'error'); }
      } }, '모두 복원') : null),
    h('p', { class: 'page-desc' }, '끝난 대화를 치워 두는 곳이에요. 보관된 대화는 사이드바와 검색에서 빠지고, 다른 대화의 컨텍스트에도 들어가지 않아요. 열어서 읽거나 이어서 쓸 수는 있어요.'),
    h('div', { class: 'toolbar' }, q), box)));
}

// ============================================================
// 루틴
// ============================================================
async function loadRoutines() {
  try { const r = await api('GET', '/api/routines'); S.routines = r.routines; S.routinesRunning = r.running; } catch { S.routines = S.routines || []; }
}

function scheduleText(s) {
  const t = s.time || '09:00';
  if (s.type === 'daily') return `매일 ${t}`;
  if (s.type === 'weekdays') return `평일 ${t}`;
  if (s.type === 'weekly') return `매주 ${(s.days || []).slice().sort().map((d) => WEEKDAYS[d]).join('·') || '—'} ${t}`;
  if (s.type === 'interval') return s.everyMinutes % 60 === 0 ? `${s.everyMinutes / 60}시간마다` : `${s.everyMinutes}분마다`;
  if (s.type === 'once') return `한 번 · ${fmtWhen(s.at)}`;
  return s.type;
}

const STATUS_TXT = { ok: '성공', error: '실패', running: '실행 중', skipped: '건너뜀', '': '아직 안 돌았음' };

function routineRow(r) {
  const running = r.lastStatus === 'running' || (S.routinesRunning || []).includes(r.id);
  const p = projectById(r.projectId);
  const toggle = h('input', { type: 'checkbox', checked: r.enabled, title: r.enabled ? '켜짐' : '꺼짐', onclick: (e) => e.stopPropagation(), onchange: async (e) => {
    try { Object.assign(r, await api('PATCH', `/api/routines/${r.id}`, { enabled: e.target.checked })); renderMain(); } catch (err) { toast(err.message, 'error'); }
  } });
  return h('div', { class: `routine-row${r.enabled ? '' : ' off'}` },
    h('label', { class: 'switch-sm' }, toggle),
    h('div', { class: 'rt-main', onclick: () => editRoutine(r) },
      h('div', { class: 'rt-name' }, r.name, p ? h('span', { class: 'chip' }, projectDot(p), p.name) : null),
      h('div', { class: 'rt-meta' },
        h('span', null, icon('refresh'), scheduleText(r.schedule)),
        r.enabled && r.nextRunAt ? h('span', null, `다음 ${fmtWhen(r.nextRunAt)}`) : null,
        h('span', { class: `rt-status ${running ? 'running' : r.lastStatus}`, title: r.lastError || '' }, running ? '실행 중…' : `${STATUS_TXT[r.lastStatus] || r.lastStatus}${r.lastRunAt ? ` · ${fmtWhen(r.lastRunAt)}` : ''}`))),
    r.lastConversationId ? h('button', { class: 'btn sm', onclick: () => go(`#/c/${r.lastConversationId}`) }, '결과 보기') : null,
    h('button', { class: 'btn sm', disabled: running, onclick: async () => {
      try { await api('POST', `/api/routines/${r.id}/run`); r.lastStatus = 'running'; toast(`"${r.name}" 실행을 시작했어요`); renderMain(); watchRoutines(); } catch (e) { toast(e.message, 'error'); }
    } }, running ? '실행 중' : '지금 실행'),
    iconBtn('trash', async () => {
      if (!(await confirmDialog('루틴 삭제', `"${r.name}" 루틴을 삭제할까요? 이미 만든 대화는 남아요.`, '삭제', true))) return;
      try { await api('DELETE', `/api/routines/${r.id}`); await loadRoutines(); renderMain(); } catch (e) { toast(e.message, 'error'); }
    }, '삭제'));
}

// 실행 중인 루틴이 있으면 끝날 때까지 가끔 새로 고친다
let routineWatch = null;
function watchRoutines() {
  if (routineWatch) return;
  routineWatch = setInterval(async () => {
    await loadRoutines();
    const any = (S.routines || []).some((r) => r.lastStatus === 'running') || (S.routinesRunning || []).length;
    if (['routines', 'project'].includes(S.route.view) && !S.modals.length) renderMain();
    if (!any) { clearInterval(routineWatch); routineWatch = null; await refreshConvs(); }
  }, 4000);
}

async function renderRoutines() {
  if (!S.routines) await loadRoutines();
  const list = S.routines || [];
  if (list.some((r) => r.lastStatus === 'running')) watchRoutines();
  main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h2', null, '루틴'), h('button', { class: 'btn primary', onclick: () => editRoutine(null) }, icon('plus'), '새 루틴')),
    h('p', { class: 'page-desc' }, '정해 둔 시각에 프롬프트를 알아서 실행해요. 결과는 대화로 남고, 프로젝트를 고르면 그 지침과 스킬로 돌아가요. Flash Studio가 켜져 있어야 실행되고, 꺼져 있던 동안 놓친 실행은 다시 켤 때 한 번 처리해요.'),
    list.length ? h('div', { class: 'routine-rows' }, ...list.map(routineRow)) : h('div', { class: 'empty' }, '루틴이 없어요. 매일 아침 정리나 주간 보고처럼 반복되는 일을 맡겨 보세요.'))));
}

function editRoutine(r, defaults = {}) {
  const v = r ? JSON.parse(JSON.stringify(r)) : { name: '', prompt: '', projectId: null, skills: [], schedule: { type: 'daily', time: '09:00', days: [1], everyMinutes: 60, at: '' }, target: 'new', catchUp: true, enabled: true, ...defaults };
  v.schedule = { time: '09:00', days: [1], everyMinutes: 60, at: '', ...v.schedule };
  const name = h('input', { type: 'text', value: v.name, placeholder: '예: 아침 작업 정리' });
  const prompt = h('textarea', { class: 'input', rows: 7, value: v.prompt, placeholder: '실행할 내용. 예: 어제 만든 이미지 목록을 정리하고 남은 컷을 표로 보여줘.' });
  const proj = h('select', null, h('option', { value: '' }, '프로젝트 없음'), ...(S.projects || []).filter((p) => !p.archived || p.id === v.projectId).map((p) => h('option', { value: p.id, selected: p.id === v.projectId ? true : null }, p.name)));
  if (v.projectId) proj.value = v.projectId;
  const type = h('select', null, ...[['daily', '매일'], ['weekdays', '평일(월~금)'], ['weekly', '매주 요일 지정'], ['interval', '일정 간격'], ['once', '한 번만']].map(([k, l]) => h('option', { value: k }, l)));
  type.value = v.schedule.type;
  const time = h('input', { type: 'time', value: v.schedule.time });
  const days = new Set(v.schedule.days);
  const dayBox = h('div', { class: 'day-picks' }, ...WEEKDAYS.map((d, i) => {
    const b = h('button', { class: `day${days.has(i) ? ' on' : ''}`, onclick: () => { if (days.has(i)) days.delete(i); else days.add(i); b.classList.toggle('on', days.has(i)); } }, d);
    return b;
  }));
  const every = h('input', { type: 'number', min: 5, max: 10080, step: 5, value: v.schedule.everyMinutes });
  const localIso = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const at = h('input', { type: 'datetime-local', value: localIso(v.schedule.at) });
  const target = h('select', null, h('option', { value: 'new' }, '실행할 때마다 새 대화'), h('option', { value: 'same' }, '한 대화에 이어서 쌓기'), h('option', { value: 'queue' }, '작업 대기열에 등록 (순서대로 무인 처리)'));
  target.value = v.target;
  const catchUp = h('input', { type: 'checkbox', checked: v.catchUp });
  const enabled = h('input', { type: 'checkbox', checked: v.enabled });

  const timeF = field('시각', time);
  const daysF = field('요일', dayBox);
  const everyF = field('간격 (분)', every, h('div', { class: 'help' }, '5분 ~ 7일(10080분). 60 = 1시간'));
  const atF = field('실행 시각', at);
  const sync = () => {
    const t = type.value;
    timeF.hidden = !['daily', 'weekdays', 'weekly'].includes(t);
    daysF.hidden = t !== 'weekly';
    everyF.hidden = t !== 'interval';
    atF.hidden = t !== 'once';
  };
  type.addEventListener('change', sync);
  sync();

  const md = modal({
    title: r ? '루틴 편집' : '새 루틴', wide: true,
    body: [
      field('이름', name),
      field('실행할 프롬프트', prompt, h('div', { class: 'help' }, '지켜보는 사람이 없으니, 무엇을 어디까지 할지 분명하게 적어 주세요.')),
      h('div', { class: 'row2' }, field('프로젝트', proj), field('반복', type)),
      h('div', { class: 'row2' }, timeF, everyF, atF),
      daysF,
      h('div', { class: 'row2' }, field('결과를 남길 곳', target, h('div', { class: 'help' }, '이어 쌓으면 길어질수록 자동 정리·핸드오프가 적용돼요.')), h('div')),
      h('label', { class: 'check-sm' }, catchUp, '앱이 꺼져 있어 놓친 실행은 켤 때 한 번 실행'),
      h('label', { class: 'check-sm' }, enabled, '루틴 켜기')
    ],
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) return toast('이름을 적어 주세요');
        if (!prompt.value.trim()) return toast('실행할 프롬프트를 적어 주세요');
        if (type.value === 'weekly' && !days.size) return toast('요일을 하나 이상 골라 주세요');
        if (type.value === 'once' && !at.value) return toast('실행 시각을 골라 주세요');
        const body = {
          name: name.value.trim(), prompt: prompt.value.trim(), projectId: proj.value || null,
          schedule: { type: type.value, time: time.value || '09:00', days: [...days].sort(), everyMinutes: Math.max(5, Number(every.value) || 60), at: at.value ? new Date(at.value).toISOString() : '' },
          target: target.value, catchUp: catchUp.checked, enabled: enabled.checked
        };
        try {
          if (r) await api('PATCH', `/api/routines/${r.id}`, body); else await api('POST', '/api/routines', body);
          md.close();
          await loadRoutines();
          renderMain();
          toast(r ? '루틴을 저장했어요' : '루틴을 만들었어요');
        } catch (e) { toast(e.message, 'error'); }
      } }, r ? '저장' : '만들기')]
  });
  setTimeout(() => (r ? prompt : name).focus(), 20);
}
