# hp - Herdr Projects: projects, virtual machines, secrets, events and agent tasks.
# Part of the "hyper-view" layout. Works in Windows PowerShell 5.1 and PowerShell 7.
#
# Data (~/.herdr):
#   machines.json             global machine list (projects only attach them)
#   secrets.json              secret metadata + permissions (values: Windows Credential Manager)
#   projects/<slug>/          project.json, agents.json, tasks.json, events.jsonl, AGENTS.md
# Credential Manager entries: herdr:vm:<machine>:ssh, herdr:vm:<machine>:sudo, herdr:secret:<name>

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$HpScript   = $MyInvocation.MyCommand.Path
$HpDir      = Split-Path -Parent $HpScript
$HerdrHome  = Join-Path $HOME '.herdr'
$ProjRoot   = Join-Path $HerdrHome 'projects'
$MachinesDb = Join-Path $HerdrHome 'machines.json'
$SecretsDb  = Join-Path $HerdrHome 'secrets.json'
$LocksDb    = Join-Path $HerdrHome 'locks.json'
$KeyFile    = Join-Path $HerdrHome 'keys\id_ed25519'
$HerdrKnown = Join-Path $HerdrHome 'known_hosts'
$BinDir     = Join-Path $HerdrHome 'bin'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------- arguments
# Values starting with "b64:" are decoded (that is how the Herdr panel sends them).
function Decode([string]$v) {
  if ($null -ne $v -and $v.StartsWith('b64:')) { return $Utf8.GetString([Convert]::FromBase64String($v.Substring(4))) }
  return $v
}
$Pos = New-Object System.Collections.ArrayList
$Opt = @{}
$Flags = @('global', 'json', 'force', 'overwrite', 'quiet', 'all', 'clear', 'dry', 'exclusive', 'ack', 'pool', 'check', 'tree', 'stdin')
# hp git <secret> ... / hp run --with <s> ...: after the first argument of the wrapped command (or "--"),
# everything goes to that command verbatim (so "git clone --depth 1" keeps its options).
$Raw = $false
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  if ($Raw) {
    # git has no --as/--task/--on/--approved/--ask/--p/--dry, so those still belong to hp even after the git
    # arguments (the Herdr panel sends its options after the positional ones).
    if ($Pos[0] -eq 'git' -and $a -eq '--dry') { $Opt['dry'] = $true; continue }
    if ($Pos[0] -eq 'git' -and $a -match '^--(as|task|on|approved|ask|p)$' -and $i + 1 -lt $args.Count) { $Opt[$Matches[1]] = Decode ([string]$args[$i + 1]); $i++; continue }
    [void]$Pos.Add((Decode $a)); continue
  }
  if ($a -eq '--') { $Raw = $true; continue }
  if ($Pos.Count -ge 1 -and (($Pos[0] -eq 'git' -and $Pos.Count -ge 2) -or ($Pos[0] -eq 'run' -and $Opt.ContainsKey('with'))) -and $a -notmatch '^--(as|on|task|p|with|secret|dry|approved|ask)$' -and $a -ne '-p') { $Raw = $true; [void]$Pos.Add((Decode $a)); continue }
  if ($a -eq '-p') { $a = '--p' }
  if ($a -match '^--([a-z0-9-]+)$') {
    $k = $Matches[1]
    if ($Flags -contains $k) { $Opt[$k] = $true }
    elseif ($i + 1 -lt $args.Count) { $Opt[$k] = Decode ([string]$args[$i + 1]); $i++ }
    else { $Opt[$k] = '' }
  } else { [void]$Pos.Add((Decode $a)) }
}
function O([string]$k, $def = $null) { if ($Opt.ContainsKey($k)) { return $Opt[$k] }; return $def }
function P([int]$n, [string]$what) {
  if ($Pos.Count -le $n) { Fail "Missing argument: $what" }
  return [string]$Pos[$n]
}
function Rest([int]$from) { return (@($Pos | Select-Object -Skip $from) -join ' ') }
function Fail([string]$msg) { [Console]::Error.WriteLine("hp: $msg"); exit 1 }
function List([string]$csv) {
  if (-not $csv) { return @() }
  return @($csv -split '[,; ]+' | Where-Object { $_ })
}

# ---------------------------------------------------------------- files
function Read-Text([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $t = [IO.File]::ReadAllText($path, $Utf8)
  if ($t.Length -gt 0 -and $t[0] -eq [char]0xFEFF) { $t = $t.Substring(1) }
  return $t
}
function Write-Text([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
  $tmp = "$path.tmp-$PID"
  [IO.File]::WriteAllText($tmp, $text, $Utf8)
  if (-not (Test-Path -LiteralPath $path)) { [IO.File]::Move($tmp, $path); return }
  # [NullString]::Value: PowerShell would turn $null into "" (an invalid backup path).
  # The Herdr UI may be reading the file at this moment: retry, then fall back to an in-place copy.
  for ($n = 0; $n -lt 20; $n++) {
    try { [IO.File]::Replace($tmp, $path, [NullString]::Value); return } catch { Start-Sleep -Milliseconds 50 }
  }
  try { [IO.File]::Copy($tmp, $path, $true) } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
function Read-Json([string]$path, $default) {
  $t = Read-Text $path
  if ([string]::IsNullOrWhiteSpace($t)) { return $default }
  return ($t | ConvertFrom-Json)
}
function Write-Json([string]$path, $obj) { Write-Text $path (ConvertTo-Json -InputObject $obj -Depth 12) }
function Arr($x) { if ($null -eq $x) { return @() }; return @($x) }
function Set-Prop($obj, [string]$name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value } else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}
function Has($list, $item) { return (@(Arr $list) -contains $item) }

# Simple cross-process lock (several agents write at once).
function With-Lock([string]$dir, [scriptblock]$body) {
  if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
  $lockPath = Join-Path $dir '.lock'
  $fs = $null
  for ($n = 0; $n -lt 200; $n++) {
    try { $fs = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None'); break }
    catch { Start-Sleep -Milliseconds 50 }
  }
  if ($null -eq $fs) { Fail "Cannot lock $lockPath" }
  try { & $body } finally { $fs.Close() }
}

function Now-Iso { return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
function New-Id { return ([guid]::NewGuid().ToString('N').Substring(0, 12)) }

function Slugify([string]$name) {
  $map = @{ 'ą' = 'a'; 'ć' = 'c'; 'ę' = 'e'; 'ł' = 'l'; 'ń' = 'n'; 'ó' = 'o'; 'ś' = 's'; 'ź' = 'z'; 'ż' = 'z' }
  $s = $name.ToLowerInvariant()
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $s.ToCharArray()) { $c = [string]$ch; if ($map.ContainsKey($c)) { [void]$sb.Append($map[$c]) } else { [void]$sb.Append($c) } }
  $s = ($sb.ToString() -replace '[^a-z0-9]+', '-').Trim('-')
  if ($s.Length -eq 0) { $s = 'x' }
  return $s
}

# ---------------------------------------------------------------- project
function Try-Find-Project {
  $p = O 'p'; if (-not $p) { $p = $env:HERDR_PROJECT }
  if ($p) { $dir = Join-Path $ProjRoot $p; if (Test-Path -LiteralPath (Join-Path $dir 'project.json')) { return $dir }; return $null }
  $d = (Get-Location).Path
  while ($d) {
    if (Test-Path -LiteralPath (Join-Path $d 'project.json')) { return $d }
    $parent = Split-Path -Parent $d
    if ($parent -eq $d) { break }
    $d = $parent
  }
  return $null
}
function Find-Project {
  $dir = Try-Find-Project
  if (-not $dir) {
    $p = O 'p'; if (-not $p) { $p = $env:HERDR_PROJECT }
    if ($p) { Fail "No such project '$p' (hp project list)" }
    Fail 'Cannot tell which project. Pass -p <project> or run inside a project folder.'
  }
  return $dir
}
function Load-Project([string]$dir) {
  $p = Read-Json (Join-Path $dir 'project.json') $null
  if ($p) { Set-Prop $p 'machines' @(Arr $p.machines) }
  return $p
}
function Save-Project([string]$dir, $p) { Write-Json (Join-Path $dir 'project.json') $p }
function Slug-Of([string]$dir) { return (Split-Path -Leaf $dir) }
function All-Projects {
  if (-not (Test-Path -LiteralPath $ProjRoot)) { return @() }
  return @(Get-ChildItem -LiteralPath $ProjRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'project.json') })
}

# ---------------------------------------------------------------- machines (global)
function Machines-Load { return @(Arr (Read-Json $MachinesDb @())) }
function Machines-Save($list) { Write-Json $MachinesDb @($list) }
function Find-Machine([string]$name) {
  foreach ($m in (Machines-Load)) { if ($m.name -eq $name) { return $m } }
  Fail "No such machine '$name' (hp vm list)"
}
function Ssh-Alias([string]$machine) { return "herdr-$machine" }

# ---------------------------------------------------------------- machine locks (global, shared by all projects)
function Locks-Load {
  $now = (Get-Date).ToUniversalTime()
  return @(Arr (Read-Json $LocksDb @()) | Where-Object { $_.vm -and $_.expires -and (([datetime]$_.expires).ToUniversalTime() -gt $now) })
}
function Locks-Save($list) { Write-Json $LocksDb @($list) }
function Lock-Of([string]$vm) { foreach ($l in (Locks-Load)) { if ($l.vm -eq $vm) { return $l } }; return $null }
function Lock-Mine($l, [string]$me, [string]$slug) { return ($l.owner -eq $me -and ([string]$l.project) -eq $slug) }
function Lock-Text($l) { return "$($l.vm) is locked by $($l.owner)$(if ($l.project) { ' (' + $l.project + ')' }) until $(([datetime]$l.expires).ToLocalTime().ToString('HH:mm')): $($l.reason)" }

# ---------------------------------------------------------------- agents
function Agents-Path([string]$dir) { return (Join-Path $dir 'agents.json') }
function Agents-Load([string]$dir) {
  $list = @(Arr (Read-Json (Agents-Path $dir) @()))
  foreach ($a in $list) { Set-Prop $a 'machines' @(Arr $a.machines); Set-Prop $a 'sudo' @(Arr $a.sudo) }
  return $list
}
function Find-Agent([string]$dir, [string]$name) { foreach ($a in (Agents-Load $dir)) { if ($a.name -eq $name) { return $a } }; return $null }
function Me { $me = O 'as'; if (-not $me) { $me = $env:HERDR_AGENT }; if (-not $me) { Fail 'Give your name: --as <name>' }; return $me }

# ---------------------------------------------------------------- permissions
# Machine: the human (no --as, or --as ty) can do anything. Agent: the machine must belong to the project
# and, if the agent has a machine list, also be on that list.
function Check-MachineAccess([string]$machine) {
  $me = O 'as'; if (-not $me) { $me = $env:HERDR_AGENT }
  if (-not $me -or $me -eq 'ty') { return }
  $dir = Try-Find-Project
  if (-not $dir) { Fail "Agent '$me' has no machine access outside a project." }
  $p = Load-Project $dir
  if (-not (Has $p.machines $machine)) { Fail "Machine '$machine' is not part of project $($p.name). Available: $((Arr $p.machines) -join ', ')" }
  $a = Find-Agent $dir $me
  if ($a -and @($a.machines).Count -gt 0 -and -not (Has $a.machines $machine)) { Fail "Agent '$me' has no access to '$machine'. Has: $(@($a.machines) -join ', ')" }
}
# Secret: empty project/agent list = everyone.
function Check-SecretAccess($meta) {
  $me = O 'as'; if (-not $me) { $me = $env:HERDR_AGENT }
  if (-not $me -or $me -eq 'ty') { return }
  $dir = Try-Find-Project
  $slug = if ($dir) { Slug-Of $dir } else { '' }
  # Secrets are shared per project: an agent may use a secret only if its project was granted it.
  if (-not (Has $meta.projects $slug)) { Fail "Secret '$($meta.name)' is not shared with this project. Ask the human to share it." }
  if (@(Arr $meta.agents).Count -gt 0 -and -not (Has $meta.agents $me)) { Fail "Agent '$me' has no access to secret '$($meta.name)'." }
}

# ---------------------------------------------------------------- Credential Manager
$CredLoaded = $false
function Load-Cred {
  if ($script:CredLoaded) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class HpCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string target, string user, string secret, string comment) {
    byte[] b = Encoding.Unicode.GetBytes(secret ?? "");
    if (b.Length > 2560) throw new Exception("Secret too long (max 1280 characters).");
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user ?? ""; c.Comment = comment; c.Persist = 2;
    c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(Math.Max(b.Length, 1));
    Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
    try { if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static string[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      string s = c.CredentialBlobSize > 0 ? Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2) : "";
      return new string[] { c.UserName ?? "", s };
    } finally { CredFree(p); }
  }
  public static bool Delete(string target) { return CredDelete(target, 1, 0); }
}
'@
  $script:CredLoaded = $true
}
function Cred-Set([string]$target, [string]$user, [string]$value) { Load-Cred; [HpCred]::Write("herdr:$target", $user, $value, 'Herdr (hp)') }
function Cred-Get([string]$target) { Load-Cred; return [HpCred]::Read("herdr:$target") }
function Cred-Del([string]$target) { Load-Cred; return [HpCred]::Delete("herdr:$target") }

function Read-Value([string]$label) {
  $v = O 'value'
  if ($null -ne $v) { return $v }
  if ([Console]::IsInputRedirected) { return ([Console]::In.ReadToEnd()).TrimEnd("`r", "`n") }
  $sec = Read-Host -AsSecureString $label
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

# ---------------------------------------------------------------- secrets (global)
function Secrets-Load { return @(Arr (Read-Json $SecretsDb @())) }
function Secrets-Save($list) { Write-Json $SecretsDb @($list) }
function Find-Secret([string]$name) {
  foreach ($s in (Secrets-Load)) { if ($s.name -eq $name) { return $s } }
  Fail "No such secret '$name' (hp secret list)"
}
function Secret-Value($meta) {
  Check-SecretAccess $meta
  $r = Secret-Read $meta.name
  if ($null -eq $r) { Fail "Secret '$($meta.name)' has no value in Credential Manager." }
  $left = Days-Left $meta
  if ($null -ne $left -and $left -lt 0) { [Console]::Error.WriteLine("hp: warning: secret '$($meta.name)' expired on $(Exp-Str $meta.expires); ask the human for a new one.") }
  elseif ($null -ne $left -and $left -lt 14) { [Console]::Error.WriteLine("hp: warning: secret '$($meta.name)' expires in $left day(s).") }
  Log-Use $meta.name
  return $r
}
# Who used a secret and when (no value) - shown in Tokens & Access.
function Log-Use([string]$name) {
  try {
    $me = O 'as'; if (-not $me) { $me = 'ty' }
    $dir = Try-Find-Project
    $line = (ConvertTo-Json -Compress -InputObject ([ordered]@{ ts = (Now-Iso); secret = $name; by = $me; project = $(if ($dir) { Slug-Of $dir } else { '' }); cmd = [string]$Pos[0] })) + "`n"
    [IO.File]::AppendAllText((Join-Path $HerdrHome 'secret-uses.jsonl'), $line, $Utf8)
  } catch {}
}

# ---------------------------------------------------------------- secret types (mirror of secretkinds.js)
# meta.provider / meta.type; secrets saved before the wizard only have meta.kind.
function Secret-Type($meta) {
  $p = [string]$meta.provider; $t = [string]$meta.type
  if ($p -and $t) { return @($p, $t) }
  switch ([string]$meta.kind) {
    'gitlab' { return @('gitlab', 'pat') }
    'gitlab-deploy' { return @('gitlab', 'deploy') }
    'github' { return @('github', 'classic') }
    'password' { return @('login', 'password') }
  }
  return @('token', 'generic')
}
$TypeLabels = @{
  'gitlab/pat' = 'GitLab personal access token'; 'gitlab/project' = 'GitLab project access token'; 'gitlab/group' = 'GitLab group access token'
  'gitlab/deploy' = 'GitLab deploy token'; 'gitlab/deploykey' = 'GitLab deploy key (SSH)'; 'gitlab/trigger' = 'GitLab pipeline trigger token'; 'gitlab/runner' = 'GitLab runner token'
  'github/fine' = 'GitHub fine-grained token'; 'github/classic' = 'GitHub classic token'; 'github/app' = 'GitHub App'; 'github/deploykey' = 'GitHub deploy key (SSH)'
  'bitbucket/api' = 'Bitbucket API token'; 'bitbucket/repo' = 'Bitbucket repository access token'; 'bitbucket/project' = 'Bitbucket project access token'
  'bitbucket/workspace' = 'Bitbucket workspace access token'; 'bitbucket/dc' = 'Bitbucket Data Center HTTP token'; 'bitbucket/accesskey' = 'Bitbucket access key (SSH)'; 'bitbucket/apppw' = 'Bitbucket app password (retired)'
  'azdo/pat' = 'Azure DevOps token'; 'gitother/token' = 'Git server token'
  'docker/pat' = 'Docker Hub token'; 'docker/org' = 'Docker Hub organization token'; 'registry/ghcr' = 'GitHub container registry'; 'registry/gitlab' = 'GitLab container registry'; 'registry/other' = 'Container registry login'
  'npm/token' = 'npm token'; 'pypi/token' = 'PyPI token'; 'aws/key' = 'AWS access key'; 'azure/sp' = 'Azure service principal'; 'gcp/sa' = 'Google Cloud service account key'
  'k8s/kubeconfig' = 'Kubeconfig'; 'ssh/key' = 'SSH private key'; 'db/conn' = 'Database login'; 'login/password' = 'Login & password'
  'apikey/key' = 'API key'; 'webhook/secret' = 'Webhook secret'; 'env/bundle' = '.env bundle'; 'token/generic' = 'Token'
}
function Type-Label($meta) { $pt = Secret-Type $meta; $l = $TypeLabels["$($pt[0])/$($pt[1])"]; if ($l) { return $l }; return "$($pt[0])/$($pt[1])" }
function SF($meta, [string]$key) { if ($meta.fields -and $meta.fields.PSObject.Properties[$key]) { return [string]$meta.fields.$key }; return '' }
function Exp-Str($v) { if ($null -eq $v -or $v -eq '') { return '' }; if ($v -is [datetime]) { return $v.ToString('yyyy-MM-dd') }; $s = [string]$v; if ($s.Length -ge 10) { return $s.Substring(0, 10) }; return $s }
function Days-Left($meta) {
  $e = Exp-Str $meta.expires; if (-not $e) { return $null }
  try { return [int]([datetime]::ParseExact($e, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) - (Get-Date).Date).TotalDays } catch { return $null }
}
$DefaultHost = @{ gitlab = 'gitlab.com'; github = 'github.com'; bitbucket = 'bitbucket.org'; azdo = 'dev.azure.com'; npm = 'registry.npmjs.org'; pypi = 'upload.pypi.org' }
# Host name only (no scheme or path).
function Secret-Host($meta) {
  $h = [string]$meta.host; if (-not $h) { $h = [string]$meta.url }
  $h = ($h -replace '^https?://', '') -replace '/.*$', ''
  if (-not $h) { $pt = Secret-Type $meta; $h = [string]$DefaultHost[$pt[0]] }
  return $h
}
function B64([string]$s) { return [Convert]::ToBase64String($Utf8.GetBytes($s)) }

# ---------------------------------------------------------------- secret values (Credential Manager)
# One entry holds at most 1280 characters, so longer values (keys, kubeconfig, JSON) are split:
# herdr:secret:<name> = "hp-chunks:N" and herdr:secret:<name>:1..N hold the parts.
$ChunkSize = 1200
function Secret-DropChunks([string]$name) { for ($k = 1; $k -le 64; $k++) { if (-not (Cred-Del "secret:${name}:$k")) { break } } }
function Secret-Write([string]$name, [string]$user, [string]$value) {
  Secret-DropChunks $name
  if ($value.Length -le $ChunkSize) { Cred-Set "secret:$name" $user $value; return }
  $n = [int][Math]::Ceiling($value.Length / $ChunkSize)
  for ($k = 1; $k -le $n; $k++) { $at = ($k - 1) * $ChunkSize; Cred-Set "secret:${name}:$k" '' $value.Substring($at, [Math]::Min($ChunkSize, $value.Length - $at)) }
  Cred-Set "secret:$name" $user "hp-chunks:$n"
}
function Secret-Read([string]$name) {
  $r = Cred-Get "secret:$name"
  if ($null -eq $r) { return $null }
  if ($r[1] -match '^hp-chunks:(\d+)$') {
    $n = [int]$Matches[1]; $sb = New-Object System.Text.StringBuilder
    for ($k = 1; $k -le $n; $k++) { $c = Cred-Get "secret:${name}:$k"; if ($null -eq $c) { Fail "Secret '$name' is incomplete in Credential Manager (part $k missing)." }; [void]$sb.Append($c[1]) }
    return @($r[0], $sb.ToString())
  }
  return @($r[0], $r[1])
}

# ---------------------------------------------------------------- GitHub App: JWT (RS256) -> installation token
function Der-Len([byte[]]$b, [ref]$i) {
  $l = [int]$b[$i.Value]; $i.Value++
  if ($l -lt 0x80) { return $l }
  $n = $l -band 0x7f; $l = 0
  for ($k = 0; $k -lt $n; $k++) { $l = ($l -shl 8) -bor [int]$b[$i.Value]; $i.Value++ }
  return $l
}
function Der-Int([byte[]]$b, [ref]$i) {
  if ($b[$i.Value] -ne 2) { Fail 'Private key: unexpected format (need an RSA PEM key).' }
  $i.Value++; $l = Der-Len $b $i; $s = $i.Value; $i.Value += $l
  while ($l -gt 1 -and $b[$s] -eq 0) { $s++; $l-- }
  $r = New-Object byte[] $l; [Array]::Copy($b, $s, $r, 0, $l)
  return , $r
}
function Pad-Bytes([byte[]]$x, [int]$n) { if ($x.Length -ge $n) { return , $x }; $r = New-Object byte[] $n; [Array]::Copy($x, 0, $r, $n - $x.Length, $x.Length); return , $r }
function Der-Seq([byte[]]$b, [ref]$i) { if ($b[$i.Value] -ne 0x30) { Fail 'Private key: unexpected format (need an RSA PEM key).' }; $i.Value++; return (Der-Len $b $i) }
# PKCS#1 (BEGIN RSA PRIVATE KEY, what GitHub hands out) or PKCS#8 (BEGIN PRIVATE KEY).
function Rsa-FromPem([string]$pem) {
  $pkcs8 = $pem -match 'BEGIN PRIVATE KEY'
  [byte[]]$b = [Convert]::FromBase64String((($pem -replace '-----[^-]+-----', '') -replace '\s', ''))
  $i = 0
  [void](Der-Seq $b ([ref]$i))
  if ($pkcs8) {
    [void](Der-Int $b ([ref]$i))
    $l = Der-Seq $b ([ref]$i); $i += $l
    if ($b[$i] -ne 4) { Fail 'Private key: unexpected PKCS#8 layout.' }; $i++; [void](Der-Len $b ([ref]$i))
    [void](Der-Seq $b ([ref]$i))
  }
  [void](Der-Int $b ([ref]$i))
  $n = Der-Int $b ([ref]$i); $e = Der-Int $b ([ref]$i); $d = Der-Int $b ([ref]$i)
  $p = Der-Int $b ([ref]$i); $q = Der-Int $b ([ref]$i); $dp = Der-Int $b ([ref]$i); $dq = Der-Int $b ([ref]$i); $iq = Der-Int $b ([ref]$i)
  $h = [int][Math]::Ceiling($n.Length / 2)
  $prm = New-Object Security.Cryptography.RSAParameters
  $prm.Modulus = $n; $prm.Exponent = $e; $prm.D = (Pad-Bytes $d $n.Length)
  $prm.P = (Pad-Bytes $p $h); $prm.Q = (Pad-Bytes $q $h); $prm.DP = (Pad-Bytes $dp $h); $prm.DQ = (Pad-Bytes $dq $h); $prm.InverseQ = (Pad-Bytes $iq $h)
  $rsa = [Security.Cryptography.RSA]::Create(); $rsa.ImportParameters($prm)
  return $rsa
}
function B64Url([byte[]]$b) { return [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function Gh-Api-Root([string]$h) { if ($h -eq 'github.com') { return 'https://api.github.com' }; return "https://$h/api/v3" }
function Gh-App-Jwt($meta, [string]$pem) {
  $app = SF $meta 'appId'
  if (-not $app) { Fail "GitHub App secret '$($meta.name)' has no App ID (edit it in Tokens & Access)." }
  $now = [long][Math]::Floor(((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds)
  $hdr = B64Url ($Utf8.GetBytes('{"alg":"RS256","typ":"JWT"}'))
  $iss = if ($app -match '^\d+$') { $app } else { '"' + $app + '"' }
  $pl = B64Url ($Utf8.GetBytes("{`"iat`":$($now - 60),`"exp`":$($now + 540),`"iss`":$iss}"))
  $rsa = Rsa-FromPem $pem
  $sig = $rsa.SignData($Utf8.GetBytes("$hdr.$pl"), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
  return "$hdr.$pl.$(B64Url $sig)"
}
# Installation tokens live 1 hour; hp mints a fresh one per command (never stored).
function Gh-App-Token($meta, [string]$pem) {
  $inst = SF $meta 'installationId'
  if (-not $inst) { Fail "GitHub App secret '$($meta.name)' has no Installation ID (edit it in Tokens & Access)." }
  $jwt = Gh-App-Jwt $meta $pem
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
  try {
    $res = Invoke-RestMethod -Method POST -Uri "$(Gh-Api-Root (Secret-Host $meta))/app/installations/$inst/access_tokens" -UseBasicParsing `
      -Headers @{ Authorization = "Bearer $jwt"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
  } catch {
    $msg = ''; try { $msg = ([string]$_.ErrorDetails.Message | ConvertFrom-Json).message } catch {}
    Fail "GitHub App token request failed: $(if ($msg) { $msg } else { $_.Exception.Message })"
  }
  return [string]$res.token
}

# ---------------------------------------------------------------- how each type authenticates
# git: value for http.extraHeader; api: request headers; ssh: the value is a private key.
# GitLab: https://docs.gitlab.com/user/profile/personal_access_tokens/ (any user + token; PRIVATE-TOKEN), deploy tokens need their username.
# GitHub: Bearer + x-access-token. Bitbucket: https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/ and using-access-tokens/.
function Secret-Auth($meta, $r) {
  $pt = Secret-Type $meta; $prov = $pt[0]; $type = $pt[1]
  $user = [string]$r[0]; if (-not $user) { $user = [string]$meta.user }
  $tok = [string]$r[1]
  $a = @{ git = $null; api = @{}; ssh = $false; why = ''; only = '' }
  $basic = { param($u, $p) "Basic $(B64 "${u}:$p")" }
  switch ($prov) {
    'gitlab' {
      if ($type -eq 'deploy') { $a.git = "Authorization: $(& $basic $user $tok)"; $a.api = @{ 'Deploy-Token' = $tok }; $a.only = 'packages' }
      elseif ($type -eq 'deploykey') { $a.ssh = $true }
      elseif ($type -eq 'trigger') { $a.why = 'A pipeline trigger token is only the "token" field of POST /projects/:id/trigger/pipeline. Use: hp run --with <secret> -- curl ... -F token=$env:GITLAB_TRIGGER_TOKEN' }
      elseif ($type -eq 'runner') { $a.why = 'A runner token is for gitlab-runner (hp run sets CI_SERVER_URL / CI_SERVER_TOKEN).' }
      else { $a.git = "Authorization: $(& $basic 'oauth2' $tok)"; $a.api = @{ 'PRIVATE-TOKEN' = $tok } }
    }
    'github' {
      if ($type -eq 'deploykey') { $a.ssh = $true } else {
        if ($type -eq 'app') { $tok = Gh-App-Token $meta $tok }
        $a.git = "Authorization: $(& $basic 'x-access-token' $tok)"
        $a.api = @{ Authorization = "Bearer $tok"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
      }
    }
    'bitbucket' {
      if ($type -eq 'accesskey') { $a.ssh = $true }
      elseif ($type -eq 'apppw') { $a.git = "Authorization: $(& $basic $user $tok)"; $a.api = @{ Authorization = (& $basic $user $tok) } }
      elseif ($type -eq 'api') { $a.git = "Authorization: $(& $basic 'x-bitbucket-api-token-auth' $tok)"; $a.api = @{ Authorization = "Bearer $tok" } }
      elseif ($type -eq 'dc') { $a.git = "Authorization: Bearer $tok"; $a.api = @{ Authorization = "Bearer $tok" } }
      else { $a.git = "Authorization: $(& $basic 'x-token-auth' $tok)"; $a.api = @{ Authorization = "Bearer $tok" } }
    }
    'azdo' { $a.git = "Authorization: $(& $basic 'pat' $tok)"; $a.api = @{ Authorization = (& $basic '' $tok) } }
    'gitother' { $u = if ($user) { $user } else { 'git' }; $a.git = "Authorization: $(& $basic $u $tok)"; $a.api = @{ Authorization = "token $tok" } }
    'ssh' { $a.ssh = $true }
    'login' { $a.git = "Authorization: $(& $basic $user $tok)"; $a.api = @{ Authorization = (& $basic $user $tok) } }
    'apikey' {
      $h = SF $meta 'header'
      if ($h -eq 'x-api-key') { $a.api = @{ 'X-API-Key' = $tok } }
      elseif ($h -eq 'custom' -and (SF $meta 'headerName')) { $a.api = @{ (SF $meta 'headerName') = $tok } }
      else { $a.api = @{ Authorization = "Bearer $tok" } }
    }
    'token' { $a.api = @{ Authorization = "Bearer $tok" } }
    default { $a.why = "A $(Type-Label $meta) is used through hp run, not hp git / hp api." }
  }
  return $a
}

# ---------------------------------------------------------------- hp run: secrets as environment variables
function Env-Name([string]$s) { return (($s -replace '[^A-Za-z0-9]+', '_').Trim('_')).ToUpperInvariant() }
function Key-Text([string]$v) { return (($v -replace "`r`n", "`n").TrimEnd() + "`n") }
function Ssh-Cmd([string]$key) { return "ssh -i `"$($key -replace '\\', '/')`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" }
function Url-Enc([string]$s) { return [uri]::EscapeDataString($s) }
$DockerAuths = @{}
# Fills $envs (name -> value) and $mask (strings hidden in output). $tmp = $null: names only (hp secret vars).
function Run-Env($meta, $r, $tmp, $envs, $mask) {
  $pt = Secret-Type $meta; $prov = $pt[0]; $type = $pt[1]
  $user = [string]$r[0]; if (-not $user) { $user = [string]$meta.user }
  $val = [string]$r[1]; $h = Secret-Host $meta
  [void]$mask.Add($val); foreach ($ln in ($val -split "`n")) { if ($ln.Trim().Length -ge 16) { [void]$mask.Add($ln.Trim()) } }
  $file = {
    param($n, $text)
    if (-not $tmp) { return "<temp>/$n" }
    $f = Join-Path $tmp $n; [IO.File]::WriteAllText($f, $text, $Utf8); Ssh-Protect $f; return $f
  }
  $sshKey = { $k = & $file 'id_key' (Key-Text $val); $envs['GIT_SSH_COMMAND'] = Ssh-Cmd $k; $envs['HP_SSH_KEY'] = $k }
  $named = { param($def) $n = SF $meta 'env'; if (-not $n) { $n = $def }; $envs[(Env-Name $n)] = $val }
  switch ($prov) {
    'gitlab' {
      if ($type -eq 'trigger') { $envs['GITLAB_TRIGGER_TOKEN'] = $val; $envs['GITLAB_URL'] = "https://$h" }
      elseif ($type -eq 'runner') { $envs['CI_SERVER_URL'] = "https://$h"; $envs['CI_SERVER_TOKEN'] = $val }
      elseif ($type -eq 'deploykey') { & $sshKey }
      elseif ($type -eq 'deploy') { $envs['CI_DEPLOY_USER'] = $user; $envs['CI_DEPLOY_PASSWORD'] = $val }
      else { $envs['GITLAB_TOKEN'] = $val; $envs['GITLAB_HOST'] = $h }
    }
    'github' {
      if ($type -eq 'deploykey') { & $sshKey } else {
        $tok = if ($type -eq 'app') { if ($tmp) { Gh-App-Token $meta $val } else { '' } } else { $val }
        if ($tok) { [void]$mask.Add($tok) }
        $envs['GH_TOKEN'] = $tok; $envs['GITHUB_TOKEN'] = $tok
        if ($h -ne 'github.com') { $envs['GH_HOST'] = $h; $envs['GH_ENTERPRISE_TOKEN'] = $tok }
      }
    }
    'bitbucket' { if ($type -eq 'accesskey') { & $sshKey } else { $envs['BITBUCKET_TOKEN'] = $val; if ($user) { $envs['BITBUCKET_USERNAME'] = $user } } }
    'azdo' { $envs['AZURE_DEVOPS_EXT_PAT'] = $val }
    'gitother' { $envs['GIT_TOKEN'] = $val; if ($user) { $envs['GIT_USER'] = $user } }
    { $_ -eq 'docker' -or $_ -eq 'registry' } {
      # A private docker config just for this command (no credsStore; removed afterwards). Several registries merge.
      $reg = if ($prov -eq 'docker') { 'https://index.docker.io/v1/' } else { $h }
      $auth = B64 "${user}:$val"; [void]$mask.Add($auth)
      $script:DockerAuths[$reg] = @{ auth = $auth }
      $cfg = & $file 'config.json' (ConvertTo-Json -Depth 5 -InputObject @{ auths = $script:DockerAuths })
      $envs['DOCKER_CONFIG'] = $(if ($tmp) { $tmp } else { '<temp>' }); $envs['REGISTRY_AUTH_FILE'] = $cfg
      $envs['REGISTRY_USER'] = $user; $envs['REGISTRY_PASSWORD'] = $val
    }
    'npm' {
      # npm expands ${NPM_TOKEN} itself, so the token is not written to the temp .npmrc.
      $envs['NPM_TOKEN'] = $val; $envs['NODE_AUTH_TOKEN'] = $val
      $envs['NPM_CONFIG_USERCONFIG'] = & $file 'npmrc' "//${h}/:_authToken=`${NPM_TOKEN}`nregistry=https://$h/`n"
    }
    'pypi' {
      $envs['TWINE_USERNAME'] = '__token__'; $envs['TWINE_PASSWORD'] = $val; $envs['UV_PUBLISH_TOKEN'] = $val; $envs['POETRY_PYPI_TOKEN_PYPI'] = $val
      if ($h -and $h -ne 'upload.pypi.org') { $envs['TWINE_REPOSITORY_URL'] = "https://$h/legacy/" }
    }
    'aws' {
      $envs['AWS_ACCESS_KEY_ID'] = $user; $envs['AWS_SECRET_ACCESS_KEY'] = $val
      $rg = SF $meta 'region'; if ($rg) { $envs['AWS_REGION'] = $rg; $envs['AWS_DEFAULT_REGION'] = $rg }
    }
    'azure' {
      $tn = SF $meta 'tenant'; $sub = SF $meta 'subscription'
      foreach ($pre in @('AZURE', 'ARM')) {
        $envs["${pre}_TENANT_ID"] = $tn; $envs["${pre}_CLIENT_ID"] = $user; $envs["${pre}_CLIENT_SECRET"] = $val
        if ($sub) { $envs["${pre}_SUBSCRIPTION_ID"] = $sub }
      }
    }
    'gcp' {
      $f = & $file 'gcp-key.json' $val
      $envs['GOOGLE_APPLICATION_CREDENTIALS'] = $f; $envs['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'] = $f
      $pj = SF $meta 'project'; if ($pj) { $envs['GOOGLE_CLOUD_PROJECT'] = $pj; $envs['CLOUDSDK_CORE_PROJECT'] = $pj }
    }
    'k8s' {
      $envs['KUBECONFIG'] = & $file 'kubeconfig' (Key-Text $val)
      $c = SF $meta 'context'; if ($c) { $envs['HP_KUBE_CONTEXT'] = $c }
      $ns = SF $meta 'namespace'; if ($ns) { $envs['HP_KUBE_NAMESPACE'] = $ns }
    }
    'ssh' { & $sshKey; $hh = [string]$meta.host; if ($hh) { $envs['HP_SSH_TARGET'] = $(if ($user) { "$user@$hh" } else { $hh }) } }
    'db' {
      $eng = SF $meta 'engine'; if (-not $eng) { $eng = 'postgres' }
      $dh = [string]$meta.host; $port = SF $meta 'port'; $db = SF $meta 'database'
      if (-not $port) { $port = @{ postgres = '5432'; mysql = '3306'; mssql = '1433'; mongodb = '27017'; redis = '6379' }[$eng] }
      $scheme = @{ postgres = 'postgresql'; mysql = 'mysql'; mssql = 'sqlserver'; mongodb = 'mongodb'; redis = 'redis' }[$eng]
      $cred = if ($user) { "$(Url-Enc $user):$(Url-Enc $val)@" } else { ":$(Url-Enc $val)@" }
      $envs['DATABASE_URL'] = "${scheme}://$cred${dh}:$port$(if ($db) { '/' + $db })"; [void]$mask.Add((Url-Enc $val))
      $envs['DB_HOST'] = $dh; $envs['DB_PORT'] = $port; $envs['DB_USER'] = $user; $envs['DB_PASSWORD'] = $val; if ($db) { $envs['DB_NAME'] = $db }
      switch ($eng) {
        'postgres' { $envs['PGHOST'] = $dh; $envs['PGPORT'] = $port; $envs['PGUSER'] = $user; $envs['PGPASSWORD'] = $val; if ($db) { $envs['PGDATABASE'] = $db } }
        'mysql' { $envs['MYSQL_HOST'] = $dh; $envs['MYSQL_TCP_PORT'] = $port; $envs['MYSQL_PWD'] = $val }
        'mssql' { $envs['SQLCMDSERVER'] = "$dh,$port"; $envs['SQLCMDUSER'] = $user; $envs['SQLCMDPASSWORD'] = $val; if ($db) { $envs['SQLCMDDBNAME'] = $db } }
        'redis' { $envs['REDISCLI_AUTH'] = $val }
      }
    }
    'login' {
      $pre = SF $meta 'env'; if (-not $pre) { $pre = $meta.name }; $pre = Env-Name $pre
      $envs["${pre}_USER"] = $user; $envs["${pre}_PASSWORD"] = $val
      if ($meta.host -or $meta.url) { $envs["${pre}_URL"] = $(if ($meta.host) { [string]$meta.host } else { [string]$meta.url }) }
    }
    'apikey' { & $named $meta.name; $n = SF $meta 'env'; if (-not $n) { $n = $meta.name }; if ($meta.host) { $envs["$(Env-Name $n)_BASE_URL"] = [string]$meta.host } }
    'webhook' { & $named 'WEBHOOK_SECRET' }
    'env' {
      foreach ($ln in ($val -split "`n")) {
        $l = $ln.Trim(); if (-not $l -or $l.StartsWith('#')) { continue }
        if ($l -match '^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
          $key = $Matches[2]; $v = $Matches[3]; if ($v -match '^"(.*)"$' -or $v -match "^'(.*)'$") { $v = $Matches[1] }
          $envs[$key] = $v; if ($v.Length -ge 6) { [void]$mask.Add($v) }
        }
      }
    }
    default { & $named $meta.name }
  }
}

# ---------------------------------------------------------------- SSH
function Ensure-Key {
  # OpenSSH on Windows refuses a private key other accounts can read, so keep it owner-only.
  if (Test-Path -LiteralPath $KeyFile) { Ssh-Protect $KeyFile; return }
  [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $KeyFile))
  # Windows PowerShell 5.1 drops an empty argument; '""' reaches ssh-keygen as an empty passphrase.
  if ($PSVersionTable.PSVersion.Major -ge 7) { & ssh-keygen.exe -q -t ed25519 -N '' -C herdr -f $KeyFile | Out-Null }
  else { & ssh-keygen.exe -q -t ed25519 -N '""' -C herdr -f $KeyFile | Out-Null }
  if (-not (Test-Path -LiteralPath $KeyFile)) { Fail 'ssh-keygen did not create the key (is OpenSSH installed?)' }
  Ssh-Protect $KeyFile
}
function Ssh-Config-Path { return (Join-Path $HOME '.ssh\config') }
function Ssh-Config-Set($m) {
  $alias = Ssh-Alias $m.name
  $path = Ssh-Config-Path
  $text = Read-Text $path; if ($null -eq $text) { $text = '' }
  $begin = "# >>> herdr $alias"; $end = "# <<< herdr $alias"
  $text = [regex]::Replace($text, '(?s)\r?\n?' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end) + '\r?\n?', "`n")
  $port = 22; if ($m.port) { $port = [int]$m.port }
  # Same login as your own terminal: Herdr's key first, then your usual keys and ssh-agent (no IdentitiesOnly).
  # Host keys go to Herdr's own known_hosts, so a stale or other-type entry in ~/.ssh/known_hosts
  # (e.g. an old ECDSA line) cannot block Herdr while your terminal still connects.
  $ids = @("  IdentityFile `"$KeyFile`"")
  foreach ($k in @('id_ed25519', 'id_ecdsa', 'id_rsa')) { $f = Join-Path $HOME ".ssh\$k"; if (Test-Path -LiteralPath $f) { $ids += "  IdentityFile `"$f`"" } }
  $block = @($begin, "Host $alias", "  HostName $($m.host)", "  User $($m.user)", "  Port $port") + $ids +
    @("  UserKnownHostsFile `"$($HerdrKnown -replace '\\', '/')`"", '  StrictHostKeyChecking accept-new', '  ServerAliveInterval 30', $end) -join "`n"
  Write-Text $path (($text.TrimEnd() + "`n`n" + $block + "`n").TrimStart())
  Ssh-Protect $path
}
function Ssh-Config-Remove([string]$alias) {
  $path = Ssh-Config-Path
  $text = Read-Text $path; if ($null -eq $text) { return }
  Write-Text $path ([regex]::Replace($text, '(?s)\r?\n?' + [regex]::Escape("# >>> herdr $alias") + '.*?' + [regex]::Escape("# <<< herdr $alias") + '\r?\n?', "`n"))
  Ssh-Protect $path
}
# Windows OpenSSH refuses a config/key that other accounts can access ("Bad owner or permissions").
# A file created in ~/.ssh inherits the folder's ACL, so keep only: me, SYSTEM, Administrators.
function Ssh-Protect([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  try {
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($s in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $s), 'FullControl', 'Allow')))
    }
    [IO.File]::SetAccessControl($path, $acl)
  } catch { [Console]::Error.WriteLine("hp: could not restrict permissions of ${path}: $($_.Exception.Message)") }
}

# Installs the public key, logging in with the password from Credential Manager (SSH_ASKPASS).
# If ssh does not use askpass, it asks for the password in the terminal.
function Install-Key($m, [string]$user, [string]$credTarget) {
  Ensure-Key
  # Askpass only when a password is stored: with SSH_ASKPASS_REQUIRE=force and no password ssh would
  # fail instead of asking in the terminal.
  if ($null -ne (Cred-Get $credTarget)) {
    $env:SSH_ASKPASS = (Join-Path $HpDir 'askpass.cmd')
    $env:SSH_ASKPASS_REQUIRE = 'force'
    $env:HP_ASKPASS_TARGET = $credTarget
    if (-not $env:DISPLAY) { $env:DISPLAY = 'herdr:0' }
  }
  $port = 22; if ($m.port) { $port = [int]$m.port }
  $pub = (Read-Text "$KeyFile.pub").Trim()
  $remote = "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys)"
  & ssh.exe -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$($HerdrKnown -replace '\\', '/')" -o ConnectTimeout=8 -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1 -p $port "$user@$($m.host)" $remote
  $code = $LASTEXITCODE
  Remove-Item Env:SSH_ASKPASS, Env:SSH_ASKPASS_REQUIRE, Env:HP_ASKPASS_TARGET -ErrorAction SilentlyContinue
  return ($code -eq 0)
}

# Runs a script on the machine: sends it base64-encoded (no quoting trouble).
function Remote-Run([string]$alias, [string]$script, [bool]$sudo, [string]$sudoPw) {
  $b64 = [Convert]::ToBase64String($Utf8.GetBytes($script.Replace("`r`n", "`n")))
  if ($sudo) {
    $cmd = "f=`$(mktemp); echo $b64 | base64 -d > `$f; sudo -S -p '' bash `$f; r=`$?; rm -f `$f; exit `$r"
    $sudoPw | & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 $alias $cmd
  } else {
    $cmd = "f=`$(mktemp); echo $b64 | base64 -d > `$f; bash `$f < /dev/null; r=`$?; rm -f `$f; exit `$r"
    & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 $alias $cmd
  }
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------- events: SQLite database
# Source of truth: ~/.herdr/herdr.db (Windows' built-in SQLite: winsqlite3.dll, nothing to install).
# Table events: id (increasing), ts, project, type (message|task|tool|system), sender, recipient,
# task, execution, text. Every write also goes as a line to projects/<slug>/events.jsonl:
# that is just a feed for the Herdr UI (mods cannot access SQLite) and can be rebuilt from the database.
$DbPath = Join-Path $HerdrHome 'herdr.db'
$DbLoaded = $false
function Load-Db {
  if ($script:DbLoaded) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class HpDb {
  const string L = "winsqlite3.dll";
  [DllImport(L, EntryPoint = "sqlite3_open16", CharSet = CharSet.Unicode)] static extern int Open(string f, out IntPtr db);
  [DllImport(L, EntryPoint = "sqlite3_close")] static extern int Close(IntPtr db);
  [DllImport(L, EntryPoint = "sqlite3_busy_timeout")] static extern int Busy(IntPtr db, int ms);
  [DllImport(L, EntryPoint = "sqlite3_prepare16_v2", CharSet = CharSet.Unicode)] static extern int Prepare(IntPtr db, string sql, int n, out IntPtr st, IntPtr tail);
  [DllImport(L, EntryPoint = "sqlite3_bind_text16", CharSet = CharSet.Unicode)] static extern int BindText(IntPtr st, int i, string v, int n, IntPtr destructor);
  [DllImport(L, EntryPoint = "sqlite3_bind_null")] static extern int BindNull(IntPtr st, int i);
  [DllImport(L, EntryPoint = "sqlite3_step")] static extern int Step(IntPtr st);
  [DllImport(L, EntryPoint = "sqlite3_column_count")] static extern int Cols(IntPtr st);
  [DllImport(L, EntryPoint = "sqlite3_column_text16")] static extern IntPtr ColText(IntPtr st, int i);
  [DllImport(L, EntryPoint = "sqlite3_finalize")] static extern int Finalize(IntPtr st);
  [DllImport(L, EntryPoint = "sqlite3_errmsg16")] static extern IntPtr ErrMsg(IntPtr db);
  [DllImport(L, EntryPoint = "sqlite3_last_insert_rowid")] static extern long LastId(IntPtr db);
  static Exception Err(IntPtr db, string where) { return new Exception("SQLite (" + where + "): " + Marshal.PtrToStringUni(ErrMsg(db))); }
  // One SQL statement with parameters ?1..?n. Returns rows (text) or [[last_insert_rowid]].
  public static List<string[]> Run(string path, string sql, string[] args) {
    IntPtr db;
    if (Open(path, out db) != 0) throw Err(db, "open");
    try {
      Busy(db, 8000);
      IntPtr st;
      if (Prepare(db, sql, -1, out st, IntPtr.Zero) != 0) throw Err(db, "prepare");
      var rows = new List<string[]>();
      try {
        for (int i = 0; args != null && i < args.Length; i++) {
          if (args[i] == null) BindNull(st, i + 1); else BindText(st, i + 1, args[i], -1, new IntPtr(-1));
        }
        for (;;) {
          int rc = Step(st);
          if (rc == 100) {
            int n = Cols(st); var row = new string[n];
            for (int c = 0; c < n; c++) { IntPtr p = ColText(st, c); row[c] = p == IntPtr.Zero ? null : Marshal.PtrToStringUni(p); }
            rows.Add(row);
          } else if (rc == 101) break;
          else throw Err(db, "step");
        }
      } finally { Finalize(st); }
      if (rows.Count == 0 && sql.TrimStart().StartsWith("INSERT", StringComparison.OrdinalIgnoreCase)) rows.Add(new string[] { LastId(db).ToString() });
      return rows;
    } finally { Close(db); }
  }
}
'@
  $script:DbLoaded = $true
  if (-not (Test-Path -LiteralPath $HerdrHome)) { [void](New-Item -ItemType Directory -Force -Path $HerdrHome) }
  foreach ($sql in @(
    'PRAGMA journal_mode=WAL',
    'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project TEXT NOT NULL, type TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL DEFAULT ''all'', task TEXT, execution TEXT, text TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS events_project ON events(project, id)',
    'CREATE INDEX IF NOT EXISTS events_task ON events(project, task)',
    'CREATE TABLE IF NOT EXISTS reads (project TEXT NOT NULL, agent TEXT NOT NULL, last_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project, agent))',
    'CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL DEFAULT '''', scope TEXT NOT NULL DEFAULT ''project'', kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '''', tags TEXT NOT NULL DEFAULT '''', task TEXT, author TEXT NOT NULL, ts TEXT NOT NULL, superseded_by INTEGER)',
    'CREATE INDEX IF NOT EXISTS memories_project ON memories(project, kind, id)',
    'CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, agent TEXT NOT NULL, what TEXT NOT NULL, cmd TEXT NOT NULL DEFAULT '''', cmd_hash TEXT NOT NULL DEFAULT '''', status TEXT NOT NULL DEFAULT ''pending'', ts TEXT NOT NULL, task TEXT, decided_by TEXT, decided_ts TEXT, note TEXT, used_ts TEXT)',
    'CREATE INDEX IF NOT EXISTS approvals_project ON approvals(project, status, id)',
    'CREATE TABLE IF NOT EXISTS acks (project TEXT NOT NULL, msg_id INTEGER NOT NULL, agent TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (project, msg_id, agent))'
  )) { [void][HpDb]::Run($DbPath, $sql, $null) }
  # Collaboration columns (threads, ack requests): added once to older databases.
  foreach ($c in @('thread TEXT', 'ack_req INTEGER')) { try { [void][HpDb]::Run($DbPath, "ALTER TABLE events ADD COLUMN $c", $null) } catch {} }
  [void][HpDb]::Run($DbPath, 'CREATE INDEX IF NOT EXISTS events_thread ON events(project, thread)', $null)
}
function Db([string]$sql, [string[]]$params) { Load-Db; return , [HpDb]::Run($DbPath, $sql, $params) }
$EvCols = 'id, ts, project, type, sender, recipient, task, execution, text, thread, ack_req'
# Messages to everyone are "broadcast" (the lead answers them), to one agent or the human "direct".
function Msg-Kind([string]$type, [string]$to) { if ($type -ne 'message') { return $null }; if (-not $to -or $to -eq 'all') { return 'broadcast' }; return 'direct' }
function Ev-Object($r) {
  $o = [pscustomobject][ordered]@{ id = [int64]$r[0]; ts = $r[1]; project = $r[2]; type = $r[3]; from = $r[4]; to = $r[5]; task = $r[6]; execution = $r[7]; text = $r[8]; kind = (Msg-Kind $r[3] $r[5]) }
  # Thread (a task id or a free name) and "ack requested" only when set, so the feed stays as before.
  if ($r.Count -gt 9 -and $r[9]) { $o | Add-Member -NotePropertyName thread -NotePropertyValue $r[9] }
  if ($r.Count -gt 10 -and $r[10] -eq '1') { $o | Add-Member -NotePropertyName ack -NotePropertyValue $true }
  return $o
}
function Events-Query([string]$where, [string[]]$params, [int]$limit) {
  $rows = Db "SELECT $EvCols FROM (SELECT $EvCols FROM events WHERE $where ORDER BY id DESC LIMIT $limit) ORDER BY id" $params
  return , @($rows | ForEach-Object { Ev-Object $_ })
}
function Max-EventId([string]$slug) {
  $r = Db 'SELECT COALESCE(MAX(id), 0) FROM events WHERE project = ?1' @($slug)
  return [int64]$r[0][0]
}
# UI feed: appends the event (with its database id) to the project's events.jsonl.
function Feed-Append([string]$dir, $ev) {
  $line = (ConvertTo-Json -InputObject $ev -Compress -Depth 4) + "`n"
  # The UI reads files only up to 1 MiB (and re-reads it every few seconds): past 640 KB the feed is cut
  # to its newest part right away.
  With-Lock $dir {
    $fp = Join-Path $dir 'events.jsonl'
    [IO.File]::AppendAllText($fp, $line, $Utf8)
    if ((New-Object IO.FileInfo $fp).Length -gt 640KB) { [void](Feed-Trim $dir 0) }
  }
}
# Keeps the newest $FeedEvents lines of events.jsonl (at most $FeedBytes, none below id $minId).
# Call inside With-Lock $dir. Returns how many lines were dropped. The database keeps everything.
$FeedEvents = 2000; $FeedBytes = 450KB
function Feed-Trim([string]$dir, [int64]$minId) {
  $fp = Join-Path $dir 'events.jsonl'
  if (-not (Test-Path -LiteralPath $fp)) { return 0 }
  $lines = [IO.File]::ReadAllLines($fp, $Utf8)
  $keep = New-Object System.Collections.Generic.List[string]
  $bytes = 0; $total = 0
  foreach ($l in $lines) { if ($l.Trim()) { $total++ } }
  for ($i = $lines.Length - 1; $i -ge 0; $i--) {
    $l = $lines[$i]; if (-not $l.Trim()) { continue }
    if ($keep.Count -ge $FeedEvents) { break }
    $bytes += $Utf8.GetByteCount($l) + 1; if ($bytes -gt $FeedBytes) { break }
    if ($minId -gt 0 -and $l -match '^\{"id":(\d+)' -and [int64]$Matches[1] -lt $minId) { break }
    $keep.Add($l)
  }
  $drop = $total - $keep.Count
  if ($drop -le 0) { return 0 }
  $keep.Reverse()
  Write-Text $fp (($keep -join "`n") + "`n")
  return $drop
}
function Emit([string]$dir, [string]$type, [string]$from, [string]$to, [string]$text, $task, [string]$thread = '', [bool]$ackReq = $false) {
  $slug = Slug-Of $dir
  if (-not $to) { $to = 'all' }
  $ts = Now-Iso
  $exec = O 'exec'; if (-not $exec) { $exec = $env:HERDR_EXEC }
  $taskStr = if ($null -ne $task -and "$task" -ne '') { ([string]$task).TrimStart('#') } else { $null }
  # Thread: given, else the task (messages about a task form its thread).
  $th = if ($thread) { $thread.TrimStart('#') } elseif ($taskStr -and $type -eq 'message') { $taskStr } else { $null }
  $id = (Db 'INSERT INTO events (ts, project, type, sender, recipient, task, execution, text, thread, ack_req) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)' @($ts, $slug, $type, $from, $to, $taskStr, $exec, $text, $th, $(if ($ackReq) { '1' } else { $null })))[0][0]
  $ev = [ordered]@{ id = [int64]$id; ts = $ts; project = $slug; type = $type; from = $from; to = $to; task = $taskStr; execution = $exec; text = $text; kind = (Msg-Kind $type $to) }
  if ($th) { $ev.thread = $th }; if ($ackReq) { $ev.ack = $true }
  Feed-Append $dir $ev
  $script:LastEmitId = [int64]$id # not returned: callers use Emit as a statement
}
function Print-Events($list) {
  foreach ($m in $list) {
    $t = ([datetime]$m.ts).ToLocalTime().ToString('HH:mm')
    $to = if ($m.to -and $m.to -ne 'all') { " -> $($m.to)" } else { '' }
    $tag = if ($m.type -and $m.type -ne 'message') { "[$($m.type)] " } else { '' }
    $tk = if ($m.task) { " (#$($m.task))" } else { '' }
    Write-Output "[$t] $tag$($m.from)$to$tk`: $($m.text)"
  }
}
# New for the agent: messages to it or to everyone, plus events addressed to it.
function Inbox([string]$dir, [string]$me, [bool]$mark) {
  $slug = Slug-Of $dir
  $r = Db 'SELECT last_id FROM reads WHERE project = ?1 AND agent = ?2' @($slug, $me)
  $seen = if ($r.Count) { [int64]$r[0][0] } else { 0 }
  $new = Events-Query "project = ?1 AND id > ?2 AND sender <> ?3 AND (recipient = ?3 OR (recipient = 'all' AND type = 'message'))" @($slug, [string]$seen, $me) 200
  if ($mark) {
    $max = if ($new.Count) { $new[$new.Count - 1].id } else { $seen }
    [void](Db 'INSERT INTO reads (project, agent, last_id) VALUES (?1, ?2, ?3) ON CONFLICT(project, agent) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)' @($slug, $me, [string]$max))
  }
  return , $new
}
function Mark-Read([string]$dir, [string]$me) {
  $slug = Slug-Of $dir
  [void](Db 'INSERT INTO reads (project, agent, last_id) VALUES (?1, ?2, ?3) ON CONFLICT(project, agent) DO UPDATE SET last_id = excluded.last_id' @($slug, $me, [string](Max-EventId $slug)))
}
# Team lead (answers broadcasts for the team): the agent set with "hp agent set <name> --lead on",
# else the first whose name or role says lead/architect/coordinator, else the first agent. '' if none.
function Lead-Of([string]$dir) {
  $list = @(Agents-Load $dir)
  if (-not $list.Count) { return '' }
  foreach ($a in $list) { if ($a.PSObject.Properties['lead'] -and $a.lead -eq $true) { return [string]$a.name } }
  foreach ($a in $list) { if ("$($a.name) $($a.role)" -match '(?i)lead|architect|coordinator') { return [string]$a.name } }
  return [string]$list[0].name
}
# Agent names @mentioned in a text (only names of this project's agents).
function Mentions([string]$text, $names) {
  $out = @()
  foreach ($m in [regex]::Matches([string]$text, '(?<![\w@])@([A-Za-z0-9][A-Za-z0-9_-]*)')) {
    $n = $m.Groups[1].Value
    foreach ($x in @(Arr $names)) { if ($x -eq $n -and -not (Has $out $x)) { $out += [string]$x } }
  }
  return , $out
}
# Inbox output: [team] = broadcast, [team, @you] = broadcast that mentions you, [direct] = only to you.
# Ends with a hint on who answers, so team messages get one reply (the lead's), not one per agent.
function Print-Inbox([string]$dir, [string]$me, $list) {
  $lead = Lead-Of $dir
  $names = @(Agents-Load $dir | ForEach-Object { [string]$_.name })
  $team = 0; $human = 0; $at = 0; $acks = @()
  # Grouped by thread (in order of first appearance), each message with its id for hp ack / hp say --reply.
  $keys = New-Object System.Collections.ArrayList
  foreach ($m in $list) { $k = Thread-Key $m; if (-not $keys.Contains($k)) { [void]$keys.Add($k) } }
  $list = @(foreach ($k in $keys) { $list | Where-Object { (Thread-Key $_) -eq $k } })
  $prev = $null
  foreach ($m in $list) {
    $k = Thread-Key $m
    if ($k -ne $prev -and $k -and @($list | Where-Object { (Thread-Key $_) -eq $k }).Count -gt 1) { Write-Output "-- thread $k (hp thread $k) --" }
    $prev = $k
    if ($m.PSObject.Properties['ack'] -and $m.ack -and $m.to -eq $me) { $acks += $m.id }
    $t = "$(([datetime]$m.ts).ToLocalTime().ToString('HH:mm')) m$($m.id)"
    $tk = if ($m.task) { " (#$($m.task))" } elseif ($m.PSObject.Properties['thread'] -and $m.thread) { " {$($m.thread)}" } else { '' }
    if ($m.PSObject.Properties['ack'] -and $m.ack) { $tk += ' [ack requested]' }
    if ($m.type -eq 'message' -and (-not $m.to -or $m.to -eq 'all')) {
      $ms = Mentions ([string]$m.text) $names
      $mine = Has $ms $me
      # A team message that @mentions other agents is theirs to answer; for the rest it is FYI.
      if ($mine) { $at++ } else { $team++; if ($m.from -eq 'ty' -and -not $ms.Count) { $human++ } }
      Write-Output "[$t] $(if ($mine) { '[team, @you]' } else { '[team]' }) $($m.from)$tk`: $($m.text)"
    } else {
      $tag = if ($m.type -and $m.type -ne 'message') { "[$($m.type)]" } else { '[direct]' }
      Write-Output "[$t] $tag $($m.from) -> you$tk`: $($m.text)"
    }
  }
  if ($acks.Count) { Write-Output "-- The sender asked for an acknowledgment: hp ack $(($acks | ForEach-Object { 'm' + $_ }) -join ' ') --as $me (then act on it)." }
  if ($at) { Write-Output '-- [team, @you]: you were @mentioned, so reply to the sender (hp say --reply <m-id> or --to <sender>).' }
  if ($team -and $lead -and $me -eq $lead) {
    if ($human) { Write-Output "-- You are the team lead: answer the human's team messages for the whole team (hp say --to ty), and delegate with hp task add --for <agent> or an @mention in hp say. The other agents stay quiet." }
    else { Write-Output '-- You are the team lead: team messages from agents are FYI; answer only if one asks you something.' }
  } elseif ($team -and $lead) {
    Write-Output "-- [team] = team message: the lead ($lead) answers it for the team. Do not reply unless it is about your current task or you are @mentioned; act on it silently (e.g. pick up your tasks)."
  }
}
# Rebuilds the events.jsonl feed from the database (e.g. after the file was deleted by hand).
function Feed-Rebuild([string]$dir) {
  $list = Events-Query 'project = ?1' @((Slug-Of $dir)) $FeedEvents
  $sb = New-Object System.Text.StringBuilder
  foreach ($e in $list) { [void]$sb.Append((ConvertTo-Json -InputObject $e -Compress -Depth 4)).Append("`n") }
  With-Lock $dir { Write-Text (Join-Path $dir 'events.jsonl') $sb.ToString() }
}

# ---------------------------------------------------------------- collaboration (threads, acks, ready, leases, reservations, cards)
# Patterns from MCP Agent Mail (threads, ack_required, advisory file reservations with TTL), Beads (bd ready,
# atomic claim, discovered-from), Claude Code agent teams (self-claim unblocked tasks) and A2A (agent cards).
function Thread-Key($m) { if ($m.PSObject.Properties['thread'] -and $m.thread) { return [string]$m.thread }; if ($m.task) { return [string]$m.task }; return '' }
function Msg-Get([string]$dir, [string]$id) {
  $n = $id.TrimStart('m', 'M', '#')
  $r = @(Events-Query 'project = ?1 AND id = ?2' @((Slug-Of $dir), $n) 1)
  if (-not $r.Count) { Fail "No message m$n in this project" }
  return $r[0]
}
# Who has seen a message (read pointer past it) and who acknowledged it.
function Msg-Receipts([string]$dir, $m) {
  $slug = Slug-Of $dir
  $to = if ($m.to -and $m.to -ne 'all') { @([string]$m.to) } else { @(Agents-Load $dir | ForEach-Object { [string]$_.name } | Where-Object { $_ -ne $m.from }) }
  $seen = @(); $acked = @()
  foreach ($r in (Db 'SELECT agent, last_id FROM reads WHERE project = ?1' @($slug))) { if ((Has $to $r[0]) -and [int64]$r[1] -ge $m.id) { $seen += $r[0] } }
  foreach ($r in (Db 'SELECT agent FROM acks WHERE project = ?1 AND msg_id = ?2' @($slug, [string]$m.id))) { $acked += $r[0] }
  return [pscustomobject][ordered]@{ to = $to; seen = $seen; acked = $acked }
}

$PoolNames = @('', 'team', 'any')   # task owner "team" = unassigned: anyone may claim it
$LeaseMin = 120                     # task claim lease (minutes), renewed by progress/note/claim
$PrioRank = @{ urgent = 0; high = 1; normal = 2; low = 3 }
function Is-Pool($x) { return (Has $PoolNames ([string]$x.agent)) }
function Lease-Holder($x) {
  if (-not ($x.PSObject.Properties['lease'] -and $x.lease)) { return '' }
  try { if (([datetime]$x.lease.until).ToUniversalTime() -gt (Get-Date).ToUniversalTime()) { return [string]$x.lease.by } } catch {}
  return ''
}
function Set-Lease($x, [string]$me, [int]$min) {
  Set-Prop $x 'lease' ([pscustomobject][ordered]@{ by = $me; until = (Get-Date).ToUniversalTime().AddMinutes($min).ToString('yyyy-MM-ddTHH:mm:ssZ') })
}
# Ready = To Do, every dependency done, owned by $me or unassigned (team), not leased by someone else.
# Sorted Beads-style: priority, then own before team, then oldest.
function Ready-Tasks($t, [string]$me, [bool]$all) {
  $out = @($t.tasks | Where-Object {
    $_.status -eq 'todo' -and -not (Is-Epic $_) -and -not (Waits-For $t $_).Count -and ($all -or $_.agent -eq $me -or (Is-Pool $_)) -and (@('', $me) -contains (Lease-Holder $_))
  })
  return , @($out | Sort-Object { $r = $PrioRank[[string]$_.priority]; if ($null -eq $r) { 2 } else { $r } }, { if ($_.agent -eq $me) { 0 } else { 1 } }, { [int]$_.id })
}

# File reservations (advisory leases on paths/globs relative to the repository root), reservations.json.
$ResTtl = 60
function Res-Path([string]$dir) { return (Join-Path $dir 'reservations.json') }
function Res-Live($list) {
  $now = (Get-Date).ToUniversalTime()
  return , @(Arr $list | Where-Object { $_ -and $(try { ([datetime]$_.expires).ToUniversalTime() -gt $now } catch { $false }) })
}
function Res-Load([string]$dir) { $r = Res-Live (Read-Json (Res-Path $dir) @()); return , $r }
function Glob-Norm([string]$g) { $g = ($g -replace '\\', '/').Trim(); while ($g.StartsWith('./')) { $g = $g.Substring(2) }; return $g.TrimStart('/').ToLowerInvariant() }
function Glob-Rx([string]$g) {
  $sb = New-Object System.Text.StringBuilder
  for ($i = 0; $i -lt $g.Length; $i++) {
    $c = $g[$i]
    if ($c -eq '*' -and $i + 1 -lt $g.Length -and $g[$i + 1] -eq '*') { [void]$sb.Append('.*'); $i++; if ($i + 1 -lt $g.Length -and $g[$i + 1] -eq '/') { $i++; [void]$sb.Append('/?') } }
    elseif ($c -eq '*') { [void]$sb.Append('[^/]*') }
    elseif ($c -eq '?') { [void]$sb.Append('[^/]') }
    else { [void]$sb.Append([regex]::Escape([string]$c)) }
  }
  return '^' + $sb.ToString().TrimEnd('/') + '(/.*)?$'
}
function Glob-Match([string]$g, [string]$path) { return ((Glob-Norm $path) -match (Glob-Rx (Glob-Norm $g))) }
function Glob-Static([string]$g) { $g = Glob-Norm $g; $i = $g.IndexOfAny([char[]]'*?['); if ($i -lt 0) { return $g }; return $g.Substring(0, $i) }
# Conservative overlap test of two globs (may report a few false overlaps, which is the safe side).
function Glob-Overlap([string]$a, [string]$b) {
  $sa = Glob-Static $a; $sb = Glob-Static $b
  if ((Glob-Match $a $sb) -or (Glob-Match $b $sa)) { return $true }
  if ($sa -and $sb -and ($sa.StartsWith($sb) -or $sb.StartsWith($sa))) { return $true }
  return $false
}
# Others' live reservations that conflict with $patterns: any exclusive one, or all when $exclusive.
function Res-Conflicts($list, [string]$me, $patterns, [bool]$exclusive) {
  $out = @()
  foreach ($r in (Arr $list)) {
    if ($r.agent -eq $me) { continue }
    if (-not ($exclusive -or $r.exclusive)) { continue }
    foreach ($g in (Arr $patterns)) { if (Glob-Overlap $g $r.pattern) { $out += $r; break } }
  }
  return , $out
}
function Res-Line($r) {
  $left = [int][Math]::Max(0, (([datetime]$r.expires).ToUniversalTime() - (Get-Date).ToUniversalTime()).TotalMinutes)
  return "r$($r.id)  $($r.pattern)  $($r.agent)  $(if ($r.exclusive) { 'exclusive' } else { 'shared' })  ${left}m left$(if ($r.task) { '  #' + $r.task })$(if ($r.reason) { '  ' + $r.reason })"
}
# Files (repo-relative) that another agent reserved: "file -> r<id> agent (exclusive)" lines.
function Res-Hits([string]$dir, [string]$me, $files) {
  $out = @(); $list = Res-Load $dir
  foreach ($f in (Arr $files)) { foreach ($r in $list) { if ($r.agent -ne $me -and (Glob-Match $r.pattern $f)) { $out += "$f -> r$($r.id) $($r.agent)$(if ($r.exclusive) { ' (exclusive)' } else { ' (shared)' })$(if ($r.task) { ' #' + $r.task })"; break } } }
  return , $out
}
# Releases $me's reservations (all, or those tied to a task / matching patterns). Returns how many.
function Res-Release([string]$dir, [string]$me, [string]$task, $patterns) {
  $script:resN = 0
  With-Lock $dir {
    $list = Res-Load $dir
    $keep = @($list | Where-Object {
      $mine = $_.agent -eq $me
      $hit = $mine -and $(if ($task) { [string]$_.task -eq $task } elseif (@(Arr $patterns).Count) { (Has (@(Arr $patterns) | ForEach-Object { Glob-Norm $_ }) (Glob-Norm $_.pattern)) -or (Has $patterns ('r' + $_.id)) } else { $true })
      -not $hit
    })
    $script:resN = $list.Count - $keep.Count
    Write-Json (Res-Path $dir) @($keep)
  }
  return $script:resN
}

# Agent cards (A2A-style): who can do what, used by hp route and the lead.
function Card-Of([string]$dir, $a, $t, $stat) {
  $st = 'unknown'
  if ($stat -and $stat.agents -and $stat.agents.PSObject.Properties[$a.name]) { $st = [string]$stat.agents.($a.name).status }
  $open = @($t.tasks | Where-Object { $_.agent -eq $a.name -and ($_.status -eq 'todo' -or $_.status -eq 'doing') })
  return [pscustomobject][ordered]@{
    name = [string]$a.name; engine = $(if ($a.app -eq 'codex') { 'codex' } else { 'claude' }); role = [string]$a.role
    skills = @(Arr $(if ($a.PSObject.Properties['skills']) { $a.skills })); desc = $(if ($a.PSObject.Properties['desc']) { [string]$a.desc } else { '' })
    lead = ((Lead-Of $dir) -eq $a.name); risk = (Risk-Of $dir $a.name); machines = @(Arr $a.machines); status = $st
    open = $open.Count; doing = @($open | Where-Object { $_.status -eq 'doing' } | ForEach-Object { [int]$_.id })
  }
}
function Status-Fresh([string]$dir) {
  $stat = Read-Json (Join-Path $dir 'status.json') $null
  if ($stat -and $stat.updated -and (((Get-Date).ToUniversalTime() - [datetime]::Parse($stat.updated).ToUniversalTime()).TotalMinutes -lt 3)) { return $stat }
  return $null
}
# Owner suggestions for a task title: skill/role/description word overlap, then availability.
function Route-Of([string]$dir, [string]$title) {
  $t = Tasks-Load $dir; $stat = Status-Fresh $dir
  $words = Mem-Words $title # returns , @(...): no @() around it
  $res = @()
  foreach ($a in (Agents-Load $dir)) {
    $c = Card-Of $dir $a $t $stat
    $why = @(); $score = 0.0
    $skillWords = Mem-Words (($c.skills -join ' ') + ' ' + $c.role + ' ' + $c.desc)
    foreach ($w in $words) {
      foreach ($s in $skillWords) { if ($s -eq $w -or ($w.Length -ge 4 -and $s.Length -ge 4 -and ($s.StartsWith($w) -or $w.StartsWith($s)))) { $score += 3; $why += $s; break } }
    }
    if ($c.status -eq 'idle') { $score += 1.5; $why += 'idle' } elseif ($c.status -eq 'stopped') { $score += 0.5 } elseif ($c.status -eq 'blocked') { $score -= 1 }
    $score -= [Math]::Min(3, $c.open * 0.75)
    if ($c.lead) { $score -= 0.5 } # the lead coordinates; give it work only when it fits best
    $res += [pscustomobject][ordered]@{ agent = $c.name; score = [Math]::Round($score, 2); match = @($why | Where-Object { $_ -ne 'idle' }).Count; why = (@($why | Select-Object -Unique) -join ', '); open = $c.open; status = $c.status; engine = $c.engine }
  }
  return , @($res | Sort-Object { - $_.score }, { $_.open }, { $_.agent })
}

# ---------------------------------------------------------------- tasks
$Statuses = @('backlog', 'todo', 'doing', 'review', 'blocked', 'done')
$StatusName = @{ backlog = 'backlog'; todo = 'to do'; doing = 'in progress'; review = 'review'; blocked = 'blocked'; done = 'done' }
$Priorities = @('low', 'normal', 'high', 'urgent')
function Tasks-Path([string]$dir) { return (Join-Path $dir 'tasks.json') }
function Tasks-Load([string]$dir) {
  $t = Read-Json (Tasks-Path $dir) $null
  if ($null -eq $t) { $t = [pscustomobject]@{ next = 1; tasks = @() } }
  $t.tasks = @(Arr $t.tasks)
  return $t
}
function Tasks-Change([string]$dir, [scriptblock]$change) {
  $script:result = $null; $script:epicsDone = @()
  With-Lock $dir {
    $t = Tasks-Load $dir
    $script:result = & $change $t
    Epics-Sync $t
    # Compact: Windows PowerShell's indented JSON is ~3x bigger, and the UI reads files only up to 1 MiB.
    Write-Text (Tasks-Path $dir) (ConvertTo-Json -InputObject $t -Depth 12 -Compress)
  }
  $r = $script:result
  # An epic whose last task got done: its owner (the lead) writes ty a short summary.
  foreach ($e in @($script:epicsDone)) {
    $ow = [string]$e.agent; if (-not $ow -or (Has $PoolNames $ow)) { $ow = Lead-Of $dir }
    Emit $dir 'task' 'hp' $(if ($ow) { $ow } else { 'all' }) "Epic #$($e.id) $($e.title) is done: all its tasks are finished. Write ty a short summary (what was delivered, anything left open): hp say --to ty --task $($e.id) --as $ow `"...`"" ([string]$e.id)
  }
  $script:epicsDone = @()
  return $r
}
function Find-Task($t, [string]$id) {
  $n = $id.TrimStart('#')
  foreach ($x in $t.tasks) { if ([string]$x.id -eq $n) { return $x } }
  if (Archived-Task (Try-Find-Project) $n) { Fail "Task #$n is archived (done long ago). See: hp task show $n" }
  Fail "No such task #$n"
}
# Retention: history/notes keep the last $TaskEntries entries per task; done tasks finished more than
# $TaskArchiveDays days ago go to tasks-archive.jsonl (hp maintain; hp task list --all and hp task show read it).
$TaskEntries = 50; $TaskArchiveDays = 30
function Task-History($x, [string]$by, [string]$what) {
  Set-Prop $x 'history' @(@(Arr $x.history) + @([pscustomobject][ordered]@{ ts = (Now-Iso); by = $by; text = $what }) | Select-Object -Last $TaskEntries)
  $x.updated = (Now-Iso)
}
function Tasks-Archived([string]$dir) {
  $ap = Join-Path $dir 'tasks-archive.jsonl'
  # Streams the tasks (callers wrap in @()).
  if (-not (Test-Path -LiteralPath $ap)) { return }
  [IO.File]::ReadAllLines($ap, $Utf8) | Where-Object { $_.Trim() } | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} }
}
function Archived-Task([string]$dir, [string]$id) {
  if (-not $dir) { return $null }
  return (Tasks-Archived $dir | Where-Object { [string]$_.id -eq $id } | Select-Object -Last 1)
}
# Dependencies: task.after = ids that must be done first. Returns the unfinished ones.
function Waits-For($t, $x) {
  $out = @()
  foreach ($d in (Arr $x.after)) { $y = $t.tasks | Where-Object { [string]$_.id -eq [string]$d } | Select-Object -First 1; if ($y -and $y.status -ne 'done') { $out += [int]$d } }
  return , $out
}
# After task $doneId is done: dependents whose deps are all done get "unblocked by #X"; a task blocked
# with reason "waiting for #..." moves back to To Do. Returns the unblocked tasks.
function Unblock-Dependents($t, [string]$doneId, [string]$by) {
  $out = @()
  foreach ($y in $t.tasks) {
    if ($y.status -eq 'done' -or -not (Has (@(Arr $y.after) | ForEach-Object { [string]$_ }) $doneId)) { continue }
    if ((Waits-For $t $y).Count) { continue }
    Task-History $y $by "unblocked by #$doneId"
    if ($y.status -eq 'blocked' -and ([string]$y.blocked_reason) -like 'waiting for #*') { $y.status = 'todo'; Set-Prop $y 'blocked_reason' ''; $script:movedBack += [string]$y.id }
    $out += $y
  }
  return , $out
}
# Epics: a task with kind "epic"; its child tasks have epic = <id>. The epic's status follows its children
# (In Progress once the plan is approved or a child left the Backlog, Done when every child is done). The
# lead's plan (children in Backlog) waits for ty's approval (hp epic submit; the epic sits in Backlog meanwhile, back
# in To Do on Revise), unless the lead is autonomous.
function Is-Epic($x) { return [bool]($x -and $x.PSObject.Properties['kind'] -and [string]$x.kind -eq 'epic') }
function Epic-Of($x) { if ($x -and $x.PSObject.Properties['epic'] -and $x.epic) { return [string]$x.epic }; return '' }
function Epic-Kids($t, [string]$id) { return , @($t.tasks | Where-Object { (Epic-Of $_) -eq $id }) }
function Epic-Plan($x) { if ($x -and $x.PSObject.Properties['plan'] -and $x.plan) { return [string]$x.plan }; return '' }
# Called inside Tasks-Change: derives every epic's status and progress; epics that just got done go to $script:epicsDone.
function Epics-Sync($t) {
  foreach ($e in @($t.tasks | Where-Object { Is-Epic $_ })) {
    $kids = Epic-Kids $t ([string]$e.id)
    if (-not $kids.Count) { continue }
    $done = @($kids | Where-Object { $_.status -eq 'done' }).Count
    $pct = [int][Math]::Floor(100 * $done / $kids.Count)
    if ([int]$e.progress -ne $pct) { Set-Prop $e 'progress' $pct }
    if ($done -eq $kids.Count) {
      if ($e.status -ne 'done') { $e.status = 'done'; Set-Prop $e 'completed' (Now-Iso); Set-Prop $e 'blocked_reason' ''; Task-History $e 'hp' "all $($kids.Count) tasks done"; $script:epicsDone += $e }
    } elseif ($e.status -ne 'doing' -and ($e.status -eq 'done' -or (Epic-Plan $e) -eq 'approved' -or @($kids | Where-Object { $_.status -ne 'backlog' }).Count)) {
      $e.status = 'doing'; Set-Prop $e 'completed' $null; if (-not $e.started) { Set-Prop $e 'started' (Now-Iso) }
      Task-History $e 'hp' "in progress ($done/$($kids.Count) tasks done)"
    }
  }
}
# Owner nudges: the human's changes to a task (priority, column, owner) reach its owner agent as one short direct
# message. hp queues them in nudges.json (per task, ts = epoch ms of the last change); the app runs
# "hp nudges flush" ~5 s after the last change, so several quick edits become one message.
$NudgeStatus = @{ backlog = 'Backlog'; todo = 'To Do'; doing = 'In Progress'; review = 'Review'; blocked = 'Blocked'; done = 'Done' }
function Nudge-Queue([string]$dir, $x, [string]$key, [string]$val) {
  if (-not $x -or (Has $PoolNames ([string]$x.agent)) -or $x.agent -eq 'ty' -or $x.agent -eq 'hp' -or $x.status -eq 'done') { return }
  $np = Join-Path $dir 'nudges.json'
  With-Lock $dir {
    $q = Read-Json $np $null; if ($null -eq $q) { $q = [pscustomobject]@{} }
    $k = "t$($x.id)" # a name like "2" would be taken for a PSMemberTypes value by Add-Member
    $e = if ($q.PSObject.Properties[$k]) { $q.$k } else { $null }
    if (-not $e) { $e = [pscustomobject][ordered]@{ agent = ''; changes = [pscustomobject]@{}; ts = 0 }; Set-Prop $q $k $e }
    $e.agent = [string]$x.agent
    Set-Prop $e.changes $key $val
    $e.ts = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    Write-Json $np $q
  }
}
# Plan approved (by ty, or at once for an autonomous lead): the epic's Backlog tasks go to To Do (their --after
# dependencies still hold them back: hp ready respects them) and every owner is told which tasks are theirs.
function Epic-Approve([string]$dir, [string]$id, [string]$by, [string]$note) {
  $script:epMoved = @()
  $title = Tasks-Change $dir {
    param($t)
    $e = Find-Task $t $id
    Set-Prop $e 'plan' 'approved'; Set-Prop $e 'plan_note' $note
    foreach ($k in (Epic-Kids $t $id)) { if ($k.status -eq 'backlog') { $k.status = 'todo'; Task-History $k $by "plan of epic #$id approved: to do"; $script:epMoved += $k } }
    Task-History $e $by "plan approved ($(@($script:epMoved).Count) tasks to To Do)$(if ($note) { ': ' + $note })"
    $e.title
  }
  $byOwner = @{}
  foreach ($k in @($script:epMoved)) { $o = [string]$k.agent; if (-not $byOwner.ContainsKey($o)) { $byOwner[$o] = @() }; $byOwner[$o] += $k }
  foreach ($o in $byOwner.Keys) {
    $ids = ($byOwner[$o] | ForEach-Object { '#' + $_.id + ' ' + $_.title }) -join '; '
    if (Has $PoolNames $o) { Emit $dir 'task' $by 'all' "Epic #$id $title is approved. Unassigned tasks ready to claim: $ids" $id }
    else { Emit $dir 'task' $by $o "Epic #$id $title is approved. Your tasks are in To Do: $ids. Run: hp ready --as $o (dependencies first)" $id }
  }
  return @($script:epMoved).Count
}

# ---------------------------------------------------------------- memory (hp remember / recall / search / reflect / forget)
# Table memories in herdr.db: what a teammate starting fresh should know. scope 'project' (project = slug)
# or 'global' (project = ''); kind decision|gotcha|pattern|note; superseded_by = id of the newer memory.
# Kept forever (rows are small: title <= 200, body <= 4000 chars). DECISIONS.md is generated from the
# decision rows; memory.json (counts + newest titles) is a small feed for the UI.
$MemKinds = @('decision', 'gotcha', 'pattern', 'note')
$MemCols = 'id, project, scope, kind, title, body, tags, task, author, ts, superseded_by'
function Clip-Text([string]$s, [int]$n) { if ($null -eq $s) { return '' }; $s = $s.Trim(); if ($s.Length -gt $n) { return $s.Substring(0, $n) }; return $s }
function Mem-Object($r) { return [pscustomobject][ordered]@{ id = [int64]$r[0]; project = $r[1]; scope = $r[2]; kind = $r[3]; title = $r[4]; body = $r[5]; tags = $r[6]; task = $r[7]; author = $r[8]; ts = $r[9]; superseded_by = $r[10] } }
function Mem-Add([string]$dir, [string]$kind, [string]$title, [string]$body, [string]$tags, [string]$task, [string]$author, [bool]$global) {
  if ($MemKinds -notcontains $kind) { Fail "Kind: $($MemKinds -join ', ')" }
  $slug = if ($global) { '' } else { Slug-Of $dir }
  $scope = if ($global) { 'global' } else { 'project' }
  $tk = if ($task) { $task.TrimStart('#') } else { $null }
  $r = Db 'INSERT INTO memories (project, scope, kind, title, body, tags, task, author, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)' @($slug, $scope, $kind, (Clip-Text $title 200), (Clip-Text $body 4000), (Clip-Text $tags 200), $tk, $author, (Now-Iso))
  return [int64]$r[0][0]
}
function Mem-Get([string]$id) { $r = Db "SELECT $MemCols FROM memories WHERE id = ?1" @($id.TrimStart('m', '#')); if ($r.Count) { return (Mem-Object $r[0]) }; return $null }
# Memories visible from a project: its own + global ones (superseded ones only with $all), newest first.
function Mem-Visible([string]$slug, [bool]$all) {
  $w = "(project = ?1 OR scope = 'global')"; if (-not $all) { $w += ' AND superseded_by IS NULL' }
  $rows = Db "SELECT $MemCols FROM memories WHERE $w ORDER BY id DESC LIMIT 5000" @($slug)
  return , @($rows | ForEach-Object { Mem-Object $_ })
}
$StopWords = @('the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'have', 'has', 'not', 'but', 'you', 'your', 'our', 'how', 'what', 'why', 'when', 'where', 'did', 'does', 'can', 'its', 'all', 'any', 'about', 'there', 'then', 'than', 'just', 'also', 'should', 'would', 'could', 'will', 'task')
function Mem-Words([string]$q) {
  $w = @([regex]::Matches(([string]$q).ToLowerInvariant(), '[\p{L}\p{N}_][\p{L}\p{N}_.:/-]*') | ForEach-Object { $_.Value.Trim('.', '-', ':', '/') } | Where-Object { $_.Length -ge 3 -and $StopWords -notcontains $_ } | Select-Object -Unique)
  return , $w
}
# Word scoring: a word found in the title or tags counts 3, in the body 1. Ties: newer first.
function Mem-Match($list, [string]$q, [int]$n) {
  $words = Mem-Words $q
  if (-not $words.Count) { return , @() }
  $scored = @(foreach ($m in $list) {
    $s = 0; $tt = ("$($m.title) $($m.tags)").ToLowerInvariant(); $bb = ([string]$m.body).ToLowerInvariant()
    foreach ($w in $words) { if ($tt.Contains($w)) { $s += 3 } elseif ($bb.Contains($w)) { $s += 1 } }
    if ($s -gt 0) { [pscustomobject]@{ m = $m; s = $s } }
  })
  return , @($scored | Sort-Object @{ Expression = { $_.s }; Descending = $true }, @{ Expression = { $_.m.id }; Descending = $true } | Select-Object -First $n | ForEach-Object { $_.m })
}
function Mem-Line($m) {
  $d = ([datetime]$m.ts).ToLocalTime().ToString('yyyy-MM-dd')
  $extra = @(); if ($m.task) { $extra += "#$($m.task)" }; if ($m.scope -eq 'global') { $extra += 'global' }; if ($m.tags) { $extra += $m.tags }
  $b = ([string]$m.body -replace '\s+', ' ').Trim(); if ($b.Length -gt 220) { $b = $b.Substring(0, 217) + '...' }
  return "  m$($m.id) [$($m.kind)] $d $($m.author)$(if ($extra.Count) { ' (' + ($extra -join ', ') + ')' }): $($m.title)$(if ($b -and $b -ne $m.title) { ' -- ' + $b })"
}
# DECISIONS.md used to be the only store: its lines are imported once (marker file .memory-migrated).
function Mem-Migrate([string]$dir) {
  $mark = Join-Path $dir '.memory-migrated'
  if (Test-Path -LiteralPath $mark) { return }
  With-Lock $dir {
    if (Test-Path -LiteralPath $mark) { return }
    $path = Join-Path $dir 'DECISIONS.md'; $n = 0
    if (Test-Path -LiteralPath $path) {
      foreach ($l in [IO.File]::ReadAllLines($path, $Utf8)) {
        if ($l -match '^- (\d{4}-\d\d-\d\d \d\d:\d\d) \*\*([^*]+)\*\*(?: \(#(\d+)\))?: (.+)$') {
          $when = $Matches[1]; $who = $Matches[2]; $tk = $Matches[3]; $text = ($Matches[4] -replace '\s*<!-- m\d+ -->\s*$', '').Trim()
        } elseif ($l -match '^\s*[-*] (.+)$') {
          # Hand-written entry: kept as it is (nothing in DECISIONS.md is lost).
          $when = ''; $who = 'unknown'; $tk = $null; $text = $Matches[1].Trim()
        } else { continue }
        if (-not $text) { continue }
        $ts = Now-Iso
        try { $ts = ([datetime]::ParseExact($when, 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } catch {}
        [void](Db "INSERT INTO memories (project, scope, kind, title, body, tags, task, author, ts) VALUES (?1, 'project', 'decision', ?2, ?3, '', ?4, ?5, ?6)" @((Slug-Of $dir), (Clip-Text $text 200), (Clip-Text $text 4000), $(if ($tk) { $tk } else { $null }), $who, $ts))
        $n++
      }
    }
    Write-Text $mark "imported $n decisions from DECISIONS.md at $(Now-Iso)`n"
    $script:MemMigrated = $true
  }
  if ($script:MemMigrated) { $script:MemMigrated = $false; Mem-Files $dir }
}
# Regenerates DECISIONS.md (for humans) and memory.json (UI) after a memory change.
function Mem-Files([string]$dir) {
  $slug = Slug-Of $dir
  $rows = Db "SELECT $MemCols FROM memories WHERE project = ?1 AND kind = 'decision' AND superseded_by IS NULL ORDER BY id" @($slug)
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append("# Decisions`n`nImportant decisions of this project, newest last. Generated from the team memory (hp decide, hp remember --kind decision); edits here are lost.`n`n")
  foreach ($r in $rows) {
    $m = Mem-Object $r
    $bd = (([string]$m.body) -replace '\s+', ' ').Trim()
    $text = if (-not $bd) { $m.title } elseif ($bd.StartsWith([string]$m.title)) { $bd } else { "$($m.title) -- $bd" }
    [void]$sb.Append("- $(([datetime]$m.ts).ToLocalTime().ToString('yyyy-MM-dd HH:mm')) **$($m.author)**$(if ($m.task) { " (#$($m.task))" }): $text <!-- m$($m.id) -->`n")
  }
  # Only overwrite a DECISIONS.md that is ours (generated) or when there is something to write.
  $dp = Join-Path $dir 'DECISIONS.md'
  if ($rows.Count -or ((Read-Text $dp) -match 'Generated from the team memory')) { Write-Text $dp $sb.ToString() }
  $c = [ordered]@{ decision = 0; gotcha = 0; pattern = 0; note = 0 }
  $cr = Db "SELECT kind, COUNT(*) FROM memories WHERE (project = ?1 OR scope = 'global') AND superseded_by IS NULL GROUP BY kind" @($slug)
  foreach ($r in $cr) { $c[[string]$r[0]] = [int]$r[1] }
  $rr = Db "SELECT $MemCols FROM memories WHERE (project = ?1 OR scope = 'global') AND superseded_by IS NULL AND kind <> 'note' ORDER BY id DESC LIMIT 6" @($slug)
  $recent = @($rr | ForEach-Object { $m = Mem-Object $_; [ordered]@{ id = $m.id; kind = $m.kind; scope = $m.scope; title = $m.title; author = $m.author; ts = $m.ts } })
  Write-Json (Join-Path $dir 'memory.json') ([ordered]@{ updated = (Now-Iso); counts = $c; recent = $recent })
}

# ---------------------------------------------------------------- risk levels and approvals
# Per agent (agents.json "risk"): careful | balanced (default) | autonomous. hp enforces it for git
# pushes/merges to protected branches, force pushes and tags (hp git), and for destructive commands on
# machines (hp ssh / hp sudo). A refused step can be approved by the human: the agent re-runs it with
# --ask "<why>" (or hp ask --cmd), ty approves in the Mailbox (hp approve <id>), the agent runs it once
# with --approved <id> (same command: SHA-256 of the normalized text must match; one use).
$RiskLevels = @('careful', 'balanced', 'autonomous')
function Risk-Of([string]$dir, [string]$me) {
  if (-not $me -or $me -eq 'ty' -or -not $dir) { return 'human' }
  $a = Find-Agent $dir $me
  if ($a -and $a.PSObject.Properties['risk'] -and $RiskLevels -contains [string]$a.risk) { return [string]$a.risk }
  return 'balanced'
}
$Destructive = @(
  '\brm\s+(-{1,2}[\w-]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-{1,2}[\w-]+\s+)*["'']?(/|~|\*|\$)',
  '\bsystemctl\b[^;&|\n]*\b(stop|restart|disable|mask|kill|isolate)\b', '\bservice\s+\S+\s+(stop|restart)\b',
  '\b(reboot|shutdown|poweroff|halt)\b', '\binit\s+[06]\b',
  '\bdrop\s+(database|table|schema)\b', '\btruncate\s+table\b', '\bdropdb\b',
  '\bkubectl\b[^;&|\n]*\b(delete|apply|scale|drain|replace|patch|rollout\s+restart)\b', '\bhelm\s+(uninstall|delete|upgrade|rollback)\b',
  '\bdocker\b[^;&|\n]*\b(rm\s+(-\S*f|--force)|rmi\s+(-\S*f|--force)|system\s+prune|volume\s+(rm|prune))', '\b(docker-compose|docker\s+compose)\b[^;&|\n]*\bdown\b',
  '\bterraform\s+(apply|destroy)\b', '\bpulumi\s+(up|destroy)\b',
  '\bmigrat(e|ion|ions)\b', '\balembic\s+(upgrade|downgrade)\b', '\b(flyway|liquibase)\b',
  '\bmkfs\b', '\bdd\s+[^;\n]*\bof=/dev/', '\b(fdisk|parted|wipefs)\b'
)
function Risky-Command([string]$s) { foreach ($re in $Destructive) { if ($s -match "(?i)$re") { return $Matches[0].Trim() } }; return $null }
# Why a git call is protected (push/merge to main/master or project.json "protected_branches", force push,
# tags, remote deletes), or $null. $remote: runs on a machine (the current branch is unknown there).
function Git-Protected([string[]]$ga, [string]$dir, [bool]$remote) {
  $prot = @('main', 'master')
  if ($dir) { $p = Load-Project $dir; if ($p.PSObject.Properties['protected_branches']) { $prot += @(Arr $p.protected_branches | ForEach-Object { [string]$_ }) } }
  $i = 0; $cwd = $null
  while ($i -lt $ga.Count -and ([string]$ga[$i]).StartsWith('-')) { if ($ga[$i] -eq '-C' -and $i + 1 -lt $ga.Count) { $cwd = $ga[$i + 1]; $i += 2 } elseif ($ga[$i] -eq '-c') { $i += 2 } else { $i++ } }
  if ($i -ge $ga.Count) { return $null }
  $sub = [string]$ga[$i]; $rest = @($ga | Select-Object -Skip ($i + 1))
  $cur = {
    if ($remote) { return '' }
    $ca = @('rev-parse', '--abbrev-ref', 'HEAD'); if ($cwd) { $ca = @('-C', $cwd) + $ca }
    $b = & git.exe @ca 2>$null
    if ($LASTEXITCODE -eq 0) { return ([string]$b).Trim() }; return ''
  }
  if ($sub -eq 'push') {
    foreach ($x in $rest) {
      if ($x -match '^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror)$') { return "force push ($x)" }
      if ($x -match '^(--tags|--follow-tags)$') { return "pushing tags ($x)" }
      if ($x -match '^(-d|--delete|--prune)$') { return "deleting remote refs ($x)" }
    }
    $specs = @($rest | Where-Object { -not ([string]$_).StartsWith('-') } | Select-Object -Skip 1)
    foreach ($sp in $specs) {
      if ($sp.StartsWith('+')) { return "force push ($sp)" }
      if ($sp.StartsWith(':')) { return "deleting a remote branch ($sp)" }
      $dst = if ($sp.Contains(':')) { $sp.Split(':')[-1] } else { $sp }
      if ($dst -like 'refs/tags/*') { return "pushing a tag ($sp)" }
      $dst = $dst -replace '^refs/heads/', ''
      if ($dst -eq 'HEAD') { $dst = & $cur }
      if ($dst -and $prot -contains $dst) { return "push to the protected branch $dst" }
    }
    if (-not $specs.Count) { $b = & $cur; if ($b -and $prot -contains $b) { return "push of the current branch $b (protected)" } }
    return $null
  }
  if ($sub -eq 'merge') { $b = & $cur; if ($b -and $prot -contains $b) { return "merge into the protected branch $b" } }
  return $null
}
function Cmd-Norm([string]$s) { return (([string]$s) -replace '\s+', ' ').Trim() }
function Cmd-Hash([string]$s) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash($Utf8.GetBytes((Cmd-Norm $s))) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
}
function Approval-Get([string]$id) {
  $r = Db 'SELECT id, project, agent, what, cmd, cmd_hash, status, ts, task, decided_by, decided_ts, note, used_ts FROM approvals WHERE id = ?1' @($id.TrimStart('#'))
  if (-not $r.Count) { return $null }
  $x = $r[0]
  return [pscustomobject][ordered]@{ id = [int64]$x[0]; project = $x[1]; agent = $x[2]; what = $x[3]; cmd = $x[4]; cmd_hash = $x[5]; status = $x[6]; ts = $x[7]; task = $x[8]; decided_by = $x[9]; decided_ts = $x[10]; note = $x[11]; used_ts = $x[12] }
}
# New request to the human: an event of type "approval" to ty (Mailbox shows Approve / Reject).
function Approval-New([string]$dir, [string]$me, [string]$what, [string]$canon) {
  $c = Cmd-Norm $canon
  $h = if ($c) { Cmd-Hash $c } else { '' }
  $tk = ([string](O 'task' '')).TrimStart('#'); if (-not $tk) { $tk = $null }
  $id = [int64](Db "INSERT INTO approvals (project, agent, what, cmd, cmd_hash, status, ts, task) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)" @((Slug-Of $dir), $me, (Clip-Text $what 500), (Clip-Text $c 2000), $h, (Now-Iso), $tk))[0][0]
  $cs = if ($c.Length -gt 300) { $c.Substring(0, 300) + '...' } else { $c }
  Emit $dir 'approval' $me 'ty' "Approval #${id}: $what$(if ($c) { ' | command: ' + $cs })" $tk
  return $id
}
# Called before a risky step. Returns when it may run; otherwise prints how to get an approval and exits.
function Risk-Gate([string]$dir, [string]$me, [string]$canon, [string]$why, [bool]$needs) {
  $level = Risk-Of $dir $me
  if ($level -eq 'human') { return }
  $c = Cmd-Norm $canon
  $cs = if ($c.Length -gt 200) { $c.Substring(0, 200) + '...' } else { $c }
  $apId = ([string](O 'approved' '')).TrimStart('#')
  if ($apId) {
    $a = Approval-Get $apId
    if (-not $a) { Fail "No approval #$apId." }
    if ($a.project -ne (Slug-Of $dir) -or $a.agent -ne $me) { Fail "Approval #$apId belongs to $($a.agent) in project $($a.project)." }
    if ($a.status -eq 'pending') { Fail "Approval #$apId is still pending. Wait with: hp wait-approval $apId --as $me" }
    if ($a.status -eq 'rejected') { Fail "Approval #$apId was rejected$(if ($a.note) { ': ' + $a.note }). Do not run it." }
    if ($a.status -eq 'used') { Fail "Approval #$apId was already used (one approval = one run). Ask again." }
    if ($a.cmd_hash -ne (Cmd-Hash $c)) { Fail "Approval #$apId was given for another command: $($a.cmd)" }
    if (O 'dry') { Write-Output "[dry] approval #$apId matches; it is not used by a dry run."; return }
    [void](Db "UPDATE approvals SET status = 'used', used_ts = ?2 WHERE id = ?1 AND status = 'approved'" @($apId, (Now-Iso)))
    Emit $dir 'tool' $me 'all' "[risk] used approval #$apId ($why): $cs" (O 'task')
    return
  }
  if (-not $needs) {
    if (-not (O 'dry')) { Emit $dir 'tool' $me 'all' "[risk] $level agent, done alone ($why): $cs" (O 'task') }
    return
  }
  $ask = [string](O 'ask' '')
  if ($ask) {
    $id = Approval-New $dir $me $ask $c
    Write-Output "Approval #$id requested from ty ($why). Next: hp wait-approval $id --as $me, then re-run the same command with --approved $id (instead of --ask)."
    exit 3
  }
  $rule = @{ careful = 'careful agents ask before every risky step'; balanced = 'balanced agents ask before protected git and before destructive commands on production machines' }[$level]
  [Console]::Error.WriteLine("hp: refused: $why. Your risk level is $level ($rule).")
  [Console]::Error.WriteLine("  Ask ty: re-run the same command with --ask `"<what and why>`"  (or: hp ask `"<what and why>`" --as $me --cmd `"$($c -replace '"', '\"')`")")
  [Console]::Error.WriteLine("  Then: hp wait-approval <id> --as $me, and re-run the same command with --approved <id>.")
  if ($canon -like 'git *') { [Console]::Error.WriteLine('  Usually better: push a branch and open a merge/pull request (hp task link <task> <url> --kind mr|pr).') }
  exit 1
}

# Cross-model review: a task that goes to review gets "Review #<id>: <title>" (high priority, no dependencies)
# for an agent on the other engine (claude <-> codex) that does not own it, unless an open one exists.
function Cross-Review([string]$dir, [string]$id, [string]$me) {
  $t0 = Tasks-Load $dir
  $orig = $t0.tasks | Where-Object { [string]$_.id -eq $id } | Select-Object -First 1
  if (-not $orig -or ([string]$orig.title) -match '^Review #\d+' -or $orig.PSObject.Properties['review_of']) { return }
  $ownerA = Find-Agent $dir ([string]$orig.agent)
  $app = if ($ownerA -and $ownerA.app) { [string]$ownerA.app } else { 'claude' }
  $cands = @(Agents-Load $dir | Where-Object { $_.name -ne $orig.agent -and $(if ($_.app) { [string]$_.app } else { 'claude' }) -ne $app })
  if (-not $cands.Count) { return }
  $pref = @($cands | Where-Object { "$($_.name) $($_.role)" -match '(?i)review|qa|test' })
  $rev = if ($pref.Count) { $pref[0] } else { $cands[0] }
  $rtitle = "Review #${id}: $($orig.title)"
  $ev = if ($orig.PSObject.Properties['evidence'] -and $orig.evidence) { [string]$orig.evidence } else { '(none given)' }
  $new = Tasks-Change $dir {
    param($t)
    if (@($t.tasks | Where-Object { $_.status -ne 'done' -and (([string]$_.review_of) -eq $id -or ([string]$_.title).StartsWith("Review #${id}:")) }).Count) { return $null }
    $nid = [int]$t.next; $t.next = $nid + 1
    $y = [pscustomobject][ordered]@{ id = $nid; title = $rtitle; desc = "Cross-model review: $($rev.app) checks $app work of $($orig.agent) on #$id. Verify it independently (run the tests yourself), then hp task done $nid --evidence `"...`" or send findings to $($orig.agent). Owner's evidence: $ev"
      agent = $rev.name; status = 'todo'; priority = 'high'; progress = 0; machine = [string]$orig.machine; by = 'hp'; created = (Now-Iso); started = $null; completed = $null; updated = (Now-Iso)
      blocked_reason = ''; notes = @(); history = @(); after = @(); review_of = [int]$id }
    Task-History $y $me "created for $($rev.name) (cross-model review of #$id)"
    $t.tasks = @($t.tasks) + @($y)
    $nid
  }
  if ($new) { Emit $dir 'task' 'hp' $rev.name "New task #${new}: $rtitle (cross-model review)" $new; Write-Output "review task #$new for $($rev.name)" }
}

# ---------------------------------------------------------------- agent instructions
# The contract part of AGENTS.md: operating reality, sacred boundaries (per risk level of the agents in this
# project), named principles, drift counter-spells, working loop, git hygiene and memory verb bridges.
$RiskBoundary = @{
  careful = @'
- Alone: read and search anything; edit, build and test in the project; commit to your own branch and push it; open merge/pull requests; read-only commands on machines (status, logs, ls, cat, health checks).
- Ask ty first (hp refuses without an approval): any push or merge to main/master/protected branches, force pushes, tags, remote branch deletes; destructive commands on **any** machine (rm -rf on absolute paths, systemctl stop/restart, reboot/shutdown, DROP DATABASE/TABLE, kubectl delete/apply/scale, helm upgrade, docker rm -f / compose down, terraform apply/destroy, migrations, mkfs/dd).
- Also ask (hp cannot see these; you must): deleting data or files outside your own work, CI/CD or infrastructure config changes, credential rotation, anything that leaves the company (emails, public posts, uploads).
'@
  balanced = @'
- Alone: everything a careful agent may do, plus destructive commands on non-production machines (lock the machine first with `hp lock`).
- Ask ty first (hp refuses without an approval): pushes or merges to main/master/protected branches, force pushes, tags, remote branch deletes; destructive commands on production machines (__PROD__).
- Also ask: deleting shared data, CI/CD config changes, credential rotation, anything that leaves the company.
'@
  autonomous = @'
- Alone: everything above, plus merging to main, tags, deploys and destructive commands on production machines. hp records each such step in the team log (`[risk]` entries).
- Still required: lock the machine, keep a rollback path, verify after the change (health check, tests) and report it with evidence (`hp say --to ty`).
- Ask anyway: anything irreversible to data (dropping databases, deleting backups) and anything that leaves the company.
'@
}
# The human's name for agents' messages (~/.herdr/profile.json: { name, forms, gen, dat }); hp's id stays "ty".
function Human-Names {
  $pr = Read-Json (Join-Path $HerdrHome 'profile.json') $null
  $n = if ($pr -and $pr.name) { [string]$pr.name } else { 'the human' }
  return @{ name = $n; forms = $(if ($pr -and $pr.forms) { [string]$pr.forms } else { $n }); gen = $(if ($pr -and $pr.gen) { [string]$pr.gen } else { $n }); dat = $(if ($pr -and $pr.dat) { [string]$pr.dat } else { $n }) }
}
function Contract-Text([string]$dir, $p, $allMachines) {
  $agents = @(Agents-Load $dir)
  $rk = { param($a) if ($a.PSObject.Properties['risk'] -and $RiskLevels -contains [string]$a.risk) { [string]$a.risk } else { 'balanced' } }
  $team = @($agents | ForEach-Object { "- ``$($_.name)`` ($(if ($_.app -eq 'codex') { 'Codex' } else { 'Claude Code' })$(if ($_.role) { ', ' + $_.role })): risk level **$(& $rk $_)**" }) -join "`n"
  if (-not $team) { $team = '- (no agents yet)' }
  $prod = @($allMachines | Where-Object { (Has $p.machines $_.name) -and $_.PSObject.Properties['prod'] -and $_.prod } | ForEach-Object { "``$($_.name)``" })
  $prodTxt = if ($prod.Count) { $prod -join ', ' } else { 'none marked yet; ty marks them with hp vm set <machine> --prod on' }
  $levels = @($agents | ForEach-Object { & $rk $_ } | Select-Object -Unique); if (-not $levels.Count) { $levels = @('balanced') }
  $bl = @()
  foreach ($lv in $RiskLevels) {
    if ($levels -notcontains $lv) { continue }
    $names = @($agents | Where-Object { (& $rk $_) -eq $lv } | ForEach-Object { $_.name }) -join ', '
    $label = @{ careful = 'Careful - asks before risky steps'; balanced = 'Balanced'; autonomous = 'Autonomous - deploys and merges on its own' }[$lv]
    $bl += "### $label$(if ($names) { ': ' + $names })`n`n" + $RiskBoundary[$lv].Replace('__PROD__', $prodTxt).Replace("`r`n", "`n")
  }
  $t = @'
## Operating reality

- Several agents work in parallel in this project folder, on the same repositories and the same machines. Files can change under you; machines are shared with other projects, and some are production (__PROD__).
- The human is __HUMAN__; in hp commands he is `ty` (`--to ty`). In anything you write (messages, questions, notes, reports) call him __HUMAN__, never "ty", with the right Polish form: __FORMS__ (e.g. "czekam na decyzję __HUMAN_GEN__", "wyślę __HUMAN_DAT__ podsumowanie").
- ty steers priorities, approves risky steps in the Mailbox and sees every `hp say`, `hp log` and task change live. Inside your boundaries you do not wait for permission.
- You can be restarted at any time and lose your context. The truth lives in tasks, team memory (`hp recall`) and handoff notes, not in your head.
- The team:

__TEAM__

## Sacred boundaries

Your level is next to your name above. hp enforces what it can (`hp git`, `hp ssh`, `hp sudo`); the rest is on you.

__BOUNDARIES__

At every level:

1. Never print, paste or commit secret values (use `hp git`, `hp api`, `hp run`).
2. Never restore, revert, stash, overwrite or delete another agent's work (see Git hygiene).
3. Never approve your own request: `hp approve` / `hp reject` belong to ty.
4. Never edit AGENTS.md, CLAUDE.md or DECISIONS.md by hand (they are generated).
5. Lock a shared machine before a deploy, restart or migration (`hp lock`).

Asking: re-run the refused command with `--ask "<what and why>"` (or `hp ask "<what and why>" --as <you> [--cmd "<command>"] [--task <id>]`), then `hp wait-approval <id> --as <you>`. When approved, run exactly the same command again with `--approved <id>` (one approval = one run). Rejected: do not do it; propose an alternative to ty.

## Named principles

**Truthful Reporting: evidence, not assertion.** "Done", "fixed" and "works" come with proof you really checked. Two places, two readers:
- `--evidence` is for __HUMAN__: in Polish, plain words, 2-5 short sentences: what you did, how you checked it, what came out and your conclusion ("Sprawdziłem logowanie na TEST trzema kontami. Wszystkie role działają, eksport CSV też. Wniosek: GUI jest gotowe do odbioru."). No links, no commit hashes, no commands, no file paths, no jargon.
- The technical proof (commands, their output, MR or commit links, log lines) goes to the task note (`hp task note <id> "..."`), for the team.
If you did not check it, say so plainly ("nie sprawdzone"). Report failures and partial results plainly.

**Spellbound Focus.** One task at a time: the one you started. Finish it or block it explicitly before switching. Side discoveries become `hp task add` or `hp remember`, not detours.

**Diagnostic Resilience.** When something fails, read the actual error, form a hypothesis and test it; do not retry blindly. Search the memory first (`hp search "<error words>"`). After two failed attempts with the same approach, change the approach or ask a teammate. Record the root cause as a gotcha.

**Scale, Don't Nerf.** When a problem is hard, add rigor (tests, bisecting, a smaller step, a teammate), never weaken the goal: no skipping or deleting failing tests, no disabled checks, no mocking away the real thing, no hard-coded expected output, no silently narrowed requirements. If the goal itself must change, ask ty.

## Drift counter-spells

- You do not get tired and there is no end of the day. No "let's wrap up", "good stopping point", "for now" or "I'll leave the rest" while work remains and you are not blocked.
- No tiredness or apology loops; no AI filler ("Great question", "I hope this helps", "Certainly!", "delve", "seamless", "robust") and no emoji in messages, commits or docs.
- No premature victory: no "done" without evidence. No silent scope creep: new problems become tasks.
- Long session: re-read your task (`hp task show <id>`) and `hp recall` before the next step.

## Working with __HUMAN__ (hp id: ty): when to decide, when to ask, how to write

ty is one person who reads the Mailbox between other work. Ask when it really is ty's call, not out of caution, and never guess on things that are.

Decide yourself (no question) when the answer follows from what is already there:
- technical how-to: which command, tool, file layout, test or check to use, how to diagnose or fix something within your task;
- the existing setup, the project docs, a team decision in memory (`hp recall`), or what this project already does elsewhere;
- read-only work (inspecting, measuring, inventories) and reversible changes on TEST or lab machines that stay inside your task.
Write such choices down when they matter later (`hp remember "<decision>" "<why>" --kind decision --as <you> --task <id>`) and mention them in your summary.

Ask ty (do not guess, do not pick a value for ty) when it is a business or ownership decision, or risky:
- requirements and policy: required times and limits (how fast to recover, how long to keep data, alert thresholds), who receives alerts or e-mails, which accounts or data may be used for tests, what counts as "accepted";
- production (__PROD__), deleting or overwriting data, anything that leaves the company (real e-mails, external services, costs), new access or credentials, security exceptions.

Do not invent requirements: follow the task, the docs and __HUMAN__'s words. Nothing like "only synthetic data" or "needs formal sign-off" unless someone asked for it. When __HUMAN__ says you decide ("zdecyduj sam", "w ustalonym przez ciebie czasie"), decide, write it down and go on. Internal addresses and services of the company (its own domain mailboxes, its own servers) are not "leaving the company". One approval covers the whole agreed plan: do not ask twice for the same thing.

Missing credential, account, token, password or access: do not work around it. No borrowing someone else's session, account or logged-in browser, no looking at __HUMAN__'s screen, no asking for a secret value in the chat. Ask __HUMAN__ once, plainly, what to add and for what, e.g. "Dodaj w Tokens & Access token GitLab (uprawnienia: api, read_repository) o nazwie avds-gitlab i udostępnij go projektowi Allegro VDS TEST (albo tylko mnie)." or "Załóż w aplikacji konto testowe z rolą client_admin i zapisz jego login i hasło w Tokens & Access jako avds-test-client-admin.". __HUMAN__ adds it in Tokens & Access and shares it with the project or with you; then use it only through hp (`hp secret list --as <you>`, `hp git`, `hp api`, `hp run --with`). Until then, do everything else.

Before asking __HUMAN__ about one environment (e.g. PROD), check how the other one (TEST) already does it and what was decided there (`hp recall`, the TEST project's notes): copy that unless something really differs. One round of questions = one message: collect them first, do not send several messages in a row. A task __HUMAN__ paused or deprioritized goes back to the backlog (`hp task backlog <id>`), not to Blocked.

While waiting for ty, keep working on everything that does not depend on the answer (other parts of the task, other tasks from `hp ready`). Block a task only when nothing useful is left in it. A task blocked because it waits for __HUMAN__ is blocked with `--wait marcel` and a reason that says what he must give (`hp task block <id> --as <you> --wait marcel --reason "Czeka na __HUMAN__a: sudo na srv-..."`): only those reach his Mailbox. A task waiting for a teammate, a review or another task is blocked without it ("waiting for #44") and stays on the team's board.

Questions go through the lead: other agents send theirs to the lead (`hp say --to <lead> ...`); the lead removes duplicates and what the team can answer itself, and sends ty one message with at most 3 numbered questions (not several messages in a row).

Between agents and in task notes, plain words with normal spaces (no glued words or IDs like "zgodnie zm2791"), in Polish, short and useful: hand off work, ask, or report something the other needs. No thanks, no acks of acks, no repeating what is already in the task note. Overlapping tasks: the lead decides who does what at once, in one message, and fixes the task titles. A question may suggest an answer ("polecam 1"), but for ty's decisions never act on silence: wait for the answer.

How to write to __HUMAN__ (messages, questions, approvals, reports):

- In ty's language (Polish), in plain everyday words. Short sentences, a space after every comma and period.
- No internal jargon and no abbreviations without explanation: write "czas przywracania po awarii (RTO)", not "RTO". No table names, IDs or file paths unless ty needs them to answer.
- Start with the point in one sentence: what you need, or what happened. Then at most 3 short bullet points.
- A question ends with choices ty can answer in one word ("Odpowiedz 1 albo 2."), your recommendation marked.
- Anything that needs __HUMAN__ to answer or to do something (a decision, adding access or a credential, logging in, attaching machines) is a question: it contains a question mark or "Odpowiedz" ("Czy możesz dodać ...?"). That is what puts it in his Mailbox. Status, reports and "noted" messages have neither: they stay in the chat.
- About 6 lines at most. Details go to the task note, not to ty.

Bad: "Czekam na ty w Mailbox #15: potwierdzenie zakresu epiku z rozbieznym opisem, SLA/RPO/RTO, HA/PITR, scenariusz NAS i zasoby izolowanej proby."
Good: "Potrzebuję decyzji, jak szybko system TEST ma wracać po awarii. 1) Do 4 godzin, dane z ostatniej doby (polecam). 2) Do 1 godziny, potrzebny drugi serwer. Odpowiedz 1 albo 2."

## Working loop

States: **Oriented** (`hp recall "<goal>"`, `hp inbox`, `git status`) -> **Selected** (one task: `hp ready`, then `hp task claim <id>`; `hp reserve` the files you will edit) -> **Executed** (small atomic steps) -> **Verified** (tests or checks run, output read) -> **Synthesized** (`hp task review|done --evidence`, `hp say` to whom it concerns) -> **Remembered** (`hp remember` gotchas/patterns, `hp reflect` before a pause).

0. Idle (no task In Progress): `hp ready --as <you>` -> `hp task claim <id> --as <you>`. Nothing ready: `hp wait --as <you> --timeout 600`, then `hp ready` again. Never invent work outside the board.
1. Quick fix: Oriented -> Selected -> Executed -> Verified -> Synthesized.
2. Feature: the whole loop; review by an agent on the other engine (hp creates the review task) before done.
3. Investigation or incident: Oriented -> Executed (diagnose, read-only) -> Verified (root cause reproduced) -> Remembered (gotcha) -> Synthesized (report to ty). Fixing production follows your boundaries.

## Git hygiene (several agents, one repository)

1. `git status` first: before you edit and before you commit.
2. Commit only your own files: `git add <paths>`; never `git add -A` / `git add .` in a shared tree.
3. Never `git checkout -- <file>`, `git restore`, `git stash`, `git clean` or `git reset --hard` on files you did not change: that is another agent's work in progress. Ask them.
4. Atomic commits: one logical change each, building and passing tests.
5. Conventional commits: `feat(scope): ...`, `fix: ...`, `refactor: ...`, `test: ...`, `docs: ...`, `chore: ...`.
6. Rebase or pull before pushing your branch; resolve conflicts only in your own files.
7. Link every pushed commit and MR/PR to the task (`hp task link`).

## Team memory

Shared across agents and sessions (decisions, gotchas, patterns, session notes; `--global` = all projects).

| When you think... | Run |
|---|---|
| "where did I leave off?" / starting / after a restart | `hp recall "<task or goal>" --as <you>` |
| "have we hit this before?" / before debugging | `hp search "<error or topic words>"` |
| "remember this" / you found a trap | `hp remember "<title>" "<body>" --kind gotcha --as <you> [--task <id>] [--tags a,b]` |
| "this is how we do X here" | `hp remember "<title>" "<body>" --kind pattern --as <you>` |
| "we decided..." | `hp decide "<decision>" --as <you> [--task <id>]` (also in DECISIONS.md) |
| before a pause / end of a session | `hp reflect "<done, next, open questions>" --as <you>` |
| a memory is wrong or outdated | `hp remember ... --supersedes <id>` or `hp forget <id> --as <you>` |

Capture bar: write it down if a teammate starting fresh would lose 10+ minutes without it.
Good: `hp remember "npm ci fails with EACCES on api-01" "The npm cache is owned by deploy; run: hp ssh api-01 'sudo -u deploy npm ci'" --kind gotcha`.
Bad: "Fixed the build", "Worked on tests today", or anything the code or commit message already says.
'@
  $hm = Human-Names
  return $t.Replace("`r`n", "`n").Replace('__HUMAN__', $hm.name).Replace('__FORMS__', $hm.forms).Replace('__HUMAN_GEN__', $hm.gen).Replace('__HUMAN_DAT__', $hm.dat).Replace('__TEAM__', $team).Replace('__BOUNDARIES__', ($bl -join "`n`n")).Replace('__PROD__', $prodTxt)
}
function Write-AgentDocs([string]$dir) {
  $p = Load-Project $dir
  $slug = Slug-Of $dir
  $all = Machines-Load
  $lines = @()
  foreach ($n in $p.machines) {
    $m = $all | Where-Object { $_.name -eq $n } | Select-Object -First 1
    if ($m) { $lines += "- ``$($m.name)`` - $($m.host)$(if ($m.os) { ', ' + $m.os })$(if ($m.desc) { ': ' + $m.desc })$(if ($m.PSObject.Properties['prod'] -and $m.prod) { ' **(PRODUCTION)**' })" }
  }
  $machines = if ($lines.Count) { $lines -join "`n" } else { '- (none yet; see `hp vm list`)' }
  $contract = Contract-Text $dir $p $all
  $sl = @()
  foreach ($s in (Secrets-Load)) {
    if (-not (Has $s.projects $slug)) { continue }
    $who = if (@(Arr $s.agents).Count) { " (only: $(@($s.agents) -join ', '))" } else { '' }
    $hs = Secret-Host $s; $left = Days-Left $s
    $exp = if ($null -eq $left) { '' } elseif ($left -lt 0) { ', EXPIRED' } else { ", expires $(Exp-Str $s.expires)" }
    $sl += "- ``$($s.name)`` - $(Type-Label $s)$(if ($hs) { ', ' + $hs })$exp$who$(if ($s.desc) { ': ' + $s.desc })"
  }
  $secrets = if ($sl.Count) { $sl -join "`n" } else { '- (none; see `hp secret list`)' }
  $hp = Join-Path $BinDir 'hp.cmd'
  $leadName = Lead-Of $dir
  $md = @"
# Project: $($p.name)

<!-- This file is generated by hp (hyper-view layout) on every project change. Manual edits will be lost. -->

$($p.desc)

You work in a team of agents on project **$($p.name)** (id: ``$slug``). Every agent has a name
(you get yours in the first message) and passes it to every ``hp`` command as ``--as <your-name>``, written ``<you>`` below.
The ``hp`` command is on PATH (if not: ``$hp``). Inside this folder ``-p`` is not needed.
This file is your contract: the boundaries and principles below come first, the operational reference after them.

$contract

## Project machines

$machines

- ``hp vm list`` - project machines and your permissions.
- ``hp ssh <machine> --as <you> "<command>"`` - run a bash command on the machine (SSH key, no password).
- ``hp sudo <machine> --as <you> "<command>"`` - same, as root. Works only on machines where the human granted you sudo (``hp vm list --as <you>`` shows it). hp supplies the password; you never see it.
- Longer script: ``hp ssh <machine> --as <you> --file script.sh``.
- Machines are shared with other projects. Before a deploy, restart or migration: ``hp lock <machine> "what you do" --as <you> [--ttl 30]`` (minutes); if it fails, someone else holds it: wait or talk to them. Afterwards: ``hp unlock <machine> --as <you>``. ``hp locks`` lists all locks.

$(Sources-Doc $p)

## Secrets (tokens, keys, passwords)

$secrets

- ``hp secret list --as <you>`` - available secrets (type, host, expiry; never values).
- ``hp git <secret> --as <you> <git arguments...>`` - git with the right auth for that token type (GitLab, GitHub, Bitbucket, Azure DevOps; SSH deploy keys too). The token never ends up in the URL or history.
- ``hp git <secret> --as <you> --on <machine> <git arguments...>`` - git with the token, run on the machine (HTTPS tokens only).
- ``hp api <secret> --as <you> <GET|POST|PUT|DELETE> <url> [--data '{json}']`` - HTTP API with the right header (GitLab, GitHub, Bitbucket, API keys).
- ``hp run --with <secret>[,<secret>] --as <you> -- <command> [args...]`` - run one command with the secret as environment variables (docker, npm, twine, aws, az, gcloud, kubectl, psql, ...). ``hp secret vars <secret> --as <you>`` lists the variable names.
- Never print secret values (no ``echo $VAR``, ``env``, ``printenv``, ``set``), and never paste them into chat, tasks, files or commits. If a secret is expired, tell the human.

## Talking to the team

Everything you send with ``hp say`` is visible live to the human in the chat panel.

- ``hp say --as <you> "message"`` - to the whole team (a team message; ``@agent`` in the text mentions an agent).
- ``hp say --as <you> --to <agent> [--task <id>] "message"`` - to a single agent (``--to ty`` = to the human).
- A message with several lines (a list, points) or with Polish letters: write it to a UTF-8 file (``[IO.File]::WriteAllText("<path>", "<text>", [Text.UTF8Encoding]::new(`$false))``) and send ``hp say --as <you> --to <who> --file <path>``. Do not pipe text into hp: Windows PowerShell turns Polish letters into "?". On Windows a line break inside the quoted text cuts the message after the first line.
- ``hp inbox --as <you>`` - new messages for you (``[team]``, ``[team, @you]`` or ``[direct]``). Check after every major step.
- ``hp wait --as <you> --timeout 600`` - wait for a message when you have nothing to do.
- ``hp log --as <you> [--task <id>] "what I did"`` - history entry (e.g. an important command, a deploy result).
- ``hp agent list`` - the team: live status, open tasks, roles and machines.

## Team messages (one answer, not one per agent)

The team lead is **$(if ($leadName) { $leadName } else { '(no agents yet)' })** (``hp agent lead``). When the human writes to the whole team:

1. Only the lead answers, for the whole team (``hp say --to ty``). The lead splits the work into tasks (``hp task add --for <agent>``) or asks a specific agent with an ``@agent`` mention.
2. Everyone else does NOT reply to team messages. Read them, then act silently: pick up your tasks, adjust what you are doing.
3. Exceptions: reply (briefly, ``--to <sender>``) when you are ``@mentioned`` or the message is clearly about your current task.
4. A direct message (``--to <you>``) is always yours to answer.
5. Team messages between agents are FYI: answer only if someone asks you something.

## Collaboration protocol

1. **Pick work from the board, not from chat.** ``hp ready --as <you>`` lists unblocked To Do tasks (yours and unassigned ``team`` ones), best first. ``hp task claim <id> --as <you>`` takes one atomically (owner, In Progress, a 2 h lease that ``hp task progress`` renews). If it fails, someone else has it: take the next one.
2. **Found more work? File it, do not detour.** ``hp task add --as <you> --for <you|agent|team|auto> --discovered-from <current id> "title"``. ``--for team`` leaves it for whoever is free; ``--for auto`` picks the best agent card (``hp route "<title>"`` shows why). Tasks for another agent go to its board; tell it only if urgent.
3. **Reserve before you edit shared files.** ``hp reserve "src/auth/**" --as <you> --task <id> [--exclusive] [--ttl 60]`` (paths relative to the repository root). A conflict means another agent is editing there: coordinate with ``hp say --to <agent> --task <id>`` or pick other work. Before committing: ``hp reservations --check <files> --as <you>``. Reservations of a task end at review/done; ``hp release --as <you>`` frees the rest.
4. **One thread per task.** Messages about a task use ``--task <id>`` (that is its thread); other topics ``--thread <name>``. Answer with ``hp say --reply m<id> --as <you> "..."`` (same thread, to the sender). ``hp thread <id>`` shows the whole conversation.
5. **Ask for an acknowledgment when it matters** (handoffs, contract changes, "stop touching X"): ``hp say --to <agent> --ack ...``. Receiving one: ``hp ack m<id> --as <you>`` first, then act. ``hp sent --as <you>`` shows who has seen and acked your messages.
6. **Hand off explicitly.** Cannot finish (wrong skills, out of limits, blocked on your side)? ``hp task handoff <id> --to <agent|team> --as <you> --note "state, next step, traps"``. The receiver is told (ack requested), your claim and reservations of the task end. Giving it back unassigned: ``hp task release <id> --as <you> --pool --note "..."``.
7. **Keep your card true.** ``hp agent card <you> --skills a,b,c --desc "what I am good at"`` - the lead and ``--for auto`` route tasks by it. ``hp agent card`` lists everyone's.
8. The supervisor nudges idle agents when ``hp ready`` has work for them, asks agents that look stuck (working, no output change for a long time) and tells ty if it continues; it returns expired claims of stopped agents to the board.

## Tasks

Statuses: backlog, todo, doing, review, blocked, done. Priorities: low, normal, high, urgent.

- ``hp task list [--for <agent>]`` / ``hp task show <id>`` - list / details with history.
- ``hp task add --as <you> --for <agent> [--priority high] [--machine <m>] [--status backlog] [--after 2,3] "title"`` (``--after``: starts only when #2 and #3 are done).
- ``hp task depends <id> <ids...> --as <you>`` / ``--clear`` - set dependencies. When the last one is done, the owner is told; a task blocked with reason "waiting for #N" goes back to To Do by itself.
- ``hp ready --as <you>`` - what you can start now; ``hp task claim <id> --as <you>`` - take it (atomic, with a lease); ``hp task start <id> --as <you>`` - start your own task.
- ``hp task handoff <id> --to <agent> --as <you> --note "..."`` / ``hp task release <id> --as <you> [--pool]`` - pass it on / give it back.
- ``hp task progress <id> <0-100> --as <you>`` - progress.
- ``hp task review <id> --as <you> --note "what to check" --evidence "<plain Polish: what I did, how I checked, conclusion>"`` - ready for review (another agent or the human checks it). If the team has an agent on the other engine (Claude Code / Codex), hp gives it a high-priority task "Review #<id>: ...".
- ``hp task block <id> --as <you> --reason "waiting for X"`` - blocked (say who/what you are waiting for). Waiting for the human (the person you work for): add ``--wait human`` (that puts it in his Mailbox).
- ``hp task done <id> --as <you> --note "result" --evidence "<plain Polish: what I did, how I checked, conclusion>"`` - done (hp warns when a task with commits or links has no evidence).
- ``hp task note <id> --as <you> "note"``.
- ``hp task link <id> <url> --as <you> --kind commit|mr|pr [--title "short title"]`` - attach a commit or merge/pull request (GitLab or GitHub) to the task.

## Task workflow

Move your own tasks through the board yourself; the human watches it live.

1. Beginning work: ``hp task start <id> --as <you>``.
2. While working: ``hp task progress <id> <0-100> --as <you>`` after each meaningful step.
3. After every commit you push: ``hp task link <id> <commit url> --as <you> --kind commit --title "commit message"``.
4. After opening a merge/pull request: ``hp task link <id> <MR/PR url> --as <you> --kind mr`` (GitLab) or ``--kind pr`` (GitHub), with ``--title``.
5. Ready for review: ``hp task review <id> --as <you> --note "what to check" --evidence "<plain Polish summary>"`` (commands, output and links go to ``hp task note``).
6. Finished: ``hp task done <id> --as <you> --note "result" --evidence "..."``. Reviewing someone else's task ("Review #<id>"): verify it yourself, then ``hp task done <review id> --evidence "..."``, or send the findings to the owner (``hp say --to <owner> --task <id>``).
7. Blocked: ``hp task block <id> --as <you> --reason "what you are waiting for"``, then ``hp say --to <agent or ty>``.

## Epics

An epic is a big goal on the board (kind ``epic``, marked EPIC); its tasks carry ``--epic <id>``. Nobody works on the epic itself.

1. **The lead breaks it down.** A new epic goes to the lead (**$(if ($leadName) { $leadName } else { 'the lead' })**): ``hp epic plan <id> --as <you>`` shows it, the team's agent cards and the steps.
2. Small, verifiable tasks, each with one owner chosen by agent card and a done check: ``hp task add --as <you> --epic <id> --for <agent> [--after <ids>] --desc "Done when: ..." "title"``. Order with ``--after``. They wait in Backlog.
3. ``hp epic submit <id> --as <you>`` sends the plan to ty (Mailbox: Approve / Revise). Approve moves the tasks to To Do and tells their owners; Revise comes back with a note: change the tasks and submit again. An autonomous lead's plan is approved at once.
4. Then the normal workflow (``hp ready``, ``hp task claim``, ...). ``hp epic show <id>`` shows progress. The epic follows its tasks (In Progress, then Done when all are done); the lead then sends ty a short summary: ``hp say --to ty --task <id> --as <you> "..."``.

When ty changes your task in the app (priority, column, owner), you get one short direct message about it; read it with ``hp inbox``.

## Team status

``hp agent list`` shows every agent's live status: working, idle, blocked (waiting for the human), stopped or starting, how long, and how many open tasks it has.
The app restarts stopped agents that still have To Do / In Progress tasks, so a short gap is normal. A restarted agent gets a handoff note (its last terminal output and task notes); before a long pause, leave one yourself with ``hp task note``.

1. Waiting for another agent: check ``hp agent list`` before ``hp wait``. Never wait forever: use ``hp wait --as <you> --timeout 600`` and check again.
2. If that agent has been stopped or blocked for 15+ minutes, or did not answer within ~20 minutes, and you can do the work: take the task over with ``hp task claim <id> --as <you> --force`` (hp tells the old owner), then ``hp say --to <agent> "Took over #<id> because ..."`` (and ``--to ty`` if it matters).
3. If you cannot do it, hand it to another idle agent with the right role (``--for <agent>``) and tell them, or ask the human: ``hp say --to ty``.
4. If you are overloaded and someone is idle, offer tasks to them the same way.

## Rules

1. At the start: ``hp recall "<your task or goal>" --as <you>`` (your tasks, decisions, gotchas, your last session note), then ``hp agent list``, ``hp inbox --as <you>``, ``hp ready --as <you>``.
2. Record every important decision (architecture, versions, conventions, what was ruled out and why): ``hp decide "<decision>" --as <you> [--task <id>]``. It goes to the team memory and DECISIONS.md.
3. A goal without a breakdown: the lead decides who does what and records it as tasks with owners (``--after`` for order); others wait for their tasks instead of discussing it in the team chat.
4. Before working ``hp task start``, during ``hp task progress``, when finished ``hp task done`` and ``hp say`` to whoever it concerns.
5. When waiting for another agent: ``hp task block`` with a reason (``"waiting for #<id>"`` if it is a task) and ``hp say --to <agent>``.
6. Do not touch another agent's tasks without agreeing first, except as described in "Team status" above.
7. Before a dangerous operation, follow "Sacred boundaries": if your level says ask, use ``hp ask`` (or ``--ask`` on the refused command) and ``hp wait-approval``. Lock the machine first (``hp lock``).
8. Before a long pause or when your context gets long: ``hp reflect "<done, next, open questions>" --as <you>``.
9. Never wait for an answer in your own terminal: nobody watches it. Every question or decision for ty goes to the Mailbox: ``hp say --to ty "<question>" --as <you> [--task <id>]``; every permission (a command your level does not allow, anything outside your sandbox) goes through ``hp ask "<what and why>" --as <you> [--cmd "<command>"]`` and ``hp wait-approval <id> --as <you>``. Meanwhile continue with other work (``hp ready``).

## Memory and approvals reference

- ``hp recall "<topic>" --as <you>`` - one compact pack: your open tasks, related open tasks, recent decisions, matching gotchas and patterns, your last session note.
- ``hp search "<words>" [--kind gotcha] [--all]`` - search the memory (this project + global).
- ``hp remember "<title>" "<body>" --kind decision|gotcha|pattern|note --as <you> [--tags a,b] [--task <id>] [--global] [--supersedes <id>]``.
- ``hp reflect "<notes>" --as <you> [--task <id>]`` - session note (linked to your current task).
- ``hp forget <id> --as <you>`` - remove a wrong memory.
- ``hp ask "<what and why>" --as <you> [--cmd "<command>"] [--task <id>]`` - approval request to ty (Mailbox: Approve / Reject).
- ``hp wait-approval <id> --as <you> [--timeout 600]`` - wait for the answer; ``hp approvals`` - open requests.
"@
  Write-Text (Join-Path $dir 'AGENTS.md') $md
  Write-Text (Join-Path $dir 'CLAUDE.md') "@AGENTS.md`n"
  $cs = Join-Path $dir '.claude\settings.json'
  if (-not (Test-Path -LiteralPath $cs)) {
    Write-Json $cs ([ordered]@{ permissions = [ordered]@{ allow = @('Bash(hp:*)', 'Bash(hp.cmd:*)', 'PowerShell(hp:*)') } })
  }
}
function Docs-All { foreach ($d in (All-Projects)) { Write-AgentDocs $d.FullName } }
function Docs-For-Machine([string]$name) {
  foreach ($d in (All-Projects)) { $p = Load-Project $d.FullName; if (Has $p.machines $name) { Write-AgentDocs $d.FullName } }
}

# ---------------------------------------------------------------- maintenance (hp maintain)
# Keeps ~/.herdr bounded. The app runs it at start and every 6 h; idempotent, a second run trims nothing.
#  herdr.db events     older than $KeepDays days or beyond the newest $KeepEvents per project are moved
#                      to projects/<slug>/archive/events-<firstId>-<lastId>.jsonl.gz (gzip JSON lines) and
#                      deleted (at most 20000 per run). Read markers stay valid: ids are never reused.
#  events.jsonl        UI feed: newest $FeedEvents events, <= $FeedBytes (Feed-Trim; also guarded on append).
#  tasks.json          history/notes: last $TaskEntries per task; done tasks finished > $TaskArchiveDays days
#                      ago (unless an open task depends on them) -> tasks-archive.jsonl (rolled to
#                      archive/tasks-<date>.jsonl.gz past 4 MB).
#  secret-uses.jsonl   last 2000 lines. trash/: removed projects older than 30 days are deleted.
#  handoff/<agent>.txt of removed agents, editor/<vm>.json of removed machines, expired machine locks.
#  leftovers           *.tmp-<pid> (interrupted writes) and %TEMP%\hp-git-*/hp-run-* older than 1 day.
#  nvim undo           ~/.herdr/nvim/undo files not touched for 30 days.
$KeepDays = 90; $KeepEvents = 20000
# ---------------------------------------------------------------- code sources (repos) and task worktrees
# project.json "sources": [{ name, kind, url, branch, secret, locations: [{ type: local|vm, path, machine, deployed, service }] }]
# A project may have none. Task worktrees: task.worktree = { source, path, branch, machine, created, pruned }.
$SourceKinds = @('github', 'gitlab', 'bitbucket', 'other-remote', 'vm-path', 'local-path')
function Sources-Of($p) { return @(Arr $p.sources | Where-Object { $_ -and $_.name }) }
function Find-Source($p, [string]$name) {
  foreach ($s in (Sources-Of $p)) { if ($s.name -eq $name) { return $s } }
  Fail "No such source '$name' (hp source list)"
}
function Src-Local($s) { foreach ($l in (Arr $s.locations)) { if ($l.type -eq 'local' -and $l.path) { return $l } }; return $null }
function Src-Vms($s) { return @(Arr $s.locations | Where-Object { $_.type -eq 'vm' -and $_.machine }) }
function Loc-Text($l) {
  if ($l.type -eq 'local') { return "local $($l.path)" }
  return "$($l.machine):$($l.path)$(if ($l.deployed) { ' (deployed' + $(if ($l.service) { ', ' + $l.service } else { '' }) + ')' })"
}
function Sh-Q([string]$s) { return "'" + ($s -replace "'", "'\''") + "'" }
function Split-Locs([string]$v) { return @($v -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
function Parse-VmLoc([string]$v, [bool]$deployed, [string]$service) {
  $i = $v.IndexOf(':'); if ($i -lt 1) { Fail "VM location must be machine:/path (got '$v')" }
  $m = $v.Substring(0, $i).Trim(); $path = $v.Substring($i + 1).Trim()
  # --deployed web1:/srv/app#nginx: service name after "#".
  $h = $path.IndexOf('#'); if ($h -ge 0) { if ($deployed -and $path.Substring($h + 1).Trim()) { $service = $path.Substring($h + 1).Trim() }; $path = $path.Substring(0, $h).Trim() }
  if (-not $path) { Fail "VM location without a path: '$v'" }
  if (-not @(Machines-Load | Where-Object { $_.name -eq $m }).Count) { [Console]::Error.WriteLine("hp: warning: no machine '$m' yet (hp vm list)") }
  return [pscustomobject][ordered]@{ type = 'vm'; machine = $m; path = $path; deployed = $deployed; service = $(if ($deployed) { $service } else { '' }) }
}
# Applies hp source add/set options to $s.
function Source-Apply($s) {
  foreach ($k in @('url', 'branch', 'secret', 'desc')) { $v = O $k; if ($null -ne $v) { Set-Prop $s $k ([string]$v).Trim() } }
  if (-not $s.branch) { Set-Prop $s 'branch' 'main' }
  if ($s.secret) { [void](Find-Secret $s.secret) }
  $locs = @(Arr $s.locations)
  $local = O 'local'
  if ($null -ne $local) {
    $locs = @($locs | Where-Object { $_.type -ne 'local' })
    if ($local) { $locs = @([pscustomobject][ordered]@{ type = 'local'; path = ([string]$local).Trim().TrimEnd('\') }) + $locs }
  }
  $vm = O 'vm'; $dep = O 'deployed'; $svc = [string](O 'service' '')
  # --vm replaces the VM list (with --deployed ones); --deployed alone adds/marks deployed locations.
  if ($null -ne $vm) { $locs = @($locs | Where-Object { $_.type -ne 'vm' }); foreach ($v in (Split-Locs ([string]$vm))) { $locs += Parse-VmLoc $v $false '' } }
  foreach ($v in (Split-Locs ([string]$dep))) {
    $x = Parse-VmLoc $v $true $svc
    $locs = @($locs | Where-Object { -not ($_.type -eq 'vm' -and $_.machine -eq $x.machine -and $_.path -eq $x.path) }) + @($x)
  }
  Set-Prop $s 'locations' @($locs)
  $kind = O 'kind'
  if (-not $kind -and -not $s.kind) {
    $u = [string]$s.url
    $kind = if ($u -match 'github') { 'github' } elseif ($u -match 'gitlab') { 'gitlab' } elseif ($u -match 'bitbucket') { 'bitbucket' } elseif ($u) { 'other-remote' } elseif ((Src-Vms $s).Count -and -not (Src-Local $s)) { 'vm-path' } else { 'local-path' }
  }
  if ($kind) { if ($SourceKinds -notcontains $kind) { Fail "Kind: $($SourceKinds -join ', ')" }; Set-Prop $s 'kind' $kind }
  if (@('github', 'gitlab', 'bitbucket', 'other-remote') -contains $s.kind -and -not $s.url) { Fail "A $($s.kind) source needs --url" }
  if ($s.kind -eq 'vm-path' -and -not (Src-Vms $s).Count) { Fail 'A vm-path source needs --vm machine:/path' }
  if ($s.kind -eq 'local-path' -and -not (Src-Local $s)) { Fail 'A local-path source needs --local <folder>' }
}
# git on this computer; never throws (Windows PowerShell turns native stderr into errors otherwise).
function Git-Local([string]$repo, [string[]]$gargs) {
  $ErrorActionPreference = 'Continue'
  $out = & git.exe -C $repo @gargs 2>&1
  $code = $LASTEXITCODE
  return [pscustomobject]@{ code = $code; out = ((@($out) | ForEach-Object { [string]$_ }) -join "`n").Trim() }
}
# git output only (stderr dropped so warnings never end up in a diff); never throws.
function Git-Text([string]$repo, [string[]]$gargs) {
  $ErrorActionPreference = 'Continue'
  $out = & git.exe -C $repo @gargs 2>$null
  $code = $LASTEXITCODE
  return [pscustomobject]@{ code = $code; lines = @(@($out) | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ }) }
}
# The task's worktree, its source, the default branch and the local checkout (hp worktree diff/merge).
function Wt-Ctx([string]$dir, [string]$id) {
  $x = Find-Task (Tasks-Load $dir) $id
  $w = $x.worktree
  if (-not $w -or -not $w.branch) { Fail "Task #$id has no worktree (hp task start $id --source <name>)." }
  $s = Sources-Of (Load-Project $dir) | Where-Object { $_.name -eq $w.source } | Select-Object -First 1
  $def = if ($s -and $s.branch) { [string]$s.branch } else { 'main' }
  $loc = if ($s) { Src-Local $s } else { $null }
  return [pscustomobject]@{ x = $x; w = $w; s = $s; def = $def; repo = $(if ($loc) { [string]$loc.path } else { '' }); live = [bool]((-not $w.pruned) -and $w.path) }
}
# Like hp ssh (same alias, access check) but returns the output instead of exiting.
function Remote-Capture([string]$machine, [string]$script) {
  [void](Find-Machine $machine); Check-MachineAccess $machine
  $b64 = [Convert]::ToBase64String($Utf8.GetBytes($script.Replace("`r`n", "`n")))
  $ErrorActionPreference = 'Continue'
  $out = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 (Ssh-Alias $machine) "f=`$(mktemp); echo $b64 | base64 -d > `$f; bash `$f < /dev/null; r=`$?; rm -f `$f; exit `$r" 2>&1
  $code = $LASTEXITCODE
  return [pscustomobject]@{ code = $code; out = ((@($out) | ForEach-Object { [string]$_ }) -join "`n").Trim() }
}
function Kv-Lines([string]$text) {
  $h = @{}; foreach ($ln in ($text -split "`n")) { if ($ln -match '^([A-Z]+)=(.*)$') { $h[$Matches[1]] = $Matches[2].Trim() } }; return $h
}
# Last commit of the default branch through the provider API (GitHub / GitLab), when a usable secret exists.
function Source-Remote([string]$dir, $s) {
  $u = (([string]$s.url) -replace '\.git$', '') -replace '/+$', ''
  if ($u -notmatch '^https?://([^/]+)/(.+)$') { return $null }
  $h = $Matches[1]; $path = $Matches[2]
  $prov = if ($s.kind -eq 'github') { 'github' } elseif ($s.kind -eq 'gitlab') { 'gitlab' } else { '' }
  if (-not $prov) { return $null }
  $me = O 'as'; if (-not $me) { $me = $env:HERDR_AGENT }; if (-not $me) { $me = 'ty' }
  $slug = Slug-Of $dir
  $meta = if ($s.secret) { Find-Secret $s.secret } else {
    Secrets-Load | Where-Object { $pt = Secret-Type $_; $pt[0] -eq $prov -and (Secret-Host $_) -eq $h -and ($me -eq 'ty' -or (Has $_.projects $slug)) } | Select-Object -First 1
  }
  if (-not $meta) { return [ordered]@{ error = "no $prov secret for $h" } }
  if ($null -eq (Secret-Read $meta.name)) { return [ordered]@{ error = "secret $($meta.name) has no value" } }
  try {
    $auth = Secret-Auth $meta (Secret-Value $meta)
    if (-not $auth.api.Count) { return [ordered]@{ error = "secret $($meta.name) can't call the API" } }
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
    $br = [uri]::EscapeDataString([string]$s.branch)
    if ($prov -eq 'github') {
      $c = Invoke-RestMethod -Uri "$(Gh-Api-Root $h)/repos/$path/commits/$br" -Headers $auth.api -UseBasicParsing
      return [ordered]@{ sha = ([string]$c.sha).Substring(0, 7); title = (([string]$c.commit.message) -split "`n")[0]; date = [string]$c.commit.author.date; secret = $meta.name }
    }
    $c = Invoke-RestMethod -Uri "https://$h/api/v4/projects/$([uri]::EscapeDataString($path))/repository/commits/$br" -Headers $auth.api -UseBasicParsing
    return [ordered]@{ sha = [string]$c.short_id; title = [string]$c.title; date = [string]$c.committed_date; secret = $meta.name }
  } catch { return [ordered]@{ error = $_.Exception.Message } }
}
function Source-Status([string]$dir, $s) {
  $locs = @()
  foreach ($l in (Arr $s.locations)) {
    $r = [ordered]@{ type = [string]$l.type; machine = [string]$l.machine; path = [string]$l.path; deployed = [bool]$l.deployed; ok = $false; branch = ''; dirty = 0; ahead = $null; behind = $null; head = ''; error = '' }
    if ($l.type -eq 'local') {
      if (-not (Test-Path -LiteralPath $l.path)) { $r.error = 'path not found' }
      else {
        $b = Git-Local $l.path @('rev-parse', '--abbrev-ref', 'HEAD')
        if ($b.code -ne 0) { $r.error = 'not a git repository' } else {
          $r.ok = $true; $r.branch = $b.out
          $r.dirty = @((Git-Local $l.path @('status', '--porcelain')).out -split "`n" | Where-Object { $_.Trim() }).Count
          $ab = Git-Local $l.path @('rev-list', '--left-right', '--count', 'HEAD...@{u}')
          if ($ab.code -eq 0 -and $ab.out -match '^(\d+)\s+(\d+)') { $r.ahead = [int]$Matches[1]; $r.behind = [int]$Matches[2] }
          $r.head = (Git-Local $l.path @('log', '-1', '--format=%h %s')).out
        }
      }
    } elseif (-not @(Machines-Load | Where-Object { $_.name -eq $l.machine }).Count) { $r.error = "no machine '$($l.machine)'" }
    else {
      $sc = @'
cd __P__ 2>/dev/null || { echo "ERR=path not found"; exit 0; }
git rev-parse --abbrev-ref HEAD >/dev/null 2>&1 || { echo "ERR=not a git repository"; exit 0; }
echo "BR=$(git rev-parse --abbrev-ref HEAD)"
echo "DIRTY=$(git status --porcelain | wc -l)"
echo "AB=$(git rev-list --left-right --count 'HEAD...@{u}' 2>/dev/null)"
echo "HEAD=$(git log -1 --format='%h %s')"
'@
      $res = Remote-Capture $l.machine $sc.Replace('__P__', (Sh-Q $l.path))
      $kv = Kv-Lines $res.out
      if ($res.code -ne 0 -and -not $kv.Count) { $r.error = "ssh failed: $((($res.out -split "`n") | Select-Object -Last 1))" }
      elseif ($kv['ERR']) { $r.error = $kv['ERR'] }
      else {
        $r.ok = $true; $r.branch = [string]$kv['BR']; $r.dirty = [int]("0" + ($kv['DIRTY'] -replace '\D', '')); $r.head = [string]$kv['HEAD']
        if ($kv['AB'] -match '^(\d+)\s+(\d+)') { $r.ahead = [int]$Matches[1]; $r.behind = [int]$Matches[2] }
      }
    }
    $locs += [pscustomobject]$r
  }
  return [ordered]@{ name = $s.name; ts = (Now-Iso); locations = @($locs); remote = (Source-Remote $dir $s) }
}
function Task-Branch($x) {
  $s = Slugify ([string]$x.title); if ($s.Length -gt 32) { $s = $s.Substring(0, 32).Trim('-') }
  return "task/$($x.id)-$s"
}
# Local source: <project>/work/<source>-task-<id>. VM source: <path>/../.worktrees/task-<id> on that machine.
function Worktree-Create([string]$dir, $s, $x) {
  $branch = Task-Branch $x
  $base = ([string]$s.branch) -replace '[^A-Za-z0-9._/-]', ''; if (-not $base) { $base = 'main' }
  $loc = Src-Local $s
  if ($loc) {
    $repo = [string]$loc.path
    if ((Git-Local $repo @('rev-parse', '--git-dir')).code -ne 0) { Fail "Source '$($s.name)': $repo is not a git repository." }
    $wt = Join-Path (Join-Path $dir 'work') "$($s.name)-task-$($x.id)"
    if (-not (Test-Path -LiteralPath $wt)) {
      [void](New-Item -ItemType Directory -Force -Path (Join-Path $dir 'work'))
      if ((Git-Local $repo @('rev-parse', '--verify', '--quiet', "refs/heads/$branch")).code -eq 0) { $r = Git-Local $repo @('worktree', 'add', $wt, $branch) }
      else {
        $from = $base
        if ((Git-Local $repo @('rev-parse', '--verify', '--quiet', "refs/heads/$base")).code -ne 0) {
          $from = if ((Git-Local $repo @('rev-parse', '--verify', '--quiet', "refs/remotes/origin/$base")).code -eq 0) { "origin/$base" } else { 'HEAD' }
        }
        $r = Git-Local $repo @('worktree', 'add', '-b', $branch, $wt, $from)
      }
      if ($r.code -ne 0) { Fail "git worktree add failed: $($r.out)" }
    }
    return [pscustomobject][ordered]@{ source = $s.name; path = $wt; branch = $branch; machine = ''; created = (Now-Iso) }
  }
  $vm = @(@(Src-Vms $s | Where-Object { -not $_.deployed }) + @(Src-Vms $s | Where-Object { $_.deployed })) | Select-Object -First 1
  if (-not $vm) { Fail "Source '$($s.name)' has no local or VM checkout; a worktree needs one (hp source set $($s.name) --local <folder> or --vm machine:/path)." }
  $sc = @'
set -e
cd __P__
wt="$(cd .. && pwd)/.worktrees/task-__ID__"
if [ ! -d "$wt" ]; then
  mkdir -p "$(dirname "$wt")"
  if git rev-parse --verify --quiet "refs/heads/__B__" >/dev/null; then git worktree add "$wt" "__B__" >&2
  else
    from="__BASE__"
    git rev-parse --verify --quiet "refs/heads/$from" >/dev/null || { git rev-parse --verify --quiet "refs/remotes/origin/$from" >/dev/null && from="origin/$from" || from=HEAD; }
    git worktree add -b "__B__" "$wt" "$from" >&2
  fi
fi
echo "WT=$wt"
'@
  $res = Remote-Capture $vm.machine $sc.Replace('__P__', (Sh-Q $vm.path)).Replace('__ID__', [string]$x.id).Replace('__BASE__', $base).Replace('__B__', $branch)
  $kv = Kv-Lines $res.out
  if ($res.code -ne 0 -or -not $kv['WT']) { Fail "worktree on $($vm.machine) failed: $($res.out)" }
  return [pscustomobject][ordered]@{ source = $s.name; path = $kv['WT']; branch = $branch; machine = [string]$vm.machine; created = (Now-Iso) }
}
# AGENTS.md section (called from the Write-AgentDocs template).
function Sources-Doc($p) {
  $src = @(Sources-Of $p)
  $out = @('## Sources & worktrees', '')
  if (-not $src.Count) { $out += 'No code repositories registered for this project (the human adds them under Resources, or `hp source add`).'; return ($out -join "`n") }
  foreach ($s in $src) {
    $where = @(Arr $s.locations | ForEach-Object { Loc-Text $_ }) -join '; '
    $out += ('- `' + $s.name + '` - ' + $s.kind + $(if ($s.url) { ', ' + $s.url } else { '' }) + ', default branch `' + $s.branch + '`' + $(if ($where) { '; ' + $where } else { '' }))
  }
  $out += ''
  $out += '- `hp source list` / `hp source status <name>` - the repositories and the state of each checkout.'
  $out += '- `hp task start <id> --as <you> --source <name>` - creates the task''s own git worktree (branch `task/<id>-<slug>` from the default branch) and prints its path. Work only inside that worktree.'
  $out += '- One task = one branch = one worktree. Commit and push from it, open the MR/PR from that branch, then `hp task link`.'
  $out += '- Never touch another task''s worktree or branch, and do not commit in the shared checkout (the source''s local/VM path).'
  $out += '- VM sources: the worktree is on the machine at `<path>/../.worktrees/task-<id>`; use `hp ssh <machine> --as <you> "cd <worktree> && ..."`.'
  $out += '- After the merge: `hp worktree prune <id> --as <you>` removes the worktree (the branch stays).'
  return ($out -join "`n")
}

function Fmt-Bytes([double]$n) {
  $ci = [Globalization.CultureInfo]::InvariantCulture
  if ($n -ge 1GB) { return [string]::Format($ci, '{0:0.0} GB', $n / 1GB) }
  if ($n -ge 1MB) { return [string]::Format($ci, '{0:0.0} MB', $n / 1MB) }
  if ($n -ge 1KB) { return [string]::Format($ci, '{0:0} KB', $n / 1KB) }
  return "$([int64]$n) B"
}
function Dir-Bytes([string]$path) {
  $n = [int64]0
  if (-not (Test-Path -LiteralPath $path)) { return $n }
  try { foreach ($f in (New-Object IO.DirectoryInfo $path).EnumerateFiles('*', [IO.SearchOption]::AllDirectories)) { $n += $f.Length } } catch {}
  return $n
}
function Js-Str($s) { if ($null -eq $s) { return 'null' }; return '"' + [Web.HttpUtility]::JavaScriptStringEncode([string]$s) + '"' }
# Moves old events of one project from the database to a gzip archive. Returns the number moved.
function Maintain-Events([string]$slug, [string]$dir) {
  $cut = (Get-Date).ToUniversalTime().AddDays(-$KeepDays).ToString('yyyy-MM-ddTHH:mm:ssZ')
  $r = Db "SELECT id FROM events WHERE project = ?1 ORDER BY id DESC LIMIT 1 OFFSET $($KeepEvents - 1)" @($slug)
  $minKeep = if ($r.Count) { [string]$r[0][0] } else { '0' }
  $old = Db "SELECT $EvCols FROM events WHERE project = ?1 AND (ts < ?2 OR id < ?3) ORDER BY id LIMIT 20000" @($slug, $cut, $minKeep)
  if (-not $old.Count) { return 0 }
  try { Add-Type -AssemblyName System.Web } catch {}
  $arch = Join-Path $dir 'archive'
  if (-not (Test-Path -LiteralPath $arch)) { [void](New-Item -ItemType Directory -Force -Path $arch) }
  $first = $old[0][0]; $last = $old[$old.Count - 1][0]
  $fs = [IO.File]::Create((Join-Path $arch "events-$first-$last.jsonl.gz"))
  try {
    $z = New-Object IO.Compression.GZipStream($fs, [IO.Compression.CompressionMode]::Compress)
    $w = New-Object IO.StreamWriter($z, $Utf8)
    foreach ($e in $old) {
      $w.Write('{"id":' + $e[0] + ',"ts":' + (Js-Str $e[1]) + ',"project":' + (Js-Str $e[2]) + ',"type":' + (Js-Str $e[3]) + ',"from":' + (Js-Str $e[4]) + ',"to":' + (Js-Str $e[5]) + ',"task":' + (Js-Str $e[6]) + ',"execution":' + (Js-Str $e[7]) + ',"text":' + (Js-Str $e[8]) + "}`n")
    }
    $w.Close()
  } finally { $fs.Dispose() }
  [void](Db 'DELETE FROM events WHERE project = ?1 AND id <= ?2 AND (ts < ?3 OR id < ?4)' @($slug, [string]$last, $cut, $minKeep))
  return $old.Count
}
# Caps history/notes and archives old done tasks. Returns @(entries dropped, tasks archived).
function Maintain-Tasks([string]$dir) {
  $script:mt = @(0, 0)
  if (-not (Test-Path -LiteralPath (Tasks-Path $dir))) { return $script:mt }
  $cut = (Get-Date).ToUniversalTime().AddDays(-$TaskArchiveDays)
  # Read first: rewrite tasks.json only when something changes.
  $t0 = Tasks-Load $dir; $busy = $false
  foreach ($x in $t0.tasks) {
    if (@(Arr $x.history).Count -gt $TaskEntries -or @(Arr $x.notes).Count -gt $TaskEntries) { $busy = $true }
    if ($x.status -eq 'done' -and $x.completed) { try { if ([datetime]::Parse([string]$x.completed).ToUniversalTime() -lt $cut) { $busy = $true } } catch {} }
  }
  if (-not $busy) { return $script:mt }
  [void](Tasks-Change $dir {
    param($t)
    $need = @{}
    foreach ($x in $t.tasks) { if ($x.status -ne 'done') { foreach ($d in (Arr $x.after)) { $need[[string]$d] = $true } } }
    $keep = @(); $gone = @()
    foreach ($x in $t.tasks) {
      foreach ($k in @('history', 'notes')) {
        $a = @(Arr $x.$k)
        if ($a.Count -gt $TaskEntries) { Set-Prop $x $k @($a | Select-Object -Last $TaskEntries); $script:mt[0] += $a.Count - $TaskEntries }
      }
      $old = $false
      if ($x.status -eq 'done' -and $x.completed -and -not $need[[string]$x.id]) { try { $old = ([datetime]::Parse([string]$x.completed).ToUniversalTime() -lt $cut) } catch {} }
      if ($old) { $gone += $x } else { $keep += $x }
    }
    if ($gone.Count) {
      $sb = New-Object System.Text.StringBuilder
      foreach ($x in $gone) { Set-Prop $x 'archived' (Now-Iso); [void]$sb.Append((ConvertTo-Json -InputObject $x -Compress -Depth 8)).Append("`n") }
      [IO.File]::AppendAllText((Join-Path $dir 'tasks-archive.jsonl'), $sb.ToString(), $Utf8)
      $t.tasks = @($keep); $script:mt[1] = $gone.Count
    }
    $null
  })
  return $script:mt
}
# Gzips a file into archive/<name>-<date>.jsonl.gz and removes it.
function Roll-Gz([string]$path, [string]$archDir, [string]$name) {
  if (-not (Test-Path -LiteralPath $archDir)) { [void](New-Item -ItemType Directory -Force -Path $archDir) }
  $src = [IO.File]::OpenRead($path)
  try {
    $fs = [IO.File]::Create((Join-Path $archDir ("{0}-{1}.jsonl.gz" -f $name, (Get-Date).ToString('yyyyMMdd-HHmmss'))))
    try { $z = New-Object IO.Compression.GZipStream($fs, [IO.Compression.CompressionMode]::Compress); $src.CopyTo($z); $z.Close() } finally { $fs.Dispose() }
  } finally { $src.Dispose() }
  Remove-Item -LiteralPath $path -Force
}
function Maintain {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $c = [ordered]@{ events = 0; feed = 0; entries = 0; tasks = 0; uses = 0; trash = 0; files = 0; temp = 0; undo = 0 }
  $day = (Get-Date).AddDays(-1); $month = (Get-Date).AddDays(-30)
  $dirs = @{}
  foreach ($d in (All-Projects)) { $dirs[$d.Name] = $d.FullName }
  $known = @{}; foreach ($m in (Machines-Load)) { $known[[string]$m.name] = $true }
  # Events in the database (every project in it, also ones whose folder is gone).
  if (Test-Path -LiteralPath $DbPath) {
    foreach ($row in (Db 'SELECT DISTINCT project FROM events' $null)) {
      $slug = [string]$row[0]
      $dir = if ($dirs[$slug]) { $dirs[$slug] } else { Join-Path (Join-Path $HerdrHome 'archive') $slug }
      try { $c.events += Maintain-Events $slug $dir } catch { [Console]::Error.WriteLine("hp: events of ${slug}: $($_.Exception.Message)") }
    }
    if ($c.events -gt 0) { try { [void](Db 'PRAGMA wal_checkpoint(TRUNCATE)' $null) } catch {} }
    if ($c.events -gt 5000) { try { [void](Db 'VACUUM' $null) } catch {} }
  }
  foreach ($slug in $dirs.Keys) {
    $dir = $dirs[$slug]
    try {
      $minId = [int64]0
      if (Test-Path -LiteralPath $DbPath) { $r = Db 'SELECT COALESCE(MIN(id), 0) FROM events WHERE project = ?1' @($slug); $minId = [int64]$r[0][0] }
      $script:fd = 0; With-Lock $dir { $script:fd = Feed-Trim $dir $minId }; $c.feed += $script:fd
    } catch { [Console]::Error.WriteLine("hp: feed of ${slug}: $($_.Exception.Message)") }
    try { $mt = Maintain-Tasks $dir; $c.entries += $mt[0]; $c.tasks += $mt[1] } catch { [Console]::Error.WriteLine("hp: tasks of ${slug}: $($_.Exception.Message)") }
    $ta = Join-Path $dir 'tasks-archive.jsonl'
    if ((Test-Path -LiteralPath $ta) -and (Get-Item -LiteralPath $ta).Length -gt 4MB) { try { With-Lock $dir { Roll-Gz $ta (Join-Path $dir 'archive') 'tasks' } } catch {} }
    # Handoff notes of agents no longer in the project.
    $names = @{}; foreach ($a in (Agents-Load $dir)) { $names[[string]$a.name] = $true }
    $ho = Join-Path $dir 'handoff'
    if (Test-Path -LiteralPath $ho) { foreach ($f in (Get-ChildItem -LiteralPath $ho -File -Filter '*.txt')) { if (-not $names[$f.BaseName]) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue; $c.files++ } } }
    foreach ($sd in @($dir, (Join-Path $dir '.claude'))) {
      if (Test-Path -LiteralPath $sd) { foreach ($f in (Get-ChildItem -LiteralPath $sd -File -Filter '*.tmp-*' -Force)) { if ($f.LastWriteTime -lt $day) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue; $c.temp++ } } }
    }
  }
  # Who-used-which-secret log: last 2000 lines.
  $su = Join-Path $HerdrHome 'secret-uses.jsonl'
  if (Test-Path -LiteralPath $su) {
    $lines = @([IO.File]::ReadAllLines($su, $Utf8) | Where-Object { $_.Trim() })
    if ($lines.Count -gt 2000) { Write-Text $su ((($lines | Select-Object -Last 2000) -join "`n") + "`n"); $c.uses = $lines.Count - 2000 }
  }
  # Removed projects: 30 days in the trash (the folder name ends with the removal time).
  $tr = Join-Path $HerdrHome 'trash'
  if (Test-Path -LiteralPath $tr) {
    foreach ($d in (Get-ChildItem -LiteralPath $tr -Directory)) {
      $when = $d.CreationTime
      if ($d.Name -match '-(\d{8}-\d{6})$') { try { $when = [datetime]::ParseExact($Matches[1], 'yyyyMMdd-HHmmss', $null) } catch {} }
      if ($when -lt $month) { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue; $c.trash++ }
    }
  }
  # Editor state of removed machines; expired locks or locks of removed machines.
  $ed = Join-Path $HerdrHome 'editor'
  if (Test-Path -LiteralPath $ed) {
    $safe = @{}; foreach ($k in $known.Keys) { $safe[($k -replace '[^A-Za-z0-9_.-]', '-')] = $true }
    foreach ($f in (Get-ChildItem -LiteralPath $ed -File -Filter '*.json')) { if (-not $safe[$f.BaseName] -and $f.LastWriteTime -lt $day) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue; $c.files++ } }
  }
  if (Test-Path -LiteralPath $LocksDb) {
    With-Lock $HerdrHome {
      $now = (Get-Date).ToUniversalTime()
      $list = @(Arr (Read-Json $LocksDb @())); $live =@($list | Where-Object { $known[[string]$_.vm] -and $(try { ([datetime]$_.expires).ToUniversalTime() -gt $now } catch { $false }) })
      if ($live.Count -lt $list.Count) { Locks-Save $live; $script:lk = $list.Count - $live.Count } else { $script:lk = 0 }
    }
    $c.files += $script:lk
  }
  # Leftovers of interrupted writes and of hp git / hp run.
  foreach ($f in (Get-ChildItem -LiteralPath $HerdrHome -File -Filter '*.tmp-*' -Force -ErrorAction SilentlyContinue)) { if ($f.LastWriteTime -lt $day) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue; $c.temp++ } }
  foreach ($d in (Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'hp-*' -ErrorAction SilentlyContinue)) {
    if ($d.Name -match '^hp-(git|run)-[0-9a-f]{12}$' -and $d.LastWriteTime -lt $day) { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue; $c.temp++ }
  }
  # Neovim undo history (the remote editor): files not touched for 30 days.
  $ud = Join-Path $HerdrHome 'nvim\undo'
  if (Test-Path -LiteralPath $ud) { foreach ($f in (Get-ChildItem -LiteralPath $ud -File -Force -ErrorAction SilentlyContinue)) { if ($f.LastWriteTime -lt $month) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue; $c.undo++ } } }
  # Sizes.
  $parts = [ordered]@{ db = [int64]0; projects = (Dir-Bytes $ProjRoot); trash = (Dir-Bytes $tr); nvim = (Dir-Bytes (Join-Path $HerdrHome 'nvim')) }
  foreach ($f in @($DbPath, "$DbPath-wal", "$DbPath-shm")) { if (Test-Path -LiteralPath $f) { $parts.db += (Get-Item -LiteralPath $f).Length } }
  $total = Dir-Bytes $HerdrHome
  $res = [ordered]@{ bytes = $total; parts = $parts; trimmed = $c; ms = [int]$sw.ElapsedMilliseconds; at = (Now-Iso) }
  if (O 'json') { Write-Output (ConvertTo-Json -InputObject $res -Depth 4 -Compress); return }
  Write-Output ("~/.herdr: {0} (events db {1}, projects {2}, trash {3}, editor plugins {4})" -f (Fmt-Bytes $total), (Fmt-Bytes $parts.db), (Fmt-Bytes $parts.projects), (Fmt-Bytes $parts.trash), (Fmt-Bytes $parts.nvim))
  $what = @()
  if ($c.events) { $what += "$($c.events) old events archived" }
  if ($c.feed) { $what += "$($c.feed) feed lines" }
  if ($c.entries) { $what += "$($c.entries) task history entries" }
  if ($c.tasks) { $what += "$($c.tasks) old done tasks archived" }
  if ($c.uses) { $what += "$($c.uses) secret-use lines" }
  if ($c.trash) { $what += "$($c.trash) trashed projects deleted" }
  if ($c.files) { $what += "$($c.files) stale files" }
  if ($c.temp) { $what += "$($c.temp) temp leftovers" }
  if ($c.undo) { $what += "$($c.undo) undo files" }
  Write-Output $(if ($what.Count) { "trimmed: $($what -join ', ')" } else { 'nothing to trim' })
  Write-Output "took $($sw.ElapsedMilliseconds) ms"
}

# ================================================================= daily report (hp report daily)
# One day of a project (default: yesterday) as a Mailbox message from "herdr" to the human, thread
# daily-<date>: tasks done, blocked tasks, top changes (task links: MRs/PRs, commits), errors and tokens per
# agent (activity-cache.json, written by the app from the agents' session logs).
$Inv = [Globalization.CultureInfo]::InvariantCulture
function Local-Time($v) {
  if ($null -eq $v -or "$v" -eq '') { return $null }
  if ($v -is [datetime]) { return $v.ToLocalTime() }
  try { return ([datetime]::Parse([string]$v, $Inv, [Globalization.DateTimeStyles]::RoundtripKind)).ToLocalTime() } catch { return $null }
}
function Fmt-Tok([double]$n) {
  if ($n -ge 1e9) { return [string]::Format($Inv, '{0:0.#}B', $n / 1e9) }
  if ($n -ge 1e6) { return [string]::Format($Inv, '{0:0.#}M', $n / 1e6) }
  if ($n -ge 1e3) { return [string]::Format($Inv, '{0:0}K', $n / 1e3) }
  return [string][int64]$n
}
# The object under a top-level "key": { ... } of a big JSON text, parsed alone (the activity cache can be
# several MB, past what Windows PowerShell's ConvertFrom-Json takes).
function Json-Member([string]$text, [string]$key) {
  $needle = '"' + $key + '":'
  $i = 0
  while ($true) {
    $i = $text.IndexOf($needle, $i)
    if ($i -lt 0) { return $null }
    if ($i -eq 0 -or $text[$i - 1] -eq '{' -or $text[$i - 1] -eq ',') { break }
    $i += $needle.Length
  }
  $s = $i + $needle.Length
  if ($s -ge $text.Length -or $text[$s] -ne '{') { return $null }
  $depth = 0; $inStr = $false
  for ($j = $s; $j -lt $text.Length; $j++) {
    $c = $text[$j]
    if ($inStr) { if ($c -eq [char]92) { $j++ } elseif ($c -eq [char]34) { $inStr = $false }; continue }
    if ($c -eq [char]34) { $inStr = $true }
    elseif ($c -eq [char]123) { $depth++ }
    elseif ($c -eq [char]125) { $depth--; if ($depth -eq 0) { return ($text.Substring($s, $j - $s + 1) | ConvertFrom-Json) } }
  }
  return $null
}
function Daily-Report([string]$dir, [datetime]$day, [bool]$auto) {
  $slug = Slug-Of $dir
  $p = Load-Project $dir
  $date = $day.ToString('yyyy-MM-dd', $Inv)
  $thread = "daily-$date"
  if ($auto -and ($p.status -eq 'paused' -or $p.loose)) { return "$slug`: skipped ($(if ($p.loose) { 'loose agent' } else { 'paused' }))" }
  if (-not (O 'force') -and -not (O 'dry')) {
    $had = Db "SELECT id FROM events WHERE project = ?1 AND thread = ?2 AND sender = 'herdr' LIMIT 1" @($slug, $thread)
    if ($had.Count) { return "$slug`: already sent for $date (m$($had[0][0]); --force sends it again)" }
  }
  $live = @((Tasks-Load $dir).tasks)
  $tasks = @($live) + @(Tasks-Archived $dir)
  $done = @($tasks | Where-Object { $_.status -eq 'done' -and $null -ne (Local-Time $_.completed) -and (Local-Time $_.completed).Date -eq $day.Date })
  $blocked = @($live | Where-Object { $_.status -eq 'blocked' })
  $links = New-Object System.Collections.ArrayList
  foreach ($x in $tasks) {
    foreach ($l in (Arr $x.links)) {
      if (-not $l) { continue }
      $lt = Local-Time $l.ts
      if ($null -eq $lt -or $lt.Date -ne $day.Date) { continue }
      $k = [string]$l.kind
      [void]$links.Add([pscustomobject]@{ rank = $(if ($k -eq 'mr' -or $k -eq 'pr') { 0 } elseif ($k -eq 'commit') { 1 } else { 2 }); kind = $k; title = [string]$l.title; by = [string]$l.by; task = $x.id })
    }
  }
  $links = @($links | Sort-Object rank)
  $tok = @{}; $err = @{}
  $raw = Read-Text (Join-Path $dir 'activity-cache.json')
  if ($raw) {
    $days = Json-Member $raw 'days'
    $dd = if ($days) { $days.PSObject.Properties[$date] } else { $null }
    if ($dd) { foreach ($q in $dd.Value.PSObject.Properties) { $a = ($q.Name -split "`t")[0]; $s = 0.0; foreach ($n in @(Arr $q.Value)) { $s += [double]$n }; $tok[$a] = [double]$tok[$a] + $s } }
    $errs = Json-Member $raw 'errors'
    $ed = if ($errs) { $errs.PSObject.Properties[$date] } else { $null }
    if ($ed) { foreach ($q in $ed.Value.PSObject.Properties) { $err[$q.Name] = [int]$err[$q.Name] + [int]$q.Value } }
  }
  $tokSum = 0.0; foreach ($v in $tok.Values) { $tokSum += $v }
  $errSum = 0; foreach ($v in $err.Values) { $errSum += $v }
  if ($auto -and -not $done.Count -and -not $links.Count -and -not $errSum -and -not $tokSum) { return "$slug`: nothing to report for $date" }
  $plural = { param($n, $w) if ($n -eq 1) { "$n $w" } else { "$n $($w)s" } }
  $lines = @("Daily report $($day.ToString('ddd MMM d', $Inv)): $($done.Count) done, $($blocked.Count) blocked, $(& $plural $links.Count 'change'), $(& $plural $errSum 'error'), $(Fmt-Tok $tokSum) tokens.")
  if ($done.Count) { $lines += 'Done: ' + ((@($done | Select-Object -First 6) | ForEach-Object { "#$($_.id) $(Clip-Text ([string]$_.title) 60)" }) -join '; ') + $(if ($done.Count -gt 6) { " (+$($done.Count - 6) more)" } else { '' }) }
  if ($blocked.Count) { $lines += 'Blocked: ' + ((@($blocked | Select-Object -First 4) | ForEach-Object { "#$($_.id) $(Clip-Text ([string]$_.title) 50)$(if ($_.blocked_reason) { ' (' + (Clip-Text ([string]$_.blocked_reason) 50) + ')' })" }) -join '; ') }
  if ($links.Count) { $lines += 'Changes: ' + ((@($links | Select-Object -First 5) | ForEach-Object { "$(if ($_.kind) { $_.kind.ToUpperInvariant() + ' ' })$(Clip-Text $_.title 60)$(if ($_.by) { ' (' + $_.by + ')' })" }) -join '; ') + $(if ($links.Count -gt 5) { " (+$($links.Count - 5) more)" } else { '' }) }
  if ($errSum) { $lines += 'Errors: ' + ((@($err.GetEnumerator() | Sort-Object Value -Descending) | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', ') }
  if ($tokSum) { $lines += 'Tokens: ' + ((@($tok.GetEnumerator() | Sort-Object Value -Descending) | ForEach-Object { "$($_.Key) $(Fmt-Tok $_.Value)" }) -join ', ') }
  $lines += 'Full timeline: the project''s Activity view.'
  $text = $lines -join "`n"
  if (O 'dry') { return "$slug`:`n$text" }
  Emit $dir 'message' 'herdr' 'ty' $text $null $thread
  return "$slug`: sent m$($script:LastEmitId) ($thread)"
}

# ================================================================= commands
$cmd = if ($Pos.Count) { [string]$Pos[0] } else { 'help' }
$sub = if ($Pos.Count -gt 1) { [string]$Pos[1] } else { '' }

switch ($cmd) {

  'help' {
@'
hp - Herdr: projects, machines, secrets, chat and agent tasks

  hp project new <name> [--desc ...] | list | show | set [--name --desc --status] | attach <vm> | detach <vm>
  hp vm add <name> --host H --user U [--port 22] [--os ...] [--desc ...] [--value password]
  hp vm import <file.csv|file.json> [--overwrite]   (columns: name,host,user,port,password,sudo,os,desc,projects)
  hp vm list [--all] | trust <vm> | sudo <vm> --user U [--value password] | rm <vm>
  hp ssh <vm> --as <me> "<command>" | --file script.sh
  hp sudo <vm> --as <me> "<command>" | --file script.sh
  hp secret set <name> --provider P --type T [--host H] [--user U] [--expires YYYY-MM-DD] [--scopes a,b] [--fields '{json}'] [--projects a,b] [--agents x,y]
       providers/types: gitlab pat|project|group|deploy|deploykey|trigger|runner, github fine|classic|app|deploykey,
       bitbucket api|repo|project|workspace|dc|accesskey|apppw, azdo pat, gitother token, docker pat|org, registry ghcr|gitlab|other,
       npm token, pypi token, aws key, azure sp, gcp sa, k8s kubeconfig, ssh key, db conn, login password, apikey key, webhook secret, env bundle, token generic
  hp secret list | vars <name> | get <name> [--field password|user] | rm <name> | uses <name> | share|unshare <name> -p <project>
  hp git <secret> --as <me> [--on <vm>] [--dry] <git arguments...>     (HTTPS token header, or SSH key types locally)
  hp api <secret> --as <me> [--dry] <GET|POST|PUT|DELETE> <url> [--data '{json}']
  hp run --with <secret>[,<secret>] --as <me> -- <command> [args...]   (secrets as env vars of that command only; output masked)
  hp mr show <url> [--json] | approve <url> | comment <url> "text"  --as <me> [-p project] [--task id] [--secret name]
  hp say --as <me> [--to <agent>] [--task id] [--thread name] [--reply m<id>] [--ack] "message"  | hp log --as <me> "what I did"
  hp thread <task id|name|m<id>> [--json] | ack <m-id...> --as <me> | sent --as <me> [--json]   (threads, acks, read receipts)
  hp ready --as <me> [--all] [--json]   (next unblocked To Do tasks: mine + unassigned "team" ones, best first)
  hp task claim <id> --as <me> [--ttl 120] [--force] | release <id> --as <me> [--pool] [--note ..] | handoff <id> --to <agent> --as <me> --note ".."
  hp task add ... --for <agent>|team|auto [--discovered-from <id>]   (team = unassigned; auto = hp route's pick)
  hp reserve <glob...> --as <me> [--ttl 60] [--exclusive] [--task id] [--reason ..] [--force] | release [<glob|r-id>...] --as <me> [--task id]
  hp reservations [--json] | reservations --check <file...> --as <me>   (advisory file leases; hp git commit/push warns)
  hp agent card [<name>] [--skills a,b] [--desc ".."] [--json] | route "<task title>" [--json]   (agent cards, owner suggestion)
  hp chat [--tail 30] | inbox --as <me> | wait --as <me> [--timeout 600]
  hp events [--since id] [--json] | feed   (events from the ~/.herdr/herdr.db database; feed rebuilds events.jsonl)
  hp maintain [--json]   (trims old events/tasks/logs, temp files; the app runs it at start and every 6 h)
  hp task list [--for agent] [--all] [--tree]   (--all: every done task, archived ones too; --tree: epic tasks under their epic)
  hp task add --kind epic "<goal>" [--for <lead>] | task add --epic <id> --for <agent> [--after ..] "title"   (epics)
  hp epic plan <id> --as <me> | show <id> [--json] | list | submit <id> --as <me>   (lead plans, ty approves: Mailbox Approve / Revise)
  hp nudges flush [--wait 5] [--json]   (owner nudges after the human's task changes; the app runs it)
  hp task add|list|show|start|progress|review|block|done|todo|backlog|note|assign|rm
  hp task link <id> <url> --as <me> [--kind commit|mr|pr] [--title "..."]   (commit or merge/pull request)
  hp source add <name> [--kind github|gitlab|bitbucket|other-remote|vm-path|local-path] [--url U] [--branch main] [--local C:\path] [--vm m:/path,...] [--deployed m:/path[#service],...] [--secret S]
  hp source list | show <name> | set <name> [same options] | status [<name>] [--json] | rm <name>
  hp task start <id> --as <me> --source <name>   (own git worktree + branch task/<id>-<slug>) | hp worktree list | prune <id> [--force] | diff <id> [--file f] [--json] | merge <id> (into the default branch, --no-ff)
  hp task add ... --after 2,3 | task depends <id> <ids...> --as <me> | --clear   (dependencies)
  hp decide "<decision>" --as <me> [--task id] | decisions   (team memory, kind decision; DECISIONS.md is generated)
  hp remember "<title>" "<body>" --kind decision|gotcha|pattern|note --as <me> [--tags a,b] [--task id] [--global] [--supersedes id]
  hp recall "<topic>" --as <me> | search "<words>" [--kind k] [--all] [--json] | reflect "<notes>" --as <me> [--task id] | forget <id> --as <me>
  hp task review|done <id> --as <me> [--note "..."] [--evidence "test output summary"]   (review: cross-model review task)
  hp ask "<what and why>" --as <me> [--cmd "<command>"] [--task id] | wait-approval <id> [--timeout 600] | approvals [--all] [--json]
  hp approve <id> [--note ".."] | reject <id> [--note ".."]   (the human only; risky commands re-run with --approved <id>)
  hp vm set <vm> --prod on|off   (production machine: balanced agents need approval for destructive commands)
  hp lock <vm> "<reason>" --as <me> [--ttl 30] | unlock <vm> --as <me> | locks   (machine locks, all projects)
  hp agent join <name> [--role ...] [--app claude|codex] [--machines a,b] [--skills a,b] | set <name> [--machines a,b] [--role ...] [--skills a,b] [--desc ..] [--autorestart on|off] [--lead on|off] [--risk careful|balanced|autonomous] | list | lead | rm
  hp report daily [-p <id> | --all] [--date yyyy-MM-dd] [--force] [--dry]   (yesterday's summary to the Mailbox)
  Project: -p <id>, $env:HERDR_PROJECT or the project folder.
'@ | Write-Output
  }

  'install' {
    [void](New-Item -ItemType Directory -Force -Path $BinDir)
    [void](New-Item -ItemType Directory -Force -Path $ProjRoot)
    Write-Text (Join-Path $BinDir 'hp.cmd') "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$HpScript`" %*`r`n"
    $shPath = ($HpScript -replace '\\', '/')
    Write-Text (Join-Path $BinDir 'hp') "#!/bin/sh`nexec powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$shPath`" `"`$@`"`n"
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $userPath) { $userPath = '' }
    if (($userPath -split ';') -notcontains $BinDir) {
      [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $BinDir).TrimStart(';'), 'User')
      Write-Output "Added $BinDir to PATH (new terminals)."
    }
    Write-Output 'ok'
  }

  'project' {
    switch ($sub) {
      'new' {
        $name = P 2 'project name'
        $slug = Slugify $name
        $dir = Join-Path $ProjRoot $slug
        if (Test-Path -LiteralPath (Join-Path $dir 'project.json')) { Fail "Project '$slug' already exists" }
        [void](New-Item -ItemType Directory -Force -Path $dir)
        $colors = @('#8aa4c8', '#5fa89a', '#7fb08a', '#d4a35a', '#c98a62', '#c97a7a', '#a593c2', '#6fb0bb')
        $p = [ordered]@{ name = $name; slug = $slug; desc = (O 'desc' ''); status = 'active'; color = $colors[(Get-Random -Maximum $colors.Count)]; created = (Now-Iso); machines = @(List (O 'machines')); loose = ((O 'loose' 'no') -eq 'yes') }
        Save-Project $dir $p
        Write-Json (Tasks-Path $dir) ([ordered]@{ next = 1; tasks = @() })
        Write-Json (Agents-Path $dir) @()
        Write-AgentDocs $dir
        Emit $dir 'system' 'hp' 'all' "Project $name created." $null
        Write-Output $slug
      }
      'list' {
        foreach ($d in (All-Projects)) { $p = Load-Project $d.FullName; Write-Output ("{0}`t{1}`t{2}" -f $d.Name, $p.name, (@($p.machines) -join ',')) }
      }
      'show' { $dir = Find-Project; Write-Output (Read-Text (Join-Path $dir 'project.json')) }
      'docs' { if (O 'all') { Docs-All } else { Write-AgentDocs (Find-Project) }; if (O 'print') { Write-Output (Read-Text (Join-Path (Find-Project) 'AGENTS.md')) } else { Write-Output 'ok' } }
      'set' {
        $dir = Find-Project; $p = Load-Project $dir
        foreach ($k in @('name', 'desc', 'color', 'status')) { $v = O $k; if ($null -ne $v) { Set-Prop $p $k $v } }
        Save-Project $dir $p; Write-AgentDocs $dir; Write-Output 'ok'
      }
      { $_ -eq 'attach' -or $_ -eq 'detach' } {
        $dir = Find-Project; $name = P 2 'machine name'
        [void](Find-Machine $name)
        $p = Load-Project $dir
        if ($sub -eq 'attach') { if (-not (Has $p.machines $name)) { $p.machines = @($p.machines) + @($name) } }
        else {
          $p.machines = @($p.machines | Where-Object { $_ -ne $name })
          With-Lock $dir {
            $list = Agents-Load $dir
            foreach ($a in $list) { $a.machines = @($a.machines | Where-Object { $_ -ne $name }) }
            Write-Json (Agents-Path $dir) @($list)
          }
        }
        Save-Project $dir $p; Write-AgentDocs $dir
        Emit $dir 'system' 'hp' 'all' $(if ($sub -eq 'attach') { "Machine $name added to the project." } else { "Machine $name detached from the project." }) $null
        Write-Output 'ok'
      }
      'rm' {
        # Moves the project to ~/.herdr/trash (recoverable) and clears its events from the database.
        $dir = Find-Project; $slug = Slug-Of $dir
        if ((O 'confirm') -ne $slug) { Fail "Confirm with --confirm $slug" }
        $trash = Join-Path $HerdrHome 'trash'
        [void](New-Item -ItemType Directory -Force -Path $trash)
        $dest = Join-Path $trash ("{0}-{1}" -f $slug, (Get-Date).ToString('yyyyMMdd-HHmmss'))
        Move-Item -LiteralPath $dir -Destination $dest
        try { [void](Db 'DELETE FROM events WHERE project = ?1' @($slug)); [void](Db 'DELETE FROM reads WHERE project = ?1' @($slug)) } catch {}
        Write-Output $dest
      }
      default { Fail 'hp project new|list|show|set|attach|detach|docs|rm' }
    }
  }

  'vm' {
    switch ($sub) {
      'add' {
        $name = Slugify (P 2 'machine name')
        $hostName = O 'host'; $user = O 'user'
        if (-not $hostName -or -not $user) { Fail 'Pass --host and --user' }
        # --sudo on: the login user has sudo rights; its password (stored once) is used for "hp sudo".
        $m = [pscustomobject][ordered]@{ name = $name; host = $hostName; port = [int](O 'port' 22); user = $user; os = (O 'os' ''); desc = (O 'desc' ''); sudo = ((O 'sudo' 'off') -eq 'on'); added = (Now-Iso) }
        With-Lock $HerdrHome { Machines-Save (@(Machines-Load | Where-Object { $_.name -ne $name }) + @($m)) }
        $pw = O 'value'
        if ($pw) { Cred-Set "vm:${name}:ssh" $user $pw }
        Ssh-Config-Set $m
        $dir = Try-Find-Project
        if ($dir -and (O 'p')) {
          $p = Load-Project $dir
          if (-not (Has $p.machines $name)) { $p.machines = @($p.machines) + @($name); Save-Project $dir $p }
          Write-AgentDocs $dir
          Emit $dir 'system' 'hp' 'all' "New machine $name ($user@$hostName) in the project." $null
        }
        if ($pw -and (Install-Key $m $user "vm:${name}:ssh")) { Write-Output 'trusted' } else { Write-Output 'needs-trust' }
      }
      'list' {
        $all = Machines-Load
        $dir = Try-Find-Project
        if ($dir -and -not (O 'all')) {
          $p = Load-Project $dir
          $all = @($all | Where-Object { Has $p.machines $_.name })
        }
        if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($all) -Depth 5); return }
        $me = O 'as'; $agent = $null
        if ($dir -and $me) { $agent = Find-Agent $dir $me }
        foreach ($m in $all) {
          $access = if ($agent -and @($agent.machines).Count -gt 0 -and -not (Has $agent.machines $m.name)) { 'no access' } else { 'access' }
          $sudo = if (-not $m.sudo) { 'sudo off' } elseif ($agent -and -not (Has $agent.sudo $m.name)) { 'no sudo for you' } else { 'sudo' }
          Write-Output ("{0}`t{1}@{2}:{3}`t{4}`t{5}`t{6}`t{7}" -f $m.name, $m.user, $m.host, $m.port, $m.os, $sudo, $access, $m.desc)
        }
      }
      # Rewrites every machine's "herdr-<name>" block in ~/.ssh/config (after a change in how Herdr logs in).
      'sync-config' {
        $n = 0
        foreach ($m in (Machines-Load)) { Ssh-Config-Set $m; $n++ }
        Write-Output "ok $n"
      }
      'trust' {
        $name = P 2 'machine name'; $m = Find-Machine $name
        $ok = Install-Key $m $m.user "vm:${name}:ssh"
        $sudo = Cred-Get "vm:${name}:sudo"
        if ($ok -and $sudo -and $sudo[0] -and $sudo[0] -ne $m.user) { $ok = Install-Key $m $sudo[0] "vm:${name}:sudo" }
        if ($ok) {
          & ssh.exe -o BatchMode=yes -o ConnectTimeout=8 (Ssh-Alias $name) 'echo ok'
          if ($LASTEXITCODE -eq 0) { Write-Output "Key works: ssh $(Ssh-Alias $name)"; exit 0 }
        }
        Fail 'Failed to install the key.'
      }
      'sudo' {
        $name = P 2 'machine name'; $m = Find-Machine $name
        $user = O 'user' $m.user
        $pw = Read-Value "Sudo password for $user on $name"
        if (-not $pw) { Fail 'Empty password' }
        Cred-Set "vm:${name}:sudo" $user $pw
        Docs-For-Machine $name
        Write-Output 'ok'
      }
      # The saved SSH / sudo password, for the human's edit form (Herdr panel). Never for agents.
      'getpass' {
        if ((O 'as') -or $env:HERDR_AGENT) { Fail 'Agents cannot read machine passwords.' }
        $name = P 2 'machine name'; [void](Find-Machine $name)
        $which = [string](O 'which' 'ssh'); if ($which -ne 'sudo') { $which = 'ssh' }
        $r = Cred-Get "vm:${name}:$which"
        if ($null -eq $r) { Fail "No $which password saved for $name." }
        Write-Output ([string]$r[1])
      }
      'password' {
        $name = P 2 'machine name'; $m = Find-Machine $name
        $pw = Read-Value "SSH password for $($m.user) on $name"
        if (-not $pw) { Fail 'Empty password' }
        Cred-Set "vm:${name}:ssh" $m.user $pw
        Write-Output 'ok'
      }
      'set' {
        $name = P 2 'machine name'
        With-Lock $HerdrHome {
          $list = Machines-Load
          foreach ($m in $list) { if ($m.name -eq $name) { foreach ($k in @('host', 'user', 'os', 'desc', 'port')) { $v = O $k; if ($null -ne $v) { if (@('host', 'user', 'port') -contains $k -and -not "$v".Trim()) { continue }; if ($k -eq 'port') { $v = [int]$v }; Set-Prop $m $k $v } }; $sw = O 'sudo'; if ($sw) { Set-Prop $m 'sudo' ($sw -eq 'on') }; $pw = O 'prod'; if ($pw) { Set-Prop $m 'prod' ($pw -eq 'on') }; Ssh-Config-Set $m } }
          Machines-Save $list
        }
        Docs-For-Machine $name
        Write-Output 'ok'
      }
      'rm' {
        $name = P 2 'machine name'
        With-Lock $HerdrHome { Machines-Save @(Machines-Load | Where-Object { $_.name -ne $name }) }
        [void](Cred-Del "vm:${name}:ssh"); [void](Cred-Del "vm:${name}:sudo")
        Ssh-Config-Remove (Ssh-Alias $name)
        foreach ($d in (All-Projects)) {
          $p = Load-Project $d.FullName
          if (Has $p.machines $name) { $p.machines = @($p.machines | Where-Object { $_ -ne $name }); Save-Project $d.FullName $p; Write-AgentDocs $d.FullName }
        }
        Write-Output 'ok'
      }
      'import' {
        # CSV with a header (name,host,user,port,password,sudo,os,desc,projects; projects split by ";")
        # or a JSON array with the same keys. Each row runs "hp vm add" (+ "project attach").
        $file = P 2 'file'
        if (-not (Test-Path -LiteralPath $file)) { Fail "No such file: $file" }
        $text = (Read-Text $file).TrimStart([char]0xFEFF).Trim()
        if ($text.StartsWith('[') -or $text.StartsWith('{')) { $j = $text | ConvertFrom-Json; $rows = @($(if ($j.machines) { $j.machines } else { $j })) }
        else { $rows = @($text | ConvertFrom-Csv) }
        $have = @(Machines-Load | ForEach-Object { $_.name })
        $enc = { param($s) 'b64:' + [Convert]::ToBase64String($Utf8.GetBytes([string]$s)) }
        $ok = 0
        foreach ($r in $rows) {
          $h = "$($r.host)".Trim(); if (-not $h) { $h = "$($r.hostname)".Trim() }
          $nm = "$($r.name)".Trim(); if (-not $nm) { $nm = $(if ($h -match '^[\d.]+$') { $h } else { ($h -split '\.')[0] }) }
          $nm = Slugify $nm; $u = "$($r.user)".Trim()
          if (-not $h -or -not $u) { Write-Output "skip`t$nm`tmissing host or user"; continue }
          if ((Has $have $nm) -and -not ((O 'overwrite') -or (O 'force'))) { Write-Output "skip`t$nm`texists (--overwrite to replace)"; continue }
          $port = "$($r.port)".Trim(); if (-not $port) { $port = '22' }
          $a = @('vm', 'add', (& $enc $nm), '--host', (& $enc $h), '--user', (& $enc $u), '--port', (& $enc $port), '--sudo', $(if ("$($r.sudo)" -match '^(1|y|yes|true|on|tak)$') { 'on' } else { 'off' }))
          foreach ($k in @('os', 'desc')) { if ("$($r.$k)".Trim()) { $a += @("--$k", (& $enc "$($r.$k)".Trim())) } }
          if ("$($r.password)") { $a += @('--value', (& $enc "$($r.password)")) }
          $out = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath @a 2>&1
          if ($LASTEXITCODE -ne 0) { Write-Output "fail`t$nm`t$((@($out) | Select-Object -Last 1))"; continue }
          $ok++
          $pl = if ($r.projects -is [array]) { @($r.projects) } else { "$($r.projects)" -split '[;|]' }
          foreach ($pj in @($pl | ForEach-Object { "$_".Trim() } | Where-Object { $_ })) {
            [void](& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath project attach (& $enc $nm) --p (& $enc (Slugify $pj)) 2>&1)
            if ($LASTEXITCODE -ne 0) { Write-Output "warn`t$nm`tno project $pj" }
          }
          Write-Output "ok`t$nm`t$((@($out) | Select-Object -Last 1))"
        }
        Write-Output "imported $ok of $($rows.Count)"
      }
      default { Fail 'hp vm add|import|list|trust|sudo|set|rm' }
    }
  }

  { $_ -eq 'ssh' -or $_ -eq 'sudo' } {
    $name = P 1 'machine name'
    $m = Find-Machine $name
    Check-MachineAccess $name
    $lk = Lock-Of $name
    if ($lk) {
      $lkMe = O 'as'; if (-not $lkMe) { $lkMe = $env:HERDR_AGENT }
      $lkDir = Try-Find-Project; $lkSlug = if ($lkDir) { Slug-Of $lkDir } else { '' }
      if (-not (Lock-Mine $lk $lkMe $lkSlug)) { [Console]::Error.WriteLine("hp: warning: $(Lock-Text $lk)") }
    }
    $file = O 'file'
    $script = if ($file) { Read-Text (Resolve-Path -LiteralPath $file).Path } else { Rest 2 }
    if (-not $script) { Fail "Give a command: hp $cmd $name `"command`"" }
    $dir = Try-Find-Project
    $me = O 'as'
    # Risk level: destructive commands need an approval (careful: everywhere; balanced: production machines).
    $rkMe = if ($me) { $me } else { $env:HERDR_AGENT }
    $rkHit = Risky-Command $script
    if ($dir -and $rkHit -and $rkMe -and $rkMe -ne 'ty') {
      # Sudo permission first, so an approval is not used up by a call that cannot run anyway.
      if ($cmd -eq 'sudo' -and (-not $m.sudo -or -not (Has (Find-Agent $dir $rkMe).sudo $name))) { Fail "No sudo for '$rkMe' on '$name' (machine sudo switch and the agent's sudo grant)." }
      $isProd = [bool]($m.PSObject.Properties['prod'] -and $m.prod)
      $lvl = Risk-Of $dir $rkMe
      Risk-Gate $dir $rkMe "$cmd ${name}: $script" "destructive command '$rkHit' on $name$(if ($isProd) { ' (production)' })" (($lvl -eq 'careful') -or ($lvl -eq 'balanced' -and $isProd))
    }
    if ($dir -and $me -and $me -ne 'ty') {
      $short = if ($script.Length -gt 160) { $script.Substring(0, 160) + '…' } else { $script }
      Emit $dir 'tool' $me 'all' "$cmd $name`: $short" (O 'task')
    }
    if ($cmd -eq 'ssh') { Remote-Run (Ssh-Alias $name) $script $false $null }
    # Sudo is a per-machine switch, and each agent must be granted sudo on that machine.
    if (-not $m.sudo) { Fail "Sudo is turned off for $name (machine -> Access -> Sudo access)." }
    $meSudo = O 'as'; if (-not $meSudo) { $meSudo = $env:HERDR_AGENT }
    if ($meSudo -and $meSudo -ne 'ty') {
      $agentDir = Try-Find-Project
      $ag = if ($agentDir) { Find-Agent $agentDir $meSudo } else { $null }
      if (-not $ag -or -not (Has $ag.sudo $name)) { Fail "Agent '$meSudo' has no sudo on '$name'. Grant it in the agent's machine access." }
    }
    $cred = Cred-Get "vm:${name}:sudo"
    if ($null -eq $cred) { $cred = Cred-Get "vm:${name}:ssh" }
    if ($null -eq $cred) { Fail "No password stored for $name (machine -> Access -> Change SSH password)." }
    $alias = Ssh-Alias $name
    if ($cred[0] -and $cred[0] -ne $m.user) { $alias = "$($cred[0])@$alias" }
    Remote-Run $alias $script $true $cred[1]
  }

  'secret' {
    switch ($sub) {
      'set' {
        $name = Slugify (P 2 'secret name')
        $old = Secrets-Load | Where-Object { $_.name -eq $name } | Select-Object -First 1
        $value = O 'value'
        if (-not $value -and -not $old) { $value = Read-Value "Value of secret $name" }
        if (-not $value -and -not $old) { Fail 'Empty value' }
        $keep = { param($k, $def) if ($null -ne (O $k)) { return (O $k) }; if ($old -and $null -ne $old.$k) { return $old.$k }; return $def }
        $fields = if ($null -ne (O 'fields')) { if ((O 'fields').Trim()) { (O 'fields') | ConvertFrom-Json } else { [pscustomobject]@{} } } elseif ($old -and $old.fields) { $old.fields } else { [pscustomobject]@{} }
        $hostV = [string](& $keep 'host' '')
        $urlV = if ($null -ne (O 'url')) { O 'url' } elseif ($null -ne (O 'host')) { if (-not $hostV) { '' } elseif ($hostV -match '^https?://') { $hostV } else { "https://$hostV" } } elseif ($old) { [string]$old.url } else { '' }
        $meta = [pscustomobject][ordered]@{
          name = $name; kind = (& $keep 'kind' $(if (O 'provider') { O 'provider' } else { 'token' }))
          provider = [string](& $keep 'provider' ''); type = [string](& $keep 'type' ''); host = $hostV
          user = (O 'user' $(if ($old) { $old.user } else { '' })); url = $urlV
          expires = (Exp-Str (& $keep 'expires' '')); scopes = @(if ($null -ne (O 'scopes')) { @((O 'scopes') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } elseif ($old) { Arr $old.scopes } else { @() })
          fields = $fields
          desc = (O 'desc' $(if ($old) { $old.desc } else { '' })); machine = (O 'machine' $(if ($old) { $old.machine } else { '' }))
          projects = @($(if ($null -ne (O 'projects')) { List (O 'projects') } elseif ($old) { Arr $old.projects } else { @() }))
          agents = @($(if ($null -ne (O 'agents')) { List (O 'agents') } elseif ($old) { Arr $old.agents } else { @() }))
          created = $(if ($old) { $old.created } else { Now-Iso }); updated = (Now-Iso)
        }
        if ($value) { Secret-Write $name $meta.user $value }
        elseif ($old -and $meta.user -ne $old.user) { $r = Cred-Get "secret:$name"; if ($r) { Cred-Set "secret:$name" $meta.user $r[1] } }
        With-Lock $HerdrHome { Secrets-Save (@(Secrets-Load | Where-Object { $_.name -ne $name }) + @($meta)) }
        Docs-All
        Write-Output $name
      }
      'list' {
        $list = Secrets-Load
        $me = O 'as'
        $dir = Try-Find-Project; $slug = if ($dir) { Slug-Of $dir } else { '' }
        if ($me -and $me -ne 'ty') {
          $list = @($list | Where-Object { (Has $_.projects $slug) -and (@(Arr $_.agents).Count -eq 0 -or (Has $_.agents $me)) })
        }
        if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($list) -Depth 5); return }
        foreach ($s in $list) {
          $left = Days-Left $s
          $exp = if ($null -eq $left) { '' } elseif ($left -lt 0) { "EXPIRED $(Exp-Str $s.expires)" } else { "expires $(Exp-Str $s.expires)" }
          Write-Output ("{0}`t{1}`t{2}`t{3}`t{4}" -f $s.name, (Type-Label $s), (Secret-Host $s), $exp, $s.desc)
        }
      }
      'get' {
        $meta = Find-Secret (P 2 'secret name')
        $r = Secret-Value $meta
        switch (O 'field' 'password') {
          'user' { Write-Output $r[0] }
          default { Write-Output $r[1] }
        }
      }
      { $_ -eq 'share' -or $_ -eq 'unshare' } {
        # hp secret share <name> -p <project>  /  hp secret unshare <name> -p <project>
        $name = P 2 'secret name'
        [void](Find-Secret $name)
        $slugT = O 'p'; if (-not $slugT) { Fail 'Pass -p <project>' }
        With-Lock $HerdrHome {
          $list = Secrets-Load
          foreach ($x in $list) { if ($x.name -eq $name) {
            $cur = @(Arr $x.projects | Where-Object { $_ -ne $slugT })
            Set-Prop $x 'projects' $(if ($sub -eq 'share') { @($cur) + @($slugT) } else { @($cur) })
          } }
          Secrets-Save $list
        }
        $dirT = Join-Path $ProjRoot $slugT
        if (Test-Path -LiteralPath (Join-Path $dirT 'project.json')) { Write-AgentDocs $dirT }
        Write-Output 'ok'
      }
      'vars' {
        # Names (never values) of the variables hp run --with <name> sets.
        $meta = Find-Secret (P 2 'secret name')
        Check-SecretAccess $meta
        $envs = [ordered]@{}; $mask = New-Object System.Collections.ArrayList
        Run-Env $meta @([string]$meta.user, '') $null $envs $mask
        Write-Output "$($meta.name) ($(Type-Label $meta)): $(@($envs.Keys) -join ', ')"
      }
      'uses' {
        $name = P 2 'secret name'
        $t = Read-Text (Join-Path $HerdrHome 'secret-uses.jsonl')
        if ($t) { $t -split "`n" | Where-Object { $_ -match ('"secret":"' + [regex]::Escape($name) + '"') } | Select-Object -Last ([int](O 'tail' 50)) | Write-Output }
      }
      # Renames a secret: its value (Credential Manager), metadata, and the references to it
      # (project sources, ${secret:NAME} in MCP servers).
      'rename' {
        $old = P 2 'secret name'; $new = Slugify (P 3 'new name')
        $meta = Find-Secret $old
        if ($old -ne $new) {
          foreach ($s in (Secrets-Load)) { if ($s.name -eq $new) { Fail "A secret named '$new' already exists." } }
          $r = Secret-Read $old
          if ($null -ne $r) { Secret-Write $new ([string]$r[0]) ([string]$r[1]) }
          With-Lock $HerdrHome {
            $list = @(Secrets-Load)
            foreach ($s in $list) { if ($s.name -eq $old) { $s.name = $new; Set-Prop $s 'updated' (Now-Iso) } }
            Secrets-Save $list
          }
          foreach ($d in (All-Projects)) {
            $p = Load-Project $d.FullName; $hit = $false
            foreach ($s in (Sources-Of $p)) { if ($s.secret -eq $old) { $s.secret = $new; $hit = $true } }
            if ($hit) { Save-Project $d.FullName $p }
          }
          $mcp = Join-Path $HerdrHome 'mcp.json'
          $t = Read-Text $mcp
          $from = '${secret:' + $old + '}'; $to = '${secret:' + $new + '}'
          if ($t -and $t.Contains($from)) { Write-Text $mcp ($t.Replace($from, $to)) }
          if ($null -ne $r) { Secret-DropChunks $old; [void](Cred-Del "secret:$old") }
          Docs-All
        }
        Write-Output $new
      }
      'rm' {
        $name = P 2 'secret name'
        Secret-DropChunks $name
        [void](Cred-Del "secret:$name")
        With-Lock $HerdrHome { Secrets-Save @(Secrets-Load | Where-Object { $_.name -ne $name }) }
        Docs-All
        Write-Output 'ok'
      }
      default { Fail 'hp secret set|list|get|vars|share|unshare|uses|rename|rm' }
    }
  }

  'git' {
    # Risk level: protected pushes/merges, force pushes and tags need an approval unless the agent is autonomous.
    $gName = P 1 'secret name'; $gArgs = @($Pos | Select-Object -Skip 2)
    $gDir = Try-Find-Project; $gMe = O 'as'; if (-not $gMe) { $gMe = $env:HERDR_AGENT }
    if ($gDir -and $gMe -and $gMe -ne 'ty') {
      $gWhy = Git-Protected ([string[]]$gArgs) $gDir ([bool](O 'on'))
      if ($gWhy) { Risk-Gate $gDir $gMe "git $gName$(if (O 'on') { ' on ' + (O 'on') }): $($gArgs -join ' ')" $gWhy ((Risk-Of $gDir $gMe) -ne 'autonomous') }
      # File reservations (Agent Mail pre-commit guard, advisory): warn when a commit/push touches files another
      # agent reserved. Local repositories only.
      if (-not (O 'on') -and @(Res-Load $gDir).Count) {
        try {
          $gRepo = (Get-Location).Path; $gSub = ''
          for ($gi = 0; $gi -lt $gArgs.Count; $gi++) { if ($gArgs[$gi] -eq '-C' -and $gi + 1 -lt $gArgs.Count) { $gRepo = $gArgs[$gi + 1]; $gi++; continue }; if (-not $gArgs[$gi].StartsWith('-')) { $gSub = $gArgs[$gi]; break } }
          $gFiles = @()
          if ($gSub -eq 'commit') { $gFiles = (Git-Text $gRepo @('diff', '--cached', '--name-only')).lines; if ($gArgs -contains '-a' -or $gArgs -contains '--all' -or $gArgs -match '^-[a-z]*a') { $gFiles += (Git-Text $gRepo @('diff', '--name-only')).lines } }
          elseif ($gSub -eq 'push') { $gFiles = (Git-Text $gRepo @('diff', '--name-only', '@{u}..HEAD')).lines }
          $gHits = if ($gFiles.Count) { Res-Hits $gDir $gMe @($gFiles | Select-Object -Unique) } else { @() }
          foreach ($h in $gHits) { [Console]::Error.WriteLine("hp: warning: $gSub touches a file reserved by another agent: $h") }
          if ($gHits.Count) { [Console]::Error.WriteLine("hp: coordinate before pushing on (hp reservations; hp say --to <agent>). Never overwrite their work.") }
        } catch {}
      }
    }
    $meta = Find-Secret (P 1 'secret name')
    $r = Secret-Value $meta
    $auth = Secret-Auth $meta $r
    if ($auth.why) { Fail $auth.why }
    $gitArgs = @($Pos | Select-Object -Skip 2)
    $on = O 'on'
    $dir = Try-Find-Project; $me = O 'as'
    if ($dir -and $me -and $me -ne 'ty') { Emit $dir 'tool' $me 'all' "git ($($meta.name))$(if ($on) { ' on ' + $on }): $($gitArgs -join ' ')" (O 'task') }
    if ($auth.ssh) {
      # SSH key types (deploy keys, access keys): the key goes to a temporary owner-only file for this one git call.
      if ($on) { Fail "SSH key secrets work only locally (hp git without --on)." }
      $tmp = Join-Path $env:TEMP ("hp-git-" + (New-Id)); [void](New-Item -ItemType Directory -Force -Path $tmp)
      try {
        $k = Join-Path $tmp 'id_key'; [IO.File]::WriteAllText($k, (Key-Text $r[1]), $Utf8); Ssh-Protect $k
        $env:GIT_SSH_COMMAND = Ssh-Cmd $k
        & git.exe @gitArgs
        $code = $LASTEXITCODE
      } finally { Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue }
      exit $code
    }
    if (-not $auth.git) { Fail "A $(Type-Label $meta) can't authenticate git. Use: hp run --with $($meta.name) -- <command>" }
    if ($on) {
      [void](Find-Machine $on); Check-MachineAccess $on
      # The header reaches git via environment variables (not visible in the process list or history).
      $q = ($gitArgs | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
      $script = "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader; read -r GIT_CONFIG_VALUE_0; export GIT_CONFIG_VALUE_0; git $q"
      $b64 = [Convert]::ToBase64String($Utf8.GetBytes($script))
      $auth.git | & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 (Ssh-Alias $on) "echo $b64 | base64 -d > /tmp/.hpgit.`$`$; bash /tmp/.hpgit.`$`$; r=`$?; rm -f /tmp/.hpgit.`$`$; exit `$r"
      exit $LASTEXITCODE
    }
    $env:GIT_CONFIG_COUNT = '1'; $env:GIT_CONFIG_KEY_0 = 'http.extraHeader'; $env:GIT_CONFIG_VALUE_0 = $auth.git
    if (O 'dry') { Write-Output "git $($gitArgs -join ' ')  [auth: $(($auth.git -split ' ')[1]) header for $(Type-Label $meta)]"; exit 0 }
    & git.exe @gitArgs
    exit $LASTEXITCODE
  }

  'api' {
    $meta = Find-Secret (P 1 'secret name')
    $method = (P 2 'method').ToUpperInvariant(); $url = P 3 'url'
    $r = Secret-Value $meta
    $auth = Secret-Auth $meta $r
    if ($auth.why) { Fail $auth.why }
    if ($auth.ssh) { Fail "An SSH key can't call an HTTP API. Use hp git (ssh remote) or hp run." }
    if (-not $auth.api.Count) { Fail "A $(Type-Label $meta) can't call an HTTP API. Use: hp run --with $($meta.name) -- <command>" }
    if ($auth.only -eq 'packages' -and $url -notmatch '/packages/') { Fail 'GitLab deploy tokens cannot use the REST API, only package registry endpoints (.../packages/...). Use a personal, project or group access token.' }
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
    $headers = $auth.api
    $params = @{ Method = $method; Uri = $url; Headers = $headers; UseBasicParsing = $true }
    $data = O 'data'
    if ($data) { $params['Body'] = $Utf8.GetBytes($data); $params['ContentType'] = 'application/json; charset=utf-8' }
    $dir = Try-Find-Project; $me = O 'as'
    if ($dir -and $me -and $me -ne 'ty') { Emit $dir 'tool' $me 'all' "api ($($meta.name)) $method $url" (O 'task') }
    if (O 'dry') { Write-Output "$method $url  [headers: $(@($headers.Keys) -join ', ')]"; exit 0 }
    $res = Invoke-WebRequest @params
    Write-Output $res.Content
  }

  'run' {
    # hp run --with a[,b] --as <me> -- <command> [args...]: secrets become environment variables of that one
    # child process (files like kubeconfig/keys go to an owner-only temp folder, deleted afterwards).
    # Secret values in its output are replaced with ***.
    $names = @((O 'with') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $cmdArgs = @($Pos | Select-Object -Skip 1)
    if (-not $names.Count -or -not $cmdArgs.Count) { Fail 'Usage: hp run --with <secret>[,<secret>] --as <me> -- <command> [args...]' }
    if (O 'on') { Fail 'hp run works on this computer only (no --on).' }
    $exe = [string]$cmdArgs[0]; $rest = @($cmdArgs | Select-Object -Skip 1)
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { Fail "Command not found: $exe" }
    $tmp = Join-Path $env:TEMP ("hp-run-" + (New-Id)); [void](New-Item -ItemType Directory -Force -Path $tmp)
    $code = 1
    try {
      $envs = [ordered]@{}; $mask = New-Object System.Collections.ArrayList
      foreach ($n in $names) { $meta = Find-Secret $n; $r = Secret-Value $meta; Run-Env $meta $r $tmp $envs $mask }
      $mask = @($mask | Where-Object { $_ -and $_.Length -ge 4 } | Sort-Object -Property Length -Descending -Unique)
      $dir = Try-Find-Project; $me = O 'as'
      if ($dir -and $me -and $me -ne 'ty') { Emit $dir 'tool' $me 'all' "run ($($names -join ', ')): $exe $($rest -join ' ')" (O 'task') }
      foreach ($k in @($envs.Keys)) { [Environment]::SetEnvironmentVariable([string]$k, [string]$envs[$k], 'Process') }
      $ErrorActionPreference = 'Continue'
      $global:LASTEXITCODE = 0
      & $exe @rest 2>&1 | ForEach-Object {
        $isErr = $_ -is [System.Management.Automation.ErrorRecord]
        $line = if ($isErr) { [string]$_.Exception.Message } else { [string]$_ }
        foreach ($m in $mask) { $line = $line.Replace($m, '***') }
        if ($isErr) { [Console]::Error.WriteLine($line) } else { $line }
      }
      $code = $LASTEXITCODE
    } finally { Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue }
    exit $code
  }

  'mr' {
    # Merge/pull request review. The token is the gitlab / github secret for that host
    # (best match: secret url host, then shared with the project); --secret <name> picks one.
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
    if (@('show', 'approve', 'comment') -notcontains $sub) { Fail 'Usage: hp mr show <url> [--json] | approve <url> | comment <url> "text"  [--as <me>] [-p project] [--task id]' }
    $url = (P 2 'url of the merge/pull request').Trim()
    $gh = $false; $mhost = ''; $base = ''
    if ($url -match '^(https?://([^/]+))/(.+?)/-/merge_requests/(\d+)') {
      $mhost = $Matches[2]; $base = "$($Matches[1])/api/v4/projects/$([uri]::EscapeDataString($Matches[3]))/merge_requests/$($Matches[4])"
    } elseif ($url -match '^(https?://([^/]+))/([^/]+)/([^/]+)/pull/(\d+)') {
      $gh = $true; $mhost = $Matches[2]
      $apiRoot = if ($mhost -eq 'github.com') { 'https://api.github.com' } else { "$($Matches[1])/api/v3" }
      $base = "$apiRoot/repos/$($Matches[3])/$($Matches[4])/pulls/$($Matches[5])"
    } else { Fail 'Not a merge/pull request url (.../-/merge_requests/N or .../pull/N)' }
    $me = O 'as'; if (-not $me) { $me = $env:HERDR_AGENT }; if (-not $me) { $me = 'ty' }
    $dir = Try-Find-Project; $slug = if ($dir) { Slug-Of $dir } else { '' }
    # API-capable types only: GitLab personal/project/group tokens, GitHub tokens or App.
    $prov = if ($gh) { 'github' } else { 'gitlab' }
    $okTypes = if ($gh) { @('fine', 'classic', 'app') } else { @('pat', 'project', 'group') }
    if (O 'secret') { $meta = Find-Secret (O 'secret') } else {
      $cands = @(Secrets-Load | Where-Object { $pt = Secret-Type $_; $pt[0] -eq $prov -and $okTypes -contains $pt[1] } | Where-Object { $me -eq 'ty' -or ((Has $_.projects $slug) -and (@(Arr $_.agents).Count -eq 0 -or (Has $_.agents $me))) })
      if (-not $cands.Count) { Fail "No $(if ($gh) { 'GitHub' } else { 'GitLab' }) API token for $mhost$(if ($me -ne 'ty') { ' shared with this project' }). Add one in Tokens & Access." }
      $meta = $cands | Sort-Object -Descending -Property @{ Expression = { $s = 0; if ((Secret-Host $_) -eq $mhost) { $s += 4 }; if ($slug -and (Has $_.projects $slug)) { $s += 2 }; $d = Days-Left $_; if ($null -eq $d -or $d -ge 0) { $s += 1 }; $s } } | Select-Object -First 1
    }
    $r = Secret-Value $meta
    $auth = Secret-Auth $meta $r
    if (-not $auth.api.Count) { Fail "Secret '$($meta.name)' ($(Type-Label $meta)) can't call the $(if ($gh) { 'GitHub' } else { 'GitLab' }) API." }
    $headers = $auth.api
    function Mr-Call([string]$method, [string]$u, $body) {
      $params = @{ Method = $method; Uri = $u; Headers = $headers; UseBasicParsing = $true }
      if ($null -ne $body) { $params['Body'] = $Utf8.GetBytes((ConvertTo-Json -Compress -InputObject $body)); $params['ContentType'] = 'application/json; charset=utf-8' }
      try { return Invoke-RestMethod @params } catch {
        $err = $_; $code = ''; $msg = ''
        try { $code = [int]$err.Exception.Response.StatusCode } catch {}
        try { $msg = [string]$err.ErrorDetails.Message; $j = $msg | ConvertFrom-Json; if ($j.message) { $msg = [string]$j.message } elseif ($j.error) { $msg = [string]$j.error } } catch {}
        if (-not $msg) { $msg = $err.Exception.Message }
        Fail "$method $u failed$(if ($code) { " ($code)" }): $msg"
      }
    }
    if ($dir -and $me -ne 'ty') { Emit $dir 'tool' $me 'all' "mr $sub ($($meta.name)) $url" (O 'task') }
    if ($sub -eq 'show') {
      $files = New-Object System.Collections.ArrayList
      if ($gh) {
        $pr = Mr-Call 'GET' $base $null
        for ($pg = 1; $pg -le 10; $pg++) {
          $page = @(Mr-Call 'GET' "$base/files?per_page=100&page=$pg" $null)
          foreach ($f in $page) { if ($null -eq $f) { continue }; [void]$files.Add([pscustomobject][ordered]@{ path = [string]$f.filename; status = [string]$f.status; additions = [int]$f.additions; deletions = [int]$f.deletions; diff = [string]$f.patch }) }
          if ($page.Count -lt 100) { break }
        }
        $info = [ordered]@{ provider = 'github'; title = [string]$pr.title; state = $(if ($pr.merged) { 'merged' } else { [string]$pr.state }); author = [string]$pr.user.login; web_url = [string]$pr.html_url; source = [string]$pr.head.ref; target = [string]$pr.base.ref }
      } else {
        $mr = Mr-Call 'GET' "$base/changes" $null
        foreach ($c in (Arr $mr.changes)) {
          $d = [string]$c.diff; $add = 0; $del = 0
          foreach ($ln in ($d -split "`n")) { if ($ln.StartsWith('+') -and -not $ln.StartsWith('+++')) { $add++ } elseif ($ln.StartsWith('-') -and -not $ln.StartsWith('---')) { $del++ } }
          $st = if ($c.new_file) { 'added' } elseif ($c.deleted_file) { 'removed' } elseif ($c.renamed_file) { 'renamed' } else { 'modified' }
          [void]$files.Add([pscustomobject][ordered]@{ path = [string]$c.new_path; status = $st; additions = $add; deletions = $del; diff = $d })
        }
        $info = [ordered]@{ provider = 'gitlab'; title = [string]$mr.title; state = [string]$mr.state; author = [string]$mr.author.username; web_url = [string]$mr.web_url; source = [string]$mr.source_branch; target = [string]$mr.target_branch }
      }
      $info['files'] = @($files)
      if (O 'json') { Write-Output (ConvertTo-Json -InputObject $info -Depth 6 -Compress); exit 0 }
      Write-Output "$($info.title)  [$($info.state)] by $($info.author)  $($info.source) -> $($info.target)"
      Write-Output $info.web_url
      foreach ($f in $files) { Write-Output ("  +{0,-5} -{1,-5} {2}" -f $f.additions, $f.deletions, $f.path) }
      exit 0
    }
    if ($sub -eq 'approve') {
      if ($gh) { [void](Mr-Call 'POST' "$base/reviews" @{ event = 'APPROVE' }) } else { [void](Mr-Call 'POST' "$base/approve" $null) }
      $what = "$(if ($gh) { 'PR' } else { 'MR' }) approved: $url"
    } else {
      $text = Rest 3; if (-not $text) { Fail 'Empty comment' }
      if ($gh) { [void](Mr-Call 'POST' "$base/reviews" @{ event = (O 'event' 'REQUEST_CHANGES').ToUpperInvariant(); body = $text }) } else { [void](Mr-Call 'POST' "$base/notes" @{ body = $text }) }
      $what = "Changes requested: $text"
    }
    $tid = O 'task'
    if ($dir -and $tid) { [void](Tasks-Change $dir { param($t) $x = Find-Task $t ([string]$tid); Task-History $x $me $what; $null }) }
    Write-Output 'ok'
  }

  'say' {
    $dir = Find-Project; $me = Me
    $text = Rest 1
    # Multi-line text: hp.cmd goes through cmd.exe, which cuts arguments at the first line break. So a
    # message with lines comes from a file (--file <path>, UTF-8) or from stdin (... | hp say --to x --stdin).
    $mf = O 'file'
    if ($mf) {
      if (-not (Test-Path -LiteralPath $mf)) { Fail "No such file: $mf" }
      # UTF-8 (with or without BOM); a file saved in the Windows code page (Set-Content in PowerShell 5.1) is read as that.
      $bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $mf).Path)
      try { $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($bytes) } catch { $text = [Text.Encoding]::Default.GetString($bytes) }
      $text = $text.TrimStart([char]0xFEFF).Trim()
    }
    elseif (O 'stdin') { $text = ([Console]::In.ReadToEnd()).Trim() }
    # Polish letters lost on the way (a pipe from Windows PowerShell 5.1 sends "?" for them): refuse, do not post "Potrzebuj? ustale?".
    if ($text -notmatch '://' -and ([regex]::Matches($text, '\p{L}\?\p{L}')).Count -ge 2) { Fail 'The message lost its Polish letters (they arrived as "?"). Write it to a UTF-8 file ([IO.File]::WriteAllText($p, $text, [Text.UTF8Encoding]::new($false))) and send it with --file <path>.' }
    if (-not $text) { Fail 'Empty message' }
    $to = O 'to' 'all'; $task = O 'task'; $thread = [string](O 'thread' '')
    # --reply <m-id>: answer that message in its thread, to its sender (unless --to says otherwise).
    $rp = O 'reply'
    if ($rp) {
      $orig = Msg-Get $dir $rp
      if ($null -eq (O 'to')) { $to = [string]$orig.from }
      if (-not $thread) { $thread = Thread-Key $orig; if (-not $thread) { $thread = "m$($orig.id)" } }
      if (-not $task -and $orig.task) { $task = $orig.task }
    }
    $ack = [bool](O 'ack')
    if ($ack -and $to -eq 'all') { Fail '--ack works with --to <agent> (a direct message).' }
    Emit $dir 'message' $me $to $text $task $thread $ack
    Write-Output $(if ($ack -or $rp -or $thread) { "ok m$($script:LastEmitId)$(if ($ack) { ' (ack requested; hp sent --as ' + $me + ' shows receipts)' })" } else { 'ok' })
  }
  # hp thread <id>: the whole conversation of a thread (a task id, a name, or m<id> of its first message).
  'thread' {
    $dir = Find-Project; $id = (P 1 'thread id (task number, name or m<id>)').TrimStart('#')
    $list = Events-Query "project = ?1 AND (thread = ?2 OR (task = ?2 AND type = 'message') OR ('m' || id) = ?2)" @((Slug-Of $dir), $id) ([int](O 'tail' 100))
    if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($list) -Depth 4); return }
    if (-not $list.Count) { Write-Output "(no messages in thread $id)"; return }
    foreach ($m in $list) {
      $t = ([datetime]$m.ts).ToLocalTime().ToString('MM-dd HH:mm')
      $to = if ($m.to -and $m.to -ne 'all') { " -> $($m.to)" } else { ' -> team' }
      $rc = ''
      if ($m.PSObject.Properties['ack'] -and $m.ack) { $r = Msg-Receipts $dir $m; $rc = " [ack: $(if ($r.acked.Count) { $r.acked -join ',' } else { 'pending' })]" }
      Write-Output "[$t] m$($m.id) $($m.from)$to$rc`: $($m.text)"
    }
  }
  # hp ack <m-id...> --as <me>: acknowledge messages (the sender sees it in hp sent; an ack request is answered).
  'ack' {
    $dir = Find-Project; $me = Me; $slug = Slug-Of $dir
    $ids = @($Pos | Select-Object -Skip 1 | ForEach-Object { List $_ } | ForEach-Object { $_.TrimStart('m', 'M', '#') } | Where-Object { $_ })
    if (-not $ids.Count) { Fail 'Give message ids: hp ack m123 [m124 ...] --as <me>' }
    foreach ($n in $ids) {
      $m = Msg-Get $dir $n
      [void](Db 'INSERT OR IGNORE INTO acks (project, msg_id, agent, ts) VALUES (?1, ?2, ?3, ?4)' @($slug, [string]$m.id, $me, (Now-Iso)))
      if ($m.PSObject.Properties['ack'] -and $m.ack -and $m.from -ne $me) { Emit $dir 'ack' $me ([string]$m.from) "ack m$($m.id): $(Clip-Text ([string]$m.text) 80)" $m.task (Thread-Key $m) }
    }
    Write-Output 'ok'
  }
  # hp sent --as <me>: my recent messages with read receipts (seen = the recipient's inbox moved past it) and acks.
  'sent' {
    $dir = Find-Project; $me = Me
    $list = Events-Query "project = ?1 AND sender = ?2 AND type = 'message'" @((Slug-Of $dir), $me) ([int](O 'tail' 10))
    if (-not $list.Count) { Write-Output '(nothing sent)'; return }
    $out = @()
    foreach ($m in $list) {
      $r = Msg-Receipts $dir $m
      $out += [pscustomobject][ordered]@{ id = "m$($m.id)"; ts = $m.ts; to = $m.to; thread = (Thread-Key $m); text = $m.text; ack_requested = [bool]($m.PSObject.Properties['ack'] -and $m.ack); seen = $r.seen; acked = $r.acked; unseen = @($r.to | Where-Object { -not (Has $r.seen $_) }) }
    }
    if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($out) -Depth 4); return }
    foreach ($o in $out) {
      $t = ([datetime]$o.ts).ToLocalTime().ToString('HH:mm')
      $state = "seen: $(if ($o.seen.Count) { $o.seen -join ',' } else { '-' })$(if ($o.unseen.Count) { '; not yet: ' + ($o.unseen -join ',') })$(if ($o.ack_requested -or $o.acked.Count) { '; acked: ' + $(if ($o.acked.Count) { $o.acked -join ',' } else { 'pending' }) })"
      Write-Output "[$t] $($o.id) -> $($o.to)$(if ($o.thread) { ' {' + $o.thread + '}' }): $(Clip-Text ([string]$o.text) 80)  [$state]"
    }
  }
  # hp ready --as <me>: the next unblocked tasks for me (mine + unassigned team tasks), best first.
  'ready' {
    $dir = Find-Project; $all = [bool](O 'all'); $me = if ($all) { [string](O 'as' '') } else { Me }
    $t = Tasks-Load $dir
    $list = Ready-Tasks $t $me $all
    $n = [int](O 'limit' 10)
    if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($list | Select-Object -First $n | ForEach-Object { [pscustomobject][ordered]@{ id = $_.id; title = $_.title; agent = $_.agent; priority = $_.priority; machine = $_.machine; discovered_from = $_.discovered_from } }) -Depth 4); return }
    $doing = @($t.tasks | Where-Object { $_.status -eq 'doing' -and $_.agent -eq $me })
    if ($doing.Count -and -not $all) { Write-Output "In progress (finish or block it first): $(($doing | ForEach-Object { '#' + $_.id + ' ' + $_.title }) -join '; ')" }
    if (-not $list.Count) {
      $blocked = @($t.tasks | Where-Object { $_.status -ne 'done' -and ($all -or $_.agent -eq $me -or (Is-Pool $_)) -and ((Waits-For $t $_).Count -or $_.status -eq 'blocked') })
      Write-Output "(nothing ready$(if ($blocked.Count) { "; $($blocked.Count) waiting on dependencies or blocked: hp task list" }))"
      return
    }
    foreach ($x in ($list | Select-Object -First $n)) {
      $extra = @(); if ($x.priority -and $x.priority -ne 'normal') { $extra += "!$($x.priority)" }; if ($x.machine) { $extra += "@$($x.machine)" }
      if (Is-Pool $x) { $extra += '[team]' } elseif ($all -or $x.agent -ne $me) { $extra += "[$($x.agent)]" }
      if ($x.PSObject.Properties['discovered_from'] -and $x.discovered_from) { $extra += "from #$($x.discovered_from)" }
      Write-Output ("#{0}  {1}  {2}" -f $x.id, ($extra -join ' '), $x.title)
    }
    if (-not $all) { Write-Output "-- claim one: hp task claim <id> --as $me (atomic; fails if someone else took it)" }
  }
  # File reservations: hp reserve <glob...> --as <me> [--ttl 60] [--exclusive] [--task id] [--reason ".."] [--force]
  'reserve' {
    $dir = Find-Project; $me = Me
    $pats = @($Pos | Select-Object -Skip 1 | Where-Object { $_ } | ForEach-Object { Glob-Norm $_ })
    if (-not $pats.Count) { Fail 'Give paths or globs (relative to the repository root): hp reserve src/auth/** --as <me>' }
    $ttl = [int](O 'ttl' $ResTtl); if ($ttl -lt 1 -or $ttl -gt 1440) { Fail '--ttl is minutes, 1-1440' }
    $ex = $null -ne (O 'exclusive'); $task = ([string](O 'task' '')).TrimStart('#'); $reason = [string](O 'reason' '')
    $script:res = $null
    With-Lock $dir {
      $list = Res-Load $dir
      $conf = Res-Conflicts $list $me $pats $ex
      if ($conf.Count -and -not (O 'force')) { $script:res = @{ conflicts = $conf }; return }
      $next = 1 + [int](@(Arr (Read-Json (Res-Path $dir) @())) + @($list) | ForEach-Object { [int]$_.id } | Measure-Object -Maximum).Maximum
      $exp = (Get-Date).ToUniversalTime().AddMinutes($ttl).ToString('yyyy-MM-ddTHH:mm:ssZ')
      $granted = @()
      foreach ($g in $pats) {
        # Renewing my own reservation of the same pattern keeps its id.
        $old = $list | Where-Object { $_.agent -eq $me -and $_.pattern -eq $g } | Select-Object -First 1
        if ($old) { $old.expires = $exp; $old.exclusive = $ex; if ($task) { Set-Prop $old 'task' $task }; if ($reason) { Set-Prop $old 'reason' $reason }; $granted += $old; continue }
        $r = [pscustomobject][ordered]@{ id = $next; pattern = $g; agent = $me; exclusive = $ex; task = $task; reason = $reason; created = (Now-Iso); expires = $exp }
        $next++; $list = @($list) + @($r); $granted += $r
      }
      Write-Json (Res-Path $dir) @($list)
      $script:res = @{ granted = $granted; conflicts = $conf }
    }
    if ($script:res.granted) {
      foreach ($r in $script:res.granted) { Write-Output "reserved $(Res-Line $r)" }
      if ($script:res.conflicts.Count) { Write-Output "warning: forced over $(($script:res.conflicts | ForEach-Object { 'r' + $_.id + ' ' + $_.pattern + ' (' + $_.agent + ')' }) -join ', ')" }
      Emit $dir 'tool' $me 'all' "reserved $($pats -join ', ')$(if ($ex) { ' (exclusive)' }) for ${ttl}m$(if ($reason) { ': ' + $reason })" $task
    } else {
      foreach ($r in $script:res.conflicts) { [Console]::Error.WriteLine("hp: conflict: $(Res-Line $r)") }
      Fail "Not reserved: another agent holds overlapping files. Coordinate (hp say --to <agent> --task <id>), pick other work, wait for expiry, or reserve shared (no --exclusive). --force overrides."
    }
  }
  'release' {
    $dir = Find-Project; $me = Me
    $pats = @($Pos | Select-Object -Skip 1 | Where-Object { $_ })
    $n = Res-Release $dir $me ([string](O 'task' '')).TrimStart('#') $pats
    Write-Output "released $n"
  }
  # hp reservations [--json] | --check <file...> --as <me> (files reserved by another agent; exit 2 when any)
  'reservations' {
    $dir = Find-Project
    if ($null -ne (O 'check')) {
      $me = Me; $files = @($Pos | Select-Object -Skip 1 | ForEach-Object { List $_ })
      $hits = Res-Hits $dir $me $files
      if ($hits.Count) { $hits | ForEach-Object { Write-Output "reserved by another agent: $_" }; exit 2 }
      Write-Output 'no conflicts'; return
    }
    $list = Res-Load $dir
    if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($list) -Depth 4); return }
    if (-not $list.Count) { Write-Output '(no active reservations)'; return }
    $list | ForEach-Object { Write-Output (Res-Line $_) }
  }
  # hp route "<task title>": suggested owners from agent cards (skills, role) and availability.
  'route' {
    $dir = Find-Project; $title = Rest 1
    if (-not $title) { Fail 'Give a task title: hp route "<title>"' }
    $r = Route-Of $dir $title
    if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($r) -Depth 4); return }
    if (-not $r.Count) { Write-Output '(no agents)'; return }
    foreach ($x in ($r | Select-Object -First 3)) { Write-Output ("{0}  score {1}  [{2}, {3}, {4} open]  {5}" -f $x.agent, $x.score.ToString([Globalization.CultureInfo]::InvariantCulture), $x.engine, $x.status, $x.open, $(if ($x.why) { 'matches: ' + $x.why } else { 'no skill match' })) }
    Write-Output "-- assign: hp task add --as <you> --for $($r[0].agent) `"$title`"   (or --for auto)"
  }
  'log' {
    $dir = Find-Project; $me = Me
    $text = Rest 1
    if (-not $text) { Fail 'Empty entry' }
    Emit $dir (O 'type' 'tool') $me 'all' $text (O 'task')
    Write-Output 'ok'
  }
  'chat' {
    $dir = Find-Project
    Print-Events (Events-Query 'project = ?1' @((Slug-Of $dir)) ([int](O 'tail' 30)))
  }
  'events' {
    $dir = Find-Project
    $since = [string](O 'since' '0')
    $list = Events-Query 'project = ?1 AND id > ?2' @((Slug-Of $dir), $since) ([int](O 'tail' 500))
    if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($list) -Depth 4) } else { Print-Events $list }
  }
  'feed' { $dir = Find-Project; Feed-Rebuild $dir; Write-Output 'ok' }
  'inbox' {
    $dir = Find-Project; $me = Me
    $new = Inbox $dir $me $true
    if ($new.Count -eq 0) { Write-Output '(no new messages)' } else { Print-Inbox $dir $me $new }
  }
  'wait' {
    $dir = Find-Project; $me = Me
    $deadline = (Get-Date).AddSeconds([int](O 'timeout' 600))
    while ((Get-Date) -lt $deadline) {
      $new = Inbox $dir $me $false
      if ($new.Count -gt 0) { Print-Inbox $dir $me (Inbox $dir $me $true); exit 0 }
      Start-Sleep -Seconds 3
    }
    Write-Output '(nothing new)'
  }

  # Team memory (table memories in herdr.db, see "memory" above). Decisions are memories of kind decision;
  # DECISIONS.md is generated from them for humans.
  'decide' {
    $dir = Find-Project; $me = Me
    $text = ((Rest 1) -replace '\r?\n', ' ').Trim()
    if (-not $text) { Fail 'Give the decision: hp decide "<text>" --as <me> [--task <id>]' }
    $tk = ([string](O 'task' '')).TrimStart('#')
    Mem-Migrate $dir
    $body = if ($text.Length -gt 200) { $text } else { '' }
    $id = Mem-Add $dir 'decision' $text $body ([string](O 'tags' '')) $tk $me ([bool](O 'global'))
    Mem-Files $dir
    Emit $dir 'system' $me 'all' "Decision: $text" $(if ($tk) { $tk } else { $null })
    Write-Output "ok (m$id)"
  }
  'decisions' {
    $dir = Find-Project; Mem-Migrate $dir
    $t = Read-Text (Join-Path $dir 'DECISIONS.md')
    if ($t -and $t -match '(?m)^- ') { Write-Output $t.TrimEnd() } else { Write-Output '(no decisions yet; record one with hp decide)' }
  }
  'remember' {
    $dir = Find-Project; $me = Me
    $title = ((P 1 'title') -replace '\r?\n', ' ').Trim()
    $body = if ($Pos.Count -gt 2) { (@($Pos | Select-Object -Skip 2) -join ' ') } else { [string](O 'body' '') }
    $kind = [string](O 'kind' 'note')
    if ($MemKinds -notcontains $kind) { Fail "Kind: $($MemKinds -join ', ')" }
    $tk = ([string](O 'task' '')).TrimStart('#')
    Mem-Migrate $dir
    $sup = ([string](O 'supersedes' '')).TrimStart('m', '#')
    if ($sup -and -not (Mem-Get $sup)) { Fail "No memory m$sup" }
    $id = Mem-Add $dir $kind $title $body ([string](O 'tags' '')) $tk $me ([bool](O 'global'))
    if ($sup) { [void](Db 'UPDATE memories SET superseded_by = ?1 WHERE id = ?2' @([string]$id, $sup)) }
    Mem-Files $dir
    Emit $dir 'system' $me 'all' "Remembered m$id [$kind]$(if (O 'global') { ' (global)' }): $title$(if ($sup) { ' (replaces m' + $sup + ')' })" $(if ($tk) { $tk } else { $null })
    Write-Output "m$id"
  }
  # One compact pack for a fresh start: tasks, decisions, gotchas, patterns and the last session note.
  'recall' {
    $dir = Find-Project; $me = Me; $slug = Slug-Of $dir
    Mem-Migrate $dir
    $p = Load-Project $dir
    $t = Tasks-Load $dir
    $ord = @{ doing = 0; blocked = 1; review = 2; todo = 3; backlog = 4 }
    $mine = @($t.tasks | Where-Object { $_.agent -eq $me -and $_.status -ne 'done' } | Sort-Object { $ord[[string]$_.status] }, { [int]$_.id })
    $topic = (Rest 1).Trim()
    $q = if ($topic) { $topic } else { (@($mine | Select-Object -First 2 | ForEach-Object { $_.title }) -join ' ') }
    $words = Mem-Words $q
    Write-Output "== recall$(if ($topic) { ': ' + $topic }) | project $($p.name) | you: $me ($(Risk-Of $dir $me)) =="
    Write-Output '-- your open tasks --'
    if (-not $mine.Count) { Write-Output "  (none; hp task list, or ask the lead)" }
    foreach ($x in @($mine | Select-Object -First 8)) {
      $st = $StatusName[[string]$x.status]; if ($x.status -eq 'doing' -and $x.progress) { $st += " $($x.progress)%" }
      Write-Output "  #$($x.id) [$st] $($x.title)$(if ($x.blocked_reason) { ' -- waiting: ' + $x.blocked_reason })$(if ($x.PSObject.Properties['evidence'] -and $x.evidence) { ' -- evidence given' })"
    }
    if ($words.Count) {
      $rel = @(foreach ($x in $t.tasks) {
        if ($x.status -eq 'done' -or $x.agent -eq $me) { continue }
        $s = 0; $tt = "$($x.title) $($x.desc)".ToLowerInvariant(); foreach ($w in $words) { if ($tt.Contains($w)) { $s++ } }
        if ($s) { [pscustomobject]@{ x = $x; s = $s } }
      })
      $rel = @($rel | Sort-Object @{ Expression = { $_.s }; Descending = $true } | Select-Object -First 5)
      if ($rel.Count) { Write-Output '-- related open tasks --'; foreach ($r in $rel) { Write-Output "  #$($r.x.id) [$($StatusName[[string]$r.x.status])] $($r.x.agent): $($r.x.title)" } }
    }
    $vis = Mem-Visible $slug $false
    $dec = @($vis | Where-Object { $_.kind -eq 'decision' })
    $show = @($dec | Select-Object -First 5)
    $ids = @($show | ForEach-Object { $_.id }); $m3 = Mem-Match $dec $q 3
    $more = @($m3 | Where-Object { $ids -notcontains $_.id })
    Write-Output "-- decisions ($($dec.Count); newest$(if ($more.Count) { ' + matching' })) --"
    if (-not $dec.Count) { Write-Output '  (none yet)' }
    foreach ($m in @($show + $more)) { Write-Output (Mem-Line $m) }
    foreach ($k in @('gotcha', 'pattern')) {
      $all = @($vis | Where-Object { $_.kind -eq $k })
      $hit = Mem-Match $all $q 5
      $label = if ($hit.Count) { 'matching' } else { 'latest' }
      if (-not $hit.Count) { $hit = @($all | Select-Object -First $(if ($k -eq 'gotcha') { 3 } else { 2 })) }
      Write-Output "-- $($k)s ($($all.Count)$(if ($all.Count) { '; ' + $label })) --"
      foreach ($m in $hit) { Write-Output (Mem-Line $m) }
    }
    Write-Output '-- your last session --'
    $note = @($vis | Where-Object { $_.kind -eq 'note' -and $_.author -eq $me } | Select-Object -First 1)
    if ($note.Count) { Write-Output (Mem-Line $note[0]) } else { Write-Output '  (no session note; leave one with hp reflect)' }
    $ho = Join-Path $dir "handoff\$me.txt"
    if (Test-Path -LiteralPath $ho) { Write-Output "  terminal handoff: handoff/$me.txt ($((Get-Item -LiteralPath $ho).LastWriteTime.ToString('yyyy-MM-dd HH:mm')))" }
    $ap = Db "SELECT id, status, what FROM approvals WHERE project = ?1 AND agent = ?2 AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT 5" @($slug, $me)
    if ($ap.Count) { Write-Output '-- your approvals --'; foreach ($r in $ap) { Write-Output "  #$($r[0]) [$($r[1])] $($r[2])" } }
    Write-Output '-- next: hp inbox; hp task start <id>; hp search "<words>" for more; hp remember for new gotchas --'
  }
  'search' {
    $dir = Find-Project; Mem-Migrate $dir
    $q = (Rest 1).Trim(); if (-not $q) { Fail 'Give words: hp search "<words>" [--kind gotcha] [--all]' }
    $list = Mem-Visible (Slug-Of $dir) ([bool](O 'all'))
    $k = O 'kind'; if ($k) { $list = @($list | Where-Object { $_.kind -eq $k }) }
    $hits = Mem-Match $list $q ([int](O 'limit' 15))
    if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($hits) -Depth 4); return }
    if (-not $hits.Count) { Write-Output "(nothing found for: $q)"; return }
    foreach ($m in $hits) { Write-Output "$(Mem-Line $m)$(if ($m.superseded_by) { ' [replaced by m' + $m.superseded_by + ']' })" }
  }
  'reflect' {
    $dir = Find-Project; $me = Me
    $notes = (Rest 1).Trim(); if (-not $notes) { Fail 'Give the notes: hp reflect "<done, next, open questions>" --as <me> [--task <id>]' }
    $tk = ([string](O 'task' '')).TrimStart('#')
    if (-not $tk) {
      $t = Tasks-Load $dir
      foreach ($st in @('doing', 'blocked', 'review')) { $c = @($t.tasks | Where-Object { $_.agent -eq $me -and $_.status -eq $st }); if ($c.Count) { $tk = [string]$c[0].id; break } }
    }
    Mem-Migrate $dir
    $id = Mem-Add $dir 'note' "Session note $((Get-Date).ToString('yyyy-MM-dd HH:mm'))$(if ($tk) { ' on #' + $tk })" $notes ([string](O 'tags' '')) $tk $me $false
    Mem-Files $dir
    Emit $dir 'system' $me 'all' "Session note m$id$(if ($tk) { ' on #' + $tk })" $(if ($tk) { $tk } else { $null })
    Write-Output "m$id"
  }
  'forget' {
    $dir = Find-Project; $me = Me
    $id = ([string](P 1 'memory id')).TrimStart('m', '#')
    $mm = Mem-Get $id; if (-not $mm) { Fail "No memory m$id" }
    if ($mm.scope -ne 'global' -and $mm.project -ne (Slug-Of $dir)) { Fail "Memory m$id belongs to project $($mm.project)" }
    [void](Db 'DELETE FROM memories WHERE id = ?1' @($id))
    [void](Db 'UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?1' @($id))
    Mem-Files $dir
    Emit $dir 'system' $me 'all' "Forgot m$id [$($mm.kind)]: $($mm.title)" $null
    Write-Output 'ok'
  }

  # Approvals (table approvals; see "risk levels and approvals" above).
  'ask' {
    $dir = Find-Project; $me = Me
    $what = ((Rest 1) -replace '\r?\n', ' ').Trim()
    if (-not $what) { Fail 'Say what and why: hp ask "<what and why>" --as <me> [--cmd "<command>"] [--task <id>]' }
    $id = Approval-New $dir $me $what ([string](O 'cmd' ''))
    Write-Output "#$id"
    Write-Output "Asked ty. Next: hp wait-approval $id --as $me$(if (O 'cmd') { '; when approved, run the command with --approved ' + $id })"
  }
  { $_ -eq 'approve' -or $_ -eq 'reject' } {
    $who = O 'as'; if (-not $who) { $who = $env:HERDR_AGENT }
    if ($who -and $who -ne 'ty') { Fail 'Only the human (ty) approves or rejects.' }
    $id = (P 1 'approval id').TrimStart('#')
    $a = Approval-Get $id
    if (-not $a) { Fail "No approval #$id" }
    if ($a.status -ne 'pending') { Fail "Approval #$id is already $($a.status)." }
    $st = if ($cmd -eq 'approve') { 'approved' } else { 'rejected' }
    $note = ([string](O 'note' '')).Trim()
    [void](Db 'UPDATE approvals SET status = ?2, decided_by = ?3, decided_ts = ?4, note = ?5 WHERE id = ?1' @($id, $st, 'ty', (Now-Iso), $note))
    $pdir = Join-Path $ProjRoot $a.project
    # An epic plan (hp epic submit): Approve moves its tasks to To Do, Reject = "Revise" sends the note to the lead.
    $ep = $null
    if (Test-Path -LiteralPath $pdir) { $ep = (Tasks-Load $pdir).tasks | Where-Object { (Is-Epic $_) -and $_.PSObject.Properties['plan_approval'] -and [string]$_.plan_approval -eq $id } | Select-Object -First 1 }
    if ($ep) {
      $eid = [string]$ep.id
      if ($st -eq 'approved') {
        $n = Epic-Approve $pdir $eid 'ty' $note
        [void](Db "UPDATE approvals SET status = 'used', used_ts = ?2 WHERE id = ?1" @($id, (Now-Iso)))
        Emit $pdir 'message' 'ty' $a.agent "Approved #${id}: the plan of epic #$eid $($ep.title). $n task$(if ($n -ne 1) { 's' }) moved to To Do. Coordinate them as they progress$(if ($note) { ' -- ' + $note })." $eid
      } else {
        [void](Tasks-Change $pdir { param($t) $e = Find-Task $t $eid; Set-Prop $e 'plan' 'revise'; if ($e.status -eq 'backlog') { $e.status = 'todo' }; Set-Prop $e 'plan_note' $note; Task-History $e 'ty' "plan sent back for revision$(if ($note) { ': ' + $note })"; $null })
        Emit $pdir 'message' 'ty' $a.agent "Rejected #${id} (revise): the plan of epic #$eid $($ep.title)$(if ($note) { ': ' + $note } else { ' (ty asked for changes; ask what to change if unclear)' }). Change its tasks (hp task set / rm / add --epic $eid), then hp epic submit $eid --as $($a.agent) again." $eid
      }
      Write-Output $st
      return
    }
    $msg = if ($st -eq 'approved') { "Approved #${id}: $($a.what)$(if ($a.cmd) { '. Run it once with --approved ' + $id })$(if ($note) { ' -- ' + $note })" } else { "Rejected #${id}: $($a.what). Do not do it$(if ($note) { ' -- ' + $note } else { '; tell me the alternative' })." }
    if (Test-Path -LiteralPath $pdir) { Emit $pdir 'message' 'ty' $a.agent $msg $a.task }
    Write-Output $st
  }
  'wait-approval' {
    $id = (P 1 'approval id').TrimStart('#')
    $deadline = (Get-Date).AddSeconds([int](O 'timeout' 600))
    while ($true) {
      $a = Approval-Get $id
      if (-not $a) { Fail "No approval #$id" }
      if ($a.status -eq 'approved') { Write-Output "approved$(if ($a.note) { ': ' + $a.note })$(if ($a.cmd) { '. Run the same command once more with --approved ' + $id })"; exit 0 }
      if ($a.status -eq 'rejected') { Write-Output "rejected$(if ($a.note) { ': ' + $a.note }). Do not do it; propose an alternative to ty."; exit 1 }
      if ($a.status -eq 'used') { Write-Output "already used at $($a.used_ts)"; exit 1 }
      if ((Get-Date) -ge $deadline) { Write-Output "still pending; run hp wait-approval $id again (or keep working on something else)"; exit 2 }
      Start-Sleep -Seconds 3
    }
  }
  'approvals' {
    $dir = Find-Project
    $w = if (O 'all') { 'project = ?1' } else { "project = ?1 AND status IN ('pending', 'approved')" }
    $rows = Db "SELECT id FROM approvals WHERE $w ORDER BY id DESC LIMIT 50" @((Slug-Of $dir))
    $list = @($rows | ForEach-Object { Approval-Get ([string]$_[0]) })
    if (O 'json') { Write-Output (ConvertTo-Json -InputObject $list -Depth 4); return }
    if (-not $list.Count) { Write-Output '(no open approval requests)'; return }
    foreach ($a in $list) { Write-Output "#$($a.id) [$($a.status)] $($a.agent): $($a.what)$(if ($a.cmd) { ' | ' + $a.cmd })" }
  }

  # Machine locks (~/.herdr/locks.json, shared by all projects).
  'lock' {
    $vm = P 1 'machine name'; $me = Me
    $reason = (Rest 2).Trim(); if (-not $reason) { $reason = [string](O 'reason' '') }
    if (-not $reason) { Fail 'Say why: hp lock <vm> "<reason>" --as <me> [--ttl 30]' }
    $ttl = [int](O 'ttl' 30); if ($ttl -lt 1) { $ttl = 1 }
    $dir = Try-Find-Project; $slug = if ($dir) { Slug-Of $dir } else { '' }
    $exp = (Get-Date).ToUniversalTime().AddMinutes($ttl).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $script:lockErr = $null
    With-Lock $HerdrHome {
      $list = @(Locks-Load)
      $cur = $list | Where-Object { $_.vm -eq $vm } | Select-Object -First 1
      if ($cur -and -not (Lock-Mine $cur $me $slug) -and -not (O 'force')) { $script:lockErr = Lock-Text $cur; return }
      Locks-Save (@($list | Where-Object { $_.vm -ne $vm }) + @([pscustomobject][ordered]@{ vm = $vm; owner = $me; project = $slug; reason = $reason; since = (Now-Iso); expires = $exp }))
    }
    if ($script:lockErr) { Fail $script:lockErr }
    $until = ([datetime]$exp).ToLocalTime().ToString('HH:mm')
    if ($dir) { Emit $dir 'system' $me 'all' "Locked $vm until ${until}: $reason" (O 'task') }
    Write-Output "ok: $vm locked until $until"
  }
  'unlock' {
    $vm = P 1 'machine name'; $me = Me
    $dir = Try-Find-Project; $slug = if ($dir) { Slug-Of $dir } else { '' }
    $script:lockErr = $null; $script:hadLock = $false
    With-Lock $HerdrHome {
      $list = @(Locks-Load)
      $cur = $list | Where-Object { $_.vm -eq $vm } | Select-Object -First 1
      if (-not $cur) { return }
      if (-not (Lock-Mine $cur $me $slug) -and $me -ne 'ty' -and -not (O 'force')) { $script:lockErr = "$(Lock-Text $cur). Only $($cur.owner) can unlock it."; return }
      $script:hadLock = $true
      Locks-Save @($list | Where-Object { $_.vm -ne $vm })
    }
    if ($script:lockErr) { Fail $script:lockErr }
    if ($script:hadLock -and $dir) { Emit $dir 'system' $me 'all' "Unlocked $vm" $null }
    Write-Output $(if ($script:hadLock) { 'ok' } else { "$vm was not locked" })
  }
  'locks' {
    $list = @(Locks-Load)
    if (O 'json') { Write-Output (ConvertTo-Json -InputObject $list -Depth 4); return }
    if (-not $list.Count) { Write-Output '(no locks)'; return }
    foreach ($l in $list) { Write-Output (Lock-Text $l) }
  }

  'task' {
    $dir = Find-Project
    switch ($sub) {
      'add' {
        $me = Me
        $title = Rest 2
        if (-not $title) { Fail 'Give a task title' }
        # --kind epic: a big goal the lead breaks into tasks (hp epic plan); it belongs to the lead unless --for says otherwise.
        $kind = [string](O 'kind' ''); if ($kind -and $kind -ne 'epic' -and $kind -ne 'task') { Fail 'Kind: task or epic' }
        $isEpic = ($kind -eq 'epic')
        $epicId = ([string](O 'epic' '')).TrimStart('#')
        if ($isEpic -and $epicId) { Fail 'An epic cannot belong to another epic.' }
        $owner = O 'for' $(if ($isEpic) { $ld = Lead-Of $dir; if ($ld) { $ld } else { $me } } else { $me })
        # --for team: unassigned (anyone claims it from hp ready); --for auto: best match from hp route.
        if ($owner -eq 'any') { $owner = 'team' }
        if ($owner -eq 'auto') { $rt = Route-Of $dir $title; $owner = if ($rt.Count -and $rt[0].match -gt 0) { [string]$rt[0].agent } else { 'team' } }
        if ($owner -ne 'team' -and $owner -ne 'ty' -and @(Agents-Load $dir).Count -and -not (Find-Agent $dir $owner)) { [Console]::Error.WriteLine("hp: warning: no agent $owner in this project yet (hp agent list; --for team = unassigned)") }
        $prio = O 'priority' 'normal'; if ($Priorities -notcontains $prio) { Fail "Priority: $($Priorities -join ', ')" }
        $st = O 'status' 'todo'; if ($Statuses -notcontains $st) { Fail "Status: $($Statuses -join ', ')" }
        # A task of an epic whose plan is not approved yet waits in the Backlog (hp epic submit moves it on approval).
        if ($epicId) {
          $ep0 = Find-Task (Tasks-Load $dir) $epicId
          if (-not (Is-Epic $ep0)) { Fail "#$epicId is not an epic" }
          if (-not (O 'status')) { $st = if ((Epic-Plan $ep0) -eq 'approved') { 'todo' } else { 'backlog' } }
        }
        $machine = O 'machine' ''; $desc = O 'desc' ''
        $after = @(List (O 'after') | ForEach-Object { [int]($_.TrimStart('#')) })
        $from = ([string](O 'discovered-from' '')).TrimStart('#')
        $id = Tasks-Change $dir {
          param($t)
          foreach ($d in $after) { [void](Find-Task $t ([string]$d)) }
          $parent = if ($from) { Find-Task $t $from } else { $null }
          $id = [int]$t.next
          $t.next = $id + 1
          $x = [pscustomobject][ordered]@{ id = $id; title = $title; desc = $desc; agent = $owner; status = $st; priority = $prio; progress = 0; machine = $machine
            by = $me; created = (Now-Iso); started = $null; completed = $null; updated = (Now-Iso); blocked_reason = ''; notes = @(); history = @(); after = @($after) }
          if ($isEpic) { Set-Prop $x 'kind' 'epic'; Set-Prop $x 'plan' '' }
          if ($epicId) { Set-Prop $x 'epic' ([int]$epicId) }
          # Discovered work (Beads "discovered-from"): lineage only, it does not block anything.
          if ($parent) { Set-Prop $x 'discovered_from' ([int]$from); Task-History $parent $me "discovered #$id $title" }
          Task-History $x $me "created for $owner ($($StatusName[$st]))$(if ($after.Count) { ', after ' + (($after | ForEach-Object { '#' + $_ }) -join ', ') })$(if ($parent) { ', discovered while working on #' + $from })"
          $t.tasks = @($t.tasks) + @($x)
          $id
        }
        if ($isEpic) {
          # The lead plans it: a direct task event (the app nudges a live lead; a stopped one is started for it).
          $toE = if ($owner -eq 'team' -or $owner -eq $me) { 'all' } else { $owner }
          Emit $dir 'task' $me $toE "New epic #${id}: $title. Break it into tasks: hp epic plan $id --as $(if ($owner -eq 'team') { '<lead>' } else { $owner })" $id
        } elseif ($epicId -and $st -eq 'backlog') {
          # Planned, not approved yet: logged for the team, the owner is told when ty approves the plan.
          Emit $dir 'task' $me 'all' "Planned #${id}: $title for $owner (epic #$epicId, waits for plan approval)" $id
        } else {
          Emit $dir 'task' $me $(if ($owner -eq 'team') { 'all' } else { $owner }) "New task #${id}: $title$(if ($owner -eq 'team') { ' (unassigned: claim it with hp task claim ' + $id + ')' } elseif ($owner -ne $me) { ' (from ' + $me + ')' })$(if ($from) { ' - discovered in #' + $from })$(if ($epicId) { ' - epic #' + $epicId })" $id
        }
        Write-Output "#$id$(if ((O 'for') -eq 'auto' -or ($isEpic -and -not (O 'for'))) { ' for ' + $owner })"
      }
      'list' {
        $t = Tasks-Load $dir
        $list = @($t.tasks)
        $all = [bool](O 'all')
        if ($all) { $list += @(Tasks-Archived $dir | ForEach-Object { Set-Prop $_ 'status' 'done'; $_ }) }
        $for = O 'for'; if ($for) { $list = @($list | Where-Object { $_.agent -eq $for }) }
        if (O 'json') { Write-Output (ConvertTo-Json -InputObject $list -Depth 6); return }
        # --tree: the tasks of an epic are listed under it (and not again in their columns).
        $tree = [bool](O 'tree')
        if ($tree) { $eids = @($t.tasks | Where-Object { Is-Epic $_ } | ForEach-Object { [string]$_.id }); $list = @($list | Where-Object { -not (Has $eids (Epic-Of $_)) }) }
        foreach ($st in @('doing', 'review', 'blocked', 'todo', 'backlog', 'done')) {
          $part = @($list | Where-Object { $_.status -eq $st })
          # Done: only the last 10 unless --all (keeps the list readable with hundreds of tasks).
          if ($st -eq 'done' -and -not $all -and $part.Count -gt 10) {
            $more = $part.Count - 10
            $part = @($part | Sort-Object { [string]$_.completed }, { [int]$_.id } | Select-Object -Last 10)
            Write-Output "== done (last 10 of $($part.Count + $more); --all for every task, archived too) =="
            $part | ForEach-Object { Write-Output ("#{0}  [{1}]  {2}" -f $_.id, $_.agent, $_.title) }
            continue
          }
          if ($part.Count) {
            Write-Output "== $($StatusName[$st]) =="
            foreach ($x in $part) {
              $extra = @(); if ($x.machine) { $extra += "@$($x.machine)" }; if ($x.priority -and $x.priority -ne 'normal') { $extra += "!$($x.priority)" }
              if ($st -eq 'doing' -and $x.progress) { $extra += "$($x.progress)%" }; if ($st -eq 'blocked' -and $x.blocked_reason) { $extra += "waiting: $($x.blocked_reason)" }
              if ($st -ne 'done' -and ([string]$x.blocked_reason) -notlike 'waiting for #*') { $w = Waits-For $t $x; if ($w.Count) { $extra += "waits for $(($w | ForEach-Object { '#' + $_ }) -join ',')" } }
              $kids = @()
              if (Is-Epic $x) {
                $kids = Epic-Kids $t ([string]$x.id)
                $extra = @("EPIC $(@($kids | Where-Object { $_.status -eq 'done' }).Count)/$($kids.Count)$(if ((Epic-Plan $x) -eq 'pending') { ' plan pending' } elseif ((Epic-Plan $x) -eq 'revise') { ' plan: revise' } elseif (-not $kids.Count) { ' not planned' })") + $extra
              } elseif (Epic-Of $x) { $extra += "epic #$(Epic-Of $x)" }
              Write-Output ("#{0}  [{1}] {2}  {3}" -f $x.id, $x.agent, ($extra -join ' '), $x.title)
              if ($tree) { foreach ($k in $kids) { Write-Output ("      - #{0}  [{1}] {2}  {3}" -f $k.id, $k.agent, $StatusName[[string]$k.status], $k.title) } }
            }
          }
        }
      }
      'show' {
        $t = Tasks-Load $dir; $want = (P 2 'task number').TrimStart('#')
        $x = $t.tasks | Where-Object { [string]$_.id -eq $want } | Select-Object -First 1
        if (-not $x) { $x = Archived-Task $dir $want; if ($x) { Write-Output "(archived on $(Exp-Str $x.archived): done long ago)" } }
        if (-not $x) { Fail "No such task #$want" }
        Write-Output "#$($x.id) $($x.title)"
        Write-Output "agent: $($x.agent) | status: $($StatusName[$x.status]) | priority: $($x.priority) | progress: $($x.progress)% | machine: $($x.machine)"
        if ($x.desc) { Write-Output $x.desc }
        if ($x.blocked_reason) { Write-Output "blocked: $($x.blocked_reason)" }
        $lh = Lease-Holder $x; if ($lh) { Write-Output "claimed by $lh until $(([datetime]$x.lease.until).ToLocalTime().ToString('HH:mm'))" }
        if ($x.PSObject.Properties['discovered_from'] -and $x.discovered_from) { Write-Output "discovered while working on #$($x.discovered_from)" }
        if (Epic-Of $x) { $ep = $t.tasks | Where-Object { [string]$_.id -eq (Epic-Of $x) } | Select-Object -First 1; Write-Output "epic: #$(Epic-Of $x)$(if ($ep) { ' ' + $ep.title })" }
        if (Is-Epic $x) {
          $ek = Epic-Kids $t ([string]$x.id)
          Write-Output "EPIC: $(@($ek | Where-Object { $_.status -eq 'done' }).Count)/$($ek.Count) tasks done$(if (Epic-Plan $x) { ', plan ' + (Epic-Plan $x) }) (hp epic show $($x.id))"
          foreach ($k in $ek) { Write-Output ("  - #{0} [{1}] {2}  {3}" -f $k.id, $k.agent, $StatusName[[string]$k.status], $k.title) }
        }
        $kids = @($t.tasks | Where-Object { $_.PSObject.Properties['discovered_from'] -and [string]$_.discovered_from -eq [string]$x.id })
        if ($kids.Count) { Write-Output ("discovered here: " + (($kids | ForEach-Object { "#$($_.id) $($_.title) ($($StatusName[$_.status]))" }) -join '; ')) }
        $rs = @(Res-Load $dir | Where-Object { [string]$_.task -eq [string]$x.id }); if ($rs.Count) { Write-Output ("files reserved: " + (($rs | ForEach-Object { "$($_.pattern) ($($_.agent))" }) -join ', ')) }
        if (@(Arr $x.after).Count) { Write-Output ("after: " + ((Arr $x.after | ForEach-Object { $d = $_; $y = $t.tasks | Where-Object { [string]$_.id -eq [string]$d } | Select-Object -First 1; "#$d $(if ($y) { $y.title + ' (' + $StatusName[$y.status] + ')' } else { '(deleted)' })" }) -join '; ')) }
        Write-Output '-- history --'
        foreach ($h in (Arr $x.history)) { Write-Output ("{0} {1}: {2}" -f ([datetime]$h.ts).ToLocalTime().ToString('MM-dd HH:mm'), $h.by, $h.text) }
        foreach ($n in (Arr $x.notes)) { Write-Output ("note {0}: {1}" -f $n.by, $n.text) }
        Write-Output '-- chat --'
        Print-Events (Events-Query 'project = ?1 AND task = ?2' @((Slug-Of $dir), [string]$x.id) 30)
      }
      { @('start', 'done', 'todo', 'backlog', 'block', 'review') -contains $_ } {
        $me = Me; $id = P 2 'task number'
        $status = @{ start = 'doing'; done = 'done'; todo = 'todo'; backlog = 'backlog'; block = 'blocked'; review = 'review' }[$sub]
        $note = O 'note'; $reason = O 'reason' ''; $evidence = ([string](O 'evidence' '')).Trim()
        if ($sub -eq 'block' -and -not $reason) { Fail 'Pass --reason "what you are waiting for"' }
        # hp task start <id> --source <name>: the task's own git worktree + branch (created once, reused after).
        $srcName = O 'source'
        if ($sub -eq 'start' -and $srcName) {
          $src = Find-Source (Load-Project $dir) $srcName
          $wtx = (Find-Task (Tasks-Load $dir) $id).worktree
          if (-not ($wtx -and $wtx.source -eq $src.name -and $wtx.path -and -not $wtx.pruned -and ($wtx.machine -or (Test-Path -LiteralPath $wtx.path)))) {
            $wtx = Worktree-Create $dir $src (Find-Task (Tasks-Load $dir) $id)
            [void](Tasks-Change $dir { param($t) $y = Find-Task $t $id; Set-Prop $y 'worktree' $wtx; Task-History $y $me "worktree $($wtx.branch) at $(if ($wtx.machine) { $wtx.machine + ':' })$($wtx.path)"; $null })
          }
          Write-Output "worktree: $(if ($wtx.machine) { $wtx.machine + ':' })$($wtx.path)"
          Write-Output "branch: $($wtx.branch)"
          if ($wtx.machine) { Write-Output "work there: hp ssh $($wtx.machine) --as $me `"cd $($wtx.path) && ...`"" } else { Write-Output "cd `"$($wtx.path)`"" }
        }
        $title = Tasks-Change $dir {
          param($t)
          $x = Find-Task $t $id
          $x.status = $status
          Set-Prop $x 'blocked_reason' $(if ($status -eq 'blocked') { $reason } else { '' })
          # --wait marcel: blocked on the human (his Mailbox shows it); anything else: on the team (it does not).
          $wv = ([string](O 'wait' '')).Trim().ToLowerInvariant()
          Set-Prop $x 'waits' $(if ($status -ne 'blocked') { '' } elseif (@('marcel', 'ty', 'human', 'me') -contains $wv -or $reason -match '(?i)^\s*czeka\w*\s+na\s+marcel') { 'ty' } else { 'team' })
          if ($status -eq 'doing' -and -not $x.started) { Set-Prop $x 'started' (Now-Iso) }
          # Claim lease: In Progress holds one (renewed by progress/note); any other status drops it.
          if ($status -eq 'doing') { Set-Lease $x $me $LeaseMin } elseif ($x.PSObject.Properties['lease']) { $x.lease = $null }
          if ($status -eq 'done') { Set-Prop $x 'completed' (Now-Iso); Set-Prop $x 'progress' 100 }
          else { Set-Prop $x 'completed' $null; if ([int]$x.progress -ge 100) { Set-Prop $x 'progress' 0 } }
          Task-History $x $me "$($StatusName[$status])$(if ($reason) { ': ' + $reason })$(if ($note) { ' - ' + $note })"
          if ($note) { Set-Prop $x 'notes' (@(Arr $x.notes) + @([pscustomobject]@{ by = $me; ts = (Now-Iso); text = $note })) }
          # Truthful reporting: evidence (test output summary) is stored on the task; missing evidence on a
          # task with commits/links is warned about below.
          if ($evidence) { Set-Prop $x 'evidence' (Clip-Text $evidence 2000); Set-Prop $x 'evidence_by' $me; Set-Prop $x 'evidence_ts' (Now-Iso); Task-History $x $me "evidence: $(Clip-Text $evidence 200)" }
          $script:noEvidence = (($status -eq 'review' -or $status -eq 'done') -and @(Arr $x.links).Count -gt 0 -and -not ($x.PSObject.Properties['evidence'] -and $x.evidence))
          $script:waits = @(); $script:unblocked = @(); $script:movedBack = @()
          if ($status -eq 'doing') { $script:waits = Waits-For $t $x }
          if ($status -eq 'done') { $script:unblocked = Unblock-Dependents $t ([string]$x.id) $me }
          $script:nx = $x
          $x.title
        }
        if ($me -eq 'ty') { Nudge-Queue $dir $script:nx 'status' $NudgeStatus[$status] }
        $n = $id.TrimStart('#')
        $msg = "#$n $title -> $($StatusName[$status])"
        if ($reason) { $msg += " (waiting: $reason)" }
        if ($note) { $msg += " ($note)" }
        Emit $dir 'task' $me 'all' $msg $n
        foreach ($y in @($script:unblocked)) { if ($y) { Emit $dir 'task' $me $y.agent "#$($y.id) $($y.title) is unblocked by #$n (all dependencies done)$(if (Has $script:movedBack ([string]$y.id)) { ' - back in To Do' })" ([string]$y.id) } }
        if ($script:waits.Count) { [Console]::Error.WriteLine("hp: warning: #$n still waits for $((@($script:waits) | ForEach-Object { '#' + $_ }) -join ', ')") }
        if ($script:noEvidence) { [Console]::Error.WriteLine("hp: warning: #$n has commits/links but no evidence. Truthful reporting: add what you ran and its result: hp task $sub $n --as $me --evidence `"<test output summary>`"") }
        # File reservations tied to this task end with it (Agent Mail: release when done).
        if ($status -eq 'done' -or $status -eq 'review') { $rn = Res-Release $dir $me $n @(); if ($rn) { Write-Output "released $rn file reservation$(if ($rn -gt 1) { 's' }) of #$n" } }
        Write-Output 'ok'
        if ($status -eq 'review') { Cross-Review $dir $n $me }
      }
      'progress' {
        $me = Me; $id = P 2 'task number'; $pct = [int](P 3 'percent 0-100')
        $pct = [Math]::Max(0, [Math]::Min(100, $pct))
        [void](Tasks-Change $dir { param($t) $x = Find-Task $t $id; Set-Prop $x 'progress' $pct; if ($x.status -eq 'todo' -or $x.status -eq 'backlog') { $x.status = 'doing'; if (-not $x.started) { Set-Prop $x 'started' (Now-Iso) } }; if ($x.status -eq 'doing' -and @('', $me) -contains (Lease-Holder $x)) { Set-Lease $x $me $LeaseMin }; $x.updated = (Now-Iso); $null })
        Write-Output 'ok'
      }
      'note' {
        $me = Me; $id = P 2 'task number'; $text = Rest 3
        [void](Tasks-Change $dir { param($t) $x = Find-Task $t $id; Set-Prop $x 'notes' (@(Arr $x.notes) + @([pscustomobject]@{ by = $me; ts = (Now-Iso); text = $text })); Task-History $x $me "note: $text"; if ($x.status -eq 'doing' -and (Lease-Holder $x) -eq $me) { Set-Lease $x $me $LeaseMin }; $null })
        Emit $dir 'task' $me 'all' "#$($id.TrimStart('#')) note: $text" $id.TrimStart('#')
        Write-Output 'ok'
      }
      'link' {
        $me = Me; $id = P 2 'task number'; $url = (P 3 'url of the commit or merge/pull request').Trim()
        if ($url -notmatch '^https?://') { Fail 'The url must start with http:// or https://' }
        $kind = O 'kind'
        if (-not $kind) { if ($url -match '/merge_requests/') { $kind = 'mr' } elseif ($url -match '/pull/') { $kind = 'pr' } else { $kind = 'commit' } }
        if (@('commit', 'mr', 'pr') -notcontains $kind) { Fail 'Kind: commit, mr or pr' }
        $ltitle = [string](O 'title' '')
        $added = Tasks-Change $dir {
          param($t)
          $x = Find-Task $t $id
          if (@(Arr $x.links | Where-Object { $_.url -eq $url }).Count) { return $false }
          Set-Prop $x 'links' (@(Arr $x.links) + @([pscustomobject][ordered]@{ url = $url; kind = $kind; title = $ltitle; by = $me; ts = (Now-Iso) }))
          Task-History $x $me "linked $kind $url"
          $true
        }
        if ($added) {
          $label = @{ commit = 'commit'; mr = 'merge request'; pr = 'pull request' }[$kind]
          Emit $dir 'task' $me 'all' "#$($id.TrimStart('#')) $label linked: $(if ($ltitle) { $ltitle } else { $url })" $id.TrimStart('#')
        }
        Write-Output 'ok'
      }
      'depends' {
        # hp task depends <id> <ids...> --as <me>   |   hp task depends <id> --clear --as <me>
        $me = Me; $id = (P 2 'task number').TrimStart('#')
        $deps = @(); if ($null -eq (O 'clear')) { $deps = @(List (Rest 3) | ForEach-Object { [int]($_.TrimStart('#')) } | Select-Object -Unique) }
        if ($null -eq (O 'clear') -and -not $deps.Count) { Fail 'Give task ids: hp task depends <id> <ids...> (or --clear)' }
        $res = Tasks-Change $dir {
          param($t)
          $x = Find-Task $t $id
          foreach ($d in $deps) {
            if ([string]$d -eq $id) { Fail "A task cannot wait for itself" }
            [void](Find-Task $t ([string]$d))
            # Cycle check: walk the chain of $d's dependencies.
            $seen = @{}; $stack = @([string]$d)
            while ($stack.Count) {
              $c = $stack[0]; $stack = @($stack | Select-Object -Skip 1)
              if ($c -eq $id) { Fail "Dependency cycle: #$d already waits (directly or not) for #$id" }
              if ($seen[$c]) { continue }; $seen[$c] = $true
              $cy = $t.tasks | Where-Object { [string]$_.id -eq $c } | Select-Object -First 1
              if ($cy) { $stack += @(Arr $cy.after | ForEach-Object { [string]$_ }) }
            }
          }
          Set-Prop $x 'after' @($deps)
          Task-History $x $me $(if ($deps.Count) { "waits for $(($deps | ForEach-Object { '#' + $_ }) -join ', ')" } else { 'dependencies cleared' })
          $x.agent
        }
        Emit $dir 'task' $me $res "#$id $(if ($deps.Count) { 'waits for ' + (($deps | ForEach-Object { '#' + $_ }) -join ', ') } else { 'has no dependencies now' })" $id
        Write-Output 'ok'
      }
      'assign' {
        $me = Me; $id = P 2 'task number'; $for = O 'for'
        if (-not $for) { Fail 'Pass --for <agent>' }
        $script:prevOwner = ''
        [void](Tasks-Change $dir { param($t) $x = Find-Task $t $id; $script:prevOwner = [string]$x.agent; $x.agent = $for; Task-History $x $me "handed over to $for"; $script:nx = $x; $null })
        if ($me -eq 'ty') {
          # The human reassigned it: logged for the team; the new owner gets one coalesced nudge (hp nudges flush).
          Emit $dir 'task' $me 'all' "Task #$($id.TrimStart('#')) assigned to $for$(if ($script:prevOwner -and $script:prevOwner -ne $for) { ' (was ' + $script:prevOwner + ')' })" $id.TrimStart('#')
          if ($script:prevOwner -ne $for) { Nudge-Queue $dir $script:nx 'assign' $for }
        } else { Emit $dir 'task' $me $for "Task #$($id.TrimStart('#')) handed over to $for" $id.TrimStart('#') }
        Write-Output 'ok'
      }
      # hp task claim <id> --as <me> [--ttl 120] [--force]: atomic take (Beads --claim): owner = me, In Progress,
      # lease for --ttl minutes. Refused when someone else holds it, it is another agent's, or it waits for deps.
      'claim' {
        $me = Me; $id = (P 2 'task number').TrimStart('#'); $min = [int](O 'ttl' $LeaseMin); $force = [bool](O 'force')
        $res = Tasks-Change $dir {
          param($t)
          $x = Find-Task $t $id
          if ($x.status -eq 'done') { Fail "#$id is done already" }
          $h = Lease-Holder $x
          if ($h -and $h -ne $me -and -not $force) { Fail "#$id is claimed by $h until $(([datetime]$x.lease.until).ToLocalTime().ToString('HH:mm')). Pick another one (hp ready --as $me) or ask $h (hp say --to $h --task $id)." }
          if (-not (Is-Pool $x) -and $x.agent -ne $me -and -not $force) { Fail "#$id belongs to $($x.agent). Ask for a handoff (hp say --to $($x.agent) --task $id) or, if $($x.agent) is stuck (see Team status in AGENTS.md), take it with --force." }
          $w = Waits-For $t $x
          if ($w.Count -and -not $force) { Fail "#$id is not ready: it waits for $(($w | ForEach-Object { '#' + $_ }) -join ', ')" }
          $prev = [string]$x.agent; $renew = ($x.status -eq 'doing' -and $prev -eq $me -and $h -eq $me)
          $x.agent = $me; $x.status = 'doing'; Set-Prop $x 'blocked_reason' ''
          if (-not $x.started) { Set-Prop $x 'started' (Now-Iso) }
          Set-Lease $x $me $min
          if (-not $renew) { Task-History $x $me "claimed (lease ${min} min)$(if ($prev -ne $me) { ', was ' + $(if (Has $PoolNames $prev) { 'unassigned' } else { $prev }) })" }
          @($x.title, $prev, $renew)
        }
        if ($res[2]) { Write-Output "renewed: #$id is yours for $min more minutes"; return }
        $msg = "#$id $($res[0]) -> in progress (claimed by $me$(if ($res[1] -and $res[1] -ne $me -and -not (Has $PoolNames $res[1])) { ', taken over from ' + $res[1] }))"
        Emit $dir 'task' $me 'all' $msg $id
        if ($res[1] -and $res[1] -ne $me -and -not (Has $PoolNames $res[1])) { Emit $dir 'task' $me $res[1] "I took over #$id $($res[0]) (hp task claim --force)." $id }
        Write-Output "claimed #$id (lease $min min; hp task progress renews it)"
      }
      # hp task release <id> --as <me> [--pool] [--note ".."]: give the claim back (To Do); --pool also unassigns it.
      'release' {
        $me = Me; $id = (P 2 'task number').TrimStart('#'); $pool = [bool](O 'pool'); $note = [string](O 'note' '')
        $res = Tasks-Change $dir {
          param($t)
          $x = Find-Task $t $id
          $h = Lease-Holder $x
          if ($x.agent -ne $me -and $h -ne $me -and @('hp', 'ty') -notcontains $me -and -not (O 'force')) { Fail "#$id is not yours ($($x.agent))." }
          $prev = [string]$x.agent
          if ($x.status -eq 'doing') { $x.status = 'todo' }
          if ($x.PSObject.Properties['lease']) { $x.lease = $null }
          if ($pool) { $x.agent = 'team' }
          Task-History $x $me "released$(if ($pool) { ' to the team (unassigned)' })$(if ($note) { ': ' + $note })"
          if ($note) { Set-Prop $x 'notes' (@(Arr $x.notes) + @([pscustomobject]@{ by = $me; ts = (Now-Iso); text = "released: $note" })) }
          @($x.title, $prev)
        }
        [void](Res-Release $dir $res[1] $id @())
        Emit $dir 'task' $me 'all' "#$id $($res[0]) released$(if ($pool) { ' to the team: anyone can claim it (hp ready)' } else { ' (back in To Do)' })$(if ($note) { ' - ' + $note })" $id
        Write-Output 'ok'
      }
      # hp task handoff <id> --to <agent> --as <me> --note "state, next step, gotchas": owner changes, the claim and
      # my file reservations of the task end, the receiver gets a direct message (ack requested) in the task thread.
      'handoff' {
        $me = Me; $id = (P 2 'task number').TrimStart('#'); $to = [string](O 'to' ''); $note = ([string](O 'note' '')).Trim()
        if (-not $to) { Fail 'Pass --to <agent> (or --to team for anyone)' }
        if (-not $note) { Fail 'Pass --note "where it stands, the next step, what to watch out for" (the receiver starts without your context)' }
        if ($to -ne 'team' -and -not (Find-Agent $dir $to)) { Fail "No agent $to in this project (hp agent list)" }
        $title = Tasks-Change $dir {
          param($t)
          $x = Find-Task $t $id
          if ($x.status -eq 'done') { Fail "#$id is done already" }
          $prev = [string]$x.agent
          $x.agent = $to
          if ($x.status -eq 'doing') { $x.status = 'todo' }
          if ($x.PSObject.Properties['lease']) { $x.lease = $null }
          Set-Prop $x 'notes' (@(Arr $x.notes) + @([pscustomobject]@{ by = $me; ts = (Now-Iso); text = "handoff to ${to}: $note" }))
          Task-History $x $me "handed off from $prev to ${to}: $note"
          $x.title
        }
        [void](Res-Release $dir $me $id @())
        if ($to -eq 'team') { Emit $dir 'task' $me 'all' "#$id $title handed to the team by $me (claim it: hp task claim $id): $note" $id }
        else { Emit $dir 'message' $me $to "Handoff #$id ${title}: $note -- Next: hp task show $id, then hp task claim $id --as $to." $id '' $true }
        Write-Output "handed #$id to $to$(if ($to -ne 'team') { " (m$($script:LastEmitId), ack requested)" })"
      }
      'set' {
        $me = Me; $id = P 2 'task number'
        $pr = O 'priority'; if ($null -ne $pr -and $Priorities -notcontains $pr) { Fail "Priority: $($Priorities -join ', ')" }
        $script:prioChanged = $false
        [void](Tasks-Change $dir { param($t) $x = Find-Task $t $id; if ($null -ne $pr -and [string]$x.priority -ne $pr) { $script:prioChanged = $true }; foreach ($k in @('title', 'desc', 'priority', 'machine')) { $v = O $k; if ($null -ne $v) { Set-Prop $x $k $v } }; Task-History $x $me $(if ($script:prioChanged) { "priority: $pr" } else { 'edited' }); $script:nx = $x; $null })
        if ($me -eq 'ty' -and $script:prioChanged) { Nudge-Queue $dir $script:nx 'priority' $pr }
        Write-Output 'ok'
      }
      'rm' {
        $id = P 2 'task number'
        [void](Tasks-Change $dir { param($t) $n = $id.TrimStart('#'); $t.tasks = @($t.tasks | Where-Object { [string]$_.id -ne $n }); $null })
        Write-Output 'ok'
      }
      default { Fail 'hp task add|list|show|start|claim|release|handoff|progress|review|block|done|todo|backlog|note|link|depends|assign|set|rm' }
    }
  }

  # Epics: hp epic plan|show|submit|list (an epic = hp task add --kind epic; its tasks: hp task add --epic <id>).
  'epic' {
    $dir = Find-Project
    $epicOf = {
      param($t, [string]$raw)
      $id = $raw.TrimStart('#'); $e = Find-Task $t $id
      if (-not (Is-Epic $e)) { Fail "#$id is not an epic (hp task add --kind epic creates one)" }
      $e
    }
    $kidLine = {
      param($t, $k)
      $w = @(Arr $k.after | ForEach-Object { '#' + $_ })
      ("  #{0} [{1}] {2}{3}  {4}" -f $k.id, $k.agent, $StatusName[[string]$k.status], $(if ($w.Count) { ' after ' + ($w -join ',') } else { '' }), $k.title)
    }
    switch ($sub) {
      'plan' {
        $me = Me; $t = Tasks-Load $dir; $e = & $epicOf $t (P 2 'epic id'); $id = [string]$e.id
        $kids = Epic-Kids $t $id; $plan = Epic-Plan $e
        Write-Output "Epic #$id $($e.title)  (lead: $($e.agent), priority: $($e.priority), plan: $(if ($plan) { $plan } else { 'not submitted' }))"
        if ($e.desc) { Write-Output $e.desc }
        if ($plan -eq 'revise' -and $e.plan_note) { Write-Output "ty asked to revise the plan: $($e.plan_note)" }
        if ($plan -eq 'pending') { Write-Output "The plan waits for ty's approval (approval #$($e.plan_approval)): hp wait-approval $($e.plan_approval) --as $me" }
        Write-Output "-- tasks so far ($($kids.Count)) --"
        if ($kids.Count) { foreach ($k in $kids) { Write-Output (& $kidLine $t $k) } } else { Write-Output '  (none yet)' }
        Write-Output '-- team (agent cards: give each task to the agent whose skills fit) --'
        $stat = Status-Fresh $dir
        foreach ($a in (Agents-Load $dir)) { $c = Card-Of $dir $a $t $stat; Write-Output "  $($c.name) ($($c.engine)$(if ($c.role) { ', ' + $c.role })$(if ($c.lead) { ', lead' })): $(if ($c.skills.Count) { 'skills ' + ($c.skills -join ', ') + '; ' })$(if ($c.desc) { $c.desc + '; ' })$($c.open) open, $($c.status)" }
        Write-Output @"
-- how to plan --
1. Split the epic into small, verifiable tasks: one owner and one outcome each, a few hours of work at most.
2. Add each one: hp task add --as $me --epic $id --for <agent> [--after <ids>] [--priority high] --desc "Done when: <check>" "<title>"
   Every task says how "done" is verified. Order them with --after (hp task depends <id> <ids> later).
   They stay in Backlog until the plan is approved; nobody starts them yet.
3. Submit: hp epic submit $id --as $me. ty approves it in the Mailbox (Approve / Revise); autonomous leads are approved at once.
4. After approval the tasks are in To Do and run the normal way (hp ready / claim). The epic follows its tasks and
   closes itself when all are done; then send ty a short summary: hp say --to ty --task $id --as $me "...".
"@
      }
      'show' {
        $t = Tasks-Load $dir; $e = & $epicOf $t (P 2 'epic id'); $id = [string]$e.id
        $kids = Epic-Kids $t $id; $done = @($kids | Where-Object { $_.status -eq 'done' }).Count
        if (O 'json') { Write-Output (ConvertTo-Json -InputObject ([ordered]@{ epic = $e; tasks = @($kids) }) -Depth 6); return }
        Write-Output "Epic #$id $($e.title)  [$($StatusName[[string]$e.status])]  lead: $($e.agent)  plan: $(if (Epic-Plan $e) { Epic-Plan $e } else { 'not submitted' })"
        if ($kids.Count) { $w = 20; $f = [int][Math]::Round($w * $done / $kids.Count); Write-Output ("progress: [{0}{1}] {2}/{3} done" -f ('#' * $f), ('.' * ($w - $f)), $done, $kids.Count) }
        if ($e.desc) { Write-Output $e.desc }
        if ($kids.Count) { foreach ($k in $kids) { Write-Output (& $kidLine $t $k) } } else { Write-Output "  (no tasks yet: hp epic plan $id --as <lead>)" }
      }
      'list' {
        $t = Tasks-Load $dir
        $eps = @($t.tasks | Where-Object { Is-Epic $_ })
        if (-not $eps.Count) { Write-Output '(no epics: hp task add --kind epic "<goal>")'; return }
        foreach ($e in $eps) { $kids = Epic-Kids $t ([string]$e.id); Write-Output ("#{0}  [{1}] {2} {3}/{4}{5}  {6}" -f $e.id, $e.agent, $StatusName[[string]$e.status], @($kids | Where-Object { $_.status -eq 'done' }).Count, $kids.Count, $(if (Epic-Plan $e) { ' plan ' + (Epic-Plan $e) } else { '' }), $e.title) }
      }
      'submit' {
        $me = Me; $t = Tasks-Load $dir; $e = & $epicOf $t (P 2 'epic id'); $id = [string]$e.id
        $kids = Epic-Kids $t $id
        if (-not $kids.Count) { Fail "Epic #$id has no tasks yet. Add them first: hp task add --as $me --epic $id --for <agent> [--after <ids>] --desc `"Done when: ...`" `"<title>`" (see hp epic plan $id --as $me)" }
        if ((Epic-Plan $e) -eq 'pending') { Fail "The plan of #$id already waits for ty (approval #$($e.plan_approval)): hp wait-approval $($e.plan_approval) --as $me" }
        $level = Risk-Of $dir $me
        if ($level -eq 'autonomous' -or $level -eq 'human') {
          $n = Epic-Approve $dir $id $me $(if ($level -eq 'human') { '' } else { 'auto-approved (autonomous lead)' })
          Emit $dir 'task' $me 'all' "Epic #$id $($e.title): plan of $($kids.Count) tasks approved$(if ($level -eq 'autonomous') { ' (autonomous lead, no ty approval needed)' }); $n moved to To Do" $id
          Write-Output "approved: $n task$(if ($n -ne 1) { 's' }) moved to To Do (your risk level is $level, so no approval was needed)"
          return
        }
        $lines = @($kids | ForEach-Object { "#$($_.id) $($_.title) ($($_.agent)$(if (@(Arr $_.after).Count) { ', after ' + ((Arr $_.after | ForEach-Object { '#' + $_ }) -join ',') }))" })
        $Opt['task'] = $id
        $aid = Approval-New $dir $me "Epic plan #${id} $($e.title): $($kids.Count) task$(if ($kids.Count -ne 1) { 's' }) - $($lines -join '; ')" ''
        [void](Tasks-Change $dir { param($t) $x = Find-Task $t $id; Set-Prop $x 'plan' 'pending'; Set-Prop $x 'plan_approval' ([int64]$aid); if ($x.status -eq 'todo') { $x.status = 'backlog' }; Task-History $x $me "plan of $($kids.Count) tasks sent to ty for approval (#$aid)"; $null })
        Write-Output "#$aid"
        Write-Output "The plan went to ty for approval. Next: hp wait-approval $aid --as $me (Approve moves the tasks to To Do; Revise comes back to you with a note)."
      }
      default { Fail 'hp epic plan|show|submit|list <id> (create one: hp task add --kind epic "<goal>"; its tasks: hp task add --epic <id> ...)' }
    }
  }
  # hp nudges flush [--wait 5] [--json]: sends the queued owner nudges (the human's task changes) whose last change
  # is at least --wait seconds old, one direct message per task; prints them (the app nudges idle terminals).
  'nudges' {
    $dir = Find-Project; $np = Join-Path $dir 'nudges.json'; $wait = [int](O 'wait' 5)
    $now = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $script:due = @()
    if ($sub -eq 'flush') {
      With-Lock $dir {
        $q = Read-Json $np $null
        if ($null -eq $q) { return }
        $keep = [pscustomobject]@{}; $nk = 0
        foreach ($pp in @($q.PSObject.Properties)) {
          if ($now - [int64]$pp.Value.ts -ge $wait * 1000) { $script:due += [pscustomobject]@{ id = ([string]$pp.Name).TrimStart('t'); e = $pp.Value } } else { Set-Prop $keep $pp.Name $pp.Value; $nk++ }
        }
        if ($script:due.Count) { if ($nk) { Write-Json $np $keep } else { Remove-Item -LiteralPath $np -Force -ErrorAction SilentlyContinue } }
      }
    } else { $q = Read-Json $np $null; if ($q) { Write-Output (ConvertTo-Json -InputObject $q -Depth 5) } else { Write-Output '{}' }; return }
    $t = Tasks-Load $dir; $out = @()
    foreach ($d in $script:due) {
      $x = $t.tasks | Where-Object { [string]$_.id -eq $d.id } | Select-Object -First 1
      if (-not $x -or $x.status -eq 'done' -or (Has $PoolNames ([string]$x.agent)) -or $x.agent -eq 'ty') { continue }
      $c = $d.e.changes; $bits = @()
      if ($c.PSObject.Properties['priority'] -and $c.priority -eq $x.priority) { $bits += "is now $($c.priority)" }
      if ($c.PSObject.Properties['status'] -and $c.status -eq $NudgeStatus[[string]$x.status]) { $bits += "moved to $($c.status)" }
      $mine = $c.PSObject.Properties['assign'] -and $c.assign -eq $x.agent
      if (-not $mine -and [string]$d.e.agent -ne [string]$x.agent) { continue } # reassigned again since: the new owner's own entry tells it
      if (-not $mine -and -not $bits.Count) { continue }
      $text = if ($mine) { "#$($x.id) $($x.title) was assigned to you$(if ($bits.Count) { ' (' + (($bits | ForEach-Object { $_ -replace '^is now ', 'now ' }) -join ', ') + ')' })." }
        elseif ($bits.Count -eq 1) { "#$($x.id) $($x.title) $($bits[0])." }
        else { "#$($x.id) $($x.title): $(($bits | ForEach-Object { $_ -replace '^is now ', 'now ' }) -join ', ')." }
      $text += " See: hp task show $($x.id) --as $($x.agent)"
      Emit $dir 'message' 'ty' ([string]$x.agent) $text ([string]$x.id)
      $out += [pscustomobject][ordered]@{ agent = [string]$x.agent; task = [int]$x.id; text = $text }
    }
    if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($out) -Depth 3 -Compress) } else { foreach ($o in $out) { Write-Output "$($o.agent): $($o.text)" } }
  }

  'agent' {
    $dir = Find-Project
    switch ($sub) {
      'join' {
        $name = Slugify (P 2 'agent name')
        $risk = [string](O 'risk' 'balanced'); if ($RiskLevels -notcontains $risk) { Fail "Risk: $($RiskLevels -join ', ')" }
        $entry = [pscustomobject][ordered]@{ name = $name; role = (O 'role' ''); app = (O 'app' 'claude'); machines = @(List (O 'machines')); sudo = @(List (O 'sudo')); risk = $risk; skills = @(List (O 'skills')); desc = [string](O 'desc' ''); joined = (Now-Iso) }
        With-Lock $dir { Write-Json (Agents-Path $dir) (@(Agents-Load $dir | Where-Object { $_.name -ne $name }) + @($entry)) }
        $known = Db 'SELECT 1 FROM reads WHERE project = ?1 AND agent = ?2' @((Slug-Of $dir), $name)
        if (-not $known.Count) { Mark-Read $dir $name }
        Emit $dir 'system' 'hp' 'all' "Agent $name joined$(if ($entry.role) { ' - ' + $entry.role })." $null
        Write-AgentDocs $dir # the "Team messages" section names the lead
        Write-Output $name
      }
      'set' {
        $name = P 2 'agent name'
        $ld = O 'lead'
        if ($null -ne $ld -and $ld -ne 'on' -and $ld -ne 'off') { Fail 'Use --lead on|off' }
        if ($null -ne $ld -and -not (Find-Agent $dir $name)) { Fail "No agent $name in this project" }
        $risk = O 'risk'
        if ($null -ne $risk -and $RiskLevels -notcontains $risk) { Fail "Use --risk $($RiskLevels -join '|')" }
        if ($null -ne $risk -and -not (Find-Agent $dir $name)) { Fail "No agent $name in this project" }
        $riskBefore = if ($null -ne $risk) { Risk-Of $dir $name } else { $null }
        $leadBefore = Lead-Of $dir
        With-Lock $dir {
          $list = Agents-Load $dir
          foreach ($a in $list) {
            # One lead per project: "--lead on" takes the flag from everyone else.
            if ($ld -eq 'on' -and $a.name -ne $name -and $a.PSObject.Properties['lead']) { Set-Prop $a 'lead' $false }
            if ($a.name -eq $name) {
              if ($null -ne (O 'machines')) { $a.machines = @(List (O 'machines')) }
              if ($null -ne (O 'sudo')) { Set-Prop $a 'sudo' @(List (O 'sudo')) }
              if ($null -ne (O 'skills')) { Set-Prop $a 'skills' @(List (O 'skills')) }
              foreach ($k in @('role', 'app', 'desc')) { $v = O $k; if ($null -ne $v) { Set-Prop $a $k $v } }
              $ar = O 'autorestart'; if ($null -ne $ar) { Set-Prop $a 'autorestart' ($ar -eq 'on') }
              if ($null -ne $ld) { Set-Prop $a 'lead' ($ld -eq 'on') }
              if ($null -ne $risk) { Set-Prop $a 'risk' $risk }
            }
          }
          Write-Json (Agents-Path $dir) @($list)
        }
        if ($null -ne $risk -and $risk -ne $riskBefore) { Emit $dir 'system' 'hp' $name "Risk level of $name is now $risk (see Sacred boundaries in AGENTS.md)." $null }
        if ($null -ne $ld -or $null -ne (O 'role') -or $null -ne $risk) {
          $leadNow = Lead-Of $dir
          if ($leadNow -ne $leadBefore) { Emit $dir 'system' 'hp' 'all' "$leadNow is now the team lead (answers team messages)." $null }
          Write-AgentDocs $dir
        }
        Write-Output 'ok'
      }
      'list' {
        # Live status comes from status.json (written by the app every 30 s).
        $stat = Read-Json (Join-Path $dir 'status.json') $null
        $fresh = $stat -and $stat.updated -and (((Get-Date).ToUniversalTime() - [datetime]::Parse($stat.updated).ToUniversalTime()).TotalMinutes -lt 3)
        Write-Output "AGENT`tSTATUS`tFOR`tOPEN TASKS`tAPP`tROLE`tMACHINES`tRISK"
        $lead = Lead-Of $dir
        foreach ($a in (Agents-Load $dir)) {
          $ms = if (@($a.machines).Count) { @($a.machines) -join ',' } else { 'all project machines' }
          $stv = 'unknown'; $for = ''; $open = ''
          if ($fresh -and $stat.agents.PSObject.Properties[$a.name]) {
            $x = $stat.agents.($a.name); $stv = $x.status; $open = $x.open
            if ($x.since) { $m = [int](((Get-Date).ToUniversalTime() - [datetime]::Parse($x.since).ToUniversalTime()).TotalMinutes); $for = if ($m -ge 60) { "$([int]($m / 60))h" } else { "${m}m" } }
          }
          $role = if ($a.name -eq $lead) { "[lead] $($a.role)".TrimEnd() } else { $a.role }
          Write-Output ("{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}`t{7}" -f $a.name, $stv, $for, $open, $a.app, $role, $ms, (Risk-Of $dir $a.name))
        }
      }
      'rm' {
        $name = P 2 'agent name'
        With-Lock $dir { Write-Json (Agents-Path $dir) @(Agents-Load $dir | Where-Object { $_.name -ne $name }) }
        Write-AgentDocs $dir
        Write-Output 'ok'
      }
      'lead' { Write-Output (Lead-Of $dir) }
      # hp agent card [<name>] [--skills a,b] [--desc ".."] [--json]: show (all without a name) or set an agent card.
      'card' {
        $name = if ($Pos.Count -gt 2) { [string]$Pos[2] } else { [string](O 'as' '') }
        if ($name -and ($null -ne (O 'skills') -or $null -ne (O 'desc'))) {
          if (-not (Find-Agent $dir $name)) { Fail "No agent $name in this project" }
          With-Lock $dir {
            $list = Agents-Load $dir
            foreach ($a in $list) { if ($a.name -eq $name) { if ($null -ne (O 'skills')) { Set-Prop $a 'skills' @(List (O 'skills')) }; if ($null -ne (O 'desc')) { Set-Prop $a 'desc' ([string](O 'desc')) } } }
            Write-Json (Agents-Path $dir) @($list)
          }
          Write-AgentDocs $dir
        }
        $t = Tasks-Load $dir; $stat = Status-Fresh $dir
        $only = $Pos.Count -gt 2 -or $null -ne (O 'skills') -or $null -ne (O 'desc')
        $cards = @(Agents-Load $dir | Where-Object { -not $only -or $_.name -eq $name } | ForEach-Object { Card-Of $dir $_ $t $stat })
        if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($cards) -Depth 4); return }
        foreach ($c in $cards) {
          Write-Output "$($c.name)$(if ($c.lead) { ' [lead]' }) - $($c.engine)$(if ($c.role) { ', ' + $c.role }) | $($c.status), $($c.open) open$(if ($c.doing.Count) { ' (doing ' + (($c.doing | ForEach-Object { '#' + $_ }) -join ',') + ')' }) | risk $($c.risk)"
          Write-Output "  skills: $(if ($c.skills.Count) { $c.skills -join ', ' } else { '(none: hp agent card ' + $c.name + ' --skills a,b)' })$(if ($c.desc) { ' | ' + $c.desc })"
        }
      }
      default { Fail 'hp agent join|set|list|card|lead|rm' }
    }
  }

  # Retention and cleanup (see "maintenance" above). Global: every project.
  'source' {
    # Code sources (repositories) of the project: hp source add|list|show|set|status|rm.
    $dir = Find-Project
    $p = Load-Project $dir
    switch ($sub) {
      'add' {
        $name = P 2 'source name'
        if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { Fail 'Source name: letters, digits, . _ - (no spaces)' }
        if (@(Sources-Of $p | Where-Object { $_.name -eq $name }).Count) { Fail "Source '$name' already exists (hp source set $name ...)" }
        $s = [pscustomobject][ordered]@{ name = $name; kind = ''; url = ''; branch = 'main'; secret = ''; locations = @() }
        Source-Apply $s
        Set-Prop $p 'sources' @(@(Sources-Of $p) + @($s))
        Save-Project $dir $p; Write-AgentDocs $dir
        Emit $dir 'system' 'hp' 'all' "Source $name added ($($s.kind))." $null
        Write-Output 'ok'
      }
      'set' {
        $s = Find-Source $p (P 2 'source name')
        Source-Apply $s
        Set-Prop $p 'sources' @(Sources-Of $p)
        Save-Project $dir $p; Write-AgentDocs $dir
        Write-Output 'ok'
      }
      'rm' {
        $name = P 2 'source name'; [void](Find-Source $p $name)
        Set-Prop $p 'sources' @(Sources-Of $p | Where-Object { $_.name -ne $name })
        Save-Project $dir $p; Write-AgentDocs $dir
        Emit $dir 'system' 'hp' 'all' "Source $name removed (files and worktrees are not touched)." $null
        Write-Output 'ok'
      }
      'list' {
        if (O 'json') { Write-Output (ConvertTo-Json -InputObject @(Sources-Of $p) -Depth 6 -Compress); exit 0 }
        if (-not (Sources-Of $p).Count) { Write-Output '(no sources; hp source add <name> --url ... | --local <folder> | --vm machine:/path)' }
        foreach ($s in (Sources-Of $p)) { Write-Output ("{0}`t{1}`t{2}`t{3}`t{4}" -f $s.name, $s.kind, $s.branch, $s.url, (@(Arr $s.locations | ForEach-Object { Loc-Text $_ }) -join '; ')) }
      }
      'show' {
        $s = Find-Source $p (P 2 'source name')
        if (O 'json') { Write-Output (ConvertTo-Json -InputObject $s -Depth 6 -Compress); exit 0 }
        Write-Output "$($s.name) ($($s.kind))$(if ($s.url) { ' ' + $s.url })"
        Write-Output "default branch: $($s.branch)$(if ($s.secret) { ' | secret: ' + $s.secret })"
        foreach ($l in (Arr $s.locations)) { Write-Output "  $(Loc-Text $l)" }
        $wts = @((Tasks-Load $dir).tasks | Where-Object { $_.worktree -and $_.worktree.source -eq $s.name })
        foreach ($x in $wts) { Write-Output "  task #$($x.id) $($x.worktree.branch)$(if ($x.worktree.pruned) { ' (worktree pruned)' } else { ' -> ' + $(if ($x.worktree.machine) { $x.worktree.machine + ':' }) + $x.worktree.path })" }
      }
      'status' {
        # Checks every location (git status on this PC, over SSH on machines) and the remote; cached in sources-status.json for the UI.
        $want = if ($Pos.Count -gt 2) { [string]$Pos[2] } else { '' }
        $list = if ($want) { @(Find-Source $p $want) } else { @(Sources-Of $p) }
        $cachePath = Join-Path $dir 'sources-status.json'
        $results = @()
        foreach ($s in $list) { $results += [pscustomobject](Source-Status $dir $s) }
        With-Lock $dir {
          $cache = Read-Json $cachePath $null; if ($null -eq $cache) { $cache = [pscustomobject]@{} }
          foreach ($r in $results) { Set-Prop $cache $r.name $r }
          foreach ($k in @($cache.PSObject.Properties.Name)) { if (-not @(Sources-Of $p | Where-Object { $_.name -eq $k }).Count) { $cache.PSObject.Properties.Remove($k) } }
          Write-Text $cachePath (ConvertTo-Json -InputObject $cache -Depth 8 -Compress)
        }
        if (O 'json') { Write-Output (ConvertTo-Json -InputObject @($results) -Depth 8 -Compress); exit 0 }
        foreach ($r in $results) {
          Write-Output $r.name
          foreach ($l in $r.locations) {
            $where = if ($l.type -eq 'local') { "local $($l.path)" } else { "$($l.machine):$($l.path)" }
            if (-not $l.ok) { Write-Output "  $where  ERROR: $($l.error)"; continue }
            $ab = if ($null -ne $l.ahead) { "  ahead $($l.ahead), behind $($l.behind)" } else { '  (no upstream)' }
            Write-Output "  $where  [$($l.branch)]  $(if ($l.dirty) { "$($l.dirty) changed" } else { 'clean' })$ab  $($l.head)"
          }
          if ($r.remote) { if ($r.remote.error) { Write-Output "  remote: $($r.remote.error)" } else { Write-Output "  remote: $($r.remote.sha) $($r.remote.title) ($($r.remote.date))" } }
        }
      }
      default { Fail 'hp source add|list|show|set|status|rm' }
    }
  }

  'worktree' {
    # Task worktrees (made by hp task start --source). prune removes the folder; the branch stays.
    $dir = Find-Project
    switch ($sub) {
      'list' {
        foreach ($x in @((Tasks-Load $dir).tasks | Where-Object { $_.worktree })) {
          $w = $x.worktree
          Write-Output ("#{0}`t{1}`t{2}`t{3}" -f $x.id, $w.source, $w.branch, $(if ($w.pruned) { '(pruned)' } else { $(if ($w.machine) { $w.machine + ':' } else { '' }) + $w.path }))
        }
      }
      'prune' {
        $id = (P 2 'task number').TrimStart('#')
        $me = O 'as'; if (-not $me) { $me = $env:HERDR_AGENT }; if (-not $me) { $me = 'ty' }
        $w = (Find-Task (Tasks-Load $dir) $id).worktree
        if (-not $w -or -not $w.path) { Fail "Task #$id has no worktree." }
        if ($w.pruned) { Write-Output 'ok (already pruned)'; exit 0 }
        $s = Sources-Of (Load-Project $dir) | Where-Object { $_.name -eq $w.source } | Select-Object -First 1
        $force = [bool](O 'force')
        $hint = $(if (-not $force) { ' (uncommitted changes? add --force to drop them)' } else { '' })
        if ($w.machine) {
          $vl = if ($s) { Src-Vms $s | Where-Object { $_.machine -eq $w.machine } | Select-Object -First 1 } else { $null }
          $repo = if ($vl) { [string]$vl.path } else { [string]$w.path }
          $res = Remote-Capture $w.machine "cd $(Sh-Q $repo) && { [ ! -d $(Sh-Q $w.path) ] || git worktree remove $(if ($force) { '--force ' })$(Sh-Q $w.path); } && git worktree prune"
          if ($res.code -ne 0) { Fail "git worktree remove on $($w.machine) failed: $($res.out)$hint" }
        } else {
          $loc = if ($s) { Src-Local $s } else { $null }
          $repo = if ($loc) { [string]$loc.path } else { [string]$w.path }
          if (Test-Path -LiteralPath $w.path) {
            $ga = @('worktree', 'remove'); if ($force) { $ga += '--force' }; $ga += [string]$w.path
            $r = Git-Local $repo $ga
            if ($r.code -ne 0) { Fail "git worktree remove failed: $($r.out)$hint" }
          }
          if ($loc) { [void](Git-Local $repo @('worktree', 'prune')) }
        }
        [void](Tasks-Change $dir { param($t) $y = Find-Task $t $id; Set-Prop $y.worktree 'pruned' (Now-Iso); Task-History $y $me "worktree removed (branch $($w.branch) kept)"; $null })
        Write-Output 'ok'
      }
      'diff' {
        # Task branch vs the default branch (from the merge base), uncommitted work included.
        # --scope uncommitted: only what is not committed yet (the agent's current turn). --file <path>: one file.
        # --json: { branch, target, base, ahead, behind, dirty, files: [{ path, status, additions, deletions, diff }] }.
        $id = (P 2 'task number').TrimStart('#')
        $c = Wt-Ctx $dir $id; $w = $c.w
        $file = ([string](O 'file' '')).Trim().Replace('\', '/'); $unc = ([string](O 'scope' 'all')) -eq 'uncommitted'
        $info = [ordered]@{ task = [int]$id; branch = [string]$w.branch; target = $c.def; source = [string]$w.source; machine = [string]$w.machine; path = [string]$w.path; pruned = [bool]$w.pruned; merged = [string]$w.merged; scope = $(if ($unc) { 'uncommitted' } else { 'all' }); base = ''; ahead = 0; behind = 0; dirty = 0 }
        $untracked = @(); $lines = @()
        if ($w.machine) {
          $vl = if ($c.s) { Src-Vms $c.s | Where-Object { $_.machine -eq $w.machine } | Select-Object -First 1 } else { $null }
          $cwd = if ($c.live) { [string]$w.path } elseif ($vl) { [string]$vl.path } else { Fail "Task #${id}: the worktree was removed and the source has no checkout on $($w.machine)." }
          $h = if ($c.live) { 'HEAD' } else { [string]$w.branch }
          $sh = @'
cd __CWD__ || exit 3
H=__H__; R=__R__; F=__F__; U=__U__
git rev-parse --verify -q "refs/heads/$R" >/dev/null 2>&1 || R="origin/$R"
B=$(git merge-base "$R" "$H" 2>/dev/null) || { echo "no common base between $R and $H"; exit 4; }
echo "BASE=$B"
echo "AHEAD=$(git rev-list --count "$B..$H" 2>/dev/null)"
echo "BEHIND=$(git rev-list --count "$H..$R" 2>/dev/null)"
if [ "$H" = HEAD ]; then echo "DIRTY=$(git status --porcelain 2>/dev/null | wc -l)"; fi
echo "@@UNTRACKED"
if [ "$H" = HEAD ]; then git ls-files --others --exclude-standard 2>/dev/null; fi
echo "@@DIFF"
FROM="$B"; if [ -n "$U" ]; then FROM=HEAD; fi
T=""; if [ "$H" != HEAD ]; then T="$H"; fi
if [ -n "$F" ]; then git -c core.quotepath=off diff --no-color --no-ext-diff $FROM $T -- "$F" 2>/dev/null; else git -c core.quotepath=off diff --no-color --no-ext-diff $FROM $T 2>/dev/null; fi
'@
          $sh = $sh.Replace('__CWD__', (Sh-Q $cwd)).Replace('__H__', (Sh-Q $h)).Replace('__R__', (Sh-Q $c.def)).Replace('__F__', (Sh-Q $file)).Replace('__U__', $(if ($unc -and $h -eq 'HEAD') { '1' } else { "''" }))
          $res = Remote-Capture $w.machine $sh
          if ($res.code -ne 0) { Fail "git diff on $($w.machine) failed: $($res.out)" }
          $kv = Kv-Lines $res.out
          $info.base = [string]$kv['BASE']; $info.ahead = [int]$kv['AHEAD']; $info.behind = [int]$kv['BEHIND']; $info.dirty = [int]$kv['DIRTY']
          $part = 0
          foreach ($ln in ($res.out -split "`n")) {
            if ($ln -eq '@@UNTRACKED') { $part = 1; continue }
            if ($ln -eq '@@DIFF') { $part = 2; continue }
            if ($part -eq 1 -and $ln) { $untracked += $ln } elseif ($part -eq 2) { $lines += $ln }
          }
        } else {
          $cwd = if ($c.live -and (Test-Path -LiteralPath $w.path)) { [string]$w.path } elseif ($c.repo) { $c.repo } else { Fail "Task #${id}: the worktree was removed and the source has no local checkout." }
          $h = if ($cwd -eq [string]$w.path) { 'HEAD' } else { [string]$w.branch }
          $r = $c.def
          if ((Git-Text $cwd @('rev-parse', '--verify', '-q', "refs/heads/$r")).code -ne 0) { $r = "origin/$r" }
          $mb = Git-Text $cwd @('merge-base', $r, $h)
          if ($mb.code -ne 0 -or -not $mb.lines.Count) { Fail "No common base between $r and $h in $cwd." }
          $info.base = $mb.lines[0].Trim()
          $info.ahead = [int](@((Git-Text $cwd @('rev-list', '--count', "$($info.base)..$h")).lines) + @('0'))[0]
          $info.behind = [int](@((Git-Text $cwd @('rev-list', '--count', "$h..$r")).lines) + @('0'))[0]
          if ($h -eq 'HEAD') {
            $info.dirty = @((Git-Text $cwd @('status', '--porcelain')).lines | Where-Object { $_ }).Count
            $untracked = @((Git-Text $cwd @('ls-files', '--others', '--exclude-standard')).lines | Where-Object { $_ })
          }
          $da = @('-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', $(if ($unc -and $h -eq 'HEAD') { 'HEAD' } else { $info.base }))
          if ($h -ne 'HEAD') { $da += $h }
          if ($file) { $da += @('--', $file) }
          $lines = @((Git-Text $cwd $da).lines)
        }
        # Split the unified diff per file; the diff text of a file starts at its first @@ hunk.
        $files = New-Object System.Collections.ArrayList
        $cur = $null
        foreach ($ln in $lines) {
          if ($ln.StartsWith('diff --git ')) {
            $pth = if ($ln -match ' b/(.+)$') { $Matches[1] } else { $ln.Substring(11) }
            $cur = [pscustomobject]@{ path = $pth; status = 'modified'; additions = 0; deletions = 0; sb = (New-Object System.Text.StringBuilder); hunks = $false }
            [void]$files.Add($cur); continue
          }
          if (-not $cur) { continue }
          if (-not $cur.hunks) {
            if ($ln.StartsWith('new file')) { $cur.status = 'added' } elseif ($ln.StartsWith('deleted file')) { $cur.status = 'deleted' } elseif ($ln.StartsWith('rename from')) { $cur.status = 'renamed' } elseif ($ln.StartsWith('Binary files')) { $cur.status = 'binary' }
            if (-not $ln.StartsWith('@@')) { continue }
            $cur.hunks = $true
          }
          if ($ln.StartsWith('+')) { $cur.additions += 1 } elseif ($ln.StartsWith('-')) { $cur.deletions += 1 }
          [void]$cur.sb.Append($ln).Append("`n")
        }
        $cap = 200000
        $out = @(foreach ($f in $files) {
          $d = $f.sb.ToString(); $cut = $d.Length -gt $cap
          if ($cut) { $d = $d.Substring(0, $cap) }
          [pscustomobject][ordered]@{ path = $f.path; status = $f.status; additions = $f.additions; deletions = $f.deletions; truncated = $cut; diff = $d }
        })
        foreach ($u in $untracked) { if (-not $file -or $u -eq $file) { $out += [pscustomobject][ordered]@{ path = $u; status = 'untracked'; additions = 0; deletions = 0; truncated = $false; diff = '' } } }
        if (O 'json') { $info['files'] = @($out); Write-Output (ConvertTo-Json -InputObject ([pscustomobject]$info) -Depth 5 -Compress); exit 0 }
        Write-Output ("#{0} {1} -> {2}: {3} commit(s) ahead, {4} behind{5}" -f $id, $w.branch, $c.def, $info.ahead, $info.behind, $(if ($info.dirty) { ", $($info.dirty) uncommitted change(s)" } else { '' }))
        if ($file) { foreach ($f in $out) { Write-Output $f.diff } }
        else { foreach ($f in $out) { Write-Output ("{0,7} {1,7}  {2}{3}" -f "+$($f.additions)", "-$($f.deletions)", $f.path, $(if ($f.status -ne 'modified') { " ($($f.status))" } else { '' })) } }
        if (-not $out.Count) { Write-Output '(no changes)' }
      }
      'merge' {
        # Merges the task branch into the default branch of the source's local checkout (git merge --no-ff).
        # Refuses on a dirty worktree/checkout, a checkout on another branch, or conflicts (then aborts).
        # Agents go through their risk level (a merge into the default branch is protected git).
        $id = (P 2 'task number').TrimStart('#')
        $me = O 'as'; if (-not $me) { $me = $env:HERDR_AGENT }; if (-not $me) { $me = 'ty' }
        $c = Wt-Ctx $dir $id; $w = $c.w; $b = [string]$w.branch; $def = $c.def
        if ($w.machine) { Fail "Task #$id works on $($w.machine): push $b and merge through a merge/pull request (hp task link)." }
        if (-not $c.repo) { Fail "Source '$($w.source)' has no local checkout to merge into (hp source set $($w.source) --local <folder>)." }
        $repo = $c.repo
        if ($c.live -and (Test-Path -LiteralPath $w.path)) {
          $st = @((Git-Text $w.path @('status', '--porcelain')).lines | Where-Object { $_ })
          if ($st.Count) { Fail "The worktree has $($st.Count) uncommitted change(s); commit them first. Merge refused." }
        }
        $cur = (@((Git-Text $repo @('rev-parse', '--abbrev-ref', 'HEAD')).lines) + @(''))[0].Trim()
        if ($cur -ne $def) { Fail "The checkout $repo is on '$cur', not '$def'. Switch it to $def first. Merge refused." }
        $st = @((Git-Text $repo @('status', '--porcelain', '--untracked-files=no')).lines | Where-Object { $_ })
        if ($st.Count) { Fail "The checkout $repo has uncommitted changes. Merge refused." }
        if ((Git-Text $repo @('rev-parse', '--verify', '-q', "refs/heads/$b")).code -ne 0) { Fail "No branch $b in $repo." }
        $ahead = [int](@((Git-Text $repo @('rev-list', '--count', "$def..$b")).lines) + @('0'))[0]
        if ($ahead -eq 0) { Write-Output "nothing to merge: $b has no commits that $def lacks"; exit 0 }
        Risk-Gate $dir $me "git merge --no-ff $b" "merge of task #$id into $def" ((Risk-Of $dir $me) -ne 'autonomous')
        $m = Git-Local $repo @('merge', '--no-ff', '--no-edit', '-m', "Merge task #${id}: $($c.x.title) ($b)", $b)
        if ($m.code -ne 0) {
          $cf = @((Git-Text $repo @('diff', '--name-only', '--diff-filter=U')).lines | Where-Object { $_ })
          [void](Git-Local $repo @('merge', '--abort'))
          if ($cf.Count) { Fail "Merge refused: $($cf.Count) conflicting file(s): $($cf -join ', '). The merge was aborted, $def is unchanged. Rebase $b on $def in the worktree and resolve them." }
          Fail "git merge failed (aborted, $def is unchanged): $($m.out)"
        }
        $sha = (@((Git-Text $repo @('rev-parse', '--short', 'HEAD')).lines) + @(''))[0].Trim()
        [void](Tasks-Change $dir { param($t) $y = Find-Task $t $id; Set-Prop $y.worktree 'merged' (Now-Iso); Set-Prop $y.worktree 'merge_sha' $sha; Task-History $y $me "merged $b into $def ($sha, $ahead commit(s))"; $null })
        Emit $dir 'task' $me 'all' "#$id $b merged into $def ($sha)" $id
        Write-Output "ok: merged $b into $def ($sha, $ahead commit(s))"
      }
      default { Fail 'hp worktree list | prune <task id> [--force] | diff <task id> [--file f] [--scope uncommitted] [--json] | merge <task id>' }
    }
  }

  'maintain' { Maintain }

  # Token usage per agent of this project, from Claude Code and Codex session logs (local files only).
  'usage' {
    $dir = Find-Project
    $projPath = (Resolve-Path -LiteralPath $dir).Path.TrimEnd('\')
    $norm = { param($x) ([string]$x).Replace('/', '\').TrimEnd('\').ToLowerInvariant() }
    $want = & $norm $projPath
    $agentRx = 'You are agent \\?"([^"\\]+)\\?"'
    $res = @{}
    $bump = {
      param($name, $engine, $in, $out, $cr, $cw, $ts)
      if (-not $name) { $name = '(unknown)' }
      if (-not $res.ContainsKey($name)) { $res[$name] = [ordered]@{ engine = $engine; input = [int64]0; output = [int64]0; cache_read = [int64]0; cache_write = [int64]0; sessions = 0; last = '' } }
      $r = $res[$name]
      $r.input += [int64]$in; $r.output += [int64]$out; $r.cache_read += [int64]$cr; $r.cache_write += [int64]$cw
      if ($ts -and ([string]$ts) -gt $r.last) { $r.last = [string]$ts }
    }
    # Claude Code: ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<session>.jsonl
    $claudeDir = Join-Path $HOME ".claude\projects\$($projPath -replace '[^a-zA-Z0-9]', '-')"
    if (Test-Path -LiteralPath $claudeDir) {
      foreach ($f in (Get-ChildItem -LiteralPath $claudeDir -Filter '*.jsonl' -File)) {
        $agent = $null; $seen = @{}; $counted = $false
        foreach ($line in [IO.File]::ReadLines($f.FullName, $Utf8)) {
          if (-not $agent -and $line -match $agentRx) { $agent = $Matches[1] }
          if ($line -notmatch '"usage"') { continue }
          try { $j = $line | ConvertFrom-Json } catch { continue }
          $u = $j.message.usage; if (-not $u) { continue }
          $id = [string]$j.message.id
          if ($id -and $seen.ContainsKey($id)) { continue }
          if ($id) { $seen[$id] = 1 }
          & $bump $agent 'claude' $u.input_tokens $u.output_tokens $u.cache_read_input_tokens $u.cache_creation_input_tokens $j.timestamp
          $counted = $true
        }
        if ($counted) { $res[$(if ($agent) { $agent } else { '(unknown)' })].sessions++ }
      }
    }
    # Codex: ~/.codex/sessions/**/rollout-*.jsonl, cwd in session_meta, cumulative token_count totals.
    $codexHome = $env:CODEX_HOME; if (-not $codexHome) { $codexHome = Join-Path $HOME '.codex' }
    $cdir = Join-Path $codexHome 'sessions'
    if (Test-Path -LiteralPath $cdir) {
      $since = (Get-Date).AddDays(-90)
      foreach ($f in (Get-ChildItem -LiteralPath $cdir -Recurse -Filter '*.jsonl' -File | Where-Object { $_.LastWriteTime -gt $since })) {
        $sr = New-Object IO.StreamReader($f.FullName, $Utf8)
        try { $first = $sr.ReadLine() } finally { $sr.Close() }
        if (-not $first -or $first -notmatch '"cwd"') { continue }
        try { $meta = $first | ConvertFrom-Json } catch { continue }
        $cwd = $meta.payload.cwd; if (-not $cwd) { $cwd = $meta.cwd }
        if ((& $norm $cwd) -ne $want) { continue }
        $agent = $null; $last = $null; $ts = ''
        foreach ($line in [IO.File]::ReadLines($f.FullName, $Utf8)) {
          if (-not $agent -and $line -match $agentRx) { $agent = $Matches[1] }
          if ($line -match '"total_token_usage"') { $last = $line }
        }
        if (-not $last) { continue }
        try { $j = $last | ConvertFrom-Json } catch { continue }
        $u = $j.payload.info.total_token_usage; if (-not $u) { continue }
        & $bump $agent 'codex' ([int64]$u.input_tokens - [int64]$u.cached_input_tokens) $u.output_tokens $u.cached_input_tokens 0 $j.timestamp
        $res[$(if ($agent) { $agent } else { '(unknown)' })].sessions++
      }
    }
    Write-Output (ConvertTo-Json -InputObject ([ordered]@{ project = (Slug-Of $dir); at = (Now-Iso); agents = $res }) -Depth 5 -Compress)
  }

  # Usage limits of Claude Code (subscription) and Codex, as JSON. The token never leaves hp.
  'limits' {
    $out = [ordered]@{ claude = [ordered]@{ ok = $false }; codex = [ordered]@{ ok = $false } }
    # Claude Code: the endpoint Claude Code's /usage uses, with Claude Code's own local login.
    try {
      $tok = $env:CLAUDE_CODE_OAUTH_TOKEN
      if (-not $tok) {
        $c = Read-Json (Join-Path $HOME '.claude\.credentials.json') $null
        if ($c -and $c.claudeAiOauth) { $tok = $c.claudeAiOauth.accessToken }
      }
      if (-not $tok) { $out.claude.err = 'Sign in to Claude Code (run: claude, then /login)' }
      else {
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
        $r = Invoke-RestMethod -Method Get -Uri 'https://api.anthropic.com/api/oauth/usage' -Headers @{ Authorization = "Bearer $tok"; 'anthropic-beta' = 'oauth-2025-04-20' } -TimeoutSec 15
        $win = { param($w) if ($null -eq $w) { return $null }; return [ordered]@{ used = [double]$w.utilization; resets_at = [string]$w.resets_at } }
        $out.claude = [ordered]@{ ok = $true; five_hour = (& $win $r.five_hour); seven_day = (& $win $r.seven_day); at = (Now-Iso) }
      }
    } catch { $out.claude.err = $_.Exception.Message }
    # Codex: the newest rate_limits sample in its local session logs.
    try {
      $codexHome = $env:CODEX_HOME; if (-not $codexHome) { $codexHome = Join-Path $HOME '.codex' }
      $dir = Join-Path $codexHome 'sessions'
      if (-not (Test-Path -LiteralPath $dir)) { $out.codex.err = 'No Codex sessions yet' }
      else {
        $found = $null
        foreach ($f in (Get-ChildItem -LiteralPath $dir -Recurse -Filter '*.jsonl' | Sort-Object LastWriteTime -Descending | Select-Object -First 8)) {
          # Codex keeps its live session log open: read it with ReadWrite sharing, skip a file that still fails.
          $lines = $null
          try { $fs = New-Object IO.FileStream($f.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)); $sr = New-Object IO.StreamReader($fs, $Utf8); try { $lines = $sr.ReadToEnd() -split "`r?`n" } finally { $sr.Close() } } catch { continue }
          for ($n = $lines.Length - 1; $n -ge 0; $n--) {
            if ($lines[$n] -notmatch '"rate_limits"') { continue }
            try { $jl = $lines[$n] | ConvertFrom-Json } catch { continue }
            $rl = $jl.payload.rate_limits; if (-not $rl) { $rl = $jl.rate_limits }
            if ($rl -and $rl.primary) { $found = @{ rl = $rl; ts = [string]$jl.timestamp }; break }
          }
          if ($found) { break }
        }
        if (-not $found) { $out.codex.err = 'No rate-limit data in Codex logs yet' }
        else {
          $base = if ($found.ts) { [datetime]$found.ts } else { Get-Date }
          $win = {
            param($w)
            if ($null -eq $w) { return $null }
            $reset = ''
            if ($w.resets_at) { $reset = ([DateTimeOffset]::FromUnixTimeSeconds([int64]$w.resets_at)).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ') }
            elseif ($w.resets_in_seconds) { $reset = $base.ToUniversalTime().AddSeconds([double]$w.resets_in_seconds).ToString('yyyy-MM-ddTHH:mm:ssZ') }
            return [ordered]@{ used = [double]$w.used_percent; window_minutes = $w.window_minutes; resets_at = $reset }
          }
          $out.codex = [ordered]@{ ok = $true; primary = (& $win $found.rl.primary); secondary = (& $win $found.rl.secondary); at = $found.ts }
        }
      }
    } catch { $out.codex.err = $_.Exception.Message }
    Write-Output (ConvertTo-Json -InputObject $out -Depth 6 -Compress)
  }

  # This computer: cpu%|ram_used|ram_total|disk_used|disk_total (bytes).
  # hp report daily [-p <project> | --all] [--date yyyy-MM-dd] [--force] [--dry]: one day (default: yesterday)
  # as a Mailbox message from "herdr" (thread daily-<date>). Once per project and day unless --force; --all
  # (the app, once a day after 08:00) skips paused and loose projects and days with nothing in them.
  'report' {
    $kind = P 1 'report kind (daily)'
    if ($kind -ne 'daily') { Fail "Unknown report '$kind'. hp report daily -p <project>" }
    $day = if (O 'date') { [datetime]::ParseExact([string](O 'date'), 'yyyy-MM-dd', $Inv) } else { (Get-Date).Date.AddDays(-1) }
    $dirs = if (O 'all') { @(All-Projects | ForEach-Object { $_.FullName }) } else { @(Find-Project) }
    foreach ($d in $dirs) {
      try { Write-Output (Daily-Report $d $day ([bool](O 'all'))) } catch { Write-Output "$(Slug-Of $d): failed ($($_.Exception.Message))" }
    }
  }

  # MCP servers attached to agents (~/.herdr/mcp.json, written by the Herdr panel). Token values never
  # leave Credential Manager: "${secret:NAME}" in an env or header value is filled in here, at start.
  #   hp mcp exec <server>     runs a stdio server (env filled in) on this process's own stdin/stdout
  #   hp mcp bridge <server>   an HTTP server as stdio (npx mcp-remote, headers filled in), for Codex
  #   hp mcp headers <server>  the HTTP headers as JSON (Claude Code's headersHelper)
  #   hp mcp test <server>     connects like an agent would (initialize + tools/list); JSON {ok, server, tools, error}
  'mcp' {
    $sub = P 1 'exec|bridge|headers|test'; $name = P 2 'server'
    $db = Read-Json (Join-Path $HerdrHome 'mcp.json') $null
    $srv = $null
    if ($db) { foreach ($s in @(Arr $db.servers)) { if ([string]$s.name -eq $name) { $srv = $s } } }
    if (-not $srv) { Fail "No such MCP server '$name' (Herdr: MCP servers)" }
    $fill = {
      param([string]$text)
      $ev = [System.Text.RegularExpressions.MatchEvaluator] { param($m) $r = Secret-Value (Find-Secret $m.Groups[1].Value.Trim()); return [string]$r[1] }
      return [regex]::Replace([string]$text, '\$\{secret:([^}]+)\}', $ev)
    }
    # Windows command-line quoting (CommandLineToArgvW rules).
    $quote = {
      param([string]$a)
      if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
      $b = [regex]::Replace($a, '(\\*)"', { param($m) $m.Groups[1].Value + $m.Groups[1].Value + '\"' })
      $b = [regex]::Replace($b, '(\\+)$', { param($m) $m.Groups[1].Value + $m.Groups[1].Value })
      return '"' + $b + '"'
    }
    $pairs = { param($list) $out = [ordered]@{}; foreach ($e in @(Arr $list)) { if ($e -and [string]$e.name) { $out[[string]$e.name] = (& $fill ([string]$e.value)) } }; return $out }
    # Starts a program with inherited stdin/stdout/stderr (no redirection: the MCP client talks to it directly).
    $start = {
      param([string]$exe, [string[]]$argList, $envs, [string]$cwd)
      # Prefer what Windows can start: .exe, then .cmd/.bat, then .ps1. Node puts an extensionless "npx" (a sh
      # script for Git Bash) next to npx.cmd; starting that one fails ("not a valid application").
      $rank = { param($x) $pth = [string]$x.Source; if (-not $pth) { $pth = [string]$x.Path }; switch -regex ($pth) { '\.(exe|com)$' { 0 } '\.(cmd|bat)$' { 1 } '\.ps1$' { 2 } default { 9 } } }
      $c = @(Get-Command $exe -All -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Where-Object { (& $rank $_) -lt 9 } | Sort-Object { & $rank $_ }) | Select-Object -First 1
      if (-not $c) { Fail "Command not found: $exe" }
      $path = [string]$c.Source; if (-not $path) { $path = [string]$c.Path }; if (-not $path) { $path = $exe }
      $file = $path; $list = @($argList)
      if ($path -match '\.(cmd|bat)$') {
        $file = Join-Path $env:SystemRoot 'System32\cmd.exe'
        $line = (@($path) + $list | ForEach-Object { & $quote ([string]$_) }) -join ' '
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $file; $psi.Arguments = '/d /s /c "' + $line + '"'
      } else {
        if ($path -match '\.ps1$') { $list = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $path) + $list; $file = 'powershell.exe' }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $file; $psi.Arguments = (@($list | ForEach-Object { & $quote ([string]$_) })) -join ' '
      }
      $psi.UseShellExecute = $false
      if ($cwd) { $psi.WorkingDirectory = $cwd }
      foreach ($k in @($envs.Keys)) { $psi.EnvironmentVariables[[string]$k] = [string]$envs[$k] }
      if ($script:McpTest) {
        $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
        return [System.Diagnostics.Process]::Start($psi)
      }
      $proc = [System.Diagnostics.Process]::Start($psi)
      $proc.WaitForExit()
      exit $proc.ExitCode
    }
    # Test: one JSON-RPC request over a started process's stdin/stdout; skips log lines and other messages.
    $rpc = {
      param($proc, [int]$id, [string]$method, $params, [int]$ms)
      $req = [ordered]@{ jsonrpc = '2.0'; id = $id; method = $method; params = $params }
      $proc.StandardInput.WriteLine((ConvertTo-Json -InputObject $req -Compress -Depth 10)); $proc.StandardInput.Flush()
      $until = (Get-Date).AddMilliseconds($ms)
      while ((Get-Date) -lt $until) {
        if (-not $script:McpRead) { $script:McpRead = $proc.StandardOutput.ReadLineAsync() }
        $left = [int][Math]::Max(1, ($until - (Get-Date)).TotalMilliseconds)
        if (-not $script:McpRead.Wait($left)) { break }
        $line = $script:McpRead.Result; $script:McpRead = $null
        if ($null -eq $line) { break }
        if ($line -notmatch '^\s*\{') { continue }
        try { $m = $line | ConvertFrom-Json } catch { continue }
        if ($m.id -eq $id) { return $m }
      }
      return $null
    }
    $report = {
      param([bool]$ok, $srvInfo, $tools, [string]$err)
      $names = @(@(Arr $tools) | ForEach-Object { [string]$_.name })
      $list = @(@(Arr $tools) | ForEach-Object { $d = ([string]$_.description -replace '\s+', ' ').Trim(); if ($d.Length -gt 400) { $d = $d.Substring(0, 399) + '...' }; [ordered]@{ name = [string]$_.name; desc = $d } })
      $o = [ordered]@{ ok = $ok; server = $(if ($srvInfo) { ([string]$srvInfo.name + ' ' + [string]$srvInfo.version).Trim() } else { '' }); tools = $names.Count; toolNames = @($names | Select-Object -First 12); toolList = $list; error = $err }
      Write-Output (ConvertTo-Json -InputObject $o -Compress)
    }
    $init = [ordered]@{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = [ordered]@{ name = 'herdr-hyper-view'; version = '1.0' } }
    switch ($sub) {
      'headers' {
        $h = & $pairs $srv.headers
        Write-Output (ConvertTo-Json -InputObject $h -Compress)
      }
      'exec' {
        if ([string]$srv.transport -eq 'http') { Fail "MCP server '$name' is an HTTP server (hp mcp bridge $name)." }
        $argList = @(@(Arr $srv.args) | ForEach-Object { & $fill ([string]$_) })
        & $start ([string]$srv.command) $argList (& $pairs $srv.env) ([string]$srv.cwd)
      }
      'bridge' {
        if (-not [string]$srv.url) { Fail "MCP server '$name' has no URL." }
        # mcp-remote expands ${VAR} in --header itself, so values with spaces ("Bearer x") stay out of the command line.
        $u = & $fill ([string]$srv.url)
        $argList = @('-y', 'mcp-remote', $u)
        # mcp-remote refuses plain http:// outside localhost unless told (internal servers like http://10.x:3018/mcp).
        if ($u -match '^http://') { $argList += '--allow-http' }
        $envs = [ordered]@{}; $i = 0
        foreach ($e in @(Arr $srv.headers)) {
          if (-not ($e -and [string]$e.name)) { continue }
          $i++; $envs["HV_MCP_H$i"] = (& $fill ([string]$e.value))
          $argList += @('--header', ([string]$e.name + ':${HV_MCP_H' + $i + '}'))
        }
        & $start 'npx' $argList $envs ''
      }
      'test' {
        try {
          if ([string]$srv.transport -eq 'http') {
            $url = & $fill ([string]$srv.url)
            if (-not $url) { & $report $false $null $null 'No URL.'; break }
            $h = & $pairs $srv.headers
            $hdr = @{ 'Accept' = 'application/json, text/event-stream' }
            foreach ($k in @($h.Keys)) { $hdr[[string]$k] = [string]$h[$k] }
            $post = {
              param($body)
              $r = Invoke-WebRequest -Uri $url -Method Post -Headers $hdr -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $body -Compress -Depth 10))) -UseBasicParsing -TimeoutSec 30
              $sid = [string]$r.Headers['Mcp-Session-Id']; if ($sid) { $hdr['Mcp-Session-Id'] = $sid }
              $text = [string]$r.Content
              # Streamable HTTP may answer as server-sent events: the JSON is on a "data:" line.
              $json = @($text -split "`n" | Where-Object { $_ -match '^data:\s*\{' } | ForEach-Object { $_ -replace '^data:\s*', '' }) | Select-Object -Last 1
              if (-not $json) { $json = $text }
              return ($json | ConvertFrom-Json)
            }
            $a = & $post ([ordered]@{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = $init })
            if ($a.error) { & $report $false $null $null ([string]$a.error.message); break }
            try { Invoke-WebRequest -Uri $url -Method Post -Headers $hdr -ContentType 'application/json' -Body '{"jsonrpc":"2.0","method":"notifications/initialized"}' -UseBasicParsing -TimeoutSec 15 | Out-Null } catch {}
            $tl = $null; try { $tl = & $post ([ordered]@{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} }) } catch {}
            & $report $true $a.result.serverInfo $tl.result.tools ''
          } else {
            $script:McpTest = $true
            $argList = @(@(Arr $srv.args) | ForEach-Object { & $fill ([string]$_) })
            $proc = & $start ([string]$srv.command) $argList (& $pairs $srv.env) ([string]$srv.cwd)
            $errTask = $proc.StandardError.ReadToEndAsync()
            try {
              # The first start may download the package (npx -y): up to 60 s.
              $a = & $rpc $proc 1 'initialize' $init 60000
              if (-not $a) {
                $why = ''; if ($proc.HasExited) { $why = 'It stopped (exit code ' + $proc.ExitCode + '). ' }
                $e = ''; if ($errTask.Wait(1500)) { $e = [string]$errTask.Result }
                $e = (($e -split "`n" | Where-Object { $_.Trim() }) | Select-Object -Last 3) -join ' '
                & $report $false $null $null ($why + $(if ($e) { $e } else { 'No answer to initialize within 60 s.' }))
              } elseif ($a.error) { & $report $false $null $null ([string]$a.error.message) }
              else {
                $proc.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}'); $proc.StandardInput.Flush()
                $tl = & $rpc $proc 2 'tools/list' @{} 20000
                & $report $true $a.result.serverInfo $tl.result.tools ''
              }
            } finally { try { if (-not $proc.HasExited) { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null } } catch {} }
          }
        } catch { & $report $false $null $null ([string]$_.Exception.Message) }
      }
      default { Fail 'hp mcp exec|bridge|headers|test <server>' }
    }
  }

  'stats' {
    $c = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $o = Get-CimInstance Win32_OperatingSystem
    $d = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))
    Write-Output ('{0}|{1}|{2}|{3}|{4}' -f [int]$c, (([int64]$o.TotalVisibleMemorySize - [int64]$o.FreePhysicalMemory) * 1024), ([int64]$o.TotalVisibleMemorySize * 1024), [int64]$d.Used, ([int64]$d.Used + [int64]$d.Free))
  }

  # For askpass.cmd: prints the password referenced by HP_ASKPASS_TARGET.
  '_askpass' {
    $r = Cred-Get $env:HP_ASKPASS_TARGET
    if ($null -eq $r) { exit 1 }
    [Console]::Out.Write($r[1] + "`n")
  }

  default { Fail "Unknown command '$cmd'. hp help" }
}
