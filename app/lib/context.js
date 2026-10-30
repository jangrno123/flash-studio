'use strict';
// 컨텍스트 관리 — D:\FlashStudio\CONTEXT.md 의 규칙을 코드로 옮긴 것.
// 규칙을 바꿀 때는 CONTEXT.md 와 이 파일을 함께 고친다.

// ---------- 예산 (CONTEXT.md §3) ----------
const POLICY = {
  charsPerToken: 3,              // 한국어·영어·JSON 이 섞인 대화의 평균 (실측: 약 900KB ≈ 29만 토큰)
  historyToolResultCap: 4000,    // L3 지난 턴의 도구 결과 최대 글자
  historyAssistantTextCap: 6000, // L3 지난 턴의 어시스턴트 답변 최대 글자
  turnKeepFullResults: 4,        // L4 진행 중인 턴에서 원문 그대로 두는 최근 도구 결과 수
  turnToolResultCap: 6000,       // L4 그보다 앞선 이번 턴 도구 결과 최대 글자
  dedupeMinChars: 400,           // 이 길이 이상 똑같은 도구 결과는 처음 것만 싣는다
  catalogDescChars: 160,         // L1 스킬 목록 설명 최대 글자
  transcriptBudgetChars: 240000, // 요약기에 넣는 대화 최대 글자 (약 8만 토큰)
  summaryMaxTokens: 6000,
  // 요청 정리와 채팅방 인계는 별도다. 원문 누적300만에서 새 대화로 넘긴다.
  handoffAtTokens: 3000000,
  handoffMaxTokens: 16000,
  handoffFiles: 40,              // 인계서에 자동으로 붙이는 파일 목록 최대 개수
  // 모델 호출 한도 (CONTEXT.md §12)
  steerBonusRounds: 15,          // 추가 지시 1건마다 늘려 주는 호출 수 (기본 한도의 2배까지)
  pollDefaultInterval: 10,       // poll_until 기본 조회 간격(초)
  pollDefaultTimeout: 1200,      // poll_until 기본 최대 대기(초). 영상 렌더가 10분을 넘는 경우가 많아 넉넉히
  pollMaxInterval: 60,           // 조회 간격은 세 번째부터 1.5배씩 늘려 이 값(초)까지
  autoWaitInterval: 15,          // 같은 상태 조회를 반복하면 서버가 대신 기다린다 (CONTEXT.md §14)
  autoWaitTimeout: 1200,
  pollMaxTimeout: 1800
};

// 한도 직전 마지막 호출에 붙이는 지시: 도구 없이 보고로 끝낸다
const LIMIT_NOTE = (n) => `[모델 호출 한도 ${n}회에 도달 — 더는 도구를 부르지 말고 지금 바로 보고한다: ① 이번 응답에서 끝낸 일과 확인된 결과(ID·경로 포함) ② 아직 못 한 일(작업 중 받은 추가 지시 포함) ③ 이어서 할 순서. 사용자가 "이어서 계속"을 누르면 새 응답에서 이어 간다. 무인 대기열 작업이면 체크포인트 내용도 이 보고에 담고, 남은 일이 정말 없을 때만 마지막 줄에 [JOB_DONE] 을 따로 쓴다.]`;

const estimateTokens = (value) => Math.ceil((typeof value === 'string' ? value.length : JSON.stringify(value).length) / POLICY.charsPerToken);

// 저장된 메시지 목록의 대략적인 토큰 수 (이미지 제외, 지난 턴 규칙으로 잘랐다고 가정)
function estimateMessages(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content || '').length;
    for (const p of m.parts || []) {
      if (p.type === 'text') chars += Math.min(p.text.length, POLICY.historyAssistantTextCap);
      else if (p.type === 'tool_call') chars += (p.arguments || '').length + Math.min((p.result || '').length, POLICY.historyToolResultCap) + 80;
    }
  }
  return Math.ceil(chars / POLICY.charsPerToken);
}

// 자동 정리 기준 (CONTEXT.md §5): 모델 컨텍스트 창의 N% 와 설정한 요청 예산 중 먼저 닿는 쪽
function compactThreshold(g, modelDef) {
  const window = (modelDef && modelDef.contextWindow) || null;
  const byPercent = window ? Math.floor((window * (g.compactAtPercent || 80)) / 100) : Infinity;
  const cap = g.compactAtTokens || Infinity;
  const threshold = Math.min(byPercent, cap);
  return { window, threshold: Number.isFinite(threshold) ? threshold : 80000, limitBy: byPercent <= cap ? 'percent' : 'cap' };
}

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…(${s.length.toLocaleString()}자 중 앞부분)` : s || '');

// 요약기에 넣을 압축 대본: 사용자 말은 거의 그대로, 도구는 이름·핵심 인자·결과 앞부분만
function condensedTranscript(messages) {
  const lines = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const atts = (m.attachments || []).map((a) => a.name).join(', ');
      lines.push(`\n[사용자] ${clip(m.content, 4000)}${atts ? `\n  (첨부: ${atts})` : ''}`);
    } else {
      for (const p of m.parts || []) {
        if (p.type === 'text' && p.text.trim()) lines.push(`[어시스턴트] ${clip(p.text.trim(), 2500)}`);
        else if (p.type === 'tool_call') lines.push(`  → ${p.name}(${clip(p.arguments, 300)}) ${p.status === 'done' ? '=' : `[${p.status}]`} ${clip((p.result || '').replace(/\s+/g, ' '), 500)}`);
        else if (p.type === 'image') lines.push(`  (이미지 ${p.url})`);
        else if (p.type === 'steer') lines.push(`[사용자 · 작업 중 추가 지시${p.delivery === 'pending' ? ' · 미반영' : ''}] ${clip(p.text, 2000)}${(p.attachments || []).map(a => `\n  첨부 ${a.name}: data/uploads/${a.file}`).join('')}`);
      }
      if (m.error) lines.push(`  [오류] ${clip(m.error, 300)}`);
    }
  }
  let text = lines.join('\n');
  if (text.length > POLICY.transcriptBudgetChars) text = `…(앞부분 ${(text.length - POLICY.transcriptBudgetChars).toLocaleString()}자 생략 — 이전 요약이 있으면 그것으로 보완)\n${text.slice(-POLICY.transcriptBudgetChars)}`;
  return text;
}

const SUMMARY_PROMPT = [
  '너는 긴 작업 대화를 이어서 일할 수 있게 압축하는 요약기다. 아래 대화를 다음 형식으로 요약한다.',
  '',
  '## 목표 — 사용자가 최종적으로 원하는 것',
  '## 사용자 지시·교정 — 사용자가 직접 정한 규칙, 바로잡은 것, 선호 (원문에 가깝게)',
  '## 확정된 사항 — 결정된 설정·방식',
  '## 식별자 — project_id, graph_id, node ID, asset ID, 파일 경로, URL, 모델·엔드포인트 ID 를 빠짐없이 그대로',
  '## 진행 상황 — 끝난 것 / 진행 중 / 실패한 것과 원인',
  '## 남은 일 — 다음에 할 일 순서대로',
  '',
  '규칙: 식별자·숫자·경로는 한 글자도 바꾸지 않는다. EP/팩/프로젝트별 미완료 작업을 각각 보존하고 사용자 원문 메시지 ID를 근거로 붙인다. 최신 교정·취소를 반영하고 유효 지침은 임의로 빼지 않는다. 이전 요약과 이번 조각을 합쳐서 하나로 만든다. 반복 보고·인사·도구 원문부터 줄이고 지침과 미완료 작업은 우선 보존한다. 요약에 담기지 않은 세부는 원문 조회로 복구할 수 있음을 명시한다. 한국어로, 최대 6000토큰.'
].join('\n');

// 인계서: 새 대화가 이 문서 하나만 읽고 바로 이어서 일할 수 있게 쓴다 (CONTEXT.md §9)
const HANDOFF_PROMPT = [
  '너는 작업 인계서를 쓰는 사람이다. 지금 대화를 닫고 새 대화에서 이어서 일한다. 새 대화의 작업자는 이 인계서만 받는다.',
  '아래 형식의 마크다운으로 쓴다.',
  '',
  '# 인계서: <작업 이름>',
  '## 목표 — 최종적으로 만들 것, 완료 기준',
  '## 사용자 지시·선호 — 사용자가 직접 정한 규칙, 금지 사항, 바로잡은 것 (원문에 가깝게)',
  '## 확정된 결정 — 정해진 설정·방식·모델·사이즈 등',
  '## 식별자 — project_id, graph_id, node ID, asset ID, 파일 경로, URL, 모델·엔드포인트 ID (빠짐없이 그대로)',
  '## 1차 자료 — 원본 이미지, 대본 시트, 원본 컷 등 판단의 근거가 되는 파일 경로. 새 대화는 이 인계서가 아니라 이 파일들을 다시 읽고 판단한다',
  '## 진행 상황 — 끝난 것 / 진행 중인 것 / 실패한 것과 원인. "끝났다"고 적을 때는 무엇으로 확인했는지(파일·조회 결과)를 함께 적고, 확인하지 않은 것은 "확인 필요"로 적는다',
  '## 다음 할 일 — 순서대로. 첫 줄은 새 대화에서 바로 실행할 한 가지',
  '## 주의 — 다시 하면 안 되는 것, 알려진 문제',
  '',
  '반드시 다음 제목을 모두 쓴다: ## 사용자 지침, ## 작업별 상태, ## 식별자, ## 참조 역할, ## 남은 작업, ## 검증과 불확실성.',
  '사용자 지침에는 현재 유효한 조건·금지·수정 이유·취소/대체된 조건을 구분하고 원문 메시지 ID를 붙인다. 취소된 조건을 되살리지 않는다.',
  '작업별 상태는 EP/팩/프로젝트/스레드별로 나누고 다른 작업의 승인을 섞지 않는다. 진행 중이거나 사용자가 요구한 작업을 빠뜨리지 않는다.',
  '참조 역할에는 원본→PRO→영상, 시작/끝 프레임, 구도/캐릭터/오디오 등 실제 역할과 모델/버전/해상도/비율/길이/화자 순서/네거를 정확히 남긴다.',
  '남은 작업에는 다음 실제 행동·실행 중 job·멱등키·승인 범위·대기 중 질문을 담고 결과 불명 제출을 중복하지 않도록 한다.',
  '규칙: 식별자·숫자·경로는 한 글자도 바꾸지 않는다. 이전 인계와 이번 조각을 합쳐 모든 작업을 유지한다. 출력은 16,000토큰 이내이며 반복 보고·도구 원문부터 줄이고 유효 지침과 미완료 작업은 삭제하지 않는다. 모르는 것은 확인 필요로 남긴다. 인증정보는 쓰지 않는다. 완료는 실제 검증 근거와 구분한다.'
].join('\n');

// 인계서에 붙일 파일 목록 (모델 요약과 별개로 코드가 모은다 — 경로를 잃지 않게)
function collectFiles(messages, limit = POLICY.handoffFiles) {
  const seen = new Map();
  const add = (label, ref) => { if (ref && !seen.has(ref)) seen.set(ref, label); };
  for (const m of messages) {
    for (const a of m.attachments || []) add(`첨부 ${a.name}`, `data/uploads/${a.file}`);
    for (const p of m.parts || []) {
      if (p.type === 'image' && p.url) add('생성 이미지', p.url);
      if (p.type === 'tool_call' && p.status === 'done') {
        let args = {};
        try { args = JSON.parse(p.arguments || '{}'); } catch { continue; }
        for (const k of ['path', 'dest', 'destination', 'output', 'outputPath', 'out', 'file']) {
          if (typeof args[k] === 'string' && /[\\/.]/.test(args[k])) add(`${p.name} ${k}`, args[k]);
        }
      }
    }
  }
  return [...seen].slice(-limit).map(([ref, label]) => ({ label, ref }));
}

// 새 대화를 권할지 판단. 권하면 이유 문자열, 아니면 null
function archiveTokens(conv) {
  let chars = 0;
  const count = text => String(text || '')
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '')
    .replace(/"(?:base64|content_base64|data_base64|bytes_base64)"\s*:\s*"[^"\\]*"/g, '').length;
  for (const m of conv.messages || []) {
    const textParts = (m.parts || []).filter(p => p.type === 'text');
    chars += m.role === 'user' || !textParts.length ? count(m.content) : 0;
    for (const p of m.parts || []) {
      if (p.type === 'text' || p.type === 'steer') chars += count(p.text);
      if (p.type === 'tool_call') chars += count(p.arguments) + count(p.result);
    }
  }
  return Math.ceil(chars / POLICY.charsPerToken);
}

function handoffAdvice(conv, tokens, threshold, total = archiveTokens(conv), handoffThreshold = POLICY.handoffAtTokens) {
  if (!Number.isFinite(handoffThreshold) || handoffThreshold <= 0) return null;
  if (total >= handoffThreshold)
    return `원문 누적이 채팅방 전환 기준 ${handoffThreshold.toLocaleString()}토큰에 도달했습니다`;
  return null;
}

// 모델에게 싣는 컨텍스트 규칙 (CONTEXT.md §6 의 요약본 — 짧게 유지)
const MODEL_RULES = [
  '# 컨텍스트 규칙',
  '- 필요한 것만 불러온다. 스킬은 작업에 맞는 것 하나만 load_skill 하고, 이미 불러온 스킬은 다시 부르지 않는다.',
  '- 큰 조회(그래프 전체, 파일 전체)는 필요한 범위만 요청한다(필터·detail 옵션 사용). 같은 조회를 반복하지 않는다.',
  '- 도구 결과에 "…앞부분", "이전 턴 결과", "생략" 표시가 있으면 원문이 줄여진 것이다. 최신 값이 꼭 필요할 때만 다시 조회한다.',
  '- 인계서의 사용자 지침·미완료 작업은 최신 교정과 대조하여 보존한다. 기억이 없다는 이유로 빼거나 완료 작업을 반복하지 않는다. 요약에 없는 옛 작업은 search_previous_conversation으로 검색한 뒤 read_previous_conversation으로 원문을 복구한다. 요약의 완료 주장은 실제 결과와 구분한다.',
  '- 사용자가 골라야 하는 갈림길이면 ask_user 로 보기와 권장안을 준다. 일반 질문은 제한 시간 뒤 권장안으로 진행된다. 중요한 질문(critical)은 영구 결정 메모에 남기고 의존 작업만 보류한다. 무응답을 승인으로 간주하지 말고 독립적인 허용 작업을 병렬 진행한다. 비용이 들거나 구조를 크게 바꾸는 결정은 critical 로 묻고, 사소한 건 묻지 않고 판단해 진행한다.',
  '- 생성·렌더·업로드를 접수하면 붙잡고 기다리지 않는다. 접수 직후 poll_until 로 백그라운드 확인을 작업마다 한 번 등록하고(label 붙이기), 그 결과와 상관없는 다음 일을 계속한다. 상태 조회 도구를 직접 반복해 부르지 않는다. 조회 한 번마다 대화 전체가 다시 전송돼 토큰이 크게 든다.',
  '- 더 할 일이 없으면 기다리는 작업을 짧게 정리하고 응답을 끝낸다. 결과는 "[백그라운드 확인]" 알림으로 들어오고 그때 이어서 진행한다. 알림을 받으면 결과물을 직접 한 번 확인(더블체크)한 뒤 다음 단계로 간다. 확인이 남아 있는 동안에는 완료 표시를 쓰지 않는다.',
  '- 서로 결과가 필요한 도구(예: prepare → execute)는 한 번에 같이 부르지 않고, 앞 결과를 받은 뒤 다음을 부른다.'
].join('\n');

// 자동 점검이 켜진 대화에 싣는 규칙 (lib/watch.js 가 이 표시를 읽는다)
const WATCH_RULE = [
  '# 자동 점검',
  '이 대화는 자동 점검이 켜져 있다. 작업이 중간에 끊기면 앱이 다시 가동시키고, 끝났으면 점검을 끈다.',
  '- 맡은 업무를 모두 끝냈으면 답의 마지막 줄에 [업무완료] 만 쓴다.',
  '- 사용자의 답이나 승인이 있어야 진행할 수 있으면 마지막 줄에 [대기] 만 쓴다.',
  '- 아직 진행 중이거나 다음 단계가 남았으면 표시를 쓰지 않는다.'
].join('\n');

module.exports = { WATCH_RULE, POLICY, estimateTokens, estimateMessages, archiveTokens, compactThreshold, condensedTranscript, SUMMARY_PROMPT, HANDOFF_PROMPT, collectFiles, handoffAdvice, MODEL_RULES, LIMIT_NOTE, clip };
