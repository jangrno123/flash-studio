[CmdletBinding()]
param(
    [ValidateSet('Start', 'Status', 'Stop')]
    [string]$Action = 'Status',
    [switch]$DryRun,
    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Target.ps1')
if ($PrepareOnly -and $Action -ne 'Start') { throw 'PrepareOnly applies only to Start.' }
$script:PowerPhase = 'inspect_vm'
$script:PowerCode = 'helper_failed'
$script:PowerExitCode = $null
$script:StopDeadline = [DateTime]::UtcNow.AddSeconds(270)

function Write-StopEvent {
    param([string]$Phase, [string]$State, [string]$Code, $ExitCode = $null, $PowerState = $null)
    if ($Action -ne 'Stop') { return }
    # Fixed fields only. Native stderr, remote logs and account values are never emitted.
    [Console]::Out.WriteLine((@{schemaVersion='h3-power-helper/v1'; action='Stop'; phase=$Phase;
        state=$State; code=$Code; exitCode=$ExitCode; powerState=$PowerState;
        psVersion=$PSVersionTable.PSVersion.ToString(); psEdition=[string]$PSVersionTable.PSEdition} | ConvertTo-Json -Compress))
}

function Resolve-StopGcloud {
    if ($PSVersionTable.PSVersion.Major -lt 7) { $script:PowerCode='powershell_core_required'; throw 'Unsupported interpreter' }
    $roots = @()
    if ($env:CLOUDSDK_ROOT_DIR) { $roots += $env:CLOUDSDK_ROOT_DIR }
    $found = Get-Command gcloud -ErrorAction SilentlyContinue
    if ($found -and $found.Source -and (Split-Path (Split-Path $found.Source) -Leaf) -eq 'bin') {
        $roots += Split-Path (Split-Path $found.Source)
    }
    foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($base) { $roots += Join-Path $base 'Google/Cloud SDK/google-cloud-sdk' }
    }
    foreach ($root in $roots) {
        if (-not [IO.Path]::IsPathRooted($root)) { continue }
        $python = Join-Path $root 'platform/bundledpython/python.exe'
        $entry = Join-Path $root 'lib/gcloud.py'
        if ((Test-Path -LiteralPath $python -PathType Leaf) -and (Test-Path -LiteralPath $entry -PathType Leaf)) {
            return @{executable=(Resolve-Path -LiteralPath $python).Path; prefix=@('-S', (Resolve-Path -LiteralPath $entry).Path)}
        }
    }
    $native = Get-Command gcloud.exe -ErrorAction SilentlyContinue
    if ($native -and $native.CommandType -eq 'Application') { return @{executable=$native.Source; prefix=@()} }
    if (-not $IsWindows -and $found -and $found.CommandType -eq 'Application') {
        return @{executable=$found.Source; prefix=@()}
    }
    $script:PowerCode='gcloud_installation_unverified'; throw 'SDK entrypoint unavailable'
}

function Invoke-StopGcloud {
    param([string[]]$Arguments, [int]$TimeoutSeconds = 30)
    $remaining = [int]($script:StopDeadline - [DateTime]::UtcNow).TotalSeconds
    if ($remaining -le 0) { $script:PowerCode='helper_deadline_exceeded'; throw 'Deadline reached' }
    $timeout = [Math]::Min($TimeoutSeconds, $remaining)
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $script:StopCloud.executable
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false, $false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false, $false)
    $info.Environment['CLOUDSDK_SSH_PUTTY_FORCE_CONNECT'] = 'false'
    $info.Environment['PYTHONIOENCODING'] = 'utf-8'
    foreach ($argument in @($script:StopCloud.prefix) + $Arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'Process start failed' }
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($timeout * 1000)) {
            # Only the local management client is ended. Cloud outcome remains unknown.
            try { $process.Kill($true) } catch { }
            $script:PowerCode='gcloud_timeout'; throw 'Management request timed out'
        }
        $out = $stdout.GetAwaiter().GetResult()
        $err = $stderr.GetAwaiter().GetResult()
        $script:PowerExitCode = $process.ExitCode
        if ($process.ExitCode -ne 0) {
            $script:PowerCode = if ($err -match '(?i)permission.denied|not.authorized|forbidden') {'gcloud_permission_denied'}
                elseif ($err -match '(?i)reauth|login|invalid.grant|credentials') {'gcloud_authentication_failed'}
                elseif ($err -match '(?i)unrecognized.arguments|invalid.choice|unknown.flag') {'gcloud_cli_incompatible'}
                elseif ($err -match '(?i)quota|resource.exhausted') {'gcloud_resource_unavailable'}
                elseif ($script:PowerPhase -eq 'idle_handshake') {'idle_handshake_failed'} else {'gcloud_exit_nonzero'}
            Write-StopEvent $script:PowerPhase 'failed' $script:PowerCode $process.ExitCode
            throw 'Management request rejected'
        }
        if ($out.Length -gt 1048576) { $script:PowerCode='gcloud_output_too_large'; throw 'Response bound exceeded' }
        Write-StopEvent $script:PowerPhase 'succeeded' 'gcloud_exit_zero' 0
        return $out
    } finally { $process.Dispose() }
}

function Invoke-GcloudJson {
    param([string[]]$Arguments)
    if ($Action -eq 'Stop') {
        $json = Invoke-StopGcloud -Arguments ($Arguments + @('--quiet','--format=json'))
        try { return ($json | ConvertFrom-Json) } catch { $script:PowerCode='gcloud_json_invalid'; throw 'Invalid response' }
    }
    $lines = & gcloud @Arguments --quiet --format=json
    if ($LASTEXITCODE -ne 0) {
        throw 'Google Cloud command failed. Reauthenticate the existing authorized account if requested; no VM was created.'
    }
    return (($lines -join "`n") | ConvertFrom-Json)
}

function Assert-ExistingTarget {
    param($Vm)
    if ($Vm.name -ne $targetVm) { throw 'Existing VM identity mismatch.' }
    $accelerators = @($Vm.guestAccelerators)
    if ($accelerators.Count -ne 1 -or $accelerators[0].acceleratorCount -ne 1 -or
        $accelerators[0].acceleratorType -notmatch '/nvidia-a100-80gb$') {
        throw 'Existing VM is not the expected single A100 80GB. No start/resize/create was attempted.'
    }
}

function Invoke-PrivateCommand {
    param([string]$Command)
    # IAP is only a management SSH transport. It does not publish inference ports.
    # Base64 carries only this fixed command source, never credentials. It avoids
    # Windows native-argument quoting altering the multiline Python/heredoc.
    $remoteSource = $Command.Replace("`r`n", "`n").Replace("`r", "`n")
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteSource))
    $remoteCommand = "printf '%s' '$encodedCommand' | base64 --decode | bash"
    & gcloud compute ssh $targetVm --project=$targetProject --zone=$targetZone --tunnel-through-iap --quiet --command=$remoteCommand
    if ($LASTEXITCODE -ne 0) { throw 'Private server check/action failed. VM stop was not authorized by the check.' }
}

function Invoke-StopPython {
    param([string]$Code, [string]$Phase, [string]$Reason, [int]$TimeoutSeconds)
    # Same Python-only argv transport as the independently successful operator.
    # No printf|bash or heredoc: the encoded payload is fixed source, never secrets.
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Code))
    $remoteCommand = "sudo /opt/h3/venv/bin/python -B -c `"import base64;exec(base64.b64decode('$encoded'))`""
    $script:PowerPhase=$Phase
    $reply=Invoke-StopGcloud -Arguments @('compute','ssh',$targetVm,"--project=$targetProject","--zone=$targetZone",'--tunnel-through-iap','--quiet','--ssh-flag=-batch',"--command=$remoteCommand") -TimeoutSeconds $TimeoutSeconds
    $verified=$false
    foreach ($line in ($reply -split "`n")) {
        try {
            $item=$line | ConvertFrom-Json
            if ($item.safeToStop -eq $true -and $item.reason -eq $Reason -and $item.proof -eq 'stopped_idle_v1' -and
                $item.readings -eq 2 -and $item.allUnitsStopped -eq $true -and $item.gpuComputeProcesses -eq 0 -and
                $item.dbActiveJobs -eq 0 -and $item.workerPendingReceipts -eq 0 -and $item.activeListeners -eq 0) { $verified=$true }
        } catch { }
    }
    if (-not $verified) { $script:PowerCode='idle_handshake_receipt_missing'; throw 'Positive receipt missing' }
    Write-StopEvent 'services_stopped' 'succeeded' $Reason 0
}

if ($DryRun) {
    [pscustomobject]@{
        dryRun = $true
        action = $Action
        prepareOnly = [bool]$PrepareOnly
        project = $targetProject
        zone = $targetZone
        existingVm = $targetVm
        site = $siteUrl
        createsVmOrNetwork = $false
        startsLocalBao = $false
        submitsNewRender = $false
        stopRequiresIdleHandshake = ($Action -eq 'Stop')
        cloudCommandsExecuted = $false
    } | ConvertTo-Json
    exit 0
}

try {
if ($Action -eq 'Stop') { $script:StopCloud=Resolve-StopGcloud }
if ($Action -ne 'Stop' -and -not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    throw 'Install the Google Cloud CLI and authenticate the existing account first.'
}
$vm = Invoke-GcloudJson -Arguments @('compute', 'instances', 'describe', $targetVm, "--project=$targetProject", "--zone=$targetZone")
Assert-ExistingTarget -Vm $vm
if ($Action -eq 'Stop') { Write-StopEvent 'inspect_vm' 'succeeded' 'target_verified' 0 $vm.status }
Write-Host "Existing VM: $targetVm / $($vm.status) / $targetZone"

if ($Action -eq 'Start') {
    if ($vm.status -eq 'TERMINATED') {
        & gcloud compute instances start $targetVm --project=$targetProject --zone=$targetZone --quiet
        if ($LASTEXITCODE -ne 0) { throw 'The existing VM could not be started.' }
    } elseif ($vm.status -ne 'RUNNING') {
        throw 'The VM is changing state. Check Status before starting it again.'
    }
    if ($PrepareOnly) {
        Write-Host 'Existing VM available for preparation. No inference service start or queue consumption command was issued.'
        exit 0
    }
    # Existing setup/weights/env must already be installed. There is no bootstrap,
    # download, enable-at-boot, local BAO process, or new generation command here.
    $startCommand = @'
set -eu
test -f /opt/h3/outbound/worker.py
test -f /opt/h3/outbound/worker.env
sudo systemctl cat bao-h3-outbound-worker.service >/dev/null
sudo rm -f -- /opt/h3/outbound/pause-claims
sudo systemctl start bao-h3-outbound-adapter.service
sudo systemctl start bao-h3-outbound-worker.service
printf '%s\n' 'Existing H3 services started. Only jobs explicitly queued on BAO can run.'
'@
    Invoke-PrivateCommand -Command $startCommand
    Write-Host "Open BAO: $siteUrl"
    Write-Host 'Choose the GCP engine on BAO and explicitly run a node when ready. Existing queued jobs may resume.'
    exit 0
}

if ($Action -eq 'Status') {
    if ($vm.status -eq 'RUNNING') {
        $statusCommand = @'
sudo /opt/h3/venv/bin/python -B - <<'PY'
import json, subprocess, urllib.request
services = {}
for name in ('bao-h3-outbound-worker','bao-h3-outbound-adapter','bao-h3-outbound-comfy'):
    result = subprocess.run(['systemctl','is-active',name+'.service'],capture_output=True,text=True)
    services[name] = result.stdout.strip()
try:
    with urllib.request.urlopen('http://127.0.0.1:45470/healthz',timeout=5) as response:
        raw = json.load(response)
    health = {k:raw.get(k) for k in ('ok','model_files_ready','model_loaded','inference_verified','queue','running','model_load_failed','gpu')}
except Exception:
    health = {'verified':False,'reason':'loopback_health_unavailable'}
print(json.dumps({'services':services,'health':health}))
PY
'@
        Invoke-PrivateCommand -Command $statusCommand
    }
    Write-Host "BAO: $siteUrl"
    exit 0
}

if ($vm.status -eq 'TERMINATED') {
    Write-StopEvent 'confirm_terminated' 'succeeded' 'already_terminated' 0 'TERMINATED'
    Write-Host 'The existing VM is already stopped.'
    exit 0
}
if ($vm.status -ne 'RUNNING') { throw 'Cannot verify a safe stop while the VM is changing state.' }

$stoppedIdleProofPython = @'
import contextlib, errno, json, os, pathlib, socket, sqlite3, subprocess, sys, time, urllib.request
root = pathlib.Path('/opt/h3/outbound')
pause = root/'pause-claims'
units = ('h3-comfy','h3-quantized-adapter','h3-adapter','bao-h3-outbound-worker','bao-h3-outbound-adapter','bao-h3-outbound-comfy')
def stopped_idle_once():
    # Positive current reads only. Missing GPU/DB/service evidence never means idle.
    if not root.is_dir() or not pause.is_file() or pause.is_symlink():
        return False
    for name in units:
        p = subprocess.run(['systemctl','show',name+'.service','--property=MainPID,ActiveState,LoadState','--no-pager'],capture_output=True,text=True,timeout=5)
        values = dict(line.split('=',1) for line in p.stdout.splitlines() if '=' in line)
        if values.get('MainPID') != '0' or values.get('ActiveState') not in ('inactive','failed'):
            return False
        if values.get('LoadState') not in ('loaded','not-found') or (p.returncode and values.get('LoadState') != 'not-found'):
            return False
    gpu = subprocess.run(['nvidia-smi','--query-compute-apps=pid','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=8)
    if gpu.returncode or gpu.stdout.strip():
        return False
    # Read just the expected layout keys; never output environment credentials.
    layout = {}
    for line in (root/'worker.env').read_text().splitlines():
        if '=' in line:
            k,v = line.split('=',1)
            if k in ('H3_ROOT','H3_ADAPTER_STATE_DIR'):
                layout[k] = json.loads(v) if v.startswith('"') else v
    if layout.get('H3_ROOT','/opt/h3') != '/opt/h3' or layout.get('H3_ADAPTER_STATE_DIR',str(root/'state')) != str(root/'state'):
        return False
    primary = root/'state/jobs.db'
    if not primary.is_file():
        return False
    for db in (primary,pathlib.Path('/opt/h3/app/jobs.db')):
        if not db.exists():
            continue
        with contextlib.closing(sqlite3.connect(db.as_uri()+'?mode=ro',uri=True,timeout=1)) as connection:
            counts = connection.execute('SELECT status,COUNT(*) FROM jobs GROUP BY status').fetchall()
            if any(status not in ('succeeded','failed','cancelled') and count for status,count in counts):
                return False
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if db == primary and 'request_keys' not in tables:
                return False
            if 'request_keys' in tables:
                unresolved = connection.execute("SELECT COUNT(*) FROM request_keys r LEFT JOIN jobs j ON j.id=r.task_id WHERE r.status NOT IN ('accepted','failed') OR (r.status='accepted' AND (j.id IS NULL OR j.status NOT IN ('succeeded','failed','cancelled')))").fetchone()[0]
                if unresolved:
                    return False
    primary_journal = pathlib.Path('/opt/h3/receipts/outbound')
    if not primary_journal.is_dir():
        return False
    for folder in (primary_journal,root/'receipts/outbound'):
        if not folder.exists():
            continue
        records = list(folder.glob('*.json'))
        if len(records)>1000 or any(folder.glob('*.tmp')):
            return False
        for record in records:
            if record.is_symlink() or not record.is_file() or record.stat().st_size>262144:
                return False
            if json.loads(record.read_text()).get('state') not in ('succeeded','failed','cancelled'):
                return False
    for port in (45470,8188,8189):
        with socket.socket() as sock:
            sock.settimeout(.2)
            if sock.connect_ex(('127.0.0.1',port)) != errno.ECONNREFUSED:
                return False
    return True
def stopped_idle_proof():
    try:
        for reading in range(2):
            if not stopped_idle_once():
                return None
            if reading == 0:
                time.sleep(.25)
    except Exception:
        return None
    return {'safeToStop':True,'proof':'stopped_idle_v1','readings':2,'allUnitsStopped':True,
            'gpuComputeProcesses':0,'dbActiveJobs':0,'workerPendingReceipts':0,'activeListeners':0}
'@
$safeStopPython = @'
control = root/'worker-control.json'
requested = time.time()
pause_preexisting = pause.exists()
def refuse(code):
    if not pause_preexisting:
        pause.unlink(missing_ok=True)
    print(json.dumps({'safeToStop':False,'reason':code}))
    raise SystemExit(3)
def health():
    try:
        with urllib.request.urlopen('http://127.0.0.1:45470/healthz',timeout=5) as response:
            data = json.load(response)
        if type(data.get('queue')) is not int or 'running' not in data:
            refuse('health_contract_unverified')
        if data['queue'] != 0 or data['running'] is not None:
            refuse('job_running_or_queued')
        return data
    except SystemExit:
        raise
    except Exception:
        refuse('loopback_health_unavailable')
if not root.is_dir():
    print(json.dumps({'safeToStop':False,'reason':'outbound_installation_unverified'}))
    raise SystemExit(3)
# Ask the worker to acknowledge an idle loop before stopping any process.
fd = os.open(pause, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
os.close(fd)
os.chown(pause, __import__('pwd').getpwnam('h3').pw_uid, __import__('grp').getgrnam('h3').gr_gid)
# A prior operator may already have stopped the services. A dead health listener
# is not proof: require the full independent DB/GPU/PID/journal proof instead.
already_stopped = stopped_idle_proof()
if already_stopped:
    print(json.dumps(dict(already_stopped,reason='idle_handshake_verified')))
    raise SystemExit(0)
deadline = time.monotonic()+40
while True:
    health()
    worker = subprocess.run(['systemctl','is-active','bao-h3-outbound-worker.service'],capture_output=True,text=True)
    if worker.stdout.strip() != 'active':
        # No consumer may be alive while we make the final check.
        process = subprocess.run(['systemctl','show','bao-h3-outbound-worker.service','--property=MainPID','--value'],capture_output=True,text=True)
        if process.stdout.strip() not in ('0',''):
            refuse('worker_shutdown_unverified')
        break
    try:
        state = json.loads(control.read_text())
    except Exception:
        state = {}
    if state.get('loopState') == 'paused' and state.get('updatedAt',0) >= requested:
        break
    if time.monotonic() >= deadline:
        refuse('idle_handshake_unconfirmed')
    time.sleep(.5)
health()
# Claiming is paused, and both adapter queue/running are confirmed idle.
for name in ('bao-h3-outbound-worker','bao-h3-outbound-adapter','bao-h3-outbound-comfy'):
    result = subprocess.run(['systemctl','stop',name+'.service'],capture_output=True)
    if result.returncode:
        refuse('service_stop_failed')
proof = stopped_idle_proof()
if not proof:
    refuse('service_shutdown_unverified')
print(json.dumps(dict(proof,reason='idle_handshake_verified')))
'@
try {
    Invoke-StopPython -Code ($stoppedIdleProofPython+"`n"+$safeStopPython) -Phase 'idle_handshake' -Reason 'idle_handshake_verified' -TimeoutSeconds 130
} catch {
    # One read-only reconciliation of the SAME handshake, never another service
    # stop or cloud stop. A lost SSH reply after service shutdown is not evidence.
    Write-StopEvent 'idle_handshake' 'failed' $script:PowerCode $script:PowerExitCode
    $recoveryPython = $stoppedIdleProofPython+"`n"+@'
proof = stopped_idle_proof()
if not proof:
    print(json.dumps({'safeToStop':False,'reason':'stopped_idle_unverified'}))
    raise SystemExit(3)
print(json.dumps(dict(proof,reason='stopped_idle_reverified')))
'@
    Invoke-StopPython -Code $recoveryPython -Phase 'idle_recovery' -Reason 'stopped_idle_reverified' -TimeoutSeconds 50
}
# Only positive current idle proof can reach the first and only cloud Stop.
# Failed reconciliation, queued/running work or unknown evidence cannot. No force.
$script:PowerPhase='request_stop'
$null=Invoke-StopGcloud -Arguments @('compute','instances','stop',$targetVm,"--project=$targetProject","--zone=$targetZone",'--discard-local-ssd=false','--quiet') -TimeoutSeconds 90
Write-StopEvent 'request_stop' 'succeeded' 'stop_request_accepted' 0
# A successful stop request is not proof of the provider's terminal state.
for ($pollIndex = 0; $pollIndex -lt 15; $pollIndex++) {
    $script:PowerPhase='confirm_terminated'
    $stoppedVm = Invoke-GcloudJson -Arguments @('compute', 'instances', 'describe', $targetVm, "--project=$targetProject", "--zone=$targetZone")
    Assert-ExistingTarget -Vm $stoppedVm
    if ($stoppedVm.status -eq 'TERMINATED') {
        Write-StopEvent 'confirm_terminated' 'succeeded' 'termination_verified' 0 'TERMINATED'
        Write-Host 'Existing GCP VM TERMINATED after the idle check. Local SSD preserved; no force stop.'
        exit 0
    }
    if ($stoppedVm.status -ne 'STOPPING') { throw 'VM stop result is not TERMINATED. Manual inspection required; no repeated stop was sent.' }
    Start-Sleep -Seconds 2
}
$script:PowerCode='termination_unconfirmed'
throw 'VM stop request was accepted, but TERMINATED was not confirmed. No repeated stop was sent.'
} catch {
    if ($Action -ne 'Stop') { throw }
    Write-StopEvent $script:PowerPhase 'failed' $script:PowerCode $script:PowerExitCode
    exit 2
}
