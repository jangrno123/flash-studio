'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uploadBaoImages, uploadBaoFiles, uploadBaoToCanvas, patchBaoCanvas, wireBaoCanvasVideos, inspectBaoVideoInputs, setBaoCanvasText, repairBaoCanvasBindings, uploadBaoWebtoon } = require('./bao-upload');

test('Flash can verify saved video inputs without changing the graph', async () => {
  const calls = [];
  const fakeFetch = async (_url, init) => {
    const rpc = JSON.parse(init.body).params;
    calls.push(rpc.name);
    const value = rpc.name === 'production_read'
      ? { graph: { revision: 42, draft: { nodes: [
        { id: 'pro', type: 'image.input' }, { id: 'prompt', type: 'text.input' },
        { id: 'video', type: 'video.generate' }], edges: [] } } }
      : { videos: [{ nodeId: 'video', title: 'Cut 01', referencesReady: true,
        images: [{ nodeId: 'pro', referenceAvailable: true }],
        prompts: [{ nodeId: 'prompt', textChars: 120 }], issues: [] }] };
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }), { status: 200 });
  };
  const ctx = { store: { getMcpConfig: () => ({ mcpServers: { 'bao-production': {
    url: 'https://example.com/api/lightbringer-mcp',
    headers: { Authorization: 'Bearer test', 'OAI-Sites-Authorization': 'test-sites' }
  } } }) } };
  const result = await inspectBaoVideoInputs({ project_id: 'bao', graph_id: 'graph1' }, ctx, fakeFetch);
  assert.match(result.text, /참조 확인 1개/);
  assert.match(result.text, /PRO images ← pro; prompt ← prompt/);
  assert.deepEqual(calls, ['production_read', 'canvas_video_inputs_read']);
});

test('video input inspection follows edge.order rather than the stored images array', async () => {
  const calls = [];
  const fakeFetch = async (_url, init) => {
    const rpc = JSON.parse(init.body).params; calls.push(rpc.name);
    const value = rpc.name === 'production_read'
      ? { graph: { revision: 8, draft: { nodes: [{ id: 'video', type: 'video.generate' }], edges: [
        { id: 'character-edge', from: { nodeId: 'character' }, to: { nodeId: 'video' }, order: 9 },
        { id: 'sb-edge', from: { nodeId: 'sb' }, to: { nodeId: 'video' }, order: 1 }
      ] } } }
      : { videos: [{ nodeId: 'video', referencesReady: true, images: [
        { edgeId: 'character-edge', nodeId: 'character', referenceAvailable: true },
        { edgeId: 'sb-edge', nodeId: 'sb', referenceAvailable: true }
      ], prompts: [] }] };
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }));
  };
  const store = { getMcpConfig: () => ({ mcpServers: { 'bao-production': {
    url: 'https://example.com/api/lightbringer-mcp',
    headers: { Authorization: 'Bearer test', 'OAI-Sites-Authorization': 'test-sites' }
  } } }) };
  const result = await inspectBaoVideoInputs({ project_id: 'bao', graph_id: 'graph1' }, { store }, fakeFetch);
  assert.match(result.text, /PRO images ← sb, character/);
  assert.match(result.text, /@Image 1=sb \(edge.order=1\), @Image 2=character \(edge.order=9\)/);
  assert.deepEqual(calls, ['production_read', 'canvas_video_inputs_read']);
});

test('text updates omit unchanged runtime fields and preserve saved settings by config merge', async () => {
  let revision = 4; let pending;
  const node = { id: 'prompt', type: 'text.input', config: { title: 'Keep title', text: 'Original text',
    registryInputs: [], executionStatus: 'succeeded', retainedSetting: { preserve: true } } };
  const original = structuredClone(node.config); const calls = [];
  const fakeFetch = async (_url, init) => {
    const rpc = JSON.parse(init.body).params; calls.push(rpc.name); let value;
    if (rpc.name === 'production_read') value = { graph: { revision, draft: { nodes: [structuredClone(node)], edges: [] } } };
    else if (rpc.name === 'production_prepare') {
      pending = rpc.arguments.arguments;
      assert.deepEqual(pending.changes[0].config, { title: 'Keep title', text: 'Corrected reference roles' });
      value = { commandId: 'cmd-one', confirmation: 'confirm' };
    } else {
      Object.assign(node.config, pending.changes[0].config); revision++;
      value = { status: 'succeeded' };
    }
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }));
  };
  const store = { getMcpConfig: () => ({ mcpServers: { 'bao-production': {
    url: 'https://example.com/api/lightbringer-mcp',
    headers: { Authorization: 'Bearer test', 'OAI-Sites-Authorization': 'test-sites' }
  } } }) };
  const result = await setBaoCanvasText({ project_id: 'bao', graph_id: 'graph1', node_id: 'prompt',
    text: 'Corrected reference roles' }, { store }, fakeFetch);
  assert.equal(result.isError, undefined);
  assert.deepEqual(node.config, { ...original, text: 'Corrected reference roles' });
  assert.deepEqual(calls, ['production_read', 'production_prepare', 'production_execute', 'production_read']);
});

test('Flash wires exact image and text nodes to saved WAN 480p nodes without generation', async () => {
  const graph = { revision: 7, draft: { nodes: [
    { id: 'pro1', type: 'image.input', sourceBinding: { kind: 'asset' }, position: { x: 560, y: 120 }, config: { title: 'PRO 1', assetId: 'asset1' } },
    { id: 'text1', type: 'text.input', position: { x: 1000, y: 120 }, config: { text: 'Motion prompt 1' } },
  ], edges: [] } };
  let prepared;
  const calls = [];
  const fakeFetch = async (_url, init) => {
    const rpc = JSON.parse(init.body).params;
    calls.push(rpc.name);
    let value;
    if (rpc.name === 'canvas_node_catalog') value = { nodes: [{ type: 'video.generate', version: 1, inputs: [
      { key: 'images', type: 'image[]' }, { key: 'prompt', type: 'text' }] }], presets: [{ id: 'wan3-mulerouter-480p',
      config: { provider: 'mulerouter', model: 'wan3', videoEngine: 'wan3-mulerouter', resolution: '480p', ratio: '16:9', duration: 5, status: 'idle' } }] };
    else if (rpc.name === 'production_read') value = { graph: structuredClone(graph) };
    else if (rpc.name === 'production_prepare') {
      prepared = rpc.arguments.arguments;
      value = { commandId: 'patch-1', confirmation: 'confirm' };
    } else if (rpc.name === 'production_execute') {
      for (const change of prepared.changes) {
        if (change.kind === 'add_node') graph.draft.nodes.push(change.node);
        if (change.kind === 'add_edge') graph.draft.edges.push(change.edge);
      }
      graph.revision++;
      value = { status: 'succeeded' };
    } else throw new Error(`unexpected ${rpc.name}`);
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }), { status: 200 });
  };
  const ctx = { store: { getMcpConfig: () => ({ mcpServers: { 'bao-production': {
    url: 'https://example.com/api/lightbringer-mcp',
    headers: { Authorization: 'Bearer test', 'OAI-Sites-Authorization': 'test-sites' }
  } } }) } };
  const args = { project_id: 'bao', graph_id: 'graph1', expected_revision: 7,
    pairs: [{ pro_image_node_id: 'pro1', prompt_node_id: 'text1', duration: 6 }] };
  const result = await wireBaoCanvasVideos(args, ctx, fakeFetch);
  assert.equal(result.isError, undefined);
  assert.equal(prepared.changes.length, 3);
  assert.equal(prepared.changes[0].node.config.videoEngine, 'wan3-mulerouter');
  assert.equal(prepared.changes[0].node.config.resolution, '480p');
  assert.equal(prepared.changes[0].node.config.duration, 6);
  assert.deepEqual(prepared.changes.filter(item => item.kind === 'add_edge').map(item => item.edge.to.port), ['images', 'prompt']);
  assert.equal(graph.draft.nodes.length, 3);
  assert.equal(graph.draft.edges.length, 2);
  assert.equal(calls.includes('canvas.generate'), false);
  const repeat = await wireBaoCanvasVideos({ ...args, expected_revision: 8 }, ctx, fakeFetch);
  assert.equal(repeat.isError, undefined);
  assert.equal(graph.revision, 8);
});

test('two local crops use one MCP ticket batch and transfer both binaries without exposing tokens', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-flash-upload-'));
  const images = path.join(root, 'images');
  fs.mkdirSync(images);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  fs.writeFileSync(path.join(images, 'cut1.png'), bytes);
  fs.writeFileSync(path.join(images, 'cut2.png'), Buffer.concat([bytes, Buffer.from([4])]));
  const calls = [];
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/api/lightbringer-mcp')) {
      const { params } = JSON.parse(init.body);
      const result = params.name === 'production_prepare'
        ? { commandId: 'cmd-1', confirmation: 'EXECUTE cmd-1' }
        : params.name === 'production_execute' ? { status: 'succeeded' }
          : { result: { uploads: ['CUT_A', 'CUT_B'].map((alias) => ({ alias,
            uploadUrl: 'https://example.com/api/assets/ticket?project=bao', uploadToken: `ticket-${alias}` })) } };
      return json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    }
    return json({ id: `asset-${calls.length}` });
  };
  try {
    const result = await uploadBaoImages({ project_id: 'bao', images: [
      { path: '/files/images/cut1.png', alias: 'CUT_A' },
      { path: '/files/images/cut2.png', alias: 'CUT_B' }
    ] }, { store: { dirs: { images, uploads: images }, getMcpConfig: () => ({ mcpServers: { 'bao-production': {
      url: 'https://example.com/api/lightbringer-mcp',
      headers: { Authorization: 'Bearer test', 'OAI-Sites-Authorization': 'test-sites' }
    } } }) } }, fakeFetch);
    assert.equal(calls.length, 5);
    assert.equal(JSON.parse(calls[0].init.body).params.arguments.arguments.files.length, 2);
    assert.equal(calls[3].init.headers.Authorization, 'Upload ticket-CUT_A');
    assert.equal(calls[4].init.headers.Authorization, 'Upload ticket-CUT_B');
    assert.equal(result.isError, undefined);
    assert.match(result.text, /CUT_A/);
    assert.doesNotMatch(result.text, /ticket-CUT_A/);
  } finally {
    fs.unlinkSync(path.join(images, 'cut1.png'));
    fs.unlinkSync(path.join(images, 'cut2.png'));
    fs.rmdirSync(images);
    fs.rmdirSync(root);
  }
});

test('direct canvas upload transfers media then patches exact graph revision and order', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-canvas-upload-'));
  const images = path.join(root, 'images'); fs.mkdirSync(images);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  for (const name of ['one.png', 'two.png']) fs.writeFileSync(path.join(images, name), bytes);
  const calls = [];
  let binaryUploads = 0;
  const json = (value) => new Response(JSON.stringify(value), { status: 200 });
  const fakeFetch = async (url, init) => {
    if (String(url).includes('/api/assets/ticket')) return json({ id: `asset-${++binaryUploads}` });
    const request = JSON.parse(init.body).params;
    calls.push({ method: request.name, args: request.arguments });
    let value;
    if (request.name === 'production_prepare') value = { commandId: request.arguments.operation === 'canvas.patch' ? 'patch-command' : 'upload-command', confirmation: 'confirm' };
    else if (request.name === 'production_execute') value = { status: 'succeeded' };
    else value = { result: { uploads: ['ONE', 'TWO'].map((alias) => ({ alias,
      uploadUrl: 'https://example.com/api/assets/ticket?project=bao', uploadToken: `token-${alias}` })) } };
    return json({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
  };
  try {
    const result = await uploadBaoToCanvas({ project_id: 'bao', graph_id: 'graph-one', base_revision: 7,
      images: [{ path: '/files/images/one.png', alias: 'ONE' }, { path: '/files/images/two.png', alias: 'TWO' }] },
    { store: { dirs: { images, uploads: images }, getMcpConfig: () => ({ mcpServers: { 'bao-production': {
      url: 'https://example.com/api/lightbringer-mcp',
      headers: { Authorization: 'Bearer test', 'OAI-Sites-Authorization': 'test-sites' }
    } } }) } }, fakeFetch);
    assert.equal(result.isError, undefined);
    const patch = calls.find((call) => call.args.operation === 'canvas.patch');
    assert.equal(patch.args.arguments.baseRevision, 7);
    assert.deepEqual(patch.args.arguments.changes.map((change) => change.position.y), [120, 480]);
    assert.deepEqual(patch.args.arguments.changes.map((change) => change.attachmentKey), ['asset-1', 'asset-2']);
    assert.match(result.text, /graph-one/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('direct canvas patch uses exact kind/nodeId with one durable BAO command', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const request = JSON.parse(init.body).params;
    calls.push(request);
    const value = request.name === 'production_prepare' ? { commandId: 'patch-command', confirmation: 'EXECUTE patch-command' }
      : { status: 'succeeded' };
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }), { status: 200 });
  };
  const store = { getMcpConfig: () => ({ mcpServers: { 'bao-production': {
    url: 'https://example.com/api/lightbringer-mcp',
    headers: { Authorization: 'Bearer test', 'OAI-Sites-Authorization': 'test-sites' }
  } } }) };
  const changes = [{ kind: 'update_node', nodeId: 'pro-1', position: { x: 560, y: 120 } },
    { kind: 'add_node', node: { id: 'prompt-1', type: 'text.input', position: { x: 1000, y: 120 }, config: { title: 'Cut 01', text: 'Prompt' } } }];
  const result = await patchBaoCanvas({ project_id: 'bao', graph_id: 'graph-one', base_revision: 3, changes }, { store }, fakeFetch);
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].arguments.operation, 'canvas.patch');
  assert.deepEqual(calls[0].arguments.arguments.changes, changes);
  assert.equal(calls[1].arguments.command_id, 'patch-command');
  await assert.rejects(() => patchBaoCanvas({ project_id: 'bao', graph_id: 'graph-one', base_revision: 3,
    changes: [{ op: 'update_node', id: 'pro-1' }] }, { store }, fakeFetch), /kind/);
  assert.equal(calls.length, 2);
});

test('direct canvas patch normalizes text node config without dropping authored text', async () => {
  let prepared;
  const fakeFetch = async (url, init) => {
    const request = JSON.parse(init.body).params;
    if (request.name === 'production_prepare') prepared = request.arguments;
    const result = request.name === 'production_prepare' ? { commandId: 'cmd', confirmation: 'EXECUTE cmd' } : { status: 'succeeded' };
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }), { status: 200 });
  };
  const store = { getMcpConfig: () => ({ mcpServers: { 'bao-production': {
    url: 'https://example.com/api/lightbringer-mcp',
    headers: { Authorization: 'Bearer test', 'OAI-Sites-Authorization': 'test-sites' }
  } } }) };
  const change = { kind: 'add_node', node: { id: 'prompt-1', type: 'text.input', position: { x: 1000, y: 120 } },
    config: { contentType: 'text/plain', title: 'Cut 01', text: 'Preserve this exact prompt.' } };
  const result = await patchBaoCanvas({ project_id: 'bao', graph_id: 'graph-one', base_revision: 3,
    changes: [change] }, { store }, fakeFetch);
  assert.equal(result.isError, undefined);
  assert.deepEqual(prepared.arguments.changes, [{ kind: 'add_node', node: { ...change.node,
    config: { title: 'Cut 01', text: 'Preserve this exact prompt.' } } }]);
  assert.equal(change.config.contentType, 'text/plain');
});

test('media binding repair keeps existing asset IDs and uses bounded CAS patches', async () => {
  let revision = 4;
  const nodes = Array.from({ length: 21 }, (_, index) => ({ id: `image-${index}`, type: 'image.input',
    position: { x: index * 10, y: 120 }, config: { assetId: `asset-${index}` } }));
  const patches = [];
  let pending;
  const fakeFetch = async (_url, init) => {
    const request = JSON.parse(init.body).params;
    let value;
    if (request.name === 'production_read') value = { data: { graph: { revision, draft: { nodes } } } };
    else if (request.name === 'production_prepare') {
      pending = request.arguments.arguments;
      patches.push(pending);
      value = { commandId: `cmd-${revision}`, confirmation: 'confirm' };
    } else {
      for (const change of pending.changes) {
        const node = nodes.find((item) => item.id === change.nodeId);
        assert.equal(change.attachmentKey, node.config.assetId);
        node.sourceBinding = { kind: 'image', assetId: change.attachmentKey };
      }
      revision += 1;
      value = { status: 'succeeded' };
    }
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }), { status: 200 });
  };
  const store = { getMcpConfig: () => ({ mcpServers: { 'bao-production': {
    url: 'https://example.com/api/lightbringer-mcp',
    headers: { Authorization: 'Bearer test', 'OAI-Sites-Authorization': 'test-sites' }
  } } }) };
  const result = await repairBaoCanvasBindings({ project_id: 'bao', graph_id: 'graph-one', expected_image_count: 21 }, { store }, fakeFetch);
  assert.equal(result.isError, undefined);
  assert.equal(result.restored, 21);
  assert.equal(result.remaining, 0);
  assert.deepEqual(patches.map((patch) => [patch.baseRevision, patch.changes.length]), [[4, 20], [5, 1]]);
  assert.deepEqual(nodes.map((node) => node.position.y), Array(21).fill(120));
});

test('webtoon upload sends exact local bytes to cloud source and crop routes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-webtoon-upload-'));
  const images = path.join(root, 'images'); fs.mkdirSync(images);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9]);
  fs.writeFileSync(path.join(images, 'page.png'), bytes);
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return new Response(JSON.stringify({ source: { id: 'source-1' }, reused: false }), { status: 201 });
  };
  const store = { dirs: { images, uploads: images }, getMcpConfig: () => ({ mcpServers: { 'bao-production': {
    url: 'https://example.com/api/lightbringer-mcp',
    headers: { Authorization: 'Bearer test', 'OAI-Sites-Authorization': 'test-sites' }
  } } }) };
  try {
    const source = await uploadBaoWebtoon({ project_id: 'bao', action: 'source', path: '/files/images/page.png',
      episode_code: 'EP01', page_order: 1 }, { store }, fakeFetch);
    assert.equal(source.isError, undefined);
    assert.equal(calls[0].init.method, 'PUT');
    assert.equal(calls[0].url.pathname, '/api/webtoon-mcp-upload');
    assert.equal(calls[0].url.searchParams.get('episodeCode'), 'EP01');
    assert.deepEqual(calls[0].init.body, bytes);
    assert.equal(calls[0].init.headers['x-content-sha256'].length, 64);
    await uploadBaoWebtoon({ project_id: 'bao', action: 'crop', path: '/files/images/page.png',
      source_id: '12345678-1234-1234-1234-123456789abc', source_sha256: 'a'.repeat(64),
      proposal_revision: 2, panel_order: 3 }, { store }, fakeFetch);
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(calls[1].url.searchParams.get('action'), 'crop');
    assert.equal(calls[1].init.body.get('panelOrder'), '3');
    assert.equal((await calls[1].init.body.get('file').arrayBuffer()).byteLength, bytes.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('general asset upload transfers MP3 and JSON through existing tickets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-flash-files-'));
  const images = path.join(root, 'uploads'); fs.mkdirSync(images);
  fs.writeFileSync(path.join(images, 'guide.mp3'), Buffer.from('ID3\u0004\u0000\u0000\u0000'));
  fs.writeFileSync(path.join(images, 'draft.json'), Buffer.from('{"scene":"one"}'));
  let files;
  const fakeFetch = async (url, init) => {
    if (String(url).includes('/api/assets/ticket')) return new Response(JSON.stringify({ id: `asset-${files.length}` }), { status: 200 });
    const request = JSON.parse(init.body).params;
    let value;
    if (request.name === 'production_prepare') {
      files = request.arguments.arguments.files;
      value = { commandId: 'cmd', confirmation: 'confirm' };
    } else if (request.name === 'production_execute') value = { status: 'succeeded' };
    else value = { result: { uploads: files.map((file) => ({ alias: file.alias,
      uploadUrl: 'https://example.com/api/assets/ticket?project=bao', uploadToken: 'ticket' })) } };
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }), { status: 200 });
  };
  const store = { dirs: { images, uploads: images }, getMcpConfig: () => ({ mcpServers: { 'bao-production': {
    url: 'https://example.com/api/lightbringer-mcp',
    headers: { Authorization: 'Bearer test', 'OAI-Sites-Authorization': 'test-sites' }
  } } }) };
  try {
    const result = await uploadBaoFiles({ project_id: 'bao', files: [
      { path: '/files/uploads/guide.mp3', alias: 'GUIDE_MP3' },
      { path: '/files/uploads/draft.json', alias: 'DRAFT_JSON' }
    ] }, { store }, fakeFetch);
    assert.equal(result.isError, undefined);
    assert.deepEqual(files.map((file) => [file.contentType, file.category]),
      [['audio/mpeg', 'audio'], ['application/json', 'other']]);
    assert.equal(result.receipts.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
