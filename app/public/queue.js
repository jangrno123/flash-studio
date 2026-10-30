'use strict';
/* global S, h, $, api, toast, icon, iconBtn, modal, confirmDialog, popover, menuItem, main, topbar, go, field, renderMain, renderSidebar, refreshConvs, projectById, projectDot, fmtWhen */
// 작업 대기열 화면 (CONTEXT.md §13): 여러 작업을 등록하면 순서대로 무인 처리한다.

const Q_STATUS = {
  queued: ['대기', ''], running: ['진행 중', 'run'], paused: ['일시정지', ''], blocked: ['확인 필요', 'warn'],
  done: ['완료', 'ok'], failed: ['실패', 'err'], canceled: ['취소', '']
};

async function loadQueue() {
  try { S.queue = await api('GET', '/api/queue'); } catch { S.queue = S.queue || { settings: {}, jobs: [] }; }
  return S.queue;
}

// 사이드바 배지: 대기+진행 / 확인 필요
function queueBadge() {
  const jobs = (S.queue && S.queue.jobs) || [];
  const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
  const blocked = jobs.filter((j) => j.status === 'blocked' || j.status === 'failed').length;
  return h('span', { class: 'count' }, blocked ? h('span', { class: 'q-alert' }, blocked) : null, pending || '');
}

let queueWatch = null;
function watchQueue() {
  clearInterval(queueWatch);
  queueWatch = setInterval(async () => {
    const before = S.queue && S.queue.version;
    await loadQueue();
    renderSidebar();
    if (S.route.view === 'queue' && !S.modals.length && S.queue.version !== before) renderQueue();
  }, 4000);
}

async function renderQueue() {
  if (!S.queue) await loadQueue();
  watchQueue();
  const { settings, jobs, activeId } = S.queue;
  const counts = {};
  for (const j of jobs) counts[j.status] = (counts[j.status] || 0) + 1;
  const filter = S.queueFilter || 'open';
  const shown = jobs.filter((j) => (filter === 'open' ? !['done', 'canceled'].includes(j.status) : filter === 'all' ? true : j.status === filter))
    .sort((a, b) => order(a) - order(b) || b.priority - a.priority || ((a.sortKey || Date.parse(a.createdAt)) - (b.sortKey || Date.parse(b.createdAt))));

  const toggleRun = h('button', { class: `btn ${settings.running ? '' : 'primary'}`, onclick: async () => {
    try { await api('PATCH', '/api/queue/settings', { running: !settings.running }); await loadQueue(); renderQueue(); } catch (e) { toast(e.message, 'error'); }
  } }, icon(settings.running ? 'stop' : 'right'), settings.running ? '대기열 멈추기' : '대기열 시작');

  const chips = [['open', '진행할 것'], ['blocked', '확인 필요'], ['done', '완료'], ['failed', '실패'], ['all', '전체']].map(([k, l]) =>
    h('button', { class: `chip q-filter${filter === k ? ' on' : ''}`, onclick: () => { S.queueFilter = k; renderQueue(); } }, l, k !== 'open' && k !== 'all' && counts[k] ? ` ${counts[k]}` : ''));

  main().replaceChildren(topbar(), h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h2', null, '작업 대기열'),
      h('button', { class: 'btn', onclick: () => editQueueSettings() }, icon('settings'), '공정 설정'),
      toggleRun,
      h('button', { class: 'btn primary', onclick: () => addJobs() }, icon('plus'), '작업 등록')),
    h('p', { class: 'page-desc' }, '등록한 작업을 순서대로 사람 손 없이 처리해요. 호출 한도에 닿으면 알아서 이어가고, 대화가 무거워지면 인계서를 써서 새 대화로 옮긴 뒤 계속해요. 오류가 나면 간격을 두고 다시 시도해요. 사람이 볼 곳은 "확인 필요"뿐이에요.'),
    h('div', { class: 'q-stats' },
      stat('대기', counts.queued || 0), stat('진행 중', counts.running || 0), stat('확인 필요', (counts.blocked || 0) + (counts.failed || 0), 'warn'), stat('완료', counts.done || 0, 'ok'),
      h('span', { class: `q-state ${settings.running ? 'on' : ''}` }, settings.running ? (activeId ? '처리 중' : '대기 중인 작업을 기다리는 중') : '멈춤', settings.alwaysOn ? ' · 24시간 가동' : '')),
    h('div', { class: 'toolbar' }, ...chips, h('span', { style: { flex: 1 } }),
      counts.done || counts.canceled ? h('button', { class: 'btn sm', onclick: async () => { const r = await api('POST', '/api/queue/clear', {}); toast(`${r.removed}건을 목록에서 지웠어요`); await loadQueue(); renderQueue(); } }, '끝난 작업 지우기') : null),
    shown.length ? h('div', { class: 'q-list' }, ...shown.map((j) => jobRow(j, activeId))) : h('div', { class: 'empty' }, jobs.length ? '해당하는 작업이 없어요' : '아직 등록된 작업이 없어요. "작업 등록"에서 한 건 또는 여러 건을 한꺼번에 넣어 보세요.'))));
}

const order = (j) => ({ running: 0, blocked: 1, failed: 2, queued: 3, paused: 4, done: 5, canceled: 6 }[j.status] ?? 9);
const stat = (label, n, cls = '') => h('div', { class: `q-stat ${cls}` }, h('b', null, n), h('span', null, label));

function jobRow(j, activeId) {
  const [label, cls] = Q_STATUS[j.status] || [j.status, ''];
  const p = projectById(j.projectId);
  const ap = j.approval || {};
  const paid = [ap.images ? '이미지' : '', ap.video ? '영상' : '', ap.other ? '기타' : ''].filter(Boolean);
  const act = (a) => api('POST', `/api/queue/jobs/${j.id}/${a}`).then(async () => { await loadQueue(); renderQueue(); }).catch((e) => toast(e.message, 'error'));
  const cp = (j.checkpoint || '').split('\n').find((l) => l.trim()) || '';
  const move = (to) => api('POST', `/api/queue/jobs/${j.id}/move`, { to }).then(async () => { await loadQueue(); renderQueue(); }).catch((e) => toast(e.message, 'error'));
  return h('div', { class: `q-row ${j.status}` },
    h('span', { class: `q-badge ${cls}` }, j.status === 'running' ? h('span', { class: 'spin' }) : null, label),
    h('div', { class: 'q-main', onclick: () => jobDetail(j) },
      h('div', { class: 'q-title' }, j.title, p ? h('span', { class: 'chip' }, projectDot(p), p.name) : null, j.source !== 'user' ? h('span', { class: 'chip' }, j.source === 'model' ? '모델 등록' : '루틴') : null),
      h('div', { class: 'q-meta' },
        h('span', null, paid.length ? `유료 승인: ${paid.join('·')}${ap.maxPaidCalls != null ? ` (${j.paidCalls}/${ap.maxPaidCalls})` : ` (${j.paidCalls}회 사용)`}` : '유료 미승인'),
        j.continues ? h('span', null, `이어가기 ${j.continues}`) : null,
        j.handoffs ? h('span', null, `인계 ${j.handoffs}`) : null,
        j.attempts ? h('span', null, `재시도 ${j.attempts}`) : null,
        j.dependsOn.length ? h('span', null, '앞 작업 뒤') : null,
        (j.attachments || []).length ? h('span', null, `첨부 ${j.attachments.length}`) : null,
        j.sourceConversationId ? h('a', { href: `#/c/${j.sourceConversationId}`, onclick: e => e.stopPropagation() }, '등록한 대화') : null,
        j.source === 'model' && S.queue.settings.allowModelRegistration !== true && j.status === 'queued' ? h('span', null, '자동 실행 허용 필요') : null,
        j.editNote ? h('span', { class: 'q-pending' }, '수정 내용 전달 대기') : null,
        h('span', null, fmtWhen(j.updatedAt))),
      j.status === 'blocked' && j.blockedReason ? h('div', { class: 'q-reason' }, j.blockedReason) : null,
      j.status === 'failed' && j.lastError ? h('div', { class: 'q-reason' }, j.lastError.slice(0, 200)) : null,
      cp && !['blocked', 'failed'].includes(j.status) ? h('div', { class: 'q-cp' }, cp.slice(0, 160)) : null),
    !['done', 'canceled'].includes(j.status) ? h('button', { class: 'btn sm', onclick: () => editJob(j) }, '수정') : null,
    j.conversationId ? h('button', { class: 'btn sm', onclick: () => go(`#/c/${j.conversationId}`) }, '대화') : null,
    ['queued', 'running'].includes(j.status) ? h('button', { class: 'btn sm', onclick: () => act('pause') }, '일시정지') : null,
    ['paused', 'blocked', 'failed', 'canceled'].includes(j.status) ? h('button', { class: 'btn sm primary', onclick: () => act('retry') }, j.status === 'paused' ? '재개' : '다시 시도') : null,
    iconBtn('more', (e) => popover(e.currentTarget, [
      menuItem('edit', '수정', () => editJob(j)),
      ...(j.status === 'queued' ? [menuItem('up', '맨 앞으로', () => move('top')), menuItem('up', '한 칸 앞으로', () => move('up')), menuItem('arrowDown', '한 칸 뒤로', () => move('down')), menuItem('arrowDown', '맨 뒤로', () => move('bottom')), h('div', { class: 'menu-sep' })] : []),
      j.conversationId ? menuItem('refresh', '처음부터 다시 (새 대화에서)', async () => { if (await confirmDialog('처음부터 다시', '지금까지의 진행(체크포인트)을 버리고 새 대화에서 처음부터 다시 시작할까요? 예전 대화는 기록으로 남아요.', '다시 시작')) act('restart'); }) : null,
      ['queued', 'running', 'paused', 'blocked', 'failed'].includes(j.status) ? menuItem('x', '취소', () => act('cancel')) : null,
      j.id !== activeId ? menuItem('trash', '삭제', async () => {
        if (!(await confirmDialog('작업 삭제', `"${j.title}" 작업을 목록에서 지울까요? 만든 대화는 남아요.`, '삭제', true))) return;
        try { await api('DELETE', `/api/queue/jobs/${j.id}`); await loadQueue(); renderQueue(); } catch (err) { toast(err.message, 'error'); }
      }, 'danger') : null].filter(Boolean), { align: 'right' }), '더보기'));
}

function jobDetail(j) {
  modal({
    title: j.title, wide: true,
    body: h('div', { class: 'q-detail' },
      h('h5', null, '작업 내용'), h('pre', null, j.prompt),
      (j.attachments || []).length ? [h('h5', null, `첨부 ${j.attachments.length}`), h('div', { class: 'q-thumbs' }, ...j.attachments.map((a) => (a.kind === 'image' ? h('img', { src: a.url, title: a.name, onclick: () => lightbox(a.url, a.name) }) : h('span', { class: 'chip' }, icon('file'), a.name))))] : null,
      j.checkpoint ? [h('h5', null, '체크포인트 (재개 지점)'), h('pre', null, j.checkpoint)] : null,
      j.blockedReason ? [h('h5', null, '확인이 필요한 이유'), h('pre', null, j.blockedReason)] : null,
      j.lastError ? [h('h5', null, '마지막 오류'), h('pre', null, j.lastError)] : null,
      j.result ? [h('h5', null, '결과'), h('div', { class: 'md', html: Markdown.render(j.result) })] : null,
      j.conversations.length ? [h('h5', null, `대화 ${j.conversations.length}개 (인계로 이어짐)`), h('div', { class: 'chip-row' }, ...j.conversations.map((id, i) => h('button', { class: 'chip', onclick: () => { S.modals.at(-1)(); go(`#/c/${id}`); } }, `${i + 1}번째`)))] : null)
  });
}

// 승인 입력 묶음 (등록·편집 공용)
function approvalFields(ap = {}) {
  const images = h('input', { type: 'checkbox', checked: !!ap.images });
  const video = h('input', { type: 'checkbox', checked: !!ap.video });
  const other = h('input', { type: 'checkbox', checked: !!ap.other });
  const max = h('input', { type: 'number', min: 0, placeholder: '제한 없음', value: ap.maxPaidCalls ?? '' });
  const note = h('input', { type: 'text', placeholder: '예: 영상 $5 이내, 컷당 30초 이하', value: ap.budgetNote || '' });
  const el = h('div', { class: 'q-approval' },
    h('div', { class: 'help' }, '여기서 허용한 유료 작업만 실행돼요. 실행 중에는 묻지 않고, 허용하지 않은 유료 작업은 막히고 "확인 필요"로 넘어와요.'),
    h('div', { class: 'chip-row' }, h('label', { class: 'check-sm' }, images, '이미지 생성'), h('label', { class: 'check-sm' }, video, '영상 렌더'), h('label', { class: 'check-sm' }, other, '기타 유료 생성(음성·음악 등)')),
    h('div', { class: 'row2' }, field('작업당 유료 호출 최대 횟수', max), field('예산 메모 (모델에게 전달)', note)));
  const value = () => ({ images: images.checked, video: video.checked, other: other.checked, maxPaidCalls: max.value === '' ? null : Math.max(0, Number(max.value)), budgetNote: note.value.trim() });
  const set = (a = {}) => { images.checked = !!a.images; video.checked = !!a.video; other.checked = !!a.other; if (a.maxPaidCalls !== undefined) max.value = a.maxPaidCalls ?? ''; if (a.budgetNote !== undefined) note.value = a.budgetNote || ''; };
  return { el, value, set };
}

// ---------------- 작업 프리셋 ----------------
// 기본 프리셋 "웹툰 → 애니메이션": 칸을 고르면 작업 지시서가 만들어진다. 사용자 프리셋은 서버(queue.json)에 저장
const WT_LAYOUTS = [['auto', '자동 판정'], ['vertical', '세로 스크롤 웹툰 (위→아래로 길게)'], ['columns', '격자형 인스타툰 (같은 크기 칸이 가로로 N개씩)'], ['grid', '출판 만화 페이지 (칸 모양이 제각각)']];
const WT_RANGES = [['cut', '컷 분리 + 대본 시트까지 (무료)'], ['convert', '16:9 변환까지 (이미지 유료)'], ['wire', '캔버스 업로드·영상 노드 연결까지 (렌더 제외)'], ['render', '영상 렌더까지 (영상 유료)']];
const WT_DEFAULT = { work: '', canvasUnit: 'image', layout: 'auto', cols: 3, rtl: false, perImage: '', continuous: true, range: 'wire', projectId: '', focus: '', extra: '' };

function webtoonPrompt(f) {
  const dir = f.rtl ? '오른쪽→왼쪽' : '왼쪽→오른쪽';
  const layoutLine = {
    auto: '구조: 자동 판정 — crop_panels 가 알려주는 구조 판정을 먼저 확인하고, 원본과 맞지 않으면 보고한다.',
    vertical: '구조: 세로 스크롤 웹툰 — 위에서 아래로 읽는다.',
    columns: `구조: 격자형 ${f.cols}열 — 같은 크기 칸이 가로로 ${f.cols}개씩 놓여 있고, ${dir}·위→아래 순서로 읽는다.`,
    grid: `구조: 출판 만화 페이지 — 칸 모양이 제각각이고 ${dir}으로 읽는다.`
  }[f.layout];
  const exp = f.perImage ? `, expected=${f.perImage}` : '';
  const rangeLine = {
    cut: '범위: 2-1 ~ 2-4 (컷 분리·문맥 확보·대본 시트). 유료 작업은 하지 않는다.',
    convert: '범위: 2-1 ~ 2-5 (16:9 변환까지). 캔버스 작업과 영상 렌더는 하지 않는다.',
    wire: '범위: 2-1 ~ 2-9 (캔버스 업로드·연출 프롬프트·네거티브·영상 노드 연결·검증까지). 영상 렌더는 하지 않는다.',
    render: '범위: 2-1 ~ 2-10 (영상 렌더까지). 렌더 완료는 poll_until 로 한 번에 기다린다.'
  }[f.range];
  return [
    '[작업 지시서 · 웹툰 → 애니메이션]',
    '스킬: webtoon-animation-bao 를 불러와 그 공정과 절대 규칙을 따른다.',
    '원본: 첨부한 {{이미지}} ({{번호}}번째 원본)',
    layoutLine,
    `컷 분리: crop_panels(mode="${f.layout}"${exp}, keep_text_boxes=true${f.rtl ? ', rtl=true' : ''}). ${f.perImage ? `결과가 ${f.perImage}컷이 아니면` : '결과가 원본 구조와 다르면'} edit_image 로 좌표를 추측해 자르지 말고, mode 를 바꿔 한 번 더 시도한 뒤에도 다르면 [JOB_BLOCKED: 컷 분리 불일치 — 기대 ${f.perImage || '?'}, 결과 N] 을 쓴다.`,
    f.continuous ? '흐름: 원본끼리 이야기가 이어진다. 앞 원본 작업의 대본 시트와 체크포인트를 참고해 문맥을 잇는다.' : '흐름: 원본마다 독립된 이야기다.',
    '16:9 변환: convert_panels 로 변환하고 원본과 대조해 검수한다 (말풍선·글자 제거, 좌우 확장, 불합격이면 자동 재생성). 불합격으로 남은 컷은 업로드·연결에 쓰지 않고 모아서 보고한다.',
    f.focus ? `에셋 고정: ${f.focus} — 모든 컷에서 이 모습이 흔들리지 않게 검수 focus 로 넘긴다.` : '',
    rangeLine,
    ...(['wire', 'render'].includes(f.range) ? [
      `BAO 프로젝트: 작품명 "${f.work || '(작품명 미입력)'}" — 제목이 같은 프로젝트를 쓰고, 없으면 새로 만든다. 다른 작품의 프로젝트를 쓰거나 기존 프로젝트 이름을 바꾸지 않는다. 만들 수 없으면 [JOB_BLOCKED: 프로젝트 생성 실패].${f.projectId ? ` (지정 project_id: ${f.projectId} — 제목이 작품명과 다르면 멈춘다)` : ''}`,
      f.canvasUnit === 'single'
        ? `BAO 캔버스: "${f.work || '작품명'}" 캔버스 하나에 모든 원본을 모은다. 같은 이름이 있으면 이어 쓴다.`
        : `BAO 캔버스: "${f.work || '작품명'} {{번호}}" — 이 원본 전용 캔버스. 같은 이름이 있으면 이어 쓰고, 없으면 만든다. 다른 원본의 캔버스에 넣지 않는다.`
    ] : []),
    f.extra ? `추가 지시: ${f.extra}` : '',
    '완료 기준: 범위 안의 단계를 끝내고 스킬 8장 검증 체크리스트를 통과하면 [JOB_DONE].'
  ].filter(Boolean).join('\n');
}

// 웹툰 프리셋 입력 칸. onChange(form) 로 바뀐 값을 알린다
function webtoonForm(initial, onChange) {
  const f = { ...WT_DEFAULT, ...(initial || {}) };
  const sel = (key, opts) => { const el = h('select', null, ...opts.map(([v, l]) => h('option', { value: v }, l))); el.value = String(f[key]); el.addEventListener('change', () => { f[key] = el.value; sync(); }); return el; };
  const layout = sel('layout', WT_LAYOUTS);
  const cols = sel('cols', [['2', '2열'], ['3', '3열'], ['4', '4열'], ['5', '5열']]);
  const dir = h('select', null, h('option', { value: 'ltr' }, '왼쪽 → 오른쪽 (한국·서양)'), h('option', { value: 'rtl' }, '오른쪽 → 왼쪽 (일본 만화)'));
  dir.value = f.rtl ? 'rtl' : 'ltr';
  dir.addEventListener('change', () => { f.rtl = dir.value === 'rtl'; sync(); });
  const per = h('input', { type: 'number', min: 1, max: 200, placeholder: '모르면 비워 두기', value: f.perImage });
  per.addEventListener('input', () => { f.perImage = per.value; sync(); });
  const cont = h('input', { type: 'checkbox', checked: f.continuous });
  cont.addEventListener('change', () => { f.continuous = cont.checked; sync(); });
  const range = sel('range', WT_RANGES);
  const work = h('input', { type: 'text', placeholder: '예: 밈고사성어 — BAO 프로젝트 이름이 돼요', value: f.work });
  work.addEventListener('input', () => { f.work = work.value.trim(); sync(); });
  const unit = sel('canvasUnit', [['image', '원본 이미지마다 캔버스 하나 (권장)'], ['single', '작품 전체를 캔버스 하나에']]);
  const pid = h('input', { type: 'text', class: 'mono', placeholder: '비우면 작품명으로 찾거나 새로 만들어요', value: f.projectId });
  pid.addEventListener('input', () => { f.projectId = pid.value.trim(); sync(); });
  const focus = h('input', { type: 'text', placeholder: '예: 이성계 흰 수염·검은 갓·푸른 곤룡포, 이방원 남색 옷', value: f.focus });
  focus.addEventListener('input', () => { f.focus = focus.value.trim(); sync(); });
  const extra = h('textarea', { class: 'input', rows: 2, placeholder: '예: 이번 웹툰은 코믹 톤. 효과음은 SFX 로 살린다.', value: f.extra });
  extra.addEventListener('input', () => { f.extra = extra.value.trim(); sync(); });
  const colsField = field('열 수', cols);
  const dirField = field('읽는 방향', dir);
  function sync() {
    colsField.hidden = f.layout !== 'columns';
    dirField.hidden = f.layout === 'vertical';
    onChange({ ...f });
  }
  const el = h('div', { class: 'q-preset-form' },
    h('div', { class: 'row2' }, field('웹툰 구조', layout, h('div', { class: 'help' }, '인스타툰처럼 칸이 가로로 나란하면 "격자형", 세로로 길게 내려가면 "세로 스크롤"')), colsField),
    h('div', { class: 'row2' }, dirField, field('이미지당 컷 수', per, h('div', { class: 'help' }, '적어 두면 자른 결과와 비교해 다르면 멈춰요'))),
    h('label', { class: 'check-sm' }, cont, '원본끼리 이야기가 이어짐 (순서대로 처리하고 앞 작업의 대본을 참고)'),
    field('작업 범위', range),
    h('div', { class: 'row2' }, field('작품명 (BAO 프로젝트)', work, h('div', { class: 'help' }, '같은 이름의 프로젝트를 쓰고, 없으면 새로 만들어요. 다른 작품 프로젝트는 쓰지 않아요')), field('캔버스 단위', unit)),
    field('BAO project_id (선택)', pid),
    field('고정할 에셋 (검수 기준)', focus, h('div', { class: 'help' }, '16:9 변환 검수 때 특히 지켜야 할 인물·옷·소품. 컷마다 흔들리지 않게 해요')),
    field('추가 지시', extra));
  setTimeout(sync, 0);
  return { el, value: () => ({ ...f }) };
}

function addJobs() {
  let mode = 'many';
  const title = h('input', { type: 'text', placeholder: '예: P02 {{컷}} 영상 준비' });
  const prompt = h('textarea', { class: 'input', rows: 8, placeholder: '작업 내용. {{변수}} 자리에 아래 목록 값이 들어가요.\n예: webtoon-animation-bao 스킬대로 P02 원본에서 {{컷}}을 처리한다. 범위: 2-1~2-9단계. 산출물: 캔버스 노드 5개 연결. 완료 기준: 검증 체크리스트 통과.' });
  const rows = h('textarea', { class: 'input mono', rows: 6, placeholder: '한 줄에 작업 하나.\n변수가 여럿이면 첫 줄에 이름을 | 로 적어요.\n\n컷|범위\ncut01|원본 0~1200px\ncut02|원본 1200~2600px' });
  const proj = h('select', null, h('option', { value: '' }, '프로젝트 없음'), ...(S.projects || []).filter((p) => !p.archived).map((p) => h('option', { value: p.id }, p.name)));
  if (S.route.view === 'project' && S.route.id) proj.value = S.route.id;
  const skills = h('input', { type: 'text', placeholder: '쉼표로 구분 (예: webtoon-animation-bao)' });
  const priority = h('input', { type: 'number', value: 0, min: -100, max: 100 });
  const sequential = h('input', { type: 'checkbox' });
  const ap = approvalFields({});
  const preview = h('div', { class: 'help' });

  // ---- 프리셋 ----
  let promptDirty = false; // 지시서를 손으로 고쳤으면 칸을 바꿔도 덮어쓰지 않는다
  prompt.addEventListener('input', () => { if (presetSel.value === 'builtin:webtoon') { promptDirty = true; regen.hidden = false; } });
  let wt = null;
  const wtBox = h('div');
  const regen = h('button', { class: 'btn sm', hidden: true, onclick: () => { promptDirty = false; regen.hidden = true; if (wt) applyWebtoon(wt.value()); } }, '지시서 다시 만들기');
  const applyWebtoon = (form) => {
    if (!promptDirty) prompt.value = webtoonPrompt(form);
    skills.value = 'webtoon-animation-bao';
    const cur = ap.value();
    ap.set({ ...cur, images: ['convert', 'wire', 'render'].includes(form.range), video: form.range === 'render' });
    sequential.checked = !!form.continuous;
    if (!title.value.trim()) title.value = '{{번호}} {{이미지}}';
    updatePreview();
  };
  const presetSel = h('select');
  const drawPresets = () => {
    const mine = (S.queue && S.queue.presets) || [];
    presetSel.replaceChildren(h('option', { value: '' }, '빈 작업 (직접 작성)'), h('option', { value: 'builtin:webtoon' }, '웹툰 → 애니메이션 (BAO)'),
      ...(mine.length ? [h('optgroup', { label: '내 프리셋' }, ...mine.map((p) => h('option', { value: `p:${p.id}` }, p.name)))] : []));
  };
  drawPresets();
  const delPreset = h('button', { class: 'btn sm', hidden: true, onclick: async () => {
    const id = presetSel.value.slice(2);
    const p = S.queue.presets.find((x) => x.id === id);
    if (!p || !(await confirmDialog('프리셋 삭제', `"${p.name}" 프리셋을 지울까요?`, '삭제', true))) return;
    await api('DELETE', `/api/queue/presets/${id}`); await loadQueue(); drawPresets(); presetSel.value = ''; presetSel.dispatchEvent(new Event('change'));
  } }, '삭제');
  presetSel.addEventListener('change', () => {
    const v = presetSel.value;
    delPreset.hidden = !v.startsWith('p:');
    promptDirty = false; regen.hidden = true;
    let form = null;
    if (v === 'builtin:webtoon') form = { ...WT_DEFAULT };
    else if (v.startsWith('p:')) {
      const p = S.queue.presets.find((x) => x.id === v.slice(2));
      if (!p) return;
      title.value = p.title || ''; skills.value = (p.skills || []).join(', '); proj.value = p.projectId || '';
      priority.value = p.priority || 0; sequential.checked = !!p.sequential; ap.set(p.approval || {});
      if (p.kind === 'webtoon') form = { ...WT_DEFAULT, ...p.form };
      else { prompt.value = p.prompt || ''; }
      if (p.kind === 'webtoon' && p.prompt && p.prompt !== webtoonPrompt(form)) { prompt.value = p.prompt; promptDirty = true; regen.hidden = false; }
    }
    if (form) {
      wt = webtoonForm(form, (fv) => applyWebtoon(fv));
      wtBox.replaceChildren(h('h4', null, '웹툰 구조와 작업 범위'), wt.el, h('div', { class: 'help' }, '칸을 고르면 아래 작업 내용(지시서)이 자동으로 써져요. 지시서를 직접 고쳐도 돼요.'));
    } else { wt = null; wtBox.replaceChildren(); }
  });
  const savePreset = h('button', { class: 'btn', onclick: async () => {
    const name = await inputDialog('프리셋 이름', presetSel.value.startsWith('p:') ? (S.queue.presets.find((x) => x.id === presetSel.value.slice(2)) || {}).name : '');
    if (!name || !name.trim()) return;
    try {
      const body = { name: name.trim(), kind: wt ? 'webtoon' : 'custom', form: wt ? wt.value() : {}, title: title.value, prompt: prompt.value, skills: skills.value.split(',').map((x) => x.trim()).filter(Boolean), projectId: proj.value || null, approval: ap.value(), priority: Number(priority.value) || 0, sequential: sequential.checked };
      const p = await api('POST', '/api/queue/presets', body);
      await loadQueue(); drawPresets(); presetSel.value = `p:${p.id}`; delPreset.hidden = false;
      toast(`"${p.name}" 프리셋을 저장했어요`);
    } catch (e) { toast(e.message, 'error'); }
  } }, '프리셋으로 저장');

  // ---- 첨부 (웹툰 원본 등): 여러 건 모드에서는 파일 1개 = 작업 1건, 목록 순서대로 ----
  const box = attachBox([], (added) => {
    if (added) { sequential.checked = true; if (!title.value.trim()) title.value = '{{번호}} {{이미지}}'; }
    updatePreview();
  });
  const files = box.files;

  const parseRows = () => {
    const lines = rows.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // 목록 없이 파일만 있으면 파일마다 한 줄
    if (!lines.length && files.length) return files.map((f, i) => ({ 이미지: f.name, 번호: String(i + 1).padStart(2, '0'), item: f.name }));
    if (!lines.length) return [];
    const vars = [...new Set([...(title.value + prompt.value).matchAll(/\{\{\s*([^}:]+?)\s*(?::[^}]*)?\}\}/g)].map((m) => m[1]))];
    let header = null;
    if (lines[0].includes('|') && lines[0].split('|').every((c) => vars.includes(c.trim()))) header = lines.shift().split('|').map((c) => c.trim());
    return lines.map((l) => {
      const cells = l.split('|').map((c) => c.trim());
      const row = {};
      (header || [vars[0] || 'item']).forEach((k, i) => { row[k] = cells[i] ?? ''; });
      if (!header) row.item = l;
      return row;
    });
  };
  function updatePreview() {
    if (mode !== 'many') { preview.textContent = files.length ? `파일 ${files.length}개를 이 작업 하나에 붙여요.` : ''; return; }
    const n = parseRows().length;
    const lines = rows.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
    preview.textContent = files.length
      ? `파일 ${files.length}개 → 작업 ${n}건${lines && n !== files.length ? ` ⚠️ 목록 ${n}줄과 파일 수가 달라요 (줄마다 같은 순서의 파일이 붙어요)` : ''}. 제목·내용에 {{번호}} {{이미지}}를 쓸 수 있어요.`
      : n ? `작업 ${n}건이 만들어져요.` : '목록을 넣거나 파일을 붙이면 줄(파일)마다 작업이 하나씩 만들어져요.';
  }
  [rows, title, prompt].forEach((el) => el.addEventListener('input', updatePreview));
  const rowsField = field('목록', rows, preview);
  const seg = h('div', { class: 'seg' });
  const drawSeg = () => {
    seg.replaceChildren(h('button', { class: mode === 'many' ? 'on' : '', onclick: () => { mode = 'many'; drawSeg(); } }, '여러 건 (템플릿)'), h('button', { class: mode === 'one' ? 'on' : '', onclick: () => { mode = 'one'; drawSeg(); } }, '한 건'));
    rowsField.hidden = mode !== 'many';
    updatePreview();
  };
  drawSeg();
  const md = modal({
    title: '작업 등록', wide: true,
    body: [h('div', { class: 'q-preset-row' }, field('프리셋', presetSel), delPreset), wtBox, seg, field('제목', title), h('div', { class: 'q-regen' }, regen), field('작업 내용', prompt, h('div', { class: 'help' }, '사람 없이 끝까지 가는 작업이에요. 목표, 범위, 산출물, 완료 기준을 분명히 적을수록 "확인 필요"가 줄어요. 붙인 파일은 첫 메시지에 첨부되고, 경로도 매번 함께 전달돼요.')),
      field('첨부 (웹툰 원본 등)', box.el), rowsField,
      h('div', { class: 'row2' }, field('프로젝트', proj), field('스킬', skills)),
      h('div', { class: 'row2' }, field('우선순위', priority, h('div', { class: 'help' }, '클수록 먼저 처리해요')), h('label', { class: 'check-sm', style: { alignSelf: 'end', marginBottom: '10px' } }, sequential, '순서대로 (앞 작업이 끝나야 다음 시작)')),
      h('h4', null, '유료 작업 승인'), ap.el],
    foot: [savePreset, h('span', { style: { flex: 1 } }), h('button', { class: 'btn', onclick: () => md.close() }, '취소'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (!prompt.value.trim()) return toast('작업 내용을 적어 주세요');
        if (wt && ['wire', 'render'].includes(wt.value().range) && !wt.value().work) return toast('작품명을 적어 주세요. BAO 프로젝트를 이 이름으로 찾거나 만들어요');
        if (files.some((f) => f.uploading)) return toast('파일을 올리는 중이에요. 잠시만 기다려 주세요');
        const common = { projectId: proj.value || null, skills: skills.value.split(',').map((x) => x.trim()).filter(Boolean), approval: ap.value(), priority: Number(priority.value) || 0, sequential: sequential.checked };
        try {
          let r;
          if (mode === 'many') {
            const list = parseRows();
            if (!list.length) return toast('목록을 넣거나 파일을 붙여 주세요');
            // 줄 i 에 같은 순서의 파일 i 를 붙인다 (파일이 모자라면 붙이지 않음)
            list.forEach((row, i) => { if (files[i]) row._attachments = [toAtt(files[i])]; if (!row['번호']) row['번호'] = String(i + 1).padStart(2, '0'); if (!row['이미지'] && files[i]) row['이미지'] = files[i].name; });
            r = await api('POST', '/api/queue/jobs', { template: { title: title.value.trim() || '작업 {{item}}', prompt: prompt.value }, rows: list, common });
          } else r = await api('POST', '/api/queue/jobs', { jobs: [{ title: title.value.trim().replace(/\{\{[^}]*\}\}/g, '').trim() || prompt.value.trim().slice(0, 40), prompt: prompt.value.trim(), attachments: files.map(toAtt) }], common });
          md.close();
          toast(`작업 ${r.added}건을 대기열에 넣었어요`);
          await loadQueue();
          go('#/queue');
          renderQueue();
        } catch (e) { toast(e.message, 'error'); }
      } }, '대기열에 넣기')]
  });
  setTimeout(() => title.focus(), 20);
}

// 첨부 상자: 끌어다 놓기·고르기, 이름 순 정렬, 순서 바꾸기, 빼기. initial 은 이미 올린 첨부
const toAtt = (f) => { const { id, name, mime, size, kind, file, url } = f; return { id, name, mime, size, kind, file, url }; };
function attachBox(initial = [], onChange = () => {}) {
  const files = initial.map((a) => ({ ...a, preview: a.kind === 'image' ? a.url : null }));
  const list = h('div', { class: 'q-files' });
  const input = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { add([...e.target.files]); e.target.value = ''; } });
  const natural = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' });
  const draw = () => {
    list.replaceChildren(...files.map((f, i) => h('div', { class: `q-file${f.uploading ? ' up' : ''}` },
      h('span', { class: 'q-fn' }, String(i + 1).padStart(2, '0')),
      f.preview ? h('img', { src: f.preview, alt: '' }) : icon('file'),
      h('span', { class: 't', title: f.name }, f.name),
      f.uploading ? h('span', { class: 'spin' }) : null,
      iconBtn('up', () => { if (i > 0) { [files[i - 1], files[i]] = [files[i], files[i - 1]]; draw(); onChange(false); } }, '앞으로'),
      iconBtn('arrowDown', () => { if (i < files.length - 1) { [files[i + 1], files[i]] = [files[i], files[i + 1]]; draw(); onChange(false); } }, '뒤로'),
      iconBtn('x', () => { files.splice(i, 1); draw(); onChange(false); }, '빼기'))));
  };
  async function add(picked) {
    const fresh = picked.sort(natural).map((f) => ({ name: f.name, size: f.size, uploading: true, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null, _file: f }));
    files.push(...fresh);
    draw();
    onChange(fresh.length > 0);
    for (const it of fresh) {
      try {
        const res = await fetch('/api/upload', { method: 'POST', headers: { 'x-flash-client': '1', 'x-filename': encodeURIComponent(it.name), 'content-type': it._file.type || 'application/octet-stream' }, body: it._file });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        Object.assign(it, j, { uploading: false });
        delete it._file;
      } catch (e) {
        files.splice(files.indexOf(it), 1);
        toast(`${it.name} 업로드 실패: ${e.message}`, 'error');
      }
      draw();
      onChange(false);
    }
  }
  const drop = h('div', { class: 'q-drop', onclick: () => input.click() }, icon('image'), h('span', null, '이미지·파일을 끌어다 놓거나 눌러서 고르세요. 여러 장이면 이름 순서(1, 2, … 10)로 정렬돼요.'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); add([...e.dataTransfer.files]); });
  draw();
  return { el: h('div', null, drop, list, input), files, busy: () => files.some((f) => f.uploading) };
}

// 작업 수정: 제목·내용·첨부·프로젝트·스킬·우선순위·유료 승인. 시작한 작업이면 바뀐 점이 모델에게 전달된다
function editJob(j) {
  const started = !!j.conversationId && !['done', 'canceled'].includes(j.status);
  const title = h('input', { type: 'text', value: j.title });
  const prompt = h('textarea', { class: 'input', rows: 10, value: j.prompt });
  const box = attachBox(j.attachments || []);
  const proj = h('select', null, h('option', { value: '' }, '프로젝트 없음'), ...(S.projects || []).filter((p) => !p.archived || p.id === j.projectId).map((p) => h('option', { value: p.id }, p.name)));
  proj.value = j.projectId || '';
  const skills = h('input', { type: 'text', value: (j.skills || []).join(', '), placeholder: '쉼표로 구분' });
  const priority = h('input', { type: 'number', value: j.priority, min: -100, max: 100 });
  const ap = approvalFields(j.approval);
  const q = S.queue || { jobs: [] };
  const batchOpen = j.batchId ? q.jobs.filter((x) => x.batchId === j.batchId && x.id !== j.id && !['done', 'canceled'].includes(x.status)).length : 0;
  const applyAll = h('input', { type: 'checkbox' });
  const note = started
    ? h('div', { class: 'q-editnote' }, icon('bulb'), h('span', null, j.status === 'running'
      ? '진행 중인 작업이에요. 저장하면 바뀐 점이 추가 지시로 바로 전달되고, 다음 단계부터 반영돼요.'
      : '이미 시작한 작업이에요. 저장하면 바뀐 점이 다음에 이어갈 때 먼저 전달돼요. 첨부를 바꾸면 새 경로가 함께 전달돼요.'))
    : null;
  const md = modal({
    title: '작업 수정', wide: true,
    body: [note,
      field('제목', title),
      field('작업 내용', prompt, h('div', { class: 'help' }, '목표, 범위, 산출물, 완료 기준을 분명히 적을수록 "확인 필요"가 줄어요.')),
      field('첨부', box.el),
      h('div', { class: 'row2' }, field('프로젝트', proj), field('스킬', skills)),
      field('우선순위', priority, h('div', { class: 'help' }, '클수록 먼저 처리해요. 같은 우선순위 안의 순서는 목록의 ⋯ 메뉴에서 옮겨요.')),
      h('h4', null, '유료 작업 승인'), ap.el,
      batchOpen ? h('label', { class: 'check-sm', style: { marginTop: '10px' } }, applyAll, `같이 등록한 나머지 ${batchOpen}건에도 프로젝트·스킬·우선순위·유료 승인 적용 (제목·내용·첨부는 이 작업만)`) : null],
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (!prompt.value.trim()) return toast('작업 내용을 적어 주세요');
        if (box.busy()) return toast('파일을 올리는 중이에요. 잠시만 기다려 주세요');
        const body = {
          title: title.value.trim() || j.title, prompt: prompt.value.trim(), attachments: box.files.map(toAtt),
          projectId: proj.value || null, skills: skills.value.split(',').map((x) => x.trim()).filter(Boolean),
          priority: Number(priority.value) || 0, approval: ap.value(), applyToBatch: applyAll.checked
        };
        try {
          const r = await api('PATCH', `/api/queue/jobs/${j.id}`, body);
          md.close();
          toast(r.changed ? (started ? (j.status === 'running' ? '저장했어요. 진행 중인 작업에 바로 전달했어요' : '저장했어요. 이어갈 때 먼저 전달돼요') : `저장했어요${r.changed > 1 ? ` (${r.changed}건)` : ''}`) : '바뀐 내용이 없어요');
          await loadQueue(); renderQueue();
        } catch (e) { toast(e.message, 'error'); }
      } }, '저장')]
  });
}

function editQueueSettings() {
  const s = S.queue.settings;
  const num = (k, attrs) => { const el = h('input', { type: 'number', value: s[k], ...attrs }); el.dataset.k = k; return el; };
  const fields = { autoContinueMax: num('autoContinueMax', { min: 0, max: 100 }), retryMax: num('retryMax', { min: 0, max: 10 }), retryDelaySec: num('retryDelaySec', { min: 5, max: 3600 }), pauseBetweenSec: num('pauseBetweenSec', { min: 0, max: 600 }), handoffAtRatio: num('handoffAtRatio', { min: 0.3, max: 1, step: 0.05 }) };
  const autoHandoff = h('input', { type: 'checkbox', checked: s.autoHandoff });
  const allowModelRegistration = h('input', { type: 'checkbox', checked: s.allowModelRegistration === true });
  // 24시간 운영
  const alwaysOn = h('input', { type: 'checkbox', checked: s.alwaysOn });
  const keepAwake = h('input', { type: 'checkbox', checked: s.keepAwake });
  const autostart = h('input', { type: 'checkbox' });
  const sysState = h('div', { class: 'help' }, '상태를 확인하는 중…');
  const drawSys = (st) => {
    autostart.checked = st.autostart;
    sysState.textContent = `감시자 ${st.supervisor ? '실행 중' : '꺼짐'} · 지금 서버 ${st.supervised ? '감시자 아래에서 실행 중' : '일반 실행'}${st.keepAwakeActive ? ' · 절전 방지 동작 중' : ''}`;
  };
  api('GET', '/api/system/always-on').then(drawSys).catch(() => { sysState.textContent = '상태를 읽지 못했어요'; });
  const startSup = h('button', { class: 'btn sm', onclick: async () => {
    try { drawSys(await api('POST', '/api/system/always-on', { startSupervisor: true })); toast('감시자를 켰어요. 서버가 멈추면 알아서 다시 띄워요'); } catch (e) { toast(e.message, 'error'); }
  } }, '감시자 지금 켜기');
  const md = modal({
    title: '공정 설정',
    body: [
      h('h4', null, '24시간 운영'),
      h('label', { class: 'check-sm' }, alwaysOn, '상시 가동 — 창을 닫거나 작업이 비어도 서버를 끄지 않고 새 작업을 기다리기'),
      h('label', { class: 'check-sm' }, keepAwake, '작업이 남아 있는 동안 PC 절전 막기 (화면 꺼짐은 그대로)'),
      h('label', { class: 'check-sm' }, autostart, '윈도우를 켤 때 자동으로 시작 (감시자와 함께)'),
      h('div', { class: 'chip-row' }, startSup, sysState),
      h('div', { class: 'help' }, '감시자는 서버가 오류로 꺼지면 몇 초 뒤 다시 띄워요. 진행 중이던 작업은 체크포인트부터 이어서 재개돼요. 로그는 data\\logs\\supervisor.log 에 남아요.'),
      h('h4', null, '자동 진행'),
      h('label', { class: 'check-sm' }, allowModelRegistration, '모델의 새 대기열 등록 허용 (기본 꺼짐)'),
      h('div', { class: 'help' }, '꺼져 있으면 현재 대화에서 작업합니다. 켜면 작업별 채팅방을 만들며 워커 1개로 순차 처리합니다. 지침·첨부·스킬·모델을 이어받고 유료 승인은 별도로 받습니다.'),
      h('label', { class: 'check-sm' }, autoHandoff, '대화가 무거워지면 인계서를 써서 새 대화로 옮기기'),
      h('div', { class: 'row2' }, h('div', { class: 'help' }, '인계 시점은 대화 설정과 같습니다. 요청은 요약하며 이어가고 원문 누적300만에서 방을 옮깁니다. 예전 비율 때문에 더 일찍 전환하지 않습니다.'), field('자동 이어가기 최대 횟수 (작업당)', fields.autoContinueMax)),
      h('div', { class: 'row2' }, field('오류 재시도 횟수', fields.retryMax), field('재시도 대기 (초, 시도마다 2배)', fields.retryDelaySec)),
      field('작업 사이 쉬는 시간 (초)', fields.pauseBetweenSec)],
    foot: [h('button', { class: 'btn', onclick: () => md.close() }, '취소'),
      h('button', { class: 'btn primary', onclick: async () => {
        const body = { allowModelRegistration: allowModelRegistration.checked, autoHandoff: autoHandoff.checked, alwaysOn: alwaysOn.checked, keepAwake: keepAwake.checked };
        for (const [k, el] of Object.entries(fields)) body[k] = Number(el.value);
        try {
          await api('PATCH', '/api/queue/settings', body);
          await api('POST', '/api/system/always-on', { autostart: autostart.checked });
          md.close(); await loadQueue(); renderQueue();
        } catch (e) { toast(e.message, 'error'); }
      } }, '저장')]
  });
}
