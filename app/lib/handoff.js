'use strict';
const { createHash } = require('node:crypto');
// 원문은 기존 대화 파일에 보존한다. 인계 모델 입력/검색 출력에는 인증정보를 싣지 않는다.
function redact(text) {
  return String(text || '')
    .replace(/\bsk-[A-Za-z0-9._-]{16,}/g, '[접속키 비공개]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{16,}/gi, 'Bearer [비공개]')
    .replace(/((?:api[_ -]?key|token|password|secret|authorization)\s*[=:]\s*["']?)[A-Za-z0-9._~-]{16,}/gi, '$1[비공개]')
    .replace(/([?&](?:token|signature|sig|key|authorization)=)[^&\s"')]+/gi, '$1[비공개]')
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[바이너리 데이터 생략]');
}

function lineage(store, id) {
  const seen = new Set(), sources = [];
  while (id) {
    if (seen.has(id)) throw new Error('대화 인계 연결이 순환합니다. 원문 연결을 확인하세요.');
    if (sources.length >= 200) throw new Error('인계 원문 연결이 200개를 넘습니다. 원문을 버리지 않고 중단합니다.');
    const c = store.getConversation(id);
    seen.add(id); sources.unshift(c); id = c.handoff?.fromConversationId;
  }
  return sources;
}

function sourceRecords(sources) {
  const records = [];
  for (const c of sources) for (const [i, m] of c.messages.entries()) {
    const location = { conversationId: c.id, messageId: m.id, index: i, createdAt: m.createdAt || '' };
    if (m.role === 'user') records.push({ ...location, type: 'user', text: redact(m.content), attachments: (m.attachments || []).map(a => ({ name: a.name, ref: `data/uploads/${a.file}` })) });
    for (const [partIndex, p] of (m.parts || []).entries()) {
      if (p.type === 'steer') records.push({ ...location, partIndex, type: 'steer', text: redact(p.text), delivery: p.delivery || 'applied', attachments: (p.attachments || []).map(a => ({ name: a.name, ref: `data/uploads/${a.file}` })) });
      else if (p.type === 'text') records.push({ ...location, partIndex, type: 'assistant', text: redact(p.text) });
      else if (p.type === 'tool_call') records.push({ ...location, partIndex, type: 'tool', name: p.name, status: p.status });
    }
  }
  return records;
}

// 순서대로 모든 사용자 지시를 처리한다. 앞부분/옛 스레드를 길이 때문에 버리지 않는다.
function transcriptChunks(sources, budget = 100000, { recentToolCount = Infinity } = {}) {
  const blocks = [];
  const toolCount = sources.reduce((n, c) => n + c.messages.reduce((m, item) => m + (item.parts || []).filter(p => p.type === 'tool_call').length, 0), 0);
  let toolIndex = 0;
  for (const c of sources) {
    blocks.push(`\n# 원문 대화 ${c.id}: ${redact(c.title)}\n대화 지침: ${redact(c.systemPrompt)}\n스킬: ${(c.skills || []).join(', ')}`);
    for (const [i, m] of c.messages.entries()) {
      const ref = `${c.id}/${m.id} (#${i + (c.sourceMessageOffset || 0)})`;
      if (m.role === 'user') blocks.push(`\n[사용자 ${ref}]\n${redact(m.content)}\n${(m.attachments || []).map(a => `첨부 ${a.name}: data/uploads/${a.file}`).join('\n')}`);
      for (const p of m.parts || []) {
        if (p.type === 'steer') blocks.push(`\n[사용자 추가 지시 ${ref}${p.delivery === 'pending' ? ' · 미반영' : ''}]\n${redact(p.text)}\n${(p.attachments || []).map(a => `첨부 ${a.name}: data/uploads/${a.file}`).join('\n')}`);
        else if (p.type === 'text') blocks.push(`\n[어시스턴트 ${ref}]\n${redact(p.text).slice(0, 6000)}`);
        else if (p.type === 'tool_call') {
          const recent = toolIndex++ >= toolCount - recentToolCount;
          if (recent || ['pending', 'running', 'awaiting_approval', 'awaiting_answer'].includes(p.status)) {
            blocks.push(`\n[도구 ${ref}] ${p.name} 상태=${p.status}\n인자 ${redact(p.arguments).slice(0, 6000)}\n결과 ${redact(p.result).slice(0, 3000)}\n(긴 원문은 read_previous_conversation으로 복구)`);
          } else {
            // 지난 완료 도구의 반복 payload는 모델에 다시 요약시키지 않는다.
            // 원문은 기존 대화와 source ledger에 남고 메시지 ID로 복구한다.
            blocks.push(`\n[지난 도구 ${ref}] ${p.name} 상태=${p.status}; 필요시 read_previous_conversation으로 인자·결과 전체 조회.`);
          }
        }
      }
    }
  }
  const chunks = [];
  let current = '';
  for (const block of blocks) for (let at = 0; at < block.length; at += budget) {
    const piece = block.slice(at, at + budget);
    if (current.length + piece.length > budget) { if (current) chunks.push(current); current = ''; }
    current += piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

const SECTIONS = ['사용자 지침', '작업별 상태', '식별자', '참조 역할', '남은 작업', '검증과 불확실성'];
function validateSummary(summary) {
  if (!summary || summary.length > 70000) throw new Error('인계서가 비었거나 저장 범위를 넘었습니다. 새 대화로 전환하지 않습니다.');
  const missing = SECTIONS.filter(s => !summary.includes(`## ${s}`));
  if (missing.length) throw new Error(`인계서 필수 항목 누락: ${missing.join(', ')}. 기존 대화를 유지합니다.`);
}
function snapshotHash(conversation, count) {
  return createHash('sha256').update(JSON.stringify({
    systemPrompt: conversation.systemPrompt || '', skills: conversation.skills || [],
    messages: conversation.messages.slice(0, count)
  })).digest('hex');
}

function sourceSnapshots(sources) {
  return sources.map(c => ({ conversationId: c.id, messageCount: c.messages.length, sha256: snapshotHash(c, c.messages.length) }));
}

// A previous verified handoff covers immutable message prefixes only. Every new
// correction and result after those prefixes must enter the new handoff.
function incrementalSources(sources, handoff) {
  const saved = handoff?.sourceSnapshots;
  if (!Array.isArray(saved) || !saved.length || !SECTIONS.every(s => handoff.summary?.includes(`## ${s}`))) return sources;
  if (handoff.sourceSummaryHash !== createHash('sha256').update(handoff.summary).digest('hex')) return sources;
  const byId = new Map(sources.map(c => [c.id, c]));
  for (const item of saved) {
    const c = byId.get(item.conversationId);
    if (!c || !Number.isInteger(item.messageCount) || item.messageCount < 0 || item.messageCount > c.messages.length || snapshotHash(c, item.messageCount) !== item.sha256) return sources;
  }
  const counts = new Map(saved.map(s => [s.conversationId, s.messageCount]));
  return sources.map(c => ({ ...c, sourceMessageOffset: counts.get(c.id) || 0, messages: c.messages.slice(counts.get(c.id) || 0) })).filter(c => c.messages.length);
}

module.exports = { redact, lineage, sourceRecords, transcriptChunks, validateSummary, SECTIONS, sourceSnapshots, incrementalSources };
