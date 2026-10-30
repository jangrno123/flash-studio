'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { HandoffCheckpoint, VERSION, HASH_BINDING, SUMMARY_LIMIT } = require('./handoff-checkpoint');
const { SECTIONS } = require('./handoff');

const valid = note => SECTIONS.map(section => `## ${section}\n${note}`).join('\n');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-handoff-checkpoint-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { directory, conversationId: 'fixture01', baseInput: { instructions: 'Keep original assets', previousHandoff: '', skills: ['fixture'] }, chunks: ['old original', 'middle original', 'last original'] };
  return { directory, options, open: extra => new HandoffCheckpoint({ ...options, ...extra }) };
}
async function draft(checkpoint, summarize) {
  let { completed, summary, total } = checkpoint.read();
  for (let index = completed; index < total; index++) {
    summary = await summarize(index, summary);
    checkpoint.commit(index, summary);
  }
  return checkpoint.read();
}

test('a completed draft reuses all summaries with zero extra model calls', async t => {
  const f = fixture(t); let calls = 0;
  const summarize = async (index, summary) => { calls++; if (index) assert.equal(summary, valid(`summary ${index - 1}`)); return valid(`summary ${index}`); };
  const first = await draft(f.open(), summarize);
  assert.equal(first.completed, 3); assert.equal(calls, 3);
  const second = await draft(f.open(), summarize);
  assert.equal(calls, 3); assert.equal(second.summary, first.summary); assert.equal(second.reused, 3); assert.equal(second.remaining, 0);
  const saved = JSON.parse(fs.readFileSync(f.open().file, 'utf8'));
  assert.equal(saved.version, VERSION); assert.equal(saved.hashBinding, HASH_BINDING); assert.equal(saved.summaries.length, 3);
  assert.ok(!JSON.stringify(saved).includes('old original')); assert.ok(!JSON.stringify(saved).includes('Keep original assets'));
});

test('an interrupted middle resumes exactly after the last validated summary', async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(draft(f.open(), async index => { calls++; if (index === 2) throw new Error('mock interruption'); return valid(`saved ${index}`); }), /mock interruption/);
  const resumed = f.open(); assert.equal(resumed.read().completed, 2); assert.equal(resumed.read().summary, valid('saved 1'));
  await draft(resumed, async (index, summary) => { calls++; assert.equal(index, 2); assert.equal(summary, valid('saved 1')); return valid('saved 2'); });
  assert.equal(calls, 4); assert.equal(f.open().read().completed, 3);
});

test('appending text that changes the final chunk retains the identical completed prefix', async t => {
  const f = fixture(t);
  await draft(f.open(), async index => valid(`original ${index}`));
  const changed = f.open({ chunks: ['old original', 'middle original', 'last original plus appended text', 'new tail'] });
  assert.equal(changed.read().completed, 2); assert.equal(changed.read().summary, valid('original 1'));
  let calls = 0;
  await draft(changed, async index => { calls++; assert.ok(index >= 2); return valid(`appended ${index}`); });
  assert.equal(calls, 2); assert.equal(f.open({ chunks: ['old original', 'middle original', 'last original plus appended text', 'new tail'] }).read().completed, 4);
});

test('editing an old chunk rolls back to its preceding cumulative summary', async t => {
  const f = fixture(t);
  await draft(f.open(), async index => valid(`original ${index}`));
  const changed = f.open({ chunks: ['old original', 'edited middle', 'last original'] });
  assert.equal(changed.read().completed, 1); assert.equal(changed.read().summary, valid('original 0')); assert.equal(changed.read().resetReason, 'transcript-changed');
  await draft(changed, async index => valid(`corrected ${index}`));
  const saved = JSON.parse(fs.readFileSync(changed.file, 'utf8'));
  assert.equal(saved.summaries[0].summary, valid('original 0')); assert.equal(saved.summaries[1].summary, valid('corrected 1'));
});

test('a shortened transcript reuses only its completed prefix and drops an old final packet', async t => {
  const f = fixture(t); const checkpoint = f.open();
  await draft(checkpoint, async index => valid(`old ${index}`)); checkpoint.finish({ summary: valid('packet'), files: [{ label: 'asset', ref: 'assets/original.png' }] });
  const shortened = f.open({ chunks: ['old original', 'middle original'] });
  assert.equal(shortened.read().completed, 2); assert.equal(shortened.read().summary, valid('old 1')); assert.equal(shortened.read().packet, null);
});

test('changing stable base instructions invalidates every old summary; object key order does not', async t => {
  const f = fixture(t); await draft(f.open(), async index => valid(`summary ${index}`));
  assert.equal(f.open({ baseInput: { skills: ['fixture'], previousHandoff: '', instructions: 'Keep original assets' } }).read().completed, 3);
  const changed = f.open({ baseInput: { ...f.options.baseInput, instructions: 'Use updated instructions' } });
  assert.equal(changed.read().completed, 0); assert.equal(changed.read().summary, ''); assert.equal(changed.read().resetReason, 'base-input-changed');
});

test('malformed, out-of-range, wrong-version and hash-mismatched checkpoints safely restart', async t => {
  const f = fixture(t); await draft(f.open(), async index => valid(`summary ${index}`));
  const file = f.open().file, original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cases = [null, {}, { ...original, completed: 4 }, { ...original, version: VERSION + 1 }, { ...original, hashBinding: 'other' }, { ...original, chunkHashes: [null] },
    { ...original, summaries: original.summaries.map((entry, index) => index === 1 ? { ...entry, summary: valid('tampered') } : entry) },
    { ...original, summaries: original.summaries.map((entry, index) => index === 1 ? { ...entry, prefixHash: '0'.repeat(64) } : entry) }];
  for (const broken of cases) {
    fs.writeFileSync(file, JSON.stringify(broken));
    const resumed = f.open(); assert.equal(resumed.read().completed, 0); assert.equal(resumed.read().summary, ''); assert.equal(resumed.read().resetReason, 'corrupt');
  }
  fs.writeFileSync(file, '{partial JSON');
  const resumed = f.open(); assert.equal(resumed.read().completed, 0); resumed.commit(0, valid('recovered')); assert.equal(f.open().read().completed, 1);
});

test('internal summary/prefix bindings reject inconsistent state even when the outer checksum is rebuilt', async t => {
  const f = fixture(t); await draft(f.open(), async index => valid(`summary ${index}`));
  const file = f.open().file, original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const reseal = state => {
    const { integrityHash, ...body } = state;
    const serialized = JSON.stringify(body, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
    return { ...body, integrityHash: createHash('sha256').update(serialized).digest('hex') };
  };
  const badSummary = { ...original, summaries: original.summaries.map((entry, index) => index === 1 ? { ...entry, summary: valid('changed summary') } : entry) };
  const badPrefix = { ...original, summaries: original.summaries.map((entry, index) => index === 1 ? { ...entry, prefixHash: '0'.repeat(64) } : entry) };
  const badIndex = { ...original, summaries: original.summaries.map((entry, index) => index === 1 ? { ...entry, index: 2 } : entry) };
  for (const broken of [badSummary, badPrefix, badIndex]) {
    fs.writeFileSync(file, JSON.stringify(reseal(broken)));
    assert.equal(f.open().read().completed, 0); assert.equal(f.open().read().resetReason, 'corrupt');
  }
});

test('each commit must be next in sequence and contain a complete bounded summary', t => {
  const f = fixture(t); const checkpoint = f.open();
  assert.throws(() => checkpoint.commit(1, valid('skipped')), /in order/);
  assert.throws(() => checkpoint.commit(-1, valid('negative')), /in order/);
  assert.throws(() => checkpoint.commit(0, '## 사용자 지침\nincomplete'), /필수 항목 누락/);
  assert.throws(() => checkpoint.commit(0, valid('too long') + 'x'.repeat(SUMMARY_LIMIT)), /70,000/);
  assert.throws(() => checkpoint.commit(0, { summary: valid('invalid type') }), /70,000/);
  assert.equal(checkpoint.read().completed, 0); assert.equal(fs.existsSync(checkpoint.file), false);
  checkpoint.commit(0, valid('first'));
  assert.throws(() => checkpoint.commit(0, valid('duplicate')), /in order/);
  assert.throws(() => checkpoint.finish({ summary: valid('premature') }), /before all/);
});

test('failed atomic replacement leaves prior valid progress and removes the temporary file', t => {
  const f = fixture(t); const checkpoint = f.open(); checkpoint.commit(0, valid('first'));
  const before = fs.readFileSync(checkpoint.file, 'utf8');
  const rename = t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('mock interrupted rename'), { code: 'EACCES' }); });
  assert.throws(() => checkpoint.commit(1, valid('second')), /mock interrupted rename/); rename.mock.restore();
  assert.equal(fs.readFileSync(checkpoint.file, 'utf8'), before); assert.equal(checkpoint.read().completed, 1); assert.equal(f.open().read().completed, 1);
  assert.deepEqual(fs.readdirSync(f.directory), [path.basename(checkpoint.file)]);
  checkpoint.commit(1, valid('second')); assert.equal(f.open().read().completed, 2);
});

test('orphan temp files never count as completed progress and stale writers cannot overwrite', t => {
  const f = fixture(t); const first = f.open(), stale = f.open();
  fs.writeFileSync(path.join(f.directory, 'fixture01-draft-checkpoint.crash.tmp'), '{partial checkpoint');
  assert.equal(f.open().read().completed, 0);
  first.commit(0, valid('first'));
  assert.throws(() => stale.commit(0, valid('stale')), /changed during/); assert.equal(f.open().read().summary, valid('first'));
});

test('final packet is reused only with exactly the same inputs and public reads are detached', async t => {
  const f = fixture(t); const checkpoint = f.open(); await draft(checkpoint, async index => valid(`summary ${index}`));
  const packet = { summary: valid('packet'), files: [{ label: 'original', ref: 'assets/original.png' }] };
  checkpoint.finish(packet);
  const reopened = f.open(); assert.deepEqual(reopened.read().packet, packet);
  reopened.read().packet.files[0].ref = 'changed'; assert.deepEqual(reopened.read().packet, packet);
  assert.equal(f.open({ chunks: [...f.options.chunks, 'append new chunk'] }).read().packet, null);
});

test('checkpoint file contains redacted summaries and references, and no original auth text', async t => {
  const f = fixture(t), secret = 'sk-' + 'A'.repeat(40);
  const checkpoint = f.open({ baseInput: `Original key ${secret}`, chunks: [`Original key ${secret}`] });
  checkpoint.commit(0, valid(`Model repeated ${secret}`));
  checkpoint.finish({ summary: valid(`Final ${secret}`), files: [{ label: 'reference', ref: 'https://fixture.invalid/asset?token=' + 'A'.repeat(30) }] });
  const saved = fs.readFileSync(checkpoint.file, 'utf8'); assert.ok(!saved.includes(secret)); assert.ok(!saved.includes('A'.repeat(30)));
  assert.match(checkpoint.read().summary, /접속키 비공개/); assert.match(checkpoint.read().packet.files[0].ref, /비공개/);
});

test('unsafe IDs and non-JSON inputs are rejected without writing outside the caller directory', t => {
  const f = fixture(t);
  for (const conversationId of ['../outside', 'a/b', 'a\\b', 'C:outside', '.hidden', '', 'a'.repeat(65)]) assert.throws(() => f.open({ conversationId }), /safe conversation ID/);
  const hiddenHole = [, 'sparse']; hiddenHole.extra = 'not an index';
  for (const baseInput of [undefined, Infinity, new Date(), [, 'sparse'], hiddenHole]) assert.throws(() => f.open({ baseInput }), /JSON|sparse/);
  const cycle = {}; cycle.self = cycle; assert.throws(() => f.open({ baseInput: cycle }), /acyclic/);
  assert.throws(() => f.open({ chunks: ['ok', null] }), /array of strings/);
  assert.throws(() => f.open({ chunks: [, 'sparse'] }), /array of strings/);
  const checkpoint = f.open(); assert.equal(path.dirname(checkpoint.file), path.resolve(f.directory)); assert.equal(fs.readdirSync(f.directory).length, 0);
});
