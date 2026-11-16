# activity.ps1 - incremental reader of Claude Code / Codex session logs for the hyper-view Activity timeline.
# Usage: activity.ps1 <request.json> <response.txt>   (Windows PowerShell 5.1 and PowerShell 7)
#
# The app (activity.js) has no file size / seek API, so this script does the cheap part: it lists the
# session logs of every project and returns only the bytes appended since the offsets the app sent.
# Request:  { cap, full, days, projects: [{slug, dir}], known: [{p, off, prov, slug}], seen: [path] }
# Response: plain text, one header line per item, then raw JSONL:
#   @@HVD {"slug","dir"}                      Claude transcript folder matched to a project
#   @@HVA {"p","prov","slug","off","next","size","mt","reset"}   followed by the new complete lines
#   @@HVC {"p","cwd"}                         a Codex rollout not seen before and its working folder
#   @@HVU {"dir"}                             a ~/.claude/projects folder of a herdr project that is not listed (diagnostics)
#   @@HVE {"more"}                            end; more = some files still have unread bytes
param([string]$Req, [string]$Resp)
$ErrorActionPreference = 'Stop'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$r = [IO.File]::ReadAllText($Req, $Utf8) | ConvertFrom-Json
$script:budget = [int64]$r.cap
$script:more = $false
$cap = [int64]$r.cap
$w = New-Object IO.StreamWriter($Resp, $false, $Utf8)

function Jstr([string]$s) { return '"' + $s.Replace('\', '\\').Replace('"', '\"') + '"' }
function Norm([string]$x) { return $x.Replace('/', '\').TrimEnd('\').ToLowerInvariant() }
function MsOf([datetime]$d) { return [int64]($d.ToUniversalTime() - (New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc))).TotalMilliseconds }
function Open-Read([string]$p) {
  return New-Object IO.FileStream($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
}

$known = @{}
foreach ($k in @($r.known)) { if ($k -and $k.p) { $known[[string]$k.p] = $k } }
$seen = @{}
foreach ($s in @($r.seen)) { if ($s) { $seen[[string]$s] = 1 } }
$done = @{}

# Reads from $off up to the last complete line (within the budget). Returns @(text, nextOffset).
function Read-Chunk([string]$path, [int64]$off, [int64]$size) {
  $fs = Open-Read $path
  try {
    $want = [int64][Math]::Min($size - $off, $script:budget)
    if ($want -le 0) { return @('', $off) }
    [void]$fs.Seek($off, [IO.SeekOrigin]::Begin)
    $buf = New-Object byte[] $want
    $n = 0
    while ($n -lt $want) { $k = $fs.Read($buf, $n, [int]($want - $n)); if ($k -le 0) { break }; $n += $k }
    if ($n -le 0) { return @('', $off) }
    $last = [Array]::LastIndexOf($buf, [byte]10, $n - 1, $n)
    if ($last -lt 0) {
      if ($off + $n -ge $size -or $want -lt $cap) { return @('', $off) }  # line still being written / budget used up
      # One line longer than the whole budget (a huge tool output): skip it.
      $pos = $off + $n
      $one = New-Object byte[] 65536
      while ($true) {
        $k = $fs.Read($one, 0, 65536)
        if ($k -le 0) { return @('', $off) }
        $i = [Array]::IndexOf($one, [byte]10, 0, $k)
        if ($i -ge 0) { return @('', ($pos + $i + 1)) }
        $pos += $k
      }
    }
    $script:budget -= ($last + 1)
    return @($Utf8.GetString($buf, 0, $last + 1), ($off + $last + 1))
  } finally { $fs.Close() }
}

function Process-File($fi, [string]$prov, [string]$slug) {
  $p = $fi.FullName
  if ($done.ContainsKey($p)) { return }
  $done[$p] = 1
  $size = [int64]$fi.Length
  $k = $known[$p]
  $off = [int64]0
  if ($k) { $off = [int64]$k.off }
  $reset = 0
  if ($size -lt $off) { $off = 0; $reset = 1 }
  if ($k -and $size -eq $off) { return }
  if ($script:budget -le 0) { $script:more = $true; return }
  $res = Read-Chunk $p $off $size
  $next = [int64]$res[1]
  if ($next -lt $size) { $script:more = $true }
  $w.Write('@@HVA {"p":' + (Jstr $p) + ',"prov":"' + $prov + '","slug":' + (Jstr $slug) + ',"off":' + $off + ',"next":' + $next + ',"size":' + $size + ',"mt":' + (MsOf $fi.LastWriteTimeUtc) + ',"reset":' + $reset + "}`n")
  if ($res[0]) { $w.Write([string]$res[0]) }
}

try {
  # ------------------------------------------------ Claude Code: ~/.claude/projects/<cwd with non-alphanumerics as '-'>
  $cands = @()
  foreach ($pr in @($r.projects)) {
    if (-not $pr -or -not $pr.dir) { continue }
    $full = [IO.Path]::GetFullPath([string]$pr.dir).TrimEnd('\')
    $cands += New-Object PSObject -Property @{ slug = [string]$pr.slug; esc = ($full -replace '[^a-zA-Z0-9]', '-').ToLowerInvariant() }
  }
  $croot = Join-Path $HOME '.claude\projects'
  if ($cands.Count -and (Test-Path -LiteralPath $croot)) {
    foreach ($d in (Get-ChildItem -LiteralPath $croot -Directory -ErrorAction SilentlyContinue)) {
      $n = $d.Name.ToLowerInvariant()
      $best = $null
      foreach ($c in $cands) {
        # Exact folder, or a subfolder of the project (worktrees): longest match wins.
        if (($n -eq $c.esc -or $n.StartsWith($c.esc + '-')) -and (-not $best -or $c.esc.Length -gt $best.esc.Length)) { $best = $c }
      }
      if (-not $best) {
        # Diagnostics: a herdr project folder that matches no current project (deleted / renamed project).
        if ($n -like '*-herdr-projects-*') { $w.Write('@@HVU {"dir":' + (Jstr $d.Name) + "}`n") }
        continue
      }
      $w.Write('@@HVD {"slug":' + (Jstr $best.slug) + ',"dir":' + (Jstr $d.FullName) + "}`n")
      foreach ($f in (Get-ChildItem -LiteralPath $d.FullName -Filter '*.jsonl' -File -Recurse -ErrorAction SilentlyContinue)) {
        try { Process-File $f 'claude' $best.slug } catch {}
      }
    }
  }

  # ------------------------------------------------ Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  $codexHome = $env:CODEX_HOME; if (-not $codexHome) { $codexHome = Join-Path $HOME '.codex' }
  $xroot = Join-Path $codexHome 'sessions'
  $list = @()
  if (Test-Path -LiteralPath $xroot) {
    if ($r.full) {
      $since = (Get-Date).AddDays(-[int]$r.days)
      $list = @(Get-ChildItem -LiteralPath $xroot -Recurse -Filter 'rollout-*.jsonl' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $since })
    } else {
      foreach ($i in -1, 0, 1) {
        $d = (Get-Date).AddDays($i)
        $dd = Join-Path $xroot ($d.ToString('yyyy') + '\' + $d.ToString('MM') + '\' + $d.ToString('dd'))
        if (Test-Path -LiteralPath $dd) { $list += @(Get-ChildItem -LiteralPath $dd -Filter 'rollout-*.jsonl' -File -ErrorAction SilentlyContinue) }
      }
    }
  }
  foreach ($k in $known.Values) {
    if ($k.prov -ne 'codex') { continue }
    try { $fi = New-Object IO.FileInfo([string]$k.p); if ($fi.Exists) { Process-File $fi 'codex' ([string]$k.slug) } } catch {}
  }
  foreach ($fi in $list) {
    $p = $fi.FullName
    if ($known.ContainsKey($p) -or $seen.ContainsKey($p)) { continue }
    $cwd = ''
    try {
      $sr = New-Object IO.StreamReader((Open-Read $p), $Utf8)
      try { $first = $sr.ReadLine() } finally { $sr.Close() }
      $m = [regex]::Match([string]$first, '"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"')
      if ($m.Success) { $cwd = [regex]::Unescape($m.Groups[1].Value) }
    } catch { continue }
    if (-not $first) { continue }  # still empty: look again next time
    $w.Write('@@HVC {"p":' + (Jstr $p) + ',"cwd":' + (Jstr $cwd) + "}`n")
  }
} finally {
  $w.Write('@@HVE {"more":' + $(if ($script:more) { 'true' } else { 'false' }) + "}`n")
  $w.Close()
}
