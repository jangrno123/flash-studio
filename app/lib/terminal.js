'use strict';
// 터미널: 모델(run_command)과 사용자가 실행한 PowerShell 명령을 한곳에 기록하고 출력을 실시간으로 모은다.
// 오른쪽 패널의 "터미널" 탭이 이 기록을 보여준다.
const { spawn } = require('child_process');

const MAX_ENTRIES = 150;
const MAX_OUT = 200000;
const CWD_MARK = '__FLASH_CWD__';

class Terminal {
  constructor(defaultCwd) {
    this.entries = [];
    this.seq = 0;
    this.version = 0;
    this.cwd = defaultCwd; // 사용자 명령용 현재 폴더 (cd 가 이어진다)
    this.procs = new Map();
  }

  // source: 'model' | 'user'. 반환 { code, out }
  run(command, { cwd, signal, source = 'model', convId = null, timeoutMs = 120000 } = {}) {
    const entry = { id: ++this.seq, command, cwd: cwd || this.cwd, source, convId, startedAt: new Date().toISOString(), endedAt: null, running: true, code: null, out: '' };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.version++;
    const trackCwd = source === 'user';
    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'\n${command}${trackCwd ? `\n"${CWD_MARK}" + (Get-Location).ProviderPath` : ''}`;
    return new Promise((resolve) => {
      let p;
      try {
        p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { cwd: entry.cwd, windowsHide: true });
      } catch (e) {
        Object.assign(entry, { running: false, code: -1, out: e.message, endedAt: new Date().toISOString() });
        this.version++;
        resolve({ code: -1, out: e.message });
        return;
      }
      this.procs.set(entry.id, p);
      const add = (d) => {
        entry.out += d.toString('utf8');
        if (entry.out.length > MAX_OUT) entry.out = entry.out.slice(-MAX_OUT);
        this.version++;
      };
      p.stdout.on('data', add);
      p.stderr.on('data', add);
      const timer = setTimeout(() => { add(`\n(${Math.round(timeoutMs / 1000)}초가 지나 중단했습니다)`); p.kill(); }, timeoutMs);
      const onAbort = () => p.kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.procs.delete(entry.id);
        if (trackCwd) {
          const i = entry.out.lastIndexOf(CWD_MARK);
          if (i !== -1) {
            const dir = entry.out.slice(i + CWD_MARK.length).split(/\r?\n/)[0].trim();
            if (dir) this.cwd = dir;
            entry.out = entry.out.slice(0, i).replace(/\s+$/, '');
          }
        }
        Object.assign(entry, { running: false, code, endedAt: new Date().toISOString() });
        this.version++;
        resolve({ code, out: entry.out });
      };
      p.on('close', (code) => finish(code ?? -1));
      p.on('error', (e) => { add(e.message); finish(-1); });
    });
  }

  kill(id) {
    const p = this.procs.get(Number(id));
    if (!p) return false;
    p.kill();
    return true;
  }

  // 패널용: 최근 기록 (출력은 뒤쪽만)
  snapshot(convId = null) {
    const list = this.entries.filter((e) => !convId || e.source === 'user' || e.convId === convId).slice(-60);
    return { version: this.version, cwd: this.cwd, entries: list.map((e) => ({ ...e, out: e.out.length > 20000 ? `…(앞부분 생략)\n${e.out.slice(-20000)}` : e.out })) };
  }

  clear() {
    this.entries = this.entries.filter((e) => e.running);
    this.version++;
  }
}

module.exports = { Terminal };
