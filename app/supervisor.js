'use strict';
// 24시간 감시자: Flash Studio 서버를 띄우고, 죽으면 다시 띄운다 (CONTEXT.md §13).
// "Flash Studio 24h.vbs" 가 창 없이 이 파일을 실행한다. 윈도우 시작 시 자동 실행은 대기열 "공정 설정"에서 켠다.
// - 이미 다른 서버(일반 실행기로 연 창 등)가 떠 있으면 새로 띄우지 않고 지켜보기만 한다.
// - 서버가 정상 종료(코드 0)하면 따라서 끝낸다. 그 밖의 종료는 잠시 뒤 다시 띄운다(연속 실패 시 간격을 늘림).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'data', 'logs');
const LOG = path.join(LOG_DIR, 'supervisor.log');
const PID = path.join(ROOT, 'data', '.cache', 'supervisor.pid');

function port() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'settings.json'), 'utf8')).server.port || 17860; } catch { return 17860; }
}
function log(msg) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch { /* 무시 */ }
}
async function alive() {
  try {
    const r = await fetch(`http://127.0.0.1:${port()}/api/ping`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 감시자는 하나만
try {
  fs.mkdirSync(path.dirname(PID), { recursive: true });
  const old = Number(fs.readFileSync(PID, 'utf8'));
  if (old && old !== process.pid) { try { process.kill(old, 0); log(`이미 감시자(${old})가 실행 중이라 끝냄`); process.exit(0); } catch { /* 죽은 기록 */ } }
} catch { /* 처음 */ }
fs.writeFileSync(PID, String(process.pid));
process.on('exit', () => { try { if (Number(fs.readFileSync(PID, 'utf8')) === process.pid) fs.unlinkSync(PID); } catch { /* 무시 */ } });

(async () => {
  log('감시자 시작');
  let fails = 0;
  for (;;) {
    if (await alive()) { await sleep(15000); continue; } // 다른 서버가 이미 떠 있다
    const started = Date.now();
    const out = fs.openSync(path.join(LOG_DIR, 'server.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js')], { cwd: path.join(ROOT, 'app'), stdio: ['ignore', out, out], windowsHide: true, env: { ...process.env, FLASH_IDLE_EXIT: '', FLASH_SUPERVISED: '1' } });
    log(`서버 시작 pid=${child.pid}`);
    const code = await new Promise((resolve) => child.on('exit', (c, sig) => resolve(sig ? `signal ${sig}` : c)));
    fs.closeSync(out);
    if (code === 0) { log('서버가 정상 종료해 감시자도 끝냄'); process.exit(0); }
    fails = Date.now() - started < 60000 ? fails + 1 : 0;
    const wait = Math.min(300, 5 * 2 ** Math.min(fails, 6));
    log(`서버 종료(${code}) — ${wait}초 뒤 다시 시작 (연속 실패 ${fails})`);
    await sleep(wait * 1000);
  }
})();
