'use strict';
const fs = require('fs');
const path = require('path');
const { newId, now } = require('./store');
const { lineage, redact } = require('./handoff');
const file = store => path.join(store.data, 'decisions.json');
function load(store) {
  try { return store.readJson ? store.readJson(file(store), 'decisions.schema.json') : JSON.parse(fs.readFileSync(file(store), 'utf8')); }
  catch(e) { if(e.code === 'ENOENT') return { version: 1, items: [] }; throw e; }
}
function save(store, data) { store.writeJson(file(store), data, 'decisions.schema.json'); }
function record(store, meta, args) {
  const data = load(store);
  const found = data.items.find(d => d.callId === meta.callId && d.conversationId === meta.conversationId);
  if(found) return found;
  const conv = store.getConversation(meta.conversationId);
  const item = { id: newId(), conversationId: conv.id, messageId: meta.messageId,
    callId: meta.callId, projectId: conv.projectId || '', title: redact(conv.title),
    question: redact(args.question), options: args.options.map(o => ({label:redact(typeof o === 'string' ? o : o.label),description:redact(o.description || '')})),
    recommended: Math.min(Math.max(0, Number(args.recommended) || 0), args.options.length - 1),
    blockedTasks: (args.blocked_tasks || []).map(redact), independentTasks: (args.independent_tasks || []).map(redact),
    status: 'pending', createdAt: now(), answer: '', answeredAt: '' };
  data.items.push(item); save(store, data); return item;
}
function answer(store, id, payload) {
  const data = load(store), item = data.items.find(d => d.id === id);
  if(!item) throw Error('결정 메모를 찾을 수 없습니다.');
  const pick = Number.isInteger(payload.choice) && item.options[payload.choice];
  const text = redact(payload.text || '').trim();
  const value = pick ? `${pick.label}${text ? ' / ' + text : ''}` : text;
  if(!value) throw Error('답을 선택하거나 입력하세요. 무응답은 승인이 아닙니다.');
  if(item.status === 'answered') {
    if(item.answer === value) return item;
    throw Error('이미 답변된 결정입니다. 변경할 내용은 대화에 새 지시로 남겨주세요.');
  }
  item.status = 'answered'; item.answer = value; item.answeredAt = now(); save(store, data); return item;
}
function context(store, conv) {
  const rule = '# 중요한 결정과 병렬 진행 규칙\n중요한 질문은 ask_user(critical=true)로 영구 메모에 남긴다. 답을 기다리느라 전체 작업을 멈추지 말고 독립적인 허용 작업을 병렬 진행한다. 미답변 권장안을 승인으로 간주하지 않는다. 답이 필요한 의존 작업만 보류한다. 모든 남은 작업이 의존하면 질문·보류 상태를 보고한다. 재개/인계 때 이 결정 메모를 먼저 대조한다. 답은 기존 사용자 승인 범위 내 해당 결정에만 적용하며 새 유료 작업의 포괄 승인이 아니다.';
  const data = load(store);
  if(!data.items.length) return rule;
  const ids = new Set(lineage(store, conv.id).map(c => c.id));
  const items = data.items.filter(d => ids.has(d.conversationId));
  return rule + (items.length ? '\n## 이 작업의 결정 메모 (다른 프로젝트와 섞지 않는다)\n' + items.map(d => JSON.stringify(d)).join('\n') : '');
}
module.exports = { load, record, answer, context };
