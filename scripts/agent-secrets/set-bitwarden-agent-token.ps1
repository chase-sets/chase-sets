#Requires -Version 7
<#
.SYNOPSIS
Todd only: store or remove the Bitwarden Secrets Manager machine-account token
that scripts/agent-secrets/with-secrets.ps1 reads from Windows Credential Manager.

.DESCRIPTION
Run this yourself in an interactive terminal. The token is read with a masked
prompt so it never passes through an agent transcript, an argument list or a
pipe; redirected input and non-interactive sessions are refused. After storing,
the script runs with-secrets.ps1 -Check and -ListKeys, which print key names only.
-Remove deletes the stored credential; also revoke the token in Bitwarden.

.EXAMPLE
pwsh -NoProfile -File scripts/agent-secrets/set-bitwarden-agent-token.ps1 -ProjectId <project-guid>

.EXAMPLE
pwsh -NoProfile -File scripts/agent-secrets/set-bitwarden-agent-token.ps1 -Remove
#>
[CmdletBinding(DefaultParameterSetName = 'Set')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Set')][guid]$ProjectId,
  [Parameter(Mandatory, ParameterSetName = 'Remove')][switch]$Remove,
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,62}$')][string]$Account = 'lanes'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:CHASE_SETS_AGENT_SECRETS -eq 'deny') {
  [Console]::Error.WriteLine('set-bitwarden-agent-token: denied: CHASE_SETS_AGENT_SECRETS=deny')
  exit 2
}
if (-not $Remove -and ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive)) {
  [Console]::Error.WriteLine('set-bitwarden-agent-token: refused: run this yourself in an interactive terminal and paste the token at the masked prompt')
  exit 2
}
Import-Module (Join-Path $PSScriptRoot 'bitwarden-agent-credential.psm1') -Force -DisableNameChecking

if ($Remove) {
  if (Remove-AgentBwsCredential -Account $Account) {
    [Console]::Out.WriteLine("Removed $(Get-AgentCredentialTarget $Account). Also revoke the access token in Bitwarden.")
  } else {
    [Console]::Out.WriteLine("No credential stored for account '$Account'.")
  }
  exit 0
}

$token = Read-Host -AsSecureString -Prompt "Paste the machine-account access token for account '$Account'"
try {
  if ($token.Length -eq 0) {
    [Console]::Error.WriteLine('set-bitwarden-agent-token: refused: no token entered')
    exit 2
  }
  Set-AgentBwsCredential -Account $Account -ProjectId $ProjectId -AccessToken $token
} finally {
  $token.Dispose()
}
[Console]::Out.WriteLine("Stored $(Get-AgentCredentialTarget $Account) for project $ProjectId. Verifying...")
$withSecrets = Join-Path $PSScriptRoot 'with-secrets.ps1'
& $withSecrets -Check -Account $Account
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $withSecrets -ListKeys -Account $Account
exit $LASTEXITCODE
