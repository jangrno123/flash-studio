'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SchemaRegistry } = require('./schema'), { Store } = require('./store');
const { ChatRunner } = require('./chat'), llm = require('./llm'), handoff = require('./handoff');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-steering-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reg = new SchemaRegistry(path.resolve(__dirname, '../../schemas')), store = new Store(root, reg);
  for (const dir of [store.dirs.conversations, store.dirs.uploads]) fs.mkdirSync(dir, { recursive: true });
  const conv = reg.applyDefaults('conversation.schema.json', { id: 'fixture01', title: 'Preserved project', createdAt: '2026-10-02', updatedAt: '2026-10-02', messages: [] });
  store.saveConversation(conv);
  const settings = reg.applyDefaults('settings.schema.json', { activeProviderId: 'fixture', activeModel: 'fixture', providers: [], systemPrompt: 'Preserve approved work' });
  settings.generation.autoTitle = false; settings.generation.autoCompact = false; settings.generation.autoHandoff = false;
  store.settings = settings; store.getProvider = () => ({ id: 'fixture', models: [{ id: 'fixture', tools: true, vision: true, contextWindow: 1048576 }] });
  const runner = new ChatRunner({ store, mcp: {}, skills: {} });
  runner.systemPrompt = () => 'Preserve work'; runner.overheadTokens = () => 0; runner.allToolDefs = () => [];
  const events = [], res = new EventEmitter();
  Object.assign(res, { writableEnded: false, writableFinished: false, writeHead() {}, write(s) { if (s.startsWith('data: ')) events.push(JSON.parse(s.slice(6))); }, end() { this.writableEnded = this.writableFinished = true; } });
  const att = { id: 'image001', name: 'reference.png', mime: 'image/png', size: 68, kind: 'image', file: 'image001.png', url: '/files/uploads/image001.png' };
  fs.writeFileSync(path.join(store.dirs.uploads, att.file), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFbkAAAAASUVORK5CYII=', 'base64'));
  return { root, store, runner, conv, events, res, att };
}
const until = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('fixture did not progress'); };

test('immediate image steering interrupts only model stream, preserves partial response and same conversation', async t => {
  const f = fixture(t), original = llm.streamChat; t.after(() => { llm.streamChat = original; });
  let calls = 0, interrupted = false;
  llm.streamChat = async args => {
    calls++;
    if (calls === 1) {
      args.onText('Already completed work. ');
      return new Promise((resolve, reject) => args.signal.addEventListener('abort', () => { interrupted = true; reject(new Error('request aborted')); }, { once: true }));
    }
    const steering = args.messages.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'text' && p.text.includes('Use the attached composition')));
    assert.ok(steering); assert.ok(steering.content.some(p => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));
    args.onText('Applied new composition.'); return { toolCalls: [] };
  };
  const work = f.runner.handle({}, f.res, { conversationId: f.conv.id, content: 'Inspect only; no paid generation' });
  await until(() => calls === 1);
  const runId = f.runner.activeRunFor(f.conv.id), run = f.runner.runs.get(runId);
  assert.equal(f.runner.steer(runId, 'Use the attached composition', { attachments: [f.att], immediate: true }), true);
  const persisted = f.store.getConversation(f.conv.id).messages.at(-1).parts.find(p => p.type === 'steer');
  assert.equal(persisted.delivery, 'pending'); assert.equal(persisted.attachments[0].file, f.att.file);
  assert.equal(run.controller.signal.aborted, false); assert.equal(run.allowAll.size, 0);
  await work; assert.equal(interrupted, true); assert.equal(calls, 2); assert.equal(f.runner.activeCount(), 0);
  const saved = f.store.getConversation(f.conv.id);
  assert.equal(saved.messages.length, 2); assert.match(saved.messages.at(-1).content, /Already completed work.*Applied new composition/);
  const part = saved.messages.at(-1).parts.find(p => p.type === 'steer'); assert.equal(part.delivery, 'applied');
  assert.equal(saved.messages.at(-1).parts.filter(p => p.type === 'steer').length, 1);
  assert.ok(f.events.some(e => e.type === 'steer' && e.part.delivery === 'applied'));
  const records = handoff.sourceRecords([saved]); assert.equal(records.find(r => r.type === 'steer').attachments[0].ref, 'data/uploads/image001.png');
  assert.ok(handoff.transcriptChunks([saved]).join('').includes('reference.png'));
});

test('immediate steering preserves in-flight tool result and cancels only unstarted old tool calls', async t => {
  const f = fixture(t), original = llm.streamChat; t.after(() => { llm.streamChat = original; });
  let calls = 0, finishTool, toolSignal, toolsRun = [];
  llm.streamChat = async args => {
    calls++;
    if (calls === 1) return { toolCalls: [{ id: 'tool001', name: 'submitted_work', arguments: '{}' }, { id: 'tool002', name: 'old_next_write', arguments: '{}' }] };
    assert.ok(args.messages.some(m => m.role === 'user' && String(m.content).includes('Change next action')));
    assert.ok(args.messages.some(m => m.role === 'tool' && m.content.includes('existing-job-completed')));
    return { toolCalls: [] };
  };
  f.runner.runTool = async (part, ctx) => {
    toolsRun.push(part.name); part.status = 'running'; toolSignal = ctx.signal;
    await new Promise(resolve => { finishTool = resolve; }); part.status = 'done'; part.result = 'existing-job-completed';
  };
  const work = f.runner.handle({}, f.res, { conversationId: f.conv.id, content: 'Continue authorized work' });
  await until(() => finishTool);
  f.runner.steer(f.runner.activeRunFor(f.conv.id), 'Change next action', { immediate: true });
  assert.equal(toolSignal.aborted, false); finishTool(); await work;
  assert.deepEqual(toolsRun, ['submitted_work']); assert.equal(calls, 2);
  const parts = f.store.getConversation(f.conv.id).messages.at(-1).parts;
  assert.equal(parts.find(p => p.id === 'tool002').status, 'denied');
  assert.equal(parts.find(p => p.id === 'tool001').result, 'existing-job-completed');
});

test('attachment validation and image-only instruction retain files without changing approval grants', t => {
  const f = fixture(t), run = { convId: f.conv.id, steer: [], controller: new AbortController(), allowAll: new Set(['existing-grant']) };
  f.runner.runs.set('run001', run);
  assert.throws(() => f.runner.steer('run001', 'bad', { attachments: [{ ...f.att, file: '../outside.png' }] }), /스키마/);
  assert.throws(() => f.runner.steer('run001', 'bad', { attachments: [{ ...f.att, file: 'missing.png' }] }), /첨부 파일/);
  assert.equal(run.steer.length, 0);
  assert.equal(f.runner.steer('run001', '', { attachments: [f.att] }), true);
  assert.equal(run.steer[0].attachments[0].file, f.att.file); assert.equal(run.steer[0].immediate, false);
  assert.deepEqual([...run.allowAll], ['existing-grant']);
  assert.equal(f.runner.steer('not-running', 'instruction'), false);
});
