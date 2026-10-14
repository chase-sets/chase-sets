import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  operations: { S: string[]; C: string[] };
};

// Synthetic component evidence only, never an actual E witness.
beforeAll(() => {
  const scratch = path.join(repo, "artifacts", "9558", "tests");
  mkdirSync(scratch, { recursive: true });
  const fixture = mkdtempSync(path.join(scratch, "synthetic-"));
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
    guestRoot: "C:\\SelectorRuns\\selector-capability-synthetic",
    guestProfile: "C:\\SelectorRuns\\selector-capability-synthetic\\profile",
    staging: stage,
    export: exported,
    journal,
    assets,
  };
  const configurationPath = path.join(fixture, "input.json");
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
Case 'unknown-property' { $m = Clone; $m.command = 'whoami'; Assert-SelectorConfiguration $m }
Case 'unknown-environment' { $m = Clone; $m.environment = 'host-desktop'; Assert-SelectorConfiguration $m }
Case 'wrong-scope' { $m = Clone; $m.purpose = 'B'; $m.modeHash = Get-SelectorModeHash $m; Assert-SelectorConfiguration $m }
foreach ($purpose in @('A', 'B')) {
  Case ($purpose + '-provider-reachable') { $m = Clone; $m.purpose = $purpose; if ($purpose -ceq 'B') { $m.runId = 'selector-rehearsal-synthetic'; $m.guestRoot = 'C:\SelectorRuns\' + $m.runId; $m.guestProfile = $m.guestRoot + '\profile' }; $m.networkMode = 'provider-reachable'; $m.osEgressBlocked = $false; $m.resolverRules = ''; $m.modeHash = Get-SelectorModeHash $m; Assert-SelectorConfiguration $m }
}
foreach ($purpose in @('S', 'C')) {
  $live = Clone; $live.purpose = $purpose; $live.endpointMode = $purpose; $live.runId = 'selector-' + $purpose + '-synthetic'
  $live.guestRoot = 'C:\SelectorRuns\' + $live.runId; $live.guestProfile = $live.guestRoot + '\profile'
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
Case 'define' { New-SelectorSandboxDefinition $c $WsbFile | Out-Null }
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
Case 'response-false' { Assert-SelectorResponse 200 '{"ok":false}' }
Case 'response-status' { Assert-SelectorResponse 302 '' }
Case 'response-payload' { Assert-SelectorResponse 200 '{"rangeSemanticsValid":true,"selectedRangeValid":false,"quickFilterRelationshipValid":true,"currentEpochComplete":false,"oldCompletionInvalidated":true,"rangeControlMatches":1,"quickFilterLabelMatches":"many","adjacentCountMatches":0,"completionSignalMatches":1}' }
Case 'response-boolean-count' { Assert-SelectorResponse 200 '{"rangeSemanticsValid":true,"selectedRangeValid":false,"quickFilterRelationshipValid":true,"currentEpochComplete":false,"oldCompletionInvalidated":true,"rangeControlMatches":true,"quickFilterLabelMatches":"many","adjacentCountMatches":0,"completionSignalMatches":1}' }
Case 'exposed-listener' { Invoke-SelectorLoopback @{ tool='channels-selector-run-endpoint/v1'; runId=$c.runId; policyIdentity='selector-agent-operation-capability-policy/v1'; policyHash=$script:SelectorEndpointPolicyHash; url='http://0.0.0.0:1234/operation'; token=('a'*64) } $message $c | Out-Null }
Case 'redirect-endpoint' { Invoke-SelectorLoopback @{ tool='channels-selector-run-endpoint/v1'; runId=$c.runId; policyIdentity='selector-agent-operation-capability-policy/v1'; policyHash=$script:SelectorEndpointPolicyHash; url='http://127.0.0.1:1234/operation?next=external'; token=('a'*64) } $message $c | Out-Null }

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
    expect(boot).toContain("-Action guest");
    expect(boot).toContain("Get-FileHash C:\\SelectorStaging\\PowerShell\\pwsh.exe");
    expect(boot).toContain("foreach ($a in $c.assets)");
    expect(boot).toContain("Get-FileHash -LiteralPath (Join-Path C:\\SelectorStaging $a.path)");
  });
  for (const name of [
    "tampered-definitionHash",
    "tampered-relayHash",
    "tampered-modeHash",
    "folded-mode-hash",
    "writable-staging",
    "mapped-profile",
    "mapped-root",
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

describe("selector-isolated-environment-transport", () => {
  for (const name of [
    "message",
    "response-ok",
    "response-204",
    "response-payload",
    "roundtrip-ok",
    "roundtrip-204",
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
    "response-false",
    "response-status",
    "response-boolean-count",
    "exposed-listener",
    "redirect-endpoint",
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
});
