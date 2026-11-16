# Installs the Hyper View layout + mod into Herdr (Windows PowerShell 5.1).
# Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = 'Stop'
$src = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'hyper-view'
$dst = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config\herdr-app' }

Write-Host "Installing Hyper View into $dst"
foreach ($d in @('layouts', 'themes', 'mods')) { New-Item -ItemType Directory -Force -Path (Join-Path $dst $d) | Out-Null }

Copy-Item (Join-Path $src 'layouts\hyper-view.json') (Join-Path $dst 'layouts') -Force
Copy-Item (Join-Path $src 'themes\hyper-view-*.json') (Join-Path $dst 'themes') -Force
$modDst = Join-Path $dst 'mods\hyper-view'
if (Test-Path $modDst) { Remove-Item $modDst -Recurse -Force }
Copy-Item (Join-Path $src 'mods\hyper-view') (Join-Path $dst 'mods') -Recurse -Force

# Merge keyboard shortcuts into keys.json (keeps a backup).
$keysPath = Join-Path $dst 'keys.json'
$ours = Get-Content (Join-Path $src 'keys.json') -Raw | ConvertFrom-Json
if (Test-Path $keysPath) {
  Copy-Item $keysPath "$keysPath.bak" -Force
  $keys = Get-Content $keysPath -Raw | ConvertFrom-Json
} else {
  $keys = New-Object PSObject
}
if ($keys.PSObject.Properties['layout:hyper-view']) { $keys.PSObject.Properties.Remove('layout:hyper-view') }
$keys | Add-Member -NotePropertyName 'layout:hyper-view' -NotePropertyValue $ours.'layout:hyper-view'
if (-not $keys.PSObject.Properties['terminal']) { $keys | Add-Member -NotePropertyName 'terminal' -NotePropertyValue (New-Object PSObject) }
foreach ($p in $ours.terminal.PSObject.Properties) {
  if (-not $keys.terminal.PSObject.Properties[$p.Name]) { $keys.terminal | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value }
}
$json = $keys | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($keysPath, $json, (New-Object Text.UTF8Encoding $false))

Write-Host 'Done. Restart Herdr and choose the layout "hyper-view" (Settings -> Layout, or Ctrl+Shift+L).'
