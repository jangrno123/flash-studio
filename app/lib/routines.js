'use strict';
// 루틴: 정해진 시각에 프롬프트를 자동 실행한다 (data/routines.json, CONTEXT.md §10)
// 앱 서버가 켜져 있는 동안만 돈다. 꺼져 있다 켜지면 놓친 실행을 catchUp 설정에 따라 한 번 처리한다.
const { newId, now } = require('./store');

const TICK_MS = 30000;
const DAY = 86400000;

const atTime = (base, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
};

// after 보다 뒤의 다음 실행 시각. 없으면 null
function computeNext(schedule, after = new Date()) {
  const t = after.getTime();
  switch (schedule.type) {
    case 'interval': return new Date(t + schedule.everyMinutes * 60000);
    case 'once': { const at = Date.parse(schedule.at); return Number.isFinite(at) && at > t ? new Date(at) : null; }
    case 'daily':
    case 'weekdays':
    case 'weekly': {
      for (let i = 0; i <= 8; i++) {
        const d = atTime(t + i * DAY, schedule.time || '09:00');
        if (d.getTime() <= t) continue;
        const wd = d.getDay();
        if (schedule.type === 'weekdays' && (wd === 0 || wd === 6)) continue;
        if (schedule.type === 'weekly' && !(schedule.days || []).includes(wd)) continue;
        return d;
      }
      return null;
    }
    default: return null;
  }
}

const iso = (d) => (d ? d.toISOString() : null);

class RoutineScheduler {
  constructor({ store, runner, queue = null }) {
    this.store = store;
    this.runner = runner;
    this.queue = queue;
    this.running = new Set();
    this.timer = null;
  }

  start() {
    this.prepare(true);
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[routine] tick', e.message)), TICK_MS);
    setTimeout(() => this.tick().catch(() => {}), 5000);
  }

  stop() { clearInterval(this.timer); }

  // 다음 실행 시각을 채우고, 시작할 때 놓친 실행을 정리한다
  prepare(startup = false) {
    const lib = this.store.getRoutines();
    const t = Date.now();
    let changed = false;
    for (const r of lib.routines) {
      if (!r.enabled) continue;
      if (!r.nextRunAt) { r.nextRunAt = iso(computeNext(r.schedule, new Date())); changed = true; continue; }
      if (r.lastStatus === 'running' && !this.running.has(r.id)) { r.lastStatus = 'error'; r.lastError = '앱이 꺼져 실행이 중단됐습니다'; changed = true; }
      if (startup && Date.parse(r.nextRunAt) < t && !r.catchUp) {
        r.runs.unshift({ at: now(), status: 'skipped', conversationId: null, error: '앱이 꺼져 있어 건너뜀', trigger: 'catchup', durationMs: null });
        r.runs = r.runs.slice(0, 30);
        r.lastStatus = 'skipped';
        r.nextRunAt = iso(computeNext(r.schedule, new Date()));
        if (!r.nextRunAt && r.schedule.type === 'once') r.enabled = false;
        changed = true;
      }
    }
    if (changed) this.store.saveRoutines(lib);
    return lib;
  }

  async tick() {
    const t = Date.now();
    for (const r of this.store.getRoutines().routines) {
      if (!r.enabled || !r.nextRunAt || this.running.has(r.id)) continue;
      const due = Date.parse(r.nextRunAt);
      if (due <= t) this.run(r.id, t - due > TICK_MS * 4 ? 'catchup' : 'schedule').catch((e) => console.error('[routine]', r.name, e.message));
    }
  }

  // 루틴 설정 저장 뒤 다음 실행 시각 다시 계산
  reschedule(r) {
    r.nextRunAt = r.enabled ? iso(computeNext(r.schedule, new Date())) : null;
    if (r.enabled && !r.nextRunAt && r.schedule.type === 'once') r.enabled = false;
  }

  keepsAlive() { return this.running.size > 0 || this.store.getRoutines().routines.some((r) => r.enabled && r.nextRunAt); }

  async run(id, trigger = 'manual') {
    if (this.running.has(id)) throw Object.assign(new Error('이미 실행 중인 루틴이에요'), { status: 409 });
    let lib = this.store.getRoutines();
    const r = lib.routines.find((x) => x.id === id);
    if (!r) throw Object.assign(new Error('루틴을 찾을 수 없어요'), { status: 404 });
    this.running.add(id);
    const t0 = Date.now();
    // 다음 실행 시각은 먼저 옮겨 둔다 (실행이 길어도 두 번 돌지 않게)
    if (trigger !== 'manual') {
      r.nextRunAt = iso(computeNext(r.schedule, new Date()));
      if (!r.nextRunAt && r.schedule.type === 'once') r.enabled = false;
    }
    r.lastStatus = 'running';
    this.store.saveRoutines(lib);

    let convId = null;
    let status = 'ok';
    let error = '';
    try {
      // 대기열로 보내는 루틴: 직접 실행하지 않고 작업으로 등록만 한다 (처리는 대기열이 순서대로)
      if (r.target === 'queue') {
        if (!this.queue) throw new Error('작업 대기열을 쓸 수 없습니다');
        const stamp = new Date().toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const [job] = this.queue.add([{ title: `[루틴] ${r.name} · ${stamp}`, prompt: r.prompt, projectId: r.projectId, skills: r.skills, approval: r.approval || {} }], { source: 'routine' });
        error = '';
        status = 'ok';
        convId = null;
        this.lastQueued = job.id;
        return { status, error, conversationId: null, jobId: job.id };
      }
      let conv = null;
      if (r.target === 'same' && r.conversationId) {
        try { conv = this.store.getConversation(r.conversationId); } catch { conv = null; }
        // 이어 쓰던 대화가 다른 대화로 넘어갔으면 이어받은 대화를 따라간다
        while (conv && conv.handedOffTo) { try { conv = this.store.getConversation(conv.handedOffTo); } catch { break; } }
      }
      if (!conv) {
        const stamp = new Date().toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        conv = this.store.createConversation({
          title: r.target === 'same' ? `[루틴] ${r.name}` : `[루틴] ${r.name} · ${stamp}`,
          projectId: r.projectId, routineId: r.id, providerId: r.providerId, model: r.model, skills: r.skills
        });
      }
      convId = conv.id;
      if (this.runner.isBusy(conv.id)) throw new Error('이 대화에서 다른 응답이 진행 중이라 건너뛰었어요');
      const options = { tools: true };
      if (r.providerId) options.providerId = r.providerId;
      if (r.model) options.model = r.model;
      const content = `${r.prompt}\n\n(예약된 루틴 "${r.name}"으로 자동 실행됨. 사용자가 지켜보고 있지 않으니 되묻지 말고 끝까지 처리한 뒤, 한 일과 결과를 짧게 정리해 보고한다.)`;
      const out = await this.runner.runHeadless({ conversationId: conv.id, content, skills: r.skills, options });
      if (!out.message || out.message.status !== 'complete') { status = 'error'; error = out.error || `응답 상태: ${out.message ? out.message.status : '없음'}`; }
    } catch (e) {
      status = 'error';
      error = e.message || String(e);
    } finally {
      this.running.delete(id);
      lib = this.store.getRoutines();
      const cur = lib.routines.find((x) => x.id === id);
      if (cur) {
        cur.lastRunAt = now();
        cur.lastStatus = status;
        cur.lastError = error.slice(0, 2000);
        cur.lastConversationId = convId;
        if (cur.target === 'same' && convId) cur.conversationId = convId;
        cur.runs.unshift({ at: now(), status, conversationId: convId, error: error.slice(0, 500), trigger, durationMs: Date.now() - t0 });
        cur.runs = cur.runs.slice(0, 30);
        this.store.saveRoutines(lib);
      }
    }
    return { status, error, conversationId: convId };
  }

  // 새 루틴 기본값
  static create(body) {
    return { id: newId(), createdAt: now(), updatedAt: now(), runs: [], ...body };
  }
}

module.exports = { RoutineScheduler, computeNext };
