'use strict';
// 채팅 실행기: 히스토리 구성 → LLM 스트리밍 → 도구 루프 → 저장, 과정을 SSE 로 중계
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const tools = require('./tools');
const extra = require('./tools-extra');
const { newId, now } = require('./store');
const {pollKey,pollStatusRead,pollInputError,pollFailure}=require('./poll-policy');

const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|kt|c|h|cpp|hpp|cs|go|rs|rb|php|swift|sql|sh|bat|ps1|ya?ml|toml|ini|cfg|conf|log|srt|vtt)$/i;
// 컨텍스트 관리 규칙 (D:\FlashStudio\CONTEXT.md 참고)
const ctxPolicy = require('./context');
const handoffPolicy = require('./handoff');
const { HandoffCheckpoint } = require('./handoff-checkpoint');
const decisions = require('./decisions');

// ---------------- 대기열 (CONTEXT.md §13) ----------------
const QUEUE_TOOLS = [
  { type: 'function', function: {
    name: 'queue_add',
    description: '사용자가 대기열 설정에서 자동 등록을 허용한 경우에만 맡긴 범위 안의 작업을 등록한다. 기본은 자동 등록 금지이며 현재 대화에서 진행한다. 워커는 1개로 순차 실행한다. 병렬 실행했다고 보고하지 않는다. 대화 지침·스킬·첨부·모델과 등록 출처를 보존한다. 동일 등록은 재사용하며 유료 승인은 사용자 화면에서 별도로 받는다.',
    parameters: { type: 'object', properties: { jobs: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', properties: {
      title: { type: 'string' }, prompt: { type: 'string' }, priority: { type: 'integer', description: '클수록 먼저 (기본 0)' },
      skills: { type: 'array', items: { type: 'string' } }, project_id: { type: 'string', description: '생략하면 지금 대화의 프로젝트' },
      after_previous: { type: 'boolean', description: 'true 면 바로 앞 작업이 끝난 뒤 시작' } }, required: ['title', 'prompt'], additionalProperties: false } } },
    required: ['jobs'], additionalProperties: false }
  } },
  { type: 'function', function: {
    name: 'queue_status',
    description: '작업 대기열의 상태(대기·진행·막힘·완료·실패)를 본다.',
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['queued', 'running', 'paused', 'blocked', 'done', 'failed', 'canceled'] } }, additionalProperties: false }
  } }
];
const CHECKPOINT_TOOL = { type: 'function', function: {
  name: 'queue_checkpoint',
  description: '무인 작업의 재개 지점을 저장한다. 단계를 끝낼 때마다 부른다. 대화가 새로 바뀌거나 앱이 다시 시작되면 여기서 이어진다. 이전 체크포인트를 덮어쓰므로 지금까지의 전체 상태를 적는다.',
  parameters: { type: 'object', properties: { checkpoint: { type: 'string', description: '단계별 진행 상태 — 끝낸 단계, 지금 단계, 식별자(graph_id·node·job·revision·파일 경로), 남은 일. 8000자 이내' } }, required: ['checkpoint'], additionalProperties: false }
} };
// 유료 도구 분류: images / video / other. 무료면 null
// 기존 프로젝트를 바꾸거나 지우는 작업이면 그 이름, 아니면 null
function protectedOp(name, args) {
  const n = String(name).split('__').pop().split('/').pop().toLowerCase();
  const op = String((args && (args.operation || args.op)) || '').toLowerCase();
  if (n === 'production_prepare' && /(update|rename|delete|archive|remove|move|transfer)_?project|project\.(update|rename|delete|archive)|workspace\.(update|delete|archive)|canvas\.delete|asset\.delete|(delete|remove)_(canvas|asset|scene|source)/.test(op)) return op;
  if (/^(production_project_(update|rename|delete|archive)|delete_project|rename_project|update_project)$/.test(n)) return n;
  return null;
}

function paidKind(name, args) {
  const n = String(name).split('__').pop().split('/').pop().toLowerCase();
  if (require('./minimax-h3').billable(n, args)) return 'other'; // VM runtime can incur cloud charges; safe stop remains available.
  if (/^(grok_|anima_)/.test(n)) return null; // Subscription/local routes never use per-call API billing.
  if (n === 'generate_image') return 'images';
  if (n === 'production_prepare') return /generate|render/i.test(String(args.operation || '')) ? 'video' : null;
  if (/video/.test(n) && /generate|render|create/.test(n)) return 'video';
  if (/^(text_to_speech|speech_to_speech|compose_music|text_to_sound_effects|voice_clone|text_to_voice|create_voice_from_preview|video_to_music)$/.test(n)) return 'other';
  if (/^generate_(hyper3d|hunyuan3d|tripo)/.test(n)) return 'other';
  return null;
}
function queueBlock(job) {
  const ap = job.approval || {};
  const yn = (v) => (v ? '허용' : '미승인');
  return [
    `# 무인 대기열 작업 — "${job.title}" (대화 ${job.conversations.length || 1}번째, 인계 ${job.handoffs}회, 자동 이어가기 ${job.continues}회)`,
    '이 대화는 사람이 지켜보지 않는 자동 공정이다.',
    '- 사소하고 되돌릴 수 있는 판단은 직접 한다. 중요한 결정은 ask_user(critical=true)로 영구 메모에 남기고 해당 의존 작업만 보류한다. 독립적인 허용 작업을 병렬 진행한다. 무응답은 승인이 아니다.',
    '- 단계를 끝낼 때마다 queue_checkpoint 로 재개 지점(끝낸 단계·식별자·job·revision·남은 일)을 남긴다. 대화가 바뀌어도 여기서 이어진다.',
    '- 이미 끝난 단계는 다시 하지 않는다. 불확실하게 끝난 제출은 새로 제출하지 말고 상태부터 확인한다.',
    '- 모두 끝나면 결과를 짧게 정리하고 마지막 줄에 [JOB_DONE] 한 가지만 따로 쓴다. 끝나지 않았으면 이 표시를 쓰지도, 언급하지도 않는다.',
    '- 사람이 결정해야만 진행할 수 있으면 [JOB_BLOCKED: 사유] 를 쓰고 멈춘다. 일부만 막혔으면 나머지를 끝낸 뒤 막힌 것을 모아 보고한다.',
    `- 유료 승인: 이미지 ${yn(ap.images)} · 영상 ${yn(ap.video)} · 기타 ${yn(ap.other)} · 유료 호출 ${job.paidCalls}/${ap.maxPaidCalls == null ? '제한 없음' : ap.maxPaidCalls}${ap.budgetNote ? ` · 예산: ${ap.budgetNote}` : ''}. 승인된 종류는 묻지 않고 진행하고, 미승인 종류는 실행되지 않는다.`,
    // 최신 작업 내용 — 사용자가 수정해도, 대화가 인계돼도 기준이 흔들리지 않게 (길면 앞부분만)
    `## 작업 내용 (최신)\n${job.prompt.length > 3000 ? `${job.prompt.slice(0, 3000)}\n…(${job.prompt.length.toLocaleString()}자 중 앞부분)` : job.prompt}`,
    (job.attachments || []).length ? `## 작업 첨부 파일 (도구에는 이 경로를 넣는다)\n${job.attachments.map((f, i) => `${i + 1}. ${f.name} → /files/uploads/${f.file}`).join('\n')}` : '',
    `## 체크포인트\n${job.checkpoint || '(아직 없음 — 처음 시작하는 작업)'}`
  ].filter(Boolean).join('\n');
}

// 일반 질문은 제한 시간 뒤 권장안, 중요한 결정은 영구 메모 + 독립 작업 계속.
const ASK_TOOL = { type: 'function', function: {
  name: 'ask_user',
  description: '사용자가 직접 골라야 하는 갈림길에서만 보기 2~4개로 묻는다. 가장 좋다고 판단한 보기를 recommended 로 정한다. 일반 질문은 제한 시간 뒤 recommended 로 진행한다. 비용·구조 변경·기존 조건 충돌 등 중요한 결정은 critical=true: 질문을 영구 메모에 남기고 즉시 반환하므로 답을 가정하지 않고 독립적인 허용 작업을 병렬 진행한다. blocked_tasks에 답이 필요한 작업, independent_tasks에 지금 계속할 작업을 적는다. 무응답은 승인이 아니다. 스스로 판단할 수 있는 사소한 건 묻지 말고 진행한다.',
  parameters: { type: 'object', properties: {
    question: { type: 'string', description: '한 문장 질문' },
    options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: { label: { type: 'string', description: '짧은 보기 이름' }, description: { type: 'string', description: '고르면 어떻게 되는지 한 줄' } }, required: ['label'], additionalProperties: false } },
    recommended: { type: 'integer', minimum: 0, maximum: 3, description: '권장 보기 번호 (0부터)' },
    critical: { type: 'boolean', description: '중요한 결정: 미답변 메모에 보존, 해당 의존 작업만 보류' },
    blocked_tasks: { type: 'array', items: { type: 'string' }, description: '답이 있어야 진행할 작업' },
    independent_tasks: { type: 'array', items: { type: 'string' }, description: '답 없이 계속할 독립적인 허용 작업' }
  }, required: ['question', 'options', 'recommended'], additionalProperties: false }
} };

// 오래 걸리는 작업을 서버가 대신 기다린다. 조회를 여러 번 해도 모델 호출은 1번 (CONTEXT.md §12)
const POLL_TOOL = { type: 'function', function: {
  name: 'poll_until',
  description: '렌더·영상/이미지 생성·업로드 처리처럼 오래 걸리는 작업의 상태를 서버가 대신 확인한다. 기본(background=true)은 백그라운드 확인이다: 바로 돌아오고, 서버가 토큰 없이 상태 조회를 반복하다가 끝나면 결과를 이 대화에 알림으로 넣는다. 그동안 다른 일을 계속하고, 할 일이 없으면 응답을 끝내도 된다(결과가 오면 자동으로 이어진다). 다음 단계가 이 결과 없이는 절대 안 되고 몇 분 안에 끝날 때만 background=false 로 그 자리에서 기다린다. 조회(읽기) 도구만 반복할 수 있다.',
  parameters: { type: 'object', properties: {
    tool: { type: 'string', description: '반복할 조회 도구 이름 (예: mcp__bao-production__canvas_job_status). mcp_call 로 쓰던 도구는 "서버/도구" 형식' },
    arguments: { type: 'object', description: '조회 도구의 전체 입력을 그대로 넣는다. production_read 예: {project_id:"bao-...",operation:"editor.export_read",arguments:{editorProjectId:"...",commandId:"editor_export_+64자리해시"}}. project_id는 이 조회 입력의 최상위, 작업 필드는 내부 arguments. editor.export_status는 없다. 네이티브 export는 editor.export_read/queue로 조회하며 제공자 render_queue와 별개다.' },
    field: { type: 'string', description: '결과 JSON 에서 볼 필드 경로 (예: status, data.job.status). 기본 status' },
    until: { type: 'array', items: { type: 'string' }, description: '이 값 중 하나가 되면 멈춘다. 기본: succeeded, completed, complete, done, success, exported, failed, error, canceled, cancelled, expired, rejected. exported는 인코딩 완료이며 결과 파일 검증·전달은 별도로 한다.' },
    contains: { type: 'string', description: 'field 대신, 결과 글에 이 문자열이 나오면 멈춘다' },
    interval_seconds: { type: 'integer', minimum: 3, maximum: 120, description: '첫 조회 간격 (기본: 백그라운드 20초, 그 자리 10초). 점점 늘어난다' },
    timeout_seconds: { type: 'integer', minimum: 10, maximum: 14400, description: '최대 대기 (기본: 백그라운드 3600초, 그 자리 1200초·최대 1800초)' },
    background: { type: 'boolean', description: '기본 true. false 면 끝날 때까지 이 자리에서 기다린다' },
    label: { type: 'string', description: '알림에 쓸 짧은 이름 (예: "cut03 영상 렌더")' }
  }, required: ['tool', 'arguments'], additionalProperties: false }
} };
const STATUS_TOOL = /(status|job|render_queue|progress)/i;
const POLL_DONE = ['succeeded', 'completed', 'complete', 'done', 'success', 'exported', 'failed', 'error', 'canceled', 'cancelled', 'expired', 'rejected'];
// 반복 호출하면 안 되는(쓰기·실행) 도구 이름
const POLL_DENY = /(execute|prepare|patch|create|delete|remove|update|upload|generate|write|submit|save|edit|move|copy|rename|set_|send|run_|apply|approve|cancel|start|render(?!_queue))/i;
const sleepFor = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
function pickField(text, fieldPath) {
  let obj = null;
  try { obj = JSON.parse(text); } catch {
    const i = text.indexOf('{');
    if (i !== -1) { try { obj = JSON.parse(text.slice(i)); } catch { obj = null; } }
  }
  if (!obj) return null;
  const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
  let v = get(obj, fieldPath);
  // 기본 경로(status)가 없으면 흔한 위치를 찾아본다
  if (v == null && fieldPath === 'status') for (const p of ['data.status', 'job.status', 'data.job.status', 'result.status', 'state']) { v = get(obj, p); if (v != null) break; }
  return v == null ? null : String(v);
}

// 작업 브라우저 도구 (lib/browser.js). 사용자는 오른쪽 패널 "브라우저" 탭에서 같은 화면을 본다
const bfn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const BROWSER_TOOLS = [
  bfn('browser_open', '작업 브라우저로 웹 페이지를 연다. 사용자 화면 오른쪽 패널에 실시간으로 보인다. 주소 대신 검색어를 넣으면 검색 결과를 연다. 결과로 본문 앞부분과 누를 수 있는 요소 번호를 받는다. 로그인·결제·개인정보 입력은 하지 말고 사용자에게 맡긴다.',
    { url: { type: 'string', description: '주소 또는 검색어' } }, ['url']),
  bfn('browser_read', '지금 페이지의 본문 텍스트와 누를 수 있는 요소 번호 목록을 읽는다. 긴 페이지는 offset 으로 이어 읽는다.',
    { offset: { type: 'integer', minimum: 0, description: '본문 시작 위치 (글자)' } }),
  bfn('browser_click', '요소를 누른다. element 번호(browser_read 목록)를 우선 쓰고, 번호가 없을 때만 x, y 좌표(1280×800 화면 기준)를 쓴다.',
    { element: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean', description: '더블클릭' } }),
  bfn('browser_type', '입력칸에 글자를 넣는다. element 를 주면 그 칸을 먼저 누른다. submit 이면 입력 뒤 Enter.',
    { element: { type: 'integer' }, text: { type: 'string' }, clear: { type: 'boolean', description: '기존 내용을 지우고 입력' }, submit: { type: 'boolean' } }, ['text']),
  bfn('browser_key', '키를 누른다.', { key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'] } }, ['key']),
  bfn('browser_scroll', '페이지를 스크롤한다.', { direction: { type: 'string', enum: ['down', 'up'] }, amount: { type: 'integer', minimum: 1, maximum: 20, description: '화면 몇 칸 (기본 1)' } }),
  bfn('browser_navigate', '뒤로·앞으로·새로고침.', { action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, ['action']),
  bfn('browser_screenshot', '작업 브라우저 화면을 이미지로 저장해 대화에 보여준다. 결과물로 남길 때나 화면 모양을 확인할 때만 쓴다.', {}),
  bfn('browser_close', '작업 브라우저를 닫는다.', {})
];
const { POLICY } = ctxPolicy;

function attachmentKind(name, mime) {
  if (/^image\//.test(mime)) return 'image';
  if (/^text\//.test(mime) || /json|xml|javascript|yaml|csv/.test(mime) || TEXT_EXT.test(name)) return 'text';
  return 'file';
}

class ChatRunner {
  constructor({ store, mcp, skills, browser = null, terminal = null }) {
    this.store = store;
    this.mcp = mcp;
    this.browser = browser;
    this.terminal = terminal;
    this.skills = skills;
    this.runs = new Map();
    this.handoffDrafts = new Map();
  }

  uploadPath(att) { return path.join(this.store.dirs.uploads, path.basename(att.file)); }

  // "/files/images/x.png" → image_url 파트. 공급자의 이미지 픽셀 한도(예: 8192x8192)와 요청 크기 한도에
  // 걸리지 않도록 prepareImageForVision 으로 필요할 때만 줄인다.
  async resultImage(url) {
    const m = String(url).match(/^\/files\/(images|uploads|screenings)\/([A-Za-z0-9._-]+)$/);
    if (!m) return null;
    const file = path.join(this.store.dirs[m[1]], m[2]);
    if (!fs.existsSync(file)) return null;
    try {
      const { mime, buffer } = await tools.prepareImageForVision(file, this.store);
      return { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } };
    } catch { return null; }
  }

  imageDataUrl(att) {
    const buf = fs.readFileSync(this.uploadPath(att));
    return `data:${att.mime || 'image/png'};base64,${buf.toString('base64')}`;
  }

  // 저장된 대화 → OpenAI messages
  async buildHistory(conv, modelDef) {
    const out = [];
    const lastUserIdx = conv.messages.map((m) => m.role).lastIndexOf('user');
    // 정리(요약)된 구간은 싣지 않는다 — 요약은 시스템 프롬프트에 들어간다 (CONTEXT.md §5)
    const cutoff = conv.compaction ? conv.messages.findIndex((m) => m.id === conv.compaction.upToMessageId) : -1;
    const seen = new Map();
    for (const [idx, m] of conv.messages.entries()) {
      if (idx <= cutoff) continue;
      if (m.role === 'user') {
        const current = idx === lastUserIdx;
        let text = m.content || '';
        const imgs = [];
        const imageAtts = (m.attachments || []).filter((a) => a.kind === 'image');
        if (modelDef.vision && imageAtts.length) {
          // 이미지를 보는 모델도 이번 메시지 첨부와 이전 첨부를 구분하게 한다
          text += current
            ? `\n\n[이번 메시지에 첨부된 이미지 ${imageAtts.length}장: ${imageAtts.map((a) => a.name).join(', ')}]`
            : `\n\n[이전 메시지에 첨부됐던 이미지: ${imageAtts.map((a) => a.name).join(', ')} — 사용자가 다시 가리키지 않으면 이번 요청에 쓰지 않는다]`;
        } else if (imageAtts.length) {
          // 이미지를 못 보는 모델: 이번 메시지 첨부와 이전 메시지 첨부를 분명히 구분한다
          text += current
            ? `\n\n[이번 메시지에 첨부된 이미지 ${imageAtts.length}장: ${imageAtts.map((a) => a.name).join(', ')} — 이 모델은 이미지를 직접 볼 수 없습니다. generate_image 에 use_attached_images: true 를 주면 이 ${imageAtts.length}장만 참조 이미지로 전달됩니다]`
            : `\n\n[이 메시지 당시 첨부됐던 이미지 ${imageAtts.length}장: ${imageAtts.map((a) => a.name).join(', ')} — 지난 요청의 이미지이며 지금 요청의 참조 이미지로는 전달되지 않습니다]`;
        }
        for (const a of m.attachments || []) {
          try {
            if (a.kind === 'image') {
              // 실제 이미지 데이터는 이번(가장 최근) 사용자 메시지에만 실어 보낸다. 지난 메시지까지 매번 다시 보내면
              // 대화가 길어질수록 요청이 계속 불어나 공급자의 요청 크기 한도(HTTP 413)에 걸린다.
              // prepareImageForVision 은 공급자의 이미지 픽셀 한도(예: 8192x8192)도 넘지 않게 필요하면 줄인다.
              if (modelDef.vision && current) {
                const { mime, buffer } = await tools.prepareImageForVision(this.uploadPath(a), this.store);
                imgs.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } });
              }
            } else if (a.kind === 'text') {
              const body = fs.readFileSync(this.uploadPath(a), 'utf8').slice(0, 300000);
              text += `\n\n<attachment name="${a.name}">\n${body}\n</attachment>`;
            } else if (/\.(docx|xlsx|pptx)$/i.test(a.name)) {
              // Word·Excel·PowerPoint 는 텍스트로 풀어서 넣는다
              const body = (extra.officeText(this.uploadPath(a)) || '').slice(0, 300000);
              text += `\n\n<attachment name="${a.name}">\n${body}\n</attachment>`;
            } else if (/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(a.name)) {
              text += `\n\n[첨부 영상: ${a.name} (${a.size} B) — inspect_video 도구에 이 이름을 넣으면 실제 시간별 프레임을 모델에 전달합니다. 표본 구간·시각을 근거로 검수하고, 오디오와 표본 사이 연속성은 미확인으로 구분하세요.]`;
            } else if (/\.pdf$/i.test(a.name)) {
              text += `\n\n[첨부 PDF: ${a.name} (${a.size} B) — read_document 도구에 이 파일 이름을 넣으면 페이지를 이미지로 읽을 수 있습니다]`;
            } else {
              text += `\n\n[첨부 파일: ${a.name} (${a.mime || '알 수 없는 형식'}, ${a.size} B) — 텍스트로 풀 수 없는 형식입니다. copy_files·file_info·http_request 로는 다룰 수 있습니다]`;
            }
          } catch (e) { text += `\n\n[첨부 파일 ${a.name} 을 읽지 못했습니다: ${e.message}]`; }
        }
        out.push({ role: 'user', content: imgs.length ? [{ type: 'text', text: text || '(이미지)' }, ...imgs] : (text || '(빈 메시지)') });
      } else if (m.role === 'assistant') {
        // L3 지난 턴: 도구 결과·긴 답변은 줄이고, 똑같은 도구 결과는 한 번만 싣는다 (CONTEXT.md §4)
        await this.appendAssistant(out, m.parts || [], { resultCap: POLICY.historyToolResultCap, textCap: POLICY.historyAssistantTextCap, seen });
      }
    }
    return out;
  }

  // parts 를 assistant/tool 메시지로 펼친다.
  // opts.resultCap: 도구 결과 최대 글자 (0 이면 그대로)
  // opts.keepFullLast: 마지막 N개 도구 결과는 resultCap 을 적용하지 않는다 (진행 중인 턴의 최신 결과)
  // opts.textCap: 어시스턴트 답변 최대 글자 (지난 턴)
  // opts.seen: 같은 도구 결과 중복 제거용 Map (buildHistory 전체에서 공유)
  async appendAssistant(out, parts, opts = {}) {
    const { withReasoning = false, imageFeedback = false, resultCap = 0, keepFullLast = 0, textCap = 0, seen = null } = opts;
    const pixelParts = new Set(parts.filter(p => p.type === 'image').slice(-8));
    const callIds = parts.filter((p) => p.type === 'tool_call').map((p) => p.id);
    const keepFull = new Set(keepFullLast ? callIds.slice(-keepFullLast) : []);
    let cur = null;
    let reasoning = '';
    const capText = (s, id) => {
      if (!s || !resultCap || keepFull.has(id) || s.length <= resultCap) return s;
      return `${s.slice(0, resultCap)}\n…(도구 결과 원문 ${s.length.toLocaleString()}자 중 앞부분 — 최신 상태가 필요할 때만 다시 조회)`;
    };
    const resultFor = (c) => {
      let text = c.result;
      if (seen && text && text.length >= POLICY.dedupeMinChars) {
        const key = `${c.name}\u0000${text}`;
        if (seen.has(key)) return `(앞선 ${c.name} 결과와 같은 내용 — 생략)`;
        seen.set(key, true);
      }
      text = capText(text, c.id);
      return text || (c.status === 'denied' ? '사용자가 이 도구 실행을 거부했습니다.' : '(결과 없음)');
    };
    const flush = async () => {
      if (!cur) return;
      const content = textCap && cur.content.length > textCap ? `${cur.content.slice(0, textCap)}\n…(답변 일부 생략)` : cur.content;
      const msg = { role: 'assistant', content: content || (cur.calls.length ? '' : ' ') };
      if (cur.calls.length) msg.tool_calls = cur.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
      if (withReasoning && cur.reasoning) msg.reasoning_content = cur.reasoning;
      out.push(msg);
      for (const c of cur.calls) out.push({ role: 'tool', tool_call_id: c.id, content: resultFor(c) });
      // 비전 모델이면 도구가 만든 이미지를 다시 보여 줘서 결과를 직접 확인하게 한다 (최근 8장, 진행 중인 턴만)
      if (imageFeedback && cur.images.length) {
        const selected = cur.images.slice(-8);
        const entries = await Promise.all(selected.map(async p => ({part:p,image:await this.resultImage(p.url)})));
        const imgs = entries.filter(entry => entry.image).flatMap(({part,image}) => [{type:'text',text:part.prompt ? `[픽셀 입력: ${part.prompt.slice(0,1200)}] ${part.url}` : `[도구 결과 이미지] ${part.url}`},image]);
        if (imgs.length) out.push({ role: 'user', content: [{ type: 'text', text: `[실제 픽셀 입력 ${imgs.length/2}장 — 최근 최대 8장. 영상 표본은 표시된 시각만 확인하며 오디오·표본 사이 구간은 미확인.]` }, ...imgs] });
      }
      cur = null;
    };
    for (const p of parts) {
      if (p.type === 'image') { if (cur && pixelParts.has(p)) cur.images.push(p); continue; }
      // 스티어링: 앞의 도구 결과 뒤에 사용자 메시지로 끼워 넣는다
      if (p.type === 'steer') {
        if (opts.skipPendingSteer && p.delivery === 'pending') continue;
        await flush();
        let text = `[작업 도중 사용자가 보낸 추가 지시 — 지금까지 한 일을 유지하면서 이 지시를 반영해 이어간다]\n${p.text}`;
        const images = [];
        for (const a of p.attachments || []) {
          text += `\n첨부 ${a.name}: data/uploads/${a.file}`;
          if (a.kind === 'image' && imageFeedback) {
            const image = await this.resultImage(`/files/uploads/${a.file}`);
            if (image) images.push(image);
            else text += ' (이미지 파일을 읽지 못했습니다)';
          } else if (a.kind === 'text') {
            try { text += `\n${fs.readFileSync(this.uploadPath(a), 'utf8').slice(0, 40000)}`; }
            catch { text += ' (첨부 파일을 읽지 못했습니다)'; }
          } else if (a.kind === 'image') text += ' (지난 추가 지시 첨부 또는 비전 미지원 — 필요하면 파일 도구로 확인)';
        }
        out.push({ role: 'user', content: images.length ? [{ type: 'text', text }, ...images] : text });
        continue;
      }
      if (p.type === 'reasoning') { if (cur && cur.calls.length) await flush(); reasoning += p.text; continue; }
      if (p.type === 'text') {
        if (cur && cur.calls.length) await flush();
        cur = cur || { content: '', calls: [], images: [], reasoning };
        cur.content += p.text;
        reasoning = '';
      } else if (p.type === 'tool_call') {
        cur = cur || { content: '', calls: [], images: [], reasoning };
        reasoning = '';
        cur.calls.push(p);
      }
    }
    await flush();
  }

  // 시스템 프롬프트는 CONTEXT.md §2 의 층 순서대로 조립한다:
  // L0 기본 지침 → 컨텍스트 규칙 → 대화 지침 → 환경 → 이전 대화 요약 → 도구·MCP 안내 → 메모리 → 스킬 목록 → 활성 스킬
  systemPrompt(conv, skillNames, toolsOn, opts = {}) {
    const s = this.store.getSettings();
    const blocks = [];
    if (s.systemPrompt.trim()) blocks.push(s.systemPrompt.trim());
    // 프로젝트 층 (CONTEXT.md §10): 지침 전문 + 참고 파일은 경로만
    const project = this.store.getProject(conv.projectId);
    if (project) {
      const files = (project.files || []).map((f) => `- ${f.label ? `${f.label}: ` : ''}${f.ref}`).join('\n');
      const body = [project.instructions.trim(), files ? `## 참고 파일 (필요할 때 read_file 로 읽는다)\n${files}` : ''].filter(Boolean).join('\n\n');
      blocks.push(`# 프로젝트: ${project.name}${project.description ? ` — ${project.description}` : ''}${body ? `\n${body}` : ''}`);
    }
    if (toolsOn) blocks.push(ctxPolicy.MODEL_RULES);
    blocks.push(decisions.context(this.store, conv));
    if (conv.systemPrompt.trim()) blocks.push(`# 이 대화의 지침\n${conv.systemPrompt.trim()}`);
    blocks.push(`# 환경\n- 현재 시각: ${new Date().toLocaleString('ko-KR', { dateStyle: 'full', timeStyle: 'short' })}\n- 로컬 설치형 앱에서 실행 중. 작업 폴더: ${this.store.dirs.workspace}\n- 앱 이미지 폴더: /files/images (${this.store.dirs.images}), 첨부 폴더: /files/uploads`);
    if (conv.watch && conv.watch.enabled && !opts.queue) blocks.push(ctxPolicy.WATCH_RULE);
    if (conv.queueJobId && this.queue && opts.queue) {
      const job = this.queue.get(conv.queueJobId);
      if (job) blocks.push(queueBlock(job));
    }
    if (conv.handoff?.summary) {
      const files = (conv.handoff.files || []).map((x) => `- ${x.label}: ${x.ref}`).join('\n');
      blocks.push(`# 이전 대화에서 넘겨받은 인계서 (원래 대화: "${conv.handoff.fromTitle}")\n사용자 지침·취소/교정·작업별 남은 일을 먼저 대조하고 이어 간다. 기억이 없다는 이유로 유효 지침을 생략하거나 완료 작업을 반복하지 않는다. 이 문서는 요약이다. 원본·대본 시트와 실제 노드 상태는 다시 확인한다. 누락·충돌·새로 언급된 옛 작업은 search_previous_conversation으로 모든 선행 대화를 검색하고 read_previous_conversation으로 메시지 원문을 끝까지 읽는다. 원문은 삭제되지 않았다.\n원문 지시 목록: ${conv.handoff.sourceLedger || '(기존 인계 — 원문 검색으로 복구)'}\n\n${conv.handoff.summary}${files ? `\n\n## 관련 파일 (자동 수집)\n${files}` : ''}`);
    }
    if (conv.compaction?.summary) {
      blocks.push(`# 이전 대화 요약 (자동 정리됨 — 메시지 ${conv.compaction.summarizedCount}개)\n${conv.compaction.summary}\n원문은 현재 대화에 보존되어 있습니다. 빠진 지침·옛 작업은 search_previous_conversation과 read_previous_conversation으로 현재 대화 원문부터 복구합니다.${conv.compaction.sourceLedger ? ` 지시 목록: ${conv.compaction.sourceLedger}` : ''}`);
    }
    // 연결된 MCP 서버의 HTTP 주소 (인증 값은 넣지 않는다). 업로드처럼 MCP 가 알려준 "/api/..." 주소는 http_request 의 mcp_server 로 보낸다
    // 이번 요청에 실제로 넘어가는 MCP 도구. 대화 앞부분에서 "도구가 없다"고 했던 것보다 이 목록이 우선한다
    const live = this.mcp.status().filter((s) => s.status === 'connected' && s.tools.length);
    if (toolsOn && live.length) {
      const direct = this.mcp.directServers(this.mcpOpts());
      const directList = live.filter((s) => direct.has(s.name));
      const viaCall = live.filter((s) => !direct.has(s.name));
      blocks.push([
        '# 지금 쓸 수 있는 MCP 도구 (이번 요청 기준)',
        '도구 목록은 요청마다 새로 갱신된다. 대화 앞부분에서 없다고 했거나 실패했던 도구라도 아래에 있으면 지금 바로 쓸 수 있다.',
        // 바로 호출하는 서버의 도구는 이미 도구 정의로 넘어가므로 이름을 다시 늘어놓지 않는다 (중복 제거)
        directList.length ? `## 바로 호출: ${directList.map((s) => `${s.name}(${s.tools.length})`).join(', ')} — 도구 정의의 mcp__<서버>__<도구> 이름으로 호출` : '',
        viaCall.length ? `## mcp_tools 로 사용법을 찾고 mcp_call 로 호출\n${viaCall.map((s) => `- ${s.name} (${s.tools.length}개): ${s.tools.map((t) => t.name).join(', ')}`).join('\n')}` : ''
      ].filter(Boolean).join('\n'));
    }
    const eps = extra.mcpEndpoints({ mcp: this.mcp });
    if (eps.length) {
      blocks.push(`# MCP 서버 주소\n${eps.map((e) => `- ${e.name}: ${e.origin} (${e.status === 'connected' ? '연결됨' : '연결 안 됨'}${Object.keys(e.headers).length ? ', 인증 헤더는 http_request 가 자동으로 붙임' : ''})`).join('\n')}\n- MCP 도구가 "/api/..." 같은 상대 주소나 업로드 토큰을 돌려주면 http_request 에 url 은 그 상대 주소 그대로, mcp_server 는 위 서버 이름으로 넣는다. 주소를 추측해서 만들지 않는다.`);
    }
    if (s.tools.enableMemory) {
      const mem = extra.loadMemory({ store: this.store }).items;
      if (mem.length) blocks.push(`# 기억해 둔 내용 (memory 도구로 관리)\n${mem.map((m) => `- [${m.id}] ${m.text}`).join('\n')}`);
    }

    // L1 스킬 목록: 이름 + 짧은 설명만. 이미 본문이 실린 활성 스킬은 목록에서 뺀다 (중복 제거)
    const active = new Set(skillNames);
    const all = this.skills.list().filter((k) => !active.has(k.name));
    if (toolsOn && all.length && s.skills.maxCatalog > 0) {
      const lines = all.slice(0, s.skills.maxCatalog).map((k) => `- ${k.name}: ${k.description.replace(/\s+/g, ' ').slice(0, POLICY.catalogDescChars)}`);
      blocks.push(`# 사용 가능한 스킬\n요청이 아래 스킬 설명과 맞으면 load_skill 로 전체 지침을 먼저 불러와 따르세요.\n${lines.join('\n')}`);
    }
    for (const name of skillNames) {
      try {
        const sk = this.skills.read(name);
        blocks.push(`# 활성 스킬: ${sk.name}\n사용자가 이 스킬을 직접 첨부했습니다. 아래 지침을 따르세요.${sk.files.length ? ` 참고 파일은 read_skill_file 로 열 수 있습니다: ${sk.files.slice(0, 30).join(', ')}` : ''}\n\n${sk.body}`);
      } catch { /* 삭제된 스킬 */ }
    }
    return blocks.join('\n\n');
  }

  // ---------------- 컨텍스트 정리 (CONTEXT.md §5) ----------------
  // 대화 기록이 예산을 넘으면 최근 K개 사용자 턴만 남기고 그 앞을 요약 하나로 바꾼다.
  // 원래 메시지는 파일에 그대로 두고(화면에는 보임) 모델에게 보내는 것만 요약으로 대체한다.
  // 모델에게 매번 붙는 고정분(시스템 프롬프트 + 도구 정의) 추정
  overheadTokens(conv, settings) {
    return ctxPolicy.estimateTokens(this.systemPrompt(conv, conv.skills || [], true)) + ctxPolicy.estimateTokens(this.allToolDefs(settings, conv));
  }

  // 지금 대화가 다음 요청에서 차지할 토큰 (CONTEXT.md §5)
  // 정리 이후에 끝난 마지막 요청의 실제 사용량이 있으면 그 값을, 없으면 추정치를 쓴다
  contextTokens(conv, settings) {
    const msgs = conv.messages.filter((m) => !(m.role === 'assistant' && m.status === 'streaming'));
    const cutoff = conv.compaction ? msgs.findIndex((m) => m.id === conv.compaction.upToMessageId) : -1;
    const live = msgs.slice(cutoff + 1);
    const since = conv.compaction ? Date.parse(conv.compaction.createdAt) : 0;
    for (let i = live.length - 1; i >= 0; i--) {
      const m = live[i];
      if (m.role !== 'assistant' || !m.usage || !m.usage.prompt_tokens) continue;
      // 오래 진행한 응답의 종료 시각으로 판단하면 정리 전 usage를 정리 후 크기로 재사용하게 된다.
      const boundary = conv.compaction?.upToMessageId || null;
      if (Object.hasOwn(m, 'usageContextBoundary')) {
        if (m.usageContextBoundary !== boundary) continue;
      } else if (conv.compaction && Date.parse(m.createdAt) < since) continue;
      const u = m.usage;
      const reasoning = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0;
      return { tokens: u.prompt_tokens + Math.max(0, (u.completion_tokens || 0) - reasoning) + ctxPolicy.estimateMessages(live.slice(i + 1)), source: 'measured' };
    }
    return { tokens: ctxPolicy.estimateMessages(live) + this.overheadTokens(conv, settings), source: 'estimated' };
  }

  // 입력창 표시기용 정보
  contextInfo(conv, providerId, modelId) {
    const settings = this.store.getSettings();
    const provider = this.store.getProvider(providerId || conv.providerId || settings.activeProviderId);
    const model = modelId || conv.model || settings.activeModel || provider.models[0].id;
    const modelDef = provider.models.find((m) => m.id === model) || { id: model };
    const g = settings.generation;
    const { tokens, source } = this.contextTokens(conv, settings);
    const t = ctxPolicy.compactThreshold(g, modelDef);
    const archiveTokens = ctxPolicy.archiveTokens(conv), handoffThreshold = g.handoffAtTokens || POLICY.handoffAtTokens;
    return { tokens, source, archiveTokens, handoffThreshold, window: t.window, threshold: t.threshold, limitBy: t.limitBy, autoCompact: g.autoCompact, compacted: !!conv.compaction, handedOffTo: conv.handedOffTo || null, handoffAdvice: conv.handedOffTo ? null : ctxPolicy.handoffAdvice(conv, tokens, t.threshold, archiveTokens, handoffThreshold) };
  }

  // measured: 진행 중인 턴에서 방금 받은 실제 프롬프트 토큰. keepTurns: 남길 사용자 턴 수 강제
  async maybeCompact(conv, provider, model, send = () => {}, { force = false, signal, modelDef, measured, keepTurns } = {}) {
    const settings = this.store.getSettings();
    const g = settings.generation;
    if (!force && !g.autoCompact) return null;
    const def = modelDef || provider.models.find((m) => m.id === model) || { id: model };
    const { threshold } = ctxPolicy.compactThreshold(g, def);
    const msgs = conv.messages;
    // 끝의 빈 어시스턴트(지금 만드는 답)는 빼고 본다
    const last = msgs[msgs.length - 1];
    const body = last && last.role === 'assistant' && last.status === 'streaming' ? msgs.slice(0, -1) : msgs;
    const start = conv.compaction ? body.findIndex((m) => m.id === conv.compaction.upToMessageId) + 1 : 0;
    const live = body.slice(start);
    const tokens = measured || this.contextTokens(conv, settings).tokens;
    if (!force && tokens < threshold) return null;

    // 남길 사용자 턴 수를 정한다. 남긴 부분만으로도 기준의 절반을 넘으면 더 줄인다 (최소 1턴 = 지금 메시지)
    const userIdx = live.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
    if (!userIdx.length) return null;
    let keep = Math.max(1, Math.min(keepTurns || g.compactKeepTurns, userIdx.length));
    while (keep > 1 && ctxPolicy.estimateMessages(live.slice(userIdx[userIdx.length - keep])) > threshold / 2) keep--;
    const cut = userIdx[userIdx.length - keep];
    const toSummarize = live.slice(0, cut);
    if (!toSummarize.length) return null;

    send({ type: 'compacting', messages: toSummarize.length, tokens });
    let summary = conv.compaction?.summary || '';
    for (const chunk of handoffPolicy.transcriptChunks([{ ...conv, messages: toSummarize }])) {
      summary = handoffPolicy.redact((await llm.complete({
        provider, model, maxTokens: POLICY.summaryMaxTokens, signal,
        meta: { kind: 'compact', conversationId: conv.id, source: 'app' },
        messages: [
          { role: 'system', content: ctxPolicy.SUMMARY_PROMPT },
          { role: 'user', content: `${summary ? `# 이전 요약\n${summary}\n\n` : ''}# 새로 요약할 원문 조각\n${chunk}` }
        ]
      })).replace(/<think>[\s\S]*?<\/think>/g, '').trim());
      if (!summary) throw new Error('대화 요약을 만들지 못했습니다. 원문을 유지합니다.');
    }
    let sourceLedger;
    if (this.store.data) {
      const dir = path.join(this.store.data, 'handoffs'); fs.mkdirSync(dir, { recursive: true });
      const file = `compact-${conv.id}-${toSummarize.at(-1).id}.json`;
      fs.writeFileSync(path.join(dir, file), JSON.stringify({ version: 1, conversationId: conv.id, records: handoffPolicy.sourceRecords([{ ...conv, messages: toSummarize }]) }, null, 2));
      sourceLedger = `data/handoffs/${file}`;
    }

    conv.compaction = {
      summary,
      upToMessageId: toSummarize[toSummarize.length - 1].id,
      summarizedCount: (conv.compaction?.summarizedCount || 0) + toSummarize.length,
      count: (conv.compaction?.count || 0) + 1,
      tokensBefore: tokens,
      tokensAfter: 0,
      createdAt: now()
    };
    if (sourceLedger) conv.compaction.sourceLedger = sourceLedger;
    conv.compaction.tokensAfter = ctxPolicy.estimateMessages(live.slice(cut)) + this.overheadTokens(conv, settings);
    this.store.saveConversation(conv, false);
    send({ type: 'compacted', compaction: conv.compaction });
    return conv.compaction;
  }

  // ---------------- 핸드오프 (CONTEXT.md §9) ----------------
  // 인계서 초안: 넘겨받은 인계서 + 누적 요약 + 요약 이후 대화를 인계서 형식으로 다시 쓴다. 저장은 하지 않는다
  async handoffDraft(convId, { force = false, signal, onProgress } = {}) {
    const existing = this.handoffDrafts.get(convId);
    if (existing) {
      if (onProgress) existing.listeners.add(onProgress);
      if (onProgress && existing.lastProgress) onProgress(existing.lastProgress);
      return existing.promise;
    }
    if (!force && [...this.runs.values()].some((r) => r.convId === convId)) throw Object.assign(new Error('응답이 끝난 뒤에 인계서를 만들 수 있어요'), { status: 409 });
    const job = { listeners: new Set(onProgress ? [onProgress] : []) };
    this.handoffDrafts.set(convId, job);
    job.promise = this.buildHandoffDraft(convId, { signal, progress: (event) => {
      job.lastProgress = event;
      for (const listener of job.listeners) { try { listener(event); } catch {} }
    } });
    try { return await job.promise; }
    finally { if (this.handoffDrafts.get(convId) === job) this.handoffDrafts.delete(convId); }
  }

  async buildHandoffDraft(convId, { signal, progress }) {
    const conv = this.store.getConversation(convId);
    if (!conv.messages.length) throw Object.assign(new Error('인계할 대화가 없어요'), { status: 400 });
    const settings = this.store.getSettings();
    const provider = this.store.getProvider(conv.providerId || settings.activeProviderId);
    const model = conv.model || settings.activeModel || provider.models[0].id;
    // 요약 이후만 읽으면 요약에서 빠진 옛 작업은 영구 누락된다. 실제 선행 대화 전부를 순서대로 대조한다.
    const sources = handoffPolicy.lineage(this.store, conv.id);
    const snapshots = handoffPolicy.sourceSnapshots(sources);
    const input = [
      conv.handoff?.summary ? `# 이 대화가 넘겨받은 인계서\n${conv.handoff.summary}` : '',
      conv.systemPrompt.trim() ? `# 이 대화의 지침\n${conv.systemPrompt.trim()}` : '',
      (conv.skills || []).length ? `# 켜 둔 스킬\n${conv.skills.join(', ')}` : '',
    ].filter(Boolean).join('\n\n');
    const chunks = handoffPolicy.transcriptChunks(handoffPolicy.incrementalSources(sources, conv.handoff), 100000, { recentToolCount: 40 });
    // Keep evidence recorded only by the earlier compactor. Appending it after
    // stable originals preserves checkpoint reuse when compaction changes.
    if (conv.compaction?.summary) {
      const compacted = handoffPolicy.redact(`# 앞부분 정리의 확인 근거\n${conv.compaction.summary}`);
      for (let at = 0; at < compacted.length; at += 100000) chunks.push(compacted.slice(at, at + 100000));
    }
    const checkpoint = new HandoffCheckpoint({ directory: path.join(this.store.data, 'handoffs'), conversationId: conv.id, baseInput: input, chunks });
    const saved = checkpoint.read();
    let summary = saved.summary;
    progress({ type: 'handoff_progress', completed: saved.completed, total: chunks.length, reused: saved.completed });
    for (const [i, chunk] of chunks.entries()) {
      if (i < saved.completed) continue;
      signal?.throwIfAborted();
      summary = handoffPolicy.redact((await llm.complete({
        provider, model, maxTokens: POLICY.handoffMaxTokens, signal,
        meta: { kind: 'handoff', conversationId: conv.id, source: 'app' },
        messages: [{ role: 'system', content: ctxPolicy.HANDOFF_PROMPT }, { role: 'user', content: `${handoffPolicy.redact(input)}\n\n# 누적 인계서\n${summary || '(처음)'}\n\n# 원문 조각 ${i + 1}/${chunks.length}\n${chunk}` }]
      })).replace(/<think>[\s\S]*?<\/think>/g, '').trim());
      handoffPolicy.validateSummary(summary);
      checkpoint.commit(i, summary);
      progress({ type: 'handoff_progress', completed: i + 1, total: chunks.length, reused: saved.completed });
    }
    const records = handoffPolicy.sourceRecords(sources);
    summary += `\n\n## 원문 보존과 복구\n대화 ${sources.length}개, 사용자 지시 ${records.filter(r => ['user','steer'].includes(r.type)).length}건을 순서대로 대조했습니다. 원문은 삭제되지 않습니다. 요약에 없으면 search_previous_conversation으로 모든 선행 대화를 검색하고 read_previous_conversation으로 메시지 원문을 이어 읽습니다. 오래된 지시와 최신 교정이 충돌하면 최신 사용자 지시를 적용합니다.`;
    const all = sources.flatMap(c => [...(c.handoff?.files || []), ...ctxPolicy.collectFiles(c.messages, 100)]);
    const files = all.filter((x, i) => all.findIndex((y) => y.ref === x.ref) === i).slice(-POLICY.handoffFiles);
    checkpoint.finish({ summary, files });
    return { summary, files, sourceSnapshots: snapshots };
  }

  // 인계서로 새 대화를 만든다. 공급자·모델·지침·스킬은 그대로 가져간다
  createHandoff(convId, { summary, files, sourceSnapshots, autoResume = false, resumeOptions }) {
    const from = this.store.getConversation(convId);
    if (from.handedOffTo) return this.store.getConversation(from.handedOffTo);
    if (!summary || !String(summary).trim()) throw Object.assign(new Error('인계서 내용이 비어 있어요'), { status: 400 });
    if (String(summary).length > 80000) throw new Error('인계서 저장 한도를 넘었습니다. 기존 대화를 유지합니다.');
    // 인계서보다 원문 목록을 먼저 저장한다. 저장 실패 시 기존 대화를 닫거나 새 대화를 만들지 않는다.
    const sources = handoffPolicy.lineage(this.store, from.id);
    const records = handoffPolicy.sourceRecords(sources);
    const dir = path.join(this.store.data, 'handoffs');
    fs.mkdirSync(dir, { recursive: true });
    const ledgerName = `${from.id}-sources.json`;
    fs.writeFileSync(path.join(dir, ledgerName), JSON.stringify({ version: 1, sourceConversationIds: sources.map(c => c.id), records }, null, 2));
    const baseTitle = from.title.replace(/\s*\(이어서(?: \d+)?\)$/, '');
    const depth = (from.handoff?.depth || 0) + 1;
    const next = this.store.createConversation({
      title: `${baseTitle} (이어서${depth > 1 ? ` ${depth}` : ''})`,
      providerId: from.providerId, model: from.model, systemPrompt: from.systemPrompt, skills: from.skills || [], projectId: from.projectId || null, queueJobId: from.queueJobId || null
    });
    next.handoff = {
      fromConversationId: from.id, fromTitle: from.title, summary: String(summary).trim(),
      sourceLedger: `data/handoffs/${ledgerName}`,
      sourceMessageCount: sources.reduce((n, c) => n + c.messages.length, 0),
      userInstructionCount: records.filter(r => ['user', 'steer'].includes(r.type)).length,
      resumeState: 'pending',
      autoResume,
      ...(resumeOptions ? { resumeOptions } : {}),
      ...(sourceSnapshots ? { sourceSnapshots } : {}),
      ...(sourceSnapshots ? { sourceSummaryHash: require('node:crypto').createHash('sha256').update(String(summary).trim()).digest('hex') } : {}),
      files: (Array.isArray(files) ? files : []).filter((x) => x && x.ref).slice(-POLICY.handoffFiles)
        .map((x) => ({ label: String(x.label || '파일').slice(0, 120), ref: String(x.ref).slice(0, 1000) })),
      depth, createdAt: now()
    };
    if (from.watch && from.watch.enabled) {
      next.watch = { ...from.watch, seen: null, note: '이전 대화에서 이어받음' };
      from.watch = { ...from.watch, enabled: false, state: 'off', note: '새 대화로 넘김' };
    }
    this.store.saveConversation(next, false);
    from.handedOffTo = next.id;
    this.store.saveConversation(from, false);
    // 사람이 열어 볼 수 있게 MD 로도 남긴다 (data/handoffs/<새 대화 id>.md)
    try {
      const dir = path.join(this.store.data, 'handoffs');
      fs.mkdirSync(dir, { recursive: true });
      const list = next.handoff.files.map((x) => `- ${x.label}: ${x.ref}`).join('\n');
      fs.writeFileSync(path.join(dir, `${next.id}.md`), `<!-- 원래 대화 ${from.id} → 새 대화 ${next.id} · ${next.handoff.createdAt} -->\n${next.handoff.summary}${list ? `\n\n## 관련 파일 (자동 수집)\n${list}` : ''}\n`);
    } catch (e) { console.error('[handoff] MD 저장 실패', e.message); }
    return next;
  }

  // 인계서를 나중에 고칠 때
  updateHandoff(convId, summary) {
    const conv = this.store.getConversation(convId);
    if (!conv.handoff) throw Object.assign(new Error('인계받은 대화가 아니에요'), { status: 400 });
    if (!summary || !String(summary).trim()) throw Object.assign(new Error('인계서 내용이 비어 있어요'), { status: 400 });
    conv.handoff.summary = String(summary).trim();
    // 사람이 수정한 인계서를 이전 원문 전체의 검증된 요약으로 간주하지 않는다.
    delete conv.handoff.sourceSnapshots;
    delete conv.handoff.sourceSummaryHash;
    this.store.saveConversation(conv, false);
    return conv.handoff;
  }

  // 원래 대화 검색 (search_previous_conversation)
  searchPrevious(convId, query, limit) {
    const conv = this.store.getConversation(convId);
    let sources;
    try { sources = handoffPolicy.lineage(this.store, conv.id); } catch (e) { return `원문 연결을 확인할 수 없습니다: ${e.message}`; }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 'query 를 입력하세요.';
    const hits = [];
    const scan = (text, where) => {
      const low = (text || '').toLowerCase();
      if (!words.every((w) => low.includes(w))) return;
      const at = low.indexOf(words[0]);
      hits.push(`[${where}] …${text.slice(Math.max(0, at - 300), at + 500).replace(/\s+/g, ' ')}…`);
    };
    for (const src of sources) src.messages.forEach((m, i) => {
      if (m.role === 'user') scan(m.content, `${src.id}/${m.id} #${i} 사용자`);
      for (const p of m.parts || []) {
        if (p.type === 'text' || p.type === 'steer') scan(p.text, `${src.id}/${m.id} #${i} ${p.type}`);
        else if (p.type === 'tool_call') scan(`${p.arguments}\n${p.result}`, `${src.id}/${m.id} #${i} ${p.name}`);
      }
    });
    if (!hits.length) return `"${query}"와 일치하는 내용이 선행 대화 ${sources.length}개에 없습니다.`;
    return handoffPolicy.redact(`선행 대화 ${sources.length}개에서 ${hits.length}곳 찾음${hits.length > limit ? ` (마지막 ${limit}곳만 표시)` : ''}\n\n${hits.slice(-limit).join('\n\n')}`);
  }

  readPrevious(convId, args) {
    const sources = handoffPolicy.lineage(this.store, convId);
    if (!args.conversation_id) return JSON.stringify({ sources: sources.map(c => ({ id: c.id, title: c.title, messages: c.messages.length })) });
    const src = sources.find(c => c.id === args.conversation_id);
    if (!src) throw new Error('현재 대화 또는 그 선행 대화만 읽을 수 있습니다.');
    const m = args.message_id ? src.messages.find(m => m.id === args.message_id) : src.messages[Math.max(0, Number(args.index) || 0)];
    if (!m) throw new Error('해당 원문 메시지가 없습니다.');
    const raw = handoffPolicy.redact(JSON.stringify(m, null, 2));
    const offset = Math.max(0, Number(args.offset) || 0), size = Math.max(100, Math.min(30000, Number(args.max_chars) || 12000));
    return JSON.stringify({ conversationId: src.id, messageId: m.id, index: src.messages.indexOf(m), totalChars: raw.length, text: raw.slice(offset, offset + size), nextOffset: offset + size < raw.length ? offset + size : null, nextIndex: src.messages.indexOf(m) + 1 < src.messages.length ? src.messages.indexOf(m) + 1 : null });
  }

  // 사용자가 메뉴에서 직접 정리할 때
  async compactNow(convId) {
    if ([...this.runs.values()].some((r) => r.convId === convId)) throw Object.assign(new Error('응답이 끝난 뒤에 정리할 수 있어요'), { status: 409 });
    const conv = this.store.getConversation(convId);
    const settings = this.store.getSettings();
    const provider = this.store.getProvider(conv.providerId || settings.activeProviderId);
    const model = conv.model || settings.activeModel || provider.models[0].id;
    const r = await this.maybeCompact(conv, provider, model, () => {}, { force: true });
    if (!r) throw Object.assign(new Error('정리할 만큼 쌓인 대화가 없어요'), { status: 400 });
    return r;
  }

  async titleFor(conv, provider, model) {
    const first = conv.messages.find((m) => m.role === 'user');
    const fallback = (first?.content || '새 대화').replace(/\s+/g, ' ').trim().slice(0, 40) || '새 대화';
    if (!this.store.getSettings().generation.autoTitle) return fallback;
    try {
      const t = await llm.complete({
        provider, model, maxTokens: 40, signal: AbortSignal.timeout(20000), meta: { kind: 'title', conversationId: conv.id, source: 'app' },
        messages: [
          { role: 'system', content: '대화 내용을 보고 15자 안팎의 짧은 제목만 출력하세요. 따옴표, 마침표, 설명 없이 제목만.' },
          { role: 'user', content: (first?.content || '').slice(0, 2000) }
        ]
      });
      const clean = t.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/["'「」]/g, '').split('\n').map((x) => x.trim()).filter(Boolean)[0];
      return (clean || fallback).slice(0, 60);
    } catch { return fallback; }
  }

  // ---------------- 메인 실행 ----------------
  async handle(req, res, body) {
    const settings = this.store.getSettings();
    let conv = this.store.getConversation(body.conversationId);
    let followed = null;
    if (!(req && req.headless) && !body.regenerate && conv.handedOffTo) {
      let c = conv;
      while (c.handedOffTo) { try { c = this.store.getConversation(c.handedOffTo); } catch { break; } }
      if (c !== conv) { conv = c; followed = c; }
    }
    const opts = body.options || {};
    if (this.isBusy(conv.id)) throw Object.assign(new Error('이 대화의 응답이 이미 진행 중입니다. 중복 실행하지 않습니다.'), { status: 409 });
    const provider = this.store.getProvider(opts.providerId || conv.providerId || settings.activeProviderId);
    const model = opts.model || conv.model || settings.activeModel || provider.models[0].id;
    const modelDef = provider.models.find((m) => m.id === model) || { id: model, vision: false, tools: true, reasoning: true };
    conv.providerId = provider.id;
    // 메시지를 고쳐 보내며 정리 기준 메시지가 사라졌으면 정리 기록도 무효 (요약과 원문이 겹쳐 실리는 걸 막는다)
    if (conv.compaction && !conv.messages.some((m) => m.id === conv.compaction.upToMessageId)) conv.compaction = null;
    conv.model = model;

    const runId = newId();
    const controller = new AbortController();
    const run = { controller, approvals: new Map(), allowAll: new Set(req?._handoffAllowAll || []), convId: conv.id, sourceConvIds: new Set([body.conversationId, conv.id]), headless: !!(req && req.headless), job: (req && req.job) || null, watch: !!(req && req.watch), steer: [], statusSeen: new Map() };
    this.runs.set(runId, run);
    let keepAlive;
    try {
    const parent = this.runs.get(req?._handoffParentRunId);
    if (parent) parent.continuationRunId = runId;
    run.steer.push(...(req?._handoffPendingSteer || []));
    let handoffFailed = false;
    const canHandoff = !run.headless && !body.regenerate && settings.generation.autoHandoff !== false;
    if (conv.handoff?.resumeState === 'pending') { conv.handoff.resumeState = 'running'; this.store.saveConversation(conv, false); }

    if (!req?._handoffContinuation) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    keepAlive = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    if (followed) send({ type: 'handoff', conversation: followed, reason: '이미 새 대화로 인계된 대화예요' });

    // 자동 인계 (CONTEXT.md §9): 정리해도 무거운 대화면, 새 메시지를 받기 전에 인계서를 만들어 새 대화로 옮기고 거기서 이어 간다
    if (canHandoff && !conv.handedOffTo) {
      const info = this.contextInfo(conv, provider.id, model);
      if (info.handoffAdvice) {
        send({ type: 'handoff_start', runId, reason: info.handoffAdvice });
        try {
          const draft = await this.handoffDraft(conv.id, { force: true, signal: controller.signal, onProgress: send });
          controller.signal.throwIfAborted();
          const next = this.createHandoff(conv.id, { ...draft, autoResume: true, resumeOptions: { providerId: provider.id, model, tools: opts.tools !== false, thinking: opts.thinking ?? settings.generation.thinking } });
          next.providerId = provider.id;
          next.model = model;
          next.handoff.resumeState = 'running';
          this.store.saveConversation(next, false);
          conv = next;
          run.convId = conv.id;
          run.sourceConvIds.add(conv.id);
          send({ type: 'handoff', conversation: conv, reason: info.handoffAdvice });
        } catch (e) {
          if (controller.signal.aborted) throw e;
          handoffFailed = true;
          send({ type: 'handoff_failed', message: e.message || String(e) });
        }
      }
    }

    // 사용자 메시지
    let userMsg = null;
    if (!body.regenerate) {
      userMsg = { id: newId(), role: 'user', createdAt: now(), content: body.content || '', attachments: body.attachments || [], skills: body.skills || [], parts: [], status: 'complete', error: '', model: '', usage: null, durationMs: null };
      conv.messages.push(userMsg);
    } else {
      while (conv.messages.length && conv.messages[conv.messages.length - 1].role === 'assistant') conv.messages.pop();
      userMsg = conv.messages[conv.messages.length - 1] || null;
      if (!userMsg) { send({ type: 'error', message: '다시 생성할 사용자 메시지가 없습니다' }); clearInterval(keepAlive); this.runs.delete(runId); res.end(); return; }
    }
    const lastUser = userMsg;
    if (conv.handoff?.resumeState === 'running' && conv.handoff.autoResume) {
      conv.handoff.resumeMessageId = userMsg.id;
    }
    // 미뤄 둔 백그라운드 확인 결과가 있으면 이번 실행 첫 단계에 싣는다 (CONTEXT.md §15)
    if (this.bg) for (const n of this.bg.takeNotes(conv)) run.steer.push(n);
    const turnImages = (lastUser.attachments || []).filter((a) => a.kind === 'image').map((a) => { try { return this.imageDataUrl(a); } catch { return null; } }).filter(Boolean);

    const asst = { id: newId(), role: 'assistant', createdAt: now(), content: '', attachments: [], skills: [], parts: [], status: 'streaming', error: '', model, usage: null, durationMs: null, requestIds: [] };
    conv.messages.push(asst);
    this.store.saveConversation(conv);
    send({ type: 'start', runId, userMessage: body.regenerate ? null : userMsg, assistantMessage: asst });

    const t0 = Date.now();
    const parts = asst.parts;
    Object.assign(run, { parts, conversation: conv, send });
    const pushDelta = (type, delta) => {
      const last = parts[parts.length - 1];
      if (last && last.type === type) last.text += delta;
      else parts.push(type === 'reasoning' ? { type, text: delta, durationMs: null } : { type, text: delta });
      send({ type, delta });
    };
    const ctx = { settings, visionAvailable: !!modelDef.vision, store: this.store, skills: this.skills, signal: controller.signal, turnImages, turnAttachments: lastUser.attachments || [], allAttachments: conv.messages.flatMap((m) => [...(m.attachments || []), ...(m.parts || []).flatMap(p => p.type === 'steer' ? p.attachments || [] : [])]), mcp: this.mcp, terminal: this.terminal, meta: { conversationId: conv.id, messageId: asst.id, source: 'app' } };
    run.toolContext = ctx;
    // 대기열 작업: 도구 안에서 여러 번 생성하는 경우(convert_panels) 매번 유료 승인·상한을 확인한다. 막히면 이유 문자열
    if (run.job && this.queue) {
      ctx.paidGuard = (kind) => {
        const job = this.queue.get(run.job.id) || run.job;
        const ap = job.approval || {};
        if (!ap[kind]) return '대기열 승인 범위 밖 (이미지 생성 미승인)';
        if (ap.maxPaidCalls != null && job.paidCalls >= ap.maxPaidCalls) return `유료 호출 상한 ${ap.maxPaidCalls}회 도달`;
        this.queue.notePaid(job.id);
        return '';
      };
    }
    const addRequestId = (id) => { if (id && !asst.requestIds.includes(id)) { asst.requestIds.push(id); send({ type: 'request', requestId: id }); } };
    const firstTurn = conv.messages.filter((m) => m.role === 'user').length === 1;

    try {
      if (opts.imageMode) {
        // 이미지 모드: LLM 없이 바로 생성
        if (!lastUser.content.trim()) throw new Error('이미지 프롬프트를 입력하세요');
        const imgs = await tools.runImage({ prompt: lastUser.content, useAttached: turnImages.length > 0 }, ctx);
        for (const im of imgs) { parts.push(im); send({ type: 'image', part: im }); }
        if (imgs.referenceAdjustments && imgs.referenceAdjustments.length) {
          pushDelta('text', imgs.referenceAdjustments.map(a => '참조 ' + a.reference + ': 원본 ' + a.original.width + '×' + a.original.height + ' 보존, AI 전송용 사본 ' + a.sent.width + '×' + a.sent.height + '.').join('\n'));
        }
      } else {
        const toolsOn = opts.tools !== false && modelDef.tools !== false;
        const project = this.store.getProject(conv.projectId);
        const skillNames = [...new Set([...(conv.skills || []), ...((project && project.skills) || []), ...(lastUser.skills || [])])];
        // 대화가 예산을 넘으면 오래된 턴을 요약으로 정리한다 (CONTEXT.md §5)
        await this.maybeCompact(conv, provider, model, send, { signal: controller.signal, modelDef });
        let system = this.systemPrompt(conv, skillNames, toolsOn, { queue: !!run.job });
        let history = await this.buildHistory({ ...conv, messages: conv.messages.slice(0, -1) }, modelDef);
        const toolDefs = toolsOn ? this.allToolDefs(settings, conv, { queue: !!run.job }) : [];
        const thinking = opts.thinking ?? settings.generation.thinking;

        // 모델 호출 한도 (CONTEXT.md §12): 기본 maxRounds, 추가 지시가 올 때마다 여유를 더 준다(최대 2배).
        // 마지막 한 번은 도구를 막고 보고만 하게 해서, 한도에 닿아도 말없이 끊기지 않게 한다.
        const baseRounds = settings.tools.maxRounds;
        let budget = baseRounds;
        for (let round = 0; round < budget; round++) {
          const loopMsgs = [];
          // 응답 중에 받은 추가 지시를 이번 단계부터 반영한다
          while (run.steer.length) {
            const incoming = run.steer.shift();
            const sp = typeof incoming === 'string' ? { type: 'steer', text: incoming, createdAt: now() } : incoming;
            sp.delivery = 'applied';
            for (const a of sp.attachments || []) {
              if (!ctx.turnAttachments.some(item => item.id === a.id)) {
                ctx.turnAttachments = [...ctx.turnAttachments, a]; ctx.allAttachments = [...ctx.allAttachments, a];
                if (a.kind === 'image') ctx.turnImages.push(this.imageDataUrl(a));
              }
            }
            if (!parts.includes(sp)) parts.push(sp);
            this.store.saveConversation(conv);
            send({ type: 'steer', part: sp });
            budget = Math.min(budget + POLICY.steerBonusRounds, baseRounds * 2);
          }
          // L4 진행 중인 턴: 최근 도구 결과 몇 개만 원문, 그 앞은 줄인다 (CONTEXT.md §4)
          await this.appendAssistant(loopMsgs, parts, {
            withReasoning: settings.generation.resendReasoningInToolLoop && thinking,
            imageFeedback: !!modelDef.vision,
            skipPendingSteer: true,
            resultCap: POLICY.turnToolResultCap,
            keepFullLast: POLICY.turnKeepFullResults
          });
          const finalRound = round > 0 && round === budget - 1;
          if (finalRound) loopMsgs.push({ role: 'user', content: ctxPolicy.LIMIT_NOTE(budget) });
          const requestEstimate = ctxPolicy.estimateTokens([{ role: 'system', content: system }, ...history, ...loopMsgs]) + ctxPolicy.estimateTokens(toolDefs);
          const budgetThreshold = ctxPolicy.compactThreshold(settings.generation, modelDef).threshold;
          if (canHandoff && !handoffFailed && this.contextInfo(conv, provider.id, model).handoffAdvice) {
            asst.stopReason = 'context_handoff';
            pushDelta('text', '\n\n컨텍스트 전환 기준에 도달했습니다. 사용자 지침과 진행 중인 작업을 원문과 대조해 다음 대화로 인계합니다.');
            break;
          }
          if (settings.generation.autoCompact && requestEstimate >= budgetThreshold) {
            const compacted = await this.maybeCompact(conv, provider, model, send, { signal: controller.signal, modelDef, measured: requestEstimate, keepTurns: 1 });
            if (compacted) {
              system = this.systemPrompt(conv, skillNames, toolsOn, { queue: !!run.job });
              history = await this.buildHistory({ ...conv, messages: conv.messages.slice(0, -1) }, modelDef);
            }
          }
          const rStart = Date.now();
          const requestBoundary = conv.compaction?.upToMessageId || null;
          const modelController = new AbortController();
          run.modelController = modelController;
          const callModel = () => llm.streamChat({
            provider, model, tools: toolDefs, signal: AbortSignal.any([controller.signal, modelController.signal]),
            messages: [{ role: 'system', content: system }, ...history, ...loopMsgs],
            params: { thinking, temperature: settings.generation.temperature, maxTokens: settings.generation.maxTokens, toolChoice: finalRound ? 'none' : undefined },
            onText: (d) => pushDelta('text', d),
            onReasoning: (d) => pushDelta('reasoning', d),
            onRetry: (info) => send({ type: 'retry', ...info }),
            meta: ctx.meta
          });
          // 응답을 받던 중 연결이 끊기면 이번 단계에서 받은 조각을 되감고 같은 단계를 다시 요청한다
          let r;
          for (let netTry = 0; ; netTry++) {
            const snap = parts.length, tail = parts[snap - 1], tailLen = tail && typeof tail.text === 'string' ? tail.text.length : null;
            try { r = await callModel(); break; } catch (e) {
              if (modelController.signal.aborted && !controller.signal.aborted && run.steer.length) { r = null; break; }
              if (!e.partial || controller.signal.aborted || netTry >= 2) throw e;
              const pendingSteer = parts.slice(snap).filter(p => p.type === 'steer');
              parts.length = snap;
              parts.push(...pendingSteer);
              if (tailLen != null) tail.text = tail.text.slice(0, tailLen);
              send({ type: 'reset', parts });
              send({ type: 'retry', wait: 5, attempt: netTry + 1, max: 3, reason: 'network' });
              await sleepFor(5000, controller.signal);
            }
          }
          if (run.modelController === modelController) run.modelController = null;
          if (!r) { budget = Math.min(budget + POLICY.steerBonusRounds, baseRounds * 2); continue; }
          addRequestId(r.requestId);
          const lastReason = [...parts].reverse().find((p) => p.type === 'reasoning');
          if (lastReason && lastReason.durationMs == null) lastReason.durationMs = Date.now() - rStart;
          if (r.usage) { asst.usage = r.usage; asst.usageContextBoundary = requestBoundary; send({ type: 'usage', usage: r.usage }); }
          const promptTokens = r.usage && r.usage.prompt_tokens;
          if (promptTokens) asst.contextPeakTokens = Math.max(asst.contextPeakTokens || 0, promptTokens);
          if (promptTokens) {
            const t = ctxPolicy.compactThreshold(settings.generation, modelDef);
            send({ type: 'context', context: { tokens: promptTokens, source: 'measured', window: t.window, threshold: t.threshold, limitBy: t.limitBy, autoCompact: settings.generation.autoCompact, compacted: !!conv.compaction } });
            // 도구를 이어 부르는 중에 기준을 넘으면 지난 턴을 바로 요약하고 이번 턴만 원문으로 이어 간다
            if (r.toolCalls.length && settings.generation.autoCompact && promptTokens >= t.threshold) {
              const done = await this.maybeCompact(conv, provider, model, send, { signal: controller.signal, modelDef, measured: promptTokens, keepTurns: 1 });
              if (done) {
                system = this.systemPrompt(conv, skillNames, toolsOn, { queue: !!run.job });
                history = await this.buildHistory({ ...conv, messages: conv.messages.slice(0, -1) }, modelDef);
              }
            }
          }
          // 한도 보고를 마쳤으면 끝낸다 (그래도 도구를 부르면 실행하지 않는다)
          if (finalRound) { asst.stopReason = 'max_rounds'; break; }
          // 도구 호출 없이 끝났어도 그사이 추가 지시가 왔으면 한 단계 더 진행한다
          if (!r.toolCalls.length) { if (run.steer.length && round < budget - 1) continue; break; }

          for (const call of r.toolCalls) {
            const part = { type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments, status: 'pending', result: '', isError: false, durationMs: null };
            parts.push(part);
            send({ type: 'tool_call', part });
          }
          this.store.saveConversation(conv);

          for (const part of parts.filter((p) => p.type === 'tool_call' && p.status === 'pending')) {
            if (run.steer.some(p => typeof p === 'object' && p.immediate)) {
              part.status = 'denied'; part.isError = true; part.result = '사용자의 즉시 추가 지시가 도착해 아직 시작하지 않은 도구를 실행하지 않았습니다.';
              send({ type: 'tool_status', id: part.id, status: part.status, result: part.result, isError: true });
            } else {
              run.currentTool = part;
              try { await this.runTool(part, ctx, run, runId, send, parts); } finally { run.currentTool = null; }
            }
            this.store.saveConversation(conv);
          }
          if (canHandoff && !handoffFailed && this.contextInfo(conv, provider.id, model).handoffAdvice) {
            asst.stopReason = 'context_handoff';
            pushDelta('text', '\n\n이번에 받은 도구 요청은 처리했습니다. 결과를 보존하고 다음 대화로 이어갑니다.');
            break;
          }
          // 한도가 1회뿐이라 보고 단계를 둘 수 없는 경우
          if (round === budget - 1) { asst.stopReason = 'max_rounds'; pushDelta('text', `\n\n_(모델 호출 한도 ${budget}회에 도달해 멈췄습니다)_`); }
        }
      }
      asst.status = 'complete';
    } catch (e) {
      addRequestId(e.requestId);
      if (controller.signal.aborted) asst.status = 'stopped';
      else { asst.status = 'error'; asst.error = e.message || String(e); send({ type: 'error', message: asst.error }); }
    } finally {
      // 반영하지 못한 추가 지시는 돌려준다 (입력창에 다시 넣음)
      if (run.steer.length) {
        const entries = run.steer.splice(0).map(p => typeof p === 'string' ? { text: p, attachments: [] } : p);
        send({ type: 'steer_dropped', texts: entries.map(p => p.text), attachments: entries.flatMap(p => p.attachments || []) });
      }
      for (const p of parts) if (p.type === 'tool_call' && ['pending', 'running', 'awaiting_approval', 'awaiting_answer'].includes(p.status)) { p.status = 'error'; p.result = p.result || '중단됨'; p.isError = true; }
      for (const p of parts) if (p.requestId) addRequestId(p.requestId);
      asst.durationMs = Date.now() - t0;
      asst.content = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      if (conv.handoff?.resumeState === 'running') conv.handoff.resumeState = asst.status === 'error' ? 'error' : asst.status === 'stopped' ? (run.stopRequested ? 'stopped' : 'pending') : 'done';
      this.store.saveConversation(conv);
      send({ type: 'done', message: asst });
    }

    if (firstTurn && (conv.title === '새 대화' || !conv.title) && asst.status !== 'error' && !res.writableEnded) {
      conv.title = opts.imageMode ? lastUser.content.slice(0, 40) : await this.titleFor(conv, provider, model);
      this.store.saveConversation(conv, false);
      send({ type: 'title', title: conv.title });
    }
    if (canHandoff && !opts.imageMode && !handoffFailed && asst.status === 'complete' && !conv.handedOffTo && !res.writableEnded) {
      try {
        const info = this.contextInfo(conv, provider.id, model);
        if (info.handoffAdvice) {
          send({ type: 'handoff_prepare', reason: info.handoffAdvice });
          const draft = await this.handoffDraft(conv.id, { force: true, signal: controller.signal, onProgress: send });
          controller.signal.throwIfAborted();
          const next = this.createHandoff(conv.id, { ...draft, autoResume: true, resumeOptions: { providerId: provider.id, model, tools: opts.tools !== false, thinking: opts.thinking ?? settings.generation.thinking } });
          next.providerId = provider.id;
          next.model = model;
          this.store.saveConversation(next, false);
          send({ type: 'handoff_ready', conversation: { id: next.id, title: next.title }, reason: info.handoffAdvice });
          send({ type: 'handoff', conversation: next, reason: '인계 완료 — 다음 작업 자동 재개' });
          await this.resumeHandoff(Object.assign(Object.create(req || null), { _handoffParentRunId: runId }), res, next, opts, run.allowAll);
        }
      } catch (e) { send({ type: 'handoff_failed', message: e.message || String(e) }); }
    }
    if (run.steer.length) {
      const entries = run.steer.splice(0).map(p => typeof p === 'string' ? { text: p, attachments: [] } : p);
      send({ type: 'steer_dropped', texts: entries.map(p => p.text), attachments: entries.flatMap(p => p.attachments || []) });
    }
    if (!res.writableEnded) res.end();
    } finally {
      clearInterval(keepAlive);
      this.runs.delete(runId);
    }
  }

  async resumeHandoff(req, res, next, options, allowAll = new Set()) {
    const parent = this.runs.get(req?._handoffParentRunId);
    if (res.writableEnded || res.destroyed || req?.aborted || parent?.controller.signal.aborted) return false;
    if (next.handoff?.resumeState !== 'pending' || this.isBusy(next.id)) return false;
    next.handoff.resumeState = 'running';
    this.store.saveConversation(next, false);
    try {
      await this.handle(Object.assign(Object.create(req || null), { _handoffContinuation: true, _handoffAllowAll: [...allowAll], _handoffPendingSteer: parent?.steer.splice(0) || [] }), res, {
        conversationId: next.id, options: { ...options, imageMode: false },
        content: '[자동 인계 재개] 사용자 지침·최신 교정·작업별 남은 일을 먼저 대조하고 직전 미완료 작업부터 이어서 진행한다. 요약에 없는 작업은 모든 선행 대화 원문을 검색한다. 제출된 job과 기존 결과는 상태부터 확인하고 중복 실행하지 않는다. 유료 승인·범위는 확대하지 않는다. 할 일이 이미 끝났거나 사용자 답이 필수라면 그 사실만 보고한다.'
      });
      const fresh = this.store.getConversation(next.id);
      const last = [...fresh.messages].reverse().find(m => m.role === 'assistant');
      if (fresh.handoff.resumeState === 'running') fresh.handoff.resumeState = last?.status === 'error' ? 'error' : last?.status === 'stopped' ? 'pending' : last?.status === 'complete' ? 'done' : 'pending';
      this.store.saveConversation(fresh, false);
      return true;
    } catch (e) {
      next.handoff.resumeState = 'error'; this.store.saveConversation(next, false); throw e;
    }
  }

  recoverHandoffStates() {
    let recovered = 0;
    for (const row of this.store.listConversations()) {
      const conv = this.store.getConversation(row.id);
      if (!conv.handoff?.autoResume || conv.handedOffTo || conv.queueJobId || this.isBusy(conv.id) || conv.handoff.resumeState !== 'running') continue;
      const last = [...conv.messages].reverse().find(m => m.role === 'assistant');
      if (last?.status === 'complete') conv.handoff.resumeState = 'done';
      else {
        if (last?.status === 'streaming') {
          last.status = 'stopped';
          last.error = '서버 연결이 끊겼습니다. 기존 도구 결과를 먼저 확인하고 이어갑니다.';
          for (const part of last.parts || []) if (part.type === 'tool_call' && ['pending', 'running', 'awaiting_approval', 'awaiting_answer'].includes(part.status)) {
            part.status = 'error'; part.isError = true;
            part.result = `${part.result ? part.result + '\n\n' : ''}요청 결과 미확인: 외부 상태를 조회하기 전 자동 재실행하지 않습니다.`;
          }
        }
        conv.handoff.resumeState = 'pending';
        conv.handoff.recoveryCount = (conv.handoff.recoveryCount || 0) + 1;
        recovered++;
      }
      this.store.saveConversation(conv, false);
    }
    return recovered;
  }

  mcpOpts() {
    const t = this.store.getSettings().tools;
    return { limit: t.mcpDirectLimit, pinned: t.mcpPinned };
  }

  // 내장 도구 + 직접 넘길 MCP 도구 + (숨긴 MCP 서버가 있으면) mcp_tools / mcp_call
  allToolDefs(settings, conv = null, opts = {}) {
    const direct = this.mcp.directServers(this.mcpOpts());
    const defs = [...tools.definitions(settings, this.skills.list().length), ...this.mcp.toolDefinitions(direct)];
    const queueRun = !!(conv && conv.queueJobId && opts.queue);
    defs.push(ASK_TOOL);
    defs.push(POLL_TOOL);
    if (this.queue && settings.tools.enableQueue) {
      const mayRegister = this.queue.load().settings.allowModelRegistration === true && !conv?.queueJobId;
      defs.push(...QUEUE_TOOLS.filter(t => t.function.name !== 'queue_add' || mayRegister));
    }
    if (this.queue && queueRun) defs.push(CHECKPOINT_TOOL);
    if (this.browser && settings.tools.enableBrowser) defs.push(...BROWSER_TOOLS);
    if (conv && (conv.handoff || conv.compaction)) {
      defs.push({ type: 'function', function: {
        name: 'search_previous_conversation',
        description: '모든 선행 대화의 사용자 지시·추가 교정·도구 결과를 검색한다. 누락된 옛 작업과 정확한 조건을 복구한다. 결과의 conversationId/messageId를 read_previous_conversation에 넣으면 잘린 부분도 읽는다.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: '찾을 말 (여러 단어면 모두 포함된 곳)' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 } }, required: ['query'], additionalProperties: false }
      } });
    }
    if (conv) defs.push({ type: 'function', function: {
      name: 'read_previous_conversation',
      description: '현재 대화와 연결된 모든 선행 대화의 원문을 읽는다. 인자 없이 대화/메시지 수 목록을 받고 conversation_id와 message_id 또는 index로 메시지를 지정한다. nextOffset이 있으면 offset으로 끝까지 이어 읽는다. 다른 작업 대화는 접근하지 않는다.',
      parameters: { type: 'object', properties: { conversation_id: { type: 'string' }, message_id: { type: 'string' }, index: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 100, maximum: 30000 } }, additionalProperties: false }
    } });
    const hidden = this.mcp.status().filter((s) => s.status === 'connected' && s.tools.length && !direct.has(s.name)).map((s) => s.name);
    if (hidden.length) {
      defs.push({ type: 'function', function: {
        name: 'mcp_tools',
        description: `MCP 서버의 도구를 이름·설명으로 찾아 사용법(입력 스키마)을 보여준다. 대상 서버: ${hidden.join(', ')}. 찾은 도구는 mcp_call 로 호출한다.`,
        parameters: { type: 'object', properties: { server: { type: 'string', enum: hidden }, query: { type: 'string', description: '찾을 말 (예: "text to speech", "generate video"). 비우면 그 서버 도구 전체' } }, additionalProperties: false }
      } });
      defs.push({ type: 'function', function: {
        name: 'mcp_call',
        description: 'MCP 서버의 도구를 이름으로 호출한다. 인자 형식은 mcp_tools 로 먼저 확인한다.',
        parameters: { type: 'object', properties: { server: { type: 'string', enum: hidden }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['server', 'tool'], additionalProperties: false }
      } });
    }
    return defs;
  }

  async runTool(part, ctx, run, runId, send, parts) {
    const t0 = Date.now();
    let args = {};
    try { args = part.arguments.trim() ? JSON.parse(part.arguments) : {}; } catch (e) {
      Object.assign(part, { status: 'error', isError: true, result: `도구 인자 JSON 파싱 실패: ${e.message}. 올바른 JSON 으로 다시 호출하세요.` });
      send({ type: 'tool_status', id: part.id, status: part.status, result: part.result, isError: true });
      return;
    }
    if (part.name === 'ask_user') return this.askUser(part, args, ctx, run, send, t0);
    // mcp_call 은 실제 대상 도구로 바꿔서 승인·실행한다
    let viaCall = null;
    if (part.name === 'mcp_call') {
      viaCall = this.mcp.find(String(args.server || ''), String(args.tool || ''));
      if (!viaCall) {
        Object.assign(part, { status: 'error', isError: true, result: `없는 도구입니다: ${args.server}/${args.tool}. mcp_tools 로 정확한 이름을 찾으세요.`, durationMs: Date.now() - t0 });
        send({ type: 'tool_status', id: part.id, status: part.status, result: part.result, isError: true });
        return;
      }
    }
    const mcpHit = viaCall || (part.name.startsWith('mcp__') ? this.mcp.lookup(part.name) : null);
    // 외부 프로젝트 보호: 프로젝트 이름·설정 변경, 프로젝트·캔버스·에셋 삭제는 Flash 에서 실행하지 않는다
    // (다른 작품 프로젝트의 이름을 바꿔 덮어쓴 사고 이후. 설정 tools.allowProjectEdits 로만 풀린다)
    {
      const blocked = protectedOp(viaCall ? viaCall.tool : part.name, viaCall ? (args.arguments || {}) : args);
      if (blocked && !ctx.settings.tools.allowProjectEdits) {
        Object.assign(part, { status: 'error', isError: true, durationMs: Date.now() - t0,
          result: `실행하지 않았다: ${blocked}은(는) 기존 프로젝트를 바꾸거나 지우는 작업이라 Flash 에서 막혀 있다. 다른 작품의 프로젝트를 쓰거나 이름을 바꾸지 않는다. 이 작업의 프로젝트가 없으면 새로 만들고, 만들 수 없으면 사용자에게 보고한다(대기열이면 [JOB_BLOCKED: 프로젝트 생성 필요 — 작품명]).` });
        send({ type: 'tool_status', id: part.id, status: part.status, result: part.result, isError: true });
        return;
      }
    }
    // 대기열 작업은 등록할 때 받은 유료 승인 범위 안에서만 유료 도구를 실행한다 (CONTEXT.md §13)
    if (run.job) {
      let kind = paidKind(viaCall ? viaCall.tool : part.name, viaCall ? (args.arguments || {}) : args);
      // 이미 만든 결과를 재사용하는 생성은 비용이 없으니 세지 않는다
      if (kind === 'images' && part.name === 'generate_image' && tools.cachedImage({ prompt: String(args.prompt || ''), size: args.size, useAttached: !!args.use_attached_images, references: args.reference_images || [], new_variant: !!args.new_variant }, ctx)) kind = null;
      if (kind) {
        const job = (this.queue && this.queue.get(run.job.id)) || run.job;
        const ap = job.approval || {};
        const capHit = ap.maxPaidCalls != null && job.paidCalls >= ap.maxPaidCalls;
        if (!ap[kind] || capHit) {
          const label = { images: '이미지 생성', video: '영상 렌더', other: '유료 생성' }[kind];
          Object.assign(part, { status: 'error', isError: true, durationMs: Date.now() - t0,
            result: `대기열 승인 범위 밖이라 실행하지 않았다 (${label}${capHit ? `, 유료 호출 상한 ${ap.maxPaidCalls}회 도달` : ' 미승인'}). 이 작업 없이 할 수 있는 일은 마저 끝내고, 지금까지 한 일을 queue_checkpoint 로 남긴 뒤 마지막 줄에 [JOB_BLOCKED: ${label} 승인 필요] 를 쓴다.` });
          send({ type: 'tool_status', id: part.id, status: part.status, result: part.result, isError: true });
          return;
        }
        if (this.queue) this.queue.notePaid(job.id);
      }
    }
    if (tools.needsApproval(part.name, ctx.settings, mcpHit, args) && !run.allowAll.has(part.name)) {
      part.status = 'awaiting_approval';
      send({ type: 'tool_status', id: part.id, status: part.status });
      const decision = await new Promise((resolve) => {
        run.approvals.set(part.id, resolve);
        ctx.signal.addEventListener('abort', () => resolve('deny'), { once: true });
      });
      run.approvals.delete(part.id);
      if (decision === 'allow_all') run.allowAll.add(part.name);
      if (decision === 'deny') {
        Object.assign(part, { status: 'denied', result: '사용자가 이 도구 실행을 거부했습니다. 다른 방법을 제안하거나 이유를 물어보세요.', isError: true });
        send({ type: 'tool_status', id: part.id, status: part.status, result: part.result, isError: true });
        return;
      }
    }
    // 끝나지 않은 작업의 상태 조회를 같은 인자로 다시 부르면, 결과를 바로 돌려주지 않고 끝날 때까지 서버가 기다린다
    // (모델이 조회 → 답 → 조회를 반복하면 한 번마다 전체 컨텍스트 토큰이 든다)
    const waitFq = viaCall ? viaCall.fq : part.name.startsWith('mcp__') ? part.name : null;
    const waitShort = waitFq ? waitFq.split('__').pop() : '';
    const waitArgs = viaCall ? (args.arguments || {}) : args;
    const waitKey = waitFq && (STATUS_TOOL.test(waitShort) || pollStatusRead(waitShort,waitArgs)) && !POLL_DENY.test(waitShort) ? pollKey(waitFq,waitArgs) : null;
    const autoWait = !!(waitKey && run.statusSeen.has(waitKey));
    part.status = 'running';
    send({ type: 'tool_status', id: part.id, status: 'running' });
    try {
      let r;
      if (part.name === 'search_previous_conversation') {
        r = { text: this.searchPrevious(ctx.meta.conversationId, String(args.query || ''), Math.min(20, Number(args.limit) || 8)) };
      } else if (part.name === 'read_previous_conversation') {
        r = { text: this.readPrevious(ctx.meta.conversationId, args) };
      } else if (part.name === 'mcp_tools') {
        const hits = this.mcp.search(args.server, args.query, 15);
        r = { text: hits.length
          ? hits.map((h) => `## ${h.server} / ${h.tool.name}\n${(h.tool.description || '').slice(0, 600)}\n입력 스키마: ${JSON.stringify(h.tool.inputSchema || {}).slice(0, 2500)}`).join('\n\n')
          : '일치하는 도구가 없습니다. query 를 바꾸거나 비워서 전체 목록을 보세요.' };
      } else if (autoWait) {
        r = await this.pollUntil({ tool: waitFq, arguments: waitArgs, field: 'status', background: true, label: waitShort, interval_seconds: POLICY.autoWaitInterval }, ctx, run, part, send);
        r = { ...r, text: `(같은 상태 조회를 반복해서 서버가 백그라운드 확인으로 넘겼다. 다음부터는 접수 직후 poll_until 로 한 번 등록한다)
${r.text}` };
      } else if (viaCall) r = tools.fromMcpResult(await this.mcp.callTool(viaCall.fq, args.arguments || {}), ctx);
      else if (mcpHit || part.name.startsWith('mcp__')) r = tools.fromMcpResult(await this.mcp.callTool(part.name, args), ctx);
      else if (part.name === 'poll_until') r = await this.pollUntil(args, ctx, run, part, send);
      else if (part.name.startsWith('queue_') && this.queue) r = this.queueTool(part.name, args, ctx);
      else if (part.name.startsWith('browser_') && this.browser) r = await this.browserTool(part.name, args, ctx);
      else r = await tools.execute(part.name, args, ctx);
      if (waitKey) {
        const v = pickField(r.text, 'status');
        if (v && !POLL_DONE.includes(v.toLowerCase()) && !r.isError) run.statusSeen.set(waitKey, v); else run.statusSeen.delete(waitKey);
      }
      const limit = ctx.settings.tools.resultLimit;
      part.result = r.text.length > limit ? `${r.text.slice(0, limit)}\n…(결과가 길어 ${limit}자에서 잘랐습니다)` : r.text;
      part.isError = !!r.isError;
      part.status = r.isError ? 'error' : 'done';
      for (const im of r.images || []) { parts.push(im); send({ type: 'image', part: im }); }
      for (const video of r.videos || []) { parts.push(video); send({ type: 'video', part: video }); }
    } catch (e) {
      part.result = `오류: ${e.message}`;
      if (e.requestId) part.requestId = e.requestId;
      part.isError = true;
      part.status = 'error';
    }
    part.durationMs = Date.now() - t0;
    send({ type: 'tool_status', id: part.id, status: part.status, result: part.result, isError: part.isError, durationMs: part.durationMs });
  }

  approve(runId, callId, decision) {
    const run = this.runs.get(runId);
    const fnr = run?.approvals.get(callId);
    if (!fnr) return false;
    fnr(decision);
    return true;
  }

  stop(runId) {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.stopRequested = true;
    run.controller.abort();
    return true;
  }

  // ask_user: 보기를 보여주고 답을 기다린다. 제한 시간(기본 20초) 안에 답이 없으면 권장안으로 진행.
  // critical은 영구 메모를 저장하고 즉시 반환한다. 의존 작업만 보류한다.
  async askUser(part, args, ctx, run, send, t0) {
    const done = (text, isError = false) => {
      Object.assign(part, { status: isError ? 'error' : 'done', result: text, isError, durationMs: Date.now() - t0 });
      send({ type: 'tool_status', id: part.id, status: part.status, result: text, isError, durationMs: part.durationMs });
    };
    const options = (Array.isArray(args.options) ? args.options : []).slice(0, 4)
      .map((o) => (typeof o === 'string' ? { label: o, description: '' } : { label: String(o?.label || '').slice(0, 100), description: String(o?.description || '').slice(0, 300) }))
      .filter((o) => o.label);
    if (options.length < 2) { done('options 는 2~4개가 필요합니다. 보기를 만들어 다시 물어보세요.', true); return; }
    const rec = Math.min(Math.max(0, Number(args.recommended) || 0), options.length - 1);
    const critical = !!args.critical;
    if (critical) {
      const item = decisions.record(this.store, { ...ctx.meta, callId: part.id }, { ...args, options, recommended: rec });
      done(`중요한 결정 메모 ${item.id}: 미답변. 권장안은 승인되지 않았습니다. 답이 필요한 작업만 보류하고 독립적인 허용 작업을 지금 병렬 진행하세요. 독립 작업이 없으면 결정 메모와 완료/미완료를 보고하세요. 설정 → 메모리 → 결정 메모에서 나중에 답할 수 있습니다.`);
      return;
    }
    if (run.headless) {
      done(`사용자가 없는 예약 실행이라 권장안 "${options[rec].label}"으로 진행한다.`);
      return;
    }
    const sec = ctx.settings.tools.askTimeoutSec || 20;
    const deadline = Date.now() + sec * 1000;
    part.status = 'awaiting_answer';
    send({ type: 'tool_status', id: part.id, status: part.status, deadline });
    const answer = await new Promise((resolve) => {
      const timer = deadline ? setTimeout(() => resolve({ timeout: true }), sec * 1000) : null;
      run.approvals.set(part.id, (v) => {
        clearTimeout(timer);
        // 사용자가 직접 입력을 시작하면 자동 진행을 멈추고 답을 기다린다
        if (v && v.hold) { send({ type: 'tool_status', id: part.id, status: 'awaiting_answer', deadline: null }); return; }
        resolve(v);
      });
      ctx.signal.addEventListener('abort', () => { clearTimeout(timer); resolve({ aborted: true }); }, { once: true });
    });
    run.approvals.delete(part.id);
    if (answer.aborted) { done('중단됨', true); return; }
    if (answer.steering) { done('사용자의 즉시 추가 지시를 우선 처리합니다. 이 질문에는 아직 답하지 않았으며 권장안을 선택하거나 승인하지 않았습니다.'); return; }
    if (answer.timeout) { done(`${sec}초 동안 답이 없어 권장안 "${options[rec].label}"으로 진행한다.`); return; }
    const pick = Number.isInteger(answer.choice) && options[answer.choice] ? options[answer.choice] : null;
    const text = String(answer.text || '').trim().slice(0, 4000);
    if (pick) done(`사용자 선택: "${pick.label}"${text ? `\n덧붙인 말: ${text}` : ''}`);
    else if (text) done(`사용자 답 (직접 입력): ${text}`);
    else done(`답이 비어 있어 권장안 "${options[rec].label}"으로 진행한다.`);
  }

  answerDecision(id, payload) {
    const item = decisions.answer(this.store, id, payload);
    const notice = `중요한 결정의 사용자 답변 [${item.id}] ${item.question} → ${item.answer}. 현재 작업과 의존성을 다시 대조하고 승인 범위에서 이어가세요. 완료된 작업은 반복하지 마세요.`;
    for (const [runId, run] of this.runs) {
      if (run.controller.signal.aborted) continue;
      const conv = this.store.getConversation(run.convId);
      if (handoffPolicy.lineage(this.store, conv.id).some(c => c.id === item.conversationId)) this.steer(runId, notice);
    }
    return item;
  }

  // 응답 중 추가 지시 (스티어링). 다음 단계(도구 결과 뒤 또는 답변 직후)에 반영된다
  steer(runId, text, options = {}) {
    const run = this.runs.get(runId);
    if (!run || run.controller?.signal.aborted || (run.headless && !run.job && !run.watch)) return false;
    const attachments = options.attachments || [];
    for (const a of attachments) {
      this.store.reg.assert('attachment.schema.json', a);
      if (!fs.existsSync(this.uploadPath(a))) throw Object.assign(new Error(`첨부 파일이 없습니다: ${a.name}`), { status: 400 });
    }
    const content = String(text || '').trim();
    if (!content && !attachments.length) return false;
    const part = { type: 'steer', id: newId(), text: content.slice(0, 20000) || '첨부 이미지를 확인하고 현재 작업에 반영해 주세요.',
      attachments, createdAt: now(), delivery: 'pending', immediate: options.immediate === true };
    run.steer.push(part);
    if (run.parts && run.conversation) {
      run.parts.push(part);
      this.store.saveConversation(run.conversation);
      run.send({ type: 'steer', part });
    }
    if (part.immediate) {
      // 모델 응답만 중단한다. 실행 중인 외부 쓰기/유료 요청은 중단·중복하지 않는다.
      run.modelController?.abort();
      if (run.currentTool?.status === 'awaiting_approval') this.approve(runId, run.currentTool.id, 'deny');
      else if (run.currentTool?.status === 'awaiting_answer') this.answer(runId, run.currentTool.id, { steering: true });
    }
    return true;
  }

  answer(runId, callId, payload) {
    const run = this.runs.get(runId);
    const fnr = run?.approvals.get(callId);
    if (!fnr) return false;
    fnr(payload);
    return true;
  }

  // 대기열 도구: 작업 등록·상태·체크포인트
  queueTool(name, args, ctx) {
    const q = this.queue;
    if (name === 'queue_add') {
      const items = Array.isArray(args.jobs) ? args.jobs.slice(0, 200) : [];
      if (!items.length) return { text: 'jobs 가 비어 있습니다.', isError: true };
      const conv = this.store.getConversation(ctx.meta.conversationId);
      const { jobs: added, reused } = q.addModelBatch(conv, items);
      return { text: `${reused ? '기존 등록을 재사용했다' : '대기열에 등록했다'}: ${added.length}건 (묶음 ${added[0].batchId}). 워커 1개로 순차 실행한다. 유료 승인은 별도로 필요하다.\n${added.map((j, i) => `${i + 1}. ${j.id} · ${j.title}${j.dependsOn.length ? ' (앞 작업 뒤)' : ''}`).join('\n')}` };
    }
    if (name === 'queue_status') {
      const snap = q.snapshot();
      const counts = {};
      for (const j of snap.jobs) counts[j.status] = (counts[j.status] || 0) + 1;
      const list = snap.jobs.filter((j) => !args.status || j.status === args.status).slice(-30)
        .map((j) => `- ${j.id} · ${j.status} · ${j.title}${j.blockedReason ? ` — ${j.blockedReason}` : ''}${j.lastError ? ` — 오류: ${j.lastError.slice(0, 120)}` : ''}`);
      return { text: `대기열 ${snap.settings.running ? '실행 중' : '일시정지'} · ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || '비어 있음'}\n${list.join('\n')}` };
    }
    if (name === 'queue_checkpoint') {
      const conv = this.store.getConversation(ctx.meta.conversationId);
      if (!conv.queueJobId) return { text: '대기열 작업 대화가 아닙니다.', isError: true };
      q.checkpoint(conv.queueJobId, String(args.checkpoint || ''));
      return { text: '체크포인트를 저장했다. 대화가 바뀌거나 앱이 다시 시작돼도 여기서 이어진다.' };
    }
    throw new Error(`알 수 없는 대기열 도구: ${name}`);
  }

  // poll_until: 조회 도구를 서버에서 반복 호출하고 끝났을 때 결과만 돌려준다
  // poll_until · 백그라운드 확인(lib/bgwait.js)이 함께 쓰는 조회 준비
  pollContext(convId) {
    return { settings: this.store.getSettings(), store: this.store, skills: this.skills, signal: new AbortController().signal, turnImages: [], turnAttachments: [], allAttachments: [], mcp: this.mcp, terminal: this.terminal, meta: { conversationId: convId, source: 'app' } };
  }

  pollTarget(name, toolArgs, ctx) {
    const inputError=pollInputError(toolArgs,name);if(inputError)return {error:inputError};
    const short = name.includes('__') ? name.split('__').pop() : name.split('/').pop();
    if (!name) return { error: 'tool 이 필요합니다.' };
    if (name === 'poll_until' || name === 'ask_user' || POLL_DENY.test(short)) return { error: `"${name}" 은(는) 조회 도구가 아니라 반복할 수 없습니다. 상태·목록·읽기 도구만 쓸 수 있습니다.` };
    // 호출 대상 결정: mcp__ 이름, "서버/도구"(mcp_call 대상), 앱 로컬 도구
    if (name.startsWith('mcp__')) return { call: () => this.mcp.callTool(name, toolArgs).then((res) => tools.fromMcpResult(res, ctx)) };
    if (name.includes('/')) {
      const [server, tool] = name.split('/');
      const hit = this.mcp.find(server, tool);
      if (!hit) return { error: `없는 도구입니다: ${name}` };
      return { call: () => this.mcp.callTool(hit.fq, toolArgs).then((res) => tools.fromMcpResult(res, ctx)) };
    }
    return { call: () => tools.execute(name, toolArgs, ctx) };
  }

  pollCheck(text, spec) {
    const fieldPath = String(spec.field || 'status');
    const until = (Array.isArray(spec.until) && spec.until.length ? spec.until : POLL_DONE).map((x) => String(x).toLowerCase());
    const contains = spec.contains ? String(spec.contains) : '';
    const value = contains ? null : pickField(text, fieldPath);
    return { value, hit: contains ? text.includes(contains) : value != null && until.includes(value.toLowerCase()) };
  }

  async pollUntil(args, ctx, run, part, send) {
    const name = String(args.tool || '').trim();
    const toolArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
    const target = this.pollTarget(name, toolArgs, ctx);
    if (target.error) return { text: target.error, isError: true };
    const call = target.call;

    // 백그라운드 확인 (CONTEXT.md §15): 한 번 보고, 안 끝났으면 서버에 맡기고 바로 돌아온다
    if (args.background !== false && this.bg) {
      const convId = ctx.meta.conversationId;
      const key = pollKey(name,toolArgs);
      const same = this.bg.list(convId).find((w) => pollKey(w.tool,w.arguments) === key);
      const AFTER = [
        '- 기다리지 말고 이 작업과 상관없는 다음 일을 계속한다 (다른 컷 준비, 프롬프트 작성, 다음 노드 구성 등).',
        '- 같은 상태 조회를 다시 부르지 않는다.',
        '- 더 할 일이 없으면 한 일과 확인을 기다리는 작업을 짧게 정리하고 응답을 끝낸다. 결과가 오면 자동으로 이어진다. 결과가 오기 전에는 완료 표시([JOB_DONE]·[업무완료])를 쓰지 않는다.'
      ].join('\n');
      if (same) return { text: `이미 백그라운드에서 확인 중인 작업이다 (${same.label}, ${same.n}회 조회, 마지막 ${same.field}=${same.lastValue ?? '?'}). 조회하지 않고 돌아왔다.
${AFTER}` };
      let first;
      try { first = await call(); } catch (e) { first = { text: `조회 오류: ${e.message}`, isError: true }; }
      const text = first.text || '';
      const failure=pollFailure(first);if(failure?.terminal)return {text:`폴링 종료 — ${failure.reason}\n\n${text}`,isError:true};
      const chk = this.pollCheck(text, args);
      if (chk.hit) return { text: `이미 끝남 — ${args.contains ? `"${args.contains}" 확인` : `${args.field || 'status'}=${chk.value}`}

${text}`, images: first.images, videos: first.videos };
      const { wait } = this.bg.add(convId, { tool: name, arguments: toolArgs, field: args.field, until: args.until, contains: args.contains, label: args.label, interval_seconds: args.interval_seconds, timeout_seconds: args.timeout_seconds });
      return { text: `백그라운드 확인에 등록했다 (${wait.label}, 현재 ${wait.field}=${chk.value ?? '?'}). 서버가 토큰 없이 상태를 확인하고, 끝나면 결과가 이 대화에 알림으로 들어온다.
${AFTER}

${text.length > 1500 ? `${text.slice(0, 1500)}
…` : text}`, images: first.images, videos: first.videos };
    }

    const fieldPath = String(args.field || 'status');
    const until = (Array.isArray(args.until) && args.until.length ? args.until : POLL_DONE).map((x) => String(x).toLowerCase());
    const contains = args.contains ? String(args.contains) : '';
    const interval = Math.min(120, Math.max(3, Number(args.interval_seconds) || POLICY.pollDefaultInterval)) * 1000;
    const timeout = Math.min(POLICY.pollMaxTimeout, Math.max(10, Number(args.timeout_seconds) || POLICY.pollDefaultTimeout)) * 1000;
    const t0 = Date.now();
    let n = 0;
    let last = null;
    let value = null;
    let errorStreak=0;
    const progress = (msg) => { part.result = msg; send({ type: 'tool_status', id: part.id, status: 'running', result: msg }); };
    for (;;) {
      n++;
      try { last = await call(); } catch (e) { last = { text: `조회 오류: ${e.message}`, isError: true }; }
      const text = last.text || '';
      const failure=pollFailure(last);errorStreak=failure?errorStreak+1:0;
      if(failure?.terminal||errorStreak>=5)return {text:`폴링 종료 — ${failure?.reason||'조회 오류가 5회 연속 발생했습니다.'}\n자동 재실행하지 말고 정확한 작업 ID와 상태를 확인하세요.\n\n${text}`,isError:true};
      value = contains ? null : pickField(text, fieldPath);
      const hit = contains ? text.includes(contains) : value != null && until.includes(value.toLowerCase());
      const secs = Math.round((Date.now() - t0) / 1000);
      if (hit) return { text: `끝남 — ${contains ? `"${contains}" 확인` : `${fieldPath}=${value}`} (${n}회 조회, ${secs}초 대기)\n\n${text}`, images: last.images, videos: last.videos };
      if (ctx.signal.aborted) return { text: `중단됨 (${n}회 조회, 마지막 ${fieldPath}=${value ?? '?'})`, isError: true };
      if (run.steer.length) return { text: `사용자가 추가 지시를 보내 기다리기를 멈췄다 (${n}회 조회, ${secs}초, 아직 끝나지 않음 — 마지막 ${fieldPath}=${value ?? '?'}). 추가 지시를 먼저 처리하고, 필요하면 다시 poll_until 로 기다린다.\n\n${text}` };
      if (Date.now() - t0 + interval > timeout) return { text: `시간 초과 — ${Math.round(timeout / 1000)}초 동안 끝나지 않음 (${n}회 조회, 마지막 ${fieldPath}=${value ?? '?'}). 더 기다릴지 판단해 다시 poll_until 을 부르거나 사용자에게 보고한다.\n\n${text}` };
      progress(`기다리는 중… ${n}회 조회 · ${secs}초 경과 · 현재 ${contains ? '미확인' : `${fieldPath}=${value ?? '?'}`}`);
      // 기다리는 동안 추가 지시가 오면 바로 깨어난다
      const until2 = Date.now() + Math.min(Math.max(interval, POLICY.pollMaxInterval * 1000), interval * 1.5 ** Math.max(0, n - 3));
      while (Date.now() < until2 && !ctx.signal.aborted && !run.steer.length) await sleepFor(Math.min(1000, until2 - Date.now()), ctx.signal);
    }
  }

  // 작업 브라우저 도구. 동작 뒤에는 짧은 페이지 요약을 돌려줘 한 번 더 읽는 왕복을 줄인다
  async browserTool(name, args, ctx) {
    if (!ctx.settings.tools.enableBrowser) throw new Error('설정에서 작업 브라우저가 꺼져 있습니다');
    const b = this.browser;
    const brief = () => b.read({ maxChars: 2500, maxElements: 50 });
    switch (name) {
      case 'browser_open': await b.open(String(args.url || '')); return { text: await brief() };
      case 'browser_read': return { text: await b.read({ offset: Math.max(0, Number(args.offset) || 0) }) };
      case 'browser_click': await b.click({ element: args.element, x: args.x, y: args.y, double: !!args.double }); return { text: await brief() };
      case 'browser_type': await b.type({ element: args.element, text: args.text, clear: !!args.clear, submit: !!args.submit }); return { text: await brief() };
      case 'browser_key': await b.key(String(args.key || 'Enter')); return { text: await brief() };
      case 'browser_scroll': await b.scroll({ direction: args.direction, amount: args.amount }); return { text: await brief() };
      case 'browser_navigate': await b.history(String(args.action || 'back')); return { text: await brief() };
      case 'browser_screenshot': {
        const buf = await b.screenshotBuffer();
        if (!buf) throw new Error('화면을 찍지 못했습니다');
        const url = tools.saveImage(buf, this.store.dirs.images, 'jpg');
        return { text: `작업 브라우저 화면을 저장했습니다: ${url} (${b.state.title} — ${b.state.url})`, images: [{ type: 'image', url, prompt: `브라우저: ${b.state.url}`, model: 'browser' }] };
      }
      case 'browser_close': b.close(); return { text: '작업 브라우저를 닫았습니다.' };
      default: throw new Error(`알 수 없는 브라우저 도구: ${name}`);
    }
  }

  activeCount() { return this.runs.size + [...this.handoffDrafts.keys()].filter(id => !this.isBusy(id)).length; }
  isBusy(convId) { return [...this.runs.values()].some((r) => r.convId === convId || r.sourceConvIds?.has(convId)); }
  activeRunFor(convId) {
    const e = [...this.runs.entries()].find(([, r]) => r.convId === convId || r.sourceConvIds?.has(convId));
    if (!e) return null;
    let [id, run] = e;
    const seen = new Set();
    while (run.continuationRunId && this.runs.has(run.continuationRunId) && !seen.has(id)) {
      seen.add(id); id = run.continuationRunId; run = this.runs.get(id);
    }
    return id;
  }

  // 화면 없이 한 턴을 실행한다 (루틴용). 끝난 어시스턴트 메시지를 돌려준다
  async runHeadless(body, extra = {}) {
    const { EventEmitter } = require('events');
    const res = new EventEmitter();
    let final = null;
    let error = '';
    const dropped = [];
    Object.assign(res, {
      writableEnded: false, writableFinished: false,
      writeHead() {},
      write(chunk) {
        const m = /^data: (.*)\n\n$/s.exec(String(chunk));
        if (m) { try { const ev = JSON.parse(m[1]); if (ev.type === 'done') final = ev.message; else if (ev.type === 'error') error = ev.message; else if (ev.type === 'steer_dropped') dropped.push(...ev.texts); } catch { /* 무시 */ } }
        return true;
      },
      end() { res.writableEnded = true; res.writableFinished = true; }
    });
    const req = this.store.reg.applyDefaults('chat-request.schema.json', { ...body });
    await this.handle({ headless: true, job: extra.job || null, watch: !!extra.watch }, res, req);
    return { message: final, error: error || (final && final.error) || '', dropped };
  }
}

module.exports = { ChatRunner, attachmentKind };
