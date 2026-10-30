'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ChatRunner } = require('./chat');
const { SchemaRegistry } = require('./schema');
const { Store } = require('./store');
const { SECTIONS } = require('./handoff');
const llm = require('./llm');
const tools = require('./tools');

const validSummary = SECTIONS.map(section => `## ${section}\nNeutral fixture: retain the original instructions and verify pending work.`).join('\n');

function response() {
  const res = new EventEmitter();
  const events = [];
  let headers = 0;
  Object.assign(res, {
    writableEnded: false, writableFinished: false,
    writeHead() { headers++; },
    write(chunk) {
      const match = /^data: (.*)\n\n$/s.exec(String(chunk));
      if (match) events.push(JSON.parse(match[1]));
      return true;
    },
    end() { this.writableEnded = this.writableFinished = true; }
  });
  return { res, events, headers: () => headers };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-handoff-resume-'));
  // Only this test's generated directory may be removed.
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('flash-handoff-resume-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const reg = new SchemaRegistry(path.resolve(__dirname, '../../schemas'));
  const store = new Store(root, reg);
  for (const dir of Object.values(store.dirs)) fs.mkdirSync(dir, { recursive: true });
  const settings = reg.applyDefaults('settings.schema.json', {
    activeProviderId: 'fixture', activeModel: 'fixture-model', providers: [], systemPrompt: 'Retain approved neutral work.'
  });
  settings.generation.autoTitle = false;
  settings.generation.autoCompact = false;
  settings.generation.autoHandoff = true;
  settings.tools.maxRounds = 5;
  store.settings = settings;
  store.getProvider = () => ({ id: 'fixture', models: [{ id: 'fixture-model', tools: true, vision: false, contextWindow: 1048576 }] });
  store.getProject = () => null;
  const conv = store.createConversation({ title: 'Neutral rollover fixture', providerId: 'fixture', model: 'fixture-model', systemPrompt: 'Keep this original instruction.', skills: ['fixture-skill'] });
  conv.messages.push({ id: 'user0001', role: 'user', createdAt: new Date().toISOString(), content: 'Original neutral work; never use production services.' });
  reg.applyDefaults('conversation.schema.json', conv);
  store.saveConversation(conv, false);
  const runner = new ChatRunner({ store, mcp: {}, skills: {} });
  runner.systemPrompt = () => 'Neutral test instructions.';
  runner.overheadTokens = () => 0;
  runner.allToolDefs = () => [];
  runner.buildHistory = async room => room.messages.filter(message => message.role === 'user').map(message => ({ role: 'user', content: message.content }));
  const originals = { complete: llm.complete, streamChat: llm.streamChat, runImage: tools.runImage };
  t.after(() => Object.assign(llm, { complete: originals.complete, streamChat: originals.streamChat }));
  t.after(() => { tools.runImage = originals.runImage; });
  llm.complete = async () => validSummary;
  llm.streamChat = async () => { throw new Error('Unexpected model request: no network is allowed in this test.'); };
  tools.runImage = async () => { throw new Error('Unexpected image request: no paid generation is allowed in this test.'); };
  return { root, reg, store, settings, runner, conv, ...response() };
}

function thresholdInfo(advice = 'Neutral archive reached the rollover threshold.') {
  return { tokens: 1000, source: 'estimated', archiveTokens: advice ? 3000000 : 100, handoffThreshold: 3000000, threshold: 1000000, window: 1048576, handoffAdvice: advice };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function neutralSteerAttachment(f) {
  const att = { id: 'steerfile01', name: 'neutral-correction.txt', mime: 'text/plain', size: 26, kind: 'text', file: 'steerfile01.txt', url: '/files/uploads/steerfile01.txt' };
  fs.writeFileSync(path.join(f.store.dirs.uploads, att.file), 'NEUTRAL_ATTACHMENT_CONTENT', 'utf8');
  return att;
}

function addRecoveryRoom(f, { state = 'running', autoResume = true } = {}) {
  const source = f.store.createConversation({ title: 'Neutral recovery source', providerId: 'fixture', model: 'fixture-model' });
  source.messages.push({ id: 'usersrc01', role: 'user', createdAt: new Date().toISOString(), content: 'Keep the verified neutral recovery work.' });
  f.reg.applyDefaults('conversation.schema.json', source);
  f.store.saveConversation(source, false);
  const room = f.runner.createHandoff(source.id, { summary: validSummary, files: [], autoResume });
  room.handoff.resumeState = state;
  f.store.saveConversation(room, false);
  return room;
}

function restartedRunner(f) {
  const store = new Store(f.root, f.reg);
  store.settings = f.settings;
  store.getProvider = f.store.getProvider;
  store.getProject = () => null;
  return { store, runner: new ChatRunner({ store, mcp: {}, skills: {} }) };
}

function addRecoveryMessages(f, room, assistant) {
  const user = { id: 'userresume01', role: 'user', createdAt: new Date().toISOString(), content: 'Neutral synthetic recovery instruction.' };
  room.messages.push(user, { id: 'assistrec01', role: 'assistant', createdAt: new Date().toISOString(), ...assistant });
  room.handoff.resumeMessageId = user.id;
  f.reg.applyDefaults('conversation.schema.json', room);
  f.store.saveConversation(room, false);
}

async function until(check) {
  for (let count = 0; count < 200; count++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Neutral fixture did not reach the expected checkpoint.');
}

test('failed pre-turn handoff processes the saved user request once without retrying the handoff this turn', async t => {
  const f = fixture(t);
  f.runner.contextInfo = () => thresholdInfo();
  let drafts = 0, modelCalls = 0;
  f.runner.handoffDraft = async () => { drafts++; throw new Error('Neutral invalid handoff sections.'); };
  llm.streamChat = async args => {
    modelCalls++;
    assert.ok(args.messages.some(message => message.role === 'user' && message.content === 'Process this neutral request.'));
    args.onText('Processed the neutral request.');
    return { toolCalls: [] };
  };
  await f.runner.handle({}, f.res, { conversationId: f.conv.id, content: 'Process this neutral request.' });
  assert.equal(drafts, 1, 'A failed handoff must not retry before the same request has been processed.');
  assert.equal(modelCalls, 1);
  assert.ok(!f.conv.handedOffTo);
  assert.equal(f.conv.messages.filter(message => message.role === 'user' && message.content === 'Process this neutral request.').length, 1);
  assert.equal(f.conv.messages.at(-1).status, 'complete');
  assert.match(f.conv.messages.at(-1).content, /Processed the neutral request/);
  assert.notEqual(f.conv.messages.at(-1).stopReason, 'context_handoff');
  assert.equal(f.events.filter(event => event.type === 'handoff_failed').length, 1);
  assert.equal(f.runner.activeCount(), 0);
});

test('post-turn handoff retains source run ownership while drafting and rejects parallel execution', async t => {
  const f = fixture(t);
  let reachedThreshold = false, drafts = 0, modelCalls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  f.runner.contextInfo = () => thresholdInfo(reachedThreshold ? undefined : null);
  f.runner.handoffDraft = async () => {
    drafts++;
    if (drafts === 1) await gate;
    throw new Error('Neutral draft checkpoint stopped for this test.');
  };
  llm.streamChat = async args => {
    modelCalls++;
    args.onText('Original neutral request processed.');
    reachedThreshold = true;
    return { toolCalls: [] };
  };
  const work = f.runner.handle({}, f.res, { conversationId: f.conv.id, content: 'Process neutral work before rollover.' });
  try {
    await until(() => drafts === 1);
    assert.ok(f.runner.activeRunFor(f.conv.id), 'The source room must have an owner until rollover and continuation finish.');
    assert.ok(f.runner.activeCount() >= 1);
    const second = response();
    await assert.rejects(
      f.runner.handle({}, second.res, { conversationId: f.conv.id, content: 'Do not execute this parallel neutral request.' }),
      error => error.status === 409
    );
    assert.equal(drafts, 1);
    assert.equal(modelCalls, 1);
  } finally {
    release();
    await work;
  }
  assert.equal(f.runner.activeCount(), 0);
});

test('headless execution processes its request despite the desktop rollover threshold', async t => {
  const f = fixture(t);
  f.runner.contextInfo = () => thresholdInfo();
  let drafts = 0, modelCalls = 0;
  f.runner.handoffDraft = async () => { drafts++; throw new Error('Headless owners manage their own rollover.'); };
  llm.streamChat = async args => {
    modelCalls++;
    args.onText('Headless neutral request processed.');
    return { toolCalls: [] };
  };
  const result = await f.runner.runHeadless({ conversationId: f.conv.id, content: 'Process this headless neutral request.' });
  assert.equal(drafts, 0);
  assert.equal(modelCalls, 1);
  assert.equal(result.message.status, 'complete');
  assert.match(result.message.content, /Headless neutral request processed/);
  assert.notEqual(result.message.stopReason, 'context_handoff');
  assert.equal(f.runner.activeCount(), 0);
});

test('mid-turn rollover preserves the completed tool result and resumes through the same SSE stream', async t => {
  const f = fixture(t);
  f.conv.queueJobId = 'jobfixture01';
  f.store.saveConversation(f.conv, false);
  let reachedThreshold = false, modelCalls = 0, toolCalls = 0;
  f.runner.contextInfo = room => thresholdInfo(room.id === f.conv.id && reachedThreshold ? undefined : null);
  f.runner.handoffDraft = async () => ({ summary: validSummary, files: [] });
  f.runner.runTool = async (part, ctx, run, runId, send) => {
    assert.equal(part.name, 'fixture_read');
    toolCalls++;
    part.status = 'done'; part.result = 'Neutral verified read result.';
    reachedThreshold = true;
    send({ type: 'tool_status', id: part.id, status: part.status, result: part.result, isError: false });
  };
  llm.streamChat = async args => {
    modelCalls++;
    if (modelCalls === 1) return { toolCalls: [{ id: 'tool0001', name: 'fixture_read', arguments: '{}' }] };
    assert.ok(args.messages.some(message => message.role === 'user' && /자동 인계 재개/.test(message.content)));
    args.onText('Verified prior results and resumed the neutral work.');
    return { toolCalls: [] };
  };
  await f.runner.handle({}, f.res, { conversationId: f.conv.id, content: 'Read and continue the neutral fixture.' });
  assert.equal(toolCalls, 1, 'The completed source tool must not be replayed.');
  assert.equal(modelCalls, 2);
  assert.equal(f.headers(), 1);
  assert.equal(f.events.filter(event => event.type === 'start').length, 2);
  assert.equal(f.events.filter(event => event.type === 'handoff').length, 1);
  const next = f.store.getConversation(f.conv.handedOffTo);
  assert.equal(next.handoff.resumeState, 'done');
  assert.match(next.messages.at(-1).content, /resumed the neutral work/);
  const originalTool = f.conv.messages.flatMap(message => message.parts || []).find(part => part.type === 'tool_call');
  assert.equal(originalTool.result, 'Neutral verified read result.');
  assert.equal(next.systemPrompt, f.conv.systemPrompt);
  assert.deepEqual(next.skills, f.conv.skills);
  assert.equal(next.queueJobId, f.conv.queueJobId, 'The real Store must preserve the queue owner when a room rolls over.');
  assert.equal(f.runner.activeCount(), 0);
});

test('concurrent handoff draft requests share one build and release the reservation after completion', async t => {
  const f = fixture(t);
  let builds = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  f.runner.buildHandoffDraft = async () => {
    builds++;
    await gate;
    return { summary: validSummary, files: [] };
  };
  const first = f.runner.handoffDraft(f.conv.id, { force: true });
  const second = f.runner.handoffDraft(f.conv.id, { force: true });
  try {
    assert.equal(builds, 1, 'A second request must reuse the in-flight draft rather than spend another model call.');
  } finally {
    release();
  }
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(builds, 1);
  assert.equal(f.runner.activeCount(), 0);
});

test('new steering and its attachment received during pre-turn handoff are applied in the destination room', async t => {
  const f = fixture(t), gate = deferred(), att = neutralSteerAttachment(f);
  let draftStarted = false, modelCalls = 0;
  const correction = 'Latest neutral correction received while the pre-turn handoff is being written.';
  f.runner.contextInfo = room => thresholdInfo(room.id === f.conv.id ? undefined : null);
  f.runner.handoffDraft = async () => { draftStarted = true; await gate.promise; return { summary: validSummary, files: [] }; };
  llm.streamChat = async args => {
    modelCalls++;
    const request = JSON.stringify(args.messages);
    assert.ok(request.includes(correction));
    assert.ok(request.includes('NEUTRAL_ATTACHMENT_CONTENT'));
    args.onText('Applied the latest neutral correction.');
    return { toolCalls: [] };
  };
  const work = f.runner.handle({}, f.res, { conversationId: f.conv.id, content: 'Continue neutral work across this handoff.' });
  try {
    await until(() => draftStarted);
    assert.equal(f.runner.steer(f.runner.activeRunFor(f.conv.id), correction, { attachments: [att] }), true);
  } finally {
    gate.resolve();
    await work;
  }
  const next = f.store.getConversation(f.conv.handedOffTo);
  const steering = next.messages.flatMap(message => message.parts || []).filter(part => part.type === 'steer' && part.text === correction);
  assert.equal(modelCalls, 1);
  assert.equal(next.messages.at(-1).status, 'complete');
  assert.equal(steering.length, 1);
  assert.equal(steering[0].delivery, 'applied');
  assert.equal(steering[0].attachments[0].file, att.file);
  assert.equal(f.runner.activeCount(), 0);
});

test('pre-turn handoff carries the original request into one completed resume and exposes its run ID before drafting', async t => {
  const f = fixture(t);
  const carriedRequest = 'Carry this exact neutral user request across the pre-turn handoff.';
  let modelCalls = 0;
  f.runner.contextInfo = room => thresholdInfo(room.id === f.conv.id ? undefined : null);
  f.runner.handoffDraft = async () => ({ summary: validSummary, files: [] });
  llm.streamChat = async args => {
    modelCalls++;
    assert.ok(args.messages.some(message => message.role === 'user' && message.content === carriedRequest));
    args.onText('Completed the carried neutral request.');
    return { toolCalls: [] };
  };
  await f.runner.handle({}, f.res, { conversationId: f.conv.id, content: carriedRequest });
  const next = f.store.getConversation(f.conv.handedOffTo);
  const carried = next.messages.find(message => message.role === 'user' && message.content === carriedRequest);
  assert.equal(modelCalls, 1);
  assert.ok(carried);
  assert.equal(next.handoff.resumeState, 'done', 'A carried request is already the resumed turn; the UI must not auto-start another one.');
  assert.equal(next.handoff.resumeMessageId, carried.id);
  const draftEvent = f.events.find(event => event.type === 'handoff_start');
  const start = f.events.find(event => event.type === 'start');
  assert.ok(draftEvent.runId, 'The UI needs the current run ID to deliver steering while drafting is still in progress.');
  assert.equal(draftEvent.runId, start.runId);
  assert.equal(await f.runner.resumeHandoff({}, response().res, next, { tools: false }), false);
  assert.equal(modelCalls, 1);
});

test('an aborted pre-turn draft caller cannot create a destination or call the model after the draft returns', async t => {
  const f = fixture(t), gate = deferred();
  let draftStarted = false, modelCalls = 0;
  f.runner.contextInfo = () => thresholdInfo();
  f.runner.handoffDraft = async () => { draftStarted = true; await gate.promise; return { summary: validSummary, files: [] }; };
  llm.streamChat = async args => { modelCalls++; args.onText('This aborted neutral request must not run.'); return { toolCalls: [] }; };
  const work = f.runner.handle({}, f.res, { conversationId: f.conv.id, content: 'Neutral request disconnected while drafting.' });
  try {
    await until(() => draftStarted);
    f.res.emit('close');
  } finally {
    gate.resolve();
    await work.catch(error => { assert.ok(error.name === 'AbortError' || /abort/i.test(error.message)); });
  }
  assert.ok(!f.conv.handedOffTo);
  assert.equal(f.store.listConversations().length, 1);
  assert.equal(modelCalls, 0);
  assert.equal(f.runner.activeCount(), 0);
  assert.equal(f.runner.activeRunFor(f.conv.id), null);
});

test('new steering received after done while post-turn handoff is being written is inherited by the resumed run', async t => {
  const f = fixture(t), gate = deferred(), att = neutralSteerAttachment(f);
  let reachedThreshold = false, draftStarted = false, modelCalls = 0, correctionSeen = false;
  const correction = 'Latest neutral correction received while the post-turn handoff is being written.';
  f.runner.contextInfo = room => thresholdInfo(room.id === f.conv.id && reachedThreshold ? undefined : null);
  f.runner.handoffDraft = async () => { draftStarted = true; await gate.promise; return { summary: validSummary, files: [] }; };
  llm.streamChat = async args => {
    modelCalls++;
    if (modelCalls === 1) {
      reachedThreshold = true;
      args.onText('Completed the original neutral step.');
    } else {
      const request = JSON.stringify(args.messages);
      correctionSeen = request.includes(correction) && request.includes('NEUTRAL_ATTACHMENT_CONTENT');
      args.onText('Continued with the latest neutral correction.');
    }
    return { toolCalls: [] };
  };
  const work = f.runner.handle({}, f.res, { conversationId: f.conv.id, content: 'Finish this neutral step and continue after rollover.' });
  try {
    await until(() => draftStarted);
    assert.ok(f.events.some(event => event.type === 'done'));
    assert.equal(f.runner.steer(f.runner.activeRunFor(f.conv.id), correction, { attachments: [att] }), true);
  } finally {
    gate.resolve();
    await work;
  }
  const next = f.store.getConversation(f.conv.handedOffTo);
  const steering = next.messages.flatMap(message => message.parts || []).filter(part => part.type === 'steer' && part.text === correction);
  assert.equal(modelCalls, 2);
  assert.equal(correctionSeen, true, 'A post-draft correction must reach the resumed model request, not remain pending only in the source room.');
  assert.equal(steering.length, 1);
  assert.equal(steering[0].delivery, 'applied');
  assert.equal(steering[0].attachments[0].file, att.file);
  assert.equal(f.runner.activeCount(), 0);
});

test('source and destination aliases point to the active child run and reject duplicate execution', async t => {
  const f = fixture(t), gate = deferred();
  let reachedThreshold = false, childStarted = false, modelCalls = 0;
  f.runner.contextInfo = room => thresholdInfo(room.id === f.conv.id && reachedThreshold ? undefined : null);
  f.runner.handoffDraft = async () => ({ summary: validSummary, files: [] });
  llm.streamChat = async args => {
    modelCalls++;
    if (modelCalls === 1) reachedThreshold = true;
    else { childStarted = true; await gate.promise; }
    args.onText('Neutral run processed once.');
    return { toolCalls: [] };
  };
  const work = f.runner.handle({}, f.res, { conversationId: f.conv.id, content: 'Continue this neutral source request.' });
  try {
    await until(() => childStarted);
    const nextId = f.conv.handedOffTo;
    const sourceOwner = f.runner.activeRunFor(f.conv.id), destinationOwner = f.runner.activeRunFor(nextId);
    assert.ok(sourceOwner);
    assert.equal(sourceOwner, destinationOwner);
    assert.equal(f.runner.runs.get(sourceOwner).convId, nextId);
    for (const conversationId of [f.conv.id, nextId]) {
      await assert.rejects(f.runner.handle({}, response().res, { conversationId, content: 'Do not duplicate this neutral request.' }), error => error.status === 409);
    }
    assert.equal(modelCalls, 2);
  } finally {
    gate.resolve();
    await work;
  }
  assert.equal(f.runner.activeRunFor(f.conv.id), null);
  assert.equal(f.runner.activeRunFor(f.conv.handedOffTo), null);
  assert.equal(f.runner.activeCount(), 0);
});

test('draft checkpoints reuse completed model boundaries after failure and process newly appended original work', async t => {
  const f = fixture(t);
  const firstMarker = 'NEUTRAL_ORIGINAL_FIRST';
  const tailMarker = 'NEUTRAL_ORIGINAL_LAST';
  f.conv.messages[0].content = firstMarker + 'x'.repeat(90000) + 'NEUTRAL_FIRST_BOUNDARY_END';
  f.conv.messages.push({ id: 'user0003', role: 'user', createdAt: new Date().toISOString(), content: 'NEUTRAL_SECOND_BOUNDARY_START' + 'y'.repeat(130000) + tailMarker });
  f.reg.applyDefaults('conversation.schema.json', f.conv);
  f.store.saveConversation(f.conv, false);
  let calls = 0;
  llm.complete = async () => {
    calls++;
    if (calls === 2) throw new Error('Neutral interrupted model call.');
    return validSummary + '\nCompleted neutral boundary one.';
  };
  await assert.rejects(f.runner.handoffDraft(f.conv.id), /Neutral interrupted model call/);
  assert.equal(calls, 2);
  assert.equal(f.runner.activeCount(), 0);
  const reloadedStore = new Store(f.root, f.reg);
  reloadedStore.settings = f.settings;
  reloadedStore.getProvider = f.store.getProvider;
  reloadedStore.getProject = () => null;
  const restarted = new ChatRunner({ store: reloadedStore, mcp: {}, skills: {} });
  const inputs = [], progress = [];
  llm.complete = async args => { inputs.push(args.messages[1].content); return validSummary + '\nRecovered neutral remainder.'; };
  await restarted.handoffDraft(f.conv.id, { onProgress: event => progress.push(event) });
  assert.ok(progress.some(event => event.reused === 1));
  assert.ok(inputs.every(input => !input.includes(firstMarker)), 'The committed original chunk must not be sent again.');
  assert.ok(inputs.join('').includes(tailMarker), 'Original work beyond the interrupted call must still be processed.');
  const oldCalls = inputs.length;
  inputs.length = 0;
  const current = reloadedStore.getConversation(f.conv.id);
  current.messages.push({ id: 'user0002', role: 'user', createdAt: new Date().toISOString(), content: 'NEUTRAL_APPENDED_USER_CORRECTION' });
  reloadedStore.reg.applyDefaults('conversation.schema.json', current);
  reloadedStore.saveConversation(current, false);
  await restarted.handoffDraft(f.conv.id);
  assert.ok(oldCalls >= 1);
  assert.ok(inputs.join('').includes('NEUTRAL_APPENDED_USER_CORRECTION'));
  assert.ok(inputs.every(input => !input.includes(firstMarker)));
  assert.equal(restarted.activeCount(), 0);
});

test('verified ancestor snapshots reuse the prior handoff while preserving later corrections and changed original prefixes', async t => {
  const f = fixture(t), inputs = [];
  const originalMarker = 'NEUTRAL_VERIFIED_ANCESTOR_ORIGINAL';
  f.conv.messages[0].content = originalMarker;
  f.store.saveConversation(f.conv, false);
  llm.complete = async args => { inputs.push(args.messages[1].content); return validSummary; };
  const originalDraft = await f.runner.handoffDraft(f.conv.id);
  const next = f.runner.createHandoff(f.conv.id, originalDraft);
  assert.ok(next.handoff.sourceSnapshots.some(item => item.conversationId === f.conv.id));
  f.conv.messages.push({ id: 'userlate01', role: 'user', createdAt: new Date().toISOString(), content: 'NEUTRAL_LATE_ANCESTOR_CORRECTION' });
  next.messages.push({ id: 'usernext01', role: 'user', createdAt: new Date().toISOString(), content: 'NEUTRAL_NEW_ROOM_BACKLOG' });
  for (const room of [f.conv, next]) { f.reg.applyDefaults('conversation.schema.json', room); f.store.saveConversation(room, false); }
  inputs.length = 0;
  await f.runner.handoffDraft(next.id);
  assert.ok(inputs.join('').includes('NEUTRAL_LATE_ANCESTOR_CORRECTION'));
  assert.ok(inputs.join('').includes('NEUTRAL_NEW_ROOM_BACKLOG'));
  assert.ok(inputs.every(input => !input.includes(originalMarker)), 'An unchanged covered ancestor prefix must not trigger another original re-summary.');
  f.conv.messages[0].content += ' NEUTRAL_CHANGED_ORIGINAL_PREFIX';
  f.store.saveConversation(f.conv, false);
  inputs.length = 0;
  await f.runner.handoffDraft(next.id);
  assert.ok(inputs.join('').includes(originalMarker));
  assert.ok(inputs.join('').includes('NEUTRAL_CHANGED_ORIGINAL_PREFIX'), 'A changed covered prefix invalidates reuse and must be compared from original source again.');
  assert.equal(f.runner.activeCount(), 0);
});

test('restart recovery makes an unstarted running handoff pending exactly once without creating a model turn', t => {
  const f = fixture(t), room = addRecoveryRoom(f);
  const restarted = restartedRunner(f);
  assert.equal(restarted.runner.recoverHandoffStates(), 1);
  const recovered = restarted.store.getConversation(room.id);
  assert.equal(recovered.handoff.resumeState, 'pending');
  assert.equal(recovered.handoff.recoveryCount, 1);
  assert.equal(recovered.messages.length, 0);
  assert.equal(restarted.runner.recoverHandoffStates(), 0);
  assert.equal(recovered.handoff.recoveryCount, 1);
  assert.equal(restarted.runner.activeCount(), 0);
  const persisted = JSON.parse(fs.readFileSync(restarted.store.convPath(room.id), 'utf8'));
  assert.equal(persisted.handoff.resumeState, 'pending');
});

test('restart recovery recognizes a complete resumed response as done without changing its verified results', t => {
  const f = fixture(t), room = addRecoveryRoom(f);
  addRecoveryMessages(f, room, { status: 'complete', content: 'Neutral completed result.', parts: [{ type: 'text', text: 'Neutral completed result.' }, { type: 'tool_call', id: 'toolrec01', name: 'fixture_read', arguments: '{}', status: 'done', result: 'Verified neutral result receipt.', isError: false }] });
  const original = JSON.stringify(room.messages);
  const restarted = restartedRunner(f);
  assert.equal(restarted.runner.recoverHandoffStates(), 0);
  const recovered = restarted.store.getConversation(room.id);
  assert.equal(recovered.handoff.resumeState, 'done');
  assert.equal(JSON.stringify(recovered.messages), original);
  assert.equal(recovered.handoff.resumeMessageId, 'userresume01');
  assert.equal(restarted.runner.recoverHandoffStates(), 0);
});

test('restart recovery preserves partial text and known tool receipts while marking interrupted tool requests unverified', t => {
  const f = fixture(t), room = addRecoveryRoom(f);
  const inflight = ['pending', 'running', 'awaiting_approval', 'awaiting_answer'];
  const known = [
    { type: 'tool_call', id: 'known001', name: 'fixture_done', arguments: '{}', status: 'done', result: 'Completed neutral result.', isError: false },
    { type: 'tool_call', id: 'known002', name: 'fixture_error', arguments: '{}', status: 'error', result: 'Existing neutral error.', isError: true },
    { type: 'tool_call', id: 'known003', name: 'fixture_denied', arguments: '{}', status: 'denied', result: 'Existing neutral refusal.', isError: true }
  ];
  addRecoveryMessages(f, room, { status: 'streaming', content: 'Neutral partial text.', parts: [
    { type: 'text', text: 'Neutral partial text.' },
    ...inflight.map((status, index) => ({ type: 'tool_call', id: `flight00${index}`, name: `fixture_${status}`, arguments: '{"neutral":true}', status, result: status === 'running' ? 'Submitted neutral job receipt.' : '', isError: false })),
    ...known
  ] });
  const originals = room.messages.at(-1).parts.filter(part => known.some(item => item.id === part.id)).map(part => JSON.stringify(part));
  const restarted = restartedRunner(f);
  assert.equal(restarted.runner.recoverHandoffStates(), 1);
  const recovered = restarted.store.getConversation(room.id), assistant = recovered.messages.at(-1);
  assert.equal(recovered.handoff.resumeState, 'pending');
  assert.equal(assistant.status, 'stopped');
  assert.equal(assistant.content, 'Neutral partial text.');
  assert.equal(assistant.parts[0].text, 'Neutral partial text.');
  assert.match(assistant.error, /기존 도구 결과/);
  for (const [index, status] of inflight.entries()) {
    const part = assistant.parts.find(item => item.id === `flight00${index}`);
    assert.equal(part.status, 'error');
    assert.equal(part.isError, true);
    assert.equal(part.arguments, '{"neutral":true}');
    if (status === 'running') assert.ok(part.result.includes('Submitted neutral job receipt.'), 'A submitted receipt must be preserved for external state verification.');
    else assert.match(part.result, /미확인/);
  }
  assert.deepEqual(assistant.parts.filter(part => known.some(item => item.id === part.id)).map(part => JSON.stringify(part)), originals);
  assert.equal(restarted.runner.recoverHandoffStates(), 0);
  assert.equal(recovered.handoff.recoveryCount, 1);
});

test('restart recovery leaves explicitly stopped, queued, legacy, handed-off and actively owned rooms untouched', t => {
  const f = fixture(t);
  const stopped = addRecoveryRoom(f, { state: 'stopped' });
  const queued = addRecoveryRoom(f); queued.queueJobId = 'jobfixture01';
  const legacy = addRecoveryRoom(f, { autoResume: false });
  const handedOff = addRecoveryRoom(f); handedOff.handedOffTo = f.store.createConversation({ title: 'Neutral later room' }).id;
  const active = addRecoveryRoom(f);
  const rooms = [stopped, queued, legacy, handedOff, active];
  for (const room of rooms) f.store.saveConversation(room, false);
  const originals = new Map(rooms.map(room => [room.id, fs.readFileSync(f.store.convPath(room.id), 'utf8')]));
  const restarted = restartedRunner(f);
  restarted.runner.runs.set('ownedfixture', { convId: active.id, sourceConvIds: new Set([active.id]) });
  assert.equal(restarted.runner.recoverHandoffStates(), 0);
  for (const room of rooms) assert.equal(fs.readFileSync(f.store.convPath(room.id), 'utf8'), originals.get(room.id));
  assert.equal(restarted.runner.activeRunFor(active.id), 'ownedfixture');
  restarted.runner.runs.delete('ownedfixture');
});

test('pending recovery is claimed once and keeps a tool-disabled request disabled throughout the resumed run', async t => {
  const f = fixture(t), room = addRecoveryRoom(f, { state: 'pending' }), gate = deferred();
  let started = false, modelCalls = 0;
  f.runner.contextInfo = () => thresholdInfo(null);
  f.runner.allToolDefs = () => { throw new Error('The recovered request disabled tools.'); };
  llm.streamChat = async args => {
    modelCalls++;
    assert.deepEqual(args.tools, []);
    assert.equal(args.params.thinking, false);
    started = true;
    await gate.promise;
    args.onText('Neutral recovered request completed once.');
    return { toolCalls: [] };
  };
  const work = f.runner.resumeHandoff({}, f.res, room, { tools: false, thinking: false, imageMode: true });
  try {
    await until(() => started);
    assert.equal(room.handoff.resumeState, 'running');
    assert.equal(await f.runner.resumeHandoff({}, response().res, room, { tools: true }), false);
    assert.equal(modelCalls, 1);
  } finally {
    gate.resolve();
    await work;
  }
  assert.equal(room.handoff.resumeState, 'done');
  assert.equal(await f.runner.resumeHandoff({}, response().res, room, { tools: false }), false);
  assert.equal(modelCalls, 1);
  assert.equal(f.runner.activeCount(), 0);
});

test('a recovery call with no started assistant remains pending instead of reporting done', async t => {
  const f = fixture(t), room = addRecoveryRoom(f, { state: 'pending' });
  f.runner.handle = async () => {};
  await f.runner.resumeHandoff({}, f.res, room, { tools: false });
  assert.equal(room.messages.length, 0);
  assert.equal(room.handoff.resumeState, 'pending');
});

test('an ended recovery stream leaves the room pending without starting an unobserved resumed run', async t => {
  const f = fixture(t), room = addRecoveryRoom(f, { state: 'pending' });
  let calls = 0;
  f.runner.handle = async () => { calls++; };
  f.res.end();
  assert.equal(await f.runner.resumeHandoff({}, f.res, room, { tools: false }), false);
  assert.equal(calls, 0);
  assert.equal(room.handoff.resumeState, 'pending');
  assert.equal(room.messages.length, 0);
});

test('unexpected conversation save failures release the owned run and its keepalive timer', async t => {
  const f = fixture(t), timers = new Set(), originalInterval = global.setInterval;
  f.runner.contextInfo = () => thresholdInfo(null);
  global.setInterval = (...args) => { const timer = originalInterval(...args); timers.add(timer); return timer; };
  t.after(() => { global.setInterval = originalInterval; for (const timer of timers) clearInterval(timer); });
  f.store.saveConversation = () => { throw new Error('Neutral injected save failure.'); };
  await assert.rejects(f.runner.handle({}, f.res, { conversationId: f.conv.id, content: 'Neutral save failure fixture.' }), /Neutral injected save failure/);
  assert.equal(f.runner.activeCount(), 0, 'An exception before the model loop must not leave a busy source room.');
  assert.equal(f.runner.activeRunFor(f.conv.id), null);
  for (const timer of timers) assert.equal(timer._destroyed, true, 'Keepalive timers must be cleared even when persistence fails.');
});

test('automatic rollover never replays direct image generation with its synthetic continuation prompt', async t => {
  const f = fixture(t);
  let imageCalls = 0;
  f.runner.contextInfo = room => thresholdInfo(room.id === f.conv.id && imageCalls > 0 ? undefined : null);
  f.runner.handoffDraft = async () => ({ summary: validSummary, files: [] });
  tools.runImage = async ({ prompt }) => {
    imageCalls++;
    if (imageCalls === 1) assert.equal(prompt, 'Neutral image fixture prompt.');
    return [];
  };
  llm.streamChat = async args => { args.onText('The approved image step is already complete.'); return { toolCalls: [] }; };
  await f.runner.handle({}, f.res, { conversationId: f.conv.id, content: 'Neutral image fixture prompt.', options: { imageMode: true } });
  assert.equal(imageCalls, 1, 'Synthetic handoff instructions must never become another paid image prompt.');
  assert.equal(f.runner.activeCount(), 0);
});
