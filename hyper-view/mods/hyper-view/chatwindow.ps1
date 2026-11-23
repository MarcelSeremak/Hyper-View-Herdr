# Opens the Hyper View chat (conversations + task panel) as a second Herdr window, e.g. for a second monitor.
# A second Herdr runs with its own home (~/.config/herdr-app-chat): one layout with only the chat, the same
# hyper-view mod (a junction to this folder, so every change applies to both windows), the same themes.
# Data (~/.herdr: projects, messages, tasks) and the agents' terminals are shared with the main window.
$ErrorActionPreference = 'Stop'
$main = Join-Path $env:USERPROFILE '.config\herdr-app'
$home2 = Join-Path $env:USERPROFILE '.config\herdr-app-chat'

# The Herdr program: the one already running, else the usual install folders.
$exe = $null
$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -match 'herdr' -and $_.Path -notmatch 'core' -and $_.ProcessName -notmatch 'core' } | Select-Object -First 1
if ($p) { $exe = $p.Path }
if (-not $exe) {
  foreach ($dir in @("$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}", "$env:LOCALAPPDATA")) {
    if (-not $dir -or -not (Test-Path $dir)) { continue }
    $f = Get-ChildItem -Path $dir -Filter '*herdr*.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'core|uninstall|update' } | Select-Object -First 1
    if ($f) { $exe = $f.FullName; break }
  }
}
if (-not $exe) { Write-Output 'ERROR: Herdr program not found'; exit 1 }

# Home of the chat window.
foreach ($d in @($home2, "$home2\layouts", "$home2\themes", "$home2\mods")) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }
$mod = "$home2\mods\hyper-view"
if (-not (Test-Path $mod)) { New-Item -ItemType Junction -Path $mod -Target "$main\mods\hyper-view" | Out-Null }
Get-ChildItem "$main\themes" -Filter 'hyper-view-*.json' | ForEach-Object { Copy-Item $_.FullName "$home2\themes\$($_.Name)" -Force }
if (Test-Path "$main\settings.json") { Copy-Item "$main\settings.json" "$home2\settings.json" -Force }
$layout = @'
{
  "id": "root",
  "type": "column",
  "background": "canvas",
  "theme": { "light": "hyper-view-light", "dark": "hyper-view-dark" },
  "font": "JetBrains Mono",
  "font_size": 13,
  "ui_font": "JetBrains Mono",
  "padding": [8, 8],
  "children": [
    { "id": "mp-chat", "type": "block", "content": { "mod": "hyper-view", "props": { "role": "chat", "standalone": true } } }
  ]
}
'@
[IO.File]::WriteAllText("$home2\layouts\hyper-chat.json", $layout, (New-Object Text.UTF8Encoding($false)))
# Start in that layout (shared "layout"), without the welcome screen; keep what the window remembered.
$sharedPath = "$home2\shared.json"
$shared = @{}
if (Test-Path $sharedPath) { try { $shared = Get-Content $sharedPath -Raw | ConvertFrom-Json } catch { $shared = @{} } }
$obj = [ordered]@{}
if ($shared -is [System.Management.Automation.PSCustomObject]) { foreach ($pp in $shared.PSObject.Properties) { $obj[$pp.Name] = $pp.Value } }
$obj['layout'] = 'hyper-chat'
$obj['frame.welcomed'] = $true
[IO.File]::WriteAllText($sharedPath, ($obj | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))

$env:HERDR_APP_HOME = $home2
Start-Process -FilePath $exe -WorkingDirectory $env:USERPROFILE
Write-Output "OK: $exe"
