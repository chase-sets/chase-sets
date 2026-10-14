[CmdletBinding()]
param(
  [ValidateSet('define', 'relay', 'guest', 'handoff')][string]$Action,
  [string]$ConfigurationPath,
  [string]$MessagePath,
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$script:SelectorEnvironmentSource = $PSCommandPath
$script:SelectorEndpointPolicyHash = '582200a0897dd14df915d17c12cb5965ff17524dc057320a9f5693c5442bc58d'
$script:SelectorOperations = @{
  S = @('attach', 'pause', 'resume', 'navigate-orders', 'initial-range', 'reload', 'restore', 'fallback-check', 'close')
  C = @('attach', 'install', 'pause', 'resume', 'cancel-before-begin', 'capture', 'remove', 'close')
}

function Assert-SelectorClosed($Value, [string[]]$Keys) {
  if ($Value -isnot [System.Collections.IDictionary] -or
      @(Compare-Object @($Value.Keys | Sort-Object) @($Keys | Sort-Object)).Count) { throw 'E_SCHEMA_REFUSED' }
}

function Get-SelectorDigest([byte[]]$Bytes) {
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Read-SelectorJson([string]$File, [int]$Limit = 1048576) {
  $item = Get-Item -LiteralPath $File -Force
  if ($item.Length -gt $Limit -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'E_FILE_REFUSED'
  }
  return [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($File)) | ConvertFrom-Json -AsHashtable
}

function Assert-SelectorDirectory([string]$Directory) {
  if (-not [IO.Path]::IsPathFullyQualified($Directory) -or [IO.Path]::GetFullPath($Directory) -cne $Directory) {
    throw 'E_PATH_REFUSED'
  }
  for ($current = $Directory; $current; $current = [IO.Path]::GetDirectoryName($current)) {
    $item = Get-Item -LiteralPath $current -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkTarget) {
      throw 'E_LINK_REFUSED'
    }
  }
}

function Get-SelectorModeHash($Configuration) {
  $mode = [ordered]@{ purpose = $Configuration.purpose; networkMode = $Configuration.networkMode
    osEgressBlocked = $Configuration.osEgressBlocked; resolverRules = $Configuration.resolverRules }
  return Get-SelectorDigest ([Text.Encoding]::UTF8.GetBytes(($mode | ConvertTo-Json -Compress)))
}

function Assert-SelectorConfiguration($Configuration) {
  Assert-SelectorClosed $Configuration @('format', 'environment', 'runId', 'purpose', 'endpointMode', 'networkMode',
    'osEgressBlocked', 'resolverRules', 'modeHash', 'definitionHash', 'relayHash', 'landedHead', 'stagingReadOnly',
    'guestRoot', 'guestProfile', 'staging', 'export', 'journal', 'assets')
  foreach ($key in @('format', 'environment', 'runId', 'purpose', 'endpointMode', 'networkMode', 'resolverRules',
    'modeHash', 'definitionHash', 'relayHash', 'landedHead', 'guestRoot', 'guestProfile', 'staging', 'export', 'journal')) {
    if ($Configuration[$key] -isnot [string]) { throw 'E_SCHEMA_REFUSED' }
  }
  if ($Configuration.format -cne 'selector-isolated-environment/v1' -or $Configuration.environment -cne 'E-S' -or
      $Configuration.runId -isnot [string] -or $Configuration.runId -cnotmatch '^selector-(capability|sentinel|rehearsal|S|C)-[A-Za-z0-9-]{1,80}$' -or
      $Configuration.purpose -cnotin @('A', 'B', 'S', 'C') -or $Configuration.endpointMode -cnotin @('S', 'C') -or
      $Configuration.landedHead -cnotmatch '^[a-f0-9]{40}$') { throw 'E_CONFIGURATION_REFUSED' }
  $scope = $Configuration.runId.Split('-')[1]
  if (($Configuration.purpose -ceq 'A' -and $scope -cne 'capability') -or
      ($Configuration.purpose -ceq 'B' -and $scope -cnotin @('sentinel', 'rehearsal')) -or
      ($Configuration.purpose -cin @('S', 'C') -and ($scope -cne $Configuration.purpose -or $Configuration.endpointMode -cne $Configuration.purpose))) {
    throw 'E_SCOPE_REFUSED'
  }
  $offline = $Configuration.purpose -cin @('A', 'B')
  if ($Configuration.osEgressBlocked -isnot [bool] -or
      $Configuration.networkMode -cne $(if ($offline) { 'offline' } else { 'provider-reachable' }) -or
      $Configuration.osEgressBlocked -cne $offline -or
      $Configuration.resolverRules -cne $(if ($offline) { 'MAP * ~NOTFOUND' } else { '' })) { throw 'E_NETWORK_REFUSED' }
  $codeHash = (Get-FileHash -LiteralPath $script:SelectorEnvironmentSource -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Configuration.definitionHash -cne $codeHash -or $Configuration.relayHash -cne $codeHash -or
      $Configuration.modeHash -cne (Get-SelectorModeHash $Configuration)) { throw 'E_HASH_REFUSED' }
  if ($Configuration.stagingReadOnly -isnot [bool] -or -not $Configuration.stagingReadOnly) { throw 'E_STAGING_WRITABLE_REFUSED' }
  $root = 'C:\SelectorRuns\' + $Configuration.runId
  if ($Configuration.guestRoot -cne $root -or $Configuration.guestProfile -cne ($root + '\profile')) { throw 'E_PROFILE_REFUSED' }
  if ($Configuration.assets -isnot [array] -or $Configuration.assets.Count -lt 6 -or $Configuration.assets.Count -gt 20000) {
    throw 'E_ASSET_REFUSED'
  }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($asset in $Configuration.assets) {
    Assert-SelectorClosed $asset @('path', 'sha256')
    if ($asset.path -isnot [string] -or $asset.path -cnotmatch '^(Chrome|PowerShell|Node|Repo)/[A-Za-z0-9_./-]+$' -or
        $asset.path.Split('/') -contains '..' -or $asset.path.Split('/') -contains '.' -or
        $asset.path -match '//|/$' -or $asset.sha256 -cnotmatch '^[a-f0-9]{64}$' -or -not $seen.Add($asset.path)) { throw 'E_ASSET_REFUSED' }
  }
  foreach ($required in @('Chrome/chrome.exe', 'PowerShell/pwsh.exe', 'Node/node.exe',
    'PowerShell/UIAutomationClient.dll', 'PowerShell/UIAutomationTypes.dll',
    'Repo/bounded-contexts/channels/features/connector-client/integrations/order-authority-probe/package.mjs')) {
    if (-not $seen.Contains($required)) { throw 'E_ASSET_MISSING' }
  }
}

function Assert-SelectorStaging($Configuration, [string]$Directory) {
  Assert-SelectorDirectory $Directory
  $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($asset in $Configuration.assets) {
    $file = [IO.Path]::Combine($Directory, $asset.path.Replace('/', [IO.Path]::DirectorySeparatorChar))
    Assert-SelectorDirectory ([IO.Path]::GetDirectoryName($file))
    $item = Get-Item -LiteralPath $file -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkTarget -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $asset.sha256) { throw 'E_ASSET_HASH_REFUSED' }
    [void]$expected.Add($asset.path)
  }
  [void]$expected.Add('selector-isolated-environment.ps1')
  [void]$expected.Add('environment.json')
  $queue = [Collections.Generic.Queue[string]]::new(); $queue.Enqueue($Directory)
  while ($queue.Count) {
    foreach ($item in Get-ChildItem -LiteralPath $queue.Dequeue() -Force) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkTarget) { throw 'E_LINK_REFUSED' }
      if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
      elseif (-not $expected.Contains([IO.Path]::GetRelativePath($Directory, $item.FullName).Replace('\', '/'))) { throw 'E_UNLISTED_STAGING_REFUSED' }
    }
  }
  if ((Get-FileHash -LiteralPath (Join-Path $Directory 'selector-isolated-environment.ps1')).Hash.ToLowerInvariant() -cne $Configuration.definitionHash) {
    throw 'E_HASH_REFUSED'
  }
}

function Write-SelectorNewFile([string]$File, [byte[]]$Bytes) {
  $stream = [IO.File]::Open($File, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($Bytes); $stream.Flush($true) } finally { $stream.Dispose() }
}

function New-SelectorSandboxDefinition($Configuration, [string]$Destination) {
  Assert-SelectorConfiguration $Configuration
  Assert-SelectorDirectory $Configuration.staging
  Assert-SelectorDirectory $Configuration.export
  Assert-SelectorDirectory $Configuration.journal
  $directories = @($Configuration.staging, $Configuration.export, $Configuration.journal)
  foreach ($left in $directories) {
    foreach ($right in $directories) {
      if ($left -ne $right -and $left.StartsWith($right + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'E_MAPPING_REFUSED' }
    }
  }
  if (@($directories | Select-Object -Unique).Count -ne 3 -or
      @(Get-ChildItem -LiteralPath $Configuration.export -Force).Count -or
      @(Get-ChildItem -LiteralPath $Configuration.journal -Force).Count) { throw 'E_MAPPING_REFUSED' }
  Assert-SelectorStaging $Configuration $Configuration.staging
  # Repo pins are independently read from the landed commit, not rebaselined from staging.
  foreach ($asset in $Configuration.assets | Where-Object { $_.path.StartsWith('Repo/', [StringComparison]::Ordinal) }) {
    $info = [Diagnostics.ProcessStartInfo]::new('git'); $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    foreach ($arg in @('show', ($Configuration.landedHead + ':' + $asset.path.Substring(5)))) { [void]$info.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($info)
    $memory = [IO.MemoryStream]::new()
    try {
      $errors = $process.StandardError.ReadToEndAsync()
      $process.StandardOutput.BaseStream.CopyTo($memory); $process.WaitForExit(); [void]$errors.GetAwaiter().GetResult()
      if ($process.ExitCode -ne 0 -or (Get-SelectorDigest $memory.ToArray()) -cne $asset.sha256) { throw 'E_LANDED_BYTES_REFUSED' }
    } finally { $memory.Dispose(); $process.Dispose() }
  }
  $json = [Text.Encoding]::UTF8.GetBytes(($Configuration | ConvertTo-Json -Depth 8 -Compress))
  Write-SelectorNewFile (Join-Path $Configuration.staging 'environment.json') $json
  $configurationHash = Get-SelectorDigest $json
  $pwshHash = ($Configuration.assets | Where-Object path -CEQ 'PowerShell/pwsh.exe').sha256
  $boot = '$ErrorActionPreference="Stop"; ' +
    'if ((Get-FileHash C:\SelectorStaging\selector-isolated-environment.ps1).Hash.ToLowerInvariant() -cne "' + $Configuration.definitionHash +
    '" -or (Get-FileHash C:\SelectorStaging\environment.json).Hash.ToLowerInvariant() -cne "' + $configurationHash +
    '" -or (Get-FileHash C:\SelectorStaging\PowerShell\pwsh.exe).Hash.ToLowerInvariant() -cne "' + $pwshHash + '") { exit 1 }; ' +
    '& C:\SelectorStaging\PowerShell\pwsh.exe -NoProfile -NonInteractive -File C:\SelectorStaging\selector-isolated-environment.ps1 -Action guest -ConfigurationPath C:\SelectorStaging\environment.json'
  $builder = [Text.StringBuilder]::new(); $writer = [Xml.XmlWriter]::Create($builder)
  try {
    $writer.WriteStartElement('Configuration')
    foreach ($key in @('ClipboardRedirection', 'PrinterRedirection', 'AudioInput', 'VideoInput', 'vGPU')) { $writer.WriteElementString($key, 'Disable') }
    $writer.WriteElementString('Networking', $(if ($Configuration.networkMode -ceq 'offline') { 'Disable' } else { 'Enable' }))
    $writer.WriteStartElement('MappedFolders')
    foreach ($mapping in @(@($Configuration.staging, 'C:\SelectorStaging', 'true'), @($Configuration.export, 'C:\SelectorExport', 'false'))) {
      $writer.WriteStartElement('MappedFolder'); $writer.WriteElementString('HostFolder', $mapping[0])
      $writer.WriteElementString('SandboxFolder', $mapping[1]); $writer.WriteElementString('ReadOnly', $mapping[2]); $writer.WriteEndElement()
    }
    $writer.WriteEndElement(); $writer.WriteStartElement('LogonCommand')
    $writer.WriteElementString('Command', ('powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($boot))))
    $writer.WriteEndElement(); $writer.WriteEndElement(); $writer.Flush()
  } finally { $writer.Dispose() }
  Write-SelectorNewFile $Destination ([Text.Encoding]::UTF8.GetBytes($builder.ToString()))
  # The ownership journal is host-only and is never mapped into E.
  Write-SelectorNewFile (Join-Path $Configuration.journal 'ownership.json') ([Text.Encoding]::UTF8.GetBytes((
    [ordered]@{ runId = $Configuration.runId; state = 'PENDING'; definitionHash = $Configuration.definitionHash
      relayHash = $Configuration.relayHash; modeHash = $Configuration.modeHash; configurationHash = $configurationHash } | ConvertTo-Json -Compress)))
  return [ordered]@{ code = 'E_DEFINED_NOT_LAUNCHED'; definitionHash = $Configuration.definitionHash
    relayHash = $Configuration.relayHash; modeHash = $Configuration.modeHash; configurationHash = $configurationHash
    wsbHash = (Get-FileHash -LiteralPath $Destination).Hash.ToLowerInvariant() }
}

function Assert-SelectorMessage([string]$Text, $Configuration) {
  if ([Text.Encoding]::UTF8.GetByteCount($Text) -gt 512) { throw 'E_MESSAGE_OVERSIZE' }
  $message = $Text | ConvertFrom-Json -AsHashtable
  Assert-SelectorClosed $message @('runId', 'policyHash', 'operation')
  # The endpoint requires canonical JSON. Restrict strings before canonical comparison.
  if ($message.runId -cne $Configuration.runId -or $message.policyHash -cne $script:SelectorEndpointPolicyHash -or
      $message.operation -cnotin $script:SelectorOperations[$Configuration.endpointMode]) { throw 'E_OPERATION_REFUSED' }
  $canonical = '{"runId":"' + $message.runId + '","policyHash":"' + $message.policyHash + '","operation":"' + $message.operation + '"}'
  if ($Text -cne $canonical) { throw 'E_MESSAGE_NONCANONICAL' }
  return $message
}

function Assert-SelectorResponse([int]$Status, [string]$Text) {
  if ($Status -eq 204 -and $Text -ceq '') { return }
  if ($Status -ne 200 -or [Text.Encoding]::UTF8.GetByteCount($Text) -gt 512) { throw 'E_RESPONSE_REFUSED' }
  $value = $Text | ConvertFrom-Json -AsHashtable
  if ($value -is [Collections.IDictionary] -and $value.Count -eq 1) {
    Assert-SelectorClosed $value @('ok'); if ($value.ok -is [bool] -and $value.ok) { return }
  } else {
    $booleans = @('rangeSemanticsValid', 'selectedRangeValid', 'quickFilterRelationshipValid', 'currentEpochComplete', 'oldCompletionInvalidated')
    $counts = @('rangeControlMatches', 'quickFilterLabelMatches', 'adjacentCountMatches', 'completionSignalMatches')
    Assert-SelectorClosed $value ($booleans + $counts)
    if (-not @($booleans | Where-Object { $value[$_] -isnot [bool] }).Count -and
        -not @($counts | Where-Object { -not (
          (($value[$_] -is [long] -or $value[$_] -is [int]) -and $value[$_] -in @(0, 1)) -or
          ($value[$_] -is [string] -and $value[$_] -ceq 'many')) }).Count) { return }
  }
  throw 'E_RESPONSE_REFUSED'
}

function Invoke-SelectorLoopback($Endpoint, [string]$Text, $Configuration) {
  Assert-SelectorClosed $Endpoint @('tool', 'runId', 'policyIdentity', 'policyHash', 'url', 'token')
  if ($Endpoint.tool -cne 'channels-selector-run-endpoint/v1' -or $Endpoint.runId -cne $Configuration.runId -or
      $Endpoint.policyIdentity -cne 'selector-agent-operation-capability-policy/v1' -or $Endpoint.policyHash -cne $script:SelectorEndpointPolicyHash -or
      $Endpoint.url -cnotmatch '^http://127\.0\.0\.1:([1-9][0-9]{0,4})/operation$' -or
      [int]$Matches[1] -gt 65535 -or $Endpoint.token -cnotmatch '^[a-f0-9]{64}$') { throw 'E_ENDPOINT_REFUSED' }
  [void](Assert-SelectorMessage $Text $Configuration)
  $handler = [Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect = $false; $handler.UseProxy = $false
  $client = [Net.Http.HttpClient]::new($handler); $client.Timeout = [TimeSpan]::FromSeconds(5)
  $cancel = [Threading.CancellationTokenSource]::new(); $cancel.CancelAfter(5000)
  try {
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $Endpoint.url)
    $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Endpoint.token)
    $request.Content = [Net.Http.StringContent]::new($Text, [Text.Encoding]::UTF8, 'application/json')
    try {
      $response = $client.Send($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token)
      try {
        $stream = $response.Content.ReadAsStream(); $buffer = [byte[]]::new(513); $length = 0
        while ($length -lt 513) {
          $n = $stream.ReadAsync($buffer, $length, 513 - $length, $cancel.Token).GetAwaiter().GetResult()
          if (-not $n) { break }; $length += $n
        }
        if ($length -gt 512) { throw 'E_RESPONSE_REFUSED' }
        $body = [Text.UTF8Encoding]::new($false, $true).GetString($buffer, 0, $length)
        if ($body.Contains($Endpoint.token, [StringComparison]::Ordinal)) { throw 'E_TOKEN_ECHO_REFUSED' }
        Assert-SelectorResponse ([int]$response.StatusCode) $body
        return [ordered]@{ status = [int]$response.StatusCode; body = $body }
      } finally { $response.Dispose() }
    } finally { $request.Dispose() }
  } finally { $cancel.Dispose(); $client.Dispose(); $handler.Dispose() }
}

function Invoke-SelectorRelay($Configuration, [string]$Text) {
  Assert-SelectorConfiguration $Configuration
  $message = Assert-SelectorMessage $Text $Configuration
  Assert-SelectorDirectory $Configuration.export
  Assert-SelectorDirectory $Configuration.journal
  $ownership = Read-SelectorJson (Join-Path $Configuration.journal 'ownership.json') 1024
  if ($ownership.runId -cne $Configuration.runId -or $ownership.state -cne 'PENDING' -or
      $ownership.definitionHash -cne $Configuration.definitionHash -or $ownership.relayHash -cne $Configuration.relayHash -or
      $ownership.modeHash -cne $Configuration.modeHash) { throw 'E_OWNERSHIP_REFUSED' }
  # CreateNew records intent before transport; a lost reply or discarded E never permits retry.
  $stem = Join-Path $Configuration.export $message.operation
  if (Test-Path -LiteralPath ($stem + '.response')) { throw 'E_UNSOLICITED_REPLY_REFUSED' }
  Write-SelectorNewFile (Join-Path $Configuration.journal ($message.operation + '.intent')) ([Text.Encoding]::UTF8.GetBytes('PENDING'))
  Write-SelectorNewFile ($stem + '.request') ([Text.Encoding]::UTF8.GetBytes($Text))
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while (-not (Test-Path -LiteralPath ($stem + '.response'))) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'E_RELAY_PENDING' }; Start-Sleep -Milliseconds 50
  }
  $reply = Read-SelectorJson ($stem + '.response') 2048
  Assert-SelectorClosed $reply @('status', 'body', 'requestHash', 'exportHash')
  if ($reply.requestHash -cne (Get-SelectorDigest ([Text.Encoding]::UTF8.GetBytes($Text))) -or
      $reply.exportHash -cne (Get-SelectorDigest ([Text.Encoding]::UTF8.GetBytes($reply.body)))) { throw 'E_EXPORT_HASH_REFUSED' }
  Assert-SelectorResponse $reply.status $reply.body
  return [ordered]@{ status = $reply.status; body = $reply.body }
}

function Invoke-SelectorGuest($Configuration) {
  Assert-SelectorConfiguration $Configuration
  if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or
      -not (Test-Path -LiteralPath 'C:\SelectorStaging\environment.json') -or
      -not (Test-Path -LiteralPath 'C:\SelectorExport' -PathType Container)) { throw 'E_GUEST_REFUSED' }
  Assert-SelectorStaging $Configuration 'C:\SelectorStaging'
  Assert-SelectorDirectory 'C:\SelectorExport'
  # Check the effective read-only mapping, not merely the manifest's desired posture.
  $probe = 'C:\SelectorStaging\.readonly-' + [guid]::NewGuid().ToString('N')
  $writable = $false
  try { $stream = [IO.File]::Open($probe, [IO.FileMode]::CreateNew); $stream.Dispose(); $writable = $true }
  catch [UnauthorizedAccessException] { }
  if ($writable) { [IO.File]::Delete($probe); throw 'E_STAGING_WRITABLE_REFUSED' }
  $drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID = 'C:'"
  if ($drive.DriveType -ne 3 -or (Test-Path -LiteralPath $Configuration.guestRoot)) { throw 'E_LOCAL_VOLUME_REFUSED' }
  # Keep the run root nonexistent for package.prepare's CreateNew ownership law.
  $relayRoot = 'C:\SelectorRelay\' + $Configuration.runId
  if (Test-Path -LiteralPath $relayRoot) { throw 'E_FRESH_ENVIRONMENT_REQUIRED' }
  [void][IO.Directory]::CreateDirectory($relayRoot)
  Assert-SelectorDirectory $relayRoot
  # A owns launch, endpoint custody and unchanged cleanup. This receiver cannot launch a shell,
  # synthesize a census, or transform E discard into successful disposal.
  $endpointFile = $relayRoot + '\endpoint.private.json'
  $deadline = [DateTime]::UtcNow.AddMinutes(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($operation in $script:SelectorOperations[$Configuration.endpointMode]) {
      $stem = 'C:\SelectorExport\' + $operation
      $consumed = $relayRoot + '\' + $operation + '.consumed'
      if (-not (Test-Path -LiteralPath ($stem + '.request')) -or (Test-Path -LiteralPath $consumed)) { continue }
      if (-not (Test-Path -LiteralPath $endpointFile)) { throw 'E_A_ENDPOINT_PENDING' }
      $endpoint = Read-SelectorJson $endpointFile 1024
      Write-SelectorNewFile $consumed ([Text.Encoding]::UTF8.GetBytes('PENDING'))
      $requestFile = Get-Item -LiteralPath ($stem + '.request')
      if ($requestFile.Length -gt 512 -or ($requestFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'E_MESSAGE_OVERSIZE' }
      $text = [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($requestFile.FullName))
      $message = Assert-SelectorMessage $text $Configuration
      if ($message.operation -cne $operation) { throw 'E_OPERATION_REFUSED' }
      $reply = Invoke-SelectorLoopback $endpoint $text $Configuration
      $reply.requestHash = Get-SelectorDigest ([Text.Encoding]::UTF8.GetBytes($text))
      $reply.exportHash = Get-SelectorDigest ([Text.Encoding]::UTF8.GetBytes($reply.body))
      Write-SelectorNewFile ($stem + '.response') ([Text.Encoding]::UTF8.GetBytes(($reply | ConvertTo-Json -Compress)))
      if ($operation -ceq 'close') { return }
    }
    Start-Sleep -Milliseconds 50
  }
  throw 'E_RELAY_PENDING'
}

function Get-SelectorEnvironmentHandoff {
  $digest = (Get-FileHash -LiteralPath $script:SelectorEnvironmentSource).Hash.ToLowerInvariant()
  return [ordered]@{ format = 'selector-isolated-environment-handoff/v1'; definitionHash = $digest; relayHash = $digest
    codeHashScope = 'whole-script-bytes'; modeHashScope = 'separate-per-run-network-configuration'
    tool = 'channels-selector-run-endpoint/v1'; policyIdentity = 'selector-agent-operation-capability-policy/v1'
    policyHash = $script:SelectorEndpointPolicyHash; messageKeys = @('runId', 'policyHash', 'operation')
    maxMessageBytes = 512; endpoint = 'http://127.0.0.1:<run-bound-port>/operation'; methods = @('POST')
    operations = $script:SelectorOperations; responses = @('closed-ok', 'closed-payload', '204')
    guestEndpointFile = 'C:\SelectorRelay\<runId>\endpoint.private.json'
    acceptance = 'PENDING_HOST_REVIEW'; actualEnvironment = 'PENDING_OPERATOR_ACTION' }
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    switch ($Action) {
      'define' { New-SelectorSandboxDefinition (Read-SelectorJson $ConfigurationPath) $OutputPath | ConvertTo-Json -Compress }
      'relay' {
        $item = Get-Item -LiteralPath $MessagePath
        if ($item.Length -gt 512) { throw 'E_MESSAGE_OVERSIZE' }
        $reply = Invoke-SelectorRelay (Read-SelectorJson $ConfigurationPath) ([Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($MessagePath)))
        if ($reply.status -eq 204) { [Console]::Write('204') } else { [Console]::Write($reply.body) }
      }
      'guest' { Invoke-SelectorGuest (Read-SelectorJson $ConfigurationPath) }
      'handoff' { Get-SelectorEnvironmentHandoff | ConvertTo-Json -Depth 5 }
      default { throw 'E_ACTION_REFUSED' }
    }
  } catch {
    # Paths, tokens, commands and native exceptions never cross this boundary.
    [Console]::Error.WriteLine('E_REFUSED'); exit 1
  }
}
