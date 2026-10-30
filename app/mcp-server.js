#!/usr/bin/env node
'use strict';
// Flash Studio 이미지 기능을 MCP(stdio)로 제공한다: Seedream 이미지 생성, 웹툰 컷 분할, 로컬 이미지 편집.
// OpenCode 등 다른 MCP 클라이언트에서 쓴다. 공급자·모델·크기·API 키는 Flash Studio 설정(data/settings.json)을 따른다.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { SchemaRegistry } = require('./lib/schema');
const { Store } = require('./lib/store');
const tools = require('./lib/tools');
const llm = require('./lib/llm');
const { RequestLog } = require('./lib/requestlog');

const ROOT = path.resolve(__dirname, '..');
const registry = new SchemaRegistry(path.join(ROOT, 'schemas'));
const store = new Store(ROOT, registry);
store.ensure();
const requestLog = new RequestLog(store.dirs.logs, registry);
llm.setRecorder((e) => requestLog.append({ source: 'mcp', ...e }));

const TOOLS = [
  {
    name: 'seedream_generate',
    description: 'Seedream(BytePlus ModelArk)으로 이미지를 생성하거나 참조 이미지를 수정한다. 결과 파일의 절대 경로를 돌려준다. 모델·기본 크기는 Flash Studio 설정을 따른다(기본 Seedream 5.0 Pro, 2048x1152 16:9). 프롬프트는 영어로 구체적으로 쓴다. 참조 이미지를 수정할 때는 무엇을 유지하고 무엇만 바꾸는지 분명히 쓴다.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '이미지 생성·수정 프롬프트' },
        reference_images: { type: 'array', items: { type: 'string' }, description: '참조 이미지의 절대 경로 목록 (최대 10장)' },
        size: { type: 'string', description: '예: "2048x1152"(16:9), "2048x2048"(1:1), "1728x2304"(세로). 생략하면 설정의 기본 크기' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'webtoon_crop_panels',
    description: '웹툰·만화 이미지를 컷(패널)별로 잘라 PNG 로 저장한다. 컷 사이 흰색·검은색 여백과 테두리선을 깎아 그림만 남기고, 글자만 있는 내레이션 상자·그라데이션 띠·브라우저 UI·옆 광고 칸은 뺀다. 무료 로컬 작업. 결과 컷 경로를 seedream_generate 의 reference_images 에 넣어 16:9 변환에 쓸 수 있다.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '자를 이미지의 절대 경로' },
        mode: { type: 'string', enum: ['auto', 'vertical', 'grid'], description: 'vertical: 세로 스크롤 웹툰, grid: 출판 만화 한 페이지, auto: 자동 (기본)' },
        rtl: { type: 'boolean', description: '오른쪽에서 왼쪽으로 읽는 만화면 true' },
        keep_text_boxes: { type: 'boolean', description: '글자만 있는 상자도 남길지 (기본 false)' },
        min_gap: { type: 'integer', description: '컷 사이 여백 최소 두께 px (기본 16). 덜 나뉘면 줄이고, 너무 잘게 나뉘면 늘린다' }
      },
      required: ['image']
    }
  },
  {
    name: 'image_edit',
    description: '이미지를 픽셀 단위로 손본다: 자르기(crop, 좌표 기본 단위 %), 크기 조정(resize), 회전(rotate), 반전(flip), 비율에 맞춰 단색 여백 채우기(pad), 밝기·대비·채도(adjust). 내용 변경(머리색·배경·말풍선 제거·장면 확장)은 seedream_generate 를 쓴다. 무료 로컬 작업, 결과는 새 파일.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '편집할 이미지의 절대 경로' },
        operations: {
          type: 'array',
          description: '순서대로 적용할 작업',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['crop', 'resize', 'rotate', 'flip', 'pad', 'adjust'] },
              x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
              unit: { type: 'string', enum: ['percent', 'px'] },
              fit: { type: 'string', enum: ['contain', 'cover', 'stretch'] },
              degrees: { type: 'integer', enum: [90, 180, 270] },
              direction: { type: 'string', enum: ['horizontal', 'vertical'] },
              ratio: { type: 'string', description: 'pad 비율, 예 "16:9"' },
              color: { type: 'string', description: 'pad 색: black, white, gray, #RRGGBB' },
              brightness: { type: 'number' }, contrast: { type: 'number' }, saturation: { type: 'number' }
            },
            required: ['op']
          }
        },
        format: { type: 'string', enum: ['png', 'jpg'] }
      },
      required: ['image', 'operations']
    }
  }
];

const imagesDir = () => store.dirs.images;
const toAbs = (text) => text
  .replace(/\/files\/images\//g, `${imagesDir()}${path.sep}`)
  .replace(/ 사용자 화면에 (모두 )?표시했습니다\./g, ' 파일로 저장했습니다.')
  .replace(/저장해 사용자 화면에 표시했습니다/g, '저장했습니다')
  .replace(/생성해 사용자 화면에 표시했습니다/g, '생성해 저장했습니다');

function imageContent(url) {
  const file = path.join(imagesDir(), path.basename(url));
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(file).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return { type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType };
}

async function callTool(name, args) {
  // 설정은 호출할 때마다 새로 읽는다 (앱에서 바꾼 모델·크기 반영)
  store.settings = store.readJson(store.files.settings, 'settings.schema.json');
  const ctx = { settings: store.settings, store, skills: null, signal: undefined, turnImages: [], turnAttachments: [], allAttachments: [], meta: { source: 'mcp' } };
  let r;
  if (name === 'seedream_generate') {
    r = await tools.execute('generate_image', { prompt: args.prompt, size: args.size, reference_images: args.reference_images || [] }, ctx);
  } else if (name === 'webtoon_crop_panels') {
    r = await tools.execute('crop_panels', { image: args.image, mode: args.mode, rtl: args.rtl, keep_text_boxes: args.keep_text_boxes, min_gap: args.min_gap }, ctx);
  } else if (name === 'image_edit') {
    r = await tools.execute('edit_image', { image: args.image, operations: args.operations, format: args.format }, ctx);
  } else {
    throw new Error(`알 수 없는 도구: ${name}`);
  }
  const content = [{ type: 'text', text: toAbs(r.text) }];
  // 결과 이미지를 함께 돌려줘서 비전 모델이 확인할 수 있게 한다 (컷이 많으면 경로만)
  const imgs = r.images || [];
  if (imgs.length && imgs.length <= 4) for (const im of imgs) { const c = imageContent(im.url); if (c) content.push(c); }
  return { content, isError: !!r.isError };
}

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const ok = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  try {
    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'flash-studio', version: '1.0.0' } });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        try { return ok(await callTool(msg.params?.name, msg.params?.arguments || {})); }
        catch (e) { return ok({ content: [{ type: 'text', text: `오류: ${e.message}` }], isError: true }); }
      }
      default:
        return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
  }
});
