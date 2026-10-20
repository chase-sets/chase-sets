import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  linkSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
// A -Command launch compiles the Add-Type scrubber, about 6 s cold on a hosted runner, past vitest's 5 s default.
const helperLaunchTimeoutMs = 30_000;
let sharedPwshHome;
let privatePwshHome;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function withoutRealBws(searchPath) {
  return searchPath
    .split(path.delimiter)
    .filter((entry) => !["bws", "bws.exe", "bws.cmd"].some((name) => entry && existsSync(path.join(entry, name))))
    .join(path.delimiter);
}

function linkPrivatePowerShellHome(source, target) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      symlinkSync(from, to, isWindows ? "junction" : "dir");
    } else {
      try {
        linkSync(from, to);
      } catch {
        copyFileSync(from, to);
      }
    }
  }
}

// The helper sees the developer's environment minus anything that could reach
// a real bws or a real token: Bitwarden variables, helper settings and any
// PATH directory holding bws.
function helperEnvironment(overrides = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(BW_|BWS_)|^CHASE_SETS_AGENT_SECRETS$|^CHASE_SETS_BWS_EXE$/i.test(name)) continue;
    env[name] = /^path$/i.test(name)
      ? [privatePwshHome, withoutRealBws(value)].filter(Boolean).join(path.delimiter)
      : value;
  }
  return { ...env, ...overrides };
}

const repositoryInventory = readFileSync(path.join(repoRoot, ".github", "credential-inventory.json"), "utf8");
// The repository inventory with a synthetic agent tier admitting secretList's
// KEY_n names with any value, for cases that exercise something other than the
// tier guard.
const syntheticTierInventory = JSON.stringify({
  ...JSON.parse(repositoryInventory),
  agentTier: {
    project: "chase-sets-agent-dev",
    keys: [0, 1, 2, 3].map((n) => ({ name: `KEY_${n}`, testPrefixes: [] })),
  },
});

// A seat mirrors the checkout layout the helper reads its inventory from:
// <repo>/scripts/agent-secrets/with-secrets.ps1 and
// <repo>/.github/credential-inventory.json. `inventory` is the file's text, or
// null for no file.
function createSeat({
  credential = true,
  bws = {},
  omitAdapter = false,
  token = `sentinel-token-${randomUUID()}`,
  inventory = syntheticTierInventory,
} = {}) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "agent-secrets-"));
  seats.push(repo);
  const root = path.join(repo, "scripts", "agent-secrets");
  mkdirSync(root, { recursive: true });
  if (inventory !== null) {
    mkdirSync(path.join(repo, ".github"));
    writeFileSync(path.join(repo, ".github", "credential-inventory.json"), inventory);
  }
  for (const name of [
    "with-secrets.ps1",
    "set-bitwarden-agent-token.ps1",
    "profile-free-shell.cmd",
    "profile-free-shell.sh",
  ]) {
    if (omitAdapter && /^profile-free-shell\./.test(name)) continue;
    copyFileSync(path.join(here, name), path.join(root, name));
  }
  copyFileSync(
    path.join(here, "test-fakes", "bitwarden-agent-credential.stub.psm1"),
    path.join(root, "bitwarden-agent-credential.psm1"),
  );
  copyFileSync(path.join(here, "test-fakes", "fake-bws.mjs"), path.join(root, "fake-bws.mjs"));
  writeFileSync(path.join(root, "stub-credential.json"), JSON.stringify({ present: credential, projectId, token }));
  writeFileSync(path.join(root, "fake-bws.json"), JSON.stringify(bws));
  const fake = path.join(root, "fake-bws.mjs");
  const shim = path.join(root, isWindows ? "bws.cmd" : "bws");
  writeFileSync(
    shim,
    isWindows
      ? `@echo off\r\nset "CHASE_SETS_FAKE_BWS_CMDLINE=%cmdcmdline%"\r\n"${process.execPath}" "${fake}"\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,
  );
  if (!isWindows) chmodSync(shim, 0o755);
  return { root, token, shim };
}

// encoding "buffer" keeps the helper's raw stream bytes for byte-exact checks.
function runPwsh(args, { cwd, env, input = "", encoding = "utf8" }) {
  const result = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", ...args], {
    cwd,
    env,
    input,
    encoding,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function runSeat(seat, script, args, env = {}, { encoding } = {}) {
  return runPwsh(["-File", path.join(seat.root, script), ...args], {
    cwd: seat.root,
    env: helperEnvironment({ CHASE_SETS_BWS_EXE: seat.shim, ...env }),
    encoding,
  });
}

function writeRuntimeProfile(profile, content) {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const result = runPwsh(
    [
      "-Command",
      `$bytes = [Convert]::FromBase64String('${encoded}'); [IO.File]::WriteAllBytes('${profile.replaceAll("'", "''")}', $bytes)`,
    ],
    { cwd: os.tmpdir(), env: helperEnvironment() },
  );
  expect(result.status).toBe(0);
}

function removeRuntimeProfile(profile) {
  const result = runPwsh(
    [
      "-Command",
      `if (Test-Path -LiteralPath '${profile.replaceAll("'", "''")}') { Remove-Item -LiteralPath '${profile.replaceAll("'", "''")}' -Force }`,
    ],
    {
      cwd: os.tmpdir(),
      env: helperEnvironment(),
    },
  );
  expect(result.status).toBe(0);
}

// A `bws secret list` document whose values are the given strings.
function secretList(values) {
  return JSON.stringify(
    values.map((value, n) => ({ id: randomUUID(), organizationId: randomUUID(), projectId, key: `KEY_${n}`, value })),
  );
}

const encodings = ["utf8", "utf16le", "utf16be"];

// The helper's own lines end in CRLF on Windows.
const unixLines = (text) => text.replace(/\r\n/g, "\n");

function encode(text, encoding) {
  if (encoding === "utf8") return Buffer.from(text, "utf8");
  const little = Buffer.from(text, "utf16le");
  return encoding === "utf16le" ? little : little.swap16();
}

// Byte equality reported as the first differing offset, so a megabyte stream
// never floods the failure message.
function expectSameBytes(actual, expected) {
  let offset = 0;
  while (offset < Math.min(actual.length, expected.length) && actual[offset] === expected[offset]) offset += 1;
  const at = (bytes) => bytes.subarray(offset, offset + 32).toString("hex");
  expect({ length: actual.length, offset, actual: at(actual) }).toEqual({
    length: expected.length,
    offset: expected.length,
    actual: at(expected),
  });
}

function expectNoPattern(bytes, secrets) {
  for (const secret of secrets) {
    for (const encoding of encodings) expect(bytes.includes(encode(secret, encoding))).toBe(false);
  }
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
  const probe = runPwsh(["-Command", "$PSHOME"], { cwd: os.tmpdir(), env: process.env });
  expect(probe.status).toBe(0);
  sharedPwshHome = probe.stdout.trim();
  expect(sharedPwshHome).not.toBe("");
  const sharedProfile = path.join(sharedPwshHome, "profile.ps1");
  expect(existsSync(sharedProfile)).toBe(false);
  privatePwshHome = mkdtempSync(path.join(os.tmpdir(), "agent-secrets-private-pwsh-"));
  linkPrivatePowerShellHome(sharedPwshHome, privatePwshHome);
  expect(existsSync(path.join(privatePwshHome, "profile.ps1"))).toBe(false);
  const version = runPwsh(["-Command", "$PSVersionTable.PSVersion.Major"], {
    cwd: os.tmpdir(),
    env: helperEnvironment(),
  });
  expect(version.status).toBe(0);
  expect(Number(version.stdout.trim())).toBeGreaterThanOrEqual(7);
});

afterAll(() => {
  const sharedProfile = path.join(sharedPwshHome, "profile.ps1");
  expect(existsSync(sharedProfile)).toBe(false);
  rmSync(privatePwshHome, { recursive: true, force: true });
});

afterEach(() => {
  for (const root of seats.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("with-secrets.ps1 -Command", { timeout: helperLaunchTimeoutMs }, () => {
  // One helper launch per case keeps each test to a single launch's cost.
  it.each([
    ["inherited", [], []],
    ["-NoInheritEnv", ["-NoInheritEnv"], ["--no-inherit-env"]],
  ])(
    "hands the token only to the bws environment and records one secret list, then the exact run argv (%s)",
    (_name, flags, runFlags) => {
      const seat = createSeat({ bws: { stdout: "child-out\n" } });
      const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello", ...flags]);

      expect(result.status).toBe(0);
      const [list, run, ...rest] = bwsCalls(seat);
      expect(rest).toEqual([]);
      expect(list.argv).toEqual(["secret", "list", projectId, "--output", "json", "--color", "no"]);
      const shell = run.argv[4];
      expect(path.isAbsolute(shell)).toBe(true);
      expect(path.basename(shell)).toMatch(/^profile-free-shell\.(?:cmd|sh)$/i);
      expect(run.argv).toEqual([
        "run",
        "--project-id",
        projectId,
        "--shell",
        shell,
        ...runFlags,
        "--",
        "Write-Output hello",
      ]);
      expectTokenOnlyInBwsEnvironment(seat, result);
    },
  );

  it.each([
    ["inherited", []],
    ["-NoInheritEnv", ["-NoInheritEnv"]],
  ])("suppresses the nested PowerShell profile at the bws shell boundary (%s)", (_name, flags) => {
    const injectedValue = `synthetic-key-${randomUUID()}`;
    const seat = createSeat({ bws: { executeShell: true, list: secretList([injectedValue]) } });
    const marker = path.join(seat.root, `profile-marker-${randomUUID()}`);
    const profile = path.join(privatePwshHome, "profile.ps1");
    expect(path.relative(privatePwshHome, profile).startsWith("..")).toBe(false);
    expect(existsSync(profile)).toBe(false);
    writeRuntimeProfile(profile, `Set-Content -LiteralPath '${marker}' profile\n`);
    try {
      const positive = spawnSync(pwsh, ["-NonInteractive", "-Command", "Write-Output positive"], {
        cwd: seat.root,
        env: helperEnvironment(),
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      });
      expect(positive.status).toBe(0);
      expect(existsSync(marker)).toBe(true);
      rmSync(marker, { force: true });
      expect(existsSync(marker)).toBe(false);

      const result = runSeat(seat, "with-secrets.ps1", [
        "-Command",
        'Write-Output "BWS_ACCESS_TOKEN=$([bool]$env:BWS_ACCESS_TOKEN) KEY_0=$([bool]$env:KEY_0)"',
        ...flags,
      ]);
      expect(result.status).toBe(0);
      expect(unixLines(result.stdout)).toBe("BWS_ACCESS_TOKEN=False KEY_0=True\n");
      expect(existsSync(marker)).toBe(false);
      expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret", "run"]);
      expect(bwsCalls(seat)[1].shellContent).toContain("-NoProfile");
    } finally {
      removeRuntimeProfile(profile);
      rmSync(marker, { force: true });
    }
  });

  it("passes through the child's stdout, stderr and exit code", () => {
    const seat = createSeat({ bws: { stdout: "child-out\n", stderr: "child-err\n", exitCode: 7 } });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "exit 7"]);

    expect(result.status).toBe(7);
    expect(result.stdout).toBe("child-out\n");
    expect(result.stderr).toBe("child-err\n");
  });

  it("executes the bws shell boundary with unchanged output and exit status", () => {
    const seat = createSeat({ bws: { executeShell: true } });
    const result = runSeat(seat, "with-secrets.ps1", [
      "-Command",
      "Write-Output 'boundary'; [Console]::Error.Write('err'); exit 7",
    ]);

    expect(result.status).toBe(7);
    expect(unixLines(result.stdout)).toBe("boundary\n");
    expect(result.stderr).toBe("err");
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret", "run"]);
  });

  it.each([
    ["inherited", []],
    ["-NoInheritEnv", ["-NoInheritEnv"]],
  ])("forwards the literal Windows shell command without expansion (%s)", (_name, flags) => {
    const seat = createSeat({ bws: { executeShell: true, list: secretList([`synthetic-key-${randomUUID()}`]) } });
    const literal = 'a "b" & c | d; ^ %PATH% \\';
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", `Write-Output '${literal}'; exit 7`, ...flags]);

    expect(result.status).toBe(7);
    expect(unixLines(result.stdout)).toBe(`${literal}\n`);
    expect(unixLines(result.stderr)).toBe("");
  });

  it("forwards bytes that only begin a pattern, including a held tail flushed at end of stream", () => {
    const value = `sentinel-value-${randomUUID()}`;
    const nearMiss = `${value.slice(0, -1)}!`;
    const seat = createSeat({
      bws: {
        list: secretList([value]),
        segments: [
          { stream: "stdout", text: `${nearMiss} \u0000ÿ ` },
          { stream: "stdout", text: value.slice(0, 20) },
          { stream: "stderr", text: "{{TOKEN@0-20}}" },
        ],
        exitCode: 7,
      },
    });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "near miss"], {}, { encoding: "buffer" });

    expect(result.status).toBe(7);
    expectSameBytes(result.stdout, Buffer.from(`${nearMiss} \u0000ÿ ${value.slice(0, 20)}`, "utf8"));
    expectSameBytes(result.stderr, Buffer.from(seat.token.slice(0, 20), "utf8"));
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

  it.each([
    [
      ["-Command", "Write-Output hello"],
      ["secret", "run"],
    ],
    [["-Check"], ["secret"]],
  ])(
    "keeps BW_SESSION, BW_PASSWORD, BW_CLIENTID and BW_CLIENTSECRET out of the bws environment for %j",
    (args, verbs) => {
      const seat = createSeat({ bws: { list: "[]" } });
      const sentinels = Object.fromEntries(bwNames.map((name) => [name, `sentinel-${name}-${randomUUID()}`]));
      const result = runSeat(seat, "with-secrets.ps1", args, sentinels);

      expect(result.status).toBe(0);
      const calls = bwsCalls(seat);
      expect(calls.map((call) => call.argv[0])).toEqual(verbs);
      for (const call of calls) expect(call.bwEnvNames).toEqual([]);
      for (const value of Object.values(sentinels)) {
        expect(filesContaining(seat.root, value, [])).toEqual([]);
      }
    },
  );
});

describe("with-secrets.ps1 -Command output scrubbing", { timeout: helperLaunchTimeoutMs }, () => {
  const R = "[redacted]";
  const MiB = 1024 * 1024;
  const KiB64 = 65536;
  const notFound =
    'Error:\n   0: Received error message from server: [404 Not Found] {"message":"Resource not found."}\n';
  const out = (text, extra = {}) => ({ stream: "stdout", text, ...extra });
  const err = (text, extra = {}) => ({ stream: "stderr", text, ...extra });

  // v2 extends v1, so only longest-pattern-first turns v2 into one [redacted].
  // {{TOKEN}} is the token the fake received in BWS_ACCESS_TOKEN.
  const mutants = [
    [
      "whole on stdout",
      ({ v1, v2 }) => ({
        segments: [out(`out {{TOKEN}} ${v1} ${v2} end\n`)],
        stdout: encode(`out ${R} ${R} ${R} end\n`, "utf8"),
        stderr: Buffer.alloc(0),
      }),
    ],
    [
      "whole on stderr",
      ({ v1, v2 }) => ({
        segments: [err(`err {{TOKEN}} ${v1} ${v2} end\n`)],
        stdout: Buffer.alloc(0),
        stderr: encode(`err ${R} ${R} ${R} end\n`, "utf8"),
      }),
    ],
    [
      "split over two writes with a pause",
      ({ v1, v2 }) => ({
        segments: [
          out("x{{TOKEN@0-9}}"),
          out(`{{TOKEN@9-}}y${v1.slice(0, 7)}`, { pauseMs: 150 }),
          out(`${v1.slice(7)}z\n`, { pauseMs: 150 }),
          err(v2.slice(0, 3)),
          err(`${v2.slice(3)}\n`, { pauseMs: 150 }),
        ],
        stdout: encode(`x${R}y${R}z\n`, "utf8"),
        stderr: encode(`${R}\n`, "utf8"),
      }),
    ],
    [
      "in UTF-16LE",
      ({ v1, v2 }) => ({
        segments: [
          out(`le {{TOKEN}} ${v1}\n`, { encoding: "utf16le" }),
          err(`${v2.slice(0, 5)}`, { encoding: "utf16le" }),
          err(`${v2.slice(5)}\n`, { encoding: "utf16le", pauseMs: 200 }),
        ],
        stdout: encode(`le ${R} ${R}\n`, "utf16le"),
        stderr: encode(`${R}\n`, "utf16le"),
      }),
    ],
    [
      "in UTF-16BE",
      ({ v1, v2 }) => ({
        segments: [
          out("be {{TOKEN@0-5}}", { encoding: "utf16be" }),
          out(`{{TOKEN@5-}} ${v2}\n`, { encoding: "utf16be", pauseMs: 200 }),
          err(`${v1}\n`, { encoding: "utf16be" }),
        ],
        stdout: encode(`be ${R} ${R}\n`, "utf16be"),
        stderr: encode(`${R}\n`, "utf16be"),
      }),
    ],
    [
      "back to back",
      ({ v1, v2 }) => ({
        segments: [out(`{{TOKEN}}${v1}${v2}{{TOKEN}}\n`), err(`${v2}${v1}{{TOKEN}}`)],
        stdout: encode(`${R}${R}${R}${R}\n`, "utf8"),
        stderr: encode(`${R}${R}${R}`, "utf8"),
      }),
    ],
    [
      "across a 64 KiB boundary of the megabyte stream",
      ({ v1, v2 }) => ({
        segments: [
          out(`${"o".repeat(KiB64 - 9)}{{TOKEN@0-9}}`),
          out(`{{TOKEN@9-}}${"o".repeat(MiB - KiB64)}`),
          err(`${"e".repeat(KiB64 - 4)}${v1.slice(0, 4)}`),
          err(`${v1.slice(4)}${"e".repeat(MiB - KiB64)}${v2}`),
        ],
        stdout: encode(`${"o".repeat(KiB64 - 9)}${R}${"o".repeat(MiB - KiB64)}`, "utf8"),
        stderr: encode(`${"e".repeat(KiB64 - 4)}${R}${"e".repeat(MiB - KiB64)}${R}`, "utf8"),
      }),
    ],
    [
      "as the last bytes before exit 7",
      ({ v1 }) => ({
        segments: [out("done {{TOKEN}}"), err(v1)],
        stdout: encode(`done ${R}`, "utf8"),
        stderr: encode(R, "utf8"),
      }),
    ],
    [
      "on the run 404 path",
      ({ v1, v2 }) => ({
        runNotFound: true,
        status: 1,
        segments: [err(`{{TOKEN}} ${v1}\n`), out(`${v2}\n`)],
        stdout: encode(`${R}\n`, "utf8"),
        stderr: encode(`${R} ${R}\n${notFound}`, "utf8"),
      }),
    ],
  ];

  it.each(mutants)("replaces the token and two values printed %s", (_name, build) => {
    const v1 = `sentinel-value-${randomUUID()}`;
    const v2 = `${v1}-longer`;
    const mutant = build({ v1, v2 });
    const seat = createSeat({
      bws: { list: secretList([v1, v2]), segments: mutant.segments, runNotFound: mutant.runNotFound, exitCode: 7 },
    });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "mutant"], {}, { encoding: "buffer" });

    expect(result.status).toBe(mutant.status ?? 7);
    for (const stream of [result.stdout, result.stderr]) expectNoPattern(stream, [seat.token, v1, v2]);
    expectSameBytes(result.stdout, mutant.stdout);
    expectSameBytes(result.stderr, mutant.stderr);
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret", "run"]);
    expect(filesContaining(seat.root, seat.token, ["stub-credential.json"])).toEqual([]);
    for (const value of [v1, v2]) expect(filesContaining(seat.root, value, ["fake-bws.json"])).toEqual([]);
  });

  // The exported scanner, driven directly: a held partial match is never
  // written once the scanner aborts, and a failing source pump aborts too.
  it("writes no held byte when the scanner is aborted mid-match or its source fails", () => {
    const seat = createSeat();
    const secret = `sentinel-abort-${randomUUID()}`;
    const script = [
      `. '${path.join(seat.root, "with-secrets.ps1")}' -Command unused`,
      "Initialize-SecretScrubber",
      `$secret = '${secret}'`,
      "$utf8 = [Text.Encoding]::UTF8",
      "function Invoke-Scanner([bool]$abort) {",
      "  $sink = [IO.MemoryStream]::new()",
      "  $scrubber = [AgentSecretScrubber]::new([string[]]@($secret), $sink)",
      "  $head = $utf8.GetBytes('safe ' + $secret.Substring(0, 12))",
      "  $scrubber.Write($head, 0, $head.Length)",
      "  $before = $utf8.GetString($sink.ToArray())",
      "  if ($abort) { $scrubber.Abort() }",
      "  $scrubber.Complete()",
      "  $rest = $utf8.GetBytes($secret.Substring(12) + ' later')",
      "  $scrubber.Write($rest, 0, $rest.Length)",
      "  $scrubber.Clear()",
      "  [pscustomobject]@{ before = $before; after = $utf8.GetString($sink.ToArray()) }",
      "}",
      "Add-Type -TypeDefinition @'",
      "using System; using System.IO; using System.Threading; using System.Threading.Tasks;",
      "public sealed class FailAfterFirstRead : Stream {",
      "  readonly byte[] first; bool served;",
      "  public FailAfterFirstRead(byte[] first) { this.first = first; }",
      "  public override int Read(byte[] buffer, int offset, int count) {",
      '    if (served) throw new IOException("synthetic pump failure");',
      "    served = true; Buffer.BlockCopy(first, 0, buffer, offset, first.Length); return first.Length;",
      "  }",
      "  public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) {",
      "    try { return Task.FromResult(Read(buffer, offset, count)); } catch (Exception e) { return Task.FromException<int>(e); }",
      "  }",
      "  public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;",
      "  public override long Length => throw new NotSupportedException();",
      "  public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }",
      "  public override void Flush() { } public override long Seek(long o, SeekOrigin s) => throw new NotSupportedException();",
      "  public override void SetLength(long v) => throw new NotSupportedException();",
      "  public override void Write(byte[] b, int o, int c) => throw new NotSupportedException();",
      "}",
      "'@",
      "$sink = [IO.MemoryStream]::new()",
      "$scrubber = [AgentSecretScrubber]::new([string[]]@($secret), $sink)",
      "$pump = $scrubber.PumpAsync([FailAfterFirstRead]::new($utf8.GetBytes('safe ' + $secret.Substring(0, 12))), [Diagnostics.Process]::new())",
      "try { $pump.Wait() } catch { }",
      "[pscustomobject]@{ aborted = Invoke-Scanner $true; completed = Invoke-Scanner $false; pump = [pscustomobject]@{ faulted = $pump.IsFaulted; after = $utf8.GetString($sink.ToArray()) } } | ConvertTo-Json -Compress",
    ].join("\n");
    const result = runPwsh(["-Command", script], { cwd: seat.root, env: helperEnvironment() });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      aborted: { before: "safe ", after: "safe " },
      completed: { before: "safe ", after: `safe ${secret.slice(0, 12)}` },
      pump: { faulted: true, after: "safe " },
    });
  });
});

describe("with-secrets.ps1 -ListKeys and -Check", { timeout: helperLaunchTimeoutMs }, () => {
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
    ["an entry without a string value", `[{"key":"ALPHA_KEY","value":7,"note":"${valueSentinel}"}]`],
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

  // The fake answers `run` with the 404 that bws 2.1.0 returns for an empty project.
  it.each([
    [
      ["-Check"],
      `OK: account 'lanes' can read project ${projectId} (0 keys).\ntoken expiry not recorded for account 'lanes'\n`,
    ],
    [["-ListKeys"], ""],
  ])("treats a readable project with zero secrets as readable for %j without calling bws run", (args, stdout) => {
    const seat = createSeat({ bws: { list: "[]", runNotFound: true } });
    const result = runSeat(seat, "with-secrets.ps1", args);

    expect(result.status).toBe(0);
    expect(result.stdout.replace(/\r\n/g, "\n")).toBe(stdout);
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret"]);
  });

  it("lets -Command reach bws run against the same empty project and surfaces its 404", () => {
    const seat = createSeat({ bws: { list: "[]", runNotFound: true } });
    const command = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello"]);

    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("404 Not Found");
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret", "run"]);
  });

  it("classifies a profile adapter creation failure without leaking exception text", () => {
    const seat = createSeat({ omitAdapter: true, bws: { list: secretList([`synthetic-key-${randomUUID()}`]) } });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output should-not-run"]);

    expect(result.status).toBe(2);
    expect(unixLines(result.stderr)).toBe("with-secrets: bws-failed\n");
    expect(result.stdout).toBe("");
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret"]);
    expect(result.stderr).not.toContain("profile-free");
    expect(result.stderr).not.toContain("should-not-run");
    expect(readdirSync(os.tmpdir()).filter((name) => name.startsWith("chase-sets-profile-free-")).length).toBe(0);
  });

  it("scrubs an executed-shell 404 and leaves no profile marker", () => {
    const seat = createSeat({
      bws: {
        executeShell: true,
        runNotFound: true,
        list: secretList([`synthetic-key-${randomUUID()}`]),
        segments: [{ stream: "stderr", text: "Error {{TOKEN}}\n" }],
      },
    });
    const marker = path.join(seat.root, `profile-marker-${randomUUID()}`);
    const profile = path.join(privatePwshHome, "profile.ps1");
    expect(existsSync(profile)).toBe(false);
    writeRuntimeProfile(profile, `Set-Content -LiteralPath '${marker}' profile\n`);
    try {
      const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output boundary"]);
      expect(result.status).not.toBe(0);
      expect(unixLines(result.stderr)).toContain("[redacted]");
      expect(result.stderr).not.toContain(seat.token);
      expect(result.stderr).toContain("404 Not Found");
      expect(existsSync(marker)).toBe(false);
      expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret", "run"]);
    } finally {
      removeRuntimeProfile(profile);
      rmSync(marker, { force: true });
    }
  });
});

describe("with-secrets.ps1 refusals", { timeout: helperLaunchTimeoutMs }, () => {
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

  // bw.cmd is a working shim to the same fake, so invoking it would be logged.
  it.each([
    ["an absolute bw.cmd", (seat) => seat.bwShim],
    ["an absolute bws.cmd that does not exist", (seat) => path.join(seat.root, "missing", "bws.cmd")],
  ])("refuses %s as CHASE_SETS_BWS_EXE before reading the credential", (_name, configured) => {
    const seat = createSeat();
    seat.bwShim = path.join(seat.root, "bw.cmd");
    copyFileSync(seat.shim, seat.bwShim);
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello"], {
      CHASE_SETS_BWS_EXE: configured(seat),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bws-failed");
    expect(result.stderr).toContain("an existing bws, bws.exe or bws.cmd");
    expect(credentialCalls(seat)).toEqual([]);
    expect(bwsCalls(seat)).toEqual([]);
  });

  it.each([
    ["a value under 8 characters", "short7!"],
    ["a value outside printable ASCII", "café-sentinel-value"],
    ["a value with a control character", "tab\tsentinel-value"],
  ])("refuses %s as unscrubbable-value before bws run", (_name, value) => {
    const other = `sentinel-value-${randomUUID()}`;
    const seat = createSeat({ bws: { list: secretList([other, value]), stdout: "ran\n" } });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unscrubbable-value");
    expect(result.stdout).toBe("");
    for (const secret of [value, other, seat.token]) expect(result.stderr).not.toContain(secret);
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret"]);
  });

  it("refuses a token it cannot scrub as unscrubbable-value before bws run", () => {
    const seat = createSeat({ token: "short", bws: { stdout: "ran\n" } });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unscrubbable-value");
    expect(result.stdout).toBe("");
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret"]);
  });
});

describe("with-secrets.ps1 agent tier guard", { timeout: helperLaunchTimeoutMs }, () => {
  // Values shaped like the agent tier in the repository inventory.
  const compliant = () => ({
    EASYPOST_API_KEY: `EZTK${randomUUID()}`,
    SEED_PACKS_SPACES_ACCESS_ID: `DO00${randomUUID()}`,
    SEED_PACKS_SPACES_SECRET_KEY: `seed-secret-${randomUUID()}`,
    STRIPE_PUBLISHABLE_KEY: `pk_test_${randomUUID()}`,
    STRIPE_SECRET_KEY: `rk_test_${randomUUID()}`,
  });
  const project = (values) =>
    JSON.stringify(
      Object.entries(values).map(([key, value]) => ({
        id: randomUUID(),
        organizationId: randomUUID(),
        projectId,
        key,
        value,
      })),
    );

  it.each([
    ["inherited", []],
    ["-NoInheritEnv", ["-NoInheritEnv"]],
  ])("runs the command when every key and value is in the repository's agent tier (%s)", (_name, flags) => {
    const seat = createSeat({ inventory: repositoryInventory, bws: { list: project(compliant()), stdout: "ran\n" } });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello", ...flags]);

    expect(unixLines(result.stderr)).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ran\n");
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret", "run"]);
  });

  it.each([
    ["an unlisted key", "SCRYDEX_API_KEY", `sentinel-unlisted-${randomUUID()}`, "not an agent-tier key", []],
    [
      "an sk_live_ sentinel under STRIPE_SECRET_KEY",
      "STRIPE_SECRET_KEY",
      `sk_live_sentinel${randomUUID()}`,
      "value without a test prefix",
      [],
    ],
    [
      "an EZAK sentinel under EASYPOST_API_KEY",
      "EASYPOST_API_KEY",
      `EZAKsentinel${randomUUID()}`,
      "value without a test prefix",
      [],
    ],
    [
      "an sk_live_ sentinel under STRIPE_SECRET_KEY with -NoInheritEnv",
      "STRIPE_SECRET_KEY",
      `sk_live_sentinel${randomUUID()}`,
      "value without a test prefix",
      ["-NoInheritEnv"],
    ],
    [
      "a key differing only in case",
      "stripe_secret_key",
      `sk_test_sentinel${randomUUID()}`,
      "not an agent-tier key",
      [],
    ],
  ])("refuses %s as tier-violation before bws run, naming only the key", (_name, key, sentinel, reason, flags) => {
    const values = { ...compliant(), [key]: sentinel };
    const seat = createSeat({ inventory: repositoryInventory, bws: { list: project(values), stdout: "ran\n" } });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello", ...flags]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(unixLines(result.stderr)).toBe(`with-secrets: tier-violation: ${key} (${reason}); nothing was run\n`);
    for (const value of Object.values(values)) {
      expect(result.stdout).not.toContain(value);
      expect(result.stderr).not.toContain(value);
    }
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret"]);
    expect(filesContaining(seat.root, sentinel, ["fake-bws.json"])).toEqual([]);
  });

  it("names every violating key in ordinal order", () => {
    const values = {
      ...compliant(),
      STRIPE_PUBLISHABLE_KEY: `pk_live_${randomUUID()}`,
      VOYAGE_API_KEY: "pa-voyage-x1",
    };
    const seat = createSeat({ inventory: repositoryInventory, bws: { list: project(values) } });
    const result = runSeat(seat, "with-secrets.ps1", ["-Command", "Write-Output hello"]);

    expect(result.status).not.toBe(0);
    expect(unixLines(result.stderr)).toBe(
      "with-secrets: tier-violation: STRIPE_PUBLISHABLE_KEY (value without a test prefix), VOYAGE_API_KEY (not an agent-tier key); nothing was run\n",
    );
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret"]);
  });

  it("refuses -Check with tier-violation and passes a compliant project", () => {
    const violating = createSeat({
      inventory: repositoryInventory,
      bws: { list: project({ ...compliant(), DIGITALOCEAN_ACCESS_TOKEN: `dop_v1_${randomUUID()}` }) },
    });
    const refused = runSeat(violating, "with-secrets.ps1", ["-Check"]);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toBe("");
    expect(unixLines(refused.stderr)).toBe(
      "with-secrets: tier-violation: DIGITALOCEAN_ACCESS_TOKEN (not an agent-tier key); nothing was run\n",
    );

    const passing = createSeat({ inventory: repositoryInventory, bws: { list: project(compliant()) } });
    const checked = runSeat(passing, "with-secrets.ps1", ["-Check"]);
    expect(checked.status).toBe(0);
    const [ok, expiry, ...rest] = unixLines(checked.stdout).split("\n");
    expect(ok).toBe(`OK: account 'lanes' can read project ${projectId} (5 keys).`);
    expect(expiry).toMatch(/^token expires 2027-01-16 \(-?\d+ days\)$/);
    expect(rest).toEqual([""]);
  });

  it.each([
    ["a missing inventory", null],
    ["an unparseable inventory", '{"schemaVersion": 1, "agentTier": {'],
    ["an inventory without agentTier", JSON.stringify({ schemaVersion: 1, environments: [], secrets: [] })],
    [
      "an agentTier key without testPrefixes",
      JSON.stringify({ agentTier: { project: "chase-sets-agent-dev", keys: [{ name: "KEY_0" }] } }),
    ],
    [
      "a duplicate agentTier key",
      JSON.stringify({
        agentTier: {
          project: "chase-sets-agent-dev",
          keys: [
            { name: "KEY_0", testPrefixes: [] },
            { name: "KEY_0", testPrefixes: ["sk_test_"] },
          ],
        },
      }),
    ],
  ])("refuses -Command and -Check on %s as inventory-unavailable before reading the token", (_name, inventory) => {
    for (const args of [["-Command", "Write-Output hello"], ["-Check"]]) {
      const seat = createSeat({ inventory, bws: { list: secretList(["sentinel-value-inventory"]), stdout: "ran\n" } });
      const result = runSeat(seat, "with-secrets.ps1", args);

      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(unixLines(result.stderr)).toBe(
        "with-secrets: inventory-unavailable: .github/credential-inventory.json beside this checkout is missing, unparseable or has no valid agentTier; nothing was run\n",
      );
      expect(credentialCalls(seat)).toEqual([]);
      expect(bwsCalls(seat)).toEqual([]);
    }
  });

  it("lets -ListKeys print names without an inventory, so a tier violation can be inspected", () => {
    const seat = createSeat({ inventory: null, bws: { list: secretList(["sentinel-value-listkeys"]) } });
    const result = runSeat(seat, "with-secrets.ps1", ["-ListKeys"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("KEY_0");
    expect(bwsCalls(seat).map((call) => call.argv[0])).toEqual(["secret"]);
  });
});

describe("with-secrets.ps1 -Check token expiry (#10034)", { timeout: helperLaunchTimeoutMs }, () => {
  const DAY = 86_400_000;
  const utcToday = () => Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const account = (name, tokenExpiresOn) => ({
    name,
    machineAccount: `chase-sets-${name}`,
    access: "read",
    tokenExpiresOn,
  });
  // The synthetic-tier inventory with the given agentTier.accounts.
  const withAccounts = (accounts) => {
    const value = JSON.parse(syntheticTierInventory);
    return JSON.stringify({ ...value, agentTier: { ...value.agentTier, accounts } });
  };
  const okLine = (name = "lanes") => `OK: account '${name}' can read project ${projectId} (0 keys).`;
  const warning = (name, date, days) =>
    `with-secrets: warning: the token for account '${name}' expires ${date} (${days} days); see Agent token renewal in docs/runbooks/credential-rotation.md\n`;

  // The helper counts from its own UTC day, so a run straddling UTC midnight
  // may report either side of it.
  function runCheck(offset, extraArgs = [], name = "lanes") {
    const date = isoDay(utcToday() + offset * DAY);
    const seat = createSeat({
      inventory: withAccounts([account("lanes", date), account("spare", isoDay(utcToday() + 60 * DAY))]),
      bws: { list: "[]" },
    });
    const before = Math.round((Date.parse(date) - utcToday()) / DAY);
    const result = runSeat(seat, "with-secrets.ps1", ["-Check", ...extraArgs]);
    const after = Math.round((Date.parse(date) - utcToday()) / DAY);
    const [ok, expiry, ...rest] = unixLines(result.stdout).split("\n");
    expect(ok).toBe(okLine(name));
    expect(rest).toEqual([""]);
    const days = Number(/^token expires \d{4}-\d{2}-\d{2} \((-?\d+) days\)$/.exec(expiry)?.[1]);
    expect([before, after]).toContain(days);
    return { result, date, days, expiry };
  }

  it("prints the recorded date and days remaining and warns nothing outside 21 days (AC3)", () => {
    const { result, date, days, expiry } = runCheck(30);
    expect(result.status).toBe(0);
    expect(expiry).toBe(`token expires ${date} (${days} days)`);
    expect(result.stderr).toBe("");
  });

  it.each([
    ["within 21 days", 20],
    ["past the date", -3],
  ])("warns on stderr %s and still exits 0, never refusing on the date alone (AC3)", (_label, offset) => {
    const { result, date, days } = runCheck(offset);
    expect(result.status).toBe(0);
    expect(unixLines(result.stderr)).toBe(warning("lanes", date, days));
  });

  it("reads the -Account's own row", () => {
    const { result, days } = runCheck(60, ["-Account", "spare"], "spare");
    expect(result.status).toBe(0);
    expect(days).toBeGreaterThanOrEqual(59);
    expect(result.stderr).toBe("");
  });

  it.each([
    ["a null tokenExpiresOn", withAccounts([account("lanes", null)])],
    ["no row for the account", withAccounts([account("spare", "2027-01-16")])],
    ["no accounts list", syntheticTierInventory],
    ["a date that is not on the calendar", withAccounts([account("lanes", "2027-02-30")])],
    ["a date without zero padding", withAccounts([account("lanes", "2027-1-16")])],
    ["a non-list accounts value", withAccounts({ lanes: "2027-01-16" })],
  ])("says the expiry is not recorded for %s, without warning or refusing", (_label, inventory) => {
    const seat = createSeat({ inventory, bws: { list: "[]" } });
    const result = runSeat(seat, "with-secrets.ps1", ["-Check"]);

    expect(result.status).toBe(0);
    expect(unixLines(result.stdout)).toBe(`${okLine()}\ntoken expiry not recorded for account 'lanes'\n`);
    expect(result.stderr).toBe("");
  });

  it("prints no expiry when the bws check fails", () => {
    const seat = createSeat({
      inventory: withAccounts([account("lanes", isoDay(utcToday() + 3 * DAY))]),
      bws: { list: "", listExitCode: 1 },
    });
    const result = runSeat(seat, "with-secrets.ps1", ["-Check"]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(unixLines(result.stderr)).toBe("with-secrets: bws-failed: bws secret list exited 1\n");
  });

  it("counts whole UTC days from the given day at the 21-day boundary", () => {
    const seat = createSeat({
      inventory: withAccounts([account("lanes", "2026-11-09"), account("spare", "2026-11-10")]),
    });
    const inventoryPath = path.join(seat.root, "..", "..", ".github", "credential-inventory.json");
    const today = "[DateTime]::new(2026, 10, 19, 0, 0, 0, [DateTimeKind]::Utc)";
    const script = [
      `. '${path.join(seat.root, "with-secrets.ps1")}' -Command unused`,
      ...["lanes", "spare", "absent"].map(
        (name) =>
          `ConvertTo-Json -Compress -InputObject (Get-AgentTokenExpiry -Path '${inventoryPath}' -Account '${name}' -Today (${today}))`,
      ),
    ].join("; ");
    const result = runPwsh(["-Command", script], { cwd: seat.root, env: helperEnvironment() });

    expect(result.status).toBe(0);
    expect(
      unixLines(result.stdout)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ Date: "2026-11-09", Days: 21 }, { Date: "2026-11-10", Days: 22 }, null]);
    expect(bwsCalls(seat)).toEqual([]);
    expect(credentialCalls(seat)).toEqual([]);
  });
});

describe("set-bitwarden-agent-token.ps1", { timeout: helperLaunchTimeoutMs }, () => {
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

describe.skipIf(!isWindows)("bitwarden-agent-credential.psm1 on Windows", { timeout: helperLaunchTimeoutMs }, () => {
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
    expect(agents).toContain("never write injected values to a file");
    expect(agents).toContain("(docs/runbooks/credential-rotation.md#agent-tier)");
    expect(readFileSync(path.join(repoRoot, "docs", "runbooks", "credential-rotation.md"), "utf8")).toContain(
      "\n## Agent Tier\n",
    );
    expect(agents).not.toContain(["orchestrator", "with-secrets"].join("/"));
    for (const [named] of agents.matchAll(/scripts\/agent-secrets\/[\w.-]+\.ps1/g)) {
      expect(existsSync(path.join(repoRoot, named))).toBe(true);
    }
  });
});
