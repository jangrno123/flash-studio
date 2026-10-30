'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Provider rejected 2560 x 28800 references at this pixel limit. This is
// independent of Flash's file upload and chat vision budgets.
const SEEDREAM_MAX_PIXELS = 36_000_000;

function referenceSize(width, height, maxPixels = SEEDREAM_MAX_PIXELS) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('참조 이미지의 픽셀 크기를 확인할 수 없습니다');
  }
  if (width * height <= maxPixels) return { width, height, resized: false };
  const scale = Math.sqrt(maxPixels / (width * height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), resized: true };
}

async function prepareReferences(inputs, ctx, deps) {
  // Other providers retain their existing input behavior and limits.
  if (!/seedream/i.test(ctx.settings.imageGen.model || '')) {
    return { images: inputs.map(i => i.file ? deps.dataUrlOf(i.file) : i.dataUrl), adjustments: [] };
  }
  const images = [], adjustments = [];
  const cacheDir = path.join(ctx.store.data, '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  for (let index = 0; index < inputs.length; index++) {
    if (ctx.signal && ctx.signal.aborted) throw new Error('이미지 요청이 중단되었습니다');
    const input = inputs[index];
    const prefix = path.join(cacheDir, 'genref_' + crypto.randomUUID());
    const owned = [];
    let file = input.file;
    try {
      if (!file) {
        const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]+)$/.exec(input.dataUrl || '');
        if (!match) throw new Error('참조 이미지 ' + (index + 1) + '의 데이터 형식을 확인할 수 없습니다');
        file = prefix + '.input';
        owned.push(file);
        fs.writeFileSync(file, Buffer.from(match[2], 'base64'));
      }
      const original = deps.imageSize(file);
      if (!original) throw new Error('참조 이미지 ' + (index + 1) + '의 픽셀 크기를 확인할 수 없습니다');
      const target = referenceSize(original.width, original.height);
      if (!target.resized) {
        images.push(input.dataUrl || deps.dataUrlOf(file));
        continue;
      }
      const out = prefix + '.png', ops = prefix + '.json';
      owned.push(out, ops);
      fs.writeFileSync(ops, JSON.stringify([{ op: 'resize', width: target.width, height: target.height, fit: 'stretch' }]));
      await deps.runPs('edit-image.ps1', ['-InputPath', file, '-OpsFile', ops, '-OutPath', out], ctx);
      const actual = deps.imageSize(out);
      if (!actual || actual.width !== target.width || actual.height !== target.height || actual.width * actual.height > SEEDREAM_MAX_PIXELS) {
        throw new Error('참조 이미지 전송용 사본의 크기 검증에 실패했습니다');
      }
      images.push(deps.dataUrlOf(out));
      adjustments.push({ reference: index + 1, original, sent: actual });
    } finally {
      for (const f of owned) fs.rmSync(f, { force: true });
    }
  }
  return { images, adjustments };
}

module.exports = { SEEDREAM_MAX_PIXELS, referenceSize, prepareReferences };
