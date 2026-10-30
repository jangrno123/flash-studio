param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Prefix = 'cut',
  [int]$MinGap = 16,
  [int]$Tol = 12,
  [string]$Mode = 'auto',
  [int]$MinSize = 80,
  [int]$Pad = 0,
  [int]$MaxPanels = 80,
  [switch]$Rtl,
  [switch]$KeepAll,
  [switch]$Loose,
  [switch]$KeepText,
  [switch]$PreserveBounds,
  [string]$CacheDir
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName PresentationCore, WindowsBase, System.Xaml

# C# 코드는 한 번만 컴파일해서 DLL 로 캐시한다
$cs = Join-Path $PSScriptRoot 'panel-cutter.cs'
if (-not $CacheDir) { $CacheDir = Join-Path $env:TEMP 'flash-studio' }
New-Item -ItemType Directory -Force $CacheDir | Out-Null
$stamp = (Get-Item $cs).LastWriteTimeUtc.Ticks
$dll = Join-Path $CacheDir "panel-cutter-$stamp.dll"
if (-not (Test-Path $dll)) {
  $refs = @(
    [System.Windows.Media.Imaging.BitmapDecoder].Assembly.Location,
    [System.Windows.Int32Rect].Assembly.Location,
    [System.Xaml.XamlReader].Assembly.Location
  )
  Add-Type -TypeDefinition (Get-Content -Raw -Encoding UTF8 $cs) -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library
}
Add-Type -Path $dll
[PanelCutter]::Run($InputPath, $OutDir, $Prefix, $MinGap, $Tol, $Mode, $MinSize, $Pad, [bool]$Rtl, $MaxPanels, [bool]$KeepAll, (-not $Loose), [bool]$KeepText, [bool]$PreserveBounds)
