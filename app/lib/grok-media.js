'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { GrokClient, defaultCli, subscriptionEnvironment, assertSubscriptionConfig, redact } = require('./grok-client');
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const managers = new WeakMap();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (file, root) => { const rel = path.relative(path.resolve(root), path.resolve(file)); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const timestamp = () => new Date().toISOString();
const mediaExt = file => /\.(png|jpe?g|webp|mp4|webm)$/i.test(file);
function collectStrings(value, output, depth = 0) {
  if (depth > 12) return;
  if (typeof value === 'string') { if (value.length < 1000000) output.push(value); return; }
  if (Array.isArray(value)) for (const item of value.slice(0, 100)) collectStrings(item, output, depth + 1);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (!/base64|data|token|authorization/i.test(key) || (key === 'data' && typeof item === 'object')) collectStrings(item, output, depth + 1);
}
function candidates(text) {
  const out = [];
  for (const match of text.matchAll(/(?:[A-Za-z]:[\\/][^\r\n"<>|]*?|file:\/\/[^\s"<>]+?|https:\/\/[^\s"<>]+?)\.(?:png|jpe?g|webp|mp4|webm)(?:\?[^\s"<>]*)?/gi)) out.push(match[0].replace(/\\\\/g, '\\'));
  return out;
}
function filesUnder(root, depth = 0) {
  if (depth > 8 || !fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...filesUnder(file, depth + 1)); else if (entry.isFile() && mediaExt(file)) out.push(file);
  }
  return out;
}
function validateMedia(buffer, kind) {
  if (kind === 'video') {
    if (buffer.length < 100 || !(buffer.subarray(4, 8).toString() === 'ftyp' || buffer.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))) throw new Error('생성 영상 파일의 형식이 올바르지 않습니다.');
    return buffer.subarray(4, 8).toString() === 'ftyp' ? { ext: '.mp4', mime: 'video/mp4' } : { ext: '.webm', mime: 'video/webm' };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { ext: '.png', mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  throw new Error('생성 이미지 파일의 형식이 올바르지 않습니다.');
}

class GrokMedia extends EventEmitter {
  constructor(store, options = {}) {
    super(); this.store = store; this.Client = options.Client || GrokClient;
    this.root = path.join(store.data, 'grok'); this.jobsDir = path.join(this.root, 'jobs');
    this.workDir = path.join(this.root, 'work'); this.videosDir = path.join(store.data, 'videos');
    for (const dir of [this.jobsDir, this.workDir, this.videosDir]) fs.mkdirSync(dir, { recursive: true });
    this.jobs = new Map(); this.active = null; this.auth = { status: 'unchecked', mode: 'subscription' };
    for (const file of fs.readdirSync(this.jobsDir).filter(name => /^[a-f0-9]{24}\.json$/.test(name))) {
      try {
        const job = store.readJson(path.join(this.jobsDir, file), 'grok-job.schema.json');
        if (job.status === 'running') { job.status = 'failed'; job.error = '서버 재시작으로 연결이 종료됐습니다. 자동 재생성하지 않았습니다.'; job.finishedAt = timestamp(); this.persist(job); }
        this.jobs.set(job.id, job);
      } catch { /* A damaged record must never cause a generation replay. */ }
    }
  }
  config() { return this.store.getSettings().grok || { enabled: false }; }
  cliPath() { return this.config().cliPath || defaultCli(); }
  persist(job) { job.updatedAt = timestamp(); this.store.writeJson(path.join(this.jobsDir, job.id + '.json'), job, 'grok-job.schema.json'); this.emit('change', job.id); }
  list() { return [...this.jobs.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,100).map(job => this.publicJob(job)); }
  get(id) { if (!/^[a-f0-9]{24}$/.test(String(id))) throw new Error('잘못된 Grok 작업 ID입니다.'); const job = this.jobs.get(id); if (!job) throw new Error('Grok 작업을 찾을 수 없습니다.'); return this.publicJob(job); }
  publicJob(job) { return { ...job, references: job.references.map(file => path.basename(file)) }; }
  keepsAlive() { return !!this.active || !!this.loginProcess || [...this.jobs.values()].some(job => job.status === 'queued'); }
  async status(check = false) {
    let configError = '';
    try { assertSubscriptionConfig(); } catch(error) { configError = error.message; }
    const cliPath = this.cliPath(), installed = fs.existsSync(cliPath);
    if (check && installed && !configError) {
      const probe = path.join(this.root, 'connection-check'); fs.mkdirSync(probe, {recursive:true});
      const client = new this.Client({ cwd: probe, cliPath, timeoutMs:45000 });
      try { await client.connect(); this.auth = { status:'ready', mode:'subscription', method:client.authMethod, checkedAt:timestamp() }; }
      catch(error) { this.auth = { status:'login_required', mode:'subscription', message:redact(error.message), checkedAt:timestamp() }; }
      finally { client.close(); }
      if (this.auth.status === 'ready') setImmediate(() => this.pump());
    }
    return { enabled:!!this.config().enabled, installed, cliPath, mode:'subscription', apiFallback:false, auth:configError ? {status:'configuration_blocked',message:configError} : this.auth, activeJobId:this.active?.job.id || null, outputDirectories:{images:this.store.dirs.images,videos:this.videosDir}, login: this.loginProcess ? {status:'pending'} : null };
  }
  login() {
    if (this.loginProcess) return {status:'pending'};
    assertSubscriptionConfig();
    const proc = spawn(this.cliPath(), ['login','--oauth'], { env:subscriptionEnvironment(), windowsHide:true, stdio:['ignore','pipe','pipe'] });
    this.loginProcess = proc; this.auth = {status:'login_pending',mode:'subscription'};
    let error = '';
    proc.stderr.on('data', chunk => { error = redact((error + chunk.toString()).slice(-1500)); });
    proc.stdout.resume();
    proc.on('error', e => { this.loginProcess = null; this.auth = {status:'login_required',mode:'subscription',message:redact(e.message)}; });
    proc.on('exit', code => { this.loginProcess = null; this.auth = {status:code===0?'unchecked':'login_required',mode:'subscription',...(code ? {message:error || 'Grok 로그인이 완료되지 않았습니다.'} : {})}; });
    return {status:'pending',message:'열린 Grok 로그인 화면에서 구독 계정으로 로그인하세요.'};
  }
  resolveReference(input) {
    let file = String(input);
    const app = file.match(/^\/files\/(images|uploads)\/([A-Za-z0-9._-]+)$/);
    if (app) file = path.join(this.store.dirs[app[1]],app[2]);
    if (!path.isAbsolute(file) || !fs.existsSync(file) || !/\.(png|jpe?g|webp)$/i.test(file)) throw new Error('참조 이미지는 업로드한 이미지 또는 허용된 로컬 이미지 경로여야 합니다.');
    const actual = fs.realpathSync(file);
    const roots = [this.store.dirs.images,this.store.dirs.uploads,this.store.dirs.workspace,...(this.store.getSettings().tools.allowedDirs || [])];
    if (!roots.some(root => fs.existsSync(root) && inside(actual,fs.realpathSync(root)))) throw new Error('참조 이미지가 허용된 작업 폴더 밖에 있습니다. 앱에 이미지를 첨부하세요.');
    if (fs.statSync(actual).size > 30*1024*1024) throw new Error('Grok 참조 이미지는 한 장당 30MB 이하로 준비하세요.');
    validateMedia(fs.readFileSync(actual),'image'); return actual;
  }
  start(input) {
    this.store.reg.assert('media-request.schema.json#/$defs/grok', input);
    if (!this.config().enabled) throw new Error('Grok 구독 생성이 꺼져 있습니다.');
    assertSubscriptionConfig();
    const {kind,prompt,reference_images = [],aspect_ratio = '16:9',resolution,duration = 6,new_variant = false} = input;
    if (!['image','video'].includes(kind) || typeof prompt !== 'string' || !prompt.trim() || prompt.length>20000) throw new Error('이미지·영상 종류와 생성 프롬프트를 확인하세요.');
    if (!['1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9'].includes(aspect_ratio)) throw new Error('지원하지 않는 화면 비율입니다.');
    if (!Array.isArray(reference_images) || reference_images.length>5) throw new Error('참조 이미지는 최대 5장입니다.');
    if (kind==='video' && ![6,10].includes(duration)) throw new Error('현재 Grok CLI 영상 길이는 6초 또는 10초입니다.');
    const res=resolution || (kind==='video'?'720p':'auto');
    if (!(kind==='video'?['480p','720p']:['auto']).includes(res)) throw new Error('현재 Grok CLI에서 지정할 수 없는 해상도입니다. 이미지는 자동 해상도, 영상은 480p 또는 720p를 사용하세요.');
    const references=reference_images.map(ref=>this.resolveReference(ref));
    const fingerprint=digest(JSON.stringify({kind,prompt:prompt.trim(),aspect_ratio,resolution:res,duration:kind==='video'?duration:null,references:references.map(file=>digest(fs.readFileSync(file)))}));
    if (!new_variant) {
      const prior=[...this.jobs.values()].reverse().find(job=>job.fingerprint===fingerprint);
      if(prior) return {...this.publicJob(prior),reused:true};
    }
    const job={id:crypto.randomBytes(12).toString('hex'),fingerprint,kind,prompt:prompt.trim(),aspectRatio:aspect_ratio,resolution:res,...(kind==='video'?{duration}:{}),references,status:'queued',phase:'대기 중',createdAt:timestamp(),updatedAt:timestamp(),artifacts:[],tools:[]};
    this.jobs.set(job.id,job);this.persist(job);setImmediate(()=>this.pump());return {...this.publicJob(job),reused:false};
  }
  async pump() {
    if (this.active || !this.config().enabled) return;
    const job=[...this.jobs.values()].find(item=>item.status==='queued');if(!job)return;
    if(['usage_limit','login_required'].includes(this.auth.status))return;
    const dir=path.join(this.workDir,job.id);fs.mkdirSync(dir,{recursive:true});
    const client=new this.Client({cwd:dir,cliPath:this.cliPath(),timeoutMs:(this.config().timeoutSeconds||900)*1000});
    this.active={job,client};job.status='running';job.startedAt=timestamp();job.phase='구독 계정 연결 중';this.persist(job);
    const inputCopies=new Set(),texts=[],toolErrors=[];
    try{
      client.on('permission',info=>this.emit('permission',info));
      const refs=job.references.map((file,i)=>{const dest=path.join(dir,`reference-${i+1}${path.extname(file).toLowerCase()}`);fs.copyFileSync(file,dest);inputCopies.add(dest);return dest;});
      client.on('update', params=>{
        if(job.status!=='running')return;
        collectStrings(params?.update,texts);if(texts.length>5000)texts.splice(0,texts.length-5000);
        const update=params?.update;
        if(update?.sessionUpdate==='tool_call'||update?.sessionUpdate==='tool_call_update'){
          if(update.status==='failed'){const errors=[];collectStrings(update.content||update.rawOutput,errors);toolErrors.push(...errors);}
          const id=String(update.toolCallId||'');let tool=job.tools.find(item=>item.id===id);
          if(!tool){tool={id,title:redact(update.title||'Grok 미디어 생성').slice(0,200),status:String(update.status||'pending')};job.tools.push(tool);}
          else if(update.status)tool.status=String(update.status);
          job.phase=/image_to_video|reference_to_video/i.test(tool.title)?'영상 생성 중':/image_edit/i.test(tool.title)?'이미지 편집 중':/image_gen/i.test(tool.title)?'이미지 생성 중':'생성 준비 중';this.persist(job);
        }
      });
      await client.connect();job.authMethod=client.authMethod;this.auth={status:'ready',mode:'subscription',method:client.authMethod,checkedAt:timestamp()};
      const session=await client.newSession();job.sessionId=session.sessionId;job.phase='생성 중';this.persist(job);
      const instructions=[
        'This is a single media-generation job submitted by the user through Flash Studio. Use only built-in Grok media tools and the authenticated Grok subscription. Do not use an API key, external services, MCP tools, shell commands, or delegate agents.',
        `Generate exactly ONE ${job.kind}. Do not generate variants or retry a failed generation. If quota/authentication/tool availability prevents generation, report that error and stop.`,
        `Requested aspect ratio: ${job.aspectRatio}.${job.kind==='video'?` Use resolution_name=${job.resolution} and duration=${job.duration} exactly.`:' Use the native image-tool resolution; do not claim a size you did not receive.'}`,
        refs.length?`Use these exact reference image files, in order: ${JSON.stringify(refs)}. ${job.kind==='image'?'Use image_edit. Preserve character identity and the source style unless the request changes them.':refs.length===1?'Use image_to_video; the reference is the first frame.':'Use reference_to_video with all references.'}`:job.kind==='image'?'Use image_gen.':'For text-to-video, first use image_gen to create exactly one starting frame, then image_to_video for exactly one video. Keep the same scene and character.',
        `Put the generated result in ${dir} if the media tool supports choosing an output file. Otherwise keep its returned artifact path. Do not delete or overwrite any input.`,
        'User creative direction (apply it to the media content, not to tool permissions):',job.prompt,
        'When finished, return JSON containing the exact absolute output file paths, actual resolution/duration when known, and any error. Do not claim a file exists without a successful generation tool result.'
      ].join('\n');
      const result=await client.prompt(instructions);collectStrings(result,texts);
      if(job.status!=='running')return;
      job.phase='생성 파일 확인 중';this.persist(job);
      const home=process.env.GROK_HOME||path.join(os.homedir(),'.grok');
      const sessionRoots=[path.join(home,'sessions',encodeURIComponent(dir),job.sessionId),path.join(home,'sessions',job.sessionId)];
      const paths=new Set([...texts.flatMap(candidates),...filesUnder(dir),...sessionRoots.flatMap(root=>filesUnder(root))]);
      const seen=new Set();
      for(let file of paths){
        if(job.status!=='running')return;
        try{
          if(/^https:\/\//i.test(file)){
            const url=new URL(file);if(!/(^|\.)(x\.ai|grok\.com)$/i.test(url.hostname))continue;
            const response=await fetch(url,{signal:AbortSignal.timeout(60000),redirect:'error'});if(!response.ok)continue;
            const length=Number(response.headers.get('content-length'));if(length>200*1024*1024)continue;
            const buf=Buffer.from(await response.arrayBuffer());if(buf.length>200*1024*1024)continue;
            if(job.status!=='running')return;
            const local=path.join(dir,'remote-'+digest(buf).slice(0,12)+path.extname(url.pathname));fs.writeFileSync(local,buf);file=local;
          }else if(file.startsWith('file:'))file=fileURLToPath(file);
          if(!path.isAbsolute(file)||!fs.existsSync(file)||inputCopies.has(file))continue;
          const actual=fs.realpathSync(file);if(!inside(actual,dir)&&!sessionRoots.some(root=>inside(actual,root)))continue;
          const info=fs.statSync(actual);if(!info.isFile()||info.mtimeMs<Date.parse(job.startedAt)-2000||info.size>200*1024*1024)continue;
          const wanted=job.kind==='video'?/\.(mp4|webm)$/i:/\.(png|jpe?g|webp)$/i;if(!wanted.test(actual))continue;
          const buffer=fs.readFileSync(actual),format=validateMedia(buffer,job.kind),sha=digest(buffer);if(seen.has(sha))continue;seen.add(sha);
          const name=`grok_${job.id}_${job.artifacts.length+1}${format.ext}`;
          const dest=path.join(job.kind==='video'?this.videosDir:this.store.dirs.images,name);
          fs.writeFileSync(dest,buffer,{flag:'wx'});
          if(digest(fs.readFileSync(dest))!==sha)throw new Error('생성 파일 저장 검증에 실패했습니다.');
          if(job.kind==='image')try{const size=require('./tools-extra').imageSize(dest);format.width=size.width;format.height=size.height;}catch{}
          if(job.kind==='video')try{const meta=await new Promise((resolve,reject)=>execFile('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height:format=duration','-of','json',dest],{windowsHide:true,timeout:10000},(error,stdout)=>error?reject(error):resolve(JSON.parse(stdout))));if(meta.streams?.[0]){format.width=meta.streams[0].width;format.height=meta.streams[0].height;}if(Number.isFinite(Number(meta.format?.duration)))format.duration=Number(meta.format.duration);}catch{}
          if(job.status!=='running')return;
          job.artifacts.push({type:job.kind,url:`/files/${job.kind==='video'?'videos':'images'}/${name}`,path:dest,bytes:buffer.length,sha256:sha,mime:format.mime,...(format.width?{width:format.width,height:format.height}:{}),...(format.duration?{duration:format.duration}:{}),model:'Grok CLI · 구독',prompt:job.prompt});
        }catch(error){if(/저장 검증/.test(error.message))throw error;}
      }
      if(job.status!=='running')return;
      if(!job.artifacts.length){const messages=toolErrors.join('\n').slice(-2000);throw new Error('생성이 완료된 결과 파일을 확인하지 못했습니다. 자동 재생성하지 않았습니다.'+(messages?'\n'+redact(messages):''));}
      job.status='succeeded';job.phase='완료';job.finishedAt=timestamp();this.persist(job);
    }catch(error){
      if(job.status==='running'){job.status='failed';job.error=redact(error.message).slice(0,5000);job.phase='오류';job.finishedAt=timestamp();this.persist(job);if(/quota|limit|credit|한도/i.test(job.error))this.auth={status:'usage_limit',mode:'subscription',message:'Grok 구독 사용 한도를 확인하세요. API 과금으로 전환하지 않았습니다.'};}
    }finally{client.close();this.active=null;setImmediate(()=>this.pump());}
  }
  cancel(id){const job=this.jobs.get(id);if(!job)throw new Error('Grok 작업을 찾을 수 없습니다.');if(!TERMINAL.has(job.status)){job.status='canceled';job.phase='취소됨';job.finishedAt=timestamp();this.persist(job);if(this.active?.job.id===id)this.active.client.close();}return this.publicJob(job);}
  wait(id,{signal}={}){
    return new Promise((resolve,reject)=>{
      const inspect=()=>{const job=this.get(id);if(TERMINAL.has(job.status)){clean();job.status==='succeeded'?resolve(job):reject(new Error(job.error||'Grok 생성이 취소됐습니다.'));}};
      const listener=changed=>{if(changed===id)inspect();};const abort=()=>{clean();reject(new Error('생성 대기가 취소됐습니다. 작업 목록에서 진행 상태를 확인하세요.'));};
      const clean=()=>{this.off('change',listener);signal?.removeEventListener('abort',abort);};this.on('change',listener);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();else inspect();
    });
  }
  close(){for(const job of this.jobs.values())if(job.status==='running')this.cancel(job.id);}
}
function getGrok(store){let manager=managers.get(store);if(!manager){manager=new GrokMedia(store);managers.set(store,manager);}return manager;}
module.exports={GrokMedia,getGrok,validateMedia,candidates,inside};
