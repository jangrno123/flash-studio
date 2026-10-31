'use strict';
// Existing A100 worker management. No arbitrary command, cloud target or render submission.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile,execFileSync} = require('node:child_process');
// Operator configuration is fixed when the app starts; model arguments cannot change it.
const TARGET = Object.freeze({project:process.env.FLASH_H3_GCP_PROJECT||'',zone:process.env.FLASH_H3_GCP_ZONE||'',vm:process.env.FLASH_H3_GCP_VM||'',account:process.env.FLASH_H3_GCP_ACCOUNT||''});
function configured() {
  if(!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(TARGET.project)||!/^[a-z]+-[a-z0-9]+[0-9]-[a-z]$/.test(TARGET.zone)||!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(TARGET.vm)||!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(TARGET.account))return false;
  try{const u=new URL(process.env.FLASH_H3_BAO_ORIGIN);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/';}catch{return false;}
}
const PROJECT = /^[A-Za-z0-9_-]{1,100}$/;
const HASHES = Object.freeze({
  "gcp-h3-power.ps1": "78bfd7d69ed17d825e8491dc5775c48624419c30a75d2059fad116f48decdd84",
  "Read-H3Runtime.ps1": "50b0137ca6ce60978decc90c66424dc1b0961975db56b2474d6370268718a45f",
  "inspect_h3_readonly.py": "f8791d2dd2ca1920c3ca1f7fe2f73cd63a81b973087602e255b68deda951f111",
  "Bind-H3Project.ps1": "6096d6e8825d1acf87a8d7def6f8a41c40f83590d3ae50531553b6a92c4e599c",
  "Target.ps1": "dd3fc4c13129ba5bbd9c44871a2f6e50cbcd6315b6584c3709a3cc1d115602d1"
});
const fn=(name,description,properties,required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const project_id={type:'string',pattern:PROJECT.source,description:'현재 FLASH BAO 연결에서 확인한 제작 프로젝트 ID. GCP 프로젝트와 별개.'};
const jobs={type:'array',maxItems:20,uniqueItems:true,items:{type:'string',pattern:PROJECT.source}};
function definitions(settings) {
  if(process.platform!=='win32'||!settings.tools.enableWorkspace)return [];
  return [
    fn('minimax_h3_status','기존 GCP 단일 A100 80GB MiniMax H3 VM과 FLASH의 BAO 연결을 읽기 전용 조회한다. discover_projects=true로 현재 연결 프로젝트를 찾는다. VM·서비스·생성을 시작하지 않는다.',{project_id,discover_projects:{type:'boolean'}}),
    fn('minimax_h3_runtime','RUNNING 상태의 기존 H3 서비스 적용값/다음 기동값, 프로젝트·프로필·지원 workflow·모델 파일과 미완료 영수증을 읽는다. plan_only=true는 원격 호출도 하지 않는다. 파일 확인은 추론 성공 증거가 아니다.',{project_id,plan_only:{type:'boolean'},hash_models:{type:'boolean'}}),
    fn('minimax_h3_jobs','FLASH의 현재 BAO 연결로 기존 MiniMax 작업의 저장된 프롬프트·참조 역할·설정·fingerprint 계약을 읽는다. 새 제출·provider polling·재생성 없음.',{project_id,job_ids:{...jobs,minItems:1}},['project_id','job_ids']),
    fn('minimax_h3_power','고정 기존 VM만 관리한다. plan_start/plan_stop은 오프라인 계획. start_prepare는 과금 VM 기동(부팅 자동 서비스는 실행될 수 있음). start_services는 빈 큐·일치한 런타임 확인 후 연속 worker 시작. stop은 기존 idle/DB/GPU 보호 절차로 종료 후 TERMINATED 확인. 새 VM·강제종료·렌더 제출 없음.',{
      action:{type:'string',enum:['plan_start','start_prepare','bind_project','start_services','plan_stop','stop']},project_id,
      expected_project_id:{...project_id,description:'bind_project에 필수. 방금 runtime에서 확인한 기존 프로젝트. 서비스/포트/GPU/DB/영수증 idle 및 두 프로젝트 빈 큐 확인 후 프로젝트 키만 바꾸며 인증·프로필을 보존한다.'},
      acknowledge_boot_autostart:{type:'boolean',description:'start_prepare에 필수. 기존 부팅 자동 서비스/대기 작업이 재개될 수 있음을 작업 범위에서 확인.'}
    },['action'])
  ];
}
function fail(code) { return Object.assign(new Error(code),{code}); }
function installation(ctx) {
  if(!configured())throw fail('H3_NOT_CONFIGURED');
  const root=path.join(ctx.store.root,'integrations','minimax-h3');
  for(const [name,expected] of Object.entries(HASHES)) {
    const file=path.join(root,name);
    if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==expected)throw fail('PINNED_HELPER_MISMATCH');
  }
  const profileFile=path.join(root,'profile.json');
  const profile=fs.existsSync(profileFile)?JSON.parse(fs.readFileSync(profileFile,'utf8')):{schemaVersion:1,powershell:process.env.FLASH_H3_POWERSHELL||''};
  if(!profile.powershell)try{profile.powershell=execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','where.exe'),['pwsh.exe'],{encoding:'utf8',windowsHide:true,timeout:5000}).trim().split(/\r?\n/)[0];}catch{}
  if(profile.schemaVersion!==1||!path.isAbsolute(profile.powershell)||!/^pwsh\.exe$/i.test(path.basename(profile.powershell))||!fs.statSync(profile.powershell).isFile())throw fail('POWERSHELL7_UNAVAILABLE');
  const output=path.join(ctx.store.data,'minimax-h3');
  fs.mkdirSync(output,{recursive:true});
  if(fs.realpathSync(output).toLowerCase()!==path.resolve(output).toLowerCase())throw fail('RECEIPT_DIRECTORY_INVALID');
  return {root,output,powershell:profile.powershell};
}
function argumentsFor(action) {
  const table={plan_start:['Start','-DryRun','-PrepareOnly'],start_prepare:['Start','-PrepareOnly'],start_services:['Start'],plan_stop:['Stop','-DryRun'],stop:['Stop'],status:['Status']};
  const args=table[action];if(!args)throw fail('INVALID_ACTION');
  return ['-NoProfile','-NonInteractive','-File','gcp-h3-power.ps1','-Action',...args];
}
function nativeRun(executable,args,options={}) {
  return new Promise(resolve=>execFile(executable,args,{cwd:options.cwd,windowsHide:true,shell:false,encoding:'utf8',maxBuffer:1024*1024,timeout:310000,
    env:{...process.env,CLOUDSDK_CORE_DISABLE_PROMPTS:'1',CLOUDSDK_CORE_ACCOUNT:TARGET.account,PYTHONIOENCODING:'utf-8'},signal:options.signal},
    (error,stdout,stderr)=>resolve({ok:!error,stdout:stdout||'',stderr:stderr||'',code:error?.code??0})));
}
function jsonLines(text) { return String(text).split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}); }
function errorCode(result) {
  const text=result.stdout+'\n'+result.stderr;
  if(text.includes(TARGET.vm)&&/(?:was not found|NOT_FOUND)/i.test(text))return 'EXISTING_H3_VM_NOT_FOUND';
  if(/VM is not RUNNING/i.test(text))return 'VM_NOT_RUNNING';
  if(/reauth|auth tokens|gcloud auth login|invalid.grant|authentication_failed/i.test(text))return 'GCLOUD_LOGIN_REQUIRED';
  if(/permission.denied|not.authorized|forbidden/i.test(text))return 'GCLOUD_PERMISSION_DENIED';
  if(/idle_handshake|job_running_or_queued|stopped_idle_unverified|shutdown_unverified/i.test(text))return 'IDLE_PROOF_NOT_CONFIRMED';
  if(result.code==='ABORT_ERR'||result.code==='ETIMEDOUT'||result.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return 'MANAGEMENT_OUTCOME_UNKNOWN';
  return 'MANAGEMENT_FAILED';
}
function powerResult(action,result) {
  const match=result.stdout.match(/Existing VM:\s*([a-z0-9-]+)\s*\/\s*([A-Z_]+)\s*\/\s*([a-z0-9-]+)/);
  const vm=match&&match[1]===TARGET.vm&&match[3]===TARGET.zone?match:null;
  const events=jsonLines(result.stdout).filter(item=>item.schemaVersion==='h3-power-helper/v1').map(item=>Object.fromEntries(['phase','state','code','powerState','exitCode'].map(key=>[key,item[key]])));
  const terminated=events.some(e=>e.powerState==='TERMINATED'&&['termination_verified','already_terminated'].includes(e.code));
  // Never retain raw native stderr, service logs, auth URLs or arbitrary remote output.
  const serviceState=jsonLines(result.stdout).findLast(item=>item.services&&item.health);
  const resultObject={action,target:TARGET,ok:result.ok,powerState:terminated?'TERMINATED':vm?.[2]||'UNKNOWN',events,
    generationSubmitted:false,cloudResourcesCreated:false,automaticRetry:false};
  if(serviceState)resultObject.worker=scrub(serviceState);
  if(action==='status'&&resultObject.powerState==='UNKNOWN')resultObject.ok=false;
  if(action.startsWith('plan_')) {
    let plan;try{plan=JSON.parse(result.stdout);}catch{}
    resultObject.ok=result.ok&&plan?.dryRun===true&&plan.cloudCommandsExecuted===false;
    resultObject.plan=plan?Object.fromEntries(['dryRun','action','prepareOnly','project','zone','existingVm','createsVmOrNetwork','startsLocalBao','submitsNewRender','stopRequiresIdleHandshake','cloudCommandsExecuted'].map(key=>[key,plan[key]])):null;
  }
  if(!resultObject.ok)resultObject.errorCode=errorCode(result);
  if(resultObject.errorCode==='EXISTING_H3_VM_NOT_FOUND')resultObject.powerState='NOT_FOUND';
  if(!result.ok&&!['status','plan_start','plan_stop'].includes(action))resultObject.outcomeUnknown=true;
  if(action==='start_prepare')resultObject.bootAutostartMayConsumeExistingQueue=true;
  if(action==='start_services')resultObject.continuousConsumer=true;
  return resultObject;
}
function runtimeCompatibility(snapshot,project,origin) {
  const errors=[];
  if(snapshot?.schema!=='h3-grok-readonly/v1'||snapshot.readOnly!==true)return {compatible:false,errors:['RUNTIME_SCHEMA_UNVERIFIED']};
  for(const key of ['worker','adapter','comfy']) {
    const service=snapshot.services?.[key];
    if(service?.queryVerified!==true)errors.push(key+':SERVICE_QUERY_UNVERIFIED');
    if(service?.mainPid>0&&service.environmentSource!=='active_process_environment')errors.push(key+':ACTIVE_ENV_UNREADABLE');
    if((service?.environmentMismatches||[]).length)errors.push(key+':ACTIVE_NEXT_ENV_MISMATCH');
    if(project&&[service?.values?.BAO_PROJECT_ID,service?.nextStartValues?.BAO_PROJECT_ID].some(value=>value!==project))errors.push(key+':PROJECT_MISMATCH');
    if(origin&&[service?.values?.BAO_SITE_ORIGIN,service?.nextStartValues?.BAO_SITE_ORIGIN].some(value=>value!==origin))errors.push(key+':BAO_ORIGIN_MISMATCH');
  }
  if(!['int8','ref2va-bf16','ref2va-int8'].includes(snapshot.model?.profile)||(snapshot.model?.errors||[]).length)errors.push('MODEL_PROFILE_UNVERIFIED');
  const profiles=['worker','adapter','comfy'].map(key=>snapshot.services?.[key]?.values?.H3_MODEL_PROFILE||'int8');
  if(profiles.some(profile=>profile!==snapshot.model?.profile))errors.push('SERVICE_PROFILE_MISMATCH');
  const required=(snapshot.model?.files||[]).filter(file=>!file.optional);
  if(!required.length||required.some(file=>!file.exists||!file.bytesMatch||file.shaChecked&&!file.shaVerified))errors.push('REQUIRED_MODEL_FILES_UNVERIFIED');
  if(!Array.isArray(snapshot.model?.allowedWorkflows)||!snapshot.model.allowedWorkflows.length)errors.push('SUPPORTED_WORKFLOW_UNVERIFIED');
  if(!Array.isArray(snapshot.pendingReceipts)||snapshot.pendingReceipts.length)errors.push('PENDING_RECEIPTS_REQUIRE_REVIEW');
  return {compatible:errors.length===0,errors,modelLoaded:'not_proven_by_inventory',inferenceVerified:'not_proven_by_inventory'};
}
function unpack(result) {
  if(result?.isError)throw fail('BAO_READ_FAILED');
  if(result?.structuredContent)return result.structuredContent;
  const text=(result?.content||[]).filter(item=>item.type==='text').map(item=>item.text).join('\n');
  try{return JSON.parse(text);}catch{throw fail('BAO_RESPONSE_UNVERIFIED');}
}
async function bao(ctx,name,args) {
  const hit=ctx.mcp?.find('bao-production',name);
  if(!hit)throw fail('FLASH_BAO_CONNECTION_UNAVAILABLE');
  return unpack(await ctx.mcp.callTool(hit.fq,args,45000));
}
function scrub(value) {
  if(Array.isArray(value))return value.map(scrub);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/token|cookie|secret|authorization|password|api.?key|(?:signed|private|download|upload).*url/i.test(key)).map(([key,item])=>[key,scrub(item)]));
  if(typeof value==='string'&&/^https?:\/\//i.test(value)){try{const url=new URL(value);return url.origin+url.pathname;}catch{return '[URL omitted]';}}
  return value;
}
async function readiness(ctx,project) {
  return bao(ctx,'production_read',{project_id:project,operation:'read_minimax_readiness',arguments:{},detail:'full'});
}
function queueFrom(result,project) {
  const data=result?.data||result;
  if(data.readOnly!==true||data.generationStarted!==false||data.queueModified!==false||project&&data.projectId!==project)throw fail('BAO_QUEUE_UNVERIFIED');
  const gcp=data.gcp;
  if(gcp?.status!=='read_verified'||gcp.configured!==true||gcp.schemaReady!==true||gcp.protocol!=='bao-gcp-h3-v1')throw fail('BAO_QUEUE_UNVERIFIED');
  const queue=gcp?.queue;
  if(!queue||!['active','queued','recoveryRequired'].every(key=>Number.isSafeInteger(queue[key])&&queue[key]>=0))throw fail('BAO_QUEUE_UNVERIFIED');
  if(queue.active||queue.queued||queue.recoveryRequired)throw fail('QUEUE_NOT_EMPTY_REVIEW_EXISTING_JOBS');
  return queue;
}
function receipt(file,data) { fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600}); }
async function cloudStatus(ctx,profile,run) {return powerResult('status',await run(profile.powershell,argumentsFor('status'),{cwd:profile.root,signal:ctx.signal}));}
async function runtime(ctx,profile,args,run) {
  const file=path.join(profile.output,'runtime-'+crypto.randomBytes(12).toString('hex')+'.json');
  const command=['-NoProfile','-NonInteractive','-File','Read-H3Runtime.ps1',...(args.plan_only?['-PlanOnly']:['-OutFile',file]),...(args.hash_models?['-HashModels']:[])];
  const result=await run(profile.powershell,command,{cwd:profile.root,signal:ctx.signal});
  if(!result.ok)return {ok:false,readOnly:true,errorCode:errorCode(result),startsVm:false};
  if(args.plan_only) {let plan;try{plan=JSON.parse(result.stdout);}catch{}return {ok:plan?.readOnly===true&&plan.startsVm===false,plan};}
  if(!fs.existsSync(file))throw fail('RUNTIME_SNAPSHOT_MISSING');
  const snapshot=JSON.parse(fs.readFileSync(file,'utf8'));
  let origin;
  try{origin=new URL(ctx.mcp?.find('bao-production','production_read')?.cfg?.url).origin;}catch{}
  return {ok:true,readOnly:true,snapshotPath:file,snapshot,validation:runtimeCompatibility(snapshot,args.project_id,origin),generationSubmitted:false};
}
const busy=new Set();
async function execute(name,args,ctx,dependencies={}) {
  ctx.store.reg.assert('minimax-h3.schema.json#/$defs/'+name,args);
  if(name==='minimax_h3_jobs')return {text:JSON.stringify({readOnly:true,generationSubmitted:false,source:'FLASH current bao-production MCP',contract:scrub(await bao(ctx,'production_read',{project_id:args.project_id,operation:'read_gcp_h3_job_contract',arguments:{job_ids:args.job_ids},detail:'full'}))})};
  if(!configured())return {text:JSON.stringify({ok:false,errorCode:'H3_NOT_CONFIGURED',setupGuide:'docs/MEDIA_SETUP.md',cloudCommandsExecuted:false,generationSubmitted:false}),isError:true};
  const profile=installation(ctx),run=dependencies.run||nativeRun;
  if(name==='minimax_h3_status') {
    const output={...(await cloudStatus(ctx,profile,run)),readOnly:true,baoConnection:'FLASH current bao-production MCP'};
    if(args.discover_projects)try{output.projects=scrub(await bao(ctx,'production_projects',{}));}catch(error){output.projectsError=error.code||'BAO_READ_FAILED';}
    if(args.project_id)try{output.baoReadiness=scrub(await readiness(ctx,args.project_id));}catch(error){output.baoError=error.code||'BAO_READ_FAILED';}
    return {text:JSON.stringify(output),isError:!output.ok};
  }
  if(name==='minimax_h3_runtime') {const result=await runtime(ctx,profile,args,run);return {text:JSON.stringify(result),isError:!result.ok};}
  const action=args.action;
  if(!['plan_start','plan_stop'].includes(action)) {
    if(busy.has(profile.root))throw fail('POWER_ACTION_IN_PROGRESS');
    busy.add(profile.root);
  }
  const file=path.join(profile.output,'power-'+crypto.randomBytes(12).toString('hex')+'.json');
  const record={schema:'flash-h3-power/v1',action,target:TARGET,projectId:args.project_id||null,startedAt:new Date().toISOString(),status:'preflight',generationSubmitted:false};
  try {
    if(action==='bind_project') {
      if(!args.project_id||!args.expected_project_id)throw fail('VERIFIED_OLD_AND_NEW_PROJECT_REQUIRED');
      const status=await cloudStatus(ctx,profile,run);
      if(!status.ok||status.powerState!=='RUNNING')throw fail('RUNNING_VM_REQUIRED_USE_PREPARE');
      const live=await runtime(ctx,profile,{project_id:args.expected_project_id},run);
      if(!live.ok||!live.validation.compatible)throw fail('RUNTIME_PROJECT_PROFILE_OR_RECEIPTS_MISMATCH');
      for(const key of ['worker','adapter','comfy'])if(live.snapshot.services[key].mainPid!==0||!['inactive','failed'].includes(live.snapshot.services[key].activeState))throw fail('STOPPED_SERVICES_REQUIRED_FOR_PROJECT_BINDING');
      record.queue=queueFrom(await readiness(ctx,args.project_id),args.project_id);
      record.previousQueue=queueFrom(await readiness(ctx,args.expected_project_id),args.expected_project_id);
      record.runtimeSnapshot=live.snapshotPath;
    }
    if(action==='start_prepare'||action==='start_services') {
      if(!args.project_id)throw fail('VERIFIED_BAO_PROJECT_REQUIRED');
      if(action==='start_prepare'&&args.acknowledge_boot_autostart!==true)throw fail('BOOT_AUTOSTART_ACKNOWLEDGEMENT_REQUIRED');
      record.queue=queueFrom(await readiness(ctx,args.project_id),args.project_id);
      if(action==='start_services') {
        const status=await cloudStatus(ctx,profile,run);
        if(!status.ok||status.powerState!=='RUNNING')throw fail('RUNNING_VM_REQUIRED_USE_PREPARE');
        const live=await runtime(ctx,profile,args,run);
        if(!live.ok||!live.validation.compatible)throw fail('RUNTIME_PROJECT_PROFILE_OR_RECEIPTS_MISMATCH');
        record.runtimeSnapshot=live.snapshotPath;
        // Read again immediately before starting the continuous consumer.
        record.queue=queueFrom(await readiness(ctx,args.project_id),args.project_id);
      }
    }
    record.status='requesting';receipt(file,record);
    let result;
    if(action==='bind_project') {
      const reply=await run(profile.powershell,['-NoProfile','-NonInteractive','-File','Bind-H3Project.ps1','-ProjectId',args.project_id,'-ExpectedProjectId',args.expected_project_id],{cwd:profile.root});
      const binding=jsonLines(reply.stdout).findLast(item=>item.bound===true);
      result={action,target:TARGET,ok:reply.ok&&binding?.projectId===args.project_id,...(binding?{binding}:{}),generationSubmitted:false,cloudResourcesCreated:false,automaticRetry:false};
      if(!result.ok){result.errorCode=errorCode(reply);result.outcomeUnknown=true;}
      if(result.ok){const after=await runtime({...ctx,signal:undefined},profile,{project_id:args.project_id},run);result.runtimeSnapshot=after.snapshotPath;result.ok=after.ok&&after.validation.compatible;if(!result.ok){result.errorCode='PROJECT_BINDING_NOT_VERIFIED';result.outcomeUnknown=true;}}
    }else result=powerResult(action,await run(profile.powershell,argumentsFor(action),{cwd:profile.root}));
    // A lost response must be reconciled by read-only status, never an automatic retry.
    if(result.ok&&!action.startsWith('plan_')) {
      const after=await cloudStatus({...ctx,signal:undefined},profile,run);
      result.after=after;
      if(action==='stop')result.ok=after.ok&&after.powerState==='TERMINATED';
      else result.ok=after.ok&&after.powerState==='RUNNING';
      if(!result.ok){result.outcomeUnknown=true;result.errorCode='FINAL_POWER_STATE_UNVERIFIED';}
    }
    record.status=result.ok?'complete':'requires_review';record.finishedAt=new Date().toISOString();record.result=result;
    fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n',{mode:0o600});
    return {text:JSON.stringify({...result,receipt:file}),isError:!result.ok};
  } finally {busy.delete(profile.root);}
}
function mutates(name,args) {return name==='minimax_h3_power'&&['start_prepare','bind_project','start_services','stop'].includes(args?.action);}
function billable(name,args) {return name==='minimax_h3_power'&&['start_prepare','start_services'].includes(args?.action);}
module.exports={definitions,execute,mutates,billable,argumentsFor,runtimeCompatibility,powerResult,queueFrom,TARGET,HASHES};
