'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { ChatRunner } = require('./chat');
const { SchemaRegistry } = require('./schema');
const llm = require('./llm');
const context = require('./context');
const { lineage, sourceRecords, transcriptChunks, redact, validateSummary, SECTIONS, sourceSnapshots, incrementalSources } = require('./handoff');
const reg = new SchemaRegistry(path.resolve(__dirname, '../../schemas'));
const valid = SECTIONS.map(s => `## ${s}\n확인된 원문 근거/미완료 구분`).join('\n');

function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-handoff-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const cs = new Map(); let creates = 0;
  const settings = reg.applyDefaults('settings.schema.json', { activeProviderId: 'fixture', activeModel: 'fixture-model', systemPrompt: 'Keep instructions', providers: [] });
  settings.generation.autoTitle = false;
  const provider = { id: 'fixture', models: [{ id: 'fixture-model', tools: false, contextWindow: 1048576 }] };
  const store = { data, reg, dirs: { workspace: data }, getSettings: () => settings, getProvider: () => provider, getProject: () => null,
    getConversation: id => { if (!cs.has(id)) throw Error('missing conversation'); return cs.get(id); },
    saveConversation: c => { reg.assert('conversation.schema.json', c); cs.set(c.id, c); },
    createConversation: args => { creates++; const c = reg.applyDefaults('conversation.schema.json', { id: `next000${creates}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [], ...args }); cs.set(c.id, c); return c; }
  };
  const add = (id, from = null) => { const c = reg.applyDefaults('conversation.schema.json', { id, title: id, createdAt: '2026-10-02', updatedAt: '2026-10-02', messages: [{ id: 'user0001', role: 'user', createdAt: '2026-10-02', content: `${id} user instruction` }], providerId: provider.id, model: 'fixture-model', systemPrompt: 'Keep original', skills: ['skill-fixture'] }); if (from) c.handoff = { fromConversationId: from, fromTitle: from, summary: 'old incomplete summary', createdAt: '2026-10-02', depth: 1 }; cs.set(id, c); return c; };
  const runner = new ChatRunner({ store, mcp: {}, skills: {} });
  runner.systemPrompt = () => 'Fixture instructions'; runner.overheadTokens = () => 0; runner.allToolDefs = () => [];
  return { runner, store, cs, add, settings, data, creates: () => creates };
}

test('archive counts original tool text once, independent of billing and compaction', () => {
  const c = { compaction: { tokensBefore: 9000000 }, messages: [{ role: 'user', content: 'abcdef' }, { role: 'assistant', content: 'ghijkl', usage: { prompt_tokens: 9000000 }, parts: [{ type: 'text', text: 'ghijkl' }, { type: 'tool_call', arguments: '{}', result: '1234' }] }] };
  assert.equal(context.archiveTokens(c), 6);
  c.messages.push({ role: 'assistant', parts: [{ type: 'tool_call', arguments: JSON.stringify({ base64: 'A'.repeat(9000) }), result: '' }] });
  assert.ok(context.archiveTokens(c) < 20);
});

test('all ancestor conversations including old EP work are searchable; unrelated project is excluded', t => {
  const f = fixture(t); const a = f.add('source01'), b = f.add('source02', a.id), c = f.add('source03', b.id);
  a.messages[0].content = 'EP02~06 재작성 원통 시트 720p';
  f.add('unrelated').messages[0].content = 'SECRET OTHER PROJECT';
  assert.equal(lineage(f.store, c.id).length, 3);
  assert.match(f.runner.searchPrevious(c.id, 'EP02~06', 8), /source01/);
  assert.equal(JSON.parse(f.runner.readPrevious(c.id, {})).sources.length, 3);
  assert.throws(() => f.runner.readPrevious(c.id, { conversation_id: 'unrelated', index: 0 }), /선행 대화/);
});

test('long user corrections are chunked without losing their tail; exact original is paged', t => {
  const f = fixture(t), a = f.add('source01');
  a.messages[0].content = 'START ' + 'x'.repeat(60000) + ' KEEP-TAIL-15S-720P';
  a.messages.push({ id: 'assist01', role: 'assistant', parts: [{ type: 'steer', text: '기존 버전 삭제 금지' }] });
  const chunks = transcriptChunks([a], 10000);
  assert.ok(chunks.length >= 6); assert.ok(chunks.every(c => c.length <= 10000));
  assert.match(chunks.join(''), /KEEP-TAIL-15S-720P/); assert.match(chunks.join(''), /삭제 금지/);
  let offset = 0, text = '';
  do { const page = JSON.parse(f.runner.readPrevious(a.id, { conversation_id: a.id, index: 0, offset, max_chars: 10000 })); text += page.text; offset = page.nextOffset; } while (offset !== null);
  assert.match(text, /KEEP-TAIL-15S-720P/);
  assert.equal(sourceRecords([a]).filter(r => r.type === 'user' || r.type === 'steer').length, 2);
});

test('handoff model sees originals hidden by earlier compaction and older handoffs', async t => {
  const f = fixture(t), a = f.add('source01'), b = f.add('source02', a.id);
  a.messages[0].content = 'EP02~06 pending; do not render';
  b.messages[0].content = 'Latest: use 3000000; retain original assets';
  b.compaction = { summary: 'Forgot EP work', upToMessageId: b.messages[0].id, summarizedCount: 1, createdAt: '2026-10-02' };
  const complete = llm.complete; const inputs = [];
  llm.complete = async args => { inputs.push(args.messages[1].content); return valid; };
  try { const draft = await f.runner.handoffDraft(b.id); assert.match(inputs.join(''), /EP02~06 pending/); assert.match(inputs.join(''), /Latest: use 3000000/); assert.match(draft.summary, /원문 보존과 복구/); }
  finally { llm.complete = complete; }
});

test('missing handoff sections and cyclic lineage fail without silently dropping work', t => {
  assert.throws(() => validateSummary('Everything completed'), /누락/);
  assert.throws(() => validateSummary(valid + 'x'.repeat(70000)), /저장 범위/);
  const f = fixture(t), a = f.add('source01', 'source02'); f.add('source02', a.id);
  assert.throws(() => lineage(f.store, a.id), /순환/);
});

test('handoff source ledger retains directives and original settings, and duplicate creation reuses same room', t => {
  const f = fixture(t), a = f.add('source01'); a.projectId = 'project01'; a.queueJobId = 'job00001';
  const original = JSON.stringify(a.messages);
  const next = f.runner.createHandoff(a.id, { summary: valid, files: [{ label: 'image', ref: 'assets/original.png' }] });
  assert.equal(next.projectId, a.projectId); assert.equal(next.model, a.model); assert.deepEqual(next.skills, a.skills); assert.equal(next.systemPrompt, a.systemPrompt); assert.equal(next.queueJobId, a.queueJobId);
  const packet = JSON.parse(fs.readFileSync(path.join(f.data, 'handoffs', `${a.id}-sources.json`)));
  assert.equal(packet.records[0].text, a.messages[0].content); assert.equal(JSON.stringify(a.messages), original);
  assert.equal(next.handoff.resumeState, 'pending');
  assert.equal(f.runner.createHandoff(a.id, { summary: valid }).id, next.id); assert.equal(f.creates(), 1);
});

test('secret values are removed from handoff and source retrieval, original remains intact', t => {
  const f = fixture(t), a = f.add('source01');
  const secret = 'sk-' + 'A'.repeat(40); a.messages[0].content = `API key ${secret} keep 720p`;
  assert.ok(!redact(a.messages[0].content).includes(secret));
  const out = f.runner.readPrevious(a.id, { conversation_id: a.id, index: 0 }); assert.ok(!out.includes(secret)); assert.ok(a.messages[0].content.includes(secret));
});

test('automatic continuation claims the pending room once and preserves request approval scope', async t => {
  const f = fixture(t), a = f.add('source01'); const next = f.runner.createHandoff(a.id, { summary: valid }); let calls = 0;
  f.runner.handle = async (req, res, body) => { calls++; assert.equal(req._handoffContinuation, true); assert.deepEqual(req._handoffAllowAll, ['approved-tool']); assert.match(body.content, /유료 승인·범위는 확대하지/); assert.equal(body.conversationId, next.id); next.messages.push({ id: 'assist01', role: 'assistant', createdAt: '2026-10-02', status: 'complete' }); };
  assert.equal(await f.runner.resumeHandoff({}, {}, next, {}, new Set(['approved-tool'])), true);
  assert.equal(await f.runner.resumeHandoff({}, {}, next, {}), false); assert.equal(calls, 1); assert.equal(next.handoff.resumeState, 'done');
});

test('real chat stream moves to the new room and runs its continuation without another user message', async t => {
  const f = fixture(t), a = f.add('source01');
  const archive = context.archiveTokens, stream = llm.streamChat;
  context.archiveTokens = c => c.id === a.id && c.messages.length >= 3 ? 3000000 : 100;
  f.runner.handoffDraft = async () => ({ summary: valid, files: [] });
  f.runner.buildHistory = async c => c.messages.filter(m => m.role === 'user').map(m => ({ role: 'user', content: m.content }));
  let modelCalls = 0;
  llm.streamChat = async args => { modelCalls++; args.onText('Resumed exact pending work'); return { toolCalls: [], usage: { prompt_tokens: 4000, completion_tokens: 20 } }; };
  const events = [], res = new EventEmitter(); let headers = 0;
  Object.assign(res, { writableEnded: false, writableFinished: false, writeHead: () => { headers++; }, write: text => { if (text.startsWith('data: ')) events.push(JSON.parse(text.slice(6))); }, end: () => { res.writableEnded = true; res.writableFinished = true; } });
  try {
    await f.runner.handle({}, res, { conversationId: a.id, content: 'Continue' });
    assert.equal(headers, 1); assert.equal(modelCalls, 1); assert.ok(events.some(e => e.type === 'handoff'));
    const starts = events.filter(e => e.type === 'start'); assert.equal(starts.length, 2);
    const next = f.store.getConversation(a.handedOffTo); assert.match(next.messages.at(-1).content, /Resumed exact/); assert.equal(next.handoff.resumeState, 'done'); assert.equal(f.runner.activeCount(), 0);
  } finally { context.archiveTokens = archive; llm.streamChat = stream; }
});

test('client switches its visible room and renders resumed messages without duplicating the old user message', () => {
  const code = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8').replace(/init\(\);\s*$/, '');
  const sandbox = { console, URL, Map, Set, document: {}, window: {}, location: { hash: '#/c/source01' }, history: { replaceState() {} } };
  vm.createContext(sandbox); vm.runInContext(code, sandbox);
  const out = vm.runInContext(`
    toast = () => {}; refreshConvs = () => {}; renderMain = () => {};
    const oldUser = {id:'user0001',role:'user',content:'Old work'};
    const oldAssistant = {id:'assist01',role:'assistant',parts:[]};
    const oldRoom = {id:'source01',messages:[oldUser,oldAssistant]};
    S.conv = oldRoom; S.run={convId:oldRoom.id,done:true,msg:oldAssistant};
    onEvent({type:'handoff',conversation:{id:'next0001',messages:[],handoff:{summary:'Keep work'}}},oldRoom,oldUser);
    onEvent({type:'start',runId:'resume01',userMessage:{id:'user0002',role:'user',content:'Resume'},assistantMessage:{id:'assist02',role:'assistant',parts:[]}},oldRoom,oldUser);
    JSON.stringify({room:S.conv.id,route:S.route.id,busy:busy(),ids:S.conv.messages.map(m=>m.id)});
  `, sandbox);
  assert.deepEqual(JSON.parse(out), { room: 'next0001', route: 'next0001', busy: true, ids: ['user0002', 'assist02'] });
});

test('incremental handoff pointers retain original indices and edited summaries invalidate snapshot coverage', t => {
  const f=fixture(t), a=f.add('source01');
  const next=f.runner.createHandoff(a.id,{summary:valid,files:[],sourceSnapshots:sourceSnapshots([a])});
  a.messages.push({id:'later0001',role:'user',createdAt:'2026-10-06',content:'NEUTRAL_LATER_CORRECTION'});
  const incremental=incrementalSources([a],next.handoff);
  assert.equal(incremental[0].messages.length,1);
  assert.match(transcriptChunks(incremental).join(''), /later0001 \(#1\)/);
  next.handoff.summary += '\nUnverified direct edit.';
  assert.equal(incrementalSources([a],next.handoff)[0].messages.length,2);
  f.runner.updateHandoff(next.id,valid+'\nManual update.');
  assert.equal(next.handoff.sourceSnapshots,undefined);
  assert.equal(next.handoff.sourceSummaryHash,undefined);
});

test('client auto recovers pending and legacy rollover once while preserving unsent draft and skipping queue/stopped rooms', async()=>{
  const code=fs.readFileSync(path.resolve(__dirname,'../public/app.js'),'utf8').replace(/init\(\);\s*$/,'');
  const sandbox={console,URL,Map,Set,document:{},window:{},location:{hash:'#/c/source01'},history:{replaceState(){}}};
  vm.createContext(sandbox); vm.runInContext(code,sandbox);
  const out=await vm.runInContext(`(async()=>{
    const conv={id:'source01',messages:[{role:'assistant',status:'complete',stopReason:'context_handoff'}]};
    S.conv=conv;S.settings={generation:{autoHandoff:true}};S.opts={tools:false,thinking:true};
    S.draft={text:'NEUTRAL_UNSENT_DRAFT',attachments:[{id:'file01'}],skills:['neutral-skill']};
    let calls=0,seen;runStream=async(body,room,optimistic,draft,endpoint)=>{calls++;seen={body,endpoint};};
    const eligible=needsHandoffResume(conv);
    await resumePendingHandoff(conv); await resumePendingHandoff(conv);
    return JSON.stringify({eligible,calls,seen,draft:S.draft,queue:needsHandoffResume({...conv,queueJobId:'job001'}),stopped:needsHandoffResume({...conv,messages:[{role:'assistant',status:'stopped',stopReason:'context_handoff'}]}),disabled:needsHandoffResume({...conv,handedOffTo:'next001'})});
  })()`,sandbox);
  const j=JSON.parse(out);assert.equal(j.eligible,true);assert.equal(j.calls,1);
  assert.equal(j.seen.body.options.tools,false);assert.equal(j.seen.body.options.thinking,true);
  assert.equal(j.seen.endpoint,'/api/conversations/source01/handoff/resume');
  assert.equal(j.draft.text,'NEUTRAL_UNSENT_DRAFT');assert.equal(j.draft.attachments.length,1);assert.equal(j.draft.skills.length,1);
  assert.equal(j.queue,false);assert.equal(j.stopped,false);assert.equal(j.disabled,false);
});
