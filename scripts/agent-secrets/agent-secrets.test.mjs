import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const isWindows = process.platform === "win32";
const projectId = "6f1c3a52-8f0e-4b8e-9a43-2d61f1f0c0aa";
const setTokenScript = "scripts/agent-secrets/set-bitwarden-agent-token.ps1";
const bwNames = ["BW_SESSION", "BW_PASSWORD", "BW_CLIENTID", "BW_CLIENTSECRET"];
const seats = [];

// Every pwsh launch resolves `pwsh` from PATH. A missing pwsh fails these
// tests rather than skipping them.
const pwsh = "pwsh";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function withoutRealBws(searchPath) {
  return searchPath
    .split(path.delimiter)
    .filter((entry) => !["bws", "bws.exe", "bws.cmd"].some((name) => entry && existsSync(path.join(entry, name))))
    .join(path.delimiter);
}

// The helper sees the developer's environment minus anything that could reach
// a real bws or a real token: Bitwarden variables, helper settings and any
// PATH directory holding bws.
function helperEnvironment(overrides = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(BW_|BWS_)|^CHASE_SETS_AGENT_SECRETS$|^CHASE_SETS_BWS_EXE$/i.test(name)) continue;
    env[name] = /^path$/i.test(name) ? withoutRealBws(value) : value;
  }
  return { ...env, ...overrides };
}

function createSeat({ credential = true, bws = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-secrets-"));
  seats.push(root);
  for (const name of ["with-secrets.ps1", "set-bitwarden-agent-token.ps1"]) {
    copyFileSync(path.join(here, name), path.join(root, name));
  }
  copyFileSync(
    path.join(here, "test-fakes", "bitwarden-agent-credential.stub.psm1"),
    path.join(root, "bitwarden-agent-credential.psm1"),
  );
  copyFileSync(path.join(here, "test-fakes", "fake-bws.mjs"), path.join(root, "fake-bws.mjs"));
  const token = `sentinel-token-${randomUUID()}`;
  writeFileSync(path.join(root, "stub-credential.json"), JSON.stringify({ present: credential, projectId, token }));
  writeFileSync(path.join(root, "fake-bws.json"), JSON.stringify(bws));
  const fake = path.join(root, "fake-bws.mjs");
  const shim = path.join(root, isWindows ? "bws.cmd" : "bws");
  writeFileSync(
    shim,
    isWindows ? `@"${process.execPath}" "${fake}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,
  );
  if (!isWindows) chmodSync(shim, 0o755);
  return { root, token, shim };
}

function runPwsh(args, { cwd, env, input = "" }) {
  const result = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", ...args], {
    cwd,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function runSeat(seat, script, args, env = {}) {
  return runPwsh(["-File", path.join(seat.root, script), ...args], {
    cwd: seat.root,
    env: helperEnvironment({ CHASE_SETS_BWS_EXE: seat.shim, ...env }),
  });
}

function readRecords(seat, name) {
  const file = path.join(seat.root, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Every recorded call must carry the fake's marker, so a real bws can never
// stand in for it.
function bwsCalls(seat) {
  const calls = readRecords(seat, "fake-bws.log");
  for (const call of calls) expect(call.marker).toBe("chase-sets-fake-bws");
  return calls;
}

function credentialCalls(seat) {
  return readRecords(seat, "stub-credential.log").map((call) => call.op);
}

function filesContaining(root, needle, except) {
  const hits = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!except.includes(entry.name) && readFileSync(full).includes(needle)) hits.push(full);
    }
  };
  walk(root);
  return hits;
}

function expectTokenOnlyInBwsEnvironment(seat, result) {
  const calls = bwsCalls(seat);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.tokenSha256).toBe(sha256(seat.token));
    expect(call.tokenEnvNames).toEqual([]);
    expect(call.stdinHasToken).toBe(false);
    expect(call.argv.some((argument) => argument.includes(seat.token))).toBe(false);
  }
  expect(result.stdout).not.toContain(seat.token);
  expect(result.stderr).not.toContain(seat.token);
  expect(filesContaining(seat.root, seat.token, ["stub-credential.json"])).toEqual([]);
}

beforeAll(() => {
  const probe = runPwsh(["-Command", "$PSVersionTable.PSVersion.Major"], { cwd: os.tmpdir(), env: process.env });
  expect(probe.status).toBe(0);
  expect(Number(probe.stdout.trim())).toBeGreaterThanOrEqual(7);
});

afterEach(() => {
  for (const root of seats.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("with-secrets.ps1 -Command", () => {
  it("hands the token only to the bws environment and records the exact run argv", () => {
    const seat = createSeat({ bws: { stdout: "child-out\n" } });
    const plain = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello"]);
    const isolated = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello", "-NoInheritEnv"]);

    expect(plain.status).toBe(0);
    expect(isolated.status).toBe(0);
    const [first, second] = bwsCalls(seat);
    const shell = first.argv[4];
    expect(path.isAbsolute(shell)).toBe(true);
    expect(path.basename(shell)).toMatch(/^pwsh(\.exe)?$/i);
    expect(first.argv).toEqual(["run", "--project-id", projectId, "--shell", shell, "--", "Write-Output hello"]);
    expect(second.argv).toEqual([
      "run",
      "--project-id",
      projectId,
      "--shell",
      shell,
      "--no-inherit-env",
      "--",
      "Write-Output hello",
    ]);
    expectTokenOnlyInBwsEnvironment(seat, plain);
    expectTokenOnlyInBwsEnvironment(seat, isolated);
  });

  it("passes through the child's stdout, stderr and exit code", () => {
    const seat = createSeat({ bws: { stdout: "child-out\n", stderr: "child-err\n", exitCode: 7 } });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "exit 7"]);

    expect(result.status).toBe(7);
    expect(result.stdout).toBe("child-out\n");
    expect(result.stderr).toBe("child-err\n");
  });

  it("drains both streams concurrently when the child writes a megabyte to each", () => {
    const bulkBytes = 1024 * 1024;
    const seat = createSeat({ bws: { bulkBytes, stdout: "end-out", stderr: "end-err" } });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output bulk"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${"o".repeat(bulkBytes)}end-out`);
    expect(result.stderr).toBe(`${"e".repeat(bulkBytes)}end-err`);
  });

  it("exports a launch builder that hides the window, redirects both streams and scrubs BW_ variables", () => {
    const seat = createSeat();
    const sentinels = Object.fromEntries(bwNames.map((name) => [name, `sentinel-${name}-${randomUUID()}`]));
    const describeStart = (capture) =>
      [
        `$start = New-BwsStartInfo -BwsPath '${seat.shim}' -Arguments @('secret', 'list') -Token 'launch-builder-token'${capture ? " -Capture" : ""}`,
        "[pscustomobject]@{ useShellExecute = $start.UseShellExecute; createNoWindow = $start.CreateNoWindow; redirectStandardOutput = $start.RedirectStandardOutput; redirectStandardError = $start.RedirectStandardError; redirectStandardInput = $start.RedirectStandardInput; fileName = $start.FileName; arguments = @($start.ArgumentList); tokenSet = $start.Environment['BWS_ACCESS_TOKEN'] -ceq 'launch-builder-token'; bwNames = @($start.Environment.Keys | Where-Object { $_ -match '^BW_' }) } | ConvertTo-Json -Compress",
      ].join("; ");
    const script = [
      `. '${path.join(seat.root, "with-secrets.ps1")}' -Command unused`,
      describeStart(false),
      describeStart(true),
    ].join("; ");
    const result = runPwsh(["-Command", script], { cwd: seat.root, env: helperEnvironment(sentinels) });

    expect(result.status).toBe(0);
    const [command, capture] = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const expected = {
      useShellExecute: false,
      createNoWindow: true,
      redirectStandardOutput: true,
      redirectStandardError: true,
      fileName: seat.shim,
      arguments: ["secret", "list"],
      tokenSet: true,
      bwNames: [],
    };
    expect(command).toEqual({ ...expected, redirectStandardInput: false });
    expect(capture).toEqual({ ...expected, redirectStandardInput: true });
    expect(bwsCalls(seat)).toEqual([]);
    expect(credentialCalls(seat)).toEqual([]);
  });

  it("keeps BW_SESSION, BW_PASSWORD, BW_CLIENTID and BW_CLIENTSECRET out of the bws environment", () => {
    const seat = createSeat({ bws: { list: "[]" } });
    const sentinels = Object.fromEntries(bwNames.map((name) => [name, `sentinel-${name}-${randomUUID()}`]));
    const command = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello"], sentinels);
    const check = runSeat(seat, "with-secrets.ps1", ["-Check"], sentinels);

    expect(command.status).toBe(0);
    expect(check.status).toBe(0);
    const calls = bwsCalls(seat);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.bwEnvNames).toEqual([]);
    for (const value of Object.values(sentinels)) {
      expect(filesContaining(seat.root, value, [])).toEqual([]);
    }
  });
});

describe("with-secrets.ps1 -ListKeys and -Check", () => {
  const valueSentinel = `sentinel-value-${randomUUID()}`;
  const secret = (key, n) => ({
    id: randomUUID(),
    organizationId: randomUUID(),
    projectId,
    key,
    value: `${valueSentinel}-${n}`,
    note: `${valueSentinel}-note-${n}`,
  });

  it("prints only the sorted key names", () => {
    const list = JSON.stringify([secret("ZETA_KEY", 1), secret("ALPHA_KEY", 2), secret("MIDDLE_KEY", 3)]);
    const seat = createSeat({ bws: { list, listStderr: `bws noise ${valueSentinel}\n` } });
    const result = runSeat(seat, "with-secrets.ps1", ["-ListKeys"]);

    expect(result.status).toBe(0);
    expect(result.stdout.split(/\r?\n/).filter(Boolean)).toEqual(["ALPHA_KEY", "MIDDLE_KEY", "ZETA_KEY"]);
    expect(result.stdout).not.toContain(valueSentinel);
    expect(result.stderr).not.toContain(valueSentinel);
    expect(bwsCalls(seat).map((call) => call.argv)).toEqual([
      ["secret", "list", projectId, "--output", "json", "--color", "no"],
    ]);
    expectTokenOnlyInBwsEnvironment(seat, result);
  });

  it.each([
    ["truncated JSON", `[{"key":"ALPHA_KEY","value":"${valueSentinel}"`],
    ["a non-array document", `{"key":"ALPHA_KEY","value":"${valueSentinel}"}`],
    ["an entry without a key", `[{"value":"${valueSentinel}"}]`],
    ["text that is not JSON", `Error: ${valueSentinel}`],
    ["a key that would forge a second output line", `[{"key":"ALPHA_KEY\\n${valueSentinel}","value":"x"}]`],
  ])("refuses %s as unparseable-list without echoing it", (_name, list) => {
    const seat = createSeat({ bws: { list, listStderr: `bws noise ${valueSentinel}\n` } });
    const result = runSeat(seat, "with-secrets.ps1", ["-ListKeys"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unparseable-list");
    expect(result.stdout).not.toContain(valueSentinel);
    expect(result.stderr).not.toContain(valueSentinel);
  });

  it("reports bws-failed without echoing bws output when the list call fails", () => {
    const seat = createSeat({ bws: { list: "", listStderr: `Error: ${valueSentinel}\n`, listExitCode: 1 } });
    const result = runSeat(seat, "with-secrets.ps1", ["-Check"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bws-failed");
    expect(result.stderr).not.toContain(valueSentinel);
    expect(result.stdout).not.toContain(valueSentinel);
  });

  it("treats a readable project with zero secrets as readable without calling bws run", () => {
    const seat = createSeat({ bws: { list: "[]", runNotFound: true } });
    const check = runSeat(seat, "with-secrets.ps1", ["-Check"]);
    const listKeys = runSeat(seat, "with-secrets.ps1", ["-ListKeys"]);

    expect(check.status).toBe(0);
    expect(check.stdout).toContain(`OK: account 'lanes' can read project ${projectId}`);
    expect(listKeys.status).toBe(0);
    expect(listKeys.stdout.trim()).toBe("");
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret", "secret"]);

    // The same fake answers `run` with the 404 that bws 2.1.0 returns for an empty project.
    const command = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello"]);
    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("404 Not Found");
  });
});

describe("with-secrets.ps1 refusals", () => {
  it("names the token setup script when no credential is stored", () => {
    const seat = createSeat({ credential: false });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing-token");
    expect(result.stderr).toContain(setTokenScript);
    expect(credentialCalls(seat)).toEqual(["import", "read"]);
    expect(bwsCalls(seat)).toEqual([]);
  });

  it.each([[["-Command", "Write-Output hello"]], [["-Check"]], [["-ListKeys"]]])(
    "refuses %j under CHASE_SETS_AGENT_SECRETS=deny before loading the credential module",
    (args) => {
      const seat = createSeat();
      const result = runSeat(seat, "with-secrets.ps1", args, { CHASE_SETS_AGENT_SECRETS: "deny" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("denied");
      expect(credentialCalls(seat)).toEqual([]);
      expect(bwsCalls(seat)).toEqual([]);
    },
  );

  it("refuses a relative CHASE_SETS_BWS_EXE without falling back to another bws", () => {
    const seat = createSeat();
    const localAppData = path.join(seat.root, "empty-local-app-data");
    mkdirSync(localAppData);
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello"], {
      CHASE_SETS_BWS_EXE: path.basename(seat.shim),
      LOCALAPPDATA: localAppData,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bws-failed");
    expect(result.stderr).toContain("CHASE_SETS_BWS_EXE must be an absolute path");
    expect(credentialCalls(seat)).toEqual([]);
    expect(bwsCalls(seat)).toEqual([]);
  });
});

describe("set-bitwarden-agent-token.ps1", () => {
  it("refuses redirected stdin without writing a credential", () => {
    const seat = createSeat();
    const result = runPwsh(["-File", path.join(seat.root, "set-bitwarden-agent-token.ps1"), "-ProjectId", projectId], {
      cwd: seat.root,
      env: helperEnvironment({ CHASE_SETS_BWS_EXE: seat.shim }),
      input: `${seat.token}\n`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refused");
    expect(credentialCalls(seat)).not.toContain("write");
    expect(bwsCalls(seat)).toEqual([]);
  });

  it("deletes the stored credential through the credential module with -Remove", () => {
    const seat = createSeat();
    const result = runSeat(seat, "set-bitwarden-agent-token.ps1", ["-Remove"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Removed chase-sets/bws/lanes");
    expect(readRecords(seat, "stub-credential.log")).toContainEqual({ op: "delete", account: "lanes" });
    expect(credentialCalls(seat)).not.toContain("write");
  });

  it("refuses under CHASE_SETS_AGENT_SECRETS=deny before loading the credential module", () => {
    const seat = createSeat();
    const result = runSeat(seat, "set-bitwarden-agent-token.ps1", ["-Remove"], { CHASE_SETS_AGENT_SECRETS: "deny" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("denied");
    expect(credentialCalls(seat)).toEqual([]);
  });
});

describe.skipIf(!isWindows)("bitwarden-agent-credential.psm1 on Windows", () => {
  it("writes, reads and deletes a random test account in Credential Manager", () => {
    const module = path.join(here, "bitwarden-agent-credential.psm1");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Import-Module '${module}' -Force -DisableNameChecking`,
      "$account = 'test-' + [guid]::NewGuid().ToString()",
      "$project = [guid]::NewGuid()",
      "$plain = 'fake-token-' + [guid]::NewGuid().ToString('N')",
      "try {",
      "  Set-AgentBwsCredential -Account $account -ProjectId $project -AccessToken (ConvertTo-SecureString $plain -AsPlainText -Force)",
      "  $stored = Get-AgentBwsCredential -Account $account",
      "  $removed = Remove-AgentBwsCredential -Account $account",
      "  $after = Get-AgentBwsCredential -Account $account",
      "} finally { $null = Remove-AgentBwsCredential -Account $account }",
      '[pscustomobject]@{ target = $stored.Target -ceq "chase-sets/bws/$account"; project = $stored.ProjectId -eq $project; token = $stored.AccessToken -ceq $plain; removed = $removed; absent = $null -eq $after; absentAfterCleanup = $null -eq (Get-AgentBwsCredential -Account $account) } | ConvertTo-Json -Compress',
    ].join("\n");
    const result = runPwsh(["-Command", script], { cwd: os.tmpdir(), env: helperEnvironment() });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      target: true,
      project: true,
      token: true,
      removed: true,
      absent: true,
      absentAfterCleanup: true,
    });
  });
});

describe("repo AGENTS.md", () => {
  it("routes agents to the product helper paths", () => {
    const agents = readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");

    expect(agents).toContain("## Secrets for agents");
    expect(agents).toContain("pwsh -NoProfile -File scripts/agent-secrets/with-secrets.ps1 -Command '<cmd>'");
    expect(agents).toContain("../main/scripts/agent-secrets/");
    expect(agents).not.toContain(["orchestrator", "with-secrets"].join("/"));
    for (const [named] of agents.matchAll(/scripts\/agent-secrets\/[\w.-]+\.ps1/g)) {
      expect(existsSync(path.join(repoRoot, named))).toBe(true);
    }
  });
});
