'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { SchemaRegistry } = require('./schema'), { Store } = require('./store');
const { JobQueue } = require('./queue');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-queue-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reg = new SchemaRegistry(path.resolve(__dirname, '../../schemas')), store = new Store(root, reg);
  fs.mkdirSync(store.dirs.conversations, { recursive: true });
  store.saveQueue(reg.applyDefaults('queue.schema.json', { version: 1, settings: {}, jobs: [] }));
  const conv = reg.applyDefaults('conversation.schema.json', { id: 'fixture01', title: 'Neutral task', createdAt: '2026-10-03', updatedAt: '2026-10-03', systemPrompt: 'Keep original layout', skills: ['preserve-layout'], providerId: 'provider01', model: 'model01', messages: [{ id: 'message01', role: 'user', content: 'Check the attached diagram. No rendering.', createdAt: '2026-10-03', attachments: [{ id: 'image001', name: 'diagram.png', mime: 'image/png', size: 68, kind: 'image', file: 'image001.png', url: '/files/uploads/image001.png' }] }] });
  store.saveConversation(conv);
  const captured = [];
  const runner = { runs: new Map(), runHeadless: async body => { captured.push(body); return { message: { parts: [{ type: 'text', text: 'Checked.\n[JOB_DONE]' }] } }; } };
  const queue = new JobQueue({ store, runner }); queue.tick = () => {};
  return { queue, store, conv, captured };
}
const jobs = [{ title: 'Inspect diagram', prompt: 'Inspect only; do not generate.' }, { title: 'Report', prompt: 'Write the findings.', after_previous: true }];
test('model registration is denied by default, user queue remains available', t => {
  const f = fixture(t);
  assert.throws(() => f.queue.addModelBatch(f.conv, jobs), /자동 대기열 등록/);
  assert.equal(f.queue.load().jobs.length, 0);
  assert.equal(f.queue.add(jobs).length, 2);
});
test('unapproved existing model jobs remain stored and cannot be selected for execution', t => {
  const f = fixture(t), q = f.queue.load(); q.settings.allowModelRegistration = true; f.queue.save(q);
  f.queue.addModelBatch(f.conv, jobs);
  const before = f.queue.load(); before.settings.allowModelRegistration = false; f.queue.save(before);
  assert.equal(f.queue.next(f.queue.load()), null); assert.equal(f.queue.load().jobs.length, 2);
  const allowed = f.queue.load(); allowed.settings.allowModelRegistration = true;
  assert.ok(f.queue.next(allowed));
});
test('authorized model batch is atomic and idempotent, preserves source context in actual execution', async t => {
  const f = fixture(t), q = f.queue.load(); q.settings.allowModelRegistration = true; f.queue.save(q);
  const first = f.queue.addModelBatch(f.conv, jobs), second = f.queue.addModelBatch(f.conv, jobs);
  assert.equal(second.reused, true); assert.deepEqual(first.jobs.map(j => j.id), second.jobs.map(j => j.id));
  assert.equal(f.queue.load().jobs.length, 2);
  assert.deepEqual(first.jobs[1].dependsOn, [first.jobs[0].id]);
  assert.equal(first.jobs[0].sourceMessageId, 'message01');
  assert.equal(first.jobs[0].approval.images, false);
  const prepared = f.queue.conversationFor(first.jobs[0]);
  assert.equal(prepared.conv.systemPrompt, f.conv.systemPrompt);
  assert.equal(prepared.conv.providerId, f.conv.providerId);
  assert.equal(prepared.conv.model, f.conv.model);
  assert.deepEqual(prepared.conv.skills, f.conv.skills);
  await f.queue.run(first.jobs[0].id);
  assert.match(f.captured[0].content, /Check the attached diagram\. No rendering\./);
  assert.match(f.captured[0].content, /Inspect only; do not generate\./);
  assert.deepEqual(f.captured[0].attachments, f.conv.messages[0].attachments);
});
test('nested registration, cross-project changes and invalid batch do not create jobs', t => {
  const f = fixture(t), q = f.queue.load(); q.settings.allowModelRegistration = true; f.queue.save(q);
  assert.throws(() => f.queue.addModelBatch({ ...f.conv, queueJobId: 'queued001' }, jobs), /자동 생성/);
  assert.throws(() => f.queue.addModelBatch(f.conv, [{ ...jobs[0], project_id: 'other-project' }]), /다른 프로젝트/);
  assert.throws(() => f.queue.addModelBatch(f.conv, [jobs[0], { title: 'Invalid', prompt: '' }]), /비어/);
  assert.equal(f.queue.load().jobs.length, 0);
});
