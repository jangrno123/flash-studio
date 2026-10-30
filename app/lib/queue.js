'use strict';
// 작업 대기열: 등록된 작업을 순서대로 무인 처리한다 (data/queue.json, CONTEXT.md §13)
// 한 작업은 대화 하나에서 시작해, 필요하면 자동으로 이어가고(호출 한도), 인계하고(컨텍스트), 재시도한다(오류).
// 사람이 개입하는 곳은 두 군데뿐: 등록할 때(유료 승인·예산) / blocked 로 표시된 작업 검토.
const { newId, now } = require('./store');
const { KeepAwake } = require('./keepawake');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const handoff = require('./handoff');

const TICK_MS = 5000;
const STALL_LIMIT = 4; // 체크포인트가 이만큼 연속 그대로면 멈춘다
const DONE_RE = /\[JOB_DONE\]/;
const BLOCKED_RE = /\[JOB_BLOCKED(?::\s*([^\]]*))?\]/;
// 표시는 응답 끝에 따로 쓴 것만 인정한다 (본문에서 표시를 설명하거나 코드로 인용한 것은 무시)
// 마지막 줄 전체가 표시 하나일 때만 인정 ("…라서 [JOB_DONE] 은 쓰지 않는다" 같은 언급은 무시)
function tailMarker(text) {
  const last = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
  const l = last.replace(/^[*_`>\s-]+|[*_`\s.]+$/g, '');
  if (/^\[JOB_DONE\]$/.test(l)) return { kind: 'done' };
  const b = l.match(/^\[JOB_BLOCKED(?::\s*([^\]]*))?\]$/);
  if (b) return { kind: 'blocked', reason: (b[1] || '사유 없음').trim() };
  return null;
}
const RESTARTED = '앱 재시작으로 중단됨 — 이어서 재개';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONTINUE_TEXT = '이어서 계속 진행한다. 체크포인트와 직전 보고의 "아직 못 한 일"부터 순서대로 처리한다.';
const RESUME_TEXT = '앱이 다시 시작돼 작업이 중단됐었다. 체크포인트부터 이어서 진행한다. 중단 직전에 제출한 작업이 있으면 새로 제출하지 말고 상태부터 확인한다.';
const HANDOFF_TEXT = '이전 대화에서 인계받은 작업이다. 인계서와 체크포인트는 요약이니, 먼저 1차 자료(원본 컷·대본 시트 파일 등)를 다시 읽고 "다음 할 일"부터 이어서 진행한다. 이미 끝난 단계는 다시 하지 않되, 그 결과물이 1차 자료와 맞는지는 확인한다.';
const NUDGE_TEXT = '작업이 모두 끝났으면 결과를 짧게 정리하고 마지막 줄에 [JOB_DONE] 을 쓴다. 남은 일이 있으면 이어서 진행한다. 더 진행할 수 없으면 [JOB_BLOCKED: 사유] 를 쓴다.';

// 처리 순서: 우선순위 높은 것 → 순서값(sortKey) 작은 것 → 먼저 등록한 것
const keyOf = (j) => j.sortKey || Date.parse(j.createdAt) || 0;
const byOrder = (a, b) => b.priority - a.priority || keyOf(a) - keyOf(b) || a.createdAt.localeCompare(b.createdAt);

class JobQueue {
  constructor({ store, runner }) {
    this.store = store;
    this.runner = runner;
    this.activeId = null;
    this.stopFlags = new Set();
    this.timer = null;
    this.version = 0;
    this.awake = new KeepAwake();
  }

  // ---------------- 저장 ----------------
  load() { return this.store.getQueue(); }
  save(q) { this.store.saveQueue(q); this.version++; }
  // 작업 하나를 읽고-고치고-저장한다 (다른 곳에서 바꾼 내용을 덮지 않게 매번 새로 읽는다)
  update(id, fn) {
    const q = this.load();
    const job = q.jobs.find((j) => j.id === id);
    if (!job) return null;
    fn(job, q);
    job.updatedAt = now();
    this.save(q);
    return job;
  }
  get(id) { return this.load().jobs.find((j) => j.id === id) || null; }

  // ---------------- 등록 ----------------
  add(items, { source = 'user', batchId = null, ids = [] } = {}) {
    const q = this.load();
    if (source === 'model' && q.settings.allowModelRegistration !== true) throw Object.assign(new Error('모델의 자동 대기열 등록이 허용되지 않았습니다.'), { status: 403 });
    const out = [];
    let seq = Date.now();
    for (const it of items) {
      const job = {
        id: ids[out.length] || newId(), title: String(it.title || '').trim().slice(0, 160) || '작업', prompt: String(it.prompt || '').trim(),
        projectId: it.projectId || null, skills: Array.isArray(it.skills) ? it.skills : [],
        priority: Number.isInteger(it.priority) ? it.priority : 0, dependsOn: Array.isArray(it.dependsOn) ? it.dependsOn : [],
        attachments: (Array.isArray(it.attachments) ? it.attachments : []).map(({ id, name, mime, size, kind, file, url }) => ({ id, name, mime, size, kind, file, url })),
        // 모델이 등록한 작업은 유료 승인을 가질 수 없다 (사람이 대기열 화면에서 준다)
        approval: source === 'model' ? {} : (it.approval || {}),
        source, batchId, sortKey: seq++, createdAt: now(), updatedAt: now()
      };
      for (const key of ['sourceConversationId', 'sourceMessageId', 'submissionKey', 'sourceContextRef']) if (it[key]) job[key] = it[key];
      if (!job.prompt) throw Object.assign(new Error('작업 내용(prompt)이 비어 있습니다'), { status: 400 });
      this.store.reg.applyDefaults('queue.schema.json#/$defs/job', job);
      this.store.reg.assert('queue.schema.json#/$defs/job', job);
      q.jobs.push(job);
      out.push(job);
    }
    this.save(q);
    setTimeout(() => this.tick(), 200);
    return out;
  }

  addModelBatch(conv, items) {
    if (this.load().settings.allowModelRegistration !== true) throw Object.assign(new Error('자동 대기열 등록은 허용되지 않았습니다. 현재 대화에서 사용자 지시 범위의 작업을 계속하세요. 사용자가 대기열 설정에서 명시적으로 허용한 경우에만 등록할 수 있습니다.'), { status: 403 });
    if (conv.queueJobId) throw Object.assign(new Error('대기열 작업이 다른 대기열을 자동 생성할 수 없습니다. 현재 작업을 진행하고 추가 분할이 필요하면 보고하세요.'), { status: 403 });
    if (!items.length || items.length > 200) throw new Error('jobs는 1~200개여야 합니다.');
    const origin = [...(conv.messages || [])].reverse().find(m => m.role === 'user');
    const messageId = origin?.id || conv.messages?.at(-1)?.id || conv.id;
    const submissionKey = crypto.createHash('sha256').update(JSON.stringify([conv.id, messageId, items])).digest('hex');
    const existing = this.load().jobs.filter(j => j.submissionKey === submissionKey);
    if (existing.length) return { jobs: existing, reused: true };
    for (const it of items) if (it.project_id && it.project_id !== conv.projectId) throw new Error('다른 프로젝트의 작업은 자동 등록할 수 없습니다.');
    const batchId = newId(), ids = items.map(() => newId());
    const sources = handoff.lineage(this.store, conv.id);
    const records = handoff.sourceRecords(sources).filter(r => ['user', 'steer'].includes(r.type));
    const attachments = sources.flatMap(c => c.messages.flatMap(m => [...(m.attachments || []), ...(m.parts || []).filter(p => p.type === 'steer').flatMap(p => p.attachments || [])]));
    const unique = [...new Map(attachments.map(a => [a.id, a])).values()];
    const sourceContextRef = `${batchId}.queue-source.json`;
    const dir = path.join(this.store.data, 'handoffs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sourceContextRef), JSON.stringify({ sourceConversationId: conv.id, sourceMessageId: messageId, projectId: conv.projectId || null, systemPrompt: conv.systemPrompt || '', providerId: conv.providerId || '', model: conv.model || '', records }, null, 2));
    const jobs = this.add(items.map((it, index) => ({ title: it.title, prompt: it.prompt, priority: it.priority,
      skills: [...new Set([...(conv.skills || []), ...(it.skills || [])])], projectId: conv.projectId || null,
      attachments: unique, dependsOn: it.after_previous && index ? [ids[index - 1]] : [],
      sourceConversationId: conv.id, sourceMessageId: messageId, submissionKey, sourceContextRef
    })), { source: 'model', batchId, ids });
    return { jobs, reused: false };
  }

  sourceContext(job) {
    if (!job.sourceContextRef) return null;
    if (!/^[A-Za-z0-9_-]{6,64}\.queue-source\.json$/.test(job.sourceContextRef)) throw new Error('대기열 원문 연결 경로가 잘못됐습니다.');
    const context = JSON.parse(fs.readFileSync(path.join(this.store.data, 'handoffs', job.sourceContextRef), 'utf8'));
    if (context.projectId !== (job.projectId || null)) throw new Error('대기열 원문과 현재 프로젝트가 다릅니다. 원문을 다시 연결하세요.');
    return context;
  }

  // ---------------- 실행 루프 ----------------
  start() {
    // 앱이 꺼지며 멈춘 작업은 다시 대기열로 (대화를 이어서 재개)
    const q = this.load();
    let changed = false;
    for (const j of q.jobs) if (j.status === 'running') { j.status = 'queued'; j.lastError = RESTARTED; changed = true; }
    if (changed) this.save(q);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    setTimeout(() => this.tick(), 3000);
  }

  // 24시간 상시 가동이면 늘 켜 두고, 아니면 할 일이 있을 때만
  keepsAlive() { const q = this.load(); return !!q.settings.alwaysOn || !!this.activeId || q.jobs.some((j) => j.status === 'queued'); }

  // 할 일이 남아 있는 동안 PC 절전을 막는다
  updateAwake(q = this.load()) {
    const pending = !!this.activeId || (q.settings.running && q.jobs.some((j) => j.status === 'queued'));
    this.awake.set(!!q.settings.keepAwake && pending);
  }

  next(q) {
    const done = new Set(q.jobs.filter((j) => j.status === 'done').map((j) => j.id));
    return q.jobs
      .filter((j) => j.status === 'queued' && (j.source !== 'model' || q.settings.allowModelRegistration === true) && j.dependsOn.every((d) => done.has(d) || !q.jobs.some((x) => x.id === d)))
      .sort(byOrder)[0] || null;
  }

  tick() {
    const q = this.load();
    this.updateAwake(q);
    if (this.activeId) return;
    if (!q.settings.running) return;
    const job = this.next(q);
    if (!job) return;
    this.activeId = job.id;
    this.run(job.id)
      .catch((e) => { console.error('[queue]', e); this.update(job.id, (j) => { j.status = 'failed'; j.lastError = e.message; j.finishedAt = now(); }); })
      .finally(async () => {
        this.activeId = null;
        this.stopFlags.delete(job.id);
        await sleep((this.load().settings.pauseBetweenSec || 0) * 1000);
        this.tick();
      });
  }

  // 사용자가 일시정지·취소하면 현재 단계가 끝난 뒤 멈춘다 (진행 중인 응답은 중단)
  stop(id, status) {
    const job = this.update(id, (j) => { if (['queued', 'running', 'blocked', 'failed'].includes(j.status)) j.status = status; });
    if (id === this.activeId) {
      this.stopFlags.add(id);
      const run = [...this.runner.runs.entries()].find(([, r]) => r.job && r.job.id === id);
      if (run) run[1].controller.abort();
    }
    return job;
  }

  // 처음부터 다시: 새 대화에서 시작한다 (예전 대화는 기록으로 남김). 진행 중이면 먼저 멈춘다
  restart(id) {
    if (id === this.activeId) this.stop(id, 'paused');
    return this.update(id, (j) => {
      if (j.status === 'running') return;
      Object.assign(j, { status: 'queued', conversationId: null, checkpoint: '', editNote: '', result: '', blockedReason: '', lastError: '', attempts: 0, continues: 0, handoffs: 0, paidCalls: 0, startedAt: null, finishedAt: null });
    });
  }

  retry(id) {
    return this.update(id, (j) => {
      if (!['blocked', 'failed', 'paused', 'canceled', 'done'].includes(j.status)) return;
      j.status = 'queued'; j.attempts = 0; j.continues = 0; j.blockedReason = ''; j.lastError = ''; j.finishedAt = null;
    });
  }

  // 대화 준비: 이어 쓰던 대화(인계됐으면 이어받은 대화) 또는 새 대화
  conversationFor(job) {
    let conv = null;
    if (job.conversationId) {
      try { conv = this.store.getConversation(job.conversationId); } catch { conv = null; }
      while (conv && conv.handedOffTo) { try { conv = this.store.getConversation(conv.handedOffTo); } catch { break; } }
    }
    if (conv) return { conv, fresh: false };
    const context = this.sourceContext(job);
    conv = this.store.createConversation({ title: `[대기열] ${job.title}`, projectId: job.projectId, skills: job.skills,
      systemPrompt: context?.systemPrompt || '', providerId: context?.providerId || '', model: context?.model || '' });
    conv.queueJobId = job.id;
    this.store.saveConversation(conv, false);
    return { conv, fresh: true };
  }

  async run(id) {
    const settings = () => this.load().settings;
    const restarted = this.get(id).lastError === RESTARTED;
    let job = this.update(id, (j) => { j.status = 'running'; j.startedAt = j.startedAt || now(); j.lastError = ''; });
    let { conv, fresh } = this.conversationFor(job);
    job = this.update(id, (j) => { j.conversationId = conv.id; if (!j.conversations.includes(conv.id)) j.conversations.push(conv.id); });
    // 새 대화면 작업 내용, 이어 쓰는 대화면 재개 지시
    const source = fresh ? this.sourceContext(job) : null;
    const directives = source ? source.records.map(r => `[${r.conversationId}/${r.messageId}] ${r.text}`).join('\n\n') : '';
    let message = fresh ? `${directives ? `## 원래 대화의 사용자 지침\n최신 교정을 우선하며 이번 작업 범위 밖의 일을 새로 실행하지 않습니다.\n${directives}\n\n` : ''}## 이번 작업의 범위\n${job.prompt}` : (restarted ? RESUME_TEXT : CONTINUE_TEXT);
    // 첨부(웹툰 원본 등)는 새 대화의 첫 메시지에만 붙인다. 이후에는 무인 작업 지침에 경로가 실린다
    let attachments = fresh ? job.attachments : [];
    let nudged = false;
    let stall = 0;
    let lastCp = job.checkpoint;

    for (;;) {
      if (this.stopFlags.has(id)) return;
      // 시작한 뒤 사용자가 작업을 고쳤으면 그 내용을 먼저 알린다
      const note = this.get(id).editNote;
      if (note) { message = `${note}\n\n${message}`; this.update(id, (j) => { j.editNote = ''; }); }
      const out = await this.runner.runHeadless({ conversationId: conv.id, content: message, attachments, skills: job.skills }, { job: this.get(id) });
      attachments = [];
      // 응답이 끝나 반영되지 못한 수정 알림은 다음 단계로 넘긴다
      if (out.dropped && out.dropped.length) this.update(id, (j) => { j.editNote = [...out.dropped, j.editNote].filter(Boolean).join('\n\n').slice(-20000); });
      if (this.stopFlags.has(id)) return;
      const m = out.message;
      const text = m ? (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('') : '';
      const s = settings();

      // 1) 끝남 / 막힘 표시 — 응답 끝 단독 줄만 인정한다 (호출 한도 보고의 끝에 쓴 것도 인정)
      const mark = tailMarker(text);
      if (mark && mark.kind === 'blocked') {
        this.update(id, (j) => { j.status = 'blocked'; j.blockedReason = mark.reason; j.result = text.slice(-6000); j.finishedAt = now(); });
        return;
      }
      // 백그라운드 확인(lib/bgwait.js)이 남아 있으면 모델을 부르지 않고 결과가 올 때까지 기다린다 (CONTEXT.md §15)
      // 결과는 editNote 로 들어와 다음 메시지 앞에 붙는다. 확인이 남았는데 쓴 완료 표시는 믿지 않는다
      const bg = this.runner.bg;
      if (bg && (bg.pending(conv.id) || bg.outbox.has(conv.id)) && !(m && m.status === 'error')) {
        while (bg.pending(conv.id) || bg.outbox.has(conv.id)) { if (this.stopFlags.has(id)) return; await sleep(5000); }
        await sleep(1000);
        message = CONTINUE_TEXT;
        nudged = false;
        continue;
      }
      if (mark && mark.kind === 'done') {
        this.update(id, (j) => { j.status = 'done'; j.result = text.replace(DONE_RE, '').trim().slice(-6000); j.finishedAt = now(); });
        return;
      }

      // 2) 오류 → 간격을 늘려 가며 재시도. 정상 응답이 오면 횟수를 되돌린다 (retryMax 는 연속 오류 기준)
      const failed = !m || m.status === 'error' || m.status === 'stopped';
      if (!failed && job.attempts) job = this.update(id, (j) => { j.attempts = 0; });
      if (failed) {
        const err = out.error || (m && m.error) || '응답 없음';
        job = this.update(id, (j) => { j.attempts++; j.lastError = err.slice(0, 4000); });
        if (job.attempts > s.retryMax) {
          this.update(id, (j) => { j.status = 'failed'; j.finishedAt = now(); });
          return;
        }
        const wait = s.retryDelaySec * 2 ** (job.attempts - 1) * 1000;
        const until = Date.now() + wait;
        while (Date.now() < until) { if (this.stopFlags.has(id)) return; await sleep(1000); }
        message = `직전 실행이 오류로 멈췄다: ${err.slice(0, 500)}\n체크포인트부터 다시 이어서 진행한다. 불확실하게 끝난 제출은 새로 제출하지 말고 상태부터 확인한다.`;
      } else if (m.stopReason === 'max_rounds') {
        // 3) 호출 한도 → 자동으로 이어가기
        job = this.update(id, (j) => { j.continues++; });
        if (job.continues > s.autoContinueMax) {
          this.update(id, (j) => { j.status = 'blocked'; j.blockedReason = `자동 이어가기 ${s.autoContinueMax}회를 넘었다 — 작업을 더 잘게 나누거나 확인이 필요`; j.result = text.slice(-6000); j.finishedAt = now(); });
          return;
        }
        message = CONTINUE_TEXT;
      } else {
        // 4) 표시 없이 끝남 → 한 번만 확인을 요청하고, 그래도 없으면 끝난 것으로 본다
        if (nudged) {
          this.update(id, (j) => { j.status = 'done'; j.result = `${text.slice(-6000)}\n\n(완료 표시 없이 끝남)`; j.finishedAt = now(); });
          return;
        }
        nudged = true;
        message = NUDGE_TEXT;
      }

      // 헛돌기 방지: 체크포인트가 연속으로 그대로면 진전이 없는 것으로 보고 멈춘다 (비용 보호)
      const cpNow = this.get(id).checkpoint;
      stall = cpNow === lastCp ? stall + 1 : 0;
      lastCp = cpNow;
      if (stall >= STALL_LIMIT) {
        this.update(id, (j) => { j.status = 'blocked'; j.blockedReason = `체크포인트가 ${STALL_LIMIT}번 연속 그대로라 진전이 없는 것으로 보고 멈췄다 — 작업 내용이나 완료 기준을 확인`; j.result = text.slice(-6000); j.finishedAt = now(); });
        return;
      }

      // 5) 컨텍스트가 무거워졌으면 인계서를 만들어 새 대화로 옮긴다
      if (s.autoHandoff) {
        const info = this.runner.contextInfo(this.store.getConversation(conv.id));
        if (info.handoffAdvice) {
          const draft = await this.runner.handoffDraft(conv.id);
          const cp = this.get(id).checkpoint;
          const next = this.runner.createHandoff(conv.id, { summary: cp ? `${draft.summary}\n\n## 대기열 체크포인트\n${cp}` : draft.summary, files: draft.files });
          next.queueJobId = id;
          this.store.saveConversation(next, false);
          conv = next;
          this.update(id, (j) => { j.handoffs++; j.conversationId = next.id; j.conversations.push(next.id); });
          message = `${HANDOFF_TEXT}\n\n(직전 대화에서 보낼 예정이던 지시: ${message})`;
        }
      }
    }
  }

  // 유료 호출 기록 (chat.js 가 승인 범위를 확인한 뒤 부른다)
// ---------------- 수정 ----------------
  // 대기 중이면 그대로 바꾸고, 이미 시작한 작업이면 바뀐 점을 모델에게 알린다
  // (진행 중이면 추가 지시로 바로, 멈춰 있으면 다음 단계 메시지에 붙여서)
  edit(id, patch, { applyToBatch = false } = {}) {
    const FIELDS = ['title', 'prompt', 'priority', 'projectId', 'skills', 'approval', 'attachments'];
    const BATCH_FIELDS = ['priority', 'projectId', 'skills', 'approval']; // 묶음 전체에 줄 수 있는 것 (제목·내용·첨부는 작업마다 다르다)
    const q = this.load();
    const target = q.jobs.find((j) => j.id === id);
    if (!target) return null;
    const list = applyToBatch && target.batchId ? q.jobs.filter((j) => j.batchId === target.batchId && !['done', 'canceled'].includes(j.status)) : [target];
    const changed = [];
    for (const j of list) {
      const fields = j === target ? FIELDS : BATCH_FIELDS;
      const diff = [];
      for (const k of fields) {
        if (patch[k] === undefined) continue;
        if (JSON.stringify(j[k]) === JSON.stringify(patch[k])) continue;
        j[k] = k === 'attachments' ? patch[k].map(({ id: aid, name, mime, size, kind, file, url }) => ({ id: aid, name, mime, size, kind, file, url })) : patch[k];
        diff.push(k);
      }
      if (!diff.length) continue;
      this.store.reg.applyDefaults('queue.schema.json#/$defs/job', j);
      this.store.reg.assert('queue.schema.json#/$defs/job', j);
      j.updatedAt = now();
      changed.push(j);
      if (j.conversationId) {
        const note = this.editMessage(j, diff);
        const run = [...this.runner.runs.entries()].find(([, r]) => r.job && r.job.id === j.id);
        if (run && this.runner.steer(run[0], note)) continue;
        j.editNote = [j.editNote, note].filter(Boolean).join('\n\n').slice(-20000);
      }
    }
    if (changed.length) this.save(q);
    return { job: target, changed: changed.length };
  }

  editMessage(j, diff) {
    const L = { title: '제목', prompt: '작업 내용', priority: '우선순위', projectId: '프로젝트', skills: '스킬', approval: '유료 승인', attachments: '첨부' };
    const lines = [`[사용자가 작업을 수정했다 — 바뀐 항목: ${diff.map((k) => L[k]).join(', ')}] 지금까지 한 일은 유지하고, 아래 최신 내용에 맞춰 이어 간다.`];
    if (diff.includes('prompt')) lines.push(`## 최신 작업 내용\n${j.prompt}`);
    if (diff.includes('attachments')) lines.push(`## 최신 첨부\n${j.attachments.map((a, i) => `${i + 1}. ${a.name} → /files/uploads/${a.file}`).join('\n') || '(없음)'}`);
    if (diff.includes('approval')) lines.push('유료 승인 범위가 바뀌었다. 무인 작업 지침의 "유료 승인" 줄이 최신 값이다.');
    return lines.join('\n');
  }

  // 대기 중인 작업의 순서 옮기기 (같은 우선순위 안에서)
  move(id, to) {
    const q = this.load();
    const job = q.jobs.find((j) => j.id === id);
    if (!job) return null;
    const lane = q.jobs.filter((j) => j.status === 'queued' && j.priority === job.priority).sort(byOrder);
    const i = lane.indexOf(job);
    if (i === -1) return job;
    lane.forEach((j) => { j.sortKey = keyOf(j); });
    if (to === 'top') job.sortKey = keyOf(lane[0]) - 1;
    else if (to === 'bottom') job.sortKey = keyOf(lane[lane.length - 1]) + 1;
    else {
      const k = to === 'up' ? i - 1 : i + 1;
      if (k < 0 || k >= lane.length) return job;
      [job.sortKey, lane[k].sortKey] = [lane[k].sortKey, job.sortKey];
      if (job.sortKey === lane[k].sortKey) job.sortKey += to === 'up' ? -1 : 1;
    }
    job.updatedAt = now();
    this.save(q);
    return job;
  }

  notePaid(id) { return this.update(id, (j) => { j.paidCalls++; }); }
  checkpoint(id, text) { return this.update(id, (j) => { j.checkpoint = String(text).slice(0, 8000); }); }

  snapshot() {
    const q = this.load();
    return { settings: q.settings, activeId: this.activeId, jobs: q.jobs, presets: q.presets || [], version: this.version };
  }
}

module.exports = { JobQueue, DONE_RE, BLOCKED_RE, tailMarker };
