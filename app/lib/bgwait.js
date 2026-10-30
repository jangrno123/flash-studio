'use strict';
// 백그라운드 확인 (CONTEXT.md §15)
// 생성·렌더를 접수한 뒤 모델이 붙잡고 기다리지 않게, 서버가 상태 조회를 대신 반복한다.
// 모델은 그동안 다른 일을 하고, 끝나면 결과가 그 대화에 알림으로 들어온다.
// - 그 대화에 실행이 돌고 있으면 추가 지시(steer)로 넣는다
// - 대기열 대화면 작업의 다음 메시지에 붙인다 (대기열은 확인이 끝날 때까지 모델을 부르지 않고 기다린다)
// - 일반 대화에서 실행이 끝나 있으면 그 대화에서 한 턴을 새로 가동해 결과를 더블체크하게 한다
// 조회는 모델 호출이 아니라서 토큰이 들지 않는다. 간격은 점점 늘린다(최대 2분).
const { newId, now } = require('./store');
const {pollKey,pollInputError,pollFailure}=require('./poll-policy');

const TICK_MS = 5000;
const MIN_INTERVAL = 15;         // 초
const MAX_INTERVAL = 120;
const DEFAULT_TIMEOUT = 3600;    // 영상 렌더가 길어질 때를 생각해 1시간
const MAX_TIMEOUT = 4 * 3600;
const GATHER_MS = 10000;         // 비슷한 때 끝난 결과는 모아서 한 번에 알린다
const MAX_PER_CONV = 30;
const RESUME_LIMIT = 30;         // 사람 메시지 없이 확인 결과로 다시 가동한 횟수 상한

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…(이하 생략)` : s);
const isAutoMsg = (m) => m && m.role === 'user' && /^\[(백그라운드 확인|자동 점검)\]/.test(m.content || '');

class BackgroundWaits {
  constructor({ store, runner }) {
    this.store = store;
    this.runner = runner;
    this.inflight = new Set();     // 지금 조회 중인 확인 id
    this.state = new Map();        // id → { n, value, nextAt }
    this.outbox = new Map();       // convId → { notes: [], timer }
    this.convs = new Set();        // 확인이 걸린 대화 id
    this.timer = null;
  }

  start() {
    this.restore();
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[bgwait] tick', e.message)), TICK_MS);
  }

  stop() { clearInterval(this.timer); }

  // 서버가 다시 켜지면 대화 파일에 남은 확인을 이어서 돈다
  restore() {
    for (const meta of this.store.listConversations()) {
      let c;
      try { c = this.store.getConversation(meta.id); } catch { continue; }
      for (const w of c.bgWaits || []) { this.state.set(w.id, { n: w.n || 0, value: w.lastValue || null, nextAt: Date.now() + 10000 }); this.convs.add(c.id); }
    }
  }

  // 대화 하나에 걸린 확인 수
  pending(convId) {
    try { return (this.store.getConversation(convId).bgWaits || []).length; } catch { return 0; }
  }
  keepsAlive() { return this.state.size > 0; }

  list(convId) {
    const c = this.store.getConversation(convId);
    return (c.bgWaits || []).map((w) => ({ ...w, n: this.state.get(w.id)?.n ?? w.n, lastValue: this.state.get(w.id)?.value ?? w.lastValue }));
  }

  // poll_until(background) 와 반복 상태 조회에서 부른다. spec: { tool, arguments, field, until, contains, label, interval_seconds, timeout_seconds }
  add(convId, spec) {
    const c = this.store.getConversation(convId);
    const waits = c.bgWaits || (c.bgWaits = []);
    const inputError=pollInputError(spec.arguments,spec.tool);if(inputError)throw new Error(inputError);
    const key = pollKey(spec.tool,spec.arguments);
    const dup = waits.find((w) => pollKey(w.tool,w.arguments) === key);
    if (dup) return { wait: dup, duplicate: true };
    if (waits.length >= MAX_PER_CONV) throw new Error(`백그라운드 확인은 대화당 ${MAX_PER_CONV}건까지예요. 끝난 것부터 정리한 뒤 다시 등록하세요`);
    const timeout = Math.min(MAX_TIMEOUT, Math.max(60, Number(spec.timeout_seconds) || DEFAULT_TIMEOUT));
    const w = {
      id: newId(), key, tool: spec.tool, arguments: spec.arguments || {},
      field: spec.field || 'status', until: spec.until || null, contains: spec.contains || '',
      label: String(spec.label || '').slice(0, 200) || spec.tool.split('__').pop(),
      interval: Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Number(spec.interval_seconds) || 20)),
      startedAt: now(), deadline: new Date(Date.now() + timeout * 1000).toISOString(), n: 0, lastValue: null
    };
    waits.push(w);
    this.store.saveConversation(c, false);
    this.convs.add(c.id);
    this.state.set(w.id, { n: 0, value: null, nextAt: Date.now() + w.interval * 1000 });
    return { wait: w, duplicate: false };
  }

  cancel(convId, waitId) {
    const c = this.store.getConversation(convId);
    const before = (c.bgWaits || []).length;
    c.bgWaits = (c.bgWaits || []).filter((w) => w.id !== waitId);
    this.state.delete(waitId);
    if (c.bgWaits.length !== before) this.store.saveConversation(c, false);
    return before !== c.bgWaits.length;
  }

  async tick() {
    const t = Date.now();
    for (const id of [...this.convs]) {
      let c;
      try { c = this.store.getConversation(id); } catch { this.convs.delete(id); continue; }
      if (!(c.bgWaits || []).length) { this.convs.delete(id); continue; }
      for (const w of [...(c.bgWaits || [])]) {
        const st = this.state.get(w.id) || { n: w.n || 0, value: null, nextAt: t };
        this.state.set(w.id, st);
        if (this.inflight.has(w.id) || st.nextAt > t) continue;
        this.inflight.add(w.id);
        this.poll(c.id, w, st).catch((e) => console.error('[bgwait]', w.label, e.message)).finally(() => this.inflight.delete(w.id));
      }
    }
  }

  async poll(convId, w, st) {
    const ctx = this.runner.pollContext(convId);
    const target = this.runner.pollTarget(w.tool, w.arguments, ctx);
    if (target.error) return this.finish(convId, w, st, { kind: 'error', text: target.error });
    st.n++;
    let r;
    try { r = await target.call(); } catch (e) { r = { text: `조회 오류: ${e.message}`, isError: true }; }
    const text = r.text || '';
    const failure=pollFailure(r);st.errorStreak=failure?(st.errorStreak||0)+1:0;
    if(failure?.terminal||st.errorStreak>=5)return this.finish(convId,w,st,{kind:'error',text:`${failure?.reason||'조회 오류 5회 연속'}\n자동 재실행하지 말고 정확한 작업 ID와 상태를 확인하세요.`});
    const check = this.runner.pollCheck(text, w);
    st.value = check.value;
    if (check.hit) return this.finish(convId, w, st, { kind: 'done', text, value: check.value });
    if (Date.now() >= Date.parse(w.deadline)) return this.finish(convId, w, st, { kind: 'timeout', text, value: check.value });
    // 세 번째부터 1.5배씩 늘린다 (최대 2분)
    const sec = Math.min(MAX_INTERVAL, w.interval * 1.5 ** Math.max(0, st.n - 2));
    st.nextAt = Date.now() + sec * 1000;
  }

  finish(convId, w, st, res) {
    // 대화에서 확인을 지운다 (이미 새 대화로 넘어갔어도 원래 대화에 남은 것을 지운다)
    let c;
    try { c = this.store.getConversation(convId); } catch { return; }
    c.bgWaits = (c.bgWaits || []).filter((x) => x.id !== w.id);
    this.store.saveConversation(c, false);
    this.state.delete(w.id);
    const mins = Math.max(1, Math.round((Date.now() - Date.parse(w.startedAt)) / 60000));
    const head = res.kind === 'done'
      ? `■ ${w.label}: 끝남 (${w.contains ? `"${w.contains}" 확인` : `${w.field}=${res.value}`}, ${st.n}회 조회 · 약 ${mins}분)`
      : res.kind === 'timeout'
        ? `■ ${w.label}: 시간 초과 — 약 ${mins}분 동안 끝나지 않음 (마지막 ${w.field}=${res.value ?? '?'})`
        : `■ ${w.label}: 확인할 수 없음 — ${res.text}`;
    this.queueNote(convId, `${head}\n${clip(res.text, 1500)}`);
  }

  // 결과를 모아서 대화에 알린다
  queueNote(convId, note) {
    const box = this.outbox.get(convId) || { notes: [], timer: null };
    box.notes.push(note);
    this.outbox.set(convId, box);
    if (!box.timer) box.timer = setTimeout(() => { this.outbox.delete(convId); this.deliver(convId, box.notes).catch((e) => console.error('[bgwait] deliver', e.message)); }, GATHER_MS);
  }

  message(notes, convId) {
    const left = this.pending(convId);
    return [
      '[백그라운드 확인] 접수해 둔 작업의 상태 확인 결과입니다.',
      '',
      notes.join('\n\n'),
      '',
      '끝난 것은 결과물을 직접 한 번 더 확인(더블체크)하세요. 노드·에셋에 실제로 붙었는지, 원본과 맞는지 봅니다. 그다음 단계로 진행하세요.',
      '실패했거나 시간이 초과된 것은 원인부터 확인하고, 필요한 것만 다시 제출하세요. 이미 끝난 생성을 다시 제출하지 마세요.',
      left ? `아직 확인 중인 작업이 ${left}건 남아 있습니다. 그 결과는 끝나는 대로 따로 알려 드립니다.` : ''
    ].filter((x) => x !== null).join('\n').trim();
  }

  async deliver(convId, notes) {
    let c;
    try { c = this.store.getConversation(convId); } catch { return; }
    // 새 대화로 넘어갔으면 가장 최근 대화로 보낸다
    for (let i = 0; i < 20 && c.handedOffTo; i++) { try { c = this.store.getConversation(c.handedOffTo); } catch { break; } }
    const text = this.message(notes, c.id);

    // 1) 실행 중이면 추가 지시로 넣는다
    const runId = this.runner.activeRunFor(c.id);
    if (runId && this.runner.steer(runId, text)) return;

    // 2) 대기열 대화: 다음 메시지에 붙인다 (대기열 루프가 확인이 끝나기를 기다렸다가 이어 간다)
    const q = this.runner.queue;
    const job = c.queueJobId && q ? q.get(c.queueJobId) : null;
    if (job) {
      q.update(job.id, (j) => { j.editNote = [j.editNote, text].filter(Boolean).join('\n\n').slice(-20000); });
      return;
    }

    // 3) 일반 대화: 그 대화에서 한 턴을 가동한다. 사람 없이 너무 많이 돌면 멈추고 알림만 남긴다
    const human = [...c.messages].reverse().find((m) => m.role === 'user' && !isAutoMsg(m));
    const auto = c.messages.slice(human ? c.messages.indexOf(human) + 1 : 0).filter(isAutoMsg).length;
    if (runId || auto >= RESUME_LIMIT) {
      c.bgNotes = [...(c.bgNotes || []), text].slice(-10);
      this.store.saveConversation(c, false);
      return;
    }
    await this.runner.runHeadless({ conversationId: c.id, content: text }, { watch: true });
  }

  // 사람이 보낸 다음 실행에 미뤄 둔 알림을 싣는다 (chat.handle 에서 부른다)
  takeNotes(conv) {
    const notes = conv.bgNotes || [];
    if (!notes.length) return [];
    conv.bgNotes = [];
    return notes;
  }
}

module.exports = { BackgroundWaits };
