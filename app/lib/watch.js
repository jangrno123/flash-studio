'use strict';
// 대화 자동 점검 (CONTEXT.md §14)
// 사용자가 채팅방에서 켜 둔 대화를 주기마다(기본 30분) 확인한다.
// - 작업이 중간에 끊겼으면(오류·서버 재시작·호출 한도) 그 대화에서 다시 가동한다
// - 끝났다는 표시([업무완료])가 있으면 점검을 끈다
// - 사용자 답을 기다리는 중([대기])이거나 사용자가 직접 멈췄으면 새 메시지가 올 때까지 모델을 부르지 않는다
// 확인 자체는 대화 파일만 읽어서 판단하므로 토큰이 들지 않는다. 모델 호출은 다시 가동하거나 애매할 때 한 번 묻는 경우뿐이다.
const { now } = require('./store');

const TICK_MS = 60000;
const DONE_RE = /^\s*\[업무\s*완료\]\s*$/;
const IDLE_RE = /^\s*\[대기\]\s*$/;
const EARLY_MS = 3 * 60000;   // 끊긴 작업은 주기를 기다리지 않고 3분 뒤 다시 가동 (사용자가 직접 손볼 틈)
const FAIL_LIMIT = 3;          // 다시 가동해도 연속으로 오류가 나면 멈춘다 (요금 미납·서버 장애에서 헛돌지 않게)
const CONTINUE_LIMIT = 20;     // 사람 손 없이 이어간 횟수 상한. 새 사용자 메시지가 오면 초기화

const RESUME_TEXT = (why) => `[자동 점검] 직전 작업이 중간에 끊겼습니다 (${why}). 대화의 마지막 확인 지점부터 이어서 진행하세요. 이미 제출한 생성·렌더는 다시 제출하지 말고 상태부터 확인하세요. 모든 업무가 끝났으면 마지막 줄에 [업무완료]만, 사용자 답이나 승인을 기다려야 하면 [대기]만 쓰세요.`;
const CHECK_TEXT = (min) => `[자동 점검] ${min}분 점검입니다. 맡은 업무 중 남은 일이 있는지 확인하고, 있으면 이어서 진행하세요. 이미 제출한 생성·렌더는 다시 제출하지 말고 상태부터 확인하세요. 모두 끝났으면 마지막 줄에 [업무완료]만, 사용자 답을 기다리는 중이면 [대기]만 쓰세요.`;

const lastLine = (m) => {
  const text = (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('').trim();
  return text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
};
const usedTools = (m) => (m.parts || []).some((p) => p.type === 'tool_call');
const isAuto = (m) => m && m.role === 'user' && /^\[(자동 점검|백그라운드 확인)\]/.test(m.content || '');

class ConvWatcher {
  constructor({ store, runner }) {
    this.store = store;
    this.runner = runner;
    this.running = new Set();
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[watch] tick', e.message)), TICK_MS);
    setTimeout(() => this.tick().catch(() => {}), 20000);
  }

  stop() { clearInterval(this.timer); }

  ids() { return this.store.listConversations().filter((c) => c.watch).map((c) => c.id); }
  keepsAlive() { return this.running.size > 0 || this.ids().length > 0; }

  // 켜기·끄기·주기 변경 (채팅방 토글)
  configure(convId, { enabled, intervalMin }) {
    const c = this.store.getConversation(convId);
    if (c.queueJobId) throw Object.assign(new Error('대기열 작업 대화는 대기열이 직접 관리해요'), { status: 400 });
    const w = c.watch || {};
    const min = Math.min(240, Math.max(10, Number(intervalMin) || w.intervalMin || 30));
    if (enabled === false) c.watch = { ...w, intervalMin: min, enabled: false, state: 'off', nextCheckAt: null, note: '사용자가 껐음' };
    else c.watch = { intervalMin: min, failStreak: 0, continues: 0, ...w, enabled: true, state: 'watching', seen: null, note: '', nextCheckAt: new Date(Date.now() + min * 60000).toISOString() };
    this.store.saveConversation(c, false);
    return c.watch;
  }

  save(convId, patch) {
    const c = this.store.getConversation(convId);
    c.watch = { ...c.watch, ...patch };
    this.store.saveConversation(c, false);
    return c;
  }

  // 대화 상태를 파일만 보고 판단한다 (모델 호출 없음)
  classify(c) {
    if (this.runner.isBusy(c.id)) return { kind: 'busy' };
    // 백그라운드 확인(lib/bgwait.js)이 남아 있으면 결과가 알아서 들어오므로 손대지 않는다
    if ((c.bgWaits || []).length) return { kind: 'busy' };
    const m = c.messages[c.messages.length - 1];
    if (!m) return { kind: 'empty' };
    if (m.role === 'user') return { kind: 'interrupted', why: '응답이 시작되기 전에 끊김' };
    if (m.status === 'streaming') return { kind: 'interrupted', why: '앱 서버가 다시 시작돼 진행 중이던 응답이 끊김' };
    if (m.status === 'error') return { kind: 'interrupted', why: `오류: ${String(m.error || '').slice(0, 200)}` };
    if (m.status === 'stopped') return { kind: 'paused', why: '사용자가 멈춤' };
    if (m.stopReason === 'max_rounds') return { kind: 'interrupted', why: '한 번에 쓸 수 있는 도구 호출 한도에 도달' };
    const line = lastLine(m);
    if (DONE_RE.test(line)) return { kind: 'done' };
    if (IDLE_RE.test(line)) return { kind: 'idle', why: '사용자 답을 기다림' };
    // 자동 점검에 답했는데 아무 도구도 안 쓰고 표시도 없이 끝났으면 할 일이 없는 것으로 본다
    const prev = c.messages[c.messages.length - 2];
    if (isAuto(prev) && !usedTools(m)) return { kind: 'idle', why: '점검했지만 진행할 일이 없다고 답함' };
    return { kind: 'unknown' };
  }

  async tick() {
    for (const id of this.ids()) {
      if (this.running.has(id)) continue;
      let c;
      try { c = this.store.getConversation(id); } catch { continue; }
      if (!c.watch || !c.watch.enabled) continue;
      // 이미 새 대화로 넘어간 대화면 점검도 그쪽으로 옮긴다
      if (c.handedOffTo) { c = this.follow(c); if (!c) continue; }
      await this.check(c).catch((e) => { console.error('[watch]', c.title, e.message); this.save(c.id, { note: `점검 오류: ${e.message}`.slice(0, 300) }); });
    }
  }

  follow(c) {
    let cur = c;
    for (let i = 0; i < 20 && cur.handedOffTo; i++) {
      try { cur = this.store.getConversation(cur.handedOffTo); } catch { return null; }
    }
    if (cur.id === c.id) return c;
    if (!(cur.watch && cur.watch.enabled)) { cur.watch = { ...c.watch, seen: null, note: '이전 대화에서 이어받음' }; this.store.saveConversation(cur, false); }
    this.save(c.id, { enabled: false, state: 'off', note: '새 대화로 넘김', nextCheckAt: null });
    return this.store.getConversation(cur.id);
  }

  async check(c) {
    const w = c.watch;
    const t = Date.now();
    const st = this.classify(c);
    const last = c.messages[c.messages.length - 1];
    const lastId = last ? last.id : null;
    const interval = (w.intervalMin || 30) * 60000;
    const due = !w.nextCheckAt || Date.parse(w.nextCheckAt) <= t;
    // 사람이 새 메시지를 보냈으면 이어가기 횟수를 되돌린다
    const humanTurn = c.messages.slice(-2).some((m) => m.role === 'user' && !isAuto(m));
    if (humanTurn && (w.continues || w.failStreak)) this.save(c.id, { continues: 0, failStreak: 0 });

    switch (st.kind) {
      case 'busy':
        if (due || w.state !== 'busy') this.save(c.id, { state: 'busy', lastCheckAt: now(), nextCheckAt: new Date(t + interval).toISOString() });
        return;
      case 'done':
        this.save(c.id, { enabled: false, state: 'done', lastCheckAt: now(), nextCheckAt: null, note: '업무 완료 표시를 확인해 점검을 껐어요' });
        return;
      case 'empty':
        if (due) this.save(c.id, { state: 'watching', lastCheckAt: now(), nextCheckAt: new Date(t + interval).toISOString() });
        return;
      case 'idle':
      case 'paused':
        // 같은 마지막 메시지면 다시 보지 않는다 (새 메시지가 오면 다시 판단)
        if (w.seen !== lastId) this.save(c.id, { state: st.kind, seen: lastId, lastCheckAt: now(), note: st.why });
        return;
      case 'interrupted': {
        // 끊긴 작업은 마지막 활동 뒤 3분이 지나면 주기와 상관없이 다시 가동한다
        const quietFor = t - Date.parse(c.updatedAt || 0);
        if (!due && quietFor < EARLY_MS) return;
        if ((w.failStreak || 0) >= FAIL_LIMIT) {
          if (w.seen !== lastId) this.save(c.id, { state: 'paused', seen: lastId, note: `다시 가동해도 ${FAIL_LIMIT}번 연속 오류가 나 멈췄어요. 원인(요금·서버 상태)을 확인한 뒤 메시지를 보내면 다시 점검해요` });
          return;
        }
        if ((w.continues || 0) >= CONTINUE_LIMIT) {
          if (w.seen !== lastId) this.save(c.id, { state: 'paused', seen: lastId, note: `사람 손 없이 ${CONTINUE_LIMIT}번 이어갔어요. 진행 상황을 확인한 뒤 메시지를 보내면 다시 점검해요` });
          return;
        }
        await this.send(c, RESUME_TEXT(st.why), st.why);
        return;
      }
      case 'unknown':
        if (!due) return;
        if (w.seen === lastId) { this.save(c.id, { lastCheckAt: now(), nextCheckAt: new Date(t + interval).toISOString() }); return; }
        await this.send(c, CHECK_TEXT(w.intervalMin || 30), '정기 점검');
        return;
      default:
    }
  }

  // 대화에서 한 턴을 실행한다. 컨텍스트가 무거우면 먼저 새 대화로 인계한다
  async send(c, text, why) {
    const sourceId = c.id;
    this.running.add(sourceId);
    try {
      const info = this.runner.contextInfo(c);
      if (this.store.getSettings().generation.autoHandoff !== false && info.handoffAdvice) {
        const draft = await this.runner.handoffDraft(c.id);
        // 작성 중 사람이 이 방을 이어받았으면 점검이 새 방을 먼저 선점하지 않는다.
        if (this.runner.isBusy(sourceId)) return;
        c = this.runner.createHandoff(c.id, draft);
      }
      const w = c.watch;
      this.save(c.id, { state: 'running', lastCheckAt: now(), note: why, continues: (w.continues || 0) + 1 });
      const out = await this.runner.runHeadless({ conversationId: c.id, content: text }, { watch: true });
      const fresh = this.store.getConversation(c.id);
      const failed = !out.message || out.message.status === 'error';
      const next = failed ? Math.min((fresh.watch.intervalMin || 30) * 60000, EARLY_MS * ((fresh.watch.failStreak || 0) + 1)) : (fresh.watch.intervalMin || 30) * 60000;
      this.save(c.id, {
        failStreak: failed ? (fresh.watch.failStreak || 0) + 1 : 0,
        state: 'watching', seen: null,
        note: failed ? `다시 가동했지만 오류: ${String(out.error || '').slice(0, 200)}` : `${why} → 다시 가동함`,
        nextCheckAt: new Date(Date.now() + next).toISOString()
      });
      // 끝난 결과를 바로 반영 (완료 표시면 끄고, 대기면 멈춤)
      const after = this.classify(this.store.getConversation(c.id));
      if (after.kind === 'done') this.save(c.id, { enabled: false, state: 'done', nextCheckAt: null, note: '업무 완료 표시를 확인해 점검을 껐어요' });
      else if (after.kind === 'idle') this.save(c.id, { state: 'idle', seen: this.store.getConversation(c.id).messages.at(-1).id, note: after.why });
    } finally {
      this.running.delete(sourceId);
    }
  }
}

module.exports = { ConvWatcher, RESUME_TEXT, CHECK_TEXT };
