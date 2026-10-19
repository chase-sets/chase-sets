# Stub for bitwarden-agent-credential.psm1. agent-secrets.test.mjs copies it
# beside the helper scripts under the real module's name, so no test touches
# Windows Credential Manager. stub-credential.json beside it supplies the
# stored credential, and every call, including the import, is appended to
# stub-credential.log beside it.
Set-StrictMode -Version Latest

function Write-StubCall([string]$Operation, [string]$Account) {
  $record = [pscustomobject]@{ op = $Operation; account = $Account } | ConvertTo-Json -Compress
  [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'stub-credential.log'), "$record`n")
}

Write-StubCall 'import' ''

function Get-AgentCredentialTarget {
  param([Parameter(Mandatory)][string]$Account)
  "chase-sets/bws/$Account"
}

function Set-AgentBwsCredential {
  param(
    [Parameter(Mandatory)][string]$Account,
    [Parameter(Mandatory)][guid]$ProjectId,
    [Parameter(Mandatory)][securestring]$AccessToken
  )
  Write-StubCall 'write' $Account
}

function Get-AgentBwsCredential {
  param([Parameter(Mandatory)][string]$Account)
  Write-StubCall 'read' $Account
  $stored = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'stub-credential.json') -Raw | ConvertFrom-Json
  if (-not $stored.present) { return $null }
  [pscustomobject]@{ Target = "chase-sets/bws/$Account"; ProjectId = [guid]$stored.projectId; AccessToken = $stored.token }
}

function Remove-AgentBwsCredential {
  param([Parameter(Mandatory)][string]$Account)
  Write-StubCall 'delete' $Account
  $true
}

Export-ModuleMember -Function Get-AgentCredentialTarget, Set-AgentBwsCredential, Get-AgentBwsCredential, Remove-AgentBwsCredential
