const fs=require('fs'),path=require('path'),os=require('os');
const test=require('node:test'),assert=require('node:assert/strict');
const {SchemaRegistry}=require('./schema'); const {Store}=require('./store');
const decisions=require('./decisions'); const {ChatRunner}=require('./chat');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'flash-decisions-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const reg=new SchemaRegistry(path.resolve(__dirname,'../../schemas'));const store=new Store(root,reg);fs.mkdirSync(store.dirs.conversations,{recursive:true});
 const add=(id,from)=>{const c=reg.applyDefaults('conversation.schema.json',{id,title:id,createdAt:'2026-10-02',updatedAt:'2026-10-02',messages:[]});if(from)c.handoff={fromConversationId:from,fromTitle:from,summary:'Previous',createdAt:'2026-10-02'};store.saveConversation(c);return c};
 const c=add('origin01');const runner=new ChatRunner({store,mcp:{},skills:{}});
 const args={question:'Choose paid regeneration or keep?',options:[{label:'Keep',description:'Keep original'},{label:'Paid',description:'Regenerate'}],recommended:0,critical:true,blocked_tasks:['regenerate'],independent_tasks:['read-only inspect next episode']};
 return {root,store,add,c,runner,args};
}
test('critical question returns immediately, durably records memo, no recommendation or approval execution',async t=>{
 const f=fixture(t),part={id:'call0001'},controller=new AbortController(),events=[];
 const ctx={settings:{tools:{askTimeoutSec:600}},meta:{conversationId:f.c.id,messageId:'assistant01'},signal:controller.signal};
 const run={headless:false,approvals:new Map(),allowAll:new Set()};
 await f.runner.askUser(part,f.args,ctx,run,e=>events.push(e),Date.now());
 assert.equal(run.approvals.size,0);assert.equal(part.status,'done');assert.match(part.result,/승인되지/);assert.equal(run.allowAll.size,0);
 const data=decisions.load(f.store);assert.equal(data.items.length,1);assert.equal(data.items[0].status,'pending');assert.deepEqual(data.items[0].blockedTasks,['regenerate']);
 const store2=new Store(f.root,f.store.reg);assert.equal(decisions.load(store2).items[0].callId,'call0001');
 await f.runner.askUser(part,f.args,ctx,run,()=>{},Date.now());assert.equal(decisions.load(f.store).items.length,1);
});
test('headless question also records and continues independent work',async t=>{
 const f=fixture(t),p={id:'call0002'};
 await f.runner.askUser(p,f.args,{settings:{tools:{}},meta:{conversationId:f.c.id,messageId:'assistant02'},signal:new AbortController().signal},{headless:true},()=>{},Date.now());
 assert.match(p.result,/병렬/);assert.equal(decisions.load(f.store).items.length,1);
});
test('answers persist through handoff, scoped to ancestry, empty answer cannot approve',t=>{
 const f=fixture(t),d=decisions.record(f.store,{conversationId:f.c.id,messageId:'asst0001',callId:'call0001'},f.args),child=f.add('child001',f.c.id),other=f.add('other001');
 assert.match(decisions.context(f.store,child),/regenerate/);assert.doesNotMatch(decisions.context(f.store,other),/Choose paid/);
 assert.throws(()=>decisions.answer(f.store,d.id,{}),/무응답/);assert.equal(decisions.load(f.store).items[0].status,'pending');
 const result=f.runner.answerDecision(d.id,{choice:0});assert.equal(result.status,'answered');assert.equal(result.answer,'Keep');assert.match(decisions.context(f.store,child),/"answer":"Keep"/);
 assert.equal(decisions.answer(f.store,d.id,{choice:0}).id,d.id);assert.throws(()=>decisions.answer(f.store,d.id,{choice:1}),/이미 답변/);
 assert.equal(f.c.messages.length,0);
});
test('late answer steers only related active run, preserves approval set',t=>{
 const f=fixture(t),d=decisions.record(f.store,{conversationId:f.c.id,messageId:'asst0001',callId:'call0001'},f.args),child=f.add('child001',f.c.id),other=f.add('other001');
 const run=id=>({convId:id,steer:[],controller:new AbortController(),allowAll:new Set(['existing'])});
 const a=run(child.id),b=run(other.id);f.runner.runs.set('run0001',a);f.runner.runs.set('run0002',b);
 f.runner.answerDecision(d.id,{text:'Keep the original'});assert.equal(a.steer.length,1);assert.equal(b.steer.length,0);assert.deepEqual([...a.allowAll],['existing']);
});
test('secret redaction and corruption never silently erase pending memo',t=>{
 const f=fixture(t),args={...f.args,question:'token=abcdefghijklmnopqrstuv'};const d=decisions.record(f.store,{conversationId:f.c.id,messageId:'asst0001',callId:'call0001'},args);
 assert.doesNotMatch(d.question,/abcdefghijkl/);fs.writeFileSync(path.join(f.store.data,'decisions.json'),'broken');assert.throws(()=>decisions.load(f.store));
});
const {EventEmitter}=require('events');const llm=require('./llm');
test('real chat tool loop continues independent work after unanswered important question',async t=>{
 const f=fixture(t);const settings=f.store.reg.applyDefaults('settings.schema.json',{activeProviderId:'fixture',activeModel:'fixture',providers:[],systemPrompt:'Keep all original instructions'});settings.generation.autoTitle=false;
 const provider={id:'fixture',models:[{id:'fixture',tools:true,contextWindow:1048576}]};f.store.settings=settings;f.store.getProvider=()=>provider;
 f.runner.systemPrompt=c=>decisions.context(f.store,c);f.runner.overheadTokens=()=>0;f.runner.allToolDefs=()=>[];f.runner.buildHistory=async()=>[];
 const stream=llm.streamChat;let calls=0,independent=false;
 llm.streamChat=async args=>{calls++;if(calls===1)return {toolCalls:[{id:'askloop01',name:'ask_user',arguments:JSON.stringify(f.args)},{id:'readonly01',name:'fixture_read',arguments:'{}'}]};assert.equal(independent,true);args.onText('Read-only work complete; paid regeneration awaiting answer');return {toolCalls:[]};};
 const realRun=f.runner.runTool.bind(f.runner);f.runner.runTool=async(p,...rest)=>{if(p.name==='fixture_read'){independent=true;p.status='done';p.result='Read-only result';return;}return realRun(p,...rest);};
 const res=new EventEmitter(),events=[];Object.assign(res,{writableEnded:false,writableFinished:false,writeHead(){},write(s){if(s.startsWith('data: '))events.push(JSON.parse(s.slice(6)));},end(){this.writableEnded=this.writableFinished=true;}});
 try{await f.runner.handle({},res,{conversationId:f.c.id,content:'Do independent work while I am away'});assert.equal(calls,2);assert.equal(decisions.load(f.store).items[0].status,'pending');assert.equal(f.runner.activeCount(),0);assert.match(f.store.getConversation(f.c.id).messages.at(-1).content,/awaiting answer/);}finally{llm.streamChat=stream;}
});
