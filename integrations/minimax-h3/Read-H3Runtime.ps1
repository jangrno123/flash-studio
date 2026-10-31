[CmdletBinding()]
param([string]$OutFile,[switch]$PlanOnly,[switch]$HashModels)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Target.ps1')
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Use PowerShell 7.' }
$taskSource=Join-Path $PSScriptRoot 'inspect_h3_readonly.py'
if (-not (Test-Path -LiteralPath $taskSource -PathType Leaf)) { throw 'Missing inspect_h3_readonly.py' }
if ($PlanOnly) {
    [pscustomobject]@{readOnly=$true;project=$targetProject;vm=$targetVm;zone=$targetZone;startsVm=$false;startsService=$false;inference=$false;fullModelHash=[bool]$HashModels}|ConvertTo-Json
    exit 0
}
$taskRaw=& gcloud compute instances describe $targetVm --project=$targetProject --zone=$targetZone '--format=json(name,status)' 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Read-only VM describe failed. Check your existing gcloud connection; no start was attempted.' }
try {$taskVm=($taskRaw|Out-String)|ConvertFrom-Json} catch {throw 'VM describe did not return JSON.'}
if ($taskVm.status -ne 'RUNNING') { throw 'VM is not RUNNING. This reader does not start it.' }
$taskPythonSource=[IO.File]::ReadAllText($taskSource)
if ($HashModels) { $taskPythonSource="import sys`nsys.argv=['inspect','--hash-models']`n"+$taskPythonSource }
$taskBytes=[Text.Encoding]::UTF8.GetBytes($taskPythonSource)
$taskEncoded=[Convert]::ToBase64String($taskBytes)
$taskPythonCode="import base64;exec(base64.b64decode('$taskEncoded'))"
$taskRemote='sudo /opt/h3/venv/bin/python -B -c "'+$taskPythonCode+'"'
$taskReply=& gcloud compute ssh $targetVm --project=$targetProject --zone=$targetZone --tunnel-through-iap --quiet "--command=$taskRemote" 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Read-only SSH inspection failed. No services, models or jobs were started by this tool.' }
$taskLine=@($taskReply | ForEach-Object {[string]$_} | Where-Object {$_ -match '^\{"' -and $_ -match '"h3-grok-readonly/v1"'}) | Select-Object -Last 1
if (-not $taskLine) { throw 'No structured snapshot returned; do not treat inspection as successful.' }
$taskObject=$taskLine|ConvertFrom-Json
if ($taskObject.readOnly -ne $true) { throw 'Unexpected snapshot schema' }
if (-not $OutFile) {$OutFile=Join-Path $PSScriptRoot ('runtime-snapshot-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'.json')}
if (Test-Path -LiteralPath $OutFile) { throw 'Output exists; preserve the prior snapshot and choose a new output path.' }
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutFile),$taskLine,[Text.UTF8Encoding]::new($false))
[pscustomobject]@{snapshot=[IO.Path]::GetFullPath($OutFile);readOnly=$true;profile=$taskObject.model.profile;workerProject=$taskObject.services.worker.values.BAO_PROJECT_ID;adapterProject=$taskObject.services.adapter.values.BAO_PROJECT_ID}|ConvertTo-Json
