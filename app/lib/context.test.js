'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { compactThreshold, handoffAdvice } = require('./context');
const { ChatRunner } = require('./chat');
const llm = require('./llm');
const { JobQueue } = require('./queue');
const { ConvWatcher } = require('./watch');
const { SchemaRegistry } = require('./schema');
const schemas = new SchemaRegistry(path.resolve(__dirname, '../../schemas'));
const threshold = 1000000;
const def = { id: 'fixture-model', contextWindow: 1048576 };
const generation = schemas.applyDefaults('settings.schema.json', {}).generation;

test('new defaults defer compaction while respecting a smaller model window', () => {
  assert.equal(generation.compactAtTokens, threshold);
  assert.equal(generation.compactKeepTurns, 8);
  assert.equal(generation.handoffAtTokens, 3000000);
  assert.equal(compactThreshold(generation, def).threshold, threshold);
  assert.equal(compactThreshold({ ...generation, compactAtPercent: 95 }, def).threshold, 996147);
  assert.equal(compactThreshold(generation, { contextWindow: 98304 }).threshold, 97320);
  assert.equal(compactThreshold({ ...generation, compactAtTokens: 100000 }, def).threshold, 100000);
});

test('compaction count and a long summary cannot trigger conversation rollover', () => {
  const conv = { compaction: { count: 50, summary: 'x'.repeat(100000), tokensBefore: threshold, tokensAfter: 20000 } };
  assert.equal(handoffAdvice(conv, 370000, threshold), null);
  assert.equal(handoffAdvice({}, 999999, threshold), null);
  assert.equal(handoffAdvice({}, 1000000, threshold), null);
  assert.match(handoffAdvice({}, 1000000, threshold, 3000000), /3,000,000/);
  assert.equal(handoffAdvice({ compaction: { tokensBefore: 120000, tokensAfter: 110000 } }, 390000, threshold), null);
});

test('one-million request pressure compacts while only three-million original text causes handoff', () => {
  const conv = { messages: [{ role: 'assistant', contextPeakTokens: threshold }], compaction: { count: 1, summary: '', tokensBefore: threshold + 10000, tokensAfter: threshold * 0.92 } };
  assert.equal(handoffAdvice(conv, threshold * 0.93, threshold), null);
  assert.equal(handoffAdvice(conv, threshold, threshold, 2999999), null);
  assert.match(handoffAdvice(conv, 20000, threshold, 3000000), /3,000,000/);
  conv.messages[0].contextPeakTokens = 0;
  assert.equal(handoffAdvice(conv, 20000, threshold), null);
  assert.equal(handoffAdvice(conv, 370000, Infinity), null);
});

function runnerFixture(conv) {
  const provider = { id: 'fixture', models: [def] };
  const r = Object.create(ChatRunner.prototype);
  r.store = {
    getSettings: () => ({ generation, activeProviderId: provider.id, activeModel: def.id }),
    getProvider: () => provider,
    getConversation: () => conv,
    saveConversation: () => schemas.assert('conversation.schema.json', conv)
  };
  r.overheadTokens = () => 1000;
  return { r, provider };
}

test('usage from before a summary boundary is not counted again after compaction', () => {
  const conv = { compaction: { upToMessageId: 'user01', createdAt: '2026-10-02T01:00:00Z' }, messages: [
    { id: 'user01', role: 'user', content: 'old' },
    { id: 'assist01', role: 'assistant', createdAt: '2026-10-02T00:00:00Z', durationMs: 7200000,
      usage: { prompt_tokens: 450000, completion_tokens: 400 }, usageContextBoundary: null, parts: [{ type: 'text', text: 'recent' }] }
  ] };
  const { r } = runnerFixture(conv);
  assert.equal(r.contextTokens(conv, {}).source, 'estimated');
  delete conv.messages[1].usageContextBoundary;
  assert.equal(r.contextTokens(conv, {}).source, 'estimated');
  conv.messages[1].usageContextBoundary = 'user01';
  assert.deepEqual(r.contextTokens(conv, {}), { tokens: 450400, source: 'measured' });
});

test('real compactor retains eight turns, original messages and correct identifiers', async () => {
  const conv = schemas.applyDefaults('conversation.schema.json', { id: 'fixture01', title: 'Fixture', createdAt: '2026-10-02T01:00:00Z', updatedAt: '2026-10-02T01:00:00Z', messages: [] });
  for (let i = 0; i < 12; i++) conv.messages.push({ id: 'user0' + String(i).padStart(2, '0'), role: 'user', createdAt: '2026-10-02T01:00:00Z', content: 'node-fixture-unchanged-' + i });
  const original = JSON.stringify(conv.messages);
  const { r, provider } = runnerFixture(conv);
  const complete = llm.complete;
  let calls = 0;
  llm.complete = async ({ messages }) => { calls++; assert.match(messages[1].content, /node-fixture-unchanged-3/); return 'Keep exact project and node IDs. Summary fixture.'; };
  try {
    assert.equal(await r.maybeCompact(conv, provider, def.id, () => {}, { measured: 120000 }), null);
    assert.equal(calls, 0);
    assert.equal(await r.maybeCompact(conv, provider, def.id, () => {}, { measured: 400000 }), null);
    assert.equal(calls, 0);
    const compacted = await r.maybeCompact(conv, provider, def.id, () => {}, { measured: threshold + 10000 });
    assert.equal(calls, 1);
    assert.equal(compacted.upToMessageId, 'user003');
    assert.equal(compacted.summarizedCount, 4);
    assert.equal(JSON.stringify(conv.messages), original);
    assert.equal(r.contextInfo(conv).handoffAdvice, null);
    schemas.assert('conversation.schema.json', { ...conv, messages: [...conv.messages, { id: 'assist02', role: 'assistant', createdAt: '2026-10-02T01:01:00Z', usageContextBoundary: 'user003' }] });
  } finally { llm.complete = complete; }
});

async function queuedContinuation(info) {
  const conv = { id: 'fixture01' };
  const job = { id: 'job0001', status: 'queued', conversationId: conv.id, conversations: [conv.id], checkpoint: '', continues: 0, handoffs: 0, attempts: 0, lastError: '', skills: [], attachments: [] };
  const q = { settings: { autoHandoff: true, handoffAtRatio: 0.8, autoContinueMax: 20 }, jobs: [job] };
  let handoffs = 0, rounds = 0;
  const store = { getQueue: () => q, saveQueue: () => {}, getConversation: () => conv, saveConversation: () => {} };
  const runner = { contextInfo: () => info, handoffDraft: async () => { handoffs++; return { summary: 'fixture', files: [] }; }, createHandoff: () => ({ id: 'fixture02' }),
    runHeadless: async () => ({ message: { status: 'complete', stopReason: ++rounds === 1 ? 'max_rounds' : '', parts: [{ type: 'text', text: rounds === 1 ? 'Progress' : '[JOB_DONE]' }] } }) };
  const queue = new JobQueue({ store, runner });
  await queue.run(job.id);
  assert.equal(job.status, 'done');
  return handoffs;
}

test('queue stays in the original conversation at its old 80% trigger', async () => {
  assert.equal(await queuedContinuation({ tokens: threshold * 0.85, threshold, handoffAdvice: null }), 0);
  assert.equal(await queuedContinuation({ tokens: threshold * 0.95, threshold, handoffAdvice: 'actual residual' }), 1);
});

test('watcher respects both genuine residual pressure and the auto-handoff switch', async () => {
  for (const [advice, enabled, expected] of [[null, true, 0], ['actual residual', false, 0], ['actual residual', true, 1]]) {
    let conv = { id: 'fixture01', watch: { enabled: true, intervalMin: 30 }, messages: [{ id: 'assist01', role: 'assistant', parts: [{ type: 'text', text: '[업무완료]' }] }] };
    let handoffs = 0;
    const store = { getSettings: () => ({ generation: { autoHandoff: enabled } }), getConversation: () => conv, saveConversation: () => {} };
    const runner = { isBusy: () => false, contextInfo: () => ({ tokens: 380000, threshold, handoffAdvice: advice }), handoffDraft: async () => { handoffs++; return { summary: 'fixture' }; },
      createHandoff: () => conv, runHeadless: async () => ({ message: { status: 'complete' } }) };
    const watcher = new ConvWatcher({ store, runner });
    await watcher.send(conv, 'continue fixture', 'fixture');
    assert.equal(handoffs, expected);
  }
});
