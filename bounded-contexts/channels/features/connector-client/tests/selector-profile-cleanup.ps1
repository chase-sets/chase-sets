[CmdletBinding()]
param([string]$AdmissionPath, [string]$EvidencePath)

$ErrorActionPreference = 'Stop'
$SelectorOperationCapabilityPolicyHash = '582200a0897dd14df915d17c12cb5965ff17524dc057320a9f5693c5442bc58d'

function Assert-SelectorCleanupTarget($Admission) {
  $root = $Admission.root
  $target = $Admission.profile
  if (-not [IO.Path]::IsPathFullyQualified($root) -or -not [IO.Path]::IsPathFullyQualified($target) -or
      [IO.Path]::GetFullPath($root) -cne $root -or [IO.Path]::GetFullPath($target) -cne $target -or
      $target -cne [IO.Path]::Combine($root, 'profile') -or
      [IO.Path]::GetFileName($root) -cnotmatch '^selector-(capability|sentinel|rehearsal|S|C)-[A-Za-z0-9-]+$' -or
      $Admission.policyIdentity -cne 'selector-agent-operation-capability-policy/v1' -or
      $Admission.policyHash -cne $SelectorOperationCapabilityPolicyHash -or $Admission.mode -cnotin @('S', 'C') -or
      $Admission.scope -cnotin @('capability', 'sentinel', 'rehearsal', 'S', 'C')) { throw 'CLEANUP_TARGET_REFUSED' }
  $identities = [Collections.Generic.List[string]]::new()
  for ($current = $target; $current; $current = [IO.Path]::GetDirectoryName($current)) {
    $item = Get-Item -LiteralPath $current -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkTarget) {
      throw 'CLEANUP_LINK_REFUSED'
    }
    $identities.Add("$($item.FullName)|$($item.CreationTimeUtc.Ticks)")
  }
  return ,$identities.ToArray()
}

function Initialize-SelectorCleanupNative {
  if (-not $IsWindows) { throw 'CLEANUP_NATIVE_WINDOWS_REQUIRED' }
  if ('SelectorCleanupNative' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class SelectorCleanupNative : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
    public System.Runtime.InteropServices.ComTypes.FILETIME Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref int value, uint size);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  SafeFileHandle handle;
  public readonly string Identity;
  public SelectorCleanupNative(string path, bool deletion) {
    // OPEN_REPARSE_POINT plus an atomic handle query prevents link-swap traversal.
    // Movable directories also need DELETE access: an attributes-only handle
    // does not exclude a directory rename on Windows.
    handle = CreateFile(path, 0x80u | (deletion ? 0x10000u : 0u), 3u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero);
    if (handle.IsInvalid) throw new Win32Exception();
    Info info;
    if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x10u) == 0 || (info.Attributes & 0x400u) != 0) {
      handle.Dispose(); throw new InvalidOperationException("CLEANUP_LINK_REFUSED");
    }
    Identity = info.Volume + ":" + info.IndexHigh + ":" + info.IndexLow;
  }
  public void DeleteOnClose() {
    int yes = 1;
    if (!SetFileInformationByHandle(handle, 4, ref yes, 4)) throw new Win32Exception();
  }
  public void Dispose() { if (handle != null) handle.Dispose(); }
  public static string[] Arguments(string command) {
    int count; IntPtr memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new Win32Exception();
    try {
      string[] result = new string[count];
      for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return result;
    } finally { LocalFree(memory); }
  }
}
'@
}

function Get-SelectorChromeCensus([string]$Target) {
  $matches = 0; $unknown = 0
  try {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'chrome%' OR Name LIKE 'chromium%'" -ErrorAction Stop)
    foreach ($process in $processes) {
      if (-not $process.CommandLine -or -not $process.CreationDate -or -not $process.ExecutablePath) { $unknown++; continue }
      try {
        $arguments = [SelectorCleanupNative]::Arguments($process.CommandLine)
        $profiles = [Collections.Generic.List[string]]::new()
        for ($i = 0; $i -lt $arguments.Length; $i++) {
          if ($arguments[$i] -ceq '--user-data-dir') {
            if ($i + 1 -ge $arguments.Length) { throw 'CENSUS_UNKNOWN' }
            $profiles.Add($arguments[++$i])
          } elseif ($arguments[$i].StartsWith('--user-data-dir=', [StringComparison]::Ordinal)) {
            $profiles.Add($arguments[$i].Substring(16))
          }
        }
        if ($profiles.Count -ne 1 -or -not [IO.Path]::IsPathFullyQualified($profiles[0])) { $unknown++; continue }
        if ([IO.Path]::GetFullPath($profiles[0]) -eq $Target) { $matches++ }
      } catch { $unknown++ }
    }
    return [ordered]@{ complete = $true; matches = $matches; unknown = $unknown; at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
  } catch { return [ordered]@{ complete = $false; matches = 0; unknown = 1; at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } }
}

function Assert-SelectorCensus($Census) {
  if ($Census.complete -isnot [bool] -or $Census.matches -isnot [int] -or $Census.unknown -isnot [int] -or
      $Census.complete -cne $true -or $Census.matches -cne 0 -or $Census.unknown -cne 0) { throw 'CLEANUP_CENSUS_REFUSED' }
}

function Assert-SelectorNativeIdentity($Admission, [string]$Directory, $Handle) {
  $rows = @($Admission.profileIdentity | Where-Object { $_[0] -ceq $Directory })
  if ($rows.Count -ne 1 -or $rows[0].Count -ne 4) { throw 'CLEANUP_IDENTITY_REFUSED' }
  $inode = [UInt64]::Parse($rows[0][2], [Globalization.CultureInfo]::InvariantCulture)
  $expected = "$($rows[0][1]):$($inode -shr 32):$($inode -band 4294967295)"
  if ($Handle.Identity -cne $expected) { throw 'CLEANUP_RACE_REFUSED' }
}

function Invoke-SelectorProfileCleanup([string]$AdmissionFile, [string]$EvidenceFile) {
  $disposition = 'REFUSED'
  $observations = [Collections.Generic.List[object]]::new()
  $held = [Collections.Generic.List[object]]::new()
  $directories = [Collections.Generic.List[object]]::new()
  $cause = 'CLEANUP_REFUSED'
  $evidenceSafe = $false
  $journal = $null
  $publicRunId = $null; $publicPolicyIdentity = $null; $publicPolicyHash = $null
  function Write-CleanupJournal([string]$State, [string]$Code) {
    $record = [ordered]@{ format = 'selector-profile-cleanup-result/v1'; runId = $publicRunId;
      policyIdentity = $publicPolicyIdentity; policyHash = $publicPolicyHash; cleanup = $State; code = $Code;
      at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); observations = $observations.ToArray() }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Depth 5 -Compress) + "`n")
    $journal.Write($bytes, 0, $bytes.Length); $journal.Flush($true)
  }
  try {
    if (-not [IO.Path]::IsPathFullyQualified($AdmissionFile) -or -not [IO.Path]::IsPathFullyQualified($EvidenceFile) -or
        (Get-Item -LiteralPath $AdmissionFile).Length -gt 4096 -or (Test-Path -LiteralPath $EvidenceFile)) { throw 'CLEANUP_ADMISSION_REFUSED' }
    $admission = Get-Content -LiteralPath $AdmissionFile -TotalCount 100 | ConvertFrom-Json -DateKind String
    $keys = @('format','root','profile','profileIdentity','scope','mode','runId','policyIdentity','policyHash','startedAt','normalClosedAt')
    if (@(Compare-Object ($admission.PSObject.Properties.Name | Sort-Object) ($keys | Sort-Object)).Count -ne 0 -or
        $admission.format -cne 'selector-profile-cleanup/v1' -or
        $admission.runId -cne [IO.Path]::GetFileName($admission.root) -or
        $admission.profileIdentity.Count -gt 100 -or $admission.profileIdentity.Count -lt 2) { throw 'CLEANUP_ADMISSION_REFUSED' }
    $identity = Assert-SelectorCleanupTarget $admission
    $publicRunId = $admission.runId; $publicPolicyIdentity = $admission.policyIdentity; $publicPolicyHash = $admission.policyHash
    $evidenceDirectory = [IO.Path]::GetDirectoryName($EvidenceFile)
    if ($EvidenceFile.StartsWith($admission.profile + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        $EvidenceFile -eq $admission.profile) { throw 'CLEANUP_EVIDENCE_REFUSED' }
    for ($current = $evidenceDirectory; $current; $current = [IO.Path]::GetDirectoryName($current)) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkTarget) { throw 'CLEANUP_EVIDENCE_REFUSED' }
    }
    $evidenceSafe = $true
    # Append-only, outside the profile. An interrupted child leaves durable
    # PENDING ownership, never an age-based permission to reclaim this root.
    $journal = [IO.File]::Open($EvidenceFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    Write-CleanupJournal 'PENDING' 'CLEANUP_PENDING'
    $started = [DateTimeOffset]::ParseExact($admission.startedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    $closed = [DateTimeOffset]::ParseExact($admission.normalClosedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    if ($closed -lt $started -or $closed -gt [DateTimeOffset]::UtcNow) { throw 'CLEANUP_CLOSE_REQUIRED' }
    Initialize-SelectorCleanupNative
    for ($parent = [IO.Path]::GetDirectoryName($admission.profile); $parent; $parent = [IO.Path]::GetDirectoryName($parent)) {
      $movable = $parent -cne [IO.Path]::GetPathRoot($parent)
      $handle = [SelectorCleanupNative]::new($parent, $movable)
      $held.Add($handle); Assert-SelectorNativeIdentity $admission $parent $handle
    }
    $queue = [Collections.Generic.Queue[string]]::new(); $queue.Enqueue($admission.profile)
    $files = [Collections.Generic.List[string]]::new()
    while ($queue.Count -gt 0) {
      $directory = $queue.Dequeue()
      $lock = [SelectorCleanupNative]::new($directory, $true)
      $held.Add($lock); $directories.Add($lock)
      if ($directory -ceq $admission.profile) { Assert-SelectorNativeIdentity $admission $directory $lock }
      foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkTarget) { throw 'CLEANUP_LINK_REFUSED' }
        if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) } else { $files.Add($item.FullName) }
      }
    }
    $first = Get-SelectorChromeCensus $admission.profile; $observations.Add($first); Write-CleanupJournal 'PENDING' 'CLEANUP_PENDING'; Assert-SelectorCensus $first
    if (@(Compare-Object $identity (Assert-SelectorCleanupTarget $admission)).Count -ne 0) { throw 'CLEANUP_RACE_REFUSED' }
    $second = Get-SelectorChromeCensus $admission.profile; $observations.Add($second); Write-CleanupJournal 'PENDING' 'CLEANUP_PENDING'; Assert-SelectorCensus $second
    $disposition = 'FAILED'
    foreach ($file in $files) { [IO.File]::Delete($file) }
    for ($i = $directories.Count - 1; $i -ge 0; $i--) { $directories[$i].DeleteOnClose(); $directories[$i].Dispose() }
    if (Test-Path -LiteralPath $admission.profile) { throw 'CLEANUP_ABSENCE_FAILED' }
    $third = Get-SelectorChromeCensus $admission.profile; $observations.Add($third); Write-CleanupJournal 'PENDING' 'CLEANUP_PENDING'; Assert-SelectorCensus $third
    $fourth = Get-SelectorChromeCensus $admission.profile; $observations.Add($fourth); Write-CleanupJournal 'PENDING' 'CLEANUP_PENDING'; Assert-SelectorCensus $fourth
    if (Test-Path -LiteralPath $admission.profile) { throw 'CLEANUP_ABSENCE_FAILED' }
    $disposition = if ([DateTimeOffset]::UtcNow -gt $started.AddMinutes(15)) { 'LATE' } else { 'TIMELY_VERIFIED' }
    $cause = 'CLEANUP_OBSERVED'
  } catch {
    # Never echo command lines, native exceptions, admission contents or paths.
    $cause = 'CLEANUP_REFUSED'
  } finally {
    for ($i = $held.Count - 1; $i -ge 0; $i--) { $held[$i].Dispose() }
  }
  $result = [ordered]@{ format = 'selector-profile-cleanup-result/v1'; runId = $publicRunId;
    policyIdentity = $publicPolicyIdentity; policyHash = $publicPolicyHash; cleanup = $disposition; code = $cause;
    at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); observations = $observations.ToArray() }
  if ($evidenceSafe -and $journal) {
    try { Write-CleanupJournal $disposition $cause }
    catch { $result.cleanup = 'FAILED'; $result.code = 'CLEANUP_REFUSED' }
    finally { $journal.Dispose() }
  }
  return $result
}

if ($MyInvocation.InvocationName -ne '.') {
  $result = Invoke-SelectorProfileCleanup $AdmissionPath $EvidencePath
  $result | ConvertTo-Json -Depth 5
  if ($result.cleanup -cne 'TIMELY_VERIFIED') { exit 1 }
}
