#Requires -Version 7
<#
.SYNOPSIS
Runs one command with the agent Bitwarden Secrets Manager project injected as
environment variables.

.DESCRIPTION
Agents call this instead of reading secrets. The machine-account token is read
from Windows Credential Manager and handed only to the bws process environment;
it never reaches an argument list, this script's environment, a file or any
output. -Check and -ListKeys print no values. Every failure prints one fixed
classification (missing-token, denied, bws-failed or unparseable-list), never
exception text or bws output. CHASE_SETS_AGENT_SECRETS=deny refuses every mode.

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

function Resolve-BwsPath {
  $configured = $env:CHASE_SETS_BWS_EXE
  if (-not [string]::IsNullOrEmpty($configured)) {
    if (-not [IO.Path]::IsPathFullyQualified($configured)) {
      Stop-WithClassification 'bws-failed' 'CHASE_SETS_BWS_EXE must be an absolute path'
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
# are pumped concurrently, byte for byte, to this script's own streams.
function Invoke-Bws {
  param([string]$BwsPath, [string[]]$Arguments, [string]$Token, [switch]$Capture)
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = New-BwsStartInfo -BwsPath $BwsPath -Arguments $Arguments -Token $Token -Capture:$Capture
  try {
    [void]$process.Start()
    if ($Capture) {
      $process.StandardInput.Close()
      $stdout = $process.StandardOutput.ReadToEndAsync()
      $stderr = $process.StandardError.ReadToEndAsync()
    } else {
      $stdout = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
      $stderr = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
    }
    [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr))
    $process.WaitForExit()
    [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = if ($Capture) { $stdout.Result } else { $null } }
  } finally {
    $process.Dispose()
  }
}

# Values stay inside the parsed document; only key names leave it. Any shape
# other than an array of objects with a string key free of control characters
# is unparseable, so a key can never forge an extra output line.
function ConvertTo-KeyName([string]$Json) {
  $document = $null
  try {
    $document = [Text.Json.JsonDocument]::Parse($Json, [Text.Json.JsonDocumentOptions]::new())
    $names = [Collections.Generic.List[string]]::new()
    foreach ($secret in $document.RootElement.EnumerateArray()) {
      $key = $secret.GetProperty('key')
      if ($key.ValueKind -ne [Text.Json.JsonValueKind]::String) { return $null }
      $name = $key.GetString()
      if ($name -notmatch '^[^\p{Cc}]+\z') { return $null }
      $names.Add($name)
    }
    $names.Sort([StringComparer]::Ordinal)
    return , $names.ToArray()
  } catch {
    return $null
  } finally {
    if ($null -ne $document) { $document.Dispose() }
  }
}

# bws 2.1.0 `run` answers 404 for a readable project with zero secrets, so the
# read probe is `secret list`, where an empty list is a readable project.
function Get-ProjectKeyName([string]$BwsPath, [string]$ProjectId, [string]$Token) {
  $result = Invoke-Bws -Capture -BwsPath $BwsPath -Token $Token -Arguments @('secret', 'list', $ProjectId, '--output', 'json', '--color', 'no')
  if ($result.ExitCode -ne 0) { Stop-WithClassification 'bws-failed' "bws secret list exited $($result.ExitCode)" }
  $names = ConvertTo-KeyName $result.Stdout
  if ($null -eq $names) { Stop-WithClassification 'unparseable-list' }
  , $names
}

# Dot-sourcing defines the functions above for tests and runs nothing.
if ($MyInvocation.InvocationName -eq '.') { return }

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:CHASE_SETS_AGENT_SECRETS -eq 'deny') {
  Stop-WithClassification 'denied' 'CHASE_SETS_AGENT_SECRETS=deny; this lane may not use agent secrets'
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
      $arguments = @('run', '--project-id', $projectId, '--shell', [Environment]::ProcessPath)
      if ($NoInheritEnv) { $arguments += '--no-inherit-env' }
      $arguments += @('--', $Command)
      $result = Invoke-Bws -BwsPath $bws -Token $token -Arguments $arguments
      exit $result.ExitCode
    }
    'Check' {
      $names = Get-ProjectKeyName -BwsPath $bws -ProjectId $projectId -Token $token
      [Console]::Out.WriteLine("OK: account '$Account' can read project $projectId ($($names.Count) keys).")
    }
    'ListKeys' {
      foreach ($name in (Get-ProjectKeyName -BwsPath $bws -ProjectId $projectId -Token $token)) {
        [Console]::Out.WriteLine($name)
      }
    }
  }
  exit 0
} catch {
  Stop-WithClassification $classification
}
