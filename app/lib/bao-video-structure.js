'use strict';

// Technical validation of already-authored reference/SHOT prompts. No directing,
// generation, provider requests, or mutation. Unmarked legacy prompts are skipped.
const portKey = (port) => String(port || '').includes(':') ? String(port).split(':')[1] : String(port || '');
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.001;
const NUMBER = '(\\d+(?:\\.\\d+)?)';
const RANGE = `${NUMBER}\\s*[–—~\\-]\\s*${NUMBER}`;

function inspectVideoStructure(graph, videoId, inputRow) {
  const nodes = graph.nodes || graph.draft?.nodes || [];
  const edges = graph.edges || graph.draft?.edges || [];
  const node = nodes.find((item) => item.id === videoId);
  const inbound = edges.filter((edge) => edge.to?.nodeId === videoId);
  const connected = (key) => inbound.filter((edge) => portKey(edge.to?.port) === key)
    .sort((left, right) => Number(left.order) - Number(right.order));
  const prompts = connected('prompt');
  const sources = prompts.map((edge) => nodes.find((item) => item.id === edge.from?.nodeId));
  const text = sources.map((item) => String(item?.config?.text || '')).join('\n');
  const ep04Structure = text.includes('[타이밍 TIMING — EP04 구조]');
  if (!text.includes('[REFERENCE-TO-VIDEO INPUT MODE]') && !ep04Structure)
    return { nodeId: videoId, applicable: false, ready: null, errors: [], warnings: ['Structured reference prompt marker absent; not validated.'] };
  const errors = []; const warnings = [];
  const fail = (code, detail) => errors.push({ code, detail });
  if (!node || node.type !== 'video.generate') fail('VIDEO_NODE', 'Expected an existing video.generate node.');
  if (prompts.length !== 1 || sources[0]?.type !== 'text.input') fail('PROMPT_SOURCE', 'Exactly one text.input prompt is required.');
  const duration = Number(node?.config?.duration);
  if (!Number.isInteger(duration) || duration < 2 || duration > 30) fail('CONFIG_DURATION', 'Duration must be an integer in 2–30s for this structured WAN contract.');
  const totalMatch = text.match(/^Total:\s*([\d.]+)s\s*\/\s*(\d+)\s*shots\s*\/\s*(\d+:\d+)/m);
  const total = totalMatch ? Number(totalMatch[1]) : null;
  if (!totalMatch || !close(total, duration)) fail('TOTAL_CONFIG', 'Total must equal config.duration.');
  if (totalMatch && totalMatch[3] !== node?.config?.ratio) fail('RATIO', 'Prompt ratio differs from config.ratio.');
  const shots = [];
  for (const line of text.split('\n').filter((item) => /^SHOT\s+\d+\s*(?:\[|—)/.test(item))) {
    const match = line.match(new RegExp(`^SHOT\\s+(\\d+)\\s*\\[${RANGE}s;\\s*duration=${NUMBER}s\\]`))
      || (ep04Structure && line.match(new RegExp(`^SHOT\\s+(\\d+)\\s*—\\s*${NUMBER}\\s*~\\s*${NUMBER}초\\s*·\\s*duration=${NUMBER}s`)));
    if (!match) { fail('SHOT_FORMAT', 'Each SHOT needs a valid numeric window and explicit duration.'); continue; }
    const shot = { shot: Number(match[1]), start: Number(match[2]), end: Number(match[3]), duration: Number(match[4]) };
    if (!(shot.end > shot.start) || !close(shot.end - shot.start, shot.duration)) fail('SHOT_DURATION', `SHOT ${shot.shot}: duration differs from end-start.`);
    const previous = shots.at(-1);
    if (shot.shot !== shots.length + 1 || !close(shot.start, previous ? previous.end : 0)) fail('SHOT_SEQUENCE', `SHOT ${shot.shot}: numbering, gap or overlap.`);
    shots.push(shot);
    if (ep04Structure && !/\[P\d+패널[123]\((?:좌상|우상|좌하)\)(?:\s*\/[^\]]+)?\]/.test(line))
      fail('PANEL_ADDRESS', `SHOT ${shot.shot}: explicit pack, panel and position reference required.`);
  }
  if (!shots.length || shots.length !== Number(totalMatch?.[2]) || !close(shots.at(-1)?.end, duration)) fail('SHOT_TOTAL', 'SHOT count/final end must match Total and config.duration.');
  const utterances = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    const match = line.match(new RegExp(`\\[LINE(\\d+)[^\\]\\n]*\\][^\\n]*「([^」]*)」\\s*${RANGE}s`));
    if (!match) continue;
    const item = { lineId: `LINE${match[1]}`, start: Number(match[3]), end: Number(match[4]) };
    if (seen.has(item.lineId)) fail('DIALOGUE_DUPLICATE', `${item.lineId}: repeated full utterance.`);
    seen.add(item.lineId);
    if (item.start < 0 || item.end <= item.start || item.end > duration + 0.001) fail('DIALOGUE_WINDOW', `${item.lineId}: invalid/out-of-range global window.`);
    const previous = utterances.at(-1);
    if (previous && item.start < previous.end - 0.001) fail('DIALOGUE_OVERLAP', `${item.lineId}: overlapping authored voice windows.`);
    item.shotIds = shots.filter((shot) => item.start < shot.end && item.end > shot.start).map((shot) => shot.shot);
    const continuation = text.split('\n').find((entry) => entry.includes(`[${item.lineId} `) && /에서 시작한 같은 발화가/.test(entry));
    const continuedFrom = continuation?.match(/SHOT(\d+)에서 시작한 같은 발화가/);
    if (continuedFrom && Number(continuedFrom[1]) !== item.shotIds[0]) fail('CONTINUATION_SHOT', `${item.lineId}: wrong starting SHOT in continuation annotation.`);
    utterances.push(item);
  }
  const slots = {};
  for (const [key, token] of [['images', 'Image'], ['audio', 'Audio']]) {
    const selected = connected(key); const orders = new Set();
    slots[key] = selected.map((edge, index) => {
      const source = nodes.find((item) => item.id === edge.from?.nodeId);
      if (!source) fail('DANGLING_EDGE', `${key}: missing source node.`);
      if (!Number.isInteger(edge.order) || edge.order < 0 || orders.has(edge.order)) fail('REFERENCE_ORDER', `${key}: missing/duplicate edge.order.`);
      orders.add(edge.order);
      const compatible = key === 'images' ? ['image.input', 'image.generate'].includes(source?.type) : ['audio.input', 'audio.generate'].includes(source?.type);
      if (!compatible) fail('REFERENCE_TYPE', `${key}: unexpected source type ${source?.type}.`);
      return { slot: index + 1, nodeId: edge.from?.nodeId, order: edge.order,
        assetId: source?.config?.assetId || source?.sourceBinding?.assetId || null,
        alias: source?.sourceBinding?.alias || source?.config?.alias || null };
    });
    const tokens = [...text.matchAll(new RegExp(`@${token} (\\d+)`, 'g'))].map((match) => Number(match[1]));
    for (const number of new Set(tokens)) if (number < 1 || number > selected.length) fail('REFERENCE_TOKEN', `@${token} ${number}: no connected slot.`);
    if (!selected.length || !tokens.includes(1)) fail('REFERENCE_DECLARATION', `Connected ${key} require an explicit @${token} 1 declaration.`);
  }
  if (inputRow && !inputRow.referencesReady) fail('REFERENCES_UNREADY', 'Upstream references are not usable.');
  for (const issue of inputRow?.issues || []) fail('UPSTREAM_INPUT', String(issue));
  const referenceRoleValid = ep04Structure
    ? /첫 프레임·마지막 프레임 고정 입력으로 사용하지 않는다/.test(text)
      && /0\.0초부터 SHOT 1의 개별 장면만/.test(text)
      && /시트 전체를 한 화면으로 만들지 않는다/.test(text)
      && /인쇄된 패널 라벨 숫자/.test(text)
    : /NOT a first-frame or last-frame image/.test(text) && /At 0\.0s/.test(text) && /Never display the complete contact sheet/.test(text);
  if (!referenceRoleValid)
    fail('REFERENCE_ROLE', 'Missing reference-only / individual SHOT 1 / no contact-sheet first-frame instruction.');
  if (node?.config?.wanMode && node.config.wanMode !== 'reference') fail('WAN_MODE', 'Explicit WAN mode conflicts with the reference contract.');
  if (!node?.config?.wanMode) warnings.push('Node has no explicit wanMode; provider mode must be checked in its submitted job.');
  if (node?.config?.mediaInputChanged) warnings.push('Existing preview belongs to older inputs; new result is unverified.');
  return { nodeId: videoId, promptNodeId: sources[0]?.id, applicable: true, ready: errors.length === 0,
    duration, ratio: node?.config?.ratio, shots, utterances, slots, errors, warnings,
    providerRoleVerified: false, renderedOutcomeVerified: false };
}

function dialoguePreservationErrors(before, after) {
  const extract = (text) => [...String(text).matchAll(/\[LINE(\d+)[^\]\n]*\][^\n]*「([^」]*)」/g)]
    .map((match) => ({ id: `LINE${match[1]}`, text: match[2] }));
  const remaining = extract(after);
  return extract(before).filter((line) => !remaining.some((item) => item.id === line.id && item.text === line.text))
    .map((line) => ({ code: 'DIALOGUE_PRESERVATION', detail: `${line.id}: existing full utterance was removed or replaced.` }));
}

module.exports = { inspectVideoStructure, dialoguePreservationErrors };
