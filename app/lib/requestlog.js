'use strict';
// 공급자 API 요청 기록 (data/logs/api-requests.jsonl). request id 로 조회할 때 쓴다.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 20 * 1024 * 1024;

class RequestLog {
  constructor(logsDir, registry) {
    this.file = path.join(logsDir, 'api-requests.jsonl');
    this.reg = registry;
  }

  append(entry) {
    const clean = {};
    for (const [k, v] of Object.entries(entry)) if (v !== undefined && v !== '') clean[k] = v;
    const r = this.reg.validate('api-request.schema.json', clean);
    if (!r.valid) console.warn('[requestlog] 스키마와 다른 기록:', r.errors[0]);
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
    } catch { /* 회전 실패는 무시 */ }
    fs.appendFileSync(this.file, `${JSON.stringify(clean)}\n`, 'utf8');
  }

  // 최신순. q 는 request id·모델·오류·대화 id 에서 찾는다
  list({ q = '', kind = '', status = '', limit = 200 } = {}) {
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
    const lines = [...read(`${this.file}.1`), ...read(this.file)];
    const needle = q.trim().toLowerCase();
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (kind && e.kind !== kind) continue;
      if (status && e.status !== status) continue;
      if (needle && ![e.requestId, e.model, e.error, e.conversationId, e.kind].some((v) => v && String(v).toLowerCase().includes(needle))) continue;
      out.push(e);
    }
    return out;
  }
}

module.exports = { RequestLog };
