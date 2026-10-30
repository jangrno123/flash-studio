'use strict';
// 컷별 대본 시트: 원본 컷에서 읽은 나레이션·대사·효과음을 파일로 남기고, 대사 음절 수로 컷마다 영상 길이를 계산한다.
// 대화가 바뀌거나 인계돼도 이 파일이 1차 자료다 (webtoon-animation-bao 스킬 2-4·2-7B).
const fs = require('fs');
const path = require('path');

// 발화 속도(음절/초) — 스킬 2-7B 표
const TONES = { calm: 3.0, epic: 3.8, normal: 4.5, fast: 5.2 };
const TONE_LABEL = { calm: '정적·감성', epic: '장엄·서사', normal: '일반 서술·대화', fast: '빠른 정보·액션' };
const MIN_SEC = 2;
const MAX_SEC = 30;

const syllables = (s) => (String(s || '').match(/[가-힣]/g) || []).length;
// 문장 수: 마침표·물음표·느낌표·말줄임·줄바꿈으로 끊는다 (빈 조각 제외)
const sentences = (s) => String(s || '').split(/[.?!…~\n]+/).map((x) => x.trim()).filter((x) => /[가-힣A-Za-z0-9]/.test(x)).length;
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || 'untitled';

// 컷 하나의 길이 계산. 반환 { seconds, raw, syllables, sentences, speed, warn }
function durationOf(cut, defaultTone) {
  const tone = TONES[cut.tone] ? cut.tone : defaultTone;
  const speed = TONES[tone];
  const spoken = [cut.narration, ...(cut.dialogue || []).map((d) => d.text)].filter(Boolean);
  const syl = spoken.reduce((n, t) => n + syllables(t), 0);
  const sen = spoken.reduce((n, t) => n + Math.max(1, sentences(t)), 0);
  const pause = sen > 1 ? (sen - 1) * 0.45 : 0;                     // 문장쉼 0.3~0.6초
  const margin = 0.8;                                               // 앞뒤 여백 0.4초씩
  const acting = Number.isFinite(Number(cut.extra_seconds)) ? Number(cut.extra_seconds) : (cut.action || cut.sfx ? 1.0 : 0.5); // 연출 여유
  const raw = syl / speed + pause + margin + acting;
  const seconds = Math.min(MAX_SEC, Math.max(MIN_SEC, Math.ceil(raw)));
  return { seconds, raw: Math.round(raw * 10) / 10, syllables: syl, sentences: sen, speed, tone, warn: raw > MAX_SEC ? `⚠️ 예상 ${raw.toFixed(1)}초 — 30초 초과. 대사 축약·속도 상향·분할 검토` : '' };
}

function sheetDir(ctx, work, episode) {
  return path.join(ctx.store.dirs.workspace, safe(work), safe(episode));
}

function toMarkdown(sheet) {
  const lines = [`# 대본 시트 — ${sheet.work} ${sheet.episode}`, '', `원본: ${sheet.source || '-'} · 기본 톤: ${TONE_LABEL[sheet.tone]} · 저장: ${sheet.savedAt}`, ''];
  for (const c of sheet.cuts) {
    lines.push(`## 컷 ${c.cut} — ${c.duration.seconds}초 (${c.duration.syllables}음절 ÷ ${c.duration.speed}/초${c.duration.sentences > 1 ? `, ${c.duration.sentences}문장` : ''})${c.duration.warn ? ` ${c.duration.warn}` : ''}`);
    if (c.original) lines.push(`- 원본 컷: ${c.original}`);
    if (c.context) lines.push(`- 문맥: ${c.context}`);
    if (c.picture) lines.push(`- 그림: ${c.picture}`);
    if (c.narration) lines.push(`- 나레이션: ${c.narration}`);
    for (const d of c.dialogue || []) lines.push(`- 대사 (${d.speaker || '?'}): ${d.text}`);
    if (c.sfx) lines.push(`- 효과음: ${c.sfx}`);
    if (c.emotion) lines.push(`- 감정: ${c.emotion}`);
    if (c.action) lines.push(`- 액션: ${c.action}`);
    lines.push('');
  }
  return lines.join('\n');
}

function table(sheet) {
  return sheet.cuts.map((c) => `컷 ${c.cut}: ${c.duration.seconds}초 · 음절 ${c.duration.syllables} · 대사 ${(c.dialogue || []).length}개${c.narration ? ' + 나레이션' : ''}${c.duration.warn ? ` ${c.duration.warn}` : ''}`).join('\n');
}

// action: save | read
function run(args, ctx) {
  const work = String(args.work || '').trim();
  const episode = String(args.episode || '').trim();
  if (!work || !episode) throw new Error('work(작품명)와 episode(회차·원본 번호)가 필요합니다');
  const dir = sheetDir(ctx, work, episode);
  const jsonPath = path.join(dir, '대본시트.json');
  const mdPath = path.join(dir, '대본시트.md');
  if (args.action === 'read') {
    if (!fs.existsSync(jsonPath)) return { text: `대본 시트가 없습니다: ${jsonPath}\n원본 컷을 읽어 script_sheet(action="save")로 먼저 만든다.`, isError: true };
    const sheet = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return { text: `${toMarkdown(sheet)}\n\n## 길이 요약\n${table(sheet)}\n\n파일: ${jsonPath}` };
  }
  const cuts = Array.isArray(args.cuts) ? args.cuts : [];
  if (!cuts.length) throw new Error('cuts 가 비어 있습니다');
  const tone = TONES[args.tone] ? args.tone : 'epic';
  // 대사·나레이션이 하나도 없는 컷이 절반을 넘으면, 원본이 아니라 프롬프트·요약에서 옮긴 것일 수 있다 → 경고
  const empty = cuts.filter((c) => !c.narration && !(c.dialogue || []).some((d) => String(d.text || '').trim())).length;
  const sheet = {
    work, episode, source: args.source || '', tone, savedAt: new Date().toISOString(),
    cuts: cuts.map((c, i) => {
      const cut = { cut: String(c.cut || i + 1).padStart(2, '0'), original: c.original || '', context: c.context || '', picture: c.picture || '', narration: String(c.narration || '').trim(), dialogue: (c.dialogue || []).filter((d) => d && String(d.text || '').trim()).map((d) => ({ speaker: String(d.speaker || '').trim(), text: String(d.text).trim() })), sfx: c.sfx || '', emotion: c.emotion || '', action: c.action || '', tone: c.tone || '', extra_seconds: c.extra_seconds };
      cut.duration = durationOf(cut, tone);
      return cut;
    })
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(sheet, null, 2));
  fs.writeFileSync(mdPath, toMarkdown(sheet));
  const warn = empty > cuts.length / 2 ? `\n⚠️ ${cuts.length}컷 중 ${empty}컷에 대사·나레이션이 없습니다. 원본 컷 이미지를 직접 읽어 말풍선·캡션을 옮겼는지 다시 확인한다 (프롬프트·인계서에서 옮기면 대사가 빠진다).` : '';
  return { text: `대본 시트를 저장했습니다.\n- ${mdPath}\n- ${jsonPath}\n\n## 컷별 길이 (bao_canvas_wire_video_batch 의 duration 에 그대로 넣는다)\n${table(sheet)}${warn}\n\n이 경로를 체크포인트에 적는다. 재개·인계 뒤에는 script_sheet(action="read")로 다시 읽는다.` };
}

module.exports = { run, durationOf, syllables, TONES };
