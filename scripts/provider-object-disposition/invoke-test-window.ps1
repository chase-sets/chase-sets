[CmdletBinding()]
param([string]$CandidateHead, [string]$ManifestPath, [string]$ManifestSha256, [switch]$AuthorizeOneTestWindow)

$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine('provider-test-window: refused; authority or publication unavailable'); exit 2 }
if (-not $AuthorizeOneTestWindow -or $CandidateHead -cnotmatch '^[a-f0-9]{40}$' -or $ManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or -not [IO.Path]::IsPathFullyQualified($ManifestPath)) {
  [Console]::Out.WriteLine('{"version":"provider-lifecycle-capture/v1","classification":"refused","code":"authority-unavailable","replayQualified":false}')
  exit 2
}
# Do not strip or bypass a machine-admission preload. An inherited Node hook is
# executable code outside the reviewed provider launch, so refuse before starting
# the child. Verification remains under its normal admitted host.
if (-not [string]::IsNullOrWhiteSpace($env:NODE_OPTIONS)) { throw 'refused' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
if (-not [IO.Path]::IsPathFullyQualified($node)) { throw 'refused' }
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $node
$start.WorkingDirectory = $root
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.CreateNoWindow = $true
# Preserve only process/runtime lookup and the machine-admission preload. Provider,
# database, GitHub and application credentials never enter the operator child env.
$keep = @('PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'NODE_OPTIONS', 'CHASE_SETS_LANE_MODE')
$values = @{}
foreach ($name in $keep) { if ($start.Environment.ContainsKey($name)) { $values[$name] = $start.Environment[$name] } }
$start.Environment.Clear()
foreach ($name in $values.Keys) { $start.Environment[$name] = $values[$name] }
$loader = ([Uri]::new((Join-Path $root 'node_modules/tsx/dist/loader.mjs'))).AbsoluteUri
foreach ($argument in @('--import', $loader, (Join-Path $PSScriptRoot 'launch-test-window.ts'), '--candidate-head', $CandidateHead, '--manifest-path', $ManifestPath, '--manifest-sha256', $ManifestSha256, '--authorize-one-test-window')) {
  $start.ArgumentList.Add($argument)
}
$child = [Diagnostics.Process]::new()
$child.StartInfo = $start
if (-not $child.Start()) { throw 'refused' }
$stdout = $child.StandardOutput.ReadToEndAsync()
$stderr = $child.StandardError.ReadToEndAsync()
$child.WaitForExit()
$text = $stdout.GetAwaiter().GetResult()
$null = $stderr.GetAwaiter().GetResult()
$exitCode = $child.ExitCode
$child.Dispose()
# Publication begins only after the credentialed child has ended. No child stderr,
# exception, browser body, trace or raw response is copied to an artifact.
if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 1048576) { throw 'refused' }
try { $packet = $text | ConvertFrom-Json -AsHashtable } catch { $packet = $null }
if (-not $packet) {
  $packet = @{ version='provider-lifecycle-capture/v1'; classification='invalid'; code='child-interrupted'; replayQualified=$false; manifestDigest=$ManifestSha256 }
  $text = $packet | ConvertTo-Json -Compress
  $exitCode = 2
}
if ($packet.version -cne 'provider-lifecycle-capture/v1' -or $packet.replayQualified -ne $false -or $packet.classification -cnotin @('refused', 'invalid', 'unknown', 'observed')) { throw 'refused' }
if ($packet.classification -ceq 'refused' -and -not $packet.manifestDigest) { [Console]::Out.WriteLine($text.Trim()); exit $exitCode }
$start.ArgumentList.Clear()
foreach ($argument in @((Join-Path $PSScriptRoot 'publish-test-window.mjs'), $ManifestPath, $ManifestSha256)) { $start.ArgumentList.Add($argument) }
$start.RedirectStandardInput = $true
$publisher = [Diagnostics.Process]::new()
$publisher.StartInfo = $start
if (-not $publisher.Start()) { throw 'refused' }
$stdout = $publisher.StandardOutput.ReadToEndAsync()
$stderr = $publisher.StandardError.ReadToEndAsync()
$publisher.StandardInput.Write($text)
$publisher.StandardInput.Close()
$publisher.WaitForExit()
$result = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json -AsHashtable
$null = $stderr.GetAwaiter().GetResult()
if ($publisher.ExitCode -ne 0) { $publisher.Dispose(); throw 'refused' }
$publisher.Dispose()
[Console]::Out.WriteLine("provider-test-window: $($result.classification); packet SHA256 $($result.packetDigest); replayQualified=false")
exit $exitCode
