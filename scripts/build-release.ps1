param([string]$NodeVersion = 'v24.20.0', [string]$NodeArchivePath = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
if ($NodeVersion -notmatch '^v\d+\.\d+\.\d+$') { throw 'Invalid Node.js version.' }
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$work = Join-Path $dist ('build-' + [Guid]::NewGuid().ToString('N'))
$package = Join-Path $work 'Flash-Studio'
$runtime = Join-Path $package 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
foreach ($item in @('app','schemas','scripts','README.md','package.json','Flash Studio.vbs','Flash Studio 24h.vbs','app.ico','install.bat','install.ps1','uninstall.bat')) {
  Copy-Item -LiteralPath (Join-Path $root $item) -Destination $package -Recurse
}
$archiveName = 'node-' + $NodeVersion + '-win-x64.zip'
$archive = Join-Path $work $archiveName
$baseUrl = 'https://nodejs.org/dist/' + $NodeVersion
Write-Host ('Downloading official Node.js ' + $NodeVersion)
if ($NodeArchivePath) {
  Copy-Item -LiteralPath $NodeArchivePath -Destination $archive
} else {
  Invoke-WebRequest -Uri ($baseUrl + '/' + $archiveName) -OutFile $archive -UseBasicParsing
}
$checksums = (Invoke-WebRequest -Uri ($baseUrl + '/SHASUMS256.txt') -UseBasicParsing).Content
$checksumLine = ($checksums -split "`n" | Where-Object { $_.Trim().EndsWith('  ' + $archiveName) } | Select-Object -First 1)
if (-not $checksumLine) { throw 'Official checksum was not found.' }
$expected = ($checksumLine.Trim() -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Node.js checksum mismatch. Distribution was not created.' }
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $work 'node')
$nodeRoot = Join-Path (Join-Path $work 'node') ('node-' + $NodeVersion + '-win-x64')
Copy-Item -LiteralPath (Join-Path $nodeRoot 'node.exe') -Destination $runtime
Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination $runtime
@{version=$NodeVersion;source=($baseUrl + '/' + $archiveName);archiveSha256=$actual} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'origin.json') -Encoding utf8
if (Test-Path -LiteralPath (Join-Path $package 'data')) { throw 'User data was unexpectedly included.' }
$output = Join-Path $dist 'Flash-Studio-DeepSeek-4.1-Windows-x64.zip'
if (Test-Path -LiteralPath $output) { throw 'A release ZIP already exists; refusing to overwrite it.' }
Compress-Archive -LiteralPath $package -DestinationPath $output -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
($hash + '  ' + [IO.Path]::GetFileName($output)) | Set-Content -LiteralPath (Join-Path $dist 'SHA256SUMS.txt') -Encoding ascii
Write-Host ('Release ZIP: ' + $output)
Write-Host ('SHA256: ' + $hash)
