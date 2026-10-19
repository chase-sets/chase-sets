#Requires -Version 7
<#
.SYNOPSIS
Runs one command with the agent Bitwarden Secrets Manager project injected as
environment variables.

.DESCRIPTION
Agents call this instead of reading secrets. The machine-account token is read
from Windows Credential Manager and handed only to the bws process environment;
it never reaches an argument list, this script's environment or a file.
-Command forwards the child's output with the token and every project value
replaced by [redacted]; -Check and -ListKeys print no values. Before reading
the token, -Command and -Check read the agent tier from the credential
inventory of the checkout this script sits in; after listing the project they
refuse while it holds a key outside the tier or a value without one of its
key's test prefixes, so -Command never reaches bws run. Every failure prints
one fixed classification (missing-token, denied, bws-failed, unparseable-list,
unscrubbable-value, inventory-unavailable or tier-violation), never exception
text, bws output or a value. CHASE_SETS_AGENT_SECRETS=deny refuses every mode.

Only this script's own streams are scrubbed: a value the command writes to a
file, a socket, or in a transformed form is not caught.

.EXAMPLE
pwsh -NoProfile -File scripts/agent-secrets/with-secrets.ps1 -Command 'pnpm run test:stripe'

.EXAMPLE
pwsh -NoProfile -File scripts/agent-secrets/with-secrets.ps1 -ListKeys
#>
[CmdletBinding(DefaultParameterSetName = 'Command')]
param(
  [Parameter(Mandatory, Position = 0, ParameterSetName = 'Command')][string]$Command,
  [Parameter(ParameterSetName = 'Command')][switch]$NoInheritEnv,
  [Parameter(Mandatory, ParameterSetName = 'Check')][switch]$Check,
  [Parameter(Mandatory, ParameterSetName = 'ListKeys')][switch]$ListKeys,
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,62}$')][string]$Account = 'lanes'
)

function Stop-WithClassification([string]$Classification, [string]$Detail) {
  $line = if ($Detail) { "with-secrets: ${Classification}: $Detail" } else { "with-secrets: $Classification" }
  [Console]::Error.WriteLine($line)
  exit 2
}

# A configured path must name an existing bws file, so a mistake such as the
# password-manager CLI bw.cmd is refused before the credential is read.
function Resolve-BwsPath {
  $configured = $env:CHASE_SETS_BWS_EXE
  if (-not [string]::IsNullOrEmpty($configured)) {
    if (-not [IO.Path]::IsPathFullyQualified($configured) -or
      [IO.Path]::GetFileName($configured) -notin @('bws', 'bws.exe', 'bws.cmd') -or
      -not (Test-Path -LiteralPath $configured -PathType Leaf)) {
      Stop-WithClassification 'bws-failed' 'CHASE_SETS_BWS_EXE must be an absolute path to an existing bws, bws.exe or bws.cmd'
    }
    return $configured
  }
  $onPath = Get-Command bws -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { return $onPath.Source }
  if ($env:LOCALAPPDATA) {
    $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bws.exe'
    if (Test-Path -LiteralPath $winget -PathType Leaf) { return $winget }
  }
  Stop-WithClassification 'bws-failed' 'bws not found; install it with winget install --id Bitwarden.BWS --exact'
}

# Compiles the -Command output scrubber once per session. Each instance scans
# one byte stream for the token and every value as UTF-8, UTF-16LE and
# UTF-16BE, replaces each leftmost match, longest pattern first, with
# [redacted] in the match's encoding, and holds back only a tail that could
# still begin a match: fewer than the longest pattern's length in bytes.
# Complete flushes that tail scrubbed; Abort drops it unwritten; Clear also
# zeroes the patterns.
function Initialize-SecretScrubber {
  if ('AgentSecretScrubber' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
public sealed class AgentSecretScrubber {
  const string Marker = "[redacted]";
  static readonly byte[] Empty = new byte[0];
  readonly object gate = new object();
  readonly Stream destination;
  readonly byte[][] patterns;
  readonly byte[][] replacements;
  readonly int[][] byFirstByte = new int[256][];
  byte[] held = Empty;
  bool closed;

  public static bool IsScrubbable(string value) {
    if (value == null || value.Length < 8) return false;
    foreach (char c in value) if (c < 0x20 || c > 0x7E) return false;
    return true;
  }

  public AgentSecretScrubber(string[] secrets, Stream destination) {
    this.destination = destination;
    Encoding[] encodings = { new UTF8Encoding(false), new UnicodeEncoding(false, false), new UnicodeEncoding(true, false) };
    var found = new List<byte[][]>();
    foreach (string secret in secrets) {
      if (!IsScrubbable(secret)) throw new ArgumentException("unscrubbable value");
      foreach (Encoding encoding in encodings) found.Add(new[] { encoding.GetBytes(secret), encoding.GetBytes(Marker) });
    }
    found.Sort((a, b) => b[0].Length.CompareTo(a[0].Length));
    patterns = new byte[found.Count][];
    replacements = new byte[found.Count][];
    var buckets = new List<int>[256];
    for (int i = 0; i < found.Count; i++) {
      patterns[i] = found[i][0];
      replacements[i] = found[i][1];
      int first = patterns[i][0];
      (buckets[first] ?? (buckets[first] = new List<int>())).Add(i);
    }
    for (int b = 0; b < 256; b++) if (buckets[b] != null) byFirstByte[b] = buckets[b].ToArray();
  }

  public void Write(byte[] buffer, int offset, int count) {
    lock (gate) {
      if (closed || count == 0) return;
      if (held.Length == 0) { Scan(buffer, offset, offset + count, false); return; }
      var work = new byte[held.Length + count];
      Buffer.BlockCopy(held, 0, work, 0, held.Length);
      Buffer.BlockCopy(buffer, offset, work, held.Length, count);
      Array.Clear(held, 0, held.Length);
      held = Empty;
      Scan(work, 0, work.Length, false);
      Array.Clear(work, 0, work.Length);
    }
  }

  public void Complete() {
    lock (gate) {
      if (closed) return;
      closed = true;
      var tail = held;
      held = Empty;
      Scan(tail, 0, tail.Length, true);
      Array.Clear(tail, 0, tail.Length);
    }
  }

  public void Abort() {
    lock (gate) {
      closed = true;
      Array.Clear(held, 0, held.Length);
      held = Empty;
    }
  }

  public void Clear() {
    lock (gate) {
      Abort();
      foreach (byte[] pattern in patterns) Array.Clear(pattern, 0, pattern.Length);
    }
  }

  // Reads the child stream to its end. On any failure the held tail is dropped
  // and the child's process tree is killed so the other stream cannot block.
  public async Task PumpAsync(Stream source, Process child) {
    var buffer = new byte[65536];
    try {
      int count;
      while ((count = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0) Write(buffer, 0, count);
      Complete();
    } catch {
      Abort();
      try { child.Kill(true); } catch { }
      throw;
    } finally {
      Array.Clear(buffer, 0, buffer.Length);
    }
  }

  void Scan(byte[] work, int start, int end, bool final) {
    var output = new MemoryStream();
    int run = start, i = start;
    while (i < end) {
      int[] candidates = byFirstByte[work[i]];
      int matched = -1;
      bool hold = false;
      if (candidates != null) {
        foreach (int p in candidates) {
          byte[] pattern = patterns[p];
          int available = end - i;
          if (pattern.Length <= available) {
            if (Matches(work, i, pattern, pattern.Length)) { matched = p; break; }
          } else if (!final && Matches(work, i, pattern, available)) {
            hold = true;
            break;
          }
        }
      }
      if (hold) break;
      if (matched < 0) { i++; continue; }
      output.Write(work, run, i - run);
      output.Write(replacements[matched], 0, replacements[matched].Length);
      i += patterns[matched].Length;
      run = i;
    }
    output.Write(work, run, i - run);
    if (i < end) {
      held = new byte[end - i];
      Buffer.BlockCopy(work, i, held, 0, held.Length);
    }
    if (output.Length > 0) {
      destination.Write(output.GetBuffer(), 0, (int)output.Length);
      destination.Flush();
    }
  }

  static bool Matches(byte[] work, int at, byte[] pattern, int length) {
    for (int k = 0; k < length; k++) if (work[at + k] != pattern[k]) return false;
    return true;
  }
}
'@
}

# Every bws launch is hidden, redirects both output streams, never carries a
# Bitwarden password-manager variable, and is the only place the token lives.
function New-BwsStartInfo {
  param(
    [Parameter(Mandatory)][string]$BwsPath,
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][string]$Token,
    [switch]$Capture
  )
  $start = [Diagnostics.ProcessStartInfo]::new($BwsPath)
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.RedirectStandardInput = [bool]$Capture
  foreach ($name in @($start.Environment.Keys)) {
    if ($name.StartsWith('BW_', [StringComparison]::OrdinalIgnoreCase)) { [void]$start.Environment.Remove($name) }
  }
  $start.Environment['BWS_ACCESS_TOKEN'] = $Token
  $start
}

# -Capture keeps stdout in memory and discards stderr; otherwise both streams
# are pumped concurrently through one scrubber each to this script's own
# streams, and -Scrub names the token and every value they must not carry.
function Invoke-Bws {
  param([string]$BwsPath, [string[]]$Arguments, [string]$Token, [switch]$Capture, [string[]]$Scrub)
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = New-BwsStartInfo -BwsPath $BwsPath -Arguments $Arguments -Token $Token -Capture:$Capture
  $scrubbers = @()
  $pumps = @()
  $completed = $false
  try {
    if (-not $Capture) {
      Initialize-SecretScrubber
      $scrubbers = @(
        [AgentSecretScrubber]::new($Scrub, [Console]::OpenStandardOutput()),
        [AgentSecretScrubber]::new($Scrub, [Console]::OpenStandardError())
      )
    }
    [void]$process.Start()
    if ($Capture) {
      $process.StandardInput.Close()
      $pumps = @($process.StandardOutput.ReadToEndAsync(), $process.StandardError.ReadToEndAsync())
    } else {
      $pumps = @(
        $scrubbers[0].PumpAsync($process.StandardOutput.BaseStream, $process),
        $scrubbers[1].PumpAsync($process.StandardError.BaseStream, $process)
      )
    }
    [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$pumps)
    $process.WaitForExit()
    $completed = $true
    [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = if ($Capture) { $pumps[0].Result } else { $null } }
  } finally {
    if (-not $completed) {
      try { $process.Kill($true) } catch { }
      foreach ($scrubber in $scrubbers) { $scrubber.Abort() }
      if ($pumps.Count -gt 0) { try { [void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$pumps, 5000) } catch { } }
    }
    foreach ($scrubber in $scrubbers) { $scrubber.Clear() }
    $process.Dispose()
  }
}

# Values stay in this script's memory: -ListKeys prints only key names and
# -Command only builds its scrub set from the values. Any shape other than an
# array of objects with a string value and a string key free of control
# characters is unparseable, so a key can never forge an extra output line.
# Keys[i] names Values[i]; Names is the same keys sorted.
function ConvertFrom-SecretList([string]$Json) {
  $document = $null
  try {
    $document = [Text.Json.JsonDocument]::Parse($Json, [Text.Json.JsonDocumentOptions]::new())
    $keys = [Collections.Generic.List[string]]::new()
    $values = [Collections.Generic.List[string]]::new()
    foreach ($secret in $document.RootElement.EnumerateArray()) {
      $key = $secret.GetProperty('key')
      $value = $secret.GetProperty('value')
      if ($key.ValueKind -ne [Text.Json.JsonValueKind]::String -or $value.ValueKind -ne [Text.Json.JsonValueKind]::String) { return $null }
      $name = $key.GetString()
      if ($name -notmatch '^[^\p{Cc}]+\z') { return $null }
      $keys.Add($name)
      $values.Add($value.GetString())
    }
    $names = [Collections.Generic.List[string]]::new($keys)
    $names.Sort([StringComparer]::Ordinal)
    return [pscustomobject]@{ Names = $names.ToArray(); Keys = $keys.ToArray(); Values = $values.ToArray() }
  } catch {
    return $null
  } finally {
    if ($null -ne $document) { $document.Dispose() }
  }
}

# bws 2.1.0 `run` answers 404 for a readable project with zero secrets, so the
# read probe is `secret list`, where an empty list is a readable project.
function Get-ProjectSecretList([string]$BwsPath, [string]$ProjectId, [string]$Token) {
  $result = Invoke-Bws -Capture -BwsPath $BwsPath -Token $Token -Arguments @('secret', 'list', $ProjectId, '--output', 'json', '--color', 'no')
  if ($result.ExitCode -ne 0) { Stop-WithClassification 'bws-failed' "bws secret list exited $($result.ExitCode)" }
  $list = ConvertFrom-SecretList $result.Stdout
  if ($null -eq $list) { Stop-WithClassification 'unparseable-list' }
  $list
}

# Reads agentTier.keys from a credential inventory as an ordinal map from key
# name to its test prefixes. The full inventory rules live in
# scripts/credential-inventory.mjs; this read only needs the tier's shape, and
# a missing file, unparseable JSON or any other shape (including a duplicate
# name) returns $null.
function Read-AgentTier([string]$Path) {
  $document = $null
  try {
    $document = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($Path), [Text.Json.JsonDocumentOptions]::new())
    $tier = [Collections.Generic.Dictionary[string, string[]]]::new([StringComparer]::Ordinal)
    foreach ($key in $document.RootElement.GetProperty('agentTier').GetProperty('keys').EnumerateArray()) {
      $name = $key.GetProperty('name')
      if ($name.ValueKind -ne [Text.Json.JsonValueKind]::String -or $name.GetString().Length -eq 0) { return $null }
      $prefixes = [Collections.Generic.List[string]]::new()
      foreach ($prefix in $key.GetProperty('testPrefixes').EnumerateArray()) {
        if ($prefix.ValueKind -ne [Text.Json.JsonValueKind]::String -or $prefix.GetString().Length -eq 0) { return $null }
        $prefixes.Add($prefix.GetString())
      }
      $tier.Add($name.GetString(), $prefixes.ToArray())
    }
    return [pscustomobject]@{ Prefixes = $tier }
  } catch {
    return $null
  } finally {
    if ($null -ne $document) { $document.Dispose() }
  }
}

# Refuses while the project holds a key the tier does not list, or a value
# that starts with none of its key's test prefixes (an empty list admits any
# value). Values are compared in memory; only key names are printed.
function Assert-AgentTier($List, $Tier) {
  $violations = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal)
  for ($i = 0; $i -lt $List.Keys.Count; $i++) {
    $key = $List.Keys[$i]
    $prefixes = $null
    if (-not $Tier.Prefixes.TryGetValue($key, [ref]$prefixes)) {
      [void]$violations.Add("$key (not an agent-tier key)")
      continue
    }
    if ($prefixes.Count -eq 0) { continue }
    $value = $List.Values[$i]
    if (-not ($prefixes.Where({ $value.StartsWith($_, [StringComparison]::Ordinal) }, 'First').Count)) {
      [void]$violations.Add("$key (value without a test prefix)")
    }
  }
  if ($violations.Count -gt 0) {
    Stop-WithClassification 'tier-violation' "$([string]::Join(', ', $violations)); nothing was run"
  }
}

# Dot-sourcing defines the functions above for tests and runs nothing.
if ($MyInvocation.InvocationName -eq '.') { return }

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:CHASE_SETS_AGENT_SECRETS -eq 'deny') {
  Stop-WithClassification 'denied' 'CHASE_SETS_AGENT_SECRETS=deny; this lane may not use agent secrets'
}

# -ListKeys prints names only, so it stays available to inspect a violation.
$tier = $null
if ($PSCmdlet.ParameterSetName -ne 'ListKeys') {
  $tier = Read-AgentTier (Join-Path $PSScriptRoot '..' '..' '.github' 'credential-inventory.json')
  if ($null -eq $tier) {
    Stop-WithClassification 'inventory-unavailable' '.github/credential-inventory.json beside this checkout is missing, unparseable or has no valid agentTier; nothing was run'
  }
}

$classification = 'bws-failed'
try {
  $bws = Resolve-BwsPath
  $classification = 'missing-token'
  Import-Module (Join-Path $PSScriptRoot 'bitwarden-agent-credential.psm1') -Force -DisableNameChecking
  $credential = Get-AgentBwsCredential -Account $Account
  if ($null -eq $credential) {
    Stop-WithClassification 'missing-token' "no stored token for account '$Account'; Todd runs scripts/agent-secrets/set-bitwarden-agent-token.ps1 -ProjectId <project-guid> in an interactive terminal"
  }
  $projectId = $credential.ProjectId.ToString()
  $token = $credential.AccessToken
  $credential = $null
  $classification = 'bws-failed'

  switch ($PSCmdlet.ParameterSetName) {
    'Command' {
      # The tier guard and the scrub set both read the list before `run`; a
      # value added between the two calls is neither checked nor scrubbed.
      $list = Get-ProjectSecretList -BwsPath $bws -ProjectId $projectId -Token $token
      Assert-AgentTier $list $tier
      $secrets = @($token) + $list.Values
      $list = $null
      Initialize-SecretScrubber
      foreach ($secret in $secrets) {
        if (-not [AgentSecretScrubber]::IsScrubbable($secret)) {
          Stop-WithClassification 'unscrubbable-value' 'the token and every project value must be at least 8 printable ASCII characters; nothing was run'
        }
      }
      $arguments = @('run', '--project-id', $projectId, '--shell', [Environment]::ProcessPath)
      if ($NoInheritEnv) { $arguments += '--no-inherit-env' }
      $arguments += @('--', $Command)
      $result = Invoke-Bws -BwsPath $bws -Token $token -Arguments $arguments -Scrub $secrets
      exit $result.ExitCode
    }
    'Check' {
      $list = Get-ProjectSecretList -BwsPath $bws -ProjectId $projectId -Token $token
      Assert-AgentTier $list $tier
      [Console]::Out.WriteLine("OK: account '$Account' can read project $projectId ($($list.Names.Count) keys).")
    }
    'ListKeys' {
      foreach ($name in (Get-ProjectSecretList -BwsPath $bws -ProjectId $projectId -Token $token).Names) {
        [Console]::Out.WriteLine($name)
      }
    }
  }
  exit 0
} catch {
  Stop-WithClassification $classification
}
