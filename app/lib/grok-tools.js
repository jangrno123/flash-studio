'use strict';
const path=require('node:path');
const {getGrok}=require('./grok-media');
const fn=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const shared={prompt:{type:'string',description:'이번 생성의 전체 연출 지시'},reference_images:{type:'array',items:{type:'string'},description:'첨부 이미지 또는 /files/images/... 경로. 원본을 그대로 참조한다.'},aspect_ratio:{type:'string',enum:['1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9']},new_variant:{type:'boolean',description:'명시적으로 새 결과가 필요할 때만 true. 기본은 기존 같은 작업 재사용.'}};
function definitions(settings){if(!settings.grok?.enabled)return[];return[
 fn('grok_generate_image','Grok 구독 로그인으로 이미지 1장을 생성하거나 참조 이미지를 편집한다. 해상도는 Grok 기본 출력이며 실제 크기를 결과에서 확인한다. 별도 API 과금이나 다른 공급자 대체가 없다. 작업 ID를 받으면 grok_job_status로 조회하거나 poll_until을 쓴다. 같은 요청은 자동 중복 생성하지 않는다.',shared,['prompt']),
 fn('grok_generate_video','Grok 구독으로 영상 1개를 백그라운드 생성한다. 이미지 1장은 첫 프레임, 여러 장은 참조 이미지다. 참조가 없으면 시작 이미지를 1장 먼저 생성한다. 별도 API 과금이 없으며 구독 한도를 쓴다. 반환된 작업을 grok_job_status로 조회하고 새로 제출하지 않는다.',{...shared,duration:{type:'integer',enum:[6,10]},resolution:{type:'string',enum:['480p','720p']}},['prompt']),
 fn('grok_job_status','이미 접수한 Grok 생성 상태·저장 파일을 조회한다. 생성이나 재제출을 하지 않는다. 완료 상태는 succeeded, 실패는 failed, 취소는 canceled.',{job_id:{type:'string'}},['job_id']),
 fn('grok_cancel_job','사용자가 취소하라고 한 Grok 작업을 중지한다.',{job_id:{type:'string'}},['job_id']),
 fn('grok_connection_status','Grok CLI 설치·구독 연결 상태를 조회한다. 모델이나 생성 호출은 하지 않는다.')
];}
function references(args,ctx){return(args.reference_images||[]).map(input=>{const file=require('./tools').resolveImage(String(input),ctx);if(!file)throw new Error('참조 이미지를 찾을 수 없습니다: '+input);return file;});}
function result(job){return{text:JSON.stringify(job),...(job.status==='succeeded'?{images:job.artifacts.filter(a=>a.type==='image').map(a=>({type:'image',url:a.url,prompt:a.prompt,model:a.model})),videos:job.artifacts.filter(a=>a.type==='video').map(a=>({type:'video',url:a.url,prompt:a.prompt,model:a.model}))}:{}),isError:job.status==='failed'};}
async function execute(name,args,ctx){const manager=getGrok(ctx.store);if(name==='grok_connection_status')return{text:JSON.stringify(await manager.status())};if(name==='grok_job_status')return result(manager.get(args.job_id));if(name==='grok_cancel_job')return result(manager.cancel(args.job_id));const kind=name==='grok_generate_video'?'video':'image';const job=manager.start({...args,kind,reference_images:references(args,ctx)});return result(job);}
async function runImage(args,ctx){
 const refs=references({reference_images:args.references||[]},ctx);
 if(args.useAttached)for(const attachment of ctx.turnAttachments||[])if(attachment.kind==='image')refs.push(path.join(ctx.store.dirs.uploads,path.basename(attachment.file)));
 if(args.useAttached&&!refs.length&&(ctx.turnImages||[]).length)throw new Error('Grok 편집은 원본 첨부 파일이 필요합니다. 이미지를 다시 첨부하세요.');
 const manager=getGrok(ctx.store),size=String(args.size||ctx.settings.imageGen.size||'2K');
 const ratio=size.match(/^(\d+)x(\d+)$/i);const aspect_ratio=ratio?(Number(ratio[1])>Number(ratio[2])?'16:9':Number(ratio[1])<Number(ratio[2])?'9:16':'1:1'):'16:9';
 const job=manager.start({kind:'image',prompt:args.prompt,reference_images:refs,aspect_ratio,resolution:'auto',new_variant:!!args.new_variant});
 const complete=await manager.wait(job.id,{signal:ctx.signal});return result(complete).images;
}
module.exports={definitions,execute,runImage,result};
