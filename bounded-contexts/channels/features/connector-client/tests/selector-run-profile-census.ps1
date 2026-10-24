#Requires -Version 7.0
# selector-run-profile-census/v1 (#9628, amended by #9651): a run-owned job and the narrowed Chrome
# census over one in-process observation. Dot-source for Start-SelectorRunOwned and
# Get-SelectorRunProfileCensus.
# `-Action witness` (admission JSON on stdin, never a path on argv) is the host verifier's witness.
# Owned processes close normally or exit on their own; the only deletion here is the witness's own
# scratch root after a CLEAR census.

$ErrorActionPreference = 'Stop'
$script:SelectorPathComparison = [StringComparison]::OrdinalIgnoreCase
$script:SelectorEntryLimit = 20000
# Checked between primitive calls from root resolution to completion. A native call in progress is
# not cancelled (CIM enumeration has its own 60 s operation timeout), so it is not a hard wall clock.
$script:SelectorCensusTimeoutMs = 120000
# One budget for a refused start: driver exit and the held job draining both fall inside it.
$script:SelectorGrantTimeoutMs = 30000
$script:SelectorDrainPollMs = 25
$script:SelectorLaunchTimeoutMs = 120000
$script:SelectorCloseTimeoutMs = 120000
$script:SelectorAdmissionLimit = 4096
$script:SelectorDefaultUserData = @(
  'Google\Chrome\User Data', 'Google\Chrome Beta\User Data', 'Google\Chrome Dev\User Data',
  'Google\Chrome SxS\User Data', 'Chromium\User Data')
$script:SelectorCountKeys = @(
  'processes', 'members', 'default', 'defaultRoots', 'other', 'chromeUnreadable', 'chromeAmbiguous',
  'chromeRootConflict', 'referenced', 'unresolved', 'unreadable', 'entries', 'holders')

# --- L5 path law: lexical normalization, then canonical resolution through native primitives ---

# Returns $null for a non-reference (relative, drive-relative, environment variable, URI, device
# namespace), 'UNRESOLVABLE' for volume-GUID/GLOBALROOT device paths, else @{ drive|server+share; parts }.
function ConvertTo-SelectorPath([string]$Token, [string[]]$LocalNames) {
  if ([string]::IsNullOrEmpty($Token)) { return $null }
  $text = $Token
  if ($text.Length -ge 2 -and (($text[0] -eq '"' -and $text[-1] -eq '"') -or ($text[0] -eq "'" -and $text[-1] -eq "'"))) {
    $text = $text.Substring(1, $text.Length - 2)
  }
  $text = $text.Replace('/', '\')
  if ($text -match '^\\(\\[?.]|\?\?)\\') {
    $text = $text.Substring(4)
    if ($text -match '^UNC\\') { $text = '\' + $text.Substring(3) }
    elseif ($text -match '^(Volume\{|GLOBALROOT(\\|$))') { return 'UNRESOLVABLE' }
    elseif ($text -notmatch '^[A-Za-z]:\\') { return $null }
  }
  if ($text -match '^([A-Za-z]):(\\.*)$') {
    $path = @{ drive = $Matches[1].ToUpperInvariant(); server = $null; share = $null }
    $rest = $Matches[2]
  } elseif ($text -match '^\\\\([^\\]+)\\([^\\]+)(\\.*)?$') {
    $path = @{ drive = $null; server = $Matches[1]; share = $Matches[2] }
    $rest = [string]$Matches[3]
    if ($path.share -match '^([A-Za-z])\$$' -and @($LocalNames | Where-Object { $_ -and $_.Equals($path.server, $script:SelectorPathComparison) }).Count) {
      $path = @{ drive = $Matches[1].ToUpperInvariant(); server = $null; share = $null }
    }
  } else { return $null }
  $parts = [Collections.Generic.List[string]]::new()
  foreach ($segment in $rest.Split('\')) {
    if ($segment -eq '' -or $segment -eq '.') { continue }
    if ($segment -eq '..') { if ($parts.Count) { $parts.RemoveAt($parts.Count - 1) }; continue }
    # Win32 trims trailing dots and spaces; a run of three or more dots is a real name.
    $name = if ($segment -match '^\.{3,}$') { $segment } else { $segment.TrimEnd('.', ' ') }
    if ($name) { $parts.Add($name) }
  }
  $path.parts = $parts.ToArray()
  return $path
}

function Format-SelectorPath($Path) {
  $base = if ($Path.drive) { "$($Path.drive):" } else { "\\$($Path.server)\$($Path.share)" }
  return $base + '\' + (@($Path.parts) -join '\')
}

# Whole components, OrdinalIgnoreCase: equal to or inside $Outer.
function Test-SelectorPathWithin([string]$Inner, [string]$Outer) {
  if (-not $Inner -or -not $Outer) { return $false }
  return $Inner.Equals($Outer, $script:SelectorPathComparison) -or $Inner.StartsWith($Outer.TrimEnd('\') + '\', $script:SelectorPathComparison)
}

# Canonical = final DOS path of the longest existing prefix plus the retained tail; without one, the
# path is unresolved. Only an L5 argv candidate (-Candidate, #9651 R1) continues past an entry the OS
# reports is not nameable (123); its results keep their own cache, so run/default-root and Chrome
# user-data-dir resolution never see one.
function Resolve-SelectorPath($Path, $Context, [switch]$Candidate) {
  $unresolved = @{ state = 'UNRESOLVED'; text = $null }
  if ($Path -isnot [hashtable]) { return $unresolved }
  $text = Format-SelectorPath $Path
  # UNC and non-fixed volumes stay lexical; v1 proves no equivalence for them.
  if (-not $Path.drive -or -not (& $Context.native.DriveFixed $Path.drive)) { return @{ state = 'RESOLVED'; text = $text } }
  $cache = if ($Candidate) { $Context.candidateCache } else { $Context.cache }
  if ($cache.ContainsKey($text)) { return $cache[$text] }
  $absent = if ($Candidate) { 2, 3, 123 } else { 2, 3 }
  $resolved = $unresolved
  $parts = @($Path.parts)
  for ($k = $parts.Count; $k -ge 0; $k--) {
    $head = if ($k) { $parts[0..($k - 1)] } else { @() }
    $prefix = Format-SelectorPath @{ drive = $Path.drive; parts = $head }
    # Non-traversing, attribute-only open of the entry itself. Only a failed open, never a metadata
    # query on an opened entry, can mean absent (2/3) or not nameable (123) and try a shorter prefix.
    $entry = & $Context.native.Open $prefix $false
    if ($entry.Code -eq 0) {
      # A failed follow or unparseable final path of an existing entry leaves the path unresolved.
      $followed = & $Context.native.Open $prefix $true
      $final = if ($followed.Code -eq 0) { ConvertTo-SelectorPath $followed.Final $Context.names } else { $null }
      if ($final -is [hashtable]) {
        $tail = if ($k -lt $parts.Count) { $parts[$k..($parts.Count - 1)] } else { @() }
        $final.parts = @($final.parts) + @($tail)
        $resolved = @{ state = 'RESOLVED'; text = Format-SelectorPath $final }
      }
      break
    }
    if ($entry.Opened -or $entry.Code -notin $absent) { break }
  }
  $cache[$text] = $resolved
  return $resolved
}

# Candidates: every token, the value after the first '=' of a -, -- or / switch, and the token after
# a bare user-data-dir switch (case-insensitive).
function Get-SelectorReferenceCandidates([string[]]$Argv) {
  for ($i = 0; $i -lt $Argv.Count; $i++) {
    $token = $Argv[$i]
    @{ value = $token; userDataDir = $false }
    if ($token -match '^(?s)(?:--?|/)([^=]+)=(.*)$') {
      @{ value = $Matches[2]; userDataDir = $Matches[1] -ieq 'user-data-dir' }
    } elseif ($token -imatch '^(?:--?|/)user-data-dir$' -and $i + 1 -lt $Argv.Count) {
      @{ value = $Argv[$i + 1]; userDataDir = $true }
    }
  }
}

function Get-SelectorReferenceState([string[]]$Argv, $Context) {
  $state = $null
  foreach ($candidate in Get-SelectorReferenceCandidates $Argv) {
    $path = ConvertTo-SelectorPath $candidate.value $Context.names
    if ($null -eq $path) { continue }
    $resolved = Resolve-SelectorPath $path $Context -Candidate
    if ($resolved.state -ceq 'UNRESOLVED') { $state = 'UNRESOLVED'; continue }
    if ((Test-SelectorPathWithin $resolved.text $Context.profile) -or
        ($candidate.userDataDir -and (Test-SelectorPathWithin $Context.profile $resolved.text))) { return 'REFERENCED' }
  }
  return $state
}

function Get-SelectorChromeSwitches([string[]]$Argv) {
  $values = [Collections.Generic.List[string]]::new()
  $bare = $false; $root = $true
  foreach ($token in $Argv) {
    if ($token -match '^(?s)(?:--?|/)user-data-dir=(.*)$') { $values.Add($Matches[1]) }
    elseif ($token -imatch '^(?:--?|/)user-data-dir$') { $bare = $true }
    if ($token -imatch '^(?:--?|/)type(=|$)') { $root = $false }
  }
  return @{ values = $values.ToArray(); bare = $bare; root = $root }
}

# --- L1: run paths, from paths only, before any collection or creation ---

function Get-SelectorRunPaths([string]$Root, $Native) {
  $names = @(& $Native.LocalNames)
  $rootPath = ConvertTo-SelectorPath $Root $names
  if ($rootPath -isnot [hashtable] -or -not $rootPath.drive -or $rootPath.parts.Count -eq 0 -or (Format-SelectorPath $rootPath) -cne $Root) {
    throw 'ROOT_ADMISSION_REFUSED'
  }
  $comparer = [StringComparer]::FromComparison($script:SelectorPathComparison)
  $context = @{ names = $names; native = $Native; cache = [Collections.Generic.Dictionary[string, object]]::new($comparer);
    candidateCache = [Collections.Generic.Dictionary[string, object]]::new($comparer) }
  $profilePath = ConvertTo-SelectorPath "$Root\profile" $names
  $context.profileLexical = Format-SelectorPath $profilePath
  $resolvedRoot = Resolve-SelectorPath $rootPath $context
  $resolvedProfile = Resolve-SelectorPath $profilePath $context
  if ($resolvedRoot.state -cne 'RESOLVED' -or $resolvedProfile.state -cne 'RESOLVED') { throw 'ROOT_UNRESOLVED' }
  $context.root = $resolvedRoot.text
  $context.profile = $resolvedProfile.text
  $context.conflict = $false
  $base = & $Native.LocalAppData
  foreach ($suffix in $script:SelectorDefaultUserData) {
    $default = ConvertTo-SelectorPath "$base\$suffix" $names
    $resolved = Resolve-SelectorPath $default $context
    if ($resolved.state -cne 'RESOLVED') { throw 'DEFAULT_ROOT_UNRESOLVED' }
    foreach ($pair in @(@($Root, (Format-SelectorPath $default)), @($context.root, $resolved.text))) {
      if ((Test-SelectorPathWithin $pair[0] $pair[1]) -or (Test-SelectorPathWithin $pair[1] $pair[0])) { $context.conflict = $true }
    }
  }
  return $context
}

function Test-SelectorRunRoot([string]$Root, $Native) {
  try {
    if ((Get-SelectorRunPaths $Root $Native).conflict) { return 'ROOT_CONFLICT' }
    return 'CLEAR'
  } catch { return 'CENSUS_INCOMPLETE' }
}

# --- L3/L4 inputs: the run job, its limits and its handle-verified members ---

function Get-SelectorJobMembers($Run, $Native, $Held) {
  foreach ($id in @(& $Native.JobPids $Run.job)) {
    # The member is the process whose opened handle is in the job; the handle stays open through the
    # observation so its PID cannot be reused, and a vanished PID is an exited process.
    $member = & $Native.OpenMember ([long]$id) $Run.job
    if ($null -eq $member) { continue }
    $Held.Add($member)
    if ($member.InJob -and $member.Alive) {
      @{ pid = [long]$member.Pid; created = [long]$member.Created }
    }
  }
}

function Get-SelectorRunTracking($Run, $Native, $Held) {
  # No launched run: pre-launch, or a refused start that never had (or no longer has) a child.
  if ($null -eq $Run -or $Run.state -ceq 'REFUSED') { return @{ state = 'NONE'; members = @() } }
  try {
    if ($Run.state -cne 'GRANTED' -or $null -eq $Run.job) { return @{ state = 'LOST'; members = @() } }
    if ((& $Native.JobLimits $Run.job) -cne $Run.limits) { return @{ state = 'LOST'; members = @() } }
    $members = @(Get-SelectorJobMembers $Run $Native $Held)
    # The PID list is not atomic: a listed process can create a child and exit before its handle opens.
    # No live member means an empty job only when the same job counts no active process.
    if (-not $members.Count -and (& $Native.JobActive $Run.job) -ne 0) { return @{ state = 'LOST'; members = @() } }
    return @{ state = 'HELD'; members = $members }
  } catch { return @{ state = 'LOST'; members = @() } }
}

function Get-SelectorProfileHolders([string]$RunProfile, $Native, [DateTime]$Deadline) {
  $pids = [Collections.Generic.HashSet[long]]::new()
  $top = & $Native.Entry $RunProfile
  if ($top.Code -in 2, 3) { return @{ entries = 0; pids = $pids } }
  if ($top.Code -ne 0) { throw 'ENTRY_QUERY_FAILED' }
  $queue = [Collections.Generic.Queue[object]]::new()
  $queue.Enqueue(@{ path = $RunProfile; directory = [bool]$top.Directory; reparse = [bool]$top.Reparse })
  $count = 0
  while ($queue.Count) {
    $entry = $queue.Dequeue()
    $count++
    if ($count + $queue.Count -gt $script:SelectorEntryLimit -or (& $Native.Now) -gt $Deadline) { throw 'ENTRY_LIMIT' }
    # Every directory and file, attribute-only and without reparse traversal.
    foreach ($holder in @(& $Native.Holders $entry.path)) { [void]$pids.Add([long]$holder) }
    if ($entry.directory -and -not $entry.reparse) {
      foreach ($child in @(& $Native.List $entry.path)) { $queue.Enqueue($child) }
    }
  }
  return @{ entries = $count; pids = $pids }
}

function New-SelectorCensusResult {
  $counts = [ordered]@{}
  foreach ($key in $script:SelectorCountKeys) { $counts[$key] = $null }
  return [ordered]@{ format = 'selector-run-profile-census/v1'; complete = $false; verdict = 'BLOCKED';
    code = 'CENSUS_INCOMPLETE'; counts = $counts; at = $null; defaultRootDigest = $null }
}

function Get-SelectorDigest([string[]]$Lines) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Lines -join "`n"))
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

# One in-process observation of root, <root>\profile, the run job and the admitted browser
# PID+start; first match of L1-L7 wins. The result carries no path, command line, non-run PID or
# exception text.
function Get-SelectorRunProfileCensus {
  param([string]$Root, $Run, $Admitted, $Native)
  $result = New-SelectorCensusResult
  $held = [Collections.Generic.List[object]]::new()
  try {
    if ($null -eq $Native) { $Native = New-SelectorRunProfileNative }
    $deadline = (& $Native.Now).AddMilliseconds($script:SelectorCensusTimeoutMs)
    $context = Get-SelectorRunPaths $Root $Native
    if ($context.conflict) { $result.code = 'ROOT_CONFLICT'; return $result }
    $self = & $Native.Self
    $tracking = Get-SelectorRunTracking $Run $Native $held
    $processes = @(& $Native.Processes)
    $entries = Get-SelectorProfileHolders $context.profileLexical $Native $deadline
    if ((& $Native.Now) -gt $deadline) { throw 'CENSUS_TIMEOUT' }
    $result.counts.processes = $processes.Count
    $result.counts.entries = $entries.entries
    if ($tracking.state -ceq 'LOST') { $result.code = 'RUN_TRACKING_INCOMPLETE'; return $result }
    $members = @($tracking.members)
    $memberPids = [Collections.Generic.HashSet[long]]::new()
    $memberKeys = [Collections.Generic.HashSet[string]]::new()
    foreach ($member in $members) { [void]$memberPids.Add($member.pid); [void]$memberKeys.Add("$($member.pid):$($member.created)") }
    $tally = @{ default = 0; other = 0; CHROME_UNREADABLE = 0; CHROME_AMBIGUOUS = 0; ROOT_CONFLICT = 0; REFERENCED = 0; UNRESOLVED = 0; unreadable = 0 }
    $roots = [Collections.Generic.List[string]]::new()
    foreach ($process in $processes) {
      if ([long]$process.pid -eq $self.pid -or $memberKeys.Contains("$($process.pid):$($process.created)")) { continue }
      $chrome = $process.name -like 'chrome*' -or $process.name -like 'chromium*'
      if ($null -ne $process.argv) {
        $state = Get-SelectorReferenceState $process.argv $context
        if ($state) { $tally[$state]++ }
      } elseif (-not $chrome) { $tally.unreadable++ }
      if (-not $chrome) { continue }
      if ($null -eq $process.argv -or $null -eq $process.created -or -not $process.executable) {
        $class = 'CHROME_UNREADABLE'
      } else {
        $switches = Get-SelectorChromeSwitches $process.argv
        if ($switches.bare -or $switches.values.Count -gt 1) {
          $class = 'CHROME_AMBIGUOUS'
        } elseif ($switches.values.Count -eq 0) {
          $class = 'DEFAULT'
          if ($switches.root) { $roots.Add("$($process.pid):$($process.created)") }
        } else {
          $resolved = Resolve-SelectorPath (ConvertTo-SelectorPath $switches.values[0] $context.names) $context
          $class = if ($resolved.state -cne 'RESOLVED') { 'CHROME_AMBIGUOUS' }
            elseif ((Test-SelectorPathWithin $resolved.text $context.root) -or (Test-SelectorPathWithin $context.root $resolved.text)) { 'ROOT_CONFLICT' }
            else { 'OTHER' }
        }
      }
      if ($class -ceq 'DEFAULT') { $tally.default++ } elseif ($class -ceq 'OTHER') { $tally.other++ } else { $tally[$class]++ }
    }
    $foreign = @($entries.pids | Where-Object { $_ -ne $self.pid -and -not $memberPids.Contains([long]$_) })
    $counts = $result.counts
    $counts.members = $members.Count; $counts.default = $tally.default; $counts.defaultRoots = $roots.Count
    $counts.other = $tally.other; $counts.chromeUnreadable = $tally.CHROME_UNREADABLE
    $counts.chromeAmbiguous = $tally.CHROME_AMBIGUOUS; $counts.chromeRootConflict = $tally.ROOT_CONFLICT
    $counts.referenced = $tally.REFERENCED; $counts.unresolved = $tally.UNRESOLVED
    $counts.unreadable = $tally.unreadable; $counts.holders = $foreign.Count
    $result.defaultRootDigest = Get-SelectorDigest @($roots | Sort-Object { [long]($_ -split ':')[0] }, { [long]($_ -split ':')[1] })
    if ((& $Native.Now) -gt $deadline) { throw 'CLASSIFICATION_TIMEOUT' }
    $result.complete = $true
    $result.code = if ($members.Count) {
      $named = @($members | Where-Object { $_.pid -eq $Admitted.pid })
      if ($null -ne $Admitted -and (($named.Count -and $named[0].created -ne $Admitted.created) -or
          (-not $named.Count -and @($processes | Where-Object { [long]$_.pid -eq $Admitted.pid }).Count))) { 'RUN_IDENTITY_MISMATCH' }
      else { 'RUN_TREE_ALIVE' }
    } elseif ($tally.REFERENCED) { 'RUN_PROFILE_REFERENCED' }
    elseif ($tally.UNRESOLVED) { 'REFERENCE_UNRESOLVED' }
    elseif ($foreign.Count) { 'RUN_PROFILE_HELD' }
    elseif ($tally.CHROME_UNREADABLE) { 'CHROME_UNREADABLE' }
    elseif ($tally.CHROME_AMBIGUOUS) { 'CHROME_AMBIGUOUS' }
    elseif ($tally.ROOT_CONFLICT) { 'ROOT_CONFLICT' }
    else { 'CLEAR' }
  } catch {
    $result = New-SelectorCensusResult
    $result.code = 'CENSUS_INCOMPLETE' # collector or resolver failure
  } finally {
    for ($i = $held.Count - 1; $i -ge 0; $i--) { if ($held[$i] -is [IDisposable]) { $held[$i].Dispose() } }
    if ($result.code -cne 'CLEAR') { $result.verdict = 'BLOCKED' } else { $result.verdict = 'CLEAR' }
    $result.at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
  }
  return $result
}

# --- Run owner: one unnamed job, one fixed driver created inside it, one grant line ---

function Start-SelectorRunOwned {
  param([string]$Driver, [hashtable]$Payload, $Native)
  $run = [ordered]@{ state = 'REFUSED'; code = 'RUN_START_REFUSED'; job = $null; limits = $null; driver = $null;
    process = $null; stdin = $null; stdout = $null; reader = $null; pending = $null; held = [Collections.Generic.List[object]]::new() }
  try {
    if ($null -eq $Native) { $Native = New-SelectorRunProfileNative }
    $run.job = & $Native.NewJob
    # No breakaway, silent-breakaway, kill-on-close or UI limits; nothing is ever set on this job.
    $run.limits = & $Native.JobLimits $run.job
    if ($run.limits -cne '0x0/0x0') { return $run }
    $start = & $Native.StartDriver $run.job $Driver
    if ($start.Error -ne 0) { return $run }
    $run.process = $start.Process; $run.stdin = $start.Stdin; $run.stdout = $start.Stdout
    $run.driver = @{ pid = [long]$start.Pid; created = $null }
    $valid = $false
    try {
      $valid = (& $Native.InJob $start.Process $run.job) -and (& $Native.JobLimits $run.job) -ceq $run.limits
      if ($valid) { $run.driver.created = [long](& $Native.Created $start.Process) }
    } catch { $valid = $false }
    if ($valid) {
      $grant = [ordered]@{ format = 'selector-run-grant/v1'; pid = $run.driver.pid; payload = $Payload } | ConvertTo-Json -Compress -Depth 3
      $written = $false
      try { $written = & $Native.WriteLine $start.Stdin $grant } catch { $written = $false }
      if ($written) { $run.state = 'GRANTED'; $run.code = 'RUN_GRANTED'; return $run }
    }
    # Withheld grant, including a failed or thrown write: EOF on the driver's own grant pipe makes it
    # exit normally. One fixed deadline covers that exit and the held job draining (#9651 R2): REFUSED
    # needs both inside it; a live driver or a nonzero, failed or late count stays PENDING.
    $run.state = 'PENDING'; $run.code = 'RUN_TRACKING_INCOMPLETE'
    $deadline = (& $Native.Now).AddMilliseconds($script:SelectorGrantTimeoutMs)
    & $Native.CloseWriter $start.Stdin
    $exited = & $Native.WaitExit $start.Process ([Math]::Max(0, [int]($deadline - (& $Native.Now)).TotalMilliseconds))
    # Driver exit is not job exit: after it, poll only the held job's active count for the remaining time.
    while ($exited) {
      $active = & $Native.JobActive $run.job
      $late = (& $Native.Now) -gt $deadline
      if ($active -eq 0 -and -not $late) { $run.state = 'REFUSED'; $run.code = 'RUN_START_REFUSED' }
      if ($active -eq 0 -or $late) { break }
      & $Native.Sleep $script:SelectorDrainPollMs
    }
    return $run
  } catch {
    if ($null -ne $run.process) {
      # Never granted: keep custody as PENDING and still give the driver EOF so it can exit normally.
      $run.state = 'PENDING'; $run.code = 'RUN_TRACKING_INCOMPLETE'
      try { & $Native.CloseWriter $run.stdin } catch { }
    }
    return $run
  }
}

# --- Host witness (AC3), host verifier only ---

function Read-SelectorWitnessAdmission([string]$Text) {
  $admission = $Text | ConvertFrom-Json -AsHashtable -Depth 2
  if ($admission -isnot [hashtable] -or $admission.Count -ne 2 -or
      $admission['format'] -cne 'selector-run-profile-census-witness-admission/v1' -or $admission['root'] -isnot [string]) {
    throw 'ADMISSION_REFUSED'
  }
  $root = ConvertTo-SelectorPath $admission['root'] @()
  if ($root -isnot [hashtable] -or -not $root.drive -or (Format-SelectorPath $root) -cne $admission['root'] -or
      @($root.parts)[-1] -cnotmatch '^selector-witness-[A-Za-z0-9-]{1,64}$') { throw 'ADMISSION_REFUSED' }
  return @{ root = $admission['root'] }
}

function ConvertFrom-SelectorDriverEvent([string]$Line) {
  try {
    $value = $Line | ConvertFrom-Json -AsHashtable -Depth 2
    if ($value -is [hashtable] -and $value.Count -eq 3 -and $value['event'] -ceq 'browser' -and ($value['pid'] -is [long] -or $value['pid'] -is [int]) -and
        $value['pid'] -gt 0 -and $value['chromium'] -is [string] -and $value['chromium'] -cmatch '^[0-9a-f]{64}$') { return $value }
  } catch { }
  return $null
}

function Get-SelectorWitnessVerdict($Result, $Run) {
  # Each condition is parenthesized: ',' binds tighter than the comparison operators.
  $steps = @(
    @('W1_NOT_CLEAR', ($Result.w1.code -ceq 'CLEAR')),
    @('NO_SWITCHLESS_CHROME_ROOT', ($Result.w1.counts.defaultRoots -ge 1)),
    @('RUN_START_REFUSED', ($null -ne $Run -and $Run.state -ceq 'GRANTED')),
    @('W2_NOT_TREE_ALIVE', ($Result.w2.code -ceq 'RUN_TREE_ALIVE' -and $Result.w2.counts.members -ge 3)),
    @('W3_NOT_CLEAR', ($Result.w3.code -ceq 'CLEAR' -and $Result.w3.counts.members -eq 0 -and $Result.w3.counts.default -ge 1)),
    @('SCRATCH_NOT_ABSENT', ($Result.scratchDeleted -and $Result.scratchAbsent)),
    @('W4_NOT_CLEAR', ($Result.w4.code -ceq 'CLEAR')))
  foreach ($step in $steps) {
    if ($step[1]) { continue }
    if ($step[0] -ceq 'NO_SWITCHLESS_CHROME_ROOT') { return @('NOT_EXERCISED', $step[0]) }
    return @('FAIL', $step[0])
  }
  # D1 (final) must equal D0, and a W3 change stays a violation even if the roots return by W4.
  if ($Result.d1 -cne $Result.d0 -or $Result.w3.defaultRootDigest -cne $Result.d0) { return @('INVALID', 'DEFAULT_ROOTS_CHANGED') }
  return @('PASS', 'WITNESS_PASS')
}

# W1 pre-launch census on a fresh scratch root; W2 with the granted witness driver's browser alive;
# W3 after the driver closed its browser and exited; census-gated scratch deletion; W4 after it.
function Invoke-SelectorRunProfileWitness {
  param([string]$Root, $Native)
  $result = [ordered]@{ format = 'selector-run-profile-census-witness/v1'; verdict = 'FAIL'; code = 'WITNESS_FAILED'; at = $null;
    scriptSha256 = $null; driverSha256 = $null; chromiumSha256 = $null; d0 = $null; d1 = $null;
    w1 = $null; w2 = $null; w3 = $null; w4 = $null; scratchDeleted = $false; scratchAbsent = $false }
  $run = $null; $admitted = $null; $emptied = $false
  try {
    if ($null -eq $Native) { $Native = New-SelectorRunProfileNative }
    $result.scriptSha256 = & $Native.ScriptSha256
    $result.driverSha256 = & $Native.DriverSha256
    $rootCode = Test-SelectorRunRoot $Root $Native
    if ($rootCode -cne 'CLEAR') { $result.verdict = 'REFUSED'; $result.code = $rootCode; return $result }
    if (& $Native.Exists $Root) { $result.verdict = 'REFUSED'; $result.code = 'WITNESS_ROOT_EXISTS'; return $result }
    & $Native.CreateRoot $Root
    $result.w1 = Get-SelectorRunProfileCensus -Root $Root -Native $Native
    $result.d0 = $result.w1.defaultRootDigest
    $last = $result.w1
    if ($result.w1.code -ceq 'CLEAR' -and $result.w1.counts.defaultRoots -ge 1) {
      $run = Start-SelectorRunOwned -Driver (& $Native.WitnessDriver) -Payload @{ profile = "$Root\profile" } -Native $Native
      if ($run.state -ceq 'GRANTED') {
        try {
          # Stderr shares the report pipe: skip unparseable lines (never echoed) until the event, EOF or the deadline.
          $deadline = (& $Native.Now).AddMilliseconds($script:SelectorLaunchTimeoutMs)
          do {
            $remaining = [Math]::Max(0, [int]($deadline - (& $Native.Now)).TotalMilliseconds)
            $line = & $Native.ReadLine $run $remaining
            $driverEvent = ConvertFrom-SelectorDriverEvent $line
          } while (-not $driverEvent -and $null -ne $line -and $remaining -gt 0)
          if ($driverEvent) {
            $result.chromiumSha256 = $driverEvent['chromium']
            $admitted = & $Native.AdmitBrowser $run $driverEvent['pid']
            $result.w2 = Get-SelectorRunProfileCensus -Root $Root -Run $run -Admitted $admitted -Native $Native
          }
        } finally {
          # EOF on the grant pipe: the driver closes its browser normally and exits.
          & $Native.ReleaseRun $run
        }
      }
      if ($run.state -cne 'REFUSED') {
        $emptied = $run.state -ceq 'GRANTED' -and (& $Native.WaitEmpty $run $script:SelectorCloseTimeoutMs)
        if (-not $emptied) { $result.verdict = 'PENDING'; $result.code = 'RUN_TRACKING_INCOMPLETE'; return $result }
        $result.w3 = Get-SelectorRunProfileCensus -Root $Root -Run $run -Admitted $admitted -Native $Native
        $result.d1 = $result.w3.defaultRootDigest
        $last = $result.w3
      }
    }
    if ($last.code -ceq 'CLEAR') {
      & $Native.RemoveScratch $Root
      $result.scratchDeleted = $true
      $result.scratchAbsent = -not (& $Native.Exists $Root)
      $result.w4 = Get-SelectorRunProfileCensus -Root $Root -Run $run -Admitted $admitted -Native $Native
      # D1 is the final post-deletion observation of the default roots.
      $result.d1 = $result.w4.defaultRootDigest
    }
    $verdict = Get-SelectorWitnessVerdict $result $run
    $result.verdict = $verdict[0]; $result.code = $verdict[1]
  } catch {
    $result.verdict = if ($null -ne $run -and $run.state -cne 'REFUSED' -and -not $emptied) { 'PENDING' } else { 'FAIL' }
    $result.code = 'WITNESS_FAILED'
  } finally {
    $result.at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
  }
  return $result
}

function Remove-SelectorWitnessScratch([string]$Root) {
  $top = Get-Item -LiteralPath $Root -Force
  if (-not $top.PSIsContainer -or ($top.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'SCRATCH_LINK_REFUSED' }
  $options = [IO.EnumerationOptions]::new()
  $options.AttributesToSkip = 0; $options.IgnoreInaccessible = $false; $options.RecurseSubdirectories = $false
  $directories = [Collections.Generic.List[string]]::new(); $files = [Collections.Generic.List[string]]::new()
  $queue = [Collections.Generic.Queue[string]]::new(); $queue.Enqueue($Root)
  while ($queue.Count) {
    $directory = $queue.Dequeue(); $directories.Add($directory)
    foreach ($item in [IO.DirectoryInfo]::new($directory).EnumerateFileSystemInfos('*', $options)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SCRATCH_LINK_REFUSED' }
      if ($item.Attributes -band [IO.FileAttributes]::Directory) { $queue.Enqueue($item.FullName) } else { $files.Add($item.FullName) }
    }
  }
  foreach ($file in $files) { [IO.File]::SetAttributes($file, [IO.FileAttributes]::Normal); [IO.File]::Delete($file) }
  for ($i = $directories.Count - 1; $i -ge 0; $i--) { [IO.Directory]::Delete($directories[$i], $false) }
}

# --- Native primitives (Windows host only) ---

function Initialize-SelectorRunProfileNative {
  if (-not $IsWindows) { throw 'NATIVE_WINDOWS_REQUIRED' }
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'NATIVE_UNELEVATED_REQUIRED' }
  if ('SelectorRunProfileNative' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class SelectorRunDriver {
  public int Error; public int Pid; public SafeProcessHandle Process; public SafeFileHandle Stdin, Stdout;
}
public sealed class SelectorRunMember : IDisposable {
  public long Pid, Created; public bool InJob, Alive; public SafeProcessHandle Handle;
  public void Dispose() { if (Handle != null) Handle.Dispose(); }
}
public sealed class SelectorPathProbe { public int Code; public bool Opened; public string Final; public bool Directory, Reparse; }

public static class SelectorRunProfileNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong Read, Write, Other, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)]
  struct EXTENDED_LIMIT {
    public BASIC_LIMIT Basic; public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ACCOUNTING {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct FILE_INFORMATION {
    public uint Attributes; public long Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status; public UIntPtr Information; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out EXTENDED_LIMIT info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out uint info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ACCOUNTING info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(SafeProcessHandle process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION information);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(SafeFileHandle handle, byte[] buffer, int count, out int written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder buffer, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FILE_INFORMATION info);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(SafeFileHandle handle, out IO_STATUS_BLOCK status, IntPtr buffer, uint length, int infoClass);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetDriveType(string root);
  [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  const int BASIC_ACCOUNTING = 1, PROCESS_ID_LIST = 3, UI_RESTRICTIONS = 4, EXTENDED_LIMITS = 9;
  const uint QUERY_LIMITED = 0x1000, SYNCHRONIZE = 0x00100000, READ_ATTRIBUTES = 0x80, SHARE_ALL = 7, OPEN_EXISTING = 3;
  const uint BACKUP_SEMANTICS = 0x02000000, OPEN_REPARSE_POINT = 0x00200000;
  static readonly IntPtr JOB_LIST = (IntPtr)0x0002000D, HANDLE_LIST = (IntPtr)0x00020002;

  static long Microseconds(long fileTime) { return fileTime / 10; }

  // Unnamed and non-inheritable: the owner holds the only handle until it exits.
  public static IntPtr NewJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    return job;
  }
  public static string Limits(IntPtr job) {
    EXTENDED_LIMIT limits; uint ui;
    if (!QueryInformationJobObject(job, EXTENDED_LIMITS, out limits, Marshal.SizeOf(typeof(EXTENDED_LIMIT)), IntPtr.Zero)) throw new Win32Exception();
    if (!QueryInformationJobObject(job, UI_RESTRICTIONS, out ui, 4, IntPtr.Zero)) throw new Win32Exception();
    return string.Format("0x{0:X}/0x{1:X}", limits.Basic.LimitFlags, ui);
  }
  public static uint Active(IntPtr job) {
    ACCOUNTING accounting;
    if (!QueryInformationJobObject(job, BASIC_ACCOUNTING, out accounting, Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero)) throw new Win32Exception();
    return accounting.ActiveProcesses;
  }
  public static long[] Pids(IntPtr job) {
    const int capacity = 4096;
    int size = 8 + capacity * IntPtr.Size;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, PROCESS_ID_LIST, buffer, size, IntPtr.Zero)) throw new Win32Exception();
      int assigned = Marshal.ReadInt32(buffer, 0), listed = Marshal.ReadInt32(buffer, 4);
      if (assigned != listed) throw new InvalidOperationException("JOB_LIST_TRUNCATED");
      long[] pids = new long[listed];
      for (int i = 0; i < listed; i++) pids[i] = Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
      return pids;
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  // One CreateProcess of the fixed driver, a job member from creation (PROC_THREAD_ATTRIBUTE_JOB_LIST),
  // inheriting only its two pipe ends. Returns the Win32 error with no process on failure.
  public static SelectorRunDriver Start(IntPtr job, string application, string commandLine) {
    SelectorRunDriver result = new SelectorRunDriver();
    SECURITY_ATTRIBUTES inherit = new SECURITY_ATTRIBUTES();
    inherit.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); inherit.bInheritHandle = 1;
    IntPtr inRead = IntPtr.Zero, inWrite = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
    IntPtr list = IntPtr.Zero, jobs = Marshal.AllocHGlobal(IntPtr.Size), handles = Marshal.AllocHGlobal(2 * IntPtr.Size);
    bool initialized = false;
    try {
      if (!CreatePipe(out inRead, out inWrite, ref inherit, 0) || !CreatePipe(out outRead, out outWrite, ref inherit, 0) ||
          !SetHandleInformation(inWrite, 1, 0) || !SetHandleInformation(outRead, 1, 0)) {
        result.Error = Marshal.GetLastWin32Error(); return result;
      }
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      list = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(list, 2, 0, ref size)) { result.Error = Marshal.GetLastWin32Error(); return result; }
      initialized = true;
      Marshal.WriteIntPtr(jobs, 0, job);
      Marshal.WriteIntPtr(handles, 0, inRead); Marshal.WriteIntPtr(handles, IntPtr.Size, outWrite);
      if (!UpdateProcThreadAttribute(list, 0, JOB_LIST, jobs, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero) ||
          !UpdateProcThreadAttribute(list, 0, HANDLE_LIST, handles, (IntPtr)(2 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) {
        result.Error = Marshal.GetLastWin32Error(); return result;
      }
      STARTUPINFOEX startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.lpAttributeList = list;
      startup.StartupInfo.dwFlags = 0x100;
      startup.StartupInfo.hStdInput = inRead; startup.StartupInfo.hStdOutput = outWrite; startup.StartupInfo.hStdError = outWrite;
      PROCESS_INFORMATION information;
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW.
      if (!CreateProcess(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x08000000, IntPtr.Zero, null, ref startup, out information)) {
        result.Error = Marshal.GetLastWin32Error(); return result;
      }
      CloseHandle(information.hThread);
      result.Pid = information.dwProcessId;
      result.Process = new SafeProcessHandle(information.hProcess, true);
      result.Stdin = new SafeFileHandle(inWrite, true); inWrite = IntPtr.Zero;
      result.Stdout = new SafeFileHandle(outRead, true); outRead = IntPtr.Zero;
      return result;
    } finally {
      if (initialized) DeleteProcThreadAttributeList(list);
      if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      Marshal.FreeHGlobal(jobs); Marshal.FreeHGlobal(handles);
      foreach (IntPtr end in new IntPtr[] { inRead, inWrite, outRead, outWrite }) if (end != IntPtr.Zero) CloseHandle(end);
    }
  }
  public static bool InJob(SafeProcessHandle process, IntPtr job) {
    bool member;
    if (!IsProcessInJob(process, job, out member)) throw new Win32Exception();
    return member;
  }
  public static long Created(SafeProcessHandle process) {
    long creation, exit, kernel, user;
    if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) throw new Win32Exception();
    return Microseconds(creation);
  }
  public static bool Exited(SafeProcessHandle process, int milliseconds) { return WaitForSingleObject(process, (uint)milliseconds) == 0; }
  public static bool WriteLine(SafeFileHandle handle, string line) {
    byte[] bytes = new UTF8Encoding(false).GetBytes(line + "\n"); int written;
    return WriteFile(handle, bytes, bytes.Length, out written, IntPtr.Zero) && written == bytes.Length;
  }
  // Returns null when the PID no longer exists (an exited member); other failures throw.
  public static SelectorRunMember Member(long pid, IntPtr job) {
    SafeProcessHandle handle = OpenProcess(QUERY_LIMITED | SYNCHRONIZE, false, (int)pid);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      if (error == 87) return null;
      throw new Win32Exception(error);
    }
    SelectorRunMember member = new SelectorRunMember();
    member.Handle = handle; member.Pid = pid;
    member.InJob = InJob(handle, job);
    member.Created = Created(handle);
    member.Alive = WaitForSingleObject(handle, 0) == 258;
    return member;
  }
  public static long SelfCreated() {
    using (System.Diagnostics.Process self = System.Diagnostics.Process.GetCurrentProcess()) {
      return Created(self.SafeHandle);
    }
  }

  // Attribute-only open; follow=false opens the entry itself without reparse traversal. Opened tells a
  // failed open from a failed metadata or final-path query on an opened handle (same Code field).
  public static SelectorPathProbe Probe(string path, bool follow) {
    SelectorPathProbe probe = new SelectorPathProbe();
    using (SafeFileHandle handle = CreateFile(path, READ_ATTRIBUTES, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, BACKUP_SEMANTICS | (follow ? 0 : OPEN_REPARSE_POINT), IntPtr.Zero)) {
      if (handle.IsInvalid) { probe.Code = Marshal.GetLastWin32Error(); return probe; }
      probe.Opened = true;
      FILE_INFORMATION info;
      if (!GetFileInformationByHandle(handle, out info)) { probe.Code = Marshal.GetLastWin32Error(); return probe; }
      probe.Directory = (info.Attributes & 0x10) != 0; probe.Reparse = (info.Attributes & 0x400) != 0;
      if (follow) {
        StringBuilder final = new StringBuilder(1024);
        uint length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
        if (length >= final.Capacity) { final = new StringBuilder((int)length + 1); length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0); }
        if (length == 0 || length >= final.Capacity) { probe.Code = Marshal.GetLastWin32Error(); if (probe.Code == 0) probe.Code = 1; return probe; }
        probe.Final = final.ToString();
      }
      return probe;
    }
  }
  // FileProcessIdsUsingFileInformation (47) on the entry itself, attribute-only, no reparse traversal.
  public static long[] Holders(string path) {
    using (SafeFileHandle handle = CreateFile(path, READ_ATTRIBUTES, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, BACKUP_SEMANTICS | OPEN_REPARSE_POINT, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception();
      for (int size = 4096; size <= (1 << 20); size *= 2) {
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
          IO_STATUS_BLOCK status;
          int code = NtQueryInformationFile(handle, out status, buffer, (uint)size, 47);
          if (code == unchecked((int)0xC0000004)) continue;
          if (code != 0) throw new InvalidOperationException("HOLDER_QUERY_FAILED");
          int count = Marshal.ReadInt32(buffer, 0);
          long[] pids = new long[count];
          for (int i = 0; i < count; i++) pids[i] = Marshal.ReadIntPtr(buffer, IntPtr.Size + i * IntPtr.Size).ToInt64();
          return pids;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
      throw new InvalidOperationException("HOLDER_QUERY_OVERFLOW");
    }
  }
  public static bool DriveFixed(string drive) { return GetDriveType(drive + ":\\") == 3; }
  public static string[] Arguments(string commandLine) {
    int count; IntPtr memory = CommandLineToArgvW(commandLine, out count);
    if (memory == IntPtr.Zero) throw new Win32Exception();
    try {
      string[] result = new string[count];
      for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return result;
    } finally { LocalFree(memory); }
  }
}
'@
}

function ConvertTo-SelectorMicroseconds([DateTime]$Value) {
  # WMI CreationDate is local time; ToFileTimeUtc would read an Unspecified kind as UTC.
  if ($Value.Kind -eq [DateTimeKind]::Unspecified) { $Value = [DateTime]::SpecifyKind($Value, [DateTimeKind]::Local) }
  return [long][decimal]::Floor([decimal]$Value.ToFileTimeUtc() / 10)
}

function Get-SelectorWin32Processes {
  $rows = Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate -OperationTimeoutSec 60 -ErrorAction Stop
  foreach ($row in $rows) {
    $argv = $null
    if ($row.CommandLine) { try { $argv = [SelectorRunProfileNative]::Arguments($row.CommandLine) } catch { $argv = $null } }
    @{ pid = [long]$row.ProcessId; parentPid = [long]$row.ParentProcessId; name = [string]$row.Name; executable = $row.ExecutablePath;
      created = $(if ($row.CreationDate) { ConvertTo-SelectorMicroseconds $row.CreationDate } else { $null }); argv = $argv }
  }
}

function New-SelectorRunProfileNative {
  Initialize-SelectorRunProfileNative
  $censusScript = $PSCommandPath
  $driver = Join-Path $PSScriptRoot 'selector-run-profile-census-witness.mjs'
  return @{
    Now = { [DateTime]::UtcNow }
    Self = { @{ pid = [long]$PID; created = [SelectorRunProfileNative]::SelfCreated() } }
    LocalAppData = { [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData) }
    LocalNames = {
      $properties = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
      @('localhost', '127.0.0.1', $env:COMPUTERNAME, [Net.Dns]::GetHostName(), "$($properties.HostName).$($properties.DomainName)") | Where-Object { $_ -and $_ -notmatch '\.$' }
    }
    Processes = { Get-SelectorWin32Processes }
    DriveFixed = { param($Drive) [SelectorRunProfileNative]::DriveFixed($Drive) }
    Open = { param($Path, $Follow) [SelectorRunProfileNative]::Probe($Path, $Follow) }
    Entry = { param($Path) [SelectorRunProfileNative]::Probe($Path, $false) }
    List = {
      param($Directory)
      $options = [IO.EnumerationOptions]::new()
      $options.AttributesToSkip = 0; $options.IgnoreInaccessible = $false; $options.RecurseSubdirectories = $false
      foreach ($item in [IO.DirectoryInfo]::new($Directory).EnumerateFileSystemInfos('*', $options)) {
        @{ path = $item.FullName; directory = [bool]($item.Attributes -band [IO.FileAttributes]::Directory);
          reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint) }
      }
    }
    Holders = { param($Path) [SelectorRunProfileNative]::Holders($Path) }
    JobLimits = { param($Job) [SelectorRunProfileNative]::Limits($Job) }
    JobPids = { param($Job) [SelectorRunProfileNative]::Pids($Job) }
    OpenMember = { param($Id, $Job) [SelectorRunProfileNative]::Member($Id, $Job) }
    NewJob = { [SelectorRunProfileNative]::NewJob() }
    StartDriver = {
      param($Job, $Driver)
      if (-not [IO.Path]::IsPathFullyQualified($Driver) -or $Driver -notmatch '\.mjs$' -or $Driver.Contains('"') -or -not [IO.File]::Exists($Driver)) {
        return @{ Error = 2 }
      }
      $node = (Get-Command -Name node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
      [SelectorRunProfileNative]::Start($Job, $node, "`"$node`" `"$Driver`"")
    }
    InJob = { param($Process, $Job) [SelectorRunProfileNative]::InJob($Process, $Job) }
    Created = { param($Process) [SelectorRunProfileNative]::Created($Process) }
    WriteLine = { param($Writer, $Line) [SelectorRunProfileNative]::WriteLine($Writer, $Line) }
    CloseWriter = { param($Writer) $Writer.Dispose() }
    WaitExit = { param($Process, $Ms) [SelectorRunProfileNative]::Exited($Process, $Ms) }
    Sleep = { param($Ms) Start-Sleep -Milliseconds $Ms }
    JobActive = { param($Job) [int][SelectorRunProfileNative]::Active($Job) }
    WitnessDriver = { $driver }.GetNewClosure()
    ScriptSha256 = { (Get-FileHash -LiteralPath $censusScript -Algorithm SHA256).Hash.ToLowerInvariant() }.GetNewClosure()
    DriverSha256 = { (Get-FileHash -LiteralPath $driver -Algorithm SHA256).Hash.ToLowerInvariant() }.GetNewClosure()
    Exists = { param($Path) Test-Path -LiteralPath $Path }
    CreateRoot = {
      param($Path)
      # Only the fresh root itself; never parents the gated deletion would leave behind.
      if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($Path))) { throw 'WITNESS_PARENT_REQUIRED' }
      [void][IO.Directory]::CreateDirectory($Path)
    }
    RemoveScratch = { param($Path) Remove-SelectorWitnessScratch $Path }
    ReadLine = {
      param($Run, $Ms)
      if ($null -eq $Run.reader) { $Run.reader = [IO.StreamReader]::new([IO.FileStream]::new($Run.stdout, [IO.FileAccess]::Read, 1)) }
      if ($null -eq $Run.pending) { $Run.pending = $Run.reader.ReadLineAsync() }
      if (-not $Run.pending.Wait($Ms)) { return $null }
      $line = $Run.pending.Result; $Run.pending = $null
      return $line
    }
    AdmitBrowser = {
      param($Run, $Id)
      $member = [SelectorRunProfileNative]::Member($Id, $Run.job)
      if ($null -eq $member) { return @{ pid = [long]$Id; created = -1 } }
      # Only a live process whose opened handle is in the run job is admitted; any other is refused unheld.
      if (-not ($member.InJob -and $member.Alive)) { $member.Dispose(); return @{ pid = [long]$Id; created = -1 } }
      $Run.held.Add($member)
      return @{ pid = [long]$Id; created = $member.Created }
    }
    ReleaseRun = { param($Run) if ($null -ne $Run.stdin) { $Run.stdin.Dispose() } }
    WaitEmpty = {
      param($Run, $Ms)
      $deadline = [DateTime]::UtcNow.AddMilliseconds($Ms)
      while ([SelectorRunProfileNative]::Active($Run.job) -ne 0) {
        if ([DateTime]::UtcNow -gt $deadline) { return $false }
        Start-Sleep -Milliseconds 250
      }
      return $true
    }
  }
}

# --- CLI: `-Action witness` only; the admission arrives on stdin and nothing is echoed ---

if ($MyInvocation.InvocationName -ne '.') {
  $refusal = 'CLI_REFUSED'
  try {
    if ($args.Count -ne 2 -or $args[0] -cne '-Action' -or $args[1] -cne 'witness') { throw 'CLI_REFUSED' }
    $refusal = 'ADMISSION_REFUSED'
    $stdin = [Console]::OpenStandardInput()
    $buffer = [byte[]]::new($script:SelectorAdmissionLimit + 1)
    $length = 0
    while ($length -lt $buffer.Length) {
      $read = $stdin.Read($buffer, $length, $buffer.Length - $length)
      if ($read -le 0) { break }
      $length += $read
    }
    if ($length -gt $script:SelectorAdmissionLimit) { throw 'ADMISSION_REFUSED' }
    $admission = Read-SelectorWitnessAdmission ([Text.UTF8Encoding]::new($false, $true).GetString($buffer, 0, $length))
    $refusal = 'WITNESS_REFUSED'
    $result = Invoke-SelectorRunProfileWitness -Root $admission.root
    $result | ConvertTo-Json -Depth 6 -Compress
    if ($result.verdict -cne 'PASS') { exit 1 }
    exit 0
  } catch {
    [ordered]@{ format = 'selector-run-profile-census-refusal/v1'; code = $refusal } | ConvertTo-Json -Compress
    exit 1
  }
}
