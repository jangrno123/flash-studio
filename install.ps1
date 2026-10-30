# Flash Studio 설치 스크립트: Node.js 확인, 바로가기 생성, 기본 데이터 준비
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ''
Write-Host '  Flash Studio 설치' -ForegroundColor Yellow
Write-Host "  위치: $root"
Write-Host ''

# 1) Node.js 확인
$node = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = Join-Path $root 'runtime\node.exe'
if (Test-Path -LiteralPath $bundledNode) { $node = [PSCustomObject]@{Source=$bundledNode} }
if (-not $node) {
  Write-Host '  [!] Node.js 를 찾지 못했습니다.' -ForegroundColor Red
  Write-Host '      https://nodejs.org 에서 LTS 버전을 설치하거나 아래 명령을 실행한 뒤 다시 설치하세요.'
  Write-Host '      winget install OpenJS.NodeJS.LTS'
  exit 1
}
$ver = (& $node.Source -v).TrimStart('v')
if ([int]($ver.Split('.')[0]) -lt 18) {
  Write-Host "  [!] Node.js $ver 는 너무 오래되었습니다. 18 이상이 필요합니다." -ForegroundColor Red
  exit 1
}
Write-Host "  [OK] Node.js $ver"

# 2) 저장소만 초기화한다. 서버·대기열·모델 요청은 시작하지 않는다.
& $node.Source (Join-Path $root 'scripts\initialize.cjs')
if ($LASTEXITCODE -ne 0) { throw '기본 데이터 초기화 실패. 기존 설정은 초기화하지 않았습니다.' }
if (Test-Path (Join-Path $root 'data\settings.json')) { Write-Host '  [OK] 기본 설정 생성 (data\settings.json)' }

# 3) 바로가기
$vbs = Join-Path $root 'Flash Studio.vbs'
$ico = Join-Path $root 'app.ico'
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Flash Studio.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Flash Studio.lnk')
)
foreach ($t in $targets) {
  $lnk = $shell.CreateShortcut($t)
  $lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $lnk.Arguments = "`"$vbs`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$ico,0"
  $lnk.Description = 'Flash Studio - 로컬 LLM 스튜디오'
  $lnk.Save()
  Write-Host "  [OK] 바로가기: $t"
}

# 4) API 키 상태 안내
$ark = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
if ($ark) { Write-Host '  [OK] DEEPSEEK_API_KEY 사용자 환경변수가 등록되어 있습니다.' }
else {
  Write-Host ''
  Write-Host '  [안내] DEEPSEEK_API_KEY 환경변수가 없습니다. 둘 중 하나로 키를 등록하세요.' -ForegroundColor Cyan
  Write-Host '    - 앱 실행 후 설정 > 모델 공급자 > API 키 칸에 입력'
  Write-Host '    - 또는 PowerShell 에서: setx DEEPSEEK_API_KEY "발급받은키"'
}
Write-Host ''
Write-Host '  설치가 끝났습니다. 바탕화면의 Flash Studio 아이콘으로 실행하세요.' -ForegroundColor Green
Write-Host ''
