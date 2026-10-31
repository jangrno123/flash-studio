# Read only operator-owned environment settings, never model/tool arguments.
$targetProject = $env:FLASH_H3_GCP_PROJECT
$targetZone = $env:FLASH_H3_GCP_ZONE
$targetVm = $env:FLASH_H3_GCP_VM
$targetAccount = $env:FLASH_H3_GCP_ACCOUNT
$siteUrl = $env:FLASH_H3_BAO_ORIGIN
if ($targetProject -cnotmatch '^[a-z][a-z0-9-]{4,61}[a-z0-9]$' -or
    $targetZone -cnotmatch '^[a-z]+-[a-z0-9]+[0-9]-[a-z]$' -or
    $targetVm -cnotmatch '^[a-z][a-z0-9-]{0,61}[a-z0-9]$' -or
    $targetAccount -notmatch '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$') { throw 'H3_NOT_CONFIGURED' }
$targetOrigin = $null
if (-not [Uri]::TryCreate($siteUrl, [UriKind]::Absolute, [ref]$targetOrigin) -or
    $targetOrigin.Scheme -ne 'https' -or $targetOrigin.UserInfo -or $targetOrigin.Query -or
    $targetOrigin.Fragment -or $targetOrigin.AbsolutePath -ne '/') { throw 'H3_NOT_CONFIGURED' }
$env:CLOUDSDK_CORE_ACCOUNT = $targetAccount
$env:CLOUDSDK_CORE_DISABLE_PROMPTS = '1'
