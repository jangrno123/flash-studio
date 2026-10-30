'use strict';
// 이미지 변환 검수: 16:9 변환본을 원본 컷과 대조해 빠진 것·바뀐 것·새로 생긴 것·글자 잔재를 찾는다.
// convert_panels 는 변환 → 검수 → (문제가 있으면) 검수 결과를 반영해 재생성을 서버에서 한 번에 처리한다.
// 에셋(인물·소품·색)이 컷마다 흔들리지 않게 하는 것이 목적이다.
const fs = require('fs');
const path = require('path');
const llm = require('./llm');

// 16:9 변환 표준 프롬프트 (webtoon-animation-bao 스킬 2-5 와 같다)
const STANDARD_PROMPT = [
  'Recreate the reference webtoon panel as a single 16:9 widescreen illustration.',
  'Keep exactly the same characters, faces, hairstyles, outfits, poses, camera angle, art style, line art and coloring.',
  'Remove every speech bubble, caption box, sound-effect lettering and all text, and repaint the covered areas so they blend naturally with the surrounding scene.',
  'Extend the scene naturally to the left and right to fill the 16:9 frame. No borders, no letterboxing, no white margins, no new characters.'
].join('\n');

const QA_PROMPT = `너는 웹툰 컷 변환 검수자다. 첫 번째 이미지 [원본]은 웹툰의 한 컷이고, 두 번째 이미지 [변환본]은 그 컷을 16:9 가로 일러스트로 다시 그린 것이다.

변환 규칙 — 아래는 정상이므로 문제로 보지 않는다:
- 말풍선·대사·효과음 글자·캡션을 모두 지운다
- 좌우를 자연스럽게 늘려 16:9를 채우고, 지운 자리는 배경으로 메운다

원본과 대조해 확인할 것:
1. 원본의 인물이 모두 있는가 (수·위치)
2. 얼굴·표정·머리 모양·머리색·피부색이 같은가
3. 옷·장신구·무늬·색이 같은가
4. 소품·핵심 배경 요소(건물·음식·무기·소품 등)가 빠지거나 바뀌지 않았는가
5. 자세·손짓·시선·구도(카메라 각도)가 같은가
6. 화풍·선·채색 톤이 같은가
7. 원본에 없는 인물·물체가 원본 영역에 새로 생기지 않았는가 (늘린 좌우의 자연스러운 배경은 괜찮다)
8. 글자·말풍선 잔재가 남지 않았는가
9. 손가락·팔다리 등 형태가 깨지지 않았는가

JSON 하나만 출력한다 (설명 문장 금지):
{"verdict":"pass|fix|fail","score":0,"issues":[{"type":"missing|changed|added|text_left|style|pose|anatomy|framing","severity":"high|medium|low","what":"무엇이 어떻게 다른지 (한국어)","fix":"고칠 방법 (한국어)"}],"fix_prompt":"재생성할 때 덧붙일 영어 지시. 문제 없으면 빈 문자열"}

판정 기준: 인물이 빠졌거나 다른 장면이면 fail, 심각(high)하거나 눈에 띄는(medium) 문제가 있으면 fix, 사소한 것뿐이면 pass. score 는 원본 충실도(100 = 완벽).`;

const lib = () => require('./tools'); // tools.js 와 서로 부르므로 쓸 때 불러온다

const RATIOS = { '9:16': '1152x2048', '16:9': '2048x1152', '1:1': '1536x1536' };
function conversionSpec(aspect_ratio, preserve_text = []) {
  if (!RATIOS[aspect_ratio]) throw new Error('aspect_ratio를 명시하세요 (개별 숏 9:16 / 16:9 / 1:1). 비율을 임의로 선택하지 않습니다.');
  const preserved = preserve_text.length ? `Preserve this diegetic text exactly: ${preserve_text.join('; ')}.` : 'Preserve meaningful text that belongs to objects in the scene (signs, messages, notifications).';
  const prompt = `Edit this existing webtoon panel into one ${aspect_ratio} shot. Preserve the original artwork, composition, character count, identities, faces, hair, clothes, props and action. Do not redesign or redraw the scene. Remove speech bubbles, narration captions and sound-effect lettering, repairing only the covered areas. ${preserved} Fit the target frame with minimal changes; do not crop away important action or invent characters. This is a single shot, not a storyboard grid. No panel borders, shot labels or collage.`;
  const review = QA_PROMPT.replace(/16:9 가로 일러스트로 다시 그린 것이다/, `${aspect_ratio} 숏으로 편집한 것이다`).replace('- 말풍선·대사·효과음 글자·캡션을 모두 지운다', `- 말풍선·대사·효과음 글자·캡션을 지운다. 장면 속 간판·댓글·알림 같은 필수 글자는 보존한다. ${preserved}`).replace('- 좌우를 자연스럽게 늘려 16:9를 채우고, 지운 자리는 배경으로 메운다', `- 원본 장면을 최대한 보존하여 ${aspect_ratio}로 편집하고, 말풍선으로 가린 자리만 복원한다`);
  return { ratio: aspect_ratio, size: RATIOS[aspect_ratio], prompt, review };
}
function ratioIssue(file, ratio) {
  const dim = require('./tools-extra').imageSize(file), [w, h] = ratio.split(':').map(Number);
  if (!dim || Math.abs((dim.width / dim.height) / (w / h) - 1) > 0.02) return { type: 'framing', severity: 'high', what: `실제 이미지 비율이 목표 ${ratio}와 다릅니다 (${dim ? `${dim.width}×${dim.height}` : '치수 확인 실패'}).`, fix: `목표 ${ratio} 비율로 다시 편집` };
  return null;
}

// 검수용 이미지: 긴 변 1280px 이하 JPEG 로 줄여 data URL 로 (토큰 절약)
async function visionUrl(file, ctx) {
  const t = lib();
  const dim = require('./tools-extra').imageSize(file);
  const big = !dim || Math.max(dim.width, dim.height) > 1280 || fs.statSync(file).size > 900000;
  if (!big) return `data:${/\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg'};base64,${fs.readFileSync(file).toString('base64')}`;
  const s = 1280 / Math.max(dim ? dim.width : 2560, dim ? dim.height : 2560);
  const w = dim ? Math.max(64, Math.round(dim.width * s)) : 1280;
  const h = dim ? Math.max(64, Math.round(dim.height * s)) : undefined;
  const dir = path.join(ctx.store.data, '.cache');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const out = path.join(dir, `qa_${stamp}.jpg`);
  const ops = path.join(dir, `qa_${stamp}.json`);
  fs.writeFileSync(ops, JSON.stringify([{ op: 'resize', width: w, height: h, fit: 'stretch' }]), 'utf8');
  try {
    await t.runPs('edit-image.ps1', ['-InputPath', file, '-OpsFile', ops, '-OutPath', out, '-Quality', '85'], ctx);
    return `data:image/jpeg;base64,${fs.readFileSync(out).toString('base64')}`;
  } finally { fs.rmSync(ops, { force: true }); fs.rmSync(out, { force: true }); }
}

function parseJson(text) {
  const s = String(text).replace(/<think>[\s\S]*?<\/think>/g, '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
}

function logQa(ctx, rec) {
  try {
    const f = path.join(ctx.store.dirs.logs, 'qa.jsonl');
    fs.appendFileSync(f, `${JSON.stringify({ time: new Date().toISOString(), conversationId: ctx.meta && ctx.meta.conversationId, ...rec })}\n`);
  } catch { /* 무시 */ }
}

// 원본 ↔ 변환본 검수. 반환 { verdict, score, issues, fixPrompt, pass }
async function check({ original, result, focus, aspect_ratio, preserve_text }, ctx) {
  const spec = conversionSpec(aspect_ratio, preserve_text);
  const t = lib();
  const cfg = ctx.settings.qa || {};
  const fo = t.resolveImage(String(original || ''), ctx);
  const fr = t.resolveImage(String(result || ''), ctx);
  if (!fo) throw new Error(`원본 이미지를 찾을 수 없습니다: ${original}`);
  if (!fr) throw new Error(`변환본 이미지를 찾을 수 없습니다: ${result}`);
  const provider = ctx.store.getProvider(cfg.providerId || 'modelark');
  const model = cfg.model || 'seed-2-0-lite-260428';
  const prov = provider.models.some((m) => m.id === model) ? provider : { ...provider, models: [...provider.models, { id: model, vision: true, reasoning: false }] };
  const [uo, ur] = await Promise.all([visionUrl(fo, ctx), visionUrl(fr, ctx)]);
  let raw = '';
  let data = null;
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    raw = await llm.complete({
      provider: prov, model, maxTokens: 1500, signal: ctx.signal,
      meta: { ...(ctx.meta || {}), kind: 'qa' },
      messages: [
        { role: 'system', content: spec.review },
        { role: 'user', content: [
          { type: 'text', text: `[원본]${focus ? `\n특히 확인할 것: ${focus}` : ''}` }, { type: 'image_url', image_url: { url: uo } },
          { type: 'text', text: '[변환본]' }, { type: 'image_url', image_url: { url: ur } },
          { type: 'text', text: attempt ? '앞 응답이 JSON 이 아니었다. JSON 하나만 출력한다.' : '검수 결과를 JSON 으로.' }
        ] }
      ]
    });
    data = parseJson(raw);
  }
  if (!data) return { verdict: 'fix', score: 0, issues: [{ type: 'framing', severity: 'medium', what: '검수 응답을 해석하지 못했다', fix: '다시 검수' }], fixPrompt: '', pass: false, raw: raw.slice(0, 500) };
  const issues = Array.isArray(data.issues) ? data.issues.slice(0, 12) : [];
  const wrongRatio = ratioIssue(fr, spec.ratio);
  if (wrongRatio) issues.push(wrongRatio);
  const score = Math.max(0, Math.min(100, Number(data.score) || 0));
  const serious = issues.some((i) => i.severity === 'high');
  const verdict = ['pass', 'fix', 'fail'].includes(data.verdict) ? data.verdict : 'fix';
  const pass = verdict === 'pass' && score >= (cfg.passScore ?? 85) && !serious;
  const res = { verdict: pass ? 'pass' : verdict === 'pass' ? 'fix' : verdict, score, issues, fixPrompt: String(data.fix_prompt || ''), pass };
  logQa(ctx, { original, result, ...res });
  return res;
}

function issueLines(q) {
  if (!q.issues.length) return '  문제 없음';
  return q.issues.map((i) => `  - [${i.severity}/${i.type}] ${i.what}${i.fix ? ` → ${i.fix}` : ''}`).join('\n');
}

// 여러 컷을 변환하고 검수·재생성까지. 반환 { text, images }
async function convertPanels({ images, extra_prompt, max_attempts, focus, aspect_ratio, preserve_text }, ctx) {
  const spec = conversionSpec(aspect_ratio, preserve_text);
  const t = lib();
  const cfg = ctx.settings.qa || {};
  const list = (Array.isArray(images) ? images : [images]).filter(Boolean).slice(0, 40);
  if (!list.length) throw new Error('변환할 컷 이미지(images)가 없습니다');
  if (cfg.enabled === false) throw new Error('설정에서 변환 검수가 꺼져 있습니다');
  const maxA = Math.max(1, Math.min(5, Number(max_attempts) || cfg.maxAttempts || 3));
  const conc = Math.max(1, Math.min(6, cfg.concurrency || 3));
  const base = `${spec.prompt}${extra_prompt ? `\n${extra_prompt}` : ''}`;
  const results = new Array(list.length);
  let next = 0;
  let stopped = '';

  async function one(i) {
    const original = String(list[i]);
    const tries = [];
    let best = null;
    let fix = '';
    for (let a = 1; a <= maxA; a++) {
      if (ctx.signal && ctx.signal.aborted) break;
      const prompt = fix ? `${base}\nCorrections from review of the previous attempt: ${fix}` : base;
      // 대기열 작업이면 유료 승인·상한을 매 생성마다 확인한다 (이미 만든 결과를 재사용하면 비용이 없으니 세지 않는다)
      if (ctx.paidGuard && !t.cachedImage({ prompt, size: spec.size, references: [original] }, ctx)) {
        const why = ctx.paidGuard('images');
        if (why) { stopped = why; break; }
      }
      let img;
      try { [img] = await t.runImage({ prompt, size: spec.size, references: [original] }, ctx); } catch (e) { tries.push({ a, error: e.message }); if (/sensitive/i.test(e.message) && a < maxA) continue; break; }
      let q;
      try { q = await check({ original, result: img.url, focus, aspect_ratio, preserve_text }, ctx); } catch (e) { q = { verdict: 'fix', score: 0, issues: [{ severity: 'medium', type: 'framing', what: `검수 실패: ${e.message}` }], fixPrompt: '', pass: false }; }
      tries.push({ a, url: img.url, q });
      if (!best || q.score > best.q.score || (q.pass && !best.q.pass)) best = { url: img.url, q, img };
      if (q.pass) break;
      fix = q.fixPrompt || q.issues.filter((x) => x.severity !== 'low').map((x) => x.fix || x.what).join('; ');
    }
    results[i] = { original, best, tries };
  }

  await Promise.all(Array.from({ length: Math.min(conc, list.length) }, async () => {
    while (next < list.length && !stopped) { const i = next++; await one(i); }
  }));

  const lines = [];
  const outImages = [];
  let passCount = 0;
  results.forEach((r, i) => {
    if (!r) { lines.push(`${i + 1}. ${list[i]} → 처리 안 함${stopped ? ` (${stopped})` : ''}`); return; }
    if (!r.best) { lines.push(`${i + 1}. ${r.original} → 실패: ${(r.tries.find((x) => x.error) || {}).error || '생성 안 됨'}`); return; }
    const q = r.best.q;
    if (q.pass) passCount++;
    outImages.push({ ...r.best.img, prompt: `컷 ${i + 1} · 검수 ${q.pass ? '합격' : '불합격'} ${q.score}점` });
    lines.push(`${i + 1}. ${r.original}\n  → ${r.best.url}  [${q.pass ? '합격' : '불합격'} ${q.score}점, 시도 ${r.tries.length}회]\n${issueLines(q)}`);
  });
  const failed = results.filter((r) => r && r.best && !r.best.q.pass).length;
  const head = `${spec.ratio} 숏 편집 + 원본 대조 검수: ${list.length}컷 중 합격 ${passCount}${failed ? `, 불합격 ${failed} (가장 점수 높은 결과를 남김)` : ''}${stopped ? ` — 중단: ${stopped}` : ''}`;
  const tail = failed ? '\n불합격 컷은 위 문제를 확인해 check_conversion 으로 다시 보거나, 사람이 확인하도록 체크포인트에 "QA 불합격"으로 적는다. 불합격 컷을 다음 단계(업로드·연결)에 쓰지 않는다.' : '';
  return { text: `${head}\n\n${lines.join('\n')}${tail}`, images: outImages };
}

async function checkTool(args, ctx) {
  const q = await check({ original: args.original, result: args.result, focus: args.focus, aspect_ratio: args.aspect_ratio, preserve_text: args.preserve_text }, ctx);
  return { text: `검수 결과: ${q.pass ? '합격' : '불합격'} (${q.verdict}, ${q.score}점)\n${issueLines(q)}${q.fixPrompt ? `\n재생성 보정 지시: ${q.fixPrompt}` : ''}` };
}

module.exports = { convertPanels, checkTool, check, STANDARD_PROMPT, conversionSpec, ratioIssue };
