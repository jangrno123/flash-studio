'use strict';
// 업무용 기본 도구: 파일 관리, 문서 읽기, 웹 검색·다운로드·HTTP(파일 업로드), 계산, 압축, 메모리
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { spawn, execFile } = require('child_process');
const zlib = require('zlib');

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } }
});

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.html': 'text/html', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

// ---------------------------------------------------------------- 정의
function definitions(settings) {
  const t = settings.tools;
  const defs = [];
  if (t.enableWorkspace) {
    defs.push(fn('find_files', '하위 폴더까지 뒤져 이름으로 파일을 찾는다. 예: pattern "*.png", "**/cut_*.png", "보고서*".',
      { path: { type: 'string', description: '찾기 시작할 폴더 (작업 폴더 기준 상대, 허용 절대 경로, "/files/images" 등). 기본 작업 폴더' }, pattern: { type: 'string', description: '파일 이름 패턴 (* ? 사용)' }, max_results: { type: 'integer' } }, ['pattern']));
    defs.push(fn('search_files', '폴더 안 텍스트 파일들의 내용에서 문자열(또는 정규식)을 찾아 "파일:줄번호: 내용" 으로 돌려준다.',
      { path: { type: 'string' }, query: { type: 'string' }, regex: { type: 'boolean' }, file_pattern: { type: 'string', description: '대상 파일 이름 패턴 (예: "*.md")' }, max_results: { type: 'integer' } }, ['query']));
    defs.push(fn('file_info', '파일 정보: 크기(sizeBytes), 수정 시각, MIME(contentType), SHA-256, 이미지면 가로×세로. 업로드 티켓 발급(예: bao 의 assets.prepare_upload_batch)에 필요한 sha256·sizeBytes 를 여기서 구한다. "/files/images/..." 경로와 * 패턴(여러 파일) 가능.',
      { path: { type: 'string', description: '파일 경로 또는 * 패턴' } }, ['path']));
    defs.push(fn('edit_file', '텍스트 파일에서 old_text 를 찾아 new_text 로 바꾼다. old_text 는 파일 안에서 정확히 일치해야 한다.',
      { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_text', 'new_text']));
    defs.push(fn('make_dir', '폴더를 만든다 (중간 폴더 포함).', { path: { type: 'string' } }, ['path']));
    defs.push(fn('rename_path', '파일·폴더 이름을 바꾼다 (같은 폴더 안). 다른 폴더로 옮기려면 copy_files(move) 를 쓴다.',
      { path: { type: 'string' }, new_name: { type: 'string' } }, ['path', 'new_name']));
    defs.push(fn('delete_path', '파일·폴더를 Windows 휴지통으로 보낸다 (영구 삭제 아님). 작업 폴더와 허용 폴더 안에서만.',
      { path: { type: 'string', description: '경로 또는 * 패턴' } }, ['path']));
    defs.push(fn('open_path', '파일·폴더·웹 주소를 사용자 PC에서 연다 (탐색기, 기본 앱, 브라우저).',
      { path: { type: 'string', description: '파일·폴더 경로 또는 http(s) 주소' } }, ['path']));
    defs.push(fn('read_document', '문서 내용을 읽는다. Word(.docx)·PowerPoint(.pptx) 는 텍스트, Excel(.xlsx) 은 시트별 표(탭 구분), PDF 는 페이지를 이미지로 바꿔 보여준다(모델이 이미지로 읽음). 텍스트 파일도 가능.',
      { path: { type: 'string', description: '문서 경로 또는 첨부 파일 이름' }, first_page: { type: 'integer', description: 'PDF 시작 쪽 (기본 1)' }, pages: { type: 'integer', description: 'PDF 쪽 수 (기본 4, 최대 8)' }, sheet: { type: 'string', description: 'Excel 시트 이름 (생략하면 전부)' } }, ['path']));
    defs.push(fn('zip_files', '파일·폴더를 zip 으로 묶는다.',
      { sources: { type: 'array', items: { type: 'string' } }, destination: { type: 'string', description: '만들 zip 경로 (예: "납품/컷모음.zip")' } }, ['sources', 'destination']));
    defs.push(fn('list_archive', 'ZIP·TAR·TGZ 등 압축 안의 파일 이름·크기·종류를 해제 없이 읽는다. PowerShell Archive 모듈을 사용하지 않는다. 큰 압축은 offset/max_results로 나눠 읽고 필요한 members만 해제한다.',
      {path:{type:'string'},offset:{type:'integer',minimum:0},max_results:{type:'integer',minimum:1,maximum:200}},['path']));
    defs.push(fn('unzip_file', 'ZIP·TAR·TGZ 압축을 허용된 로컬 폴더에 푼다. 모듈 설치가 필요 없다. members를 주면 그 파일만 해제한다. 기존 다른 파일은 덮어쓰지 않고, 동일한 ZIP 파일은 재사용한다. 해제한 이미지·영상은 inspect_image/inspect_video로 읽는다.',
      { path: { type: 'string' }, destination: { type: 'string' },members:{type:'array',items:{type:'string'}} }, ['path', 'destination']));
  }
  if (t.enableWeb) {
    defs.push(fn('web_search', '웹 검색 결과(제목·주소·요약)를 돌려준다. 자세한 내용은 fetch_url 로 연다.',
      { query: { type: 'string' }, max_results: { type: 'integer', description: '기본 8' } }, ['query']));
    defs.push(fn('download_file', 'URL 의 파일을 내려받아 저장한다 (이미지·영상·문서 등 바이너리 가능).',
      { url: { type: 'string' }, destination: { type: 'string', description: '저장할 파일 경로 또는 폴더 (기본 작업 폴더 downloads)' } }, ['url']));
    defs.push(fn('http_request',
      'HTTP 요청을 보낸다. API 호출, 업로드 URL 로 파일 전송(PUT/POST 에 body_file), 폼 업로드(multipart)에 쓴다. body_file·multipart 에는 "/files/images/..." 같은 앱 경로나 첨부 이름도 넣을 수 있다. "/api/..." 처럼 상대 주소를 주면 연결된 MCP 서버(예: bao-production)의 주소로 보내고, 그 서버의 인증 헤더를 자동으로 붙인다(토큰 값은 보이지 않음). 업로드 티켓의 토큰은 headers 나 multipart.fields 에 그대로 넣는다. GET/HEAD 외에는 사용자 승인이 필요하다.',
      {
        method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        url: { type: 'string', description: '전체 주소(http/https) 또는 MCP 서버 기준 상대 주소("/api/...")' },
        mcp_server: { type: 'string', description: '상대 주소의 기준이 될 MCP 서버 이름 (예: "bao-production"). 연결된 서버가 하나면 생략 가능' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        json: { description: 'JSON 본문 (content-type: application/json 자동)' },
        body: { type: 'string', description: '문자열 본문' },
        body_file: { type: 'string', description: '파일 내용을 그대로 본문으로 보낸다 (업로드 URL 에 PUT 할 때). content-type 은 확장자로 자동, headers 로 덮어쓰기 가능' },
        multipart: {
          type: 'object',
          description: 'multipart/form-data 업로드',
          properties: {
            fields: { type: 'object', additionalProperties: { type: 'string' } },
            files: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, path: { type: 'string' }, filename: { type: 'string' }, content_type: { type: 'string' } }, required: ['field', 'path'] } }
          }
        },
        save_to: { type: 'string', description: '응답 본문을 파일로 저장할 경로 (바이너리 응답일 때)' },
        timeout_seconds: { type: 'integer', description: '기본 120' }
      }, ['url']));
  }
  if (t.enableCode) {
    defs.push(fn('run_javascript', '자바스크립트를 격리된 환경에서 실행해 계산·데이터 가공을 한다 (파일·네트워크 접근 없음, 10초 제한). 마지막 식의 값 또는 return 값을 돌려주고 console.log 도 모은다. input 으로 데이터를 넘길 수 있다.',
      { code: { type: 'string' }, input: { description: '코드 안에서 input 변수로 쓸 데이터' } }, ['code']));
  }
  if (t.enableMemory) {
    defs.push(fn('memory', '대화가 바뀌어도 유지되는 메모리. 사용자가 기억해 달라고 한 것, 반복해서 쓰일 사실(선호, 프로젝트 정보, 규칙)만 저장한다. 목록은 매번 시스템 프롬프트에 들어간다.',
      { action: { type: 'string', enum: ['add', 'list', 'delete', 'update'] }, text: { type: 'string' }, id: { type: 'string' } }, ['action']));
  }
  return defs;
}

const APPROVAL = new Set(['edit_file', 'make_dir', 'rename_path', 'delete_path', 'zip_files', 'unzip_file', 'download_file']);
function needsApproval(name, args) {
  if (APPROVAL.has(name)) return true;
  if (name === 'http_request') return !['GET', 'HEAD'].includes(String(args?.method || 'GET').toUpperCase());
  return false;
}

// ---------------------------------------------------------------- 공통
let core = null; // tools.js 의 경로 함수 (순환 참조를 피하려고 나중에 주입)
function bind(c) { core = c; }

function walk(dir, visit, depth = 0, state = { n: 0 }) {
  if (depth > 12 || state.n > 20000) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.app-profile')) continue;
    const full = path.join(dir, e.name);
    state.n++;
    if (e.isDirectory()) { if (visit(full, e, true) !== false) walk(full, visit, depth + 1, state); }
    else visit(full, e, false);
  }
}

// "**/cut_*.png" 처럼 경로가 들어간 패턴: ** = 하위 폴더 여러 단계, * = 폴더 구분자 제외 아무 글자
function pathGlobRe(pattern) {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') { src += '(?:.*/)?'; i += 2; }
    else if (c === '*' && pattern[i + 1] === '*') { src += '.*'; i += 1; }
    else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`, 'i');
}

function sha256File(f) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(f).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function imageSize(f) {
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const b = Buffer.alloc(65536);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const kind = b.toString('ascii', 12, 16);
      if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
      if (kind === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < n - 9) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch { /* 무시 */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

function runPsScript(file, args, timeoutMs = 180000, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    signal?.addEventListener('abort', () => p.kill(), { once: true });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((err || out).trim().slice(0, 600) || `종료 코드 ${code}`));
      resolve(out);
    });
    p.on('error', reject);
  });
}

function runPsCommand(command, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${command}`], { windowsHide: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (e, out, err) => {
      if (e) reject(new Error((err || e.message).trim().slice(0, 600)));
      else resolve(out);
    });
  });
}
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---------------------------------------------------------------- zip 읽기 (docx·xlsx·pptx)
function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip 형식이 아닙니다');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    entries.set(name, { method, csize, off });
    p += 46 + nlen + xlen + clen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lnl = buf.readUInt16LE(e.off + 26), lxl = buf.readUInt16LE(e.off + 28);
      const data = buf.subarray(e.off + 30 + lnl + lxl, e.off + 30 + lnl + lxl + e.csize);
      return (e.method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
  };
}

const xmlText = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

function docxText(file) {
  const z = readZip(file);
  const xml = z.read('word/document.xml');
  if (!xml) throw new Error('word/document.xml 이 없습니다');
  return xmlText(xml
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>\s*<\/w:tc>/g, '</w:tc>')           // 칸 안 마지막 문단은 줄을 바꾸지 않는다
    .replace(/<\/w:tc>/g, ' | ').replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n'))
    .replace(/ \| \n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function pptxText(file) {
  const z = readZip(file);
  const slides = z.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/(\d+)\.xml/)[1] - +b.match(/(\d+)\.xml/)[1]);
  return slides.map((n, i) => {
    const xml = z.read(n);
    const text = xmlText(xml.replace(/<\/a:p>/g, '\n').replace(/<a:br\/>/g, '\n')).replace(/\n{2,}/g, '\n').trim();
    return `## 슬라이드 ${i + 1}\n${text}`;
  }).join('\n\n');
}

function xlsxText(file, onlySheet) {
  const z = readZip(file);
  const shared = [];
  const ss = z.read('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  const wb = z.read('xl/workbook.xml') || '';
  const rels = z.read('xl/_rels/workbook.xml.rels') || '';
  const relMap = new Map([...rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: xmlText(m[1]), target: relMap.get(m[2]) }));
  const colNum = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const out = [];
  for (const sh of sheets) {
    if (onlySheet && sh.name !== onlySheet) continue;
    const p = sh.target?.startsWith('/') ? sh.target.slice(1) : `xl/${sh.target}`;
    const xml = z.read(p);
    if (!xml) continue;
    const rows = [];
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1], inner = cm[2] || '';
        const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
        const type = (attrs.match(/t="([^"]+)"/) || [])[1];
        let v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (type === 's' && v != null) v = shared[+v];
        else if (type === 'inlineStr') v = xmlText((inner.match(/<is>([\s\S]*?)<\/is>/) || [])[1] || '');
        else if (v != null) v = xmlText(v);
        if (ref) cells[colNum(ref)] = v ?? '';
      }
      rows.push(Array.from(cells, (c) => (c ?? '').toString().replace(/\t|\n/g, ' ')).join('\t'));
      if (rows.length >= 3000) { rows.push('…(3000행까지만)'); break; }
    }
    out.push(`## 시트: ${sh.name}\n${rows.join('\n')}`);
  }
  return out.join('\n\n') || '(시트를 찾지 못했습니다)';
}

// 첨부 자동 변환용 (chat.js 가 사용)
function officeText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') return docxText(file);
  if (ext === '.pptx') return pptxText(file);
  if (ext === '.xlsx') return xlsxText(file);
  return null;
}

// ---------------------------------------------------------------- 웹 검색
function stripTags(s) { return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim(); }

async function searchDuckDuckGo(q, n, signal) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=kr-kr`, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' }, signal });
  const html = await res.text();
  const out = [];
  const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  titles.forEach((m, i) => {
    if (out.length >= n) return;
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) return; // 광고
    // 이 결과 제목부터 다음 결과 제목 사이에서 요약을 찾는다
    const block = html.slice(m.index, i + 1 < titles.length ? titles[i + 1].index : undefined);
    const snip = (block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/) || [])[1] || '';
    out.push({ title: stripTags(m[2]), url, snippet: stripTags(snip) });
  });
  return out;
}

async function searchBing(q, n, signal) {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=ko`, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' }, signal });
  const html = await res.text();
  const out = [];
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g)) {
    const snip = (m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '';
    out.push({ title: stripTags(m[2]), url: m[1].replace(/&amp;/g, '&'), snippet: stripTags(snip) });
    if (out.length >= n) break;
  }
  return out;
}

// ---------------------------------------------------------------- MCP 서버 주소·인증
// 원격 MCP(url+headers)와 mcp-remote 방식 stdio("npx mcp-remote <url> --header Name:${VAR}") 둘 다 읽는다
function mcpEndpoints(ctx) {
  const out = [];
  const servers = ctx.mcp?.servers ? [...ctx.mcp.servers.values()] : [];
  for (const s of servers) {
    const cfg = s.cfg || {};
    const env = { ...process.env, ...(cfg.env || {}) };
    const expand = (v) => String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => env[k] || '');
    let url = cfg.url || null;
    const headers = { ...(cfg.headers || {}) };
    if (!url && Array.isArray(cfg.args)) {
      url = cfg.args.find((a) => /^https?:\/\//i.test(a)) || null;
      for (let i = 0; i < cfg.args.length; i++) {
        if (cfg.args[i] === '--header' && cfg.args[i + 1]) {
          const hv = cfg.args[i + 1];
          const k = hv.indexOf(':');
          if (k > 0) headers[hv.slice(0, k).trim()] = hv.slice(k + 1).trim();
        }
      }
    }
    if (!url) continue;
    for (const k of Object.keys(headers)) headers[k] = expand(headers[k]);
    try { out.push({ name: s.name, origin: new URL(url).origin, headers, status: s.status }); } catch { /* 잘못된 주소 */ }
  }
  return out;
}

// ---------------------------------------------------------------- 메모리
function memoryFile(ctx) { return path.join(ctx.store.data, 'memory.json'); }
function loadMemory(ctx) {
  try { return JSON.parse(fs.readFileSync(memoryFile(ctx), 'utf8')); } catch { return { version: 1, items: [] }; }
}
function saveMemory(ctx, mem) {
  ctx.store.reg.assert('memory.schema.json', mem);
  fs.writeFileSync(memoryFile(ctx), JSON.stringify(mem, null, 2), 'utf8');
}

// ---------------------------------------------------------------- 실행
async function execute(name, args, ctx) {
  const { resolvePath, expandSources, globRe, uniqueTarget, saveImage } = core;
  switch (name) {
    case 'find_files': {
      const root = resolvePath(args.path || '.', ctx, 'read');
      const pat = String(args.pattern || '*').replace(/\\/g, '/');
      const byPath = pat.includes('/');
      const re = byPath ? pathGlobRe(pat) : globRe(pat);
      const max = Math.min(Number(args.max_results) || 200, 2000);
      const hits = [];
      walk(root, (full, e, isDir) => {
        if (isDir) return true;
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (re.test(byPath ? rel : e.name) && hits.length < max) {
          let st = null; try { st = fs.statSync(full); } catch { /* 무시 */ }
          hits.push({ full, size: st?.size || 0, mtime: st?.mtimeMs || 0 });
        }
        return true;
      });
      hits.sort((a, b) => b.mtime - a.mtime);
      return { text: `${root} 에서 "${args.pattern}" — ${hits.length}개${hits.length >= max ? ' (상한 도달)' : ''}\n${hits.map((h) => `${h.full} (${h.size.toLocaleString()} B)`).join('\n') || '(없음)'}` };
    }
    case 'search_files': {
      const root = resolvePath(args.path || '.', ctx, 'read');
      const max = Math.min(Number(args.max_results) || 100, 1000);
      const fre = args.file_pattern ? globRe(args.file_pattern) : null;
      let re;
      try { re = args.regex ? new RegExp(args.query, 'i') : new RegExp(String(args.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } catch (e) { throw new Error(`정규식 오류: ${e.message}`); }
      const hits = [];
      const walkTarget = fs.statSync(root).isFile() ? null : root;
      const scan = (full) => {
        let st; try { st = fs.statSync(full); } catch { return; }
        if (st.size > 2 * 1024 * 1024) return;
        const buf = fs.readFileSync(full);
        if (buf.subarray(0, 8000).includes(0)) return;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < max; i++) if (re.test(lines[i])) hits.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
      };
      if (!walkTarget) scan(root);
      else walk(root, (full, e, isDir) => { if (isDir) return true; if (fre && !fre.test(e.name)) return true; if (hits.length < max) scan(full); return true; });
      return { text: `"${args.query}" 검색 결과 ${hits.length}건${hits.length >= max ? ' (상한 도달)' : ''}\n${hits.join('\n') || '(없음)'}` };
    }
    case 'file_info': {
      const files = expandSources(args.path, ctx);
      if (!files.length) throw new Error(`파일을 찾을 수 없습니다: ${args.path}`);
      const rows = [];
      for (const f of files.slice(0, 50)) {
        const st = fs.statSync(f);
        if (st.isDirectory()) { rows.push({ path: f, type: 'folder' }); continue; }
        const dim = imageSize(f);
        rows.push({ path: f, fileName: path.basename(f), sizeBytes: st.size, mimeType: mimeOf(f), modified: st.mtime.toISOString(), sha256: await sha256File(f), ...(dim ? { width: dim.width, height: dim.height } : {}) });
      }
      return { text: JSON.stringify(rows.length === 1 ? rows[0] : rows, null, 2) + (files.length > 50 ? `\n…(50개까지만, 전체 ${files.length}개)` : '') };
    }
    case 'edit_file': {
      const f = resolvePath(args.path, ctx, 'dest');
      const src = fs.readFileSync(f, 'utf8');
      const oldT = String(args.old_text), newT = String(args.new_text ?? '');
      const count = src.split(oldT).length - 1;
      if (!count) throw new Error('old_text 를 파일에서 찾지 못했습니다. 공백·줄바꿈까지 정확히 맞춰 주세요.');
      if (count > 1 && !args.replace_all) throw new Error(`old_text 가 ${count}곳에 있습니다. 더 길게 지정하거나 replace_all 을 true 로 주세요.`);
      fs.writeFileSync(f, args.replace_all ? src.split(oldT).join(newT) : src.replace(oldT, () => newT), 'utf8');
      return { text: `${f} 에서 ${args.replace_all ? count : 1}곳을 바꿨습니다.` };
    }
    case 'make_dir': {
      const d = resolvePath(args.path, ctx, 'dest');
      fs.mkdirSync(d, { recursive: true });
      return { text: `폴더를 만들었습니다: ${d}` };
    }
    case 'rename_path': {
      const f = resolvePath(args.path, ctx, 'dest');
      const nn = String(args.new_name || '');
      if (!nn || /[\\/:*?"<>|]/.test(nn)) throw new Error('새 이름에 쓸 수 없는 문자가 있습니다');
      const target = path.join(path.dirname(f), nn);
      if (fs.existsSync(target)) throw new Error(`같은 이름이 이미 있습니다: ${target}`);
      fs.renameSync(f, target);
      return { text: `이름을 바꿨습니다: ${f} → ${target}` };
    }
    case 'delete_path': {
      const full = resolvePath(args.path, ctx, 'dest');
      let targets = [full];
      if (/[*?]/.test(path.basename(full))) {
        const re = globRe(path.basename(full));
        targets = fs.readdirSync(path.dirname(full)).filter((n) => re.test(n)).map((n) => path.join(path.dirname(full), n));
      }
      targets = targets.filter((t) => fs.existsSync(t));
      if (!targets.length) throw new Error(`지울 대상이 없습니다: ${args.path}`);
      const roots = [ctx.store.dirs.workspace, ...(ctx.settings.tools.allowedDirs || [])].map((d) => path.resolve(d).toLowerCase());
      for (const t of targets) if (roots.includes(path.resolve(t).toLowerCase())) throw new Error('작업 폴더·허용 폴더 자체는 지울 수 없습니다');
      const lines = targets.map((t) => `[Microsoft.VisualBasic.FileIO.FileSystem]::${fs.statSync(t).isDirectory() ? 'DeleteDirectory' : 'DeleteFile'}(${psq(t)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`);
      await runPsCommand(`Add-Type -AssemblyName Microsoft.VisualBasic; ${lines.join('; ')}`);
      return { text: `휴지통으로 보냈습니다 (${targets.length}개):\n${targets.join('\n')}` };
    }
    case 'open_path': {
      const target = String(args.path || '');
      if (/^https?:\/\//i.test(target)) { execFile('cmd.exe', ['/c', 'start', '', target], { windowsHide: true }); return { text: `브라우저로 열었습니다: ${target}` }; }
      const f = resolvePath(target, ctx, 'read');
      if (!fs.existsSync(f)) throw new Error(`없는 경로입니다: ${f}`);
      execFile('explorer.exe', [f], { windowsHide: true }, () => {});
      return { text: `열었습니다: ${f}` };
    }
    case 'read_document': {
      const files = expandSources(args.path, ctx);
      if (!files.length) throw new Error(`문서를 찾을 수 없습니다: ${args.path}`);
      const f = files[0];
      const ext = path.extname(f).toLowerCase();
      const limit = ctx.settings.tools.resultLimit;
      if (ext === '.pdf') {
        const first = Math.max(1, Number(args.first_page) || 1);
        const count = Math.min(8, Math.max(1, Number(args.pages) || 4));
        const prefix = `pdf_${Date.now().toString(36)}`;
        const out = await runPsScript(path.join(__dirname, 'pdf-pages.ps1'), ['-InputPath', f, '-OutDir', ctx.store.dirs.images, '-Prefix', prefix, '-First', String(first), '-Count', String(count)], 180000, ctx.signal);
        const r = JSON.parse(out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{')));
        const images = r.pages.map((p, i) => ({ type: 'image', url: `/files/images/${p}`, prompt: `${path.basename(f)} ${r.first + i}쪽` }));
        return {
          text: `${path.basename(f)}: 전체 ${r.pageCount}쪽 중 ${r.first}~${r.last}쪽을 이미지로 만들었습니다. 이어지는 이미지에서 내용을 읽으세요.${r.last < r.pageCount ? ` 다음 쪽은 first_page: ${r.last + 1} 로 다시 부르세요.` : ''}\n${images.map((i) => i.url).join('\n')}`,
          images
        };
      }
      let text = officeText(f);
      if (text == null) {
        const buf = fs.readFileSync(f);
        if (buf.subarray(0, 8000).includes(0)) throw new Error(`읽을 수 없는 형식입니다 (${ext || '확장자 없음'})`);
        text = buf.toString('utf8');
      }
      if (args.sheet && ext === '.xlsx') text = xlsxText(f, args.sheet);
      return { text: `# ${path.basename(f)}\n\n${text.length > limit ? `${text.slice(0, limit)}\n…(${text.length.toLocaleString()}자 중 앞부분만)` : text}` };
    }
    case 'zip_files': {
      return require('./archives').execute(name,args,ctx);
    }
    case 'unzip_file': {
      return require('./archives').execute(name,args,ctx);
    }
    case 'list_archive': return require('./archives').execute(name,args,ctx);
    case 'web_search': {
      const n = Math.min(Number(args.max_results) || 8, 20);
      const signal = AbortSignal.any([AbortSignal.timeout(20000), ...(ctx.signal ? [ctx.signal] : [])]);
      let results = [];
      let source = 'DuckDuckGo';
      try { results = await searchDuckDuckGo(String(args.query), n, signal); } catch { /* 대체 검색으로 */ }
      if (!results.length) { source = 'Bing'; results = await searchBing(String(args.query), n, signal); }
      if (!results.length) throw new Error('검색 결과를 가져오지 못했습니다');
      return { text: `"${args.query}" 검색 결과 (${source})\n\n${results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n')}` };
    }
    case 'download_file': {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('http(s) 주소만 받을 수 있습니다');
      const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.any([AbortSignal.timeout(600000), ...(ctx.signal ? [ctx.signal] : [])]) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 500 * 1024 * 1024) throw new Error('500MB 를 넘는 파일은 받지 않습니다');
      const cd = res.headers.get('content-disposition') || '';
      let fname = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i) || [])[1] || '') || path.basename(new URL(url).pathname) || 'download';
      fname = fname.replace(/[\\/:*?"<>|]/g, '_');
      let dest = resolvePath(args.destination || 'downloads', ctx, 'dest');
      if (!path.extname(dest) || (fs.existsSync(dest) && fs.statSync(dest).isDirectory())) { fs.mkdirSync(dest, { recursive: true }); dest = uniqueTarget(dest, fname); }
      else fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return { text: `내려받았습니다: ${dest} (${buf.length.toLocaleString()} B, ${res.headers.get('content-type') || '형식 모름'})` };
    }
    case 'http_request': {
      const method = String(args.method || 'GET').toUpperCase();
      let url = String(args.url || '').trim();
      const eps = mcpEndpoints(ctx);
      if (url.startsWith('/')) {
        // 상대 주소 → MCP 서버 주소 기준
        let ep = args.mcp_server ? eps.find((e) => e.name === args.mcp_server) : null;
        if (!ep && !args.mcp_server) ep = eps.length === 1 ? eps[0] : null;
        if (!ep) throw new Error(`상대 주소의 기준 서버를 정할 수 없습니다. mcp_server 에 다음 중 하나를 넣으세요: ${eps.map((e) => e.name).join(', ') || '(주소가 있는 MCP 서버 없음)'}`);
        url = ep.origin + url;
      }
      if (!/^https?:\/\//i.test(url)) throw new Error('http(s) 주소나 "/api/..." 같은 상대 주소만 요청할 수 있습니다');
      const headers = { 'user-agent': UA, ...(args.headers || {}) };
      const lower = Object.fromEntries(Object.keys(headers).map((k) => [k.toLowerCase(), k]));
      // 대상이 연결된 MCP 서버와 같은 주소면 그 서버의 인증 헤더를 붙인다 (사용자가 준 헤더가 우선, 값은 출력하지 않음)
      let authFrom = '';
      const targetOrigin = new URL(url).origin;
      const ep = eps.find((e) => e.origin === targetOrigin);
      if (ep) {
        for (const [k, v] of Object.entries(ep.headers)) if (v && !lower[k.toLowerCase()]) { headers[k] = v; authFrom = ep.name; }
      }
      let body;
      let sent = '';
      if (args.body_file) {
        const f = expandSources(args.body_file, ctx)[0];
        if (!f) throw new Error(`보낼 파일을 찾을 수 없습니다: ${args.body_file}`);
        body = fs.readFileSync(f);
        if (!lower['content-type']) headers['content-type'] = mimeOf(f);
        sent = `파일 ${path.basename(f)} (${body.length.toLocaleString()} B)`;
      } else if (args.multipart) {
        const form = new FormData();
        for (const [k, v] of Object.entries(args.multipart.fields || {})) form.append(k, String(v));
        for (const it of args.multipart.files || []) {
          const f = expandSources(it.path, ctx)[0];
          if (!f) throw new Error(`보낼 파일을 찾을 수 없습니다: ${it.path}`);
          form.append(it.field, new Blob([fs.readFileSync(f)], { type: it.content_type || mimeOf(f) }), it.filename || path.basename(f));
        }
        body = form;
        if (lower['content-type']) delete headers[lower['content-type']];
        sent = `multipart (필드 ${Object.keys(args.multipart.fields || {}).length}개, 파일 ${(args.multipart.files || []).length}개)`;
      } else if (args.json !== undefined) {
        body = JSON.stringify(args.json);
        if (!lower['content-type']) headers['content-type'] = 'application/json';
        sent = `JSON ${body.length} B`;
      } else if (args.body != null) {
        body = String(args.body);
        sent = `본문 ${Buffer.byteLength(body)} B`;
      }
      const t0 = Date.now();
      const res = await fetch(url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body, redirect: 'follow', signal: AbortSignal.any([AbortSignal.timeout((Number(args.timeout_seconds) || 120) * 1000), ...(ctx.signal ? [ctx.signal] : [])]) });
      const ct = res.headers.get('content-type') || '';
      const hdrs = {};
      res.headers.forEach((v, k) => { if (/^(content-type|content-length|location|etag|x-request-id|x-amz-request-id|x-tt-logid|retry-after)$/i.test(k)) hdrs[k] = v; });
      let bodyText = '';
      if (method !== 'HEAD') {
        const buf = Buffer.from(await res.arrayBuffer());
        if (args.save_to) {
          const dest = resolvePath(args.save_to, ctx, 'dest');
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, buf);
          bodyText = `(본문 ${buf.length.toLocaleString()} B 를 ${dest} 에 저장)`;
        } else if (/json|text|xml|html|javascript|urlencoded/.test(ct) || !buf.subarray(0, 4000).includes(0)) {
          bodyText = buf.toString('utf8');
          if (/json/.test(ct)) { try { bodyText = JSON.stringify(JSON.parse(bodyText), null, 2); } catch { /* 그대로 */ } }
          const lim = ctx.settings.tools.resultLimit;
          if (bodyText.length > lim) bodyText = `${bodyText.slice(0, lim)}\n…(잘림)`;
        } else bodyText = `(바이너리 ${buf.length.toLocaleString()} B — save_to 로 저장 가능)`;
      }
      return { text: `${method} ${url}\n보낸 내용: ${sent || '없음'}${authFrom ? `\n인증: ${authFrom} 서버의 인증 헤더를 자동으로 붙임` : ''}\n응답: HTTP ${res.status} ${res.statusText} (${Date.now() - t0}ms)\n헤더: ${JSON.stringify(hdrs)}\n\n${bodyText}`, isError: !res.ok };
    }
    case 'run_javascript': {
      const logs = [];
      const fmt = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
      const sandbox = { input: args.input, console: { log: (...a) => logs.push(a.map(fmt).join(' ')), error: (...a) => logs.push(a.map(fmt).join(' ')) }, JSON, Math, Date, Intl, Number, String, Array, Object, RegExp, Map, Set };
      const code = String(args.code || '');
      const wrapped = /\breturn\b/.test(code) ? `(function(){\n${code}\n})()` : code;
      let result;
      try { result = vm.runInNewContext(wrapped, sandbox, { timeout: 10000, displayErrors: true }); } catch (e) { return { text: `실행 오류: ${e.message}${logs.length ? `\n\nconsole:\n${logs.join('\n')}` : ''}`, isError: true }; }
      let out = result === undefined ? '(값 없음)' : typeof result === 'string' ? result : fmt(result);
      if (typeof result === 'object' && result !== null) { try { out = JSON.stringify(result, null, 2); } catch { /* 그대로 */ } }
      return { text: `결과:\n${out}${logs.length ? `\n\nconsole:\n${logs.join('\n')}` : ''}`.slice(0, ctx.settings.tools.resultLimit) };
    }
    case 'memory': {
      const mem = loadMemory(ctx);
      const act = args.action;
      if (act === 'list') return { text: mem.items.length ? mem.items.map((m) => `[${m.id}] ${m.text}`).join('\n') : '(저장된 메모리 없음)' };
      if (act === 'add') {
        const text = String(args.text || '').trim();
        if (!text) throw new Error('text 가 필요합니다');
        const item = { id: crypto.randomUUID().slice(0, 8), text: text.slice(0, 2000), createdAt: new Date().toISOString() };
        mem.items.push(item);
        saveMemory(ctx, mem);
        return { text: `기억했습니다 [${item.id}]: ${item.text}` };
      }
      const i = mem.items.findIndex((m) => m.id === args.id);
      if (i === -1) throw new Error(`없는 메모리 id: ${args.id}`);
      if (act === 'delete') { const [d] = mem.items.splice(i, 1); saveMemory(ctx, mem); return { text: `지웠습니다: ${d.text}` }; }
      if (act === 'update') { mem.items[i].text = String(args.text || '').slice(0, 2000); saveMemory(ctx, mem); return { text: `고쳤습니다 [${args.id}]: ${mem.items[i].text}` }; }
      throw new Error(`알 수 없는 action: ${act}`);
    }
    default:
      return null;
  }
}

module.exports = { definitions, execute, needsApproval, bind, officeText, loadMemory, saveMemory, sha256File, imageSize, mcpEndpoints };
