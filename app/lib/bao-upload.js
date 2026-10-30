'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { inspectVideoStructure, dialoguePreservationErrors } = require('./bao-video-structure');

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 64;
const LOCAL_IMAGE = /^\/files\/(images|uploads)\/([A-Za-z0-9._-]+)$/;
const PROJECT_ID = /^(?:bao|bao-[a-f0-9]{32})$/;

function localImage(image, dirs) {
  const match = LOCAL_IMAGE.exec(String(image || ''));
  if (!match) throw new Error('Flash Studio의 /files/images/... 또는 /files/uploads/... 경로가 필요합니다.');
  const file = path.join(dirs[match[1]], match[2]);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`이미지를 찾을 수 없습니다: ${image}`);
  return file;
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { contentType: 'image/png', ext: '.png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { contentType: 'image/jpeg', ext: '.jpg' };
  throw new Error('BAO 에셋 업로드는 PNG/JPEG만 지원합니다. 웹툰 크롭은 PNG로 저장해 주세요.');
}
function assetFileType(file, bytes) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') return imageType(bytes);
  if(ext==='.webp'&&bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return {contentType:'image/webp',ext:'.webp'};
  if(['.mp4','.mov'].includes(ext)&&bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp')return {contentType:bytes.toString('ascii',8,12)==='qt  '?'video/quicktime':'video/mp4',ext};
  if(ext==='.webm'&&bytes.subarray(0,4).equals(Buffer.from([26,69,223,163])))return {contentType:'video/webm',ext};
  if (ext === '.mp3' && (bytes.subarray(0, 3).toString('ascii') === 'ID3' ||
    bytes[0] === 255 && (bytes[1] & 224) === 224)) return { contentType: 'audio/mpeg', ext: '.mp3' };
  if (ext === '.json' || ext === '.txt' || ext === '.md') {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.includes('\0')) throw new Error('텍스트 파일에 바이너리 내용이 있습니다.');
    if (ext === '.json') { JSON.parse(content); return { contentType: 'application/json', ext: '.json' }; }
    return { contentType: 'text/plain', ext: '.txt' };
  }
  throw new Error('BAO 에셋 업로드는 PNG/JPEG/WebP, MP3, MP4/MOV/WebM, JSON, TXT/MD를 지원합니다.');
}

function webtoonImageType(bytes) {
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
    return { contentType: 'image/webp', ext: '.webp' };
  return imageType(bytes);
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${String(body.error || body.message || '').slice(0, 240)}`);
  return body;
}

async function mcpCall(url, headers, name, args, fetchImpl, signal) {
  const response = await fetchImpl(url, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }), signal
  });
  const rpc = await responseJson(response, name);
  const item = rpc.result?.content?.find((part) => part.type === 'text');
  if (!item) throw new Error(`${name}: 응답 본문이 없습니다.`);
  let data;
  try { data = JSON.parse(item.text); } catch { throw new Error(`${name}: JSON 결과를 읽을 수 없습니다.`); }
  if (rpc.result?.isError || data.error) throw new Error(`${name}: ${String(data.error || 'BAO 도구 오류')}`);
  return data;
}

async function uploadBaoImages(args, ctx, fetchImpl = fetch, allowFiles = false) {
  const projectId = String(args.project_id || '');
  if (!PROJECT_ID.test(projectId)) throw new Error('production_projects에서 조회한 정확한 BAO project_id가 필요합니다.');
  if (!Array.isArray(args.images) || args.images.length < 1 || args.images.length > MAX_FILES)
    throw new Error('한 번에 1–64개 이미지를 지정하세요.');
  const bao = ctx.store.getMcpConfig().mcpServers['bao-production'];
  const endpoint = new URL(String(bao?.url || ''));
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/api/lightbringer-mcp')
    throw new Error('Flash Studio의 BAO MCP 클라우드 주소를 먼저 연결하세요.');
  const headers = bao.headers || {};
  if (!headers.Authorization || !headers['OAI-Sites-Authorization']) throw new Error('BAO 개인키와 Sites 인증 헤더가 모두 필요합니다.');

  const files = [];
  const paths = new Map();
  for (const item of args.images) {
    const file = localImage(item.path, ctx.store.dirs);
    const sizeBytes = fs.statSync(file).size;
    if (!sizeBytes || sizeBytes > MAX_FILE_BYTES) throw new Error(`${item.path}: 파일은 1바이트 이상 16MB 이하여야 합니다.`);
    const bytes = fs.readFileSync(file);
    const type = allowFiles ? assetFileType(file, bytes) : imageType(bytes);
    const hash = sha256(bytes);
    const alias = String(item.alias || `CUT_${hash.slice(0, 12).toUpperCase()}`);
    if (!/^[A-Z0-9._,:_-]{2,48}$/.test(alias)) throw new Error(`${alias}: BAO 에셋 alias 형식이 맞지 않습니다.`);
    const category = String(item.category || (type.contentType === 'audio/mpeg' ? 'audio' : 'other'));
    if (!['character', 'background', 'equipment', 'audio', 'other'].includes(category) ||
      !allowFiles && category === 'audio') throw new Error(`${alias}: 지원하지 않는 에셋 분류입니다.`);
    files.push({ alias, name: String(item.name || path.basename(file)).slice(0, 100), category,
      description: String(item.description || '').slice(0, 1200), fileName: `${alias}${type.ext}`,
      contentType: type.contentType, sizeBytes, sha256: hash });
    paths.set(alias, file);
  }
  if (new Set(files.map((file) => file.alias)).size !== files.length) throw new Error('업로드 목록의 alias가 중복됩니다.');

  const idempotencyKey = `flash-upload-${sha256(Buffer.from(JSON.stringify({ projectId, files }))).slice(0, 40)}`;
  const prepared = await mcpCall(endpoint.href, headers, 'production_prepare', {
    project_id: projectId, operation: 'assets.prepare_upload_batch', arguments: { files }, idempotency_key: idempotencyKey
  }, fetchImpl, ctx.signal);
  if (!prepared.commandId || !prepared.confirmation) throw new Error('BAO 업로드 준비 명령의 확인 정보가 없습니다.');
  const executed = await mcpCall(endpoint.href, headers, 'production_execute', {
    project_id: projectId, command_id: prepared.commandId, confirmation: prepared.confirmation
  }, fetchImpl, ctx.signal);
  if (executed.status !== 'succeeded') throw new Error(`BAO 업로드 티켓 발급 실패: ${executed.status || '상태 불명'}`);
  const full = await mcpCall(endpoint.href, headers, 'production_command_status', {
    project_id: projectId, command_id: prepared.commandId, detail: 'full'
  }, fetchImpl, ctx.signal);
  const uploads = full.result?.uploads;
  if (!Array.isArray(uploads) || uploads.length !== files.length) throw new Error('BAO 업로드 티켓 건수가 맞지 않습니다. 재발급하지 말고 명령 상태를 확인하세요.');

  const receipts = [];
  for (const ticket of uploads) {
    const descriptor = files.find((file) => file.alias === ticket.alias);
    if (!descriptor || !paths.has(ticket.alias) || !ticket.uploadToken) throw new Error('BAO 업로드 티켓이 원본 파일과 일치하지 않습니다.');
    const uploadUrl = new URL(String(ticket.uploadUrl));
    if (uploadUrl.origin !== endpoint.origin || uploadUrl.pathname !== '/api/assets/ticket') throw new Error('BAO 업로드 주소가 예상한 서버와 다릅니다.');
    const bytes = fs.readFileSync(paths.get(ticket.alias));
    if (bytes.length !== descriptor.sizeBytes || sha256(bytes) !== descriptor.sha256) throw new Error(`${ticket.alias}: 업로드 전에 파일이 변경됐습니다.`);
    let response;
    try { response = await fetchImpl(uploadUrl.href, { method: 'POST', headers: {
      Authorization: `Upload ${ticket.uploadToken}`, 'OAI-Sites-Authorization': headers['OAI-Sites-Authorization'],
      'content-type': descriptor.contentType
    }, body: bytes, signal: ctx.signal }); }
    catch (error) { return { text: `전송 결과가 불확실하여 중단했습니다. 성공 ${receipts.length}/${files.length}건. ${ticket.alias}의 티켓/에셋 상태를 확인한 뒤 재시도하세요. ${error.message}`, isError: true }; }
    let receipt;
    try { receipt = await responseJson(response, ticket.alias); }
    catch (error) { return { text: `업로드가 ${ticket.alias}에서 중단됐습니다. 앞선 성공 ${receipts.length}/${files.length}건은 유지됩니다. 같은 티켓과 에셋 상태를 확인한 뒤 재개하세요. ${error.message}`, isError: true }; }
    receipts.push({ alias: ticket.alias, assetId: receipt.asset?.id || receipt.id || null, name: descriptor.name, sizeBytes: descriptor.sizeBytes });
  }
  return { text: `BAO 프로젝트 ${projectId}에 ${allowFiles ? '파일' : '이미지'} ${receipts.length}개를 등록했습니다. 생성/렌더는 실행하지 않았습니다.\n${JSON.stringify(receipts)}`, receipts };
}

function uploadBaoFiles(args, ctx, fetchImpl = fetch) {
  return uploadBaoImages({ ...args, images: args.files }, ctx, fetchImpl, true);
}

async function uploadBaoToCanvas(args, ctx, fetchImpl = fetch) {
  const graphId = String(args.graph_id || '');
  const baseRevision = args.base_revision;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(graphId) || !Number.isSafeInteger(baseRevision) || baseRevision < 0)
    throw new Error('canvas_overview/read_canvas_graph에서 확인한 정확한 graph_id와 base_revision이 필요합니다.');
  if (!Array.isArray(args.images) || args.images.length > 20)
    throw new Error('캔버스에 한 번에 올릴 수 있는 이미지는 1–20장입니다.');
  const uploaded = await uploadBaoImages(args, ctx, fetchImpl);
  if (uploaded.isError) return uploaded;
  const projectId = String(args.project_id);
  const config = ctx.store.getMcpConfig().mcpServers['bao-production'];
  const changes = uploaded.receipts.map((item, index) => ({
    kind: 'attach_media', mode: 'add', attachmentKey: item.assetId,
    nodeId: `flash_${crypto.createHash('sha256').update(`${projectId}:${graphId}:${item.assetId}`).digest('hex').slice(0, 24)}`,
    title: item.name, position: { x: 120, y: 120 + index * 360 }
  }));
  if (changes.some((change) => !change.attachmentKey))
    return { isError: true, text: `이미지 업로드는 완료됐지만 저장 assetId를 확인하지 못해 캔버스 연결을 중단했습니다. ${JSON.stringify(uploaded.receipts)}` };
  const idempotencyKey = `flash-canvas-${sha256(Buffer.from(JSON.stringify({ projectId, graphId, baseRevision, changes }))).slice(0, 40)}`;
  try {
    const prepared = await mcpCall(config.url, config.headers, 'production_prepare', { project_id: projectId,
      operation: 'canvas.patch', arguments: { graphId, baseRevision, changes }, idempotency_key: idempotencyKey }, fetchImpl);
    const executed = await mcpCall(config.url, config.headers, 'production_execute', { project_id: projectId,
      command_id: prepared.commandId, confirmation: prepared.confirmation }, fetchImpl);
    if (executed.status !== 'succeeded') throw new Error(`캔버스 반영 상태: ${executed.status || '불명'}`);
    return { text: `BAO 캔버스 ${graphId}에 이미지 ${changes.length}개를 세로로 배치했습니다. 생성/렌더는 실행하지 않았습니다. ${JSON.stringify({ assets: uploaded.receipts, nodeIds: changes.map((change) => change.nodeId), commandId: prepared.commandId })}` };
  } catch (error) {
    return { isError: true, text: `이미지 ${uploaded.receipts.length}개는 에셋에 등록됐지만 캔버스 반영은 확인되지 않았습니다. 캔버스 revision과 명령 상태를 조회하세요. 재업로드하지 마세요. ${error.message} ${JSON.stringify(uploaded.receipts)}` };
  }
}

async function patchBaoCanvas(args, ctx, fetchImpl = fetch) {
  const projectId = String(args.project_id || '');
  const graphId = String(args.graph_id || '');
  const baseRevision = args.base_revision;
  const changes = Array.isArray(args.changes) ? args.changes.map((source) => {
    const change = { ...source };
    if (change.kind === 'update_node' && change.config && typeof change.config === 'object' &&
      !Array.isArray(change.config) && change.config.contentType === 'text/plain' && typeof change.config.text === 'string') {
      change.config = { ...change.config };
      delete change.config.contentType;
    }
    if (change.kind === 'add_node' && change.node?.type === 'text.input') {
      const node = { ...change.node };
      if (change.config !== undefined) {
        if (node.config !== undefined) throw new Error('새 텍스트 노드의 config가 두 곳에 있습니다. node.config만 사용하세요.');
        node.config = change.config;
        delete change.config;
      }
      if (!node.config || typeof node.config !== 'object' || Array.isArray(node.config))
        throw new Error('새 텍스트 노드는 node.config:{title,text}가 필요합니다.');
      node.config = { ...node.config };
      if (node.config.contentType === 'text/plain') delete node.config.contentType;
      if (typeof node.config.text !== 'string' || !node.config.text.trim())
        throw new Error('새 텍스트 노드에는 실제 내용인 node.config.text가 필요합니다.');
      change.node = node;
    }
    return change;
  }) : args.changes;
  if (!PROJECT_ID.test(projectId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(graphId) ||
    !Number.isSafeInteger(baseRevision) || baseRevision < 0)
    throw new Error('정확한 project_id, graph_id와 최신 base_revision이 필요합니다.');
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 20 ||
    changes.some((change) => !change || typeof change !== 'object' || Array.isArray(change) ||
      !['update_node', 'add_node', 'remove_node', 'add_edge', 'update_edge', 'remove_edge', 'upsert_group', 'remove_group', 'attach_media', 'replace_media'].includes(change.kind) || 'op' in change))
    throw new Error('변경은 1–20개이며 각 항목에 정확한 kind가 필요합니다. op 필드는 사용하지 않습니다.');
  const bao = ctx.store.getMcpConfig().mcpServers['bao-production'];
  const endpoint = new URL(String(bao?.url || ''));
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/api/lightbringer-mcp' ||
    !bao.headers?.Authorization || !bao.headers?.['OAI-Sites-Authorization'])
    throw new Error('BAO 클라우드 MCP와 이중 인증을 먼저 연결하세요.');
  const argumentsValue = { graphId, baseRevision, changes };
  const idempotencyKey = `flash-patch-${sha256(Buffer.from(JSON.stringify({ projectId, ...argumentsValue }))).slice(0, 40)}`;
  const prepared = await mcpCall(endpoint.href, bao.headers, 'production_prepare', {
    project_id: projectId, operation: 'canvas.patch', arguments: argumentsValue, idempotency_key: idempotencyKey
  }, fetchImpl, ctx.signal);
  if (!prepared.commandId || !prepared.confirmation) throw new Error('캔버스 수정 준비 명령을 확인하지 못했습니다.');
  let executed;
  try {
    executed = await mcpCall(endpoint.href, bao.headers, 'production_execute', {
      project_id: projectId, command_id: prepared.commandId, confirmation: prepared.confirmation
    }, fetchImpl, ctx.signal);
  } catch (error) {
    return { isError: true, text: `캔버스 수정 결과를 확인하지 못했습니다. 명령 ${prepared.commandId}의 상태와 그래프 revision을 조회하세요. 새 키로 자동 재실행하지 마세요. ${error.message}` };
  }
  if (executed.status !== 'succeeded')
    return { isError: true, text: `캔버스 수정 상태 ${executed.status || '불명'}; 명령 ${prepared.commandId}와 그래프 revision을 확인하세요.` };
  return { text: `BAO 캔버스 ${graphId}에 ${changes.length}개 변경을 적용했습니다. commandId=${prepared.commandId}. 최신 revision과 노드를 다시 읽어 검증하세요.`, commandId: prepared.commandId };
}

// 캔버스 그래프(draft)를 읽어 revision 과 노드 목록을 돌려준다
async function readBaoCanvas(projectId, graphId, ctx, fetchImpl = fetch) {
  const bao = ctx.store.getMcpConfig().mcpServers['bao-production'];
  const data = await mcpCall(String(bao?.url || ''), bao?.headers || {}, 'production_read', {
    project_id: projectId, operation: 'read_canvas_graph', arguments: { graph_id: graphId }, detail: 'full'
  }, fetchImpl, ctx.signal);
  const graph = data.data?.graph || data.graph || {};
  const raw = graph.draft?.nodes || [];
  const nodes = Array.isArray(raw) ? raw : Object.values(raw);
  return { revision: graph.revision, nodes, edges: Array.isArray(graph.draft?.edges) ? graph.draft.edges : [] };
}

// Build saved, unexecuted I2V nodes from exact pairs. The BAO registry supplies
// provider settings and ports; a graph read-back, not the revision alone, proves
// every node and connection was saved.
async function wireBaoCanvasVideos(args, ctx, fetchImpl = fetch) {
  const projectId = String(args.project_id || '');
  const graphId = String(args.graph_id || '');
  const pairs = args.pairs;
  // 동기화 오디오: 기본 켬 (예전에는 false 로 고정돼 모든 영상이 무성으로 나왔다)
  const wantAudio = args.generate_audio !== false;
  // 길이는 컷마다 대본 시트에서 계산한 값만 받는다 (프리셋의 duration 5 를 그대로 쓰지 않는다)
  for (const [i, pair] of (pairs || []).entries()) {
    const d = Number(pair.duration);
    if (!Number.isInteger(d) || d < 2 || d > 30) throw new Error(`컷 ${i + 1}: duration(2~30초)이 없습니다. script_sheet 로 대본 시트를 저장해 컷마다 계산된 길이를 넣으세요. 고정 5초는 쓰지 않습니다.`);
  }
  if (!PROJECT_ID.test(projectId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(graphId))
    throw new Error('정확한 BAO project_id와 graph_id가 필요합니다.');
  if (!Array.isArray(pairs) || !pairs.length || pairs.length > 40)
    throw new Error('한 번에 컷별 이미지·프롬프트 쌍을 1–40개 지정하세요.');
  const ids = new Set();
  for (const pair of pairs) {
    if (!pair || typeof pair !== 'object' ||
      !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(String(pair.pro_image_node_id || '')) ||
      !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(String(pair.prompt_node_id || '')))
      throw new Error('각 컷에는 캔버스에서 조회한 정확한 pro_image_node_id와 prompt_node_id가 필요합니다.');
    const key = `${pair.pro_image_node_id}\0${pair.prompt_node_id}`;
    if (ids.has(key)) throw new Error('같은 PRO 이미지·프롬프트 쌍을 중복 지정했습니다.');
    ids.add(key);
  }
  const bao = ctx.store.getMcpConfig().mcpServers['bao-production'];
  const endpoint = new URL(String(bao?.url || ''));
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/api/lightbringer-mcp' ||
    !bao.headers?.Authorization || !bao.headers?.['OAI-Sites-Authorization'])
    throw new Error('BAO 클라우드 MCP와 이중 인증을 먼저 연결하세요.');
  const catalog = await mcpCall(endpoint.href, bao.headers, 'canvas_node_catalog',
    { project_id: projectId, type: 'video.generate' }, fetchImpl, ctx.signal);
  const video = catalog.nodes?.find((item) => item.type === 'video.generate');
  const preset = catalog.presets?.find((item) => item.id === 'wan3-mulerouter-480p');
  if (!video || !preset || !video.inputs?.some((port) => port.key === 'images' && port.type === 'image[]') ||
    !video.inputs?.some((port) => port.key === 'prompt' && port.type === 'text') ||
    preset.config?.provider !== 'mulerouter' || preset.config?.model !== 'wan3' ||
    preset.config?.videoEngine !== 'wan3-mulerouter' || preset.config?.resolution !== '480p')
    throw new Error('BAO의 실제 WAN 3.0 MuleRouter 480p 노드 계약을 확인하지 못했습니다. 노드를 생성하지 않았습니다.');
  const original = await readBaoCanvas(projectId, graphId, ctx, fetchImpl);
  if (Number.isSafeInteger(args.expected_revision) && original.revision !== args.expected_revision)
    throw new Error(`캔버스 revision이 ${args.expected_revision} → ${original.revision}로 바뀌었습니다. 최신 상태를 읽고 다시 요청하세요.`);
  const nodesById = new Map(original.nodes.map((node) => [node.id, node]));
  const plan = pairs.map((pair, index) => {
    const image = nodesById.get(pair.pro_image_node_id);
    const prompt = nodesById.get(pair.prompt_node_id);
    if (image?.type !== 'image.input' || !image.sourceBinding && !image.config?.assetId)
      throw new Error(`${pair.pro_image_node_id}: 연결된 PRO 이미지가 아닙니다. 실제 미디어 출처를 확인하세요.`);
    if (prompt?.type !== 'text.input' || !String(prompt.config?.text || prompt.config?.prompt || '').trim())
      throw new Error(`${pair.prompt_node_id}: 내용이 있는 text.input 노드가 아닙니다.`);
    const nodeId = String(pair.video_node_id || `wan3_${sha256(Buffer.from(`${graphId}:${image.id}:${prompt.id}`)).slice(0, 24)}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(nodeId)) throw new Error('video_node_id 형식이 올바르지 않습니다.');
    const existing = nodesById.get(nodeId);
    if (existing && (existing.type !== 'video.generate' || existing.config?.provider !== 'mulerouter' ||
      existing.config?.model !== 'wan3' || existing.config?.resolution !== '480p'))
      throw new Error(`${nodeId}: 다른 용도로 사용 중인 노드 ID입니다. 기존 노드를 덮지 않습니다.`);
    const title = String(pair.title || `WAN 3.0 · ${image.config?.title || `컷 ${index + 1}`}`).slice(0, 180);
    return { imageId: image.id, promptId: prompt.id, nodeId, title, duration: Number(pair.duration),
      position: { x: Math.max(Number(image.position?.x || 0), Number(prompt.position?.x || 0)) + 440,
        y: Number(image.position?.y || prompt.position?.y || index * 360) } };
  });
  if (new Set(plan.map((item) => item.nodeId)).size !== plan.length)
    throw new Error('둘 이상의 컷이 같은 영상 노드 ID를 사용합니다.');
  let state = original;
  const updated = [];
  for (let start = 0; start < plan.length; start += 6) {
    const changes = [];
    for (const item of plan.slice(start, start + 6)) {
      const node = state.nodes.find((candidate) => candidate.id === item.nodeId);
      if (!node) changes.push({ kind: 'add_node', node: { id: item.nodeId, type: 'video.generate',
        typeVersion: video.version, position: item.position,
        config: { ...Object.fromEntries(Object.entries(preset.config).filter(([key]) => key !== 'status')), title: item.title, duration: item.duration, durationProvisional: false, generateAudio: wantAudio } } });
      else if (node.config?.generateAudio !== wantAudio || node.config?.duration !== item.duration) {
        // update_node 는 config 를 통째로 바꾸므로 기존 설정에 합쳐 보낸다. 실행 상태 값은 서버가 거부하니 뺀다
        const RUNTIME = ['status', 'executionStatus', 'executionAction', 'submittedAt', 'runtimeUpdatedAt', 'idempotencyKey', 'mediaInputChanged', 'jobId', 'lastJobId', 'outputUrl', 'outputs', 'error', 'progress'];
        const config = Object.fromEntries(Object.entries(node.config || {}).filter(([key]) => !RUNTIME.includes(key)));
        changes.push({ kind: 'update_node', nodeId: item.nodeId, config: { ...config, generateAudio: wantAudio, duration: item.duration, durationProvisional: false } });
      }
      const edgeSpecs = [
        { id: `${item.nodeId}_image`, from: { nodeId: item.imageId, port: 'image' },
          to: { nodeId: item.nodeId, port: 'images' }, dataType: 'image', order: 0 },
        { id: `${item.nodeId}_prompt`, from: { nodeId: item.promptId, port: 'text' },
          to: { nodeId: item.nodeId, port: 'prompt' }, dataType: 'text', order: 0 },
      ];
      for (const edge of edgeSpecs) {
        const existing = state.edges.find((candidate) => candidate.id === edge.id);
        if (existing && JSON.stringify({ from: existing.from, to: existing.to, dataType: existing.dataType }) !==
          JSON.stringify({ from: edge.from, to: edge.to, dataType: edge.dataType }))
          throw new Error(`${edge.id}: 기존 연결이 다릅니다. 덮어쓰지 않았습니다.`);
        if (!existing) changes.push({ kind: 'add_edge', edge });
      }
    }
    if (changes.length) {
      const result = await patchBaoCanvas({ project_id: projectId, graph_id: graphId,
        base_revision: state.revision, changes }, ctx, fetchImpl);
      if (result.isError) return { ...result, text: `${updated.length}개 컷까지 저장 확인. ${result.text}` };
    }
    state = await readBaoCanvas(projectId, graphId, ctx, fetchImpl);
    for (const item of plan.slice(start, start + 6)) {
      const node = state.nodes.find((candidate) => candidate.id === item.nodeId);
      const imageEdge = state.edges.find((edge) => edge.from?.nodeId === item.imageId && edge.from?.port === 'image' &&
        edge.to?.nodeId === item.nodeId && edge.to?.port === 'images' && edge.dataType === 'image');
      const promptEdge = state.edges.find((edge) => edge.from?.nodeId === item.promptId && edge.from?.port === 'text' &&
        edge.to?.nodeId === item.nodeId && edge.to?.port === 'prompt' && edge.dataType === 'text');
      if (!node || node.config?.provider !== 'mulerouter' || node.config?.model !== 'wan3' ||
        node.config?.videoEngine !== 'wan3-mulerouter' || node.config?.resolution !== '480p' ||
        node.config?.generateAudio !== wantAudio || node.config?.duration !== item.duration || !imageEdge || !promptEdge)
        return { isError: true, text: `저장 후 재조회에서 ${item.nodeId}의 영상 설정·입력 연결을 확인하지 못했습니다. 이미 적용된 변경을 재실행하지 마세요. revision=${state.revision}` };
      updated.push(item.nodeId);
    }
  }
  return { text: `Flash가 ${updated.length}개 컷의 PRO 이미지·프롬프트를 각각 WAN 3.0 MuleRouter 480p 영상 노드에 연결하고, 동기화 오디오 ${wantAudio ? '켬' : '끔'}과 컷별 길이(${plan.map((p) => p.duration + '초').join(', ')})까지 다시 읽어 확인했습니다. 영상 생성은 실행하지 않았습니다. revision=${state.revision}; videoNodeIds=${JSON.stringify(updated)}. 기존 프롬프트가 영상 동작용인지 확인하고 길이를 지정한 뒤 유료 생성을 별도로 요청하세요.` };
}

// Read the same reference contract that BAO uses for the editor and renderer.
// This is intentionally read-only: Flash can find missing links without
// guessing from a screenshot or adding duplicate edges.
async function inspectBaoVideoInputs(args, ctx, fetchImpl = fetch) {
  const projectId = String(args.project_id || '');
  const graphId = String(args.graph_id || '');
  if (!PROJECT_ID.test(projectId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(graphId))
    throw new Error('정확한 BAO project_id와 graph_id가 필요합니다.');
  const bao = ctx.store.getMcpConfig().mcpServers['bao-production'];
  const endpoint = new URL(String(bao?.url || ''));
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/api/lightbringer-mcp' ||
    !bao.headers?.Authorization || !bao.headers?.['OAI-Sites-Authorization'])
    throw new Error('BAO 클라우드 MCP와 이중 인증을 먼저 연결하세요.');
  const graph = await readBaoCanvas(projectId, graphId, ctx, fetchImpl);
  const rows = [];
  for (let offset = 0; offset < graph.nodes.filter((node) => node.type === 'video.generate').length; offset += 40) {
    const result = await mcpCall(endpoint.href, bao.headers, 'canvas_video_inputs_read',
      { project_id: projectId, graph_id: graphId, expected_revision: graph.revision, offset, limit: 40 },
      fetchImpl, ctx.signal);
    rows.push(...(result.videos || []));
  }
  const lines = rows.map((row) => {
    // The upstream read tool returns storage-array order, while execution sorts
    // inbound edges by edge.order. Do not label storage order as Image slots.
    const imageOrder = (image) => {
      const edge = graph.edges.find((item) => item.to?.nodeId === row.nodeId &&
        (image.edgeId ? item.id === image.edgeId : item.from?.nodeId === image.nodeId));
      return edge && Number.isFinite(Number(edge.order)) ? Number(edge.order) : null;
    };
    const orderedImages = [...(row.images || [])].sort((left, right) =>
      (imageOrder(left) ?? Infinity) - (imageOrder(right) ?? Infinity));
    const images = orderedImages.map((image) => `${image.nodeId}${image.referenceAvailable ? '' : ' (원본 참조 없음)'}`).join(', ') || '없음';
    const orderNote = orderedImages.every((image) => imageOrder(image) !== null)
      ? orderedImages.map((image, index) => `@Image ${index + 1}=${image.nodeId} (edge.order=${imageOrder(image)})`).join(', ')
      : '엣지 순서 근거 없음; 공급자 슬롯 미검증';
    const prompts = (row.prompts || []).map((prompt) => `${prompt.nodeId} (${prompt.textChars}자)`).join(', ') || '없음';
    const problems = row.issues?.length ? ` · 문제: ${row.issues.join(', ')}` : '';
    return `- ${row.title || row.nodeId}: PRO images ← ${images}; prompt ← ${prompts}; 참조 ${row.referencesReady ? '확인' : '미완료'}${problems} · edge.order 기준: ${orderNote}`;
  });
  const structure = rows.map((row) => inspectVideoStructure(graph, row.nodeId, row));
  const checked = structure.filter((row) => row.applicable);
  const structureLines = checked.map((row) => `- ${row.nodeId}: 구조 ${row.ready ? '통과' : '오류'}; Total/config=${row.duration}s; SHOT=${row.shots.length}; 전역발화=${row.utterances.length}; ${row.errors.map((item) => item.code + ': ' + item.detail).join(' / ') || '시간·슬롯 오류 없음'}`);
  return { structure, text: `BAO 저장 그래프 revision ${graph.revision}, video.generate ${rows.length}개, 참조 확인 ${rows.filter((row) => row.referencesReady).length}개. 실제 입력 포트는 images+prompt입니다. 목록은 edge.order로 정렬했습니다. 공급자 직렬화·reference/first-frame 역할·영상 품질은 별도 확인해야 합니다. 확인된 컷에는 선을 중복 추가하거나 노드를 재생성하지 마세요.\n${lines.join('\n')}\n구조 검사 ${checked.length}개, 오류 ${checked.filter((row) => !row.ready).length}개. 구조 오류가 있으면 해당 필드를 교정하고 다시 조회하세요. 구조 통과는 실제 영상 합격이 아닙니다.\n${structureLines.join('\n')}` };
}

// 컷 프롬프트 한 개를 text.input 노드로 저장한다.
// 실행 전에 그래프를 읽어 노드가 있으면 update, 없으면 add 를 고르고(mode 는 참고만), 실행 뒤 다시 읽어 실제 저장 여부를 확인한다.
async function setBaoCanvasText(args, ctx, fetchImpl = fetch) {
  const text = String(args.text || '').trim();
  const nodeId = String(args.node_id || '');
  if (!text || text.length > 12000 || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(nodeId))
    throw new Error('유효한 node_id와 1–12000자 text가 필요합니다. 컷마다 한 번씩 호출하세요.');
  const projectId = String(args.project_id || '');
  const graphId = String(args.graph_id || '');
  const before = await readBaoCanvas(projectId, graphId, ctx, fetchImpl);
  const existing = before.nodes.find((n) => n.id === nodeId);
  const title = String(args.title || existing?.config?.title || nodeId);
  const hasStructuredReference = (value) => String(value || '').includes('[REFERENCE-TO-VIDEO INPUT MODE]')
    || String(value || '').includes('[타이밍 TIMING — EP04 구조]');
  if (hasStructuredReference(existing?.config?.text)) {
    const missingDialogue = dialoguePreservationErrors(existing.config.text, text);
    if (missingDialogue.length) return { isError: true, text: `기존 원문 대사 보존 오류로 저장하지 않았습니다: ${missingDialogue.map((item) => item.detail).join(' / ')}` };
    if (!hasStructuredReference(text))
      return { isError: true, text: '기존 reference 구조 선언이 삭제되었습니다. 보존한 수정본을 사용하세요. 저장하지 않았습니다.' };
    const proposed = { ...before, nodes: before.nodes.map((node) => node.id === nodeId
      ? { ...node, config: { ...node.config, title, text } } : node) };
    const affectedIds = [...new Set(before.edges.filter((edge) => edge.from?.nodeId === nodeId &&
      String(edge.to?.port || '').split(':')[1] === 'prompt').map((edge) => edge.to.nodeId))];
    const invalid = affectedIds.map((id) => inspectVideoStructure(proposed, id)).filter((row) => row.applicable && !row.ready);
    if (invalid.length) return { isError: true, text: `구조 오류로 저장하지 않았습니다: ${invalid.map((row) => row.nodeId + ' ' + row.errors.map((error) => error.code + ': ' + error.detail).join(' / ')).join('; ')}` };
  }
  let change;
  if (existing) {
    // canvas.patch merges config. Re-sending unchanged registry/runtime fields
    // can fail server validation even though the text itself is valid.
    change = { kind: 'update_node', nodeId, config: { title, text } };
  } else {
    // 좌표가 없으면 기존 텍스트 노드 열 아래에 이어 붙인다
    const texts = before.nodes.filter((n) => n.type === 'text.input' && n.position);
    const x = Number.isFinite(args.x) ? args.x : (texts[0]?.position.x ?? 1000);
    const y = Number.isFinite(args.y) ? args.y : (texts.length ? Math.max(...texts.map((n) => n.position.y)) + 360 : 120);
    change = { kind: 'add_node', node: { id: nodeId, type: 'text.input', position: { x, y }, config: { title, text } } };
  }
  // base_revision 은 방금 읽은 최신값을 쓴다 (모델이 준 값이 오래됐어도 충돌하지 않게)
  const result = await patchBaoCanvas({ project_id: projectId, graph_id: graphId,
    base_revision: before.revision, changes: [change] }, ctx, fetchImpl);
  if (result.isError) return result;
  const after = await readBaoCanvas(projectId, graphId, ctx, fetchImpl);
  const saved = after.nodes.find((n) => n.id === nodeId);
  if (!saved || String(saved.config?.text || '').trim() !== text)
    return { isError: true, text: `명령은 성공으로 끝났지만 다시 읽은 그래프에서 ${nodeId} 의 내용이 확인되지 않습니다 (revision ${after.revision}). commandId=${result.commandId}` };
  const textCount = after.nodes.filter((n) => n.type === 'text.input').length;
  return {
    text: `${existing ? '기존 노드를 수정' : '새 노드를 추가'}하고 다시 읽어 확인했습니다: ${nodeId} "${saved.config.title}" — ${saved.config.text.length}자, 위치 (${saved.position?.x}, ${saved.position?.y}). 그래프 revision ${before.revision} → ${after.revision}, 전체 노드 ${after.nodes.length}개(텍스트 ${textCount}개). commandId=${result.commandId}`,
    commandId: result.commandId
  };
}

// 캔버스 노드를 실제로 읽어 요약한다 (텍스트 노드 내용 앞부분 포함). canvas_overview 는 노드 내용을 주지 않으므로 검증에는 이것을 쓴다
async function inspectBaoCanvas(args, ctx, fetchImpl = fetch) {
  const projectId = String(args.project_id || '');
  const graphId = String(args.graph_id || '');
  const { revision, nodes } = await readBaoCanvas(projectId, graphId, ctx, fetchImpl);
  const types = {};
  for (const n of nodes) types[n.type] = (types[n.type] || 0) + 1;
  const filter = String(args.type || '');
  const list = nodes.filter((n) => !filter || n.type === filter)
    .sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0) || (a.position?.y ?? 0) - (b.position?.y ?? 0));
  const lines = list.map((n) => {
    const c = n.config || {};
    const detail = n.type === 'text.input' ? `"${c.title || ''}" ${String(c.text || '').length}자: ${String(c.text || '').replace(/\s+/g, ' ').slice(0, Number(args.preview_chars) || 120)}`
      : n.type === 'image.input' ? `"${c.title || ''}" assetId=${c.assetId || '-'}` : (c.title || '');
    return `- ${n.id} [${n.type}] (${n.position?.x}, ${n.position?.y}) ${detail}`;
  });
  return { text: `그래프 ${graphId} revision ${revision}: 노드 ${nodes.length}개 ${JSON.stringify(types)}\n${lines.join('\n')}` };
}

async function repairBaoCanvasBindings(args, ctx, fetchImpl = fetch) {
  const projectId = String(args.project_id || '');
  const graphId = String(args.graph_id || '');
  const expected = args.expected_image_count;
  if (!PROJECT_ID.test(projectId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(graphId) ||
    !Number.isSafeInteger(expected) || expected < 1 || expected > 1000)
    throw new Error('정확한 project_id, graph_id, expected_image_count가 필요합니다.');
  const bao = ctx.store.getMcpConfig().mcpServers['bao-production'];
  const endpoint = new URL(String(bao?.url || ''));
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/api/lightbringer-mcp' ||
    !bao.headers?.Authorization || !bao.headers?.['OAI-Sites-Authorization'])
    throw new Error('BAO 클라우드 MCP와 이중 인증을 먼저 연결하세요.');
  const read = () => mcpCall(endpoint.href, bao.headers, 'production_read', {
    project_id: projectId, operation: 'read_canvas_graph', detail: 'full', arguments: { graph_id: graphId }
  }, fetchImpl, ctx.signal);
  const initial = await read();
  const imageNodes = initial.data?.graph?.draft?.nodes?.filter((node) => node.type === 'image.input') || [];
  if (imageNodes.length !== expected)
    throw new Error(`이미지 노드 수가 예상과 다릅니다: 예상 ${expected}, 실제 ${imageNodes.length}. 수정 없이 중단했습니다.`);
  const missing = imageNodes.filter((node) => !node.sourceBinding && typeof node.config?.assetId === 'string');
  if (imageNodes.some((node) => !node.sourceBinding && !node.config?.assetId))
    throw new Error('출처와 assetId가 모두 없는 이미지가 있어 수정 없이 중단했습니다.');
  const targetIds = missing.map((node) => node.id);
  let restored = 0;
  for (let offset = 0; offset < targetIds.length; offset += 20) {
    const current = await read();
    const graph = current.data?.graph;
    const byId = new Map((graph?.draft?.nodes || []).map((node) => [node.id, node]));
    const selected = targetIds.slice(offset, offset + 20);
    const changes = [];
    for (const id of selected) {
      const node = byId.get(id);
      if (!node || node.type !== 'image.input')
        return { isError: true, text: `이미지 ${id}가 변경됐습니다. ${restored}개 복구 후 중단했습니다.` };
      if (node.sourceBinding) continue;
      if (!node.config?.assetId)
        return { isError: true, text: `이미지 ${id}의 assetId가 사라졌습니다. ${restored}개 복구 후 중단했습니다.` };
      changes.push({ kind: 'attach_media', nodeId: id, attachmentKey: node.config.assetId, mode: 'replace' });
    }
    if (!changes.length) continue;
    const result = await patchBaoCanvas({ project_id: projectId, graph_id: graphId,
      base_revision: graph.revision, changes }, ctx, fetchImpl);
    if (result.isError) return { isError: true, text: `${restored}개 복구 후 중단했습니다. ${result.text}` };
    restored += changes.length;
  }
  const final = await read();
  const finalImages = final.data?.graph?.draft?.nodes?.filter((node) => node.type === 'image.input') || [];
  const remaining = finalImages.filter((node) => !node.sourceBinding).length;
  return { text: `BAO 캔버스 ${graphId}: 기존 assetId를 사용해 이미지 출처 연결 ${restored}개 복구했습니다. 최종 이미지 ${finalImages.length}개, 출처 누락 ${remaining}개, revision ${final.data?.graph?.revision}. 새 업로드·생성·렌더 없음.${remaining ? ' 누락 항목을 검토하세요.' : ''}`,
    restored, remaining, revision: final.data?.graph?.revision };
}

async function uploadBaoWebtoon(args, ctx, fetchImpl = fetch) {
  const projectId = String(args.project_id || '');
  const action = String(args.action || '');
  if (!PROJECT_ID.test(projectId) || !['source', 'frame', 'crop'].includes(action))
    throw new Error('정확한 project_id와 action=source|frame|crop이 필요합니다.');
  const file = localImage(args.path, ctx.store.dirs);
  const bytes = fs.readFileSync(file);
  const limit = action === 'source' ? 50 * 1024 * 1024 : 8 * 1024 * 1024;
  if (!bytes.length || bytes.length > limit) throw new Error(`${action} 이미지 크기는 1바이트–${limit}바이트여야 합니다.`);
  const type = webtoonImageType(bytes);
  const digest = sha256(bytes);
  const bao = ctx.store.getMcpConfig().mcpServers['bao-production'];
  const endpoint = new URL(String(bao?.url || ''));
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/api/lightbringer-mcp' ||
    !bao.headers?.Authorization || !bao.headers?.['OAI-Sites-Authorization'])
    throw new Error('BAO 클라우드 MCP와 이중 인증을 먼저 연결하세요.');
  const target = new URL('/api/webtoon-mcp-upload', endpoint.origin);
  target.searchParams.set('project', projectId);
  const headers = { Authorization: bao.headers.Authorization,
    'OAI-Sites-Authorization': bao.headers['OAI-Sites-Authorization'] };
  let init;
  if (action === 'source') {
    const episodeCode = String(args.episode_code || '');
    const pageOrder = args.page_order;
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u.test(episodeCode) ||
      !Number.isSafeInteger(pageOrder) || pageOrder < 1 || pageOrder > 100000)
      throw new Error('source에는 episode_code와 1–100000 page_order가 필요합니다.');
    target.searchParams.set('episodeCode', episodeCode);
    target.searchParams.set('pageOrder', String(pageOrder));
    target.searchParams.set('sourceName', String(args.name || path.basename(file)).slice(0, 180));
    target.searchParams.set('idempotencyKey', `flash-${sha256(Buffer.from(`${projectId}:${episodeCode}:${pageOrder}:${digest}`)).slice(0, 48)}`);
    init = { method: 'PUT', headers: { ...headers, 'content-type': type.contentType,
      'content-length': String(bytes.length), 'x-content-sha256': digest }, body: bytes, signal: ctx.signal };
  } else {
    const sourceId = String(args.source_id || '');
    const sourceSha = String(args.source_sha256 || '');
    if (!/^[a-f0-9-]{36}$/i.test(sourceId) || !/^[a-f0-9]{64}$/.test(sourceSha))
      throw new Error(`${action}에는 정확한 source_id와 source_sha256이 필요합니다.`);
    const form = new FormData();
    form.set('sourceId', sourceId);
    form.set('sourceSha256', sourceSha);
    form.set('file', new Blob([bytes], { type: type.contentType }), path.basename(file));
    if (action === 'frame') {
      const order = args.frame_order;
      const bounds = args.crop_bounds;
      if (!Number.isSafeInteger(order) || order < 0 || order > 255 || !bounds ||
        ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger))
        throw new Error('frame에는 0–255 frame_order와 정확한 crop_bounds {x,y,width,height}가 필요합니다.');
      form.set('frameOrder', String(order));
      form.set('cropBounds', JSON.stringify(bounds));
      form.set('idempotencyKey', `flash-${sha256(Buffer.from(`${projectId}:${sourceId}:${order}:${digest}`)).slice(0, 48)}`);
    } else {
      if (!Number.isSafeInteger(args.proposal_revision) || args.proposal_revision < 1 ||
        !Number.isSafeInteger(args.panel_order) || args.panel_order < 1 || args.panel_order > 200)
        throw new Error('crop에는 proposal_revision과 1–200 panel_order가 필요합니다.');
      form.set('proposalRevision', String(args.proposal_revision));
      form.set('panelOrder', String(args.panel_order));
    }
    target.searchParams.set('action', action);
    init = { method: 'POST', headers, body: form, signal: ctx.signal };
  }
  let response;
  try { response = await fetchImpl(target.href, init); }
  catch (error) { return { isError: true, text: `웹툰 ${action} 전송 결과가 불확실합니다. 동일 입력의 서버 상태를 먼저 조회하세요. ${error.message}` }; }
  const result = await responseJson(response, `웹툰 ${action} 업로드`);
  return { text: `BAO 웹툰 ${action} 입력이 저장됐습니다. 생성·렌더는 실행하지 않았습니다. ${JSON.stringify(result)}`,
    result };
}

module.exports = { uploadBaoImages, uploadBaoFiles, uploadBaoToCanvas, patchBaoCanvas, wireBaoCanvasVideos, inspectBaoVideoInputs, setBaoCanvasText, inspectBaoCanvas, readBaoCanvas, repairBaoCanvasBindings, uploadBaoWebtoon, localImage, imageType };
