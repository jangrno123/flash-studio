'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const qa = require('./qa'), tools = require('./tools'), llm = require('./llm');
test('ratio is explicit and follows the work, preservation instructions do not force a different format', () => {
  assert.throws(() => qa.conversionSpec(), /aspect_ratio/);
  const wide = qa.conversionSpec('16:9', ['ROOM 1']), tall = qa.conversionSpec('9:16');
  assert.equal(wide.size, '2048x1152'); assert.match(wide.prompt, /one 16:9 shot/);
  assert.match(wide.prompt, /ROOM 1/); assert.match(wide.review, /16:9 숏/);
  assert.equal(tall.size, '1152x2048'); assert.match(tall.prompt, /one 9:16 shot/);
  assert.doesNotMatch(tall.prompt, /16:9|left and right|Recreate/);
});
test('the actual generation and QA request use the selected ratio, mismatched pixels cannot pass', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-qa-ratio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, 'result.png'), data = Buffer.alloc(32);
  data.writeUInt32BE(0x89504e47); data.writeUInt32BE(160, 16); data.writeUInt32BE(90, 20); fs.writeFileSync(fake, data);
  const old = { runImage: tools.runImage, resolveImage: tools.resolveImage, complete: llm.complete };
  t.after(() => Object.assign(tools, { runImage: old.runImage, resolveImage: old.resolveImage }));
  t.after(() => { llm.complete = old.complete; });
  let submitted;
  tools.runImage = async request => { submitted = request; return [{ url: 'test-result', prompt: request.prompt }]; };
  tools.resolveImage = () => fake;
  llm.complete = async request => { assert.match(request.messages[0].content, /9:16 숏/); return JSON.stringify({ verdict: 'pass', score: 100, issues: [] }); };
  const ctx = { settings: { qa: {} }, store: { dirs: { logs: root }, getProvider: () => ({ models: [] }) }, meta: {} };
  const result = await qa.convertPanels({ images: ['test-original'], aspect_ratio: '9:16', max_attempts: 1 }, ctx);
  assert.equal(submitted.size, '1152x2048'); assert.match(submitted.prompt, /one 9:16 shot/);
  assert.match(result.text, /불합격 1/); assert.match(result.text, /160×90/);
});
