'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {execFile}=require('node:child_process');
const fn=(name,description,properties,required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const range={start_seconds:{type:'number',minimum:0},end_seconds:{type:'number',minimum:0}};
function definitions(settings){if(!settings.tools.enableWorkspace)return[];return[
 fn('media_info','로컬 이미지·영상·오디오의 실제 크기·해상도·재생시간·fps·코덱·오디오 유무·SHA-256을 확인한다. 영상 내용을 보았다는 뜻은 아니다.',{path:{type:'string'}},['path']),
 fn('media_checks','로컬 영상의 검정 화면·정지 후보 또는 오디오의 음량(dBFS)을 수치로 점검한다. 최대 600초, 기본 처음 120초. 검정·정지는 의도된 연출일 수 있으므로 시각 검수로 확정하고, 음량 수치로 대사 내용·믹싱·립싱크를 이해했다고 주장하지 않는다.',{path:{type:'string'},check:{type:'string',enum:['video_gaps','audio_levels']},...range,minimum_duration:{type:'number',minimum:0.1,maximum:10}},['path','check']),
 fn('media_export','로컬 영상 구간 추출(trim_video), 작은 재생 미리보기(preview_video), 무손실 WAV 오디오 추출(extract_audio). 최대 600초. 원본을 바꾸지 않고 새 파일에 저장한다. 영상은 H.264/AAC로 인코딩하며 AI 생성이나 외부 업로드를 하지 않는다.',{path:{type:'string'},operation:{type:'string',enum:['trim_video','preview_video','extract_audio']},...range},['path','operation'])
];}
function run(executable,args,signal){const bounded=executable==='ffmpeg'?['-threads','2','-filter_threads','1',...args.slice(0,-1),'-threads','2',args.at(-1)]:args;return new Promise((resolve,reject)=>execFile(executable,bounded,{windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024,timeout:600000,signal},(e,stdout,stderr)=>e?reject(new Error(`${executable}: ${(stderr||e.message).slice(-900)}`)):resolve({stdout,stderr})));}
function source(input,ctx){const file=require('./tools').expandSources(input,ctx)[0];if(!file||!fs.statSync(file).isFile())throw new Error('미디어 파일을 찾을 수 없습니다.');if(fs.statSync(file).size>2*1024*1024*1024)throw new Error('미디어는 2GB 이하로 준비하세요.');return require('./tools').resolvePath(file,ctx,'read');}
async function probe(file,signal){return JSON.parse((await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration,size,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels','-of','json',file],signal)).stdout);}
function interval(meta,args){const duration=Number(meta.format?.duration);if(!Number.isFinite(duration)||duration<=0)throw new Error('재생시간이 있는 영상·오디오가 필요합니다.');const start=args.start_seconds??0,end=args.end_seconds??Math.min(duration,start+120);if(start>=duration||end>duration+0.05||end<=start||end-start>600)throw new Error('구간은 미디어 길이 안에서 최대 600초로 지정하세요.');return{start,end:Math.min(duration,end),duration:Math.min(duration,end)-start};}
async function info(args,ctx){const file=source(args.path,ctx);const meta=await probe(file,ctx.signal);return{text:JSON.stringify({path:file,bytes:fs.statSync(file).size,sha256:await require('./tools-extra').sha256File(file),...meta,visualContentReviewed:false,audioContentReviewed:false})};}
async function checks(args,ctx){const file=source(args.path,ctx),meta=await probe(file,ctx.signal),window=interval(meta,args);const input=['-hide_banner','-nostdin','-ss',String(window.start),'-t',String(window.duration),'-protocol_whitelist','file,pipe','-i',file];let result;
 if(args.check==='audio_levels'){
  if(!meta.streams.some(s=>s.codec_type==='audio'))throw new Error('오디오 트랙이 없습니다.');
  const {stderr}=await run('ffmpeg',[...input,'-vn','-af','volumedetect','-f','null','-'],ctx.signal);const mean=stderr.match(/mean_volume:\s*([+-]?(?:[\d.]+|inf))\s*dB/),peak=stderr.match(/max_volume:\s*([+-]?(?:[\d.]+|inf))\s*dB/);
  if(!mean||!peak)throw new Error('음량 수치를 확인하지 못했습니다.');result={meanDbfs:mean[1],peakDbfs:peak[1],nearFullScale:Number(peak[1])>=-0.1,meaning:'수치 기반 음량 검사이며 음성 내용·대사 균형·립싱크 판정이 아닙니다.'};
 }else{
  if(!meta.streams.some(s=>s.codec_type==='video'))throw new Error('영상 트랙이 없습니다.');const d=args.minimum_duration??0.5;
  const {stderr}=await run('ffmpeg',[...input,'-an','-vf',`scale=320:-2,blackdetect=d=${d}:pix_th=0.08:pic_th=0.98,freezedetect=n=0.001:d=${d}`,'-f','null','-'],ctx.signal);
  const black=[...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)].map(m=>({startSeconds:Number(m[1])+window.start,endSeconds:Number(m[2])+window.start,durationSeconds:Number(m[3])}));
  const starts=[...stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map(m=>Number(m[1]));const ends=[...stderr.matchAll(/freeze_end:\s*([\d.]+)/g)].map(m=>Number(m[1]));const frozen=starts.map(start=>({startSeconds:window.start+start,endSeconds:window.start+(ends.find(end=>end>=start)??window.duration)}));
  result={blackIntervals:black.slice(0,100),freezeCandidates:frozen.slice(0,100),truncated:black.length>100||frozen.length>100,meaning:'검정 화면·정지는 정상 연출일 수 있습니다. 해당 시각을 inspect_video로 확인한 뒤 판단하세요.'};
 }
 return{text:JSON.stringify({source:path.basename(file),check:args.check,coverage:{startSeconds:window.start,endSeconds:window.end},...result})};
}
async function exportMedia(args,ctx){
 const file=source(args.path,ctx),meta=await probe(file,ctx.signal),window=interval(meta,args),audio=args.operation==='extract_audio';const video=meta.streams.find(s=>s.codec_type==='video');
 if(audio&&!meta.streams.some(s=>s.codec_type==='audio'))throw new Error('추출할 오디오 트랙이 없습니다.');if(!audio&&!video)throw new Error('영상 트랙이 없습니다.');
 const before=await require('./tools-extra').sha256File(file);const directory=audio?ctx.store.dirs.uploads:ctx.store.dirs.videos;fs.mkdirSync(directory,{recursive:true});
 const name=`${args.operation}_${crypto.randomBytes(12).toString('hex')}${audio?'.wav':'.mp4'}`,dest=path.join(directory,name);let output;
 try{
  const command=['-hide_banner','-loglevel','error','-nostdin','-n','-ss',String(window.start),'-protocol_whitelist','file,pipe','-i',file,'-t',String(window.duration)];
  if(audio)command.push('-vn','-map','0:a:0','-c:a','pcm_s16le');
  else{
   command.push('-map','0:v:0','-map','0:a?');
   if(args.operation==='preview_video'){const portrait=video.height>video.width,w=Math.min(video.width,portrait?720:1280),h=Math.min(video.height,portrait?1280:720);command.push('-vf',`scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`);}
   command.push('-c:v','libx264','-preset','veryfast','-crf',args.operation==='preview_video'?'25':'18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart');
  }
  command.push(dest);await run('ffmpeg',command,ctx.signal);output=await probe(dest,ctx.signal);
  if(await require('./tools-extra').sha256File(file)!==before)throw new Error('처리 중 원본이 바뀌었습니다. 결과를 다시 확인하세요.');
 }catch(error){if(fs.existsSync(dest))fs.rmSync(dest);throw error;}
 const artifact={type:audio?'audio':'video',url:`/files/${audio?'uploads':'videos'}/${name}`,path:dest,bytes:fs.statSync(dest).size,sourceSha256:before,sourceUnchanged:true,operation:args.operation,requestedInterval:window,metadata:output};
 return{text:JSON.stringify(artifact),...(!audio?{videos:[{type:'video',url:artifact.url,model:'로컬 FFmpeg',prompt:'원본 구간 추출 · '+path.basename(file)}]}:{})};
}
async function execute(name,args,ctx){ctx.store.reg.assert('media-utils.schema.json#/$defs/'+name,args);if(name==='media_info')return info(args,ctx);if(name==='media_checks')return checks(args,ctx);return exportMedia(args,ctx);}
module.exports={definitions,execute,probe,interval};
