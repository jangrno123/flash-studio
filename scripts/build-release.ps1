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
foreach ($item in @('app','schemas','scripts','docs','integrations','README.md','CHANGELOG.md','package.json','Flash Studio.vbs','Flash Studio 24h.vbs','app.ico','install.bat','install.ps1','uninstall.bat')) {
  $source = Join-Path $root $item
  $files = if (Test-Path -LiteralPath $source -PathType Container) { Get-ChildItem -LiteralPath $source -File -Recurse } else { Get-Item -LiteralPath $source }
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($root.Length + 1)
    if ($relative -match '(^|[\\/])(__pycache__|node_modules|private|restore-[^\\/]+)([\\/]|$)' -or
        $file.Name -match '\.(pyc|log|tmp)$' -or
        $relative -match '^integrations[\\/]minimax-h3[\\/](profile\.json|runtime-snapshot-.*\.json)$') { continue }
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked files cannot be included in the release.' }
    $target = Join-Path $package $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target
  }
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
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($archive, (Join-Path $work 'node'))
$nodeRoot = Join-Path (Join-Path $work 'node') ('node-' + $NodeVersion + '-win-x64')
Copy-Item -LiteralPath (Join-Path $nodeRoot 'node.exe') -Destination $runtime
Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination $runtime
@{version=$NodeVersion;source=($baseUrl + '/' + $archiveName);archiveSha256=$actual} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'origin.json') -Encoding utf8
if (Test-Path -LiteralPath (Join-Path $package 'data')) { throw 'User data was unexpectedly included.' }
$output = Join-Path $dist 'Flash-Studio-DeepSeek-4.1-Windows-x64.zip'
if (Test-Path -LiteralPath $output) { throw 'A release ZIP already exists; refusing to overwrite it.' }
[IO.Compression.ZipFile]::CreateFromDirectory($package, $output, [IO.Compression.CompressionLevel]::Optimal, $true)
$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
($hash + '  ' + [IO.Path]::GetFileName($output)) | Set-Content -LiteralPath (Join-Path $dist 'SHA256SUMS.txt') -Encoding ascii
Write-Host ('Release ZIP: ' + $output)
Write-Host ('SHA256: ' + $hash)
