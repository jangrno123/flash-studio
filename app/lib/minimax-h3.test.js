'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
// This file runs in an isolated Node test process; no real cloud commands are used.
Object.assign(process.env,{FLASH_H3_GCP_PROJECT:'example-project',FLASH_H3_GCP_ZONE:'us-central1-a',FLASH_H3_GCP_VM:'h3-worker',FLASH_H3_GCP_ACCOUNT:'operator@example.com',FLASH_H3_BAO_ORIGIN:'https://example.com'});
const h3=require('./minimax-h3');const tools=require('./tools');const {SchemaRegistry}=require('./schema');const {Store}=require('./store');
const installed=path.resolve(__dirname,'../../integrations/minimax-h3');
function ready(project='actual-project',queued=0){return {data:{projectId:project,readOnly:true,generationStarted:false,queueModified:false,gcp:{status:'read_verified',configured:true,schemaReady:true,protocol:'bao-gcp-h3-v1',queue:{active:0,queued,recoveryRequired:0}}}};}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flash-h3-test-')),store=new Store(root,new SchemaRegistry(path.resolve(__dirname,'../../schemas')));store.ensure();
  const integration=path.join(root,'integrations','minimax-h3');fs.mkdirSync(integration,{recursive:true});for(const name of Object.keys(h3.HASHES))fs.copyFileSync(path.join(installed,name),path.join(integration,name));
  const pwsh=path.join(root,'pwsh.exe');fs.writeFileSync(pwsh,'fixture only');fs.writeFileSync(path.join(integration,'profile.json'),JSON.stringify({schemaVersion:1,powershell:pwsh}));
  const calls=[];
  const ctx={store,settings:store.getSettings(),mcp:{
    find:(server,name)=>{assert.equal(server,'bao-production');return {fq:name};},
    callTool:async(name,args)=>{
      calls.push({name,args});
      const structuredContent=name==='production_projects'?{projects:[]}:ready(args.project_id);
      return {structuredContent};
    }
  }};
  t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'flash-h3-test-'));fs.rmSync(root,{recursive:true,force:true});});return {ctx,calls,integration};
}
function snapshot(){const service=()=>({queryVerified:true,mainPid:123,environmentSource:'active_process_environment',values:{BAO_PROJECT_ID:'actual-project',H3_MODEL_PROFILE:'int8'},activeValues:{BAO_PROJECT_ID:'actual-project',H3_MODEL_PROFILE:'int8'},nextStartValues:{BAO_PROJECT_ID:'actual-project',H3_MODEL_PROFILE:'int8'},environmentMismatches:[]});return {schema:'h3-grok-readonly/v1',readOnly:true,services:{worker:service(),adapter:service(),comfy:service()},model:{profile:'int8',allowedWorkflows:['fl2va','ref2va'],errors:[],files:[{optional:false,exists:true,bytesMatch:true}]},pendingReceipts:[]};}
const status=(state='RUNNING')=>({ok:true,stdout:`Existing VM: h3-worker / ${state} / us-central1-a\n`,stderr:''});
test('an unconfigured employee install performs no cloud commands, while saved BAO jobs remain readable',async t=>{
  const {ctx}=fixture(t),origin=process.env.FLASH_H3_BAO_ORIGIN;let commands=0;
  try {
    delete process.env.FLASH_H3_BAO_ORIGIN;
    const result=JSON.parse((await h3.execute('minimax_h3_status',{},ctx,{run:async()=>{commands++;return status();}})).text);
    assert.equal(result.errorCode,'H3_NOT_CONFIGURED');assert.equal(result.cloudCommandsExecuted,false);assert.equal(commands,0);
    const jobs=JSON.parse((await h3.execute('minimax_h3_jobs',{project_id:'actual-project',job_ids:['existing-job']},ctx)).text);
    assert.equal(jobs.readOnly,true);assert.equal(jobs.generationSubmitted,false);
  } finally {process.env.FLASH_H3_BAO_ORIGIN=origin;}
});
function mockRun(state,requests){return async(executable,args)=>{requests.push(args);if(args.includes('Read-H3Runtime.ps1')){fs.writeFileSync(args[args.indexOf('-OutFile')+1],JSON.stringify(state));return{ok:true,stdout:'{}',stderr:''};}return status();};}

test('H3 tools are discoverable, narrowly typed and preserve approval semantics',async t=>{
  const {ctx}=fixture(t);for(const name of ['minimax_h3_status','minimax_h3_runtime','minimax_h3_jobs','minimax_h3_power'])assert.ok(tools.definitions(ctx.settings,0).some(d=>d.function.name===name));
  await assert.rejects(h3.execute('minimax_h3_power',{action:'stop',force:true},ctx),/스키마/);
  await assert.rejects(h3.execute('minimax_h3_jobs',{project_id:'x;evil',job_ids:['a']},ctx),/스키마/);
  assert.equal(tools.needsApproval('minimax_h3_power',{tools:{approval:'ask'}},null,{action:'stop'}),true);
  assert.equal(tools.needsApproval('minimax_h3_power',{tools:{approval:'ask'}},null,{action:'plan_stop'}),false);
  assert.equal(h3.billable('minimax_h3_power',{action:'stop'}),false);assert.equal(h3.billable('minimax_h3_power',{action:'start_prepare'}),true);
  assert.deepEqual(h3.argumentsFor('start_prepare'),['-NoProfile','-NonInteractive','-File','gcp-h3-power.ps1','-Action','Start','-PrepareOnly']);
  assert.throws(()=>h3.argumentsFor('raw_command'));
});
test('existing job contracts use FLASH current MCP with unchanged IDs and roles, and remove secrets',async t=>{
  const {ctx,calls}=fixture(t);ctx.mcp.callTool=async(name,args)=>{calls.push({name,args});return{structuredContent:{project_id:args.project_id,jobs:[{id:'existing-job',mediaRoles:['first_frame'],inputFingerprint:'original-hash',duration:5}],leaseToken:'secret',signedDownloadUrl:'secret'}};};
  const result=JSON.parse((await h3.execute('minimax_h3_jobs',{project_id:'actual-project',job_ids:['existing-job']},ctx)).text);
  assert.deepEqual(calls[0].args,{project_id:'actual-project',operation:'read_gcp_h3_job_contract',arguments:{job_ids:['existing-job']},detail:'full'});
  assert.equal(result.generationSubmitted,false);assert.deepEqual(result.contract.jobs[0].mediaRoles,['first_frame']);assert.equal(result.contract.jobs[0].inputFingerprint,'original-hash');assert.equal(JSON.stringify(result).includes('secret'),false);
});
test('pinned helper tampering blocks execution before any management command',async t=>{
  const {ctx,integration}=fixture(t);fs.appendFileSync(path.join(integration,'gcp-h3-power.ps1'),'changed');let called=false;
  await assert.rejects(h3.execute('minimax_h3_status',{},ctx,{run:async()=>{called=true;return status();}}),/PINNED_HELPER_MISMATCH/);assert.equal(called,false);
});
test('runtime mismatch, unreadable active environment, absent weights and pending receipts block startup',()=>{
  assert.equal(h3.runtimeCompatibility(snapshot(),'actual-project').compatible,true);
  for(const mutate of [s=>s.services.worker.nextStartValues.BAO_PROJECT_ID='another',s=>s.services.adapter.environmentSource='active_process_environment_unreadable',s=>s.model.files[0].bytesMatch=false,s=>s.pendingReceipts.push({projectId:'another'}),s=>s.services.comfy.environmentMismatches.push({key:'H3_MODEL_PROFILE'}),s=>s.services.comfy.values.H3_MODEL_PROFILE='ref2va-bf16']){
    const state=snapshot();mutate(state);assert.equal(h3.runtimeCompatibility(state,'actual-project').compatible,false);
  }
});
test('missing/busy BAO queue and unacknowledged boot autostart cannot start a VM',async t=>{
  const {ctx}=fixture(t);let commands=0;const dependencies={run:async()=>{commands++;return status();}};
  await assert.rejects(h3.execute('minimax_h3_power',{action:'start_prepare',project_id:'actual-project'},ctx,dependencies),/BOOT_AUTOSTART_ACKNOWLEDGEMENT_REQUIRED/);
  ctx.mcp.callTool=async()=>({structuredContent:ready('actual-project',1)});
  await assert.rejects(h3.execute('minimax_h3_power',{action:'start_prepare',project_id:'actual-project',acknowledge_boot_autostart:true},ctx,dependencies),/QUEUE_NOT_EMPTY/);
  assert.equal(commands,0);assert.throws(()=>h3.queueFrom({data:{gcp:{queue:{active:0,queued:0}}}}),/QUEUE_UNVERIFIED/);
  assert.throws(()=>h3.queueFrom(ready('other-project'),'actual-project'),/QUEUE_UNVERIFIED/);
});
test('continuous service start validates runtime and fresh empty queue; no render is submitted',async t=>{
  const {ctx,calls}=fixture(t),requests=[];const result=JSON.parse((await h3.execute('minimax_h3_power',{action:'start_services',project_id:'actual-project'},ctx,{run:mockRun(snapshot(),requests)})).text);
  assert.equal(result.ok,true);assert.equal(result.continuousConsumer,true);assert.equal(result.generationSubmitted,false);
  assert.equal(requests.filter(a=>a.includes('Start')).length,1);assert.equal(calls.filter(c=>c.args.operation==='read_minimax_readiness').length,2);
  const state=snapshot();state.services.worker.nextStartValues.BAO_PROJECT_ID='other';const before=requests.length;
  await assert.rejects(h3.execute('minimax_h3_power',{action:'start_services',project_id:'actual-project'},ctx,{run:mockRun(state,requests)}),/RUNTIME_PROJECT_PROFILE_OR_RECEIPTS_MISMATCH/);
  assert.equal(requests.slice(before).some(a=>a.includes('Start')),false);
});
test('stop uses the unmodified guarded helper, verifies TERMINATED and never retries a lost reply',async t=>{
  const {ctx}=fixture(t);let stops=0;const deps={run:async(exe,args)=>{if(args.includes('Stop')){stops++;return {ok:true,stdout:'{"schemaVersion":"h3-power-helper/v1","phase":"confirm_terminated","state":"succeeded","code":"termination_verified","powerState":"TERMINATED"}',stderr:''};}return status('TERMINATED');}};
  const first=JSON.parse((await h3.execute('minimax_h3_power',{action:'stop'},ctx,deps)).text);assert.equal(first.ok,true);assert.equal(first.after.powerState,'TERMINATED');assert.equal(stops,1);
  const lost=JSON.parse((await h3.execute('minimax_h3_power',{action:'stop'},ctx,{run:async()=>{stops++;return {ok:false,stdout:'',stderr:'timeout',code:'ETIMEDOUT'};}})).text);
  assert.equal(lost.ok,false);assert.equal(lost.outcomeUnknown,true);assert.equal(lost.automaticRetry,false);assert.equal(stops,2);
});
test('status separates cloud authentication failure from readable BAO readiness and strips native logs',async t=>{
  const {ctx}=fixture(t);const result=JSON.parse((await h3.execute('minimax_h3_status',{project_id:'actual-project',discover_projects:true},ctx,{run:async()=>({ok:false,stdout:'',stderr:'Reauthentication failed gcloud auth login bearer SECRET',code:1})})).text);
  assert.equal(result.errorCode,'GCLOUD_LOGIN_REQUIRED');assert.equal(result.readOnly,true);assert.equal(result.baoReadiness.data.gcp.queue.queued,0);assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('a deleted fixed VM is reported as NOT_FOUND, not a login error or an invitation to create resources',async t=>{
  const {ctx}=fixture(t);let calls=0;
  const result=JSON.parse((await h3.execute('minimax_h3_status',{},ctx,{run:async()=>{calls++;return {ok:false,stdout:'',stderr:"The resource 'projects/example-project/zones/us-central1-a/instances/h3-worker' was not found",code:1};}})).text);
  assert.equal(result.errorCode,'EXISTING_H3_VM_NOT_FOUND');assert.equal(result.powerState,'NOT_FOUND');assert.equal(result.cloudResourcesCreated,false);assert.equal(calls,1);
});
test('project binding keeps the current profile, checks both queues, and verifies the stored new project',async t=>{
  const {ctx,calls}=fixture(t),state=snapshot(),requests=[];for(const service of Object.values(state.services)){service.mainPid=0;service.activeState='inactive';service.environmentSource='next_start_environment';service.activeValues=null;}
  const run=async(exe,args)=>{
    requests.push(args);
    if(args.includes('Read-H3Runtime.ps1')){fs.writeFileSync(args[args.indexOf('-OutFile')+1],JSON.stringify(state));return{ok:true,stdout:'{}',stderr:''};}
    if(args.includes('Bind-H3Project.ps1')){
      assert.equal(args[args.indexOf('-ExpectedProjectId')+1],'actual-project');
      for(const service of Object.values(state.services)){service.values.BAO_PROJECT_ID='new-project';service.nextStartValues.BAO_PROJECT_ID='new-project';}
      return{ok:true,stdout:JSON.stringify({bound:true,projectId:'new-project',previousProjectId:'actual-project',credentialsAndProfilePreserved:true}),stderr:''};
    }
    return status();
  };
  const result=JSON.parse((await h3.execute('minimax_h3_power',{action:'bind_project',project_id:'new-project',expected_project_id:'actual-project'},ctx,{run})).text);
  assert.equal(result.ok,true);assert.equal(result.binding.credentialsAndProfilePreserved,true);assert.equal(result.generationSubmitted,false);assert.equal(state.model.profile,'int8');
  assert.equal(requests.filter(args=>args.includes('Bind-H3Project.ps1')).length,1);assert.deepEqual(calls.map(call=>call.args.project_id),['new-project','actual-project']);
  assert.equal(h3.mutates('minimax_h3_power',{action:'bind_project'}),true);assert.equal(h3.billable('minimax_h3_power',{action:'bind_project'}),false);
});
test('binding cannot change a project under active services or without the expected old project',async t=>{
  const {ctx}=fixture(t),requests=[];
  await assert.rejects(h3.execute('minimax_h3_power',{action:'bind_project',project_id:'new-project'},ctx,{run:mockRun(snapshot(),requests)}),/VERIFIED_OLD_AND_NEW_PROJECT_REQUIRED/);
  await assert.rejects(h3.execute('minimax_h3_power',{action:'bind_project',project_id:'new-project',expected_project_id:'actual-project'},ctx,{run:mockRun(snapshot(),requests)}),/STOPPED_SERVICES_REQUIRED/);
  assert.equal(requests.some(args=>args.includes('Bind-H3Project.ps1')),false);
});
