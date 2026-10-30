'use strict';
// 절전 방지: 작업이 남아 있는 동안 PC가 절전 모드로 들어가지 않게 한다 (화면 꺼짐은 막지 않음).
// SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) 를 건 PowerShell 을 띄워 두고, 필요 없으면 끝낸다.
// 설정을 바꾸지 않으며, 이 프로세스가 끝나면 윈도우 기본 절전 동작으로 돌아간다.
const { spawn } = require('child_process');

const SCRIPT = `
Add-Type -Namespace Flash -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[Flash.Power]::SetThreadExecutionState(0x80000001) | Out-Null
while ($true) { Start-Sleep -Seconds 60; [Flash.Power]::SetThreadExecutionState(0x80000001) | Out-Null }
`;

class KeepAwake {
  constructor() { this.proc = null; }
  get active() { return !!this.proc; }
  set(on) {
    if (on && !this.proc) {
      this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, stdio: 'ignore' });
      this.proc.on('exit', () => { this.proc = null; });
    } else if (!on && this.proc) {
      try { this.proc.kill(); } catch { /* 무시 */ }
      this.proc = null;
    }
  }
}

module.exports = { KeepAwake };
