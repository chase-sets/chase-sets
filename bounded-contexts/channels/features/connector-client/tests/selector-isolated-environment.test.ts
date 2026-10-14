import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const source = fileURLToPath(new URL("./selector-isolated-environment.ps1", import.meta.url));
const repo = path.resolve(path.dirname(source), "../../../../..");
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const packagePath =
  "bounded-contexts/channels/features/connector-client/integrations/order-authority-probe/package.mjs";
let results: Record<string, string>;
let sandbox: string;
let fixture: string;
let configurationPath: string;
let handoff: {
  definitionHash: string;
  relayHash: string;
  policyHash: string;
  tool: string;
  codeHashScope: string;
  modeHashScope: string;
  maxMessageBytes: number;
  actualEnvironment: string;
  acceptance: string;
  guestRunRoot: string;
  operations: { S: string[]; C: string[] };
};

// Synthetic component evidence only, never an actual E witness.
beforeAll(() => {
  const scratch = path.join(repo, "artifacts", "9558", "tests");
  mkdirSync(scratch, { recursive: true });
  fixture = mkdtempSync(path.join(scratch, "synthetic-"));
  const stage = path.join(fixture, "staging");
  const exported = path.join(fixture, "export");
  const journal = path.join(fixture, "host-journal");
  mkdirSync(stage);
  mkdirSync(exported);
  mkdirSync(journal);
  const assets = [
    "Chrome/chrome.exe",
    "PowerShell/pwsh.exe",
    "Node/node.exe",
    "PowerShell/UIAutomationClient.dll",
    "PowerShell/UIAutomationTypes.dll",
    "Repo/" + packagePath,
  ].map((name) => {
    const file = path.join(stage, name);
    mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from("synthetic closed fixture: " + name + "\n");
    writeFileSync(file, bytes);
    return { path: name, sha256: digest(bytes) };
  });
  // Separately committed oracle, not mutable staged bytes.
  mkdirSync(path.dirname(path.join(fixture, packagePath)), { recursive: true });
  copyFileSync(path.join(stage, "Repo/" + packagePath), path.join(fixture, packagePath));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--initial-branch=synthetic");
  git("add", packagePath);
  git(
    "-c",
    "user.name=Synthetic fixture",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-m",
    "closed synthetic fixture only",
  );
  const codeHash = digest(readFileSync(source));
  copyFileSync(source, path.join(stage, "selector-isolated-environment.ps1"));
  const configuration = {
    format: "selector-isolated-environment/v1",
    environment: "E-S",
    runId: "selector-capability-synthetic",
    purpose: "A",
    endpointMode: "C",
    networkMode: "offline",
    osEgressBlocked: true,
    resolverRules: "MAP * ~NOTFOUND",
    modeHash: digest(
      JSON.stringify({ purpose: "A", networkMode: "offline", osEgressBlocked: true, resolverRules: "MAP * ~NOTFOUND" }),
    ),
    definitionHash: codeHash,
    relayHash: codeHash,
    landedHead: git("rev-parse", "HEAD").trim(),
    stagingReadOnly: true,
    guestRoot: "C:\\SelectorRepo\\artifacts\\9115\\selector-capability-synthetic",
    guestProfile: "C:\\SelectorRepo\\artifacts\\9115\\selector-capability-synthetic\\profile",
    staging: stage,
    export: exported,
    journal,
    assets,
  };
  configurationPath = path.join(fixture, "input.json");
  writeFileSync(configurationPath, JSON.stringify(configuration));
  const harness = path.join(fixture, "focused.ps1");
  const resultsPath = path.join(fixture, "results.json");
  const handoffPath = path.join(fixture, "handoff.json");
  const wsbPath = path.join(fixture, "environment.wsb");
  writeFileSync(
    harness,
    String.raw`
param($Source, $ConfigurationFile, $ResultFile, $HandoffFile, $WsbFile)
$ErrorActionPreference = 'Stop'
. $Source
$c = Read-SelectorJson $ConfigurationFile
$r = [ordered]@{}
function Case($Name, [scriptblock]$Body) {
  try { & $Body; $r[$Name] = 'ACCEPTED' } catch { $r[$Name] = 'REFUSED' }
}
function Clone { return ($c | ConvertTo-Json -Depth 8 -Compress | ConvertFrom-Json -AsHashtable) }
Case 'valid-definition' { Assert-SelectorConfiguration $c; Assert-SelectorStaging $c $c.staging }
foreach ($field in @('definitionHash', 'relayHash', 'modeHash')) {
  Case ('tampered-' + $field) { $m = Clone; $m[$field] = '0' * 64; Assert-SelectorConfiguration $m }
}
Case 'folded-mode-hash' { $m = Clone; $m.definitionHash = Get-SelectorDigest ([Text.Encoding]::UTF8.GetBytes($m.definitionHash + $m.modeHash)); Assert-SelectorConfiguration $m }
Case 'writable-staging' { $m = Clone; $m.stagingReadOnly = $false; Assert-SelectorConfiguration $m }
Case 'mapped-profile' { $m = Clone; $m.guestProfile = 'C:\SelectorStaging\profile'; Assert-SelectorConfiguration $m }
Case 'mapped-root' { $m = Clone; $m.guestRoot = 'C:\SelectorExport\run'; Assert-SelectorConfiguration $m }
Case 'non-repo-local-root' { $m = Clone; $m.guestRoot = 'C:\SelectorRuns\' + $m.runId; $m.guestProfile = $m.guestRoot + '\profile'; Assert-SelectorConfiguration $m }
Case 'unknown-property' { $m = Clone; $m.command = 'whoami'; Assert-SelectorConfiguration $m }
Case 'unknown-environment' { $m = Clone; $m.environment = 'host-desktop'; Assert-SelectorConfiguration $m }
Case 'wrong-scope' { $m = Clone; $m.purpose = 'B'; $m.modeHash = Get-SelectorModeHash $m; Assert-SelectorConfiguration $m }
foreach ($purpose in @('A', 'B')) {
  Case ($purpose + '-provider-reachable') { $m = Clone; $m.purpose = $purpose; if ($purpose -ceq 'B') { $m.runId = 'selector-rehearsal-synthetic'; $m.guestRoot = 'C:\SelectorRepo\artifacts\9115\' + $m.runId; $m.guestProfile = $m.guestRoot + '\profile' }; $m.networkMode = 'provider-reachable'; $m.osEgressBlocked = $false; $m.resolverRules = ''; $m.modeHash = Get-SelectorModeHash $m; Assert-SelectorConfiguration $m }
}
foreach ($purpose in @('S', 'C')) {
  $live = Clone; $live.purpose = $purpose; $live.endpointMode = $purpose; $live.runId = 'selector-' + $purpose + '-synthetic'
  $live.guestRoot = 'C:\SelectorRepo\artifacts\9115\' + $live.runId; $live.guestProfile = $live.guestRoot + '\profile'
  Case ($purpose + '-offline') { $live.modeHash = Get-SelectorModeHash $live; Assert-SelectorConfiguration $live }
  $live.networkMode = 'provider-reachable'; $live.osEgressBlocked = $false; $live.resolverRules = ''; $live.modeHash = Get-SelectorModeHash $live
  Case ($purpose + '-provider-definition') { Assert-SelectorConfiguration $live }
  Case ($purpose + '-egress-blocked') { $live.osEgressBlocked = $true; $live.modeHash = Get-SelectorModeHash $live; Assert-SelectorConfiguration $live }
}
foreach ($asset in $c.assets) {
  $file = Join-Path $c.staging $asset.path
  $original = [IO.File]::ReadAllBytes($file)
  Case ('missing-' + $asset.path) { [IO.File]::Move($file, $file + '.missing'); try { Assert-SelectorStaging $c $c.staging } finally { [IO.File]::Move($file + '.missing', $file) } }
  Case ('tampered-' + $asset.path) { [IO.File]::WriteAllText($file, 'tampered fixture'); try { Assert-SelectorStaging $c $c.staging } finally { [IO.File]::WriteAllBytes($file, $original) } }
}
Case 'traversal' { $m = Clone; $m.assets[0].path = 'Chrome/../chrome.exe'; Assert-SelectorConfiguration $m }
Case 'duplicate-asset' { $m = Clone; $m.assets += $m.assets[0]; Assert-SelectorConfiguration $m }
Case 'missing-runtime-pin' { $m = Clone; $m.assets[0].path = 'Chrome/other.exe'; Assert-SelectorConfiguration $m }
Case 'unlisted-secret' { $file = Join-Path $c.staging 'credentials.json'; [IO.File]::WriteAllText($file, 'synthetic'); try { Assert-SelectorStaging $c $c.staging } finally { [IO.File]::Delete($file) } }
Case 'rebaselined-repo' {
  $m = Clone; $asset = $m.assets[-1]; $file = Join-Path $m.staging $asset.path; $bytes = [IO.File]::ReadAllBytes($file)
  [IO.File]::WriteAllText($file, 'synthetic rebaselined repo'); $asset.sha256 = (Get-FileHash $file).Hash.ToLowerInvariant()
  try { New-SelectorSandboxDefinition $m $WsbFile | Out-Null } finally { [IO.File]::WriteAllBytes($file, $bytes) }
}
& {
  $alias = Clone; $alias.export = $alias.journal.ToUpperInvariant()
  # Unix CI creates both spellings; the mapping boundary still enforces Windows identities.
  if (-not $IsWindows) {
    $alias.export = Join-Path ([IO.Path]::GetDirectoryName($alias.journal)) ([IO.Path]::GetFileName($alias.journal).ToUpperInvariant())
    [void][IO.Directory]::CreateDirectory($alias.export)
  }
  $writes = [Collections.Generic.Dictionary[string,byte[]]]::new([StringComparer]::OrdinalIgnoreCase)
  function Write-SelectorNewFile([string]$File, [byte[]]$Bytes) { $writes.Add($File, $Bytes) }
  function Get-FileHash {
    param([string]$LiteralPath, [string]$Algorithm='SHA256')
    if ($writes.ContainsKey($LiteralPath)) { [pscustomobject]@{Hash=(Get-SelectorDigest $writes[$LiteralPath])} }
    else { Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm }
  }
  try {
    New-SelectorSandboxDefinition $alias 'SYNTHETIC-MEMORY-ONLY.wsb' | Out-Null
    $r['case-alias'] = 'ACCEPTED'
  } catch { $r['case-alias'] = $_.Exception.Message }
  $r['case-alias-writes'] = [string]$writes.Count
}
Case 'define' { New-SelectorSandboxDefinition $c $WsbFile | Out-Null }
$xml = [xml][IO.File]::ReadAllText($WsbFile)
$encoded = $xml.Configuration.LogonCommand.Command.Split(' ')[-1]
$boot = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
$ast = [Management.Automation.Language.Parser]::ParseInput($boot, [ref]$null, [ref]$null)
$commands = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true))
$launch = @($commands | Where-Object { $_.GetCommandName() -ceq 'C:\SelectorStaging\PowerShell\pwsh.exe' })
$r['bootstrap-launch-count'] = [string]$launch.Count
$r['bootstrap-launch-arguments'] = @($launch[0].CommandElements | Select-Object -Skip 1 | ForEach-Object {
  if ($_ -is [Management.Automation.Language.CommandParameterAst]) { '-' + $_.ParameterName } else { $_.Value }
}) | ConvertTo-Json -Compress
$assetLoops = @($ast.FindAll({ param($n)
  $n -is [Management.Automation.Language.ForEachStatementAst] -and
  $null -ne $n.Body.Find({ param($child)
    $child -is [Management.Automation.Language.CommandAst] -and $child.GetCommandName() -ceq 'Get-FileHash'
  }, $true)
}, $true))
$r['bootstrap-asset-loops'] = [string]$assetLoops.Count
$start = [DateTime]::UtcNow
$operationDeadline = Get-SelectorOperationDeadline $start
$r['operation-budget-ms'] = [string]($operationDeadline - $start).TotalMilliseconds
$r['reply-publication-budget-ms'] = [string]((Get-SelectorReplyDeadline $operationDeadline) - $operationDeadline).TotalMilliseconds
$message = '{"runId":"' + $c.runId + '","policyHash":"' + $script:SelectorEndpointPolicyHash + '","operation":"attach"}'
Case 'message' { Assert-SelectorMessage $message $c | Out-Null }
Case 'oversize' { Assert-SelectorMessage ($message + (' ' * 513)) $c | Out-Null }
Case 'non-closed' { Assert-SelectorMessage ($message.Replace('}', ',"secret":"synthetic"}')) $c | Out-Null }
Case 'unknown-operation' { Assert-SelectorMessage ($message.Replace('attach', 'exec')) $c | Out-Null }
Case 'non-allowlisted-entrypoint' { Assert-SelectorMessage ($message.Replace('attach', 'powershell.exe')) $c | Out-Null }
Case 'wrong-run' { Assert-SelectorMessage ($message.Replace('synthetic', 'other')) $c | Out-Null }
Case 'wrong-policy' { Assert-SelectorMessage ($message.Replace($script:SelectorEndpointPolicyHash, ('0' * 64))) $c | Out-Null }
Case 'noncanonical' { Assert-SelectorMessage (' ' + $message) $c | Out-Null }
Case 'response-ok' { Assert-SelectorResponse 200 '{"ok":true}' }
Case 'response-204' { Assert-SelectorResponse 204 '' }
Case 'response-204-body' { Assert-SelectorResponse 204 '{"ok":true}' }
Case 'response-extra' { Assert-SelectorResponse 200 '{"ok":true,"token":"synthetic"}' }
Case 'response-cased-key' { Assert-SelectorResponse 200 '{"OK":true}' }
Case 'response-duplicate-secret' { Assert-SelectorResponse 200 '{"ok":"synthetic-private-value","ok":true}' }
Case 'response-duplicate-escaped-token' { Assert-SelectorResponse 200 ('{"ok":"' + ('\u0061' * 64) + '","ok":true}') }
Case 'response-false' { Assert-SelectorResponse 200 '{"ok":false}' }
Case 'response-status' { Assert-SelectorResponse 302 '' }
Case 'response-payload' { Assert-SelectorResponse 200 '{"rangeSemanticsValid":true,"selectedRangeValid":false,"quickFilterRelationshipValid":true,"currentEpochComplete":false,"oldCompletionInvalidated":true,"rangeControlMatches":1,"quickFilterLabelMatches":"many","adjacentCountMatches":0,"completionSignalMatches":1}' }
Case 'response-boolean-count' { Assert-SelectorResponse 200 '{"rangeSemanticsValid":true,"selectedRangeValid":false,"quickFilterRelationshipValid":true,"currentEpochComplete":false,"oldCompletionInvalidated":true,"rangeControlMatches":true,"quickFilterLabelMatches":"many","adjacentCountMatches":0,"completionSignalMatches":1}' }
Case 'exposed-listener' { Invoke-SelectorLoopback @{ tool='channels-selector-run-endpoint/v1'; runId=$c.runId; policyIdentity='selector-agent-operation-capability-policy/v1'; policyHash=$script:SelectorEndpointPolicyHash; url='http://0.0.0.0:1234/operation'; token=('a'*64) } $message $c | Out-Null }
Case 'redirect-endpoint' { Invoke-SelectorLoopback @{ tool='channels-selector-run-endpoint/v1'; runId=$c.runId; policyIdentity='selector-agent-operation-capability-policy/v1'; policyHash=$script:SelectorEndpointPolicyHash; url='http://127.0.0.1:1234/operation?next=external'; token=('a'*64) } $message $c | Out-Null }
Case 'endpoint-valid' { Assert-SelectorEndpoint @{ tool='channels-selector-run-endpoint/v1'; runId=$c.runId; policyIdentity='selector-agent-operation-capability-policy/v1'; policyHash=$script:SelectorEndpointPolicyHash; url='http://127.0.0.1:1234/operation'; token=('a'*64) } $c }
Case 'endpoint-nonstring' { Assert-SelectorEndpoint @{ tool='channels-selector-run-endpoint/v1'; runId=$true; policyIdentity='selector-agent-operation-capability-policy/v1'; policyHash=$script:SelectorEndpointPolicyHash; url='http://127.0.0.1:1234/operation'; token=('a'*64) } $c }

# Synchronous closed exchange seam, not an E or loopback acceptance witness.
function Write-SelectorNewFile([string]$File, [byte[]]$Bytes) {
  $stream = [IO.File]::Open($File, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($Bytes); $stream.Flush($true) } finally { $stream.Dispose() }
  if ($File.EndsWith('.request')) {
    $body = $(if ($script:FixtureStatus -eq 204) { '' } else { $script:FixtureBody })
    $reply = @{ status=$script:FixtureStatus; body=$body; requestHash=(Get-SelectorDigest $Bytes); exportHash=(Get-SelectorDigest ([Text.Encoding]::UTF8.GetBytes($body))) }
    if ($script:TamperHash) { $reply.exportHash = '0' * 64 }
    [IO.File]::WriteAllText($File.Replace('.request', '.response'), ($reply | ConvertTo-Json -Compress))
  }
}
$script:FixtureStatus = 200; $script:FixtureBody = '{"ok":true}'; $script:TamperHash = $false
Case 'roundtrip-ok' { $reply = Invoke-SelectorRelay $c $message; if ($reply.status -ne 200 -or $reply.body -cne '{"ok":true}') { throw 'TEST_MISMATCH' } }
Case 'replay' { Invoke-SelectorRelay $c $message | Out-Null }
$script:FixtureStatus = 204
Case 'roundtrip-204' { $reply = Invoke-SelectorRelay $c ($message.Replace('attach','pause')); if ($reply.status -ne 204 -or $reply.body -cne '') { throw 'TEST_MISMATCH' } }
$script:FixtureStatus = 200; $script:TamperHash = $true
Case 'export-hash-mismatch' { Invoke-SelectorRelay $c ($message.Replace('attach','resume')) | Out-Null }
$script:TamperHash = $false; $script:FixtureBody = '{"ok":true,"token":"' + ('a'*64) + '"}'
Case 'token-echo' { Invoke-SelectorRelay $c ($message.Replace('attach','close')) | Out-Null }
Case 'discard-keeps-pending' { $ownership = Read-SelectorJson (Join-Path $c.journal 'ownership.json'); if ($ownership.state -cne 'PENDING') { throw 'TEST_MISMATCH' }; if (-not (Test-Path (Join-Path $c.journal 'close.intent'))) { throw 'TEST_MISMATCH' }; if (Test-Path (Join-Path $c.export 'ownership.json')) { throw 'TEST_MISMATCH' } }
$r | ConvertTo-Json | Set-Content -LiteralPath $ResultFile
Get-SelectorEnvironmentHandoff | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $HandoffFile
`,
  );
  execFileSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-File", harness, source, configurationPath, resultsPath, handoffPath, wsbPath],
    {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  results = JSON.parse(readFileSync(resultsPath, "utf8").replace(/^\uFEFF/, ""));
  handoff = JSON.parse(readFileSync(handoffPath, "utf8").replace(/^\uFEFF/, ""));
  sandbox = readFileSync(wsbPath, "utf8");
});

describe("selector-isolated-environment-definition", () => {
  it("refuses the Appendix A export/journal case alias before any captured write", () => {
    expect(results["case-alias"]).toBe("E_MAPPING_REFUSED");
    expect(results["case-alias-writes"]).toBe("0");
    expect(results.define).toBe("ACCEPTED");
  });
  it("hash-binds code/mode separately and generates two mappings with fixed boot", () => {
    expect(results["valid-definition"]).toBe("ACCEPTED");
    expect(results.define).toBe("ACCEPTED");
    expect(sandbox).not.toContain('encoding="utf-16"');
    expect((sandbox.match(/<MappedFolder>/g) ?? []).length).toBe(2);
    expect(sandbox).toContain("<ReadOnly>true</ReadOnly>");
    expect(sandbox).toContain("<SandboxFolder>C:\\SelectorExport</SandboxFolder>");
    expect(sandbox).toContain("<Networking>Disable</Networking>");
    for (const key of ["ClipboardRedirection", "PrinterRedirection", "AudioInput", "VideoInput", "vGPU"])
      expect(sandbox).toContain("<" + key + ">Disable</" + key + ">");
    const encoded = sandbox.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
    const boot = Buffer.from(encoded ?? "", "base64").toString("utf16le");
    expect(boot).toContain(handoff.definitionHash);
    expect(results["bootstrap-launch-count"]).toBe("1");
    expect(JSON.parse(results["bootstrap-launch-arguments"])).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "C:\\SelectorStaging\\selector-isolated-environment.ps1",
      "-Action",
      "guest",
      "-ConfigurationPath",
      "C:\\SelectorStaging\\environment.json",
    ]);
    expect(results["bootstrap-asset-loops"]).toBe("1");
  });
  for (const name of [
    "tampered-definitionHash",
    "tampered-relayHash",
    "tampered-modeHash",
    "folded-mode-hash",
    "writable-staging",
    "mapped-profile",
    "mapped-root",
    "non-repo-local-root",
    "unknown-property",
    "unknown-environment",
    "wrong-scope",
    "A-provider-reachable",
    "B-provider-reachable",
    "S-offline",
    "C-offline",
    "S-egress-blocked",
    "C-egress-blocked",
    "traversal",
    "duplicate-asset",
    "missing-runtime-pin",
    "unlisted-secret",
    "rebaselined-repo",
  ])
    it("refuses " + name + " before launch", () => expect(results[name]).toBe("REFUSED"));
  for (const asset of [
    "Chrome/chrome.exe",
    "PowerShell/pwsh.exe",
    "Node/node.exe",
    "PowerShell/UIAutomationClient.dll",
    "PowerShell/UIAutomationTypes.dll",
    "Repo/" + packagePath,
  ]) {
    for (const mutant of ["missing", "tampered"])
      it("refuses " + mutant + " " + asset, () => expect(results[mutant + "-" + asset]).toBe("REFUSED"));
  }
  it("keeps provider-reachable S/C definitions distinct from offline A/B", () => {
    expect(results["S-provider-definition"]).toBe("ACCEPTED");
    expect(results["C-provider-definition"]).toBe("ACCEPTED");
  });
});

const psLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'";
async function runPowerShell(command: string, onOutput?: (text: string) => void) {
  const child = spawn(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
    { cwd: fixture, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    onOutput?.(stdout);
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout: stdout.replaceAll("\r\n", "\n").trim(), stderr: stderr.trim() };
}

async function loopbackProbe({
  delay = 0,
  status = 200,
  body = '{"ok":true}',
  deadlineMs,
  bodyOnly = false,
  headerOverflow = false,
}: {
  delay?: number;
  status?: number;
  body?: string;
  deadlineMs?: number;
  bodyOnly?: boolean;
  headerOverflow?: boolean;
}) {
  let requests = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      const headers = {
        "Content-Type": "application/json",
        Location: "/other",
        ...(headerOverflow ? { "X-Synthetic-Padding": "x".repeat(2048) } : {}),
      };
      if (bodyOnly) {
        response.writeHead(status, headers);
        response.flushHeaders();
      }
      timers.push(
        setTimeout(() => {
          if (!bodyOnly) response.writeHead(status, headers);
          response.end(body);
        }, delay),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("synthetic_listener_missing");
    const result = await runPowerShell(`
. ${psLiteral(source)}
$c = @{runId='selector-capability-synthetic-delay';endpointMode='C'}
${deadlineMs === undefined ? "" : `function Get-SelectorOperationDeadline([DateTime]$StartedAt) { [DateTime]::UtcNow.AddMilliseconds(${deadlineMs}) }`}
$e = @{tool='channels-selector-run-endpoint/v1';runId=$c.runId;policyIdentity='selector-agent-operation-capability-policy/v1';policyHash='${handoff.policyHash}';url='http://127.0.0.1:${address.port}/operation';token=('a'*64)}
$m = '{"runId":"selector-capability-synthetic-delay","policyHash":"${handoff.policyHash}","operation":"capture"}'
try { $reply=Invoke-SelectorLoopback $e $m $c; 'ACCEPTED '+$reply.status } catch { 'REFUSED' }
`);
    return { ...result, requests };
  } finally {
    timers.forEach(clearTimeout);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("selector-isolated-environment-real-boundaries", () => {
  it("uses the frozen session ceiling and bounds the body/publication allowance separately", () => {
    expect(results["operation-budget-ms"]).toBe("900000");
    expect(results["reply-publication-budget-ms"]).toBe("10000");
  });
  for (const expired of [false, true]) {
    it(
      expired
        ? "retains mapped ownership and one-shot intent after the reply deadline"
        : "waits for a delayed mapped closed response instead of truncating the guest operation",
      async () => {
        const mapped = mkdtempSync(path.join(fixture, "mapped-"));
        const config = JSON.parse(readFileSync(configurationPath, "utf8"));
        config.export = path.join(mapped, "export");
        config.journal = path.join(mapped, "journal");
        mkdirSync(config.export);
        mkdirSync(config.journal);
        writeFileSync(
          path.join(config.journal, "ownership.json"),
          JSON.stringify({
            runId: config.runId,
            state: "PENDING",
            definitionHash: config.definitionHash,
            relayHash: config.relayHash,
            modeHash: config.modeHash,
          }),
        );
        const configFile = path.join(mapped, "input.json");
        writeFileSync(configFile, JSON.stringify(config));
        const message = JSON.stringify({ runId: config.runId, policyHash: handoff.policyHash, operation: "capture" });
        let publications = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const command = `
. ${psLiteral(source)}
${expired ? "function Get-SelectorReplyDeadline([DateTime]$OperationDeadline) { [DateTime]::UtcNow.AddMilliseconds(500) }" : ""}
$writer = ${"$"}{function:Write-SelectorNewFile}
function Write-SelectorNewFile([string]$File, [byte[]]$Bytes) {
  & $writer $File $Bytes
  if ($File.EndsWith('.request')) { [Console]::WriteLine('SYNTHETIC_REQUEST_READY') }
}
try { $r=Invoke-SelectorRelay (Read-SelectorJson ${psLiteral(configFile)}) ${psLiteral(message)}; 'ACCEPTED '+$r.status } catch { 'REFUSED' }
`;
        try {
          const result = await runPowerShell(command, (output) => {
            if (timer || !output.includes("SYNTHETIC_REQUEST_READY")) return;
            timer = setTimeout(
              () => {
                publications++;
                const body = '{"ok":true}';
                writeFileSync(
                  path.join(config.export, "capture.response"),
                  JSON.stringify({
                    status: 200,
                    body,
                    requestHash: digest(message),
                    exportHash: digest(body),
                  }),
                );
              },
              expired ? 1500 : 5250,
            );
          });
          expect(result).toMatchObject({
            code: 0,
            stderr: "",
            stdout: "SYNTHETIC_REQUEST_READY\n" + (expired ? "REFUSED" : "ACCEPTED 200"),
          });
          expect(publications).toBe(expired ? 0 : 1);
          expect(JSON.parse(readFileSync(path.join(config.journal, "ownership.json"), "utf8")).state).toBe("PENDING");
          expect(existsSync(path.join(config.journal, "capture.intent"))).toBe(true);
          const replay = await runPowerShell(command);
          expect(replay.stdout).toBe("REFUSED");
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    );
  }
  it("accepts Appendix B's closed response after 5.25 seconds within the frozen session budget", async () => {
    expect(await loopbackProbe({ delay: 5250 })).toMatchObject({
      code: 0,
      stdout: "ACCEPTED 200",
      stderr: "",
      requests: 1,
    });
  });
  it("refuses a response after the admitted operation deadline without retry", async () => {
    expect(await loopbackProbe({ delay: 1500, deadlineMs: 500 })).toMatchObject({
      code: 0,
      stdout: "REFUSED",
      stderr: "",
      requests: 1,
    });
  });
  for (const control of [
    { name: "immediate 200", status: 200, body: '{"ok":true}', expected: "ACCEPTED 200" },
    { name: "paused 204", status: 204, body: "", expected: "ACCEPTED 204" },
    { name: "overflow", status: 200, body: "x".repeat(513), expected: "REFUSED" },
    { name: "redirect", status: 302, body: "", expected: "REFUSED" },
    { name: "secret", status: 200, body: '{"ok":true,"token":"' + "a".repeat(64) + '"}', expected: "REFUSED" },
    { name: "header overflow", headerOverflow: true, expected: "REFUSED" },
    { name: "body deadline", bodyOnly: true, delay: 5250, expected: "REFUSED" },
    {
      name: "closed payload",
      body: '{"rangeSemanticsValid":true,"selectedRangeValid":false,"quickFilterRelationshipValid":true,"currentEpochComplete":false,"oldCompletionInvalidated":true,"rangeControlMatches":1,"quickFilterLabelMatches":"many","adjacentCountMatches":0,"completionSignalMatches":1}',
      expected: "ACCEPTED 200",
    },
  ])
    it("real HTTP " + control.name, async () => {
      expect(await loopbackProbe(control)).toMatchObject({
        code: 0,
        stdout: control.expected,
        stderr: "",
        requests: 1,
      });
    });
  for (const action of ["SYNTHETIC_PRIVATE_ACTION_9563", "invalid", ""]) {
    it("keeps invalid CLI action inside the closed-error boundary: " + (action || "empty"), () => {
      const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", source, "-Action", action], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe("");
      expect(result.stderr.trim()).toBe("E_REFUSED");
    });
  }
  for (const action of ["handoff", "HANDOFF"])
    it("preserves the real handoff CLI readback: " + action, () => {
      const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", source, "-Action", action], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(handoff);
    });
});

describe("selector-isolated-environment-transport", () => {
  for (const name of [
    "message",
    "response-ok",
    "response-204",
    "response-payload",
    "roundtrip-ok",
    "roundtrip-204",
    "endpoint-valid",
    "discard-keeps-pending",
  ])
    it("closed fixture " + name, () => expect(results[name]).toBe("ACCEPTED"));
  for (const name of [
    "oversize",
    "non-closed",
    "unknown-operation",
    "non-allowlisted-entrypoint",
    "wrong-run",
    "wrong-policy",
    "noncanonical",
    "response-204-body",
    "response-extra",
    "response-cased-key",
    "response-duplicate-secret",
    "response-duplicate-escaped-token",
    "response-false",
    "response-status",
    "response-boolean-count",
    "exposed-listener",
    "redirect-endpoint",
    "endpoint-nonstring",
    "replay",
    "export-hash-mismatch",
    "token-echo",
  ])
    it("refuses " + name, () => expect(results[name]).toBe("REFUSED"));
});

describe("selector-isolated-environment-handoff", () => {
  it("readbacks code hashes separately from mode and frozen endpoint contract", () => {
    expect(handoff.definitionHash).toBe(digest(readFileSync(source)));
    expect(handoff.relayHash).toBe(handoff.definitionHash);
    expect(handoff.codeHashScope).toBe("whole-script-bytes");
    expect(handoff.modeHashScope).toBe("separate-per-run-network-configuration");
    expect(handoff.tool).toBe("channels-selector-run-endpoint/v1");
    expect(handoff.policyHash).toBe("582200a0897dd14df915d17c12cb5965ff17524dc057320a9f5693c5442bc58d");
    expect(handoff.maxMessageBytes).toBe(512);
    expect(handoff.guestRunRoot).toBe("C:\\SelectorRepo\\artifacts\\9115\\<runId>");
    expect(handoff.operations.S).toEqual([
      "attach",
      "pause",
      "resume",
      "navigate-orders",
      "initial-range",
      "reload",
      "restore",
      "fallback-check",
      "close",
    ]);
    expect(handoff.operations.C).toEqual([
      "attach",
      "install",
      "pause",
      "resume",
      "cancel-before-begin",
      "capture",
      "remove",
      "close",
    ]);
    expect(handoff.actualEnvironment).toBe("PENDING_OPERATOR_ACTION");
    expect(handoff.acceptance).toBe("PENDING_HOST_REVIEW");
  });
  it("matches the actual package.prepare profile path without precreating its owned run root", async () => {
    const packaging = await import(new URL("../integrations/order-authority-probe/package.mjs", import.meta.url).href);
    const parent = path.join(repo, "artifacts", "9115");
    mkdirSync(parent, { recursive: true });
    const out = path.join(mkdtempSync(path.join(parent, "synthetic-environment-")), "run");
    expect(existsSync(out)).toBe(false);
    const preparation = packaging.prepare({
      out,
      cadenceMs: 30000,
      cadenceSource: packaging.AUTHORITY,
      t0: "2030-01-01T00:00:00.000Z",
      synthetic: true,
    });
    expect(preparation.profileDirectory).toBe(path.join(out, "profile"));
    expect(path.win32.relative("C:\\SelectorRepo", handoff.guestRunRoot)).toBe("artifacts\\9115\\<runId>");
  });
});
