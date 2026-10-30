'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatRunner } = require('./chat');
const { BackgroundWaits } = require('./bgwait');
const { pollKey, pollStatusRead, pollInputError, pollFailure } = require('./poll-policy');

const fq = 'mcp__bao__production_read';
const commandId = 'editor_export_' + 'a'.repeat(64);
const envelope = () => ({ project_id: 'bao-' + 'b'.repeat(32), operation: 'editor.export_read', arguments: { editorProjectId: 'edit_neutral', commandId } });
const spec = () => ({ tool: fq, arguments: envelope(), label: 'Neutral export' });
function fixture(results = [{ status: 'waiting_for_renderer' }]) {
  const conversation = { id: 'neutral01', messages: [], bgWaits: [] };
  const settings = { tools: { approval: 'auto', resultLimit: 20000 } };
  const calls = [], notes = [];
  const store = { getSettings: () => settings, getConversation: () => conversation, saveConversation: () => {} };
  const mcp = {
    find: () => ({ fq, tool: 'production_read', cfg: {} }),
    lookup: () => ({ tool: 'production_read', cfg: {} }),
    async callTool(tool, args) {
      calls.push({ tool, args: structuredClone(args) });
      const result = results[Math.min(calls.length - 1, results.length - 1)];
      if (result instanceof Error) throw result;
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !!result.error };
    }
  };
  const runner = new ChatRunner({ store, mcp, skills: {} });
  const bg = new BackgroundWaits({ store, runner });
  bg.queueNote = (id, note) => notes.push({ id, note });
  runner.bg = bg;
  const ctx = runner.pollContext(conversation.id);
  const run = { steer: [], allowAll: new Set(), statusSeen: new Map() };
  return { runner, bg, conversation, ctx, run, calls, notes };
}
const poll = (f, args) => f.runner.pollUntil(args, f.ctx, f.run, { id: 'poll01' }, () => {});

test('production_read poll envelope preserves outer project and exact operation inputs', () => {
  const args = envelope(), before = structuredClone(args);
  for (const tool of [fq, 'bao/production_read', 'production_read']) assert.equal(pollInputError(args, tool), '');
  assert.deepEqual(args, before);
  assert.equal(pollInputError({ command_id: 'mcp_cmd_neutral', project_id: args.project_id }, 'mcp__bao__production_command_status'), '');
});

test('the logged flattened/missing envelopes are rejected before MCP or background registration', async () => {
  for (const args of [{ project_id: 'bao' }, { operation: 'editor.export_read' }, { operation: 'editor.export_read', arguments: [] }]) {
    const f = fixture();
    const result = await poll(f, { tool: fq, arguments: args });
    assert.equal(result.isError, true); assert.match(result.text, /전체 입력/);
    assert.equal(f.calls.length, 0); assert.equal(f.bg.pending(f.conversation.id), 0);
    assert.throws(() => f.bg.add(f.conversation.id, { tool: fq, arguments: args }), /전체 입력/);
  }
});

test('unsupported export_status gives the exact export_read contract without replay', async () => {
  const f = fixture(), args = envelope(); args.operation = 'editor.export_status';
  const result = await poll(f, { tool: fq, arguments: args });
  assert.equal(result.isError, true); assert.match(result.text, /editor\.export_read/);
  assert.match(result.text, /editorProjectId,commandId/); assert.match(result.text, /render_queue.*editor\.export_queue/);
  assert.equal(f.calls.length, 0); assert.equal(f.bg.pending(f.conversation.id), 0);
});

test('export ID, editor project, and outer project placement guards remain explicit', () => {
  for (const id of ['PLACEHOLDER', 'pending', 'mcp_cmd_neutral', 'editor_export_' + 'a'.repeat(63)]) {
    const args = envelope(); args.arguments.commandId = id;
    assert.match(pollInputError(args, fq), /64자리/);
    assert.match(pollInputError(args), /64자리/);
  }
  const missingProject = envelope(); delete missingProject.arguments.editorProjectId;
  assert.match(pollInputError(missingProject, fq), /editorProjectId/);
  const innerProject = envelope(); innerProject.arguments.project_id = innerProject.project_id;
  assert.match(pollInputError(innerProject, fq), /최상위/);
});

test('foreground export ends immediately on exported without registration or another read', async () => {
  const f = fixture([{ status: 'exported', commandId, output: { filename: 'neutral.webm' } }]);
  const args = spec(), result = await poll(f, { ...args, background: false });
  assert.match(result.text, /끝남.*status=exported/); assert.equal(result.isError, undefined);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0], { tool: fq, args: args.arguments });
  assert.equal(f.bg.pending(f.conversation.id), 0);
});

test('server/tool polling forwards the same complete production_read envelope', async () => {
  const f = fixture([{ status: 'exported', commandId }]), args = spec();
  const result = await poll(f, { ...args, tool: 'bao/production_read', background: false });
  assert.match(result.text, /status=exported/); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { tool: fq, args: args.arguments });
});

test('background export keeps exact saved IDs through waiting, rendering and exported', async () => {
  const f = fixture([{ status: 'waiting_for_renderer' }, { status: 'rendering' }, { status: 'exported', commandId }]);
  const args = spec(), result = await poll(f, args);
  assert.match(result.text, /백그라운드 확인에 등록/); assert.equal(f.bg.pending(f.conversation.id), 1);
  const wait = f.bg.list(f.conversation.id)[0], state = f.bg.state.get(wait.id);
  await f.bg.poll(f.conversation.id, wait, state);
  assert.equal(f.bg.pending(f.conversation.id), 1); assert.equal(state.value, 'rendering');
  await f.bg.poll(f.conversation.id, wait, state);
  assert.equal(f.bg.pending(f.conversation.id), 0); assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].note, /status=exported/);
  assert.equal(f.calls.length, 3); assert.ok(f.calls.every(call => call.tool === fq && JSON.stringify(call.args) === JSON.stringify(args.arguments)));
});

test('canonical duplicates register once and perform no duplicate MCP read', async () => {
  const f = fixture(), args = spec(); await poll(f, args);
  const reordered = { arguments: { commandId, editorProjectId: 'edit_neutral' }, operation: 'editor.export_read', project_id: args.arguments.project_id };
  assert.equal(pollKey(fq, args.arguments), pollKey(fq, reordered));
  const result = await poll(f, { ...args, arguments: reordered });
  assert.match(result.text, /이미 백그라운드/); assert.equal(f.calls.length, 1);
  assert.equal(f.bg.pending(f.conversation.id), 1);
  assert.equal(f.bg.add(f.conversation.id, { ...args, arguments: reordered }).duplicate, true);
});

test('only native export read is newly included in operation-aware repeated-status detection', () => {
  for (const tool of [fq, 'bao/production_read', 'production_read']) assert.equal(pollStatusRead(tool, envelope()), true);
  for (const operation of ['editor.export', 'editor.export_queue', 'editor.export_status', 'editor.timeline_read', 'editor.command_status', 'editor.video_frames_read']) assert.equal(pollStatusRead(fq, { operation }), false);
  assert.equal(pollStatusRead('production_prepare', envelope()), false);
});

test('repeated direct production_read export queries hand over to existing background wait', async () => {
  const f = fixture(), args = envelope();
  const read = async (id, value) => {
    const part = { id, name: fq, arguments: JSON.stringify(value) };
    await f.runner.runTool(part, f.ctx, f.run, 'neutral-run', () => {}, []);
    assert.equal(part.isError, false); return part;
  };
  await read('read01', args);
  assert.equal(f.calls.length, 1); assert.equal(f.bg.pending(f.conversation.id), 0);
  const reordered = { operation: args.operation, project_id: args.project_id, arguments: { commandId, editorProjectId: 'edit_neutral' } };
  const second = await read('read02', reordered);
  assert.match(second.result, /백그라운드 확인에 등록/); assert.equal(f.calls.length, 2);
  const third = await read('read03', args);
  assert.match(third.result, /이미 백그라운드/); assert.equal(f.calls.length, 2);
  assert.equal(f.bg.pending(f.conversation.id), 1);
});

test('terminal status and HTTP validation errors keep stopping without retry', async () => {
  for (const status of ['failed', 'error', 'rejected', 'cancelled', 'canceled', 'expired', 'unknown', 'unverified']) assert.equal(pollFailure({ text: JSON.stringify({ status }) }).terminal, true);
  for (const code of [400, 401, 403, 404, 405, 410, 422]) assert.equal(pollFailure({ text: `API ${code} neutral validation error`, isError: true }).terminal, true);
  for (const background of [true, false]) {
    const f = fixture([{ error: 'API 400 neutral invalid fields' }]);
    const result = await poll(f, { ...spec(), background });
    assert.equal(result.isError, true); assert.match(result.text, /폴링 종료/);
    assert.equal(f.calls.length, 1); assert.equal(f.bg.pending(f.conversation.id), 0);
  }
});

test('background transient errors preserve the five-error limit and reset after progress', async () => {
  const f = fixture([new Error('neutral connection reset')]);
  const { wait } = f.bg.add(f.conversation.id, spec()), state = f.bg.state.get(wait.id);
  for (let i = 1; i <= 5; i++) {
    await f.bg.poll(f.conversation.id, wait, state);
    assert.equal(f.bg.pending(f.conversation.id), i < 5 ? 1 : 0);
  }
  assert.equal(f.calls.length, 5); assert.match(f.notes[0].note, /확인할 수 없음/);
  assert.equal(pollFailure({ text: 'neutral temporary connection reset', isError: true }).terminal, false);
  const progressing = fixture([new Error('neutral temporary'), { status: 'rendering' }]);
  const registered = progressing.bg.add(progressing.conversation.id, spec()), progressState = progressing.bg.state.get(registered.wait.id);
  await progressing.bg.poll(progressing.conversation.id, registered.wait, progressState);
  assert.equal(progressState.errorStreak, 1);
  await progressing.bg.poll(progressing.conversation.id, registered.wait, progressState);
  assert.equal(progressState.errorStreak, 0); assert.equal(progressing.bg.pending(progressing.conversation.id), 1);
});

test('write targets remain forbidden and explicit until remains authoritative', () => {
  const f = fixture();
  for (const tool of ['mcp__bao__production_prepare', 'bao/production_execute', 'generate_image']) assert.match(f.runner.pollTarget(tool, {}, f.ctx).error, /반복할 수 없습니다/);
  assert.equal(f.runner.pollCheck('{"status":"exported"}', { until: ['delivered'] }).hit, false);
  assert.equal(f.runner.pollCheck('{"status":"exported"}', {}).hit, true);
});
