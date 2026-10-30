'use strict';
// 내장 도구: 이미지 생성, 스킬 로드, 웹 가져오기, 작업 폴더 파일, (선택) PowerShell
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const llm = require('./llm');
const extra = require('./tools-extra');

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } }
});

function definitions(settings, skillCount) {
  const t = settings.tools;
  const defs = [];
  if (settings.imageGen.enabled) {
    defs.push(fn('generate_image',
      '텍스트 프롬프트로 이미지를 생성해 사용자 화면에 보여준다. 프롬프트는 영어로 구체적으로 쓰는 편이 품질이 좋다. 참조 이미지는 가장 최근 사용자 메시지에 첨부된 이미지만 쓸 수 있고, 이전 메시지의 이미지는 전달되지 않는다. 이전 요청에서 했던 수정(색·스타일 등)을 사용자가 다시 말하지 않았다면 이번 프롬프트에 합치지 않는다.',
      {
        prompt: { type: 'string', description: '이미지 생성 프롬프트' },
        size: { type: 'string', description: '예: "2K", "4K", "2048x2048", "1728x2304"(세로), "2560x1440"(가로). 생략하면 기본값' },
        use_attached_images: { type: 'boolean', description: '이번 메시지의 첨부 이미지를 참조 이미지로 사용할지 여부' },
        reference_images: { type: 'array', items: { type: 'string' }, description: '참조 이미지 경로 목록. crop_panels 나 이전 generate_image 결과로 받은 "/files/images/..." 경로를 그대로 넣는다' },
        new_variant: { type: 'boolean', description: '같은 프롬프트·참조로 이미 만든 결과가 있어도 새로 만든다 (기본 false: 이미 만든 결과를 비용 없이 재사용)' }
      }, ['prompt']));
  }
  if (process.platform === 'win32') {
    defs.push(fn('script_sheet',
      '웹툰 컷별 대본 시트를 파일로 저장하거나(save) 다시 읽는다(read). 원본 컷 이미지에서 직접 읽은 나레이션·말풍선 대사(화자+원문)·효과음·감정·액션을 컷마다 담는다. 저장하면 대사 음절 수 ÷ 발화 속도로 컷마다 영상 길이(초)를 계산해 돌려준다 — 이 값을 bao_canvas_wire_video_batch 의 duration 에 넣는다. 파일은 대화가 바뀌어도 남는 1차 자료다. 프롬프트 노드나 인계서에서 대사를 옮기지 않는다.',
      {
        action: { type: 'string', enum: ['save', 'read'] },
        work: { type: 'string', description: '작품명 (예: 밈고사성어)' },
        episode: { type: 'string', description: '회차·원본 번호 (예: 01)' },
        source: { type: 'string', description: '원본 이미지 경로' },
        tone: { type: 'string', enum: ['calm', 'epic', 'normal', 'fast'], description: '기본 발화 톤: calm 정적·감성 3.0 / epic 장엄·서사 3.8(기본) / normal 일반 대화 4.5 / fast 다급·액션 5.2 음절/초' },
        cuts: { type: 'array', description: 'save 일 때 컷 목록 (읽는 순서대로)', items: { type: 'object', properties: {
          cut: { type: 'string' }, original: { type: 'string', description: '원본 컷 경로' }, context: { type: 'string', description: '앞→현재→뒤 흐름에서의 위치' }, picture: { type: 'string' },
          narration: { type: 'string', description: '나레이션·캡션 원문 그대로' },
          dialogue: { type: 'array', items: { type: 'object', properties: { speaker: { type: 'string' }, text: { type: 'string', description: '말풍선 원문 그대로' } }, required: ['text'] } },
          sfx: { type: 'string' }, emotion: { type: 'string' }, action: { type: 'string' },
          tone: { type: 'string', enum: ['calm', 'epic', 'normal', 'fast'] }, extra_seconds: { type: 'number', description: '연출 여유 초 (카메라 무브·액션이 길 때). 기본 1.0, 액션·효과음 없으면 0.5' } }, required: ['cut'] } }
      }, ['action', 'work', 'episode']));
    defs.push(fn('convert_panels',
      '원본 웹툰 숏을 작품별 지정 비율로 편집하고 원본과 대조한다. aspect_ratio를 반드시 지정하며 기존 작품의 승인 비율을 유지한다. 다음 작품에도 같은 비율을 임의로 강제하지 않는다. 개별 숏 비율과 패킹 시트 전체 비율은 별개다. 원본 인물·화풍·구도를 유지하고 말풍선·캡션·효과음만 제거하며 장면 속 필수 글자는 보존한다. 새 스토리보드를 그리는 도구가 아니다. 원문 대사는 먼저 대본 시트에 보존한다. 실제 결과 비율과 누락·변형을 검수한다. 여러 컷은 병렬 처리한다. 유료(이미지 생성).',
      {
        images: { type: 'array', items: { type: 'string' }, description: 'crop_panels 로 자른 원본 컷 경로들 ("/files/images/..."), 읽는 순서대로' },
        aspect_ratio: { type: 'string', enum: ['9:16', '16:9', '1:1'], description: '작품에서 승인된 개별 숏 비율. 패킹 시트의 전체 비율과 별개. 현재 작품은 16:9. 다음 작품은 새 지시에 맞춘다. 생략 금지.' },
        preserve_text: { type: 'array', items: { type: 'string' }, description: '보존할 장면 속 글자(간판·댓글·알림 등). 말풍선·캡션·효과음과 구별한다.' },
        extra_prompt: { type: 'string', description: '원본 보존 편집 지시에 추가할 지시 (선택)' },
        focus: { type: 'string', description: '검수 때 특히 볼 것 (예: 주인공 머리색 은발, 빨간 도포)' },
        max_attempts: { type: 'integer', minimum: 1, maximum: 5, description: '컷당 최대 생성 횟수 (기본 설정값 3)' }
      }, ['images', 'aspect_ratio']));
    defs.push(fn('check_conversion',
      '변환본 이미지를 원본 컷과 대조해 검수만 한다 (빠진 것·바뀐 것·새로 생긴 것·글자 잔재·형태 깨짐). 합격/불합격, 점수, 문제 목록, 재생성 보정 지시를 돌려준다.',
      { original: { type: 'string' }, result: { type: 'string' }, aspect_ratio: { type: 'string', enum: ['9:16', '16:9', '1:1'] }, preserve_text: { type: 'array', items: { type: 'string' } }, focus: { type: 'string' } }, ['original', 'result', 'aspect_ratio']));
    defs.push(fn('crop_panels',
      '웹툰·만화 이미지의 구조(세로 스크롤 / 격자형 N열 / 출판 만화)를 먼저 판정하고, 컷(패널)별로 잘라 각각 PNG 로 저장해 사용자 화면에 보여준다. 결과는 읽는 순서대로 번호가 붙는다. 최초 패널 후보는 이 도구로 만들고 실제 결과 이미지와 원본 경계를 검수한다. 잘못된 후보는 원본 구간을 확대해 경계를 확인한 뒤 edit_image의 crop과 unit:px로 해당 영역만 보정할 수 있다. 이미지를 보지 않은 좌표 추측은 금지한다. 결과 컷 수가 expected 와 다르면 mode·min_gap 을 바꿔 한 번 더 시도하고, 그래도 다르면 사용자에게 보고한다. 컷 사이의 흰색·검은색 여백과 테두리선을 깎아 그림 부분만 남기고, 글자 상자·그라데이션 제외는 keep_text_boxes 설정에 따르며, 원본/대본 판독 단계에는 true로 출처를 보존한다. 그림 속 단색 영역을 여백으로 오인하지 않았는지 검수한다. 무료 로컬 작업. 결과로 받은 각 컷 경로를 generate_image 의 reference_images 에 넣어 16:9 변환 등에 쓸 수 있다.',
      {
        preserve_bounds: { type: 'boolean', description: 'true: 원본 판독용 보수적 후보. 단색 배경을 새 여백색으로 벗기거나 잉크 밀도만으로 인물/가장자리를 깎지 않는다. 원본 대조 검수는 여전히 필요하다. 기존 방식은 생략 또는 false.' },
        image: { type: 'string', description: '자를 이미지: 이번 메시지 첨부 파일 이름 또는 "/files/..." 경로. 생략하면 이번 메시지의 첫 번째 첨부 이미지' },
        mode: { type: 'string', enum: ['auto', 'vertical', 'columns', 'grid'], description: 'auto: 구조를 스스로 판정(기본). vertical: 세로 스크롤 웹툰(위아래로만). columns: 격자형 — 같은 크기 칸이 가로로 2~5개씩 나란한 인스타툰·SNS툰(열 먼저, 줄 다음, 왼→오·위→아래). grid: 출판 만화 페이지(칸 모양이 제각각)' },
        expected: { type: 'integer', description: '작업 지시에 적힌 이미지당 컷 수. 결과와 다르면 경고한다' },
        rtl: { type: 'boolean', description: '오른쪽에서 왼쪽으로 읽는 일본식 만화면 true' },
        keep_text_boxes: { type: 'boolean', description: '글자만 있는 내레이션 상자도 남길지 여부 (기본 false)' },
        min_gap: { type: 'integer', description: '컷 사이 여백으로 인정할 최소 두께(px). 기본 16. 컷이 덜 나뉘면 줄이고, 너무 잘게 나뉘면 늘린다' }
      }));
    defs.push(fn('edit_image',
      '이미지를 그대로 둔 채 픽셀 단위로 손본다: 자르기, 크기 조정, 회전, 반전, 비율에 맞춰 여백 채우기, 밝기·대비·채도 조절. 내용(머리색·말풍선 제거·장면 확장 등)을 바꾸려면 generate_image 를 쓴다. 무료 로컬 작업이며 결과는 새 파일로 저장돼 사용자 화면에 표시된다. operations 는 적힌 순서대로 적용된다.',
      {
        image: { type: 'string', description: '편집할 이미지: 첨부 파일 이름 또는 "/files/..." 경로(crop_panels·generate_image·edit_image 결과). 생략하면 이번 메시지의 첫 번째 첨부 이미지' },
        operations: {
          type: 'array',
          description: '적용할 작업 목록',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['crop', 'resize', 'rotate', 'flip', 'pad', 'adjust'] },
              x: { type: 'number', description: 'crop: 왼쪽 위 x (기본 단위 %)' },
              y: { type: 'number', description: 'crop: 왼쪽 위 y (기본 단위 %)' },
              width: { type: 'number', description: 'crop: 너비(%), resize/pad: 목표 너비(px)' },
              height: { type: 'number', description: 'crop: 높이(%), resize/pad: 목표 높이(px)' },
              unit: { type: 'string', enum: ['percent', 'px'], description: 'crop 좌표 단위. 기본 percent (이미지 대비 %)' },
              fit: { type: 'string', enum: ['contain', 'cover', 'stretch'], description: 'resize: contain=비율 유지해 안에 맞춤, cover=꽉 채우고 넘치는 부분 잘라냄, stretch=늘림' },
              degrees: { type: 'integer', enum: [90, 180, 270], description: 'rotate: 시계 방향 각도' },
              direction: { type: 'string', enum: ['horizontal', 'vertical'], description: 'flip 방향' },
              ratio: { type: 'string', description: 'pad: 목표 비율 (예: "16:9")' },
              color: { type: 'string', description: 'pad: 여백 색 (black, white, gray, #RRGGBB)' },
              brightness: { type: 'number', description: 'adjust: -100~100' },
              contrast: { type: 'number', description: 'adjust: -100~100' },
              saturation: { type: 'number', description: 'adjust: -100~100' }
            },
            required: ['op']
          }
        },
        format: { type: 'string', enum: ['png', 'jpg'], description: '저장 형식. 기본 png' }
      }, ['operations']));
  }
  {
    defs.push(fn('list_skills', '등록된 로컬·외부 스킬을 이름/설명으로 검색한다. 목록에서 생략된 스킬도 조회할 수 있다. 연결이 끊어진 외부 폴더도 알린다.',
      { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 40 } }));
    defs.push(fn('load_skill', '스킬 목록에 있는 스킬의 전체 지침(SKILL.md)을 불러온다. 작업이 스킬 설명과 맞으면 먼저 호출해 지침을 따른다.',
      { name: { type: 'string', description: '스킬 이름' } }, ['name']));
    defs.push(fn('read_skill_file', '스킬 폴더 안의 참고 파일(references/, templates/ 등)을 읽는다.',
      { name: { type: 'string' }, path: { type: 'string', description: 'SKILL.md 기준 상대 경로' } }, ['name', 'path']));
  }
  if (t.enableWorkspace) {
    defs.push(fn('save_skill', '새 스킬을 스킬 폴더에 등록한다 (SKILL.md 작성). 등록 즉시 load_skill 로 불러올 수 있고, 다음 대화부터 스킬 목록에도 나온다. write_file 로 작업 폴더에 만든 뒤 옮겨 달라고 하지 말고 이 도구를 바로 쓴다.',
      {
        name: { type: 'string', description: '영문 소문자·숫자·하이픈만 (예: "webtoon-animation-bao"). 폴더 이름이 된다' },
        description: { type: 'string', description: '이 스킬을 언제 써야 하는지. 모델이 스킬 목록에서 이 설명만 보고 고른다' },
        body: { type: 'string', description: 'SKILL.md 본문 (마크다운, 프런트매터 제외)' }
      }, ['name', 'description', 'body']));
    defs.push(fn('write_skill_file', '등록된 로컬·외부 스킬의 참고 파일을 추가하거나 수정한다. 기존 파일은 read_skill_file로 읽은 원문을 expected_content에 넣는다. 수정 전 원문은 자동 보관한다.',
      { name: { type: 'string' }, path: { type: 'string', description: '스킬 기준 상대 경로' }, content: { type: 'string' }, expected_content: { type: 'string', description: '덮어쓸 파일의 최신 원문. 기존 파일에 필수' } }, ['name', 'path', 'content']));
    defs.push(fn('edit_skill_file', '등록된 로컬·외부 스킬을 부분 수정한다. 먼저 read_skill_file로 SKILL.md 또는 참고 파일 원문을 읽는다. old_text가 정확히 한 번 나오는 경우만 교체하고 나머지 내용과 수정 전 원문을 보존한다.',
      { name: { type: 'string' }, path: { type: 'string', description: 'SKILL.md 또는 스킬 기준 상대 경로' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['name', 'path', 'old_text', 'new_text']));
  }
  if (t.enableFetch) {
    defs.push(fn('fetch_url', '웹 페이지나 API 응답을 가져와 텍스트로 돌려준다. HTML은 본문 텍스트만 추린다.',
      { url: { type: 'string' }, max_chars: { type: 'integer', description: '최대 글자 수 (기본 20000)' } }, ['url']));
  }
  if (t.enableWorkspace) {
    defs.push(fn('list_files', '폴더의 파일 목록을 본다(최신순). 작업 폴더, 허용 폴더, 앱 이미지 폴더("/files/images"), 첨부 폴더("/files/uploads")를 볼 수 있다. 이름에 * 를 쓰면 걸러 본다(예: "/files/images/cut_*.png").',
      { path: { type: 'string', description: '상대 경로(작업 폴더 기준), 허용된 절대 경로, 또는 "/files/images" 같은 앱 경로. 생략하면 작업 폴더' } }));
    defs.push(fn('read_file', '텍스트 파일을 읽는다. 경로 규칙은 list_files 와 같다.',
      { path: { type: 'string' } }, ['path']));
    defs.push(fn('write_file', '텍스트 파일을 만들거나 덮어쓴다. 상대 경로는 작업 폴더 기준이고, 절대 경로면 data 폴더(D:\\FlashStudio\\data) 전체 어디든 쓸 수 있다(단 settings.json 등 앱이 직접 관리하는 파일은 제외). 스킬은 이 도구 대신 save_skill을 쓴다. 부분 수정은 edit_file.',
      { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']));
    defs.push(fn('copy_files',
      '파일(이미지 등 바이너리 포함)을 다른 폴더로 복사하거나 이동한다. 원본은 앱 경로("/files/images/..."), 첨부 파일 이름, 작업 폴더 상대 경로, 절대 경로 모두 가능하고 이름에 * 를 쓰면 여러 개를 한 번에 고른다. 대상은 작업 폴더, 설정의 허용 폴더, 또는 data 폴더(D:\\FlashStudio\\data) 안 절대 경로 어디든 가능하다(settings.json 등 앱 관리 파일은 제외). 앱 이미지·첨부 폴더의 원본은 대화 화면에 쓰이므로 move 여도 복사만 한다.',
      {
        sources: { type: 'array', items: { type: 'string' }, description: '원본 목록. 예: ["/files/images/cut_20260928_ab12_*.png"], ["webtoon.png"]' },
        destination: { type: 'string', description: '대상 폴더. 작업 폴더 기준 상대 경로(예: "bao/17cuts") 또는 허용된 절대 경로. 없으면 만든다' },
        move: { type: 'boolean', description: 'true 면 이동(원본 삭제), 기본 false(복사)' },
        overwrite: { type: 'boolean', description: '같은 이름이 있으면 덮어쓸지. 기본 false(뒤에 번호를 붙임)' }
      }, ['sources', 'destination']));
  }
  defs.push(...extra.definitions(settings));
  if (t.enableShell) {
    defs.push(fn('run_command', 'Windows PowerShell 명령을 작업 폴더에서 실행하고 출력을 돌려준다. 최대 120초.',
      { command: { type: 'string' } }, ['command']));
  }
  return defs;
}

const WRITE_TOOLS = new Set(['write_file', 'run_command', 'copy_files', 'save_skill', 'write_skill_file', 'edit_skill_file']);

function needsApproval(name, settings, mcpHit, args) {
  if (settings.tools.approval === 'auto') return false;
  if (mcpHit) {
    if (mcpHit.cfg.autoApprove) return false;
    if ((mcpHit.cfg.alwaysAllow || []).includes(mcpHit.tool)) return false;
    return true;
  }
  return WRITE_TOOLS.has(name) || extra.needsApproval(name, args);
}

// mode: 'read' = data 폴더 전체 + 허용 폴더, 'write'/'dest' = data 폴더 전체(+dest 는 허용 폴더도) — 단 앱이 직접 관리하는 파일은 RESERVED 로 막는다
function allowedRoots(ctx, mode = 'read') {
  const data = ctx.store.data;
  const extra = ctx.settings.tools.allowedDirs || [];
  const skillDirs = mode === 'read' ? (ctx.skills?.list() || []).map(skill => skill.dir) : [];
  const list = mode === 'write' ? [data] : mode === 'dest' ? [data, ...extra] : [data, ...extra, ...skillDirs];
  return list.map((d) => path.resolve(d));
}

// data 폴더 바로 아래에서 앱이 직접 검증·저장하는 파일·폴더. 도구가 직접 쓰거나 지우면 앱이 깨질 수 있어 막는다
const RESERVED = ['settings.json', 'mcp.json', 'prompts.json', 'memory.json', 'decisions.json', 'projects.json', 'routines.json', 'queue.json', 'conversations', 'logs', '.cache', '.app-profile', '.browser-profile'];
const APP_DIRS = { images: 'images', uploads: 'uploads' };
const isInside = (full, root) => { const f = full.toLowerCase(), r = root.toLowerCase(); return f === r || f.startsWith(r + path.sep); };
const isReserved = (full, ctx) => RESERVED.some((name) => isInside(full, path.resolve(ctx.store.data, name)));

function resolvePath(p, ctx, mode = 'read') {
  if (mode === true) mode = 'write';
  if (mode === false) mode = 'read';
  const ws = path.resolve(ctx.store.dirs.workspace);
  let raw = String(p || '.').trim();
  // "/files/images/..." 같은 앱 경로를 실제 폴더로 바꾼다
  const m = raw.replace(/\\/g, '/').match(/^\/?files\/(images|uploads)(?:\/(.*))?$/);
  const full = m ? path.resolve(ctx.store.dirs[APP_DIRS[m[1]]], m[2] || '.') : path.resolve(ws, raw);
  const roots = allowedRoots(ctx, mode);
  if (!roots.some((r) => isInside(full, r))) throw new Error(`허용되지 않은 경로입니다: ${full}\n허용 폴더: ${roots.join(', ')}`);
  if (mode === 'read' && fs.existsSync(full) && !roots.some(root => isInside(fs.realpathSync(full), fs.existsSync(root) ? fs.realpathSync(root) : root))) throw new Error('허용 폴더 밖을 가리키는 링크입니다');
  if (mode !== 'read' && isReserved(full, ctx)) throw new Error(`앱이 직접 관리하는 파일·폴더는 도구로 바꿀 수 없습니다: ${full}\n설정은 앱 화면에서, 스킬은 save_skill/write_skill_file로 다루세요.`);
  return full;
}

const globRe = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

// 원본 지정값 하나를 실제 파일 목록으로 (첨부 이름·앱 경로·와일드카드 지원)
function expandSources(spec, ctx) {
  const s = String(spec || '').trim();
  if (!s) return [];
  const byName = [...(ctx.turnAttachments || []), ...(ctx.allAttachments || [])].find((a) => a.name === s);
  if (byName) return [path.join(ctx.store.dirs.uploads, path.basename(byName.file))];
  const full = resolvePath(s, ctx, 'read');
  const base = path.basename(full);
  if (/[*?]/.test(base)) {
    const dir = path.dirname(full);
    if (!fs.existsSync(dir)) return [];
    const re = globRe(base);
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && re.test(e.name)).map((e) => path.join(dir, e.name)).sort();
  }
  return fs.existsSync(full) ? [full] : [];
}

function uniqueTarget(dir, name) {
  let target = path.join(dir, name);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(name), stem = path.basename(name, ext);
  for (let i = 2; ; i++) { target = path.join(dir, `${stem} (${i})${ext}`); if (!fs.existsSync(target)) return target; }
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function saveImage(buf, dir) {
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const isWebp = buf.slice(8, 12).toString() === 'WEBP';
  const ext = isJpg ? 'jpg' : isWebp ? 'webp' : 'png';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const name = `${stamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `/files/images/${name}`;
}


// "/files/images/x.png" 같은 앱 경로를 실제 파일 경로로 바꾼다
function localFileFromUrl(url, ctx) {
  const m = String(url || '').match(/^\/files\/(images|uploads)\/([A-Za-z0-9._-]+)$/);
  if (!m) return null;
  const full = path.join(ctx.store.dirs[m[1]], m[2]);
  return fs.existsSync(full) ? full : null;
}

function mimeOfExt(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
}

function dataUrlOf(file) {
  return `data:${mimeOfExt(file)};base64,${fs.readFileSync(file).toString('base64')}`;
}

// 채팅 비전용 예산. Seedream 생성 참조의 별도 픽셀 예산은 image-generation-input에서 처리한다.
// 웹툰 스크린샷처럼 10MB를 넘는 원본을 그대로 매 요청마다 보내면 공급자 요청 크기 한도(HTTP 413)에 걸리고,
// 가로나 세로 한 변이 공급자의 픽셀 한도(예: 8192)를 넘으면 HTTP 400으로 거부되므로 둘 다 맞춘다.
const VISION_INLINE_BYTES = 1.5 * 1024 * 1024;
const VISION_MAX_MEGAPIXELS = 4_000_000;
const VISION_MAX_SIDE = 8000; // 공급자 한도(8192)보다 여유를 둔 값. 세로로 매우 긴 웹툰 스트립은 면적만 줄이면 한 변이 여전히 넘을 수 있다

async function prepareImageForVision(file, store, signal) {
  const stat = fs.statSync(file);
  const dim = extra.imageSize(file);
  const overSide = dim && Math.max(dim.width, dim.height) > VISION_MAX_SIDE;
  const withinBudget = stat.size <= VISION_INLINE_BYTES && !overSide && (!dim || dim.width * dim.height <= VISION_MAX_MEGAPIXELS);
  if (withinBudget) return { mime: mimeOfExt(file), buffer: fs.readFileSync(file) };

  const areaScale = dim ? Math.sqrt(VISION_MAX_MEGAPIXELS / (dim.width * dim.height)) : 0.5;
  const sideScale = dim ? VISION_MAX_SIDE / Math.max(dim.width, dim.height) : 1;
  const scale = Math.min(1, areaScale, sideScale);
  const w = dim ? Math.max(64, Math.round(dim.width * scale)) : undefined;
  const h = dim ? Math.max(64, Math.round(dim.height * scale)) : undefined;
  const outDir = path.join(store.data, '.cache');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const outPath = path.join(outDir, `vision_${stamp}.jpg`);
  const opsFile = path.join(outDir, `vision_${stamp}.json`);
  fs.writeFileSync(opsFile, JSON.stringify([{ op: 'resize', width: w, height: h, fit: 'stretch' }]), 'utf8');
  try {
    await runPs('edit-image.ps1', ['-InputPath', file, '-OpsFile', opsFile, '-OutPath', outPath, '-Quality', '82'], { store, signal });
    return { mime: 'image/jpeg', buffer: fs.readFileSync(outPath) };
  } finally {
    fs.rmSync(opsFile, { force: true });
    fs.rmSync(outPath, { force: true });
  }
}

// 이미지 지정값을 실제 파일로 찾는다: "/files/..." 경로 → 이번 메시지 첨부 → 이 대화의 이전 첨부
function resolveImage(want, ctx) {
  if (want && want.startsWith('/files/')) return localFileFromUrl(want, ctx);
  if (want && path.isAbsolute(want)) return fs.existsSync(want) ? want : null;
  const turn = (ctx.turnAttachments || []).filter((a) => a.kind === 'image');
  const all = (ctx.allAttachments || []).filter((a) => a.kind === 'image');
  const hit = want ? (turn.find((a) => a.name === want) || [...all].reverse().find((a) => a.name === want)) : turn[0];
  return hit ? path.join(ctx.store.dirs.uploads, path.basename(hit.file)) : null;
}

function runPs(script, args, ctx) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script), ...args,
      '-CacheDir', path.join(ctx.store.data, '.cache')], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), 180000);
    ctx.signal?.addEventListener('abort', () => p.kill(), { once: true });
    p.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
      if (code !== 0 || !line) return reject(new Error((err || out).trim().slice(0, 500) || `종료 코드 ${code}`));
      try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
    });
    p.on('error', reject);
  });
}

async function runEditor(args, ctx) {
  const file = resolveImage(args.image ? String(args.image) : '', ctx);
  if (!file) throw new Error(args.image ? `이미지를 찾을 수 없습니다: ${args.image}` : '편집할 이미지가 없습니다. 이미지를 첨부해 달라고 요청하세요.');
  const ops = Array.isArray(args.operations) ? args.operations.slice(0, 20) : [];
  if (!ops.length) throw new Error('operations 가 비어 있습니다');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const name = `edit_${stamp}_${Math.random().toString(36).slice(2, 6)}.${args.format === 'jpg' ? 'jpg' : 'png'}`;
  const opsFile = path.join(ctx.store.data, '.cache', `${name}.json`);
  fs.mkdirSync(path.dirname(opsFile), { recursive: true });
  fs.writeFileSync(opsFile, JSON.stringify(ops), 'utf8');
  try {
    const r = await runPs('edit-image.ps1', ['-InputPath', file, '-OpsFile', opsFile, '-OutPath', path.join(ctx.store.dirs.images, name)], ctx);
    return { ...r, url: `/files/images/${name}` };
  } catch (e) {
    throw new Error(`이미지 편집 실패: ${e.message}`);
  } finally {
    fs.rmSync(opsFile, { force: true });
  }
}

function runCropper(args, ctx) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'crop-panels.ps1');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const prefix = `cut_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
    const a = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-InputPath', args.file, '-OutDir', ctx.store.dirs.images, '-Prefix', prefix,
      '-Mode', args.mode || 'auto', '-MinGap', String(Math.max(2, Math.min(200, Number(args.min_gap) || 16))),
      '-CacheDir', path.join(ctx.store.data, '.cache')];
    if (args.rtl) a.push('-Rtl');
    if (args.keep_text_boxes) a.push('-KeepText');
    if (args.preserve_bounds) a.push('-PreserveBounds');
    const p = spawn('powershell.exe', a, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), 180000);
    ctx.signal?.addEventListener('abort', () => p.kill(), { once: true });
    p.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
      if (code !== 0 || !line) return reject(new Error(`컷 분할 실패: ${(err || out).trim().slice(0, 500)}`));
      try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
    });
    p.on('error', reject);
  });
}

// ---------------- 생성 결과 재사용 (같은 요청에 두 번 돈 내지 않기) ----------------
// 같은 모델·크기·프롬프트·참조 이미지로 이미 만든 결과가 있으면 새로 생성하지 않고 그 파일을 돌려준다.
// 실행이 겹치거나, 재시작·인계 뒤 같은 컷을 다시 요청해도 비용이 나가지 않는다. new_variant 면 새로 만든다.
let genIndex = null;
const GEN_TTL = 30 * 86400000;
function genIndexFile(ctx) { return path.join(ctx.store.data, '.cache', 'gen-index.json'); }
function loadGenIndex(ctx) {
  if (!genIndex) { try { genIndex = JSON.parse(fs.readFileSync(genIndexFile(ctx), 'utf8')); } catch { genIndex = {}; } }
  return genIndex;
}
function saveGenIndex(ctx) {
  const now = Date.now();
  for (const [k, v] of Object.entries(genIndex)) if (now - v.time > GEN_TTL) delete genIndex[k];
  fs.mkdirSync(path.dirname(genIndexFile(ctx)), { recursive: true });
  fs.writeFileSync(genIndexFile(ctx), JSON.stringify(genIndex));
}
function genKey({ prompt, size, useAttached, references }, ctx) {
  const cfg = ctx.settings.imageGen;
  const h = crypto.createHash('sha1');
  h.update([cfg.providerId, cfg.model, size || cfg.size, String(prompt).trim()].join('\u0000'));
  for (const d of useAttached ? ctx.turnImages || [] : []) h.update(crypto.createHash('sha1').update(d).digest('hex'));
  for (const ref of references || []) {
    const file = resolveImage(String(ref), ctx);
    if (file) { const st = fs.statSync(file); h.update(`${path.basename(file)}:${st.size}`); } else h.update(String(ref));
  }
  return h.digest('hex');
}
// 이미 만든 결과가 있으면 그 목록, 없으면 null
function cachedImage(args, ctx) {
  if (args.new_variant) return null;
  const e = loadGenIndex(ctx)[genKey(args, ctx)];
  if (!e || Date.now() - e.time > GEN_TTL) return null;
  const files = e.urls.map((u) => path.join(ctx.store.dirs.images, path.basename(u)));
  return files.every((x) => fs.existsSync(x)) ? e : null;
}

// 예전에 만든 결과를 재사용 목록에 올린다 (대화 기록에서 되살릴 때)
function rememberImage(args, urls, requestId, ctx) {
  loadGenIndex(ctx)[genKey(args, ctx)] = { urls, requestId, time: Date.now() };
  saveGenIndex(ctx);
}

async function runImage({ prompt, size, useAttached, references, new_variant }, ctx) {
  const hit = cachedImage({ prompt, size, useAttached, references, new_variant }, ctx);
  if (hit) {
    const out = hit.urls.map((url) => ({ type: 'image', url, prompt, model: ctx.settings.imageGen.model, ...(hit.requestId ? { requestId: hit.requestId } : {}) }));
    out.reused = true;
    return out;
  }
  const made = await runImageFresh({ prompt, size, useAttached, references }, ctx);
  try {
    loadGenIndex(ctx)[genKey({ prompt, size, useAttached, references }, ctx)] = { urls: made.map((m) => m.url), requestId: made[0] && made[0].requestId, time: Date.now() };
    saveGenIndex(ctx);
  } catch { /* 캐시 실패는 무시 */ }
  return made;
}

async function runImageFresh({ prompt, size, useAttached, references }, ctx) {
  const cfg = ctx.settings.imageGen;
  if (!cfg.enabled) throw new Error('설정에서 이미지 생성이 꺼져 있습니다');
  const provider = ctx.store.getProvider(cfg.providerId);
  const refs = (useAttached ? ctx.turnImages || [] : []).map(dataUrl => ({ dataUrl }));
  for (const r of references || []) {
    const f = resolveImage(String(r), ctx);
    if (!f) throw new Error(`참조 이미지를 찾을 수 없습니다: ${r}`);
    refs.push({ file: f });
  }
  const prepared = await require('./image-generation-input').prepareReferences(refs, ctx, {
    imageSize: extra.imageSize, dataUrlOf, runPs
  });
  const { buffers, requestId } = await llm.generateImage({
    provider, model: cfg.model, prompt, size: size || cfg.size, images: prepared.images, watermark: cfg.watermark, extraBody: cfg.extraBody, signal: ctx.signal,
    meta: ctx.meta || {}
  });
  const made = buffers.map((b) => ({ type: 'image', url: saveImage(b, ctx.store.dirs.images), prompt, model: cfg.model, ...(requestId ? { requestId } : {}) }));
  made.referenceAdjustments = prepared.adjustments;
  return made;
}

function runShell(command, cwd, signal) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`], { cwd, windowsHide: true });
    let out = '';
    const add = (d) => { out += d.toString('utf8'); if (out.length > 200000) out = out.slice(-200000); };
    p.stdout.on('data', add); p.stderr.on('data', add);
    const timer = setTimeout(() => p.kill(), 120000);
    signal?.addEventListener('abort', () => p.kill(), { once: true });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
  });
}

// 반환: { text, isError, images: [part] }
async function execute(name, args, ctx) {
  switch (name) {
    case 'generate_image': {
      const references = Array.isArray(args.reference_images) ? args.reference_images.slice(0, 10) : [];
      const images = await runImage({ prompt: String(args.prompt || ''), size: args.size, useAttached: !!args.use_attached_images, references, new_variant: !!args.new_variant }, ctx);
      const rid = images.find((i) => i.requestId)?.requestId;
      if (images.reused) return { text: `같은 프롬프트·참조로 이미 만든 이미지가 있어 새로 생성하지 않고 재사용했습니다 (비용 없음). 파일: ${images.map((i) => i.url).join(', ')}. 다른 결과가 꼭 필요할 때만 new_variant=true 로 다시 부른다.`, images };
      const prep = (images.referenceAdjustments || []).map(a => `참조 ${a.reference}: ${a.original.width}×${a.original.height} → ${a.sent.width}×${a.sent.height} (공급자 픽셀 한도에 맞춘 전송용 사본, 원본 보존)`).join('; ');
      return { text: `이미지 ${images.length}장을 생성해 사용자 화면에 표시했습니다. 파일: ${images.map((i) => i.url).join(', ')}${rid ? ` (Request ID: ${rid})` : ''}${prep ? '\n' + prep : ''}`, images };
    }
    case 'edit_image': {
      const r = await runEditor(args, ctx);
      return {
        text: `편집한 이미지를 저장해 사용자 화면에 표시했습니다: ${r.url} (${r.width}×${r.height})\n적용: ${(r.steps || []).join(' / ')}`,
        images: [{ type: 'image', url: r.url, prompt: `편집 · ${r.width}×${r.height}` }]
      };
    }
    case 'script_sheet': return require('./script-sheet').run(args, ctx);
    case 'convert_panels': return require('./qa').convertPanels(args, ctx);
    case 'check_conversion': return require('./qa').checkTool(args, ctx);
    case 'crop_panels': {
      const want = args.image ? String(args.image) : '';
      const file = resolveImage(want, ctx);
      if (!file) throw new Error(want ? `이미지를 찾을 수 없습니다: ${want}` : '이번 메시지에 첨부된 이미지가 없습니다. 이미지를 첨부해 달라고 요청하세요.');
      const r = await runCropper({ ...args, file }, ctx);
      const images = r.panels.map((p, i) => ({ type: 'image', url: `/files/images/${p.file}`, prompt: `컷 ${i + 1} · ${p.w}×${p.h}` }));
      const lines = r.panels.map((p, i) => `${i + 1}. /files/images/${p.file}  (원본 좌표 x=${p.x}, y=${p.y}, width=${p.w}, height=${p.h}; 출력 ${p.w}×${p.h}, 비율 ${(p.w / p.h).toFixed(2)})`);
      const layout = r.layout === 'columns' ? `격자형 ${r.columns}열 (열 먼저 나누고 줄을 나눔, ${args.rtl ? '오→왼' : '왼→오'}·위→아래 순서)` : r.layout === 'grid' ? '출판 만화 페이지 (가로세로 여백으로 나눔)' : '세로 스크롤 (위아래로 나눔)';
      const exp = Number(args.expected) || 0;
      const warn = exp && exp !== r.panels.length ? `
⚠️ 예상 컷 수 ${exp}개와 다릅니다 (결과 ${r.panels.length}개). 구조·여백을 확인해 mode나 min_gap을 한 번 보정하고, 여전히 틀리면 원본 경계 확대를 근거로 해당 컷만 edit_image crop(unit:px)로 보정한다. 판독 불확실한 경계는 보고하고 유료 변환에 쓰지 않는다.` : '';
      return {
        text: `구조 판정: ${layout}
원본 ${r.width}×${r.height} 에서 컷 후보 ${r.panels.length}개를 잘랐습니다${args.preserve_bounds ? ' (원본 경계 보존 모드; 실제 이미지 검수 필요)' : ''}${r.textBoxesSkipped ? ` (글자 상자·그라데이션 ${r.textBoxesSkipped}개 제외)` : ''}. 사용자 화면에 모두 표시했습니다.\n${lines.join('\n') || '(찾은 컷 없음 — min_gap 을 줄이거나 mode 를 바꿔 다시 시도)'}${warn}`,
        images
      };
    }
    case 'list_skills': {
      const query = String(args.query || '').toLowerCase();
      const list = ctx.skills.list().filter(skill => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query));
      const offset = Math.max(0, Number(args.offset) || 0), limit = Math.max(1, Math.min(40, Number(args.limit) || 20));
      return { text: JSON.stringify({ skills: list.slice(offset, offset + limit), total: list.length, next_offset: offset + limit < list.length ? offset + limit : null, unavailable_dirs: ctx.skills.unavailableDirs || [] }) };
    }
    case 'load_skill': {
      const s = ctx.skills.read(String(args.name));
      const files = s.files.length ? `\n\n[이 스킬의 참고 파일 — read_skill_file 로 열람]\n${s.files.slice(0, 60).join('\n')}` : '';
      return { text: `# 스킬: ${s.name}\n\n${s.body}${files}` };
    }
    case 'read_skill_file':
      return { text: ctx.skills.readFile(String(args.name), String(args.path)) };
    case 'save_skill': {
      const name = String(args.name || '').trim();
      ctx.skills.create({ name, description: String(args.description || ''), body: String(args.body || '') });
      ctx.skills.scan(ctx.settings.skills.extraDirs, ctx.settings.skills.disabled);
      const s = ctx.skills.get(name);
      return { text: `스킬을 등록했습니다: ${path.join(s.dir, 'SKILL.md')}\nload_skill 로 바로 불러올 수 있고, 참고 파일은 write_skill_file 로 추가합니다.` };
    }
    case 'write_skill_file': {
      const result = ctx.skills.writeFile(String(args.name || ''), String(args.path || ''), String(args.content ?? ''), args.expected_content);
      ctx.skills.scan(ctx.settings.skills.extraDirs, ctx.settings.skills.disabled);
      return { text: JSON.stringify(result) };
    }
    case 'edit_skill_file': {
      const result = ctx.skills.editFile(String(args.name || ''), String(args.path || ''), String(args.old_text || ''), String(args.new_text ?? ''));
      ctx.skills.scan(ctx.settings.skills.extraDirs, ctx.settings.skills.disabled);
      return { text: JSON.stringify(result) };
    }
    case 'fetch_url': {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('http(s) 주소만 가져올 수 있습니다');
      const res = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(25000), ...(ctx.signal ? [ctx.signal] : [])]), headers: { 'user-agent': 'Mozilla/5.0 FlashStudio/1.0' }, redirect: 'follow' });
      const ct = res.headers.get('content-type') || '';
      let text = await res.text();
      if (ct.includes('html')) text = htmlToText(text);
      const max = Math.min(Number(args.max_chars) || 20000, 200000);
      return { text: `HTTP ${res.status} ${ct}\n\n${text.slice(0, max)}${text.length > max ? '\n…(잘림)' : ''}`, isError: !res.ok };
    }
    case 'list_files': {
      let dir = resolvePath(args.path, ctx, 'read');
      let re = null;
      if (/[*?]/.test(path.basename(dir))) { re = globRe(path.basename(dir)); dir = path.dirname(dir); }
      if (!fs.existsSync(dir)) throw new Error(`폴더가 없습니다: ${dir}`);
      const ents = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => !re || re.test(e.name))
        .map((e) => { let st = null; try { st = fs.statSync(path.join(dir, e.name)); } catch { /* 무시 */ } return { e, st }; })
        .sort((a, b) => (b.st?.mtimeMs || 0) - (a.st?.mtimeMs || 0));
      const lines = ents.slice(0, 500).map(({ e, st }) => (e.isDirectory() ? `[폴더] ${e.name}/` : `${e.name} (${(st?.size || 0).toLocaleString()} B)`));
      return { text: `${dir}${re ? ` (필터 ${path.basename(args.path)})` : ''} — ${ents.length}개\n${lines.join('\n') || '(비어 있음)'}${ents.length > 500 ? '\n…(500개까지만 표시)' : ''}` };
    }
    case 'copy_files': {
      const destDir = resolvePath(args.destination, ctx, 'dest');
      fs.mkdirSync(destDir, { recursive: true });
      const move = !!args.move;
      const protectedRoots = [ctx.store.dirs.images, ctx.store.dirs.uploads].map((d) => path.resolve(d));
      const done = [], missing = [], kept = [];
      for (const spec of Array.isArray(args.sources) ? args.sources : [args.sources]) {
        const files = expandSources(spec, ctx);
        if (!files.length) { missing.push(spec); continue; }
        for (const src of files) {
          if (!fs.statSync(src).isFile()) continue;
          const target = args.overwrite ? path.join(destDir, path.basename(src)) : uniqueTarget(destDir, path.basename(src));
          if (path.resolve(src).toLowerCase() === path.resolve(target).toLowerCase()) continue;
          fs.copyFileSync(src, target);
          const appOwned = protectedRoots.some((r) => isInside(path.resolve(src), r));
          if (move && !appOwned) fs.unlinkSync(src);
          if (move && appOwned) kept.push(path.basename(src));
          done.push(`${path.basename(src)} → ${target} (${fs.statSync(target).size.toLocaleString()} B)`);
        }
      }
      if (!done.length) throw new Error(`옮길 파일을 찾지 못했습니다: ${missing.join(', ') || '(원본 없음)'}`);
      return {
        text: `${done.length}개 파일을 ${move ? '이동' : '복사'}했습니다 → ${destDir}\n${done.join('\n')}`
          + (kept.length ? `\n\n앱 이미지·첨부 폴더의 원본 ${kept.length}개는 대화 화면에 쓰이므로 지우지 않고 복사만 했습니다.` : '')
          + (missing.length ? `\n\n찾지 못한 원본: ${missing.join(', ')}` : '')
      };
    }
    case 'read_file': {
      const f = resolvePath(args.path, ctx, 'read');
      const buf = fs.readFileSync(f);
      if (buf.includes(0)) return { text: `바이너리 파일이라 텍스트로 읽을 수 없습니다 (${buf.length} B)`, isError: true };
      return { text: buf.toString('utf8') };
    }
    case 'write_file': {
      const f = resolvePath(args.path, ctx, 'dest');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, String(args.content ?? ''), 'utf8');
      return { text: `저장했습니다: ${f} (${Buffer.byteLength(String(args.content ?? ''))} B)` };
    }
    case 'run_command': {
      if (!ctx.settings.tools.enableShell) throw new Error('설정에서 명령 실행이 꺼져 있습니다');
      // 터미널 패널에 기록되도록 공용 터미널로 실행한다 (없으면 기존 방식)
      const r = ctx.terminal
        ? await ctx.terminal.run(String(args.command || ''), { cwd: ctx.store.dirs.workspace, signal: ctx.signal, source: 'model', convId: ctx.meta && ctx.meta.conversationId })
        : await runShell(String(args.command || ''), ctx.store.dirs.workspace, ctx.signal);
      return { text: `종료 코드 ${r.code}\n${r.out}`, isError: r.code !== 0 };
    }
    default: {
      const r = await extra.execute(name, args, ctx);
      if (r) return r;
      throw new Error(`알 수 없는 도구: ${name}`);
    }
  }
}

// MCP tools/call 결과를 텍스트 + 이미지로 변환
function fromMcpResult(result, ctx) {
  const texts = [];
  const images = [];
  for (const c of result?.content || []) {
    if (c.type === 'text') texts.push(c.text);
    else if (c.type === 'image' && c.data) {
      images.push({ type: 'image', url: saveImage(Buffer.from(c.data, 'base64'), ctx.store.dirs.images), prompt: '(MCP 도구 결과)' });
      texts.push('[이미지 1장 — 사용자 화면에 표시됨]');
    } else if (c.type === 'resource') texts.push(c.resource?.text ?? `[리소스] ${c.resource?.uri || ''}`);
    else if (c.type === 'resource_link') texts.push(`[리소스 링크] ${c.name || ''} ${c.uri || ''}`);
    else if (c.type === 'audio') texts.push('[오디오 결과]');
  }
  if (result?.structuredContent && !texts.length) texts.push(JSON.stringify(result.structuredContent, null, 2));
  return { text: texts.join('\n\n') || '(빈 결과)', isError: !!result?.isError, images };
}

extra.bind({ resolvePath, expandSources, globRe, uniqueTarget, saveImage });

module.exports = { cachedImage, rememberImage, definitions, execute, needsApproval, fromMcpResult, runImage, saveImage, resolvePath, expandSources, prepareImageForVision, resolveImage, runPs };
