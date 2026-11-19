param([Parameter(Mandatory)][string]$Parent)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'windows-run-custody.ps1'
$run = Join-Path $Parent 'run'
try { & $script -Action VerifyRoot -Path $Parent } catch { $inheritedRefused = $true }
if (-not $inheritedRefused) { throw 'An inherited root was accepted.' }

& $script -Action Create -Path $run
& $script -Action VerifyRoot -Path $run
$seal = Join-Path $run 'synthetic-seal'
[IO.File]::WriteAllText($seal, 'synthetic')
& $script -Action Verify -Path $seal

try { & $script -Action Create -Path $run } catch { $recreationRefused = $true }
if (-not $recreationRefused) { throw 'An existing run was accepted.' }

'owner-only custody verified'
