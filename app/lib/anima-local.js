'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');const {execFile}=require('node:child_process');const {EventEmitter}=require('node:events');
const {validateMedia}=require('./grok-media');
const managers=new WeakMap();const now=()=>new Date().toISOString();const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
function tail(file,bytes=50000){try{const fd=fs.openSync(file,'r');try{const size=fs.fstatSync(fd).size;const data=Buffer.alloc(Math.min(size,bytes));fs.readSync(fd,data,0,data.length,Math.max(0,size-data.length));return data.toString('utf8');}finally{fs.closeSync(fd);}}catch{return '';}}
function alive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
function trainingState(){
 const trainingRoot=process.env.FLASH_ANIMA_TRAINING_ROOT||'D:/lora_train';
 let state=null,supervisor=null;try{state=JSON.parse(fs.readFileSync(path.join(trainingRoot,'background-state.json'),'utf8').replace(/^\uFEFF/,''));}catch{}
 try{supervisor=JSON.parse(fs.readFileSync(path.join(trainingRoot,'background-supervisor.json'),'utf8').replace(/^\uFEFF/,''));}catch{}
 if(!state)return{active:false,status:'unknown'};
 const active=state.Status==='running'&&(alive(state.Pid)||alive(supervisor?.SupervisorPid));
 const log=state.Stderr?tail(state.Stderr):'';const steps=[...log.matchAll(/steps:\s*(\d+)%[^\r\n]*?\b(\d+)\/(\d+)\s*\[/g)].at(-1);
 const out=state.Stdout?tail(state.Stdout):'';const epoch=[...out.matchAll(/epoch\s+(\d+)\/(\d+)/gi)].at(-1);
 return{active,status:state.Status,stage:state.Stage||'',initialEpoch:state.InitialEpoch||null,epoch:epoch?Number(epoch[1]):null,totalEpochs:epoch?Number(epoch[2]):null,stepsThisRun:steps?Number(steps[2]):null,error:state.Error||'',results:state.Results||[]};
}
class AnimaLocal extends EventEmitter{
 constructor(store,{training=trainingState}={}){super();this.training=training;this.store=store;this.root=path.join(store.data,'anima');this.jobsDir=path.join(this.root,'jobs');fs.mkdirSync(this.jobsDir,{recursive:true});this.jobs=new Map();this.polling=false;this.starting=null;
  for(const file of fs.readdirSync(this.jobsDir).filter(f=>/^anima_[a-f0-9]{24}\.json$/.test(f)))try{const job=store.readJson(path.join(this.jobsDir,file),'anima-job.schema.json');this.jobs.set(job.id,job);}catch{}
  this.timer=setInterval(()=>this.tick().catch(()=>{}),5000);this.timer.unref();
 }
 config(){return this.store.getSettings().anima||{enabled:false,root:'D:/AnimaStudio',apiUrl:'http://127.0.0.1:17861'};}
 persist(job){job.updatedAt=now();this.store.writeJson(path.join(this.jobsDir,job.id+'.json'),job,'anima-job.schema.json');this.emit('change',job.id);}
 get(id){if(!/^anima_[a-f0-9]{24}$/.test(String(id))||!this.jobs.has(id))throw new Error('ANIMA 작업을 찾을 수 없습니다.');return structuredClone(this.jobs.get(id));}
 list(){return[...this.jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100).map(j=>structuredClone(j));}
 keepsAlive(){return[...this.jobs.values()].some(j=>['queued','running'].includes(j.status));}
 async api(route,{method='GET',body,timeout=12000}={}){
  const cfg=this.config(),base=new URL(cfg.apiUrl);
  if(base.protocol!=='http:'||!['127.0.0.1','localhost'].includes(base.hostname)||base.username||base.password||base.pathname!=='/')throw new Error('ANIMA는 이 PC의 로컬 주소만 연결할 수 있습니다.');
  const token=fs.readFileSync(path.join(cfg.root,'.local','token'),'utf8').trim();
  const response=await fetch(new URL(route,base),{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeout)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'ANIMA HTTP '+response.status);return data;
 }
 async status(){
  const cfg=this.config(),training=this.training();let engine=null,availableLoras=[],message='';
  try{engine=await this.api('/v1/status');availableLoras=engine.available_loras||[];}catch(error){message=error.code==='ENOENT'?'ANIMA 로컬 설치 또는 인증 파일을 찾을 수 없습니다.':error.message;}
  if(!availableLoras.length)try{const {listLoras}=await import(pathToFileURL(path.join(cfg.root,'app/loras.mjs')).href);const settings=JSON.parse(fs.readFileSync(path.join(cfg.root,'config/settings.json'),'utf8'));availableLoras=await listLoras(cfg.root,settings);}catch{}
  return{enabled:!!cfg.enabled,installed:fs.existsSync(path.join(cfg.root,'app/server.mjs')),ready:!!engine?.ready&&!training.active,engine,training,loras:availableLoras,defaults:{preset:cfg.preset,lora:cfg.lora,loraStrength:cfg.loraStrength},message,capabilities:{textToImage:true,imageToImage:false,video:false,lora:true},outputDirectory:this.store.dirs.images};
 }
 async startEngine(){
  if(this.training().active)throw new Error('LoRA 학습 중입니다. 학습이 끝난 뒤 ANIMA 생성을 시작합니다.');
  if(this.starting)return this.starting;
  const script=path.join(this.config().root,'scripts/start-local.ps1');
  this.starting=new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,timeout:30000},error=>error?reject(new Error('ANIMA 엔진 시작에 실패했습니다. 로컬 시작 로그를 확인하세요.')):resolve({started:true})));
  try{return await this.starting;}finally{this.starting=null;}
 }
 async start(input){
  this.store.reg.assert('media-request.schema.json#/$defs/anima',input);
  const cfg=this.config();if(!cfg.enabled)throw new Error('ANIMA 로컬 생성이 꺼져 있습니다.');
  if(input.reference_images?.length)throw new Error('현재 ANIMA 로컬은 텍스트→이미지 생성만 지원합니다. 참조 이미지 편집은 Grok을 선택하세요.');
  const prompt=String(input.prompt||'').trim(),width=input.width??1280,height=input.height??720;
  if(!prompt||prompt.length>6000)throw new Error('ANIMA 프롬프트는 1~6000자입니다.');
  if(![width,height].every(n=>Number.isInteger(n)&&n>=720&&n<=1536&&n%16===0)||width*height>1048576)throw new Error('가로·세로 최소 720px, 16px 단위, 최대 약 1메가픽셀입니다. 1280×720을 사용하세요.');
  const lora=Object.hasOwn(input,'lora_name')?String(input.lora_name||''):cfg.lora||'';
  const strength=input.lora_strength??cfg.loraStrength??0.8;
  if(lora&&(!/^[a-zA-Z0-9_.-]+\.safetensors$/.test(lora)||!Number.isFinite(strength)||strength<0||strength>2))throw new Error('LoRA 이름과 강도를 확인하세요.');
  const preset=input.preset||(lora?'aesthetic':cfg.preset||'turbo');if(!['turbo','aesthetic'].includes(preset))throw new Error('지원하지 않는 ANIMA 프리셋입니다.');
  const seed=input.seed??null;if(seed!==null&&(!Number.isInteger(seed)||seed<0||seed>2147483647))throw new Error('시드는 0~2147483647입니다.');
  const parameters={prompt,negative_prompt:String(input.negative_prompt||''),preset,width,height,seed,...(lora?{lora_name:lora,lora_strength:strength}:{})};
  const fingerprint=sha(JSON.stringify(parameters));if(!input.new_variant){const prior=[...this.jobs.values()].reverse().find(j=>j.fingerprint===fingerprint);if(prior)return{...prior,reused:true};}
  const id='anima_'+crypto.randomBytes(12).toString('hex');
  const job={id,fingerprint,kind:'image',status:'queued',prompt,createdAt:now(),updatedAt:now(),references:[],artifacts:[],phase:this.training().active?'LoRA 학습 완료 대기':'로컬 생성 대기',request:{...parameters,project_slug:'flash-studio',shot_id:id,request_id:'flash-'+id}};
  this.jobs.set(id,job);this.persist(job);setImmediate(()=>this.tick().catch(()=>{}));return{...job,reused:false};
 }
 async tick(){
  if(this.polling)return;const job=[...this.jobs.values()].find(j=>['queued','running'].includes(j.status));if(!job)return;this.polling=true;
  try{
   if(this.training().active&&!job.nativeJobId){if(job.status==='queued'&&job.phase!=='LoRA 학습 완료 대기'){job.phase='LoRA 학습 완료 대기';this.persist(job);}return;}
   if(!job.nativeJobId){
    const state=await this.status();if(job.status==='canceled')return;if(!state.ready){if(state.installed&&!this.starting)await this.startEngine();return;}
    // An unresolved prior POST may already have been accepted. Adopt its exact request before any retry.
    const directory=path.join(this.config().root,'.local/jobs');
    for(const file of fs.readdirSync(directory).filter(f=>/^[a-f0-9]{32}\.json$/.test(f))){const old=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));if(old.request?.request_id===job.request.request_id){job.nativeJobId=old.id;break;}}
    if(!job.nativeJobId){job.status='running';job.phase='로컬 요청 접수 중';job.startedAt=now();this.persist(job);
     try{const native=await this.api('/v1/tools/call',{method:'POST',body:{name:job.request.lora_name?'generate_anime_image_with_lora':'generate_anime_image',arguments:job.request},timeout:45000});job.nativeJobId=native.id;}
     catch(error){job.status='failed';job.error='ANIMA 접수 결과를 확인하지 못했습니다. 중복 방지를 위해 재접수하지 않았습니다. '+error.message;job.finishedAt=now();this.persist(job);return;}
    }
    job.status='running';job.phase='ANIMA 로컬 생성 중';this.persist(job);
   }
   const native=await this.api('/v1/jobs/'+job.nativeJobId);
   if(native.status==='succeeded'){
    const artifacts=[];
    for(const [index,image]of(native.images||[]).entries()){
     const file=fs.realpathSync(image.local_path),output=fs.realpathSync(path.join(this.config().root,'output'));
     if(!file.startsWith(output+path.sep))throw new Error('ANIMA 결과 경로가 로컬 출력 폴더 밖에 있습니다.');
     const buffer=fs.readFileSync(file),format=validateMedia(buffer,'image'),hash=sha(buffer),dest=path.join(this.store.dirs.images,`anima_${job.id.slice(6)}_${index+1}${format.ext}`);
     if(!fs.existsSync(dest))fs.writeFileSync(dest,buffer,{flag:'wx'});if(sha(fs.readFileSync(dest))!==hash)throw new Error('ANIMA 결과 저장 검증에 실패했습니다.');
     artifacts.push({type:'image',url:'/files/images/'+path.basename(dest),path:dest,bytes:buffer.length,sha256:hash,mime:format.mime,...(format.width?{width:format.width,height:format.height}:{}),model:'ANIMA 로컬'+(job.request.lora_name?' · '+job.request.lora_name:''),prompt:job.prompt});
    }
    if(!artifacts.length)throw new Error('ANIMA가 완료됐지만 생성 파일이 없습니다.');job.artifacts=artifacts;delete job.error;job.status='succeeded';job.phase='완료';job.finishedAt=now();
   }else if(['failed','submission_unknown'].includes(native.status)){job.status='failed';job.error=native.error||'ANIMA 생성 상태를 확인하세요. 자동 재제출하지 않았습니다.';job.finishedAt=now();}
   this.persist(job);
  }catch(error){job.phase='로컬 연결 대기';job.error=error.message;this.persist(job);}finally{this.polling=false;}
 }
 cancel(id){const job=this.jobs.get(id);if(!job)throw new Error('ANIMA 작업을 찾을 수 없습니다.');if(job.nativeJobId&&job.status==='running')throw new Error('이미 ANIMA에서 실행 중인 작업은 강제 종료하지 않습니다. 완료까지 기다려 주세요.');if(job.status==='queued'){job.status='canceled';job.phase='취소됨';job.finishedAt=now();this.persist(job);}return this.get(id);}
 wait(id,{signal}={}){return new Promise((resolve,reject)=>{const clean=()=>{this.off('change',listener);signal?.removeEventListener('abort',abort);};const inspect=()=>{const job=this.get(id);if(['succeeded','failed','canceled'].includes(job.status)){clean();job.status==='succeeded'?resolve(job):reject(new Error(job.error||'ANIMA 작업이 취소됐습니다.'));}};const listener=changed=>{if(changed===id)inspect();};const abort=()=>{clean();reject(new Error('대기를 중지했습니다. ANIMA 작업 목록에서 진행 상태를 확인하세요.'));};this.on('change',listener);signal?.addEventListener('abort',abort,{once:true});signal?.aborted?abort():inspect();});}
 close(){clearInterval(this.timer);}
}
function getAnima(store){let manager=managers.get(store);if(!manager){manager=new AnimaLocal(store);managers.set(store,manager);}return manager;}
const fn=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
function definitions(settings){if(!settings.anima?.enabled)return[];return[
 fn('anima_generate_image','ANIMA 로컬 모델로 텍스트→이미지를 생성한다. 유료 외부 API를 쓰지 않는다. LoRA 학습 중이면 대기하고 끝난 뒤 진행한다. 참조 이미지 편집·영상 생성은 지원하지 않는다. 반환된 작업 ID를 anima_job_status로 조회하거나 poll_until로 기다린다.',{prompt:{type:'string'},negative_prompt:{type:'string'},width:{type:'integer'},height:{type:'integer'},preset:{type:'string',enum:['turbo','aesthetic']},lora_name:{type:'string',description:'anima_connection_status에서 확인한 정확한 파일명. 빈 문자열은 LoRA 없이 생성.'},lora_strength:{type:'number',minimum:0,maximum:2},seed:{type:'integer',minimum:0,maximum:2147483647},new_variant:{type:'boolean'}},['prompt']),
 fn('anima_job_status','기존 ANIMA 생성 작업의 상태와 파일을 조회한다. 새로 생성하지 않는다.',{job_id:{type:'string'}},['job_id']),
 fn('anima_connection_status','ANIMA 로컬 준비 상태, LoRA 파일 목록, 학습 진행 상태를 조회한다. 모델이나 학습을 시작하지 않는다.')];}
function result(job){return{text:JSON.stringify(job),images:job.status==='succeeded'?job.artifacts.map(a=>({type:'image',url:a.url,prompt:a.prompt,model:a.model})):[],isError:job.status==='failed'};}
async function execute(name,args,ctx){const manager=getAnima(ctx.store);if(name==='anima_connection_status')return{text:JSON.stringify(await manager.status())};if(name==='anima_job_status')return result(manager.get(args.job_id));return result(await manager.start(args));}
async function runImage(args,ctx){if(args.useAttached||args.references?.length)throw new Error('현재 ANIMA 로컬은 텍스트→이미지 전용입니다. 참조 편집은 Grok을 선택하세요.');const size=String(args.size||'').match(/^(\d+)x(\d+)$/i);const manager=getAnima(ctx.store);const job=await manager.start({prompt:args.prompt,...(size?{width:Number(size[1]),height:Number(size[2])}:{}),new_variant:!!args.new_variant});return result(await manager.wait(job.id,{signal:ctx.signal})).images;}
module.exports={AnimaLocal,getAnima,definitions,execute,runImage,trainingState};
