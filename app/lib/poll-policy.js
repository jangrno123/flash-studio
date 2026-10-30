'use strict';
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])) : value;
const pollKey = (tool,args) => `${tool} ${JSON.stringify(stable(args||{}))}`;
const shortTool = tool => String(tool || '').split('__').pop().split('/').pop();
const objectArgs = value => value && typeof value === 'object' && !Array.isArray(value);
const pollStatusRead = (tool,args) => shortTool(tool) === 'production_read' && args?.operation === 'editor.export_read';
function pollInputError(args, tool) {
  if(shortTool(tool)==='production_read') {
    if(!objectArgs(args)||typeof args.operation!=='string'||!args.operation.trim()||!objectArgs(args.arguments))
      return 'production_read 폴링에는 poll_until.arguments 안에 조회 도구의 전체 입력 {project_id, operation, arguments:{...}}가 필요합니다. project_id는 이 조회 입력의 최상위에 두고, 작업별 필드는 그 안의 arguments에 넣습니다. 기존 작업의 정확한 ID를 확인하고 새 생성·export를 제출하지 마세요.';
    if(args.operation==='editor.export_status')
      return 'editor.export_status는 지원되는 조회 작업이 아닙니다. production_capabilities로 스키마를 확인하고 editor.export_read의 arguments:{editorProjectId,commandId}로 기존 내보내기를 조회하세요. 제공자 render_queue와 editor.export_queue는 별개이며 새 export를 만들지 않습니다.';
  }
  if(args?.operation==='editor.export_read'&&!/^editor_export_[a-f0-9]{64}$/.test(args.arguments?.commandId||''))
    return 'editor.export_read에는 실제 export 결과의 editor_export_ + 64자리 해시 ID가 필요합니다. PLACEHOLDER·pending·mcp_cmd ID로 폴링하지 않습니다. 새 export를 만들지 말고 기존 production_command_status의 result.commandId를 확인하세요.';
  if(args?.operation==='editor.export_read'&&(!objectArgs(args.arguments)||typeof args.arguments.editorProjectId!=='string'||!args.arguments.editorProjectId.trim()||Object.hasOwn(args.arguments,'project_id')))
    return 'editor.export_read의 내부 arguments에는 정확한 editorProjectId와 commandId가 필요합니다. project_id는 production_read 조회 입력의 최상위에 보존하세요. 기존 export ID를 조회하며 새 export를 만들지 않습니다.';
  return '';
}
function pollFailure(result) {
  const text=String(result?.text||'');let data;
  try {data=JSON.parse(text);} catch {}
  const status=String(data?.status||data?.result?.status||data?.command?.status||'').toLowerCase();
  if(['failed','error','rejected','cancelled','canceled','expired','unknown','unverified'].includes(status))
    return {terminal:true,reason:`작업 상태=${status}. 성공이 아니며 자동 재실행하지 않습니다.`};
  const error=data?.error;
  const message=error ? (typeof error==='string'?error:JSON.stringify(error)) : result?.isError ? text : '';
  if(!message)return null;
  const code=message.match(/(?:API|HTTP|status(?:Code)?)\s*[:=]?\s*(4\d\d|5\d\d)\b/i)?.[1];
  const terminal=['400','401','403','404','405','410','422'].includes(code)||/editor_edit_validation_failed|keyframe_out_of_range|command_(?:failed|expired|unknown)/.test(message);
  return {terminal,reason:message,code:code||'tool_error'};
}
module.exports={pollKey,pollStatusRead,pollInputError,pollFailure};
