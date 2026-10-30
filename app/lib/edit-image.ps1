param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OpsFile,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$Quality = 92,
  [string]$CacheDir
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName PresentationCore, WindowsBase, System.Xaml

$cs = Join-Path $PSScriptRoot 'image-ops.cs'
if (-not $CacheDir) { $CacheDir = Join-Path $env:TEMP 'flash-studio' }
New-Item -ItemType Directory -Force $CacheDir | Out-Null
$dll = Join-Path $CacheDir ("image-ops-{0}.dll" -f (Get-Item $cs).LastWriteTimeUtc.Ticks)
if (-not (Test-Path $dll)) {
  $refs = @([System.Windows.Media.Imaging.BitmapDecoder].Assembly.Location, [System.Windows.Int32Rect].Assembly.Location, [System.Xaml.XamlReader].Assembly.Location)
  Add-Type -TypeDefinition (Get-Content -Raw -Encoding UTF8 $cs) -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library
}
Add-Type -Path $dll

function ParseColor([string]$c) {
  switch -Regex ($c) {
    '^#?([0-9a-fA-F]{6})$' { $h = $Matches[1]; return @([Convert]::ToByte($h.Substring(0, 2), 16), [Convert]::ToByte($h.Substring(2, 2), 16), [Convert]::ToByte($h.Substring(4, 2), 16)) }
    '^white$' { return @(255, 255, 255) }
    '^gray$|^grey$' { return @(128, 128, 128) }
    default { return @(0, 0, 0) }
  }
}

$img = [ImageOps]::Load($InputPath)
$log = @()
$ops = Get-Content -Raw -Encoding UTF8 $OpsFile | ConvertFrom-Json
foreach ($o in $ops) {
  $W = $img.PixelWidth; $H = $img.PixelHeight
  switch ($o.op) {
    'crop' {
      if ($o.unit -eq 'px') { $x = [int]$o.x; $y = [int]$o.y; $w = [int]$o.width; $h = [int]$o.height }
      else { $x = [int]($W * $o.x / 100); $y = [int]($H * $o.y / 100); $w = [int]($W * $o.width / 100); $h = [int]($H * $o.height / 100) }
      $img = [ImageOps]::Crop($img, $x, $y, $w, $h)
    }
    'resize' {
      $tw = [int]$o.width; $th = [int]$o.height; $fit = if ($o.fit) { $o.fit } else { 'contain' }
      if ($tw -le 0 -and $th -le 0) { throw 'resize: width 또는 height 가 필요합니다' }
      if ($tw -le 0) { $tw = [int][math]::Round($W * $th / $H) }
      elseif ($th -le 0) { $th = [int][math]::Round($H * $tw / $W) }
      if ($fit -eq 'stretch') { $img = [ImageOps]::Resize($img, $tw, $th) }
      elseif ($fit -eq 'cover') {
        $s = [math]::Max($tw / $W, $th / $H); $img = [ImageOps]::Resize($img, [int][math]::Ceiling($W * $s), [int][math]::Ceiling($H * $s))
        $img = [ImageOps]::Crop($img, [int](($img.PixelWidth - $tw) / 2), [int](($img.PixelHeight - $th) / 2), $tw, $th)
      } else {
        $s = [math]::Min($tw / $W, $th / $H); $img = [ImageOps]::Resize($img, [int][math]::Round($W * $s), [int][math]::Round($H * $s))
      }
    }
    'rotate' { $img = [ImageOps]::Rotate($img, [int]$o.degrees) }
    'flip' { $img = [ImageOps]::Flip($img, ($o.direction -ne 'vertical')) }
    'pad' {
      $c = ParseColor ([string]$o.color)
      if ($o.ratio) {
        $p = ([string]$o.ratio) -split '[:x/]'; $rw = [double]$p[0]; $rh = [double]$p[1]
        if ($W / $H -lt $rw / $rh) { $tw = [int][math]::Round($H * $rw / $rh); $th = $H } else { $tw = $W; $th = [int][math]::Round($W * $rh / $rw) }
      } else { $tw = [int]$o.width; $th = [int]$o.height }
      $img = [ImageOps]::Pad($img, $tw, $th, $c[0], $c[1], $c[2])
    }
    'adjust' { $img = [ImageOps]::Adjust($img, [double]$o.brightness, [double]$o.contrast, [double]$o.saturation) }
    default { throw "알 수 없는 작업: $($o.op)" }
  }
  $log += "$($o.op) → $($img.PixelWidth)x$($img.PixelHeight)"
}
[ImageOps]::Save($img, $OutPath, $Quality)
@{ width = $img.PixelWidth; height = $img.PixelHeight; steps = $log } | ConvertTo-Json -Compress
