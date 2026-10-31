[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_-]{1,100}$')][string]$ProjectId,[Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_-]{1,100}$')][string]$ExpectedProjectId)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Target.ps1')
$taskSdk=Join-Path $env:LOCALAPPDATA 'Google/Cloud SDK/google-cloud-sdk'
$taskPython=Join-Path $taskSdk 'platform/bundledpython/python.exe'
$taskEntry=Join-Path $taskSdk 'lib/gcloud.py'
if(-not (Test-Path -LiteralPath $taskPython -PathType Leaf)){throw 'Cloud SDK native Python unavailable'}
$taskSource=@'
import errno,hashlib,json,os,re,socket,sqlite3,subprocess,time
from pathlib import Path
project='__NEW_PROJECT__'
expected='__OLD_PROJECT__'
root=Path('/opt/h3')
for name in ('worker','adapter','comfy'):
    p=subprocess.run(['systemctl','show','bao-h3-outbound-'+name+'.service','--property=ActiveState,MainPID'],capture_output=True,text=True,timeout=8)
    values=dict(line.split('=',1) for line in p.stdout.splitlines() if '=' in line)
    if p.returncode or values.get('ActiveState') not in ('inactive','failed') or values.get('MainPID')!='0': raise SystemExit('services_must_be_stopped')
for port in (45470,8188,8189):
    with socket.socket() as sock:
        sock.settimeout(.3)
        if sock.connect_ex(('127.0.0.1',port))!=errno.ECONNREFUSED: raise SystemExit('h3_listener_not_idle')
gpu=subprocess.run(['nvidia-smi','--query-compute-apps=pid','--format=csv,noheader'],capture_output=True,text=True,timeout=8)
if gpu.returncode or gpu.stdout.strip(): raise SystemExit('gpu_process_not_idle')
journal=root/'receipts/outbound'
if not journal.is_dir() or len(list(journal.glob('*.json')))>1000 or list(journal.glob('*.tmp')): raise SystemExit('journal_unverified')
for file in journal.glob('*.json'):
    if file.is_symlink() or file.stat().st_size>262144 or json.loads(file.read_text()).get('state') not in ('succeeded','failed','cancelled'): raise SystemExit('pending_receipt')
for file in (f for f in (root/'outbound/state').glob('*') if f.suffix in ('.db','.sqlite','.sqlite3')):
    if file.is_symlink(): raise SystemExit('state_database_unverified')
    with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True,timeout=2) as db:
        tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'jobs' not in tables: raise SystemExit('state_database_unverified')
        if 'jobs' in tables and db.execute("SELECT COUNT(*) FROM jobs WHERE status NOT IN ('succeeded','failed','cancelled')").fetchone()[0]: raise SystemExit('database_not_idle')
        if 'request_keys' in tables and db.execute("SELECT COUNT(*) FROM request_keys r LEFT JOIN jobs j ON j.id=r.task_id WHERE r.status NOT IN ('accepted','failed') OR (r.status='accepted' AND (j.id IS NULL OR j.status NOT IN ('succeeded','failed','cancelled')))").fetchone()[0]: raise SystemExit('request_key_unresolved')
file=root/'outbound/worker.env'
if file.is_symlink() or not file.is_file(): raise SystemExit('environment_unverified')
raw=file.read_bytes();text=raw.decode();matches=list(re.finditer(r'^BAO_PROJECT_ID=(.*)$',text,re.M))
if len(matches)!=1: raise SystemExit('project_key_ambiguous')
old=matches[0].group(1).strip().strip('"\'')
if old!=expected: raise SystemExit('project_changed_before_binding')
if old==project:
    print(json.dumps({'bound':True,'projectId':project,'previousProjectId':old,'changed':False,'servicesStarted':False,'generationSubmitted':False}));raise SystemExit(0)
updated=text[:matches[0].start(1)]+project+text[matches[0].end(1):]
backup=root/'receipts'/('worker-project-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+hashlib.sha256(raw).hexdigest()[:12]+'.env')
fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'wb') as output: output.write(raw);output.flush();os.fsync(output.fileno())
temporary=file.with_name('worker.env.binding.tmp')
fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as output: output.write(updated);output.flush();os.fsync(output.fileno())
original=file.stat();os.chown(temporary,original.st_uid,original.st_gid)
if file.read_bytes()!=raw: temporary.unlink();raise SystemExit('environment_changed_before_commit')
temporary.replace(file)
print(json.dumps({'bound':True,'projectId':project,'previousProjectId':old,'changed':True,'credentialsAndProfilePreserved':True,'privateBackupWritten':True,'servicesStarted':False,'generationSubmitted':False}))
'@
$taskSource=$taskSource.Replace('__NEW_PROJECT__',$ProjectId).Replace('__OLD_PROJECT__',$ExpectedProjectId)
$taskEncoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($taskSource))
$taskRemote="sudo python3 -c `"import base64;exec(base64.b64decode('$taskEncoded'))`""
$taskReply=& $taskPython -S $taskEntry compute ssh $targetVm --project=$targetProject --zone=$targetZone --account=$targetAccount --tunnel-through-iap --quiet --ssh-flag=-batch "--command=$taskRemote" 2>&1
if($LASTEXITCODE -ne 0){throw 'Project binding refused or response unknown. Read runtime before retrying. No services were started by this helper.'}
$taskJson=@($taskReply|ForEach-Object{[string]$_}|Where-Object{$_ -match '^\{' -and $_ -match '"bound"'})|Select-Object -Last 1
if(-not $taskJson){throw 'Project binding receipt missing; inspect runtime before retrying'}
$taskJson
