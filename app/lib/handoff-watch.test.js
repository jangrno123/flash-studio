'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConvWatcher } = require('./watch');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// All state is in memory. This fixture never starts a server, reads user data,
// calls a model, generates assets, or writes files.
function fixture() {
  const source = {
    id: 'watchsource01', title: 'Neutral watched source',
    messages: [{ id: 'user0001', role: 'user', content: 'Neutral existing work.' }, { id: 'assist001', role: 'assistant', status: 'complete', parts: [{ type: 'text', text: 'Neutral work is pending.' }] }],
    watch: { enabled: true, intervalMin: 37, state: 'watching', continues: 2, failStreak: 1, seen: 'assist001', nextCheckAt: null, note: 'Original neutral watch preference.' }
  };
  const rooms = new Map([[source.id, source]]), saves = [], creations = [], executions = [];
  let sourceBusy = false;
  const packet = {
    summary: 'Neutral verified handoff summary.', files: [{ label: 'Neutral original', ref: 'assets/neutral-original.txt' }],
    sourceSnapshots: [{ conversationId: source.id, messageCount: source.messages.length, sha256: 'a'.repeat(64) }]
  };
  const store = {
    getSettings: () => ({ generation: { autoHandoff: true } }),
    getConversation: id => { assert.ok(rooms.has(id), 'The fixture cannot access any other conversation.'); return rooms.get(id); },
    saveConversation: room => { saves.push(room.id); rooms.set(room.id, room); },
    listConversations: () => [...rooms.values()].map(room => ({ id: room.id, watch: room.watch.enabled ? room.watch.state : null }))
  };
  const runner = {
    isBusy: id => id === source.id && sourceBusy,
    contextInfo: () => ({ handoffAdvice: 'Neutral source reached its rollover threshold.' }),
    handoffDraft: async () => packet,
    createHandoff: (id, draft) => {
      assert.equal(id, source.id);
      creations.push(draft);
      const next = { id: 'watchnext01', title: 'Neutral watched next', messages: [], watch: { ...source.watch, seen: null }, handoff: { summary: draft.summary, files: draft.files, sourceSnapshots: draft.sourceSnapshots } };
      rooms.set(next.id, next);
      source.handedOffTo = next.id;
      source.watch = { ...source.watch, enabled: false, state: 'off' };
      return next;
    },
    runHeadless: async (body, extra) => {
      executions.push({ body, extra });
      const room = store.getConversation(body.conversationId);
      const message = { id: 'assist002', role: 'assistant', status: 'complete', parts: [{ type: 'text', text: '[대기]' }] };
      room.messages.push({ id: 'user0002', role: 'user', content: body.content }, message);
      return { message, error: '' };
    }
  };
  return { source, rooms, packet, saves, creations, executions, store, runner, watcher: new ConvWatcher({ store, runner }), setSourceBusy(value) { sourceBusy = value; } };
}

test('a watcher awaiting a shared handoff yields when an interactive run has claimed the source', async () => {
  const f = fixture(), gate = deferred();
  const original = JSON.stringify(f.source);
  let drafting = false;
  f.runner.handoffDraft = async () => { drafting = true; return gate.promise; };
  const work = f.watcher.send(f.source, '[자동 점검] Neutral continuation.', 'Neutral watch tick');
  assert.equal(drafting, true);
  assert.equal(f.watcher.running.has(f.source.id), true);
  f.setSourceBusy(true);
  gate.resolve(f.packet);
  await work;
  assert.equal(f.creations.length, 0, 'The watcher must not create or reuse another destination after the interactive source claim.');
  assert.equal(f.executions.length, 0, 'The watcher must not start a second headless run.');
  assert.equal(f.saves.length, 0);
  assert.equal(JSON.stringify(f.source), original, 'The user watch preferences and source data must remain intact.');
  assert.equal(f.watcher.running.size, 0);
});

test('an unclaimed watcher continues once and passes the complete handoff snapshot metadata', async () => {
  const f = fixture();
  const originalInterval = f.source.watch.intervalMin;
  const content = '[자동 점검] Continue this neutral watched work once.';
  await f.watcher.send(f.source, content, 'Neutral ordinary watch tick');
  assert.equal(f.creations.length, 1);
  assert.equal(f.executions.length, 1);
  assert.equal(f.creations[0].summary, f.packet.summary);
  assert.deepEqual(f.creations[0].files, f.packet.files);
  assert.deepEqual(f.creations[0].sourceSnapshots, f.packet.sourceSnapshots, 'Verified ancestor boundaries must reach createHandoff unchanged.');
  const next = f.rooms.get(f.source.handedOffTo);
  assert.deepEqual(next.handoff.sourceSnapshots, f.packet.sourceSnapshots);
  assert.equal(next.watch.enabled, true);
  assert.equal(next.watch.intervalMin, originalInterval);
  assert.equal(next.watch.continues, 3);
  assert.equal(next.watch.failStreak, 0);
  assert.equal(f.executions[0].body.conversationId, next.id);
  assert.equal(f.executions[0].body.content, content);
  assert.deepEqual(f.executions[0].extra, { watch: true });
  assert.equal(f.source.watch.enabled, false);
  assert.equal(f.watcher.running.size, 0, 'The source reservation must be released even when c changes to the destination.');
});

test('a watcher releases its source reservation when shared handoff drafting fails', async () => {
  const f = fixture();
  f.runner.handoffDraft = async () => { throw new Error('Neutral shared draft failure.'); };
  await assert.rejects(f.watcher.send(f.source, '[자동 점검] Neutral continuation.', 'Neutral failure tick'), /Neutral shared draft failure/);
  assert.equal(f.creations.length, 0);
  assert.equal(f.executions.length, 0);
  assert.equal(f.watcher.running.size, 0);
  assert.equal(f.source.watch.enabled, true);
});
