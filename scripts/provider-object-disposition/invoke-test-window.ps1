[CmdletBinding()]
param([string]$CandidateHead, [string]$ManifestPath, [string]$ManifestSha256, [switch]$AuthorizeOneTestWindow)

$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine('provider-test-window: refused; authority or publication unavailable'); exit 2 }
if (-not $AuthorizeOneTestWindow -or $CandidateHead -cnotmatch '^[a-f0-9]{40}$' -or $ManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or -not [IO.Path]::IsPathFullyQualified($ManifestPath) -or $ManifestPath -match '^[\\/]{2}') {
  [Console]::Out.WriteLine('{"version":"provider-lifecycle-capture/v1","classification":"refused","code":"authority-unavailable","replayQualified":false}')
  exit 2
}
if (-not [string]::IsNullOrWhiteSpace($env:NODE_OPTIONS)) { throw 'refused' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
if (-not [IO.Path]::IsPathFullyQualified($node)) { throw 'refused' }

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
public sealed class BoundaryOutput {
  public string Text;
  public bool Overflow;
  public int Bytes;
  public static async Task<BoundaryOutput> Read(TextReader reader, bool keep, Process child) {
    const int limit = 1048576;
    var result = new BoundaryOutput();
    var text = new StringBuilder();
    var buffer = new char[4096];
    int count;
    while ((count = await reader.ReadAsync(buffer, 0, buffer.Length)) != 0) {
      result.Bytes = Math.Min(limit + 1, result.Bytes + Encoding.UTF8.GetByteCount(buffer, 0, count));
      if (result.Bytes > limit) {
        result.Overflow = true;
        text.Clear();
        try { if (!child.HasExited) child.Kill(); } catch { }
      } else if (keep && !result.Overflow) text.Append(buffer, 0, count);
    }
    result.Text = text.ToString();
    return result;
  }
}
'@

$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $node
$start.WorkingDirectory = $root
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.CreateNoWindow = $true
$keep = @('PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'NODE_OPTIONS', 'CHASE_SETS_LANE_MODE')
$values = @{}
foreach ($name in $keep) { if ($start.Environment.ContainsKey($name)) { $values[$name] = $start.Environment[$name] } }
$start.Environment.Clear()
foreach ($name in $values.Keys) { $start.Environment[$name] = $values[$name] }

function Invoke-BoundaryChild([string[]]$Arguments, [AllowNull()][object]$Payload) {
  $start.ArgumentList.Clear()
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $start.RedirectStandardInput = $null -ne $Payload
  $child = [Diagnostics.Process]::new()
  $child.StartInfo = $start
  $started = $false
  try {
    if (-not $child.Start()) { throw 'refused' }
    $started = $true
    $stdout = [BoundaryOutput]::Read($child.StandardOutput, $true, $child)
    $stderr = [BoundaryOutput]::Read($child.StandardError, $false, $child)
    if ($null -ne $Payload) { $child.StandardInput.Write($Payload); $child.StandardInput.Close() }
    if (-not $child.WaitForExit(3606000)) { $child.Kill(); if (-not $child.WaitForExit(2000)) { throw 'refused' } }
    $output = $stdout.GetAwaiter().GetResult()
    $errorOutput = $stderr.GetAwaiter().GetResult()
    return @{ Text=$output.Text; Code=$child.ExitCode; Invalid=$output.Overflow -or $errorOutput.Overflow -or $errorOutput.Bytes -ne 0 }
  } finally {
    if ($started -and -not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(2000) }
    $child.Dispose()
  }
}

$loader = ([Uri]::new((Join-Path $root 'node_modules/tsx/dist/loader.mjs'))).AbsoluteUri
$result = Invoke-BoundaryChild @('--import', $loader, (Join-Path $PSScriptRoot 'launch-test-window.ts'), '--candidate-head', $CandidateHead, '--manifest-path', $ManifestPath, '--manifest-sha256', $ManifestSha256, '--authorize-one-test-window') $null
$text = $result.Text
try { $packet = $text | ConvertFrom-Json -AsHashtable } catch { $packet = $null }
if ($result.Invalid -or -not $packet) {
  $packet = @{ version='provider-lifecycle-capture/v1'; classification='invalid'; code='child-interrupted'; replayQualified=$false; manifestDigest=$ManifestSha256 }
  $text = $packet | ConvertTo-Json -Compress
  $result.Code = 2
}
if ($packet.classification -ceq 'refused' -and -not $packet.manifestDigest) {
  if ((($packet.Keys | Sort-Object) -join ',') -cne 'classification,code,replayQualified,version' -or $packet.version -cne 'provider-lifecycle-capture/v1' -or $packet.code -cne 'authority-unavailable' -or $packet.replayQualified -ne $false -or $result.Code -ne 2) { throw 'refused' }
  [Console]::Out.WriteLine('{"version":"provider-lifecycle-capture/v1","classification":"refused","code":"authority-unavailable","replayQualified":false}')
  exit 2
}
if (($packet.classification -cin @('observed','unknown') -and $result.Code -ne 0) -or ($packet.classification -cin @('refused','invalid') -and $result.Code -ne 2)) { throw 'refused' }
# The publisher revalidates the entire recursive packet after the private child ends.
$published = Invoke-BoundaryChild @((Join-Path $PSScriptRoot 'publish-test-window.mjs'), $ManifestPath, $ManifestSha256) $text
if ($published.Invalid -or $published.Code -ne 0) { throw 'refused' }
$receipt = $published.Text | ConvertFrom-Json -AsHashtable
if ((($receipt.Keys | Sort-Object) -join ',') -cne 'classification,packetDigest,replayQualified' -or $receipt.packetDigest -cnotmatch '^[a-f0-9]{64}$' -or $receipt.classification -cnotin @('refused','invalid','unknown','observed') -or $receipt.replayQualified -ne $false) { throw 'refused' }
[Console]::Out.WriteLine("provider-test-window: $($receipt.classification); packet SHA256 $($receipt.packetDigest); replayQualified=false")
exit $result.Code
