'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectVideoStructure, dialoguePreservationErrors } = require('./bao-video-structure');
const { setBaoCanvasText } = require('./bao-upload');
function fixture() {
  const text = '[REFERENCE-TO-VIDEO INPUT MODE]\nNOT a first-frame or last-frame image. At 0.0s individual SHOT 1. Never display the complete contact sheet.\n@Image 1 = sheet\n@Audio 1 = VOICE_TEST\nSHOT 1 [0.0–2.0s; duration=2.0s]\n · [LINE01 · VO] 「Hello there」 1.0–3.0s\nSHOT 2 [2.0–4.0s; duration=2.0s]\n · [LINE01 · 이어짐] SHOT1에서 시작한 같은 발화가 3.0s까지 이어짐\nTotal: 4s / 2 shots / 16:9';
  return { revision: 1, nodes: [
    { id: 'prompt', type: 'text.input', config: { text } },
    { id: 'sheet', type: 'image.input', config: { assetId: 'sheet-asset' } },
    { id: 'voice', type: 'audio.input', config: { assetId: 'voice-asset' } },
    { id: 'video', type: 'video.generate', config: { duration: 4, ratio: '16:9' } }
  ], edges: [
    { id: 'prompt-edge', from: { nodeId: 'prompt' }, to: { nodeId: 'video', port: 'in:prompt:text' }, order: 0 },
    { id: 'image-edge', from: { nodeId: 'sheet' }, to: { nodeId: 'video', port: 'in:images:image' }, order: 9 },
    { id: 'voice-edge', from: { nodeId: 'voice' }, to: { nodeId: 'video', port: 'in:audio:audio' }, order: 0 }
  ] };
}
const errorCodes = (graph) => inspectVideoStructure(graph, 'video').errors.map((error) => error.code);
test('valid cross-shot global utterance is not duplicated and gapped order is a slot index', () => {
  const row = inspectVideoStructure(fixture(), 'video', { referencesReady: true, issues: [] });
  assert.equal(row.ready, true); assert.deepEqual(row.utterances[0].shotIds, [1, 2]);
  assert.equal(row.slots.images[0].slot, 1); assert.equal(row.slots.images[0].order, 9);
  assert.equal(row.providerRoleVerified, false); assert.equal(row.renderedOutcomeVerified, false);
});
test('previous duration and malformed-number failures are detected', () => {
  const graph = fixture(); graph.nodes[3].config.duration = 2;
  assert.ok(errorCodes(graph).includes('TOTAL_CONFIG')); assert.ok(errorCodes(graph).includes('DIALOGUE_WINDOW'));
  graph.nodes[3].config.duration = 4; graph.nodes[0].config.text = graph.nodes[0].config.text.replace('2.0–4.0', '2.0.0–4.0');
  assert.ok(errorCodes(graph).includes('SHOT_FORMAT'));
});
test('duplicate references, missing slots and duplicate full utterances fail', () => {
  const graph = fixture(); graph.edges.push({ ...graph.edges[1], id: 'image-edge-duplicate' });
  assert.ok(errorCodes(graph).includes('REFERENCE_ORDER'));
  graph.nodes[0].config.text += '\n@Image 8 = absent\n · [LINE01 · VO] 「Hello there」 1.0–3.0s';
  assert.ok(errorCodes(graph).includes('REFERENCE_TOKEN')); assert.ok(errorCodes(graph).includes('DIALOGUE_DUPLICATE'));
});
test('wrong continuation SHOT and ratio are caught without rewriting authored content', () => {
  const graph = fixture(); graph.nodes[0].config.text = graph.nodes[0].config.text.replace('SHOT1에서', 'SHOT2에서');
  graph.nodes[3].config.ratio = '9:16';
  assert.ok(errorCodes(graph).includes('CONTINUATION_SHOT')); assert.ok(errorCodes(graph).includes('RATIO'));
});
test('unmarked legacy prompts stay outside the new contract', () => {
  const graph = fixture(); graph.nodes[0].config.text = 'Existing unstructured prompt';
  assert.equal(inspectVideoStructure(graph, 'video').applicable, false);
});
test('existing full dialogue cannot silently disappear or be replaced', () => {
  const before = fixture().nodes[0].config.text;
  assert.deepEqual(dialoguePreservationErrors(before, before), []);
  assert.equal(dialoguePreservationErrors(before, before.replace('Hello there', 'Different words'))[0].code, 'DIALOGUE_PRESERVATION');
  assert.equal(dialoguePreservationErrors(before, before.replace(/ · \[LINE01 · VO\][^\n]*\n/, '')).length, 1);
});
test('invalid structured text is rejected before prepare/execute', async () => {
  const graph = fixture(); const calls = [];
  const fakeFetch = async (_url, init) => {
    const rpc = JSON.parse(init.body).params; calls.push(rpc.name);
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ graph: { revision: 1, draft: graph } }) }] } }));
  };
  const store = { getMcpConfig: () => ({ mcpServers: { 'bao-production': { url: 'https://test.example/api/lightbringer-mcp', headers: { Authorization: 'test', 'OAI-Sites-Authorization': 'test' } } } }) };
  const result = await setBaoCanvasText({ project_id: 'bao', graph_id: 'graph1', node_id: 'prompt', text: graph.nodes[0].config.text.replace('Total: 4s', 'Total: 8s') }, { store }, fakeFetch);
  assert.equal(result.isError, true); assert.match(result.text, /TOTAL_CONFIG/);
  assert.deepEqual(calls, ['production_read']);
});

function ep04Fixture() {
  const graph = fixture();
  graph.nodes[0].config.text = graph.nodes[0].config.text
    .replace('[REFERENCE-TO-VIDEO INPUT MODE]', '[레퍼런스 역할 / REFERENCE ROLES]')
    .replace('NOT a first-frame or last-frame image. At 0.0s individual SHOT 1. Never display the complete contact sheet.',
      '첫 프레임·마지막 프레임 고정 입력으로 사용하지 않는다. 0.0초부터 SHOT 1의 개별 장면만 표시한다. 시트 전체를 한 화면으로 만들지 않는다. 인쇄된 패널 라벨 숫자는 주소일 뿐이다.')
    .replace('SHOT 1 [0.0–2.0s; duration=2.0s]', 'SHOT 1 — 0.0~2.0초 · duration=2.0s · Existing scene. [P01패널1(좌상)]')
    .replace('SHOT 2 [2.0–4.0s; duration=2.0s]', 'SHOT 2 — 2.0~4.0초 · duration=2.0s · Existing scene. [P01패널2(우상)]')
    .replace('Total: 4s', '[타이밍 TIMING — EP04 구조]\nTotal: 4s');
  return graph;
}
test('EP04 shot headers retain duration and cross-shot utterance checks', () => {
  const row = inspectVideoStructure(ep04Fixture(), 'video');
  assert.equal(row.applicable, true);
  assert.equal(row.ready, true);
  assert.deepEqual(row.shots.map(s => [s.start, s.end, s.duration]), [[0, 2, 2], [2, 4, 2]]);
  assert.deepEqual(row.utterances[0].shotIds, [1, 2]);
  const graph = ep04Fixture();
  graph.nodes[0].config.text = graph.nodes[0].config.text.replace('duration=2.0s', 'duration=1.0s');
  assert.ok(errorCodes(graph).includes('SHOT_DURATION'));
});
test('EP04 structure cannot omit panel address or reference-only role', () => {
  const graph = ep04Fixture();
  graph.nodes[0].config.text = graph.nodes[0].config.text.replace('[P01패널1(좌상)]', '');
  assert.ok(errorCodes(graph).includes('PANEL_ADDRESS'));
  graph.nodes[0].config.text = graph.nodes[0].config.text.replace('첫 프레임·마지막 프레임 고정 입력으로 사용하지 않는다.', '');
  assert.ok(errorCodes(graph).includes('REFERENCE_ROLE'));
});
test('EP04 prompt dialogue loss is rejected before any write request', async () => {
  const graph = ep04Fixture(); const calls = [];
  const fakeFetch = async (_url, init) => {
    const rpc = JSON.parse(init.body).params; calls.push(rpc.name);
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ graph: { revision: 1, draft: graph } }) }] } }));
  };
  const store = { getMcpConfig: () => ({ mcpServers: { 'bao-production': { url: 'https://test.example/api/lightbringer-mcp', headers: { Authorization: 'test', 'OAI-Sites-Authorization': 'test' } } } }) };
  const result = await setBaoCanvasText({ project_id: 'bao', graph_id: 'graph1', node_id: 'prompt', text: graph.nodes[0].config.text.replace('Hello there', 'Different words') }, { store }, fakeFetch);
  assert.equal(result.isError, true);
  assert.match(result.text, /대사 보존 오류/);
  assert.deepEqual(calls, ['production_read']);
});
