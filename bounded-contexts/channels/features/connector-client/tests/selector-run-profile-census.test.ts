import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Software-only evidence for #9628 AC1/AC2. Every native primitive below the census law is
// synthetic; the collector, job and actual-host witness (AC3/AC4) belong to the host verifier.
const script = fileURLToPath(new URL("./selector-run-profile-census.ps1", import.meta.url));
const driver = fileURLToPath(new URL("./selector-run-profile-census-witness.mjs", import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "selector-run-profile-census-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const LOCAL = "C:\\Users\\synthetic\\AppData\\Local";
const USER_DATA = `${LOCAL}\\Google\\Chrome\\User Data`;
const ROOT = "C:\\Users\\synthetic\\scratch\\selector-witness-synthetic";
const PROFILE = `${ROOT}\\profile`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SELF = { pid: 9000, parentPid: 1, name: "pwsh.exe", executable: "C:\\pwsh\\pwsh.exe", created: 90 };
const SELF_ROW = { ...SELF, argv: ["pwsh", "-NoProfile", "-File", "C:\\seat\\census.ps1", "-Action", "witness"] };
const CHROME_ROOT = { pid: 5000, parentPid: 1, name: "chrome.exe", executable: CHROME, created: 50, argv: [CHROME] };
const CHROME_CHILD = {
  pid: 5001,
  parentPid: 5000,
  name: "chrome.exe",
  executable: CHROME,
  created: 51,
  argv: [CHROME, "--type=renderer", "--field-trial-handle=1,i,2", "/prefetch:1"],
};
const GRANTED = { state: "GRANTED", job: "J1", limits: "0x0/0x0", driver: { pid: 700, created: 70 } };
const MEMBER = { inJob: true, alive: true };

type Spec = Record<string, unknown>;
type Case = { name: string; kind: string; expect?: string; [key: string]: unknown };

function fs(extra: Record<string, unknown> = {}, omit: string[] = []) {
  const base: Record<string, unknown> = {
    [USER_DATA]: "dir",
    [`${USER_DATA}\\Default`]: "dir",
    [PROFILE]: "dir",
    [`${PROFILE}\\Default`]: "dir",
    [`${PROFILE}\\Default\\Cookies`]: "file",
    [`${ROOT}\\PROFIL~1`]: { short: PROFILE },
    [`${ROOT}\\profile-backup`]: "dir",
    [`${ROOT}\\other`]: "dir",
    "C:\\links\\into": { link: PROFILE },
    "C:\\links\\elsewhere": { link: "C:\\Users\\synthetic" },
    "C:\\links\\userdata": { link: USER_DATA },
    "C:\\links\\loop": { loop: true },
    "C:\\links\\dangling": { link: `${PROFILE}\\missing-target` },
    "C:\\gate\\alias": { link: PROFILE, deny: true },
    ...extra,
  };
  for (const key of omit) delete base[key];
  return base;
}

function native(overrides: Spec = {}): Spec {
  return {
    self: SELF,
    localAppData: LOCAL,
    localNames: ["localhost", "127.0.0.1", "SYNTHETIC-HOST"],
    fixed: ["C", "S"],
    substs: { "S:": ROOT },
    fs: fs(),
    processes: [SELF_ROW, CHROME_ROOT, CHROME_CHILD],
    holders: {},
    ...overrides,
  };
}

function census(name: string, expected: string, overrides: Spec = {}, extra: Spec = {}): Case {
  return {
    name,
    kind: "census",
    root: ROOT,
    run: null,
    admitted: null,
    native: native(overrides),
    expect: expected,
    ...extra,
  };
}

const tool = (pid: number, ...argv: string[]) => ({
  pid,
  parentPid: 1,
  name: "node.exe",
  executable: "C:\\node\\node.exe",
  created: pid,
  argv: ["node", ...argv],
});
const chrome = (pid: number, ...argv: string[]) => ({
  pid,
  parentPid: 1,
  name: "chrome.exe",
  executable: CHROME,
  created: pid,
  argv: [CHROME, ...argv],
});
const withProcesses = (...rows: unknown[]) => ({ processes: [SELF_ROW, CHROME_ROOT, CHROME_CHILD, ...rows] });

const ALIASES: Array<[string, string[]]> = [
  ["slash separators", [PROFILE.replaceAll("\\", "/")]],
  ["case variant", [`${PROFILE.toUpperCase()}\\DEFAULT`]],
  ["split user-data-dir switch", ["--user-data-dir", PROFILE]],
  ["split user-data-dir ancestor with profile-directory", ["--USER-DATA-DIR", ROOT, "--profile-directory=profile"]],
  ["user-data-dir equals root", [`--user-data-dir=${ROOT}`]],
  ["8.3 short name", [`${ROOT}\\PROFIL~1\\Default`]],
  ["localhost admin share", [`\\\\localhost\\C$${PROFILE.slice(2)}`]],
  ["host-name admin share", [`\\\\synthetic-host\\c$${PROFILE.slice(2)}\\Default`]],
  ["win32 device prefix", [`\\\\?\\${PROFILE}`]],
  ["dos device prefix", [`\\\\.\\${PROFILE}`]],
  ["device UNC admin share", [`\\\\?\\UNC\\127.0.0.1\\C$${PROFILE.slice(2)}`]],
  ["subst drive", ["S:\\profile\\Default"]],
  ["quoted token", [`"${PROFILE}"`]],
  ["trailing separator", [`${PROFILE}\\`]],
  ["trailing dot", [`${PROFILE}.`]],
  ["repeated separators", [PROFILE.replace("\\profile", "\\\\profile")]],
  ["dot-dot through sibling", [`${ROOT}\\profile-backup\\..\\profile`]],
  ["double-dash switch value", [`--disk-cache-dir=${PROFILE}\\Cache`]],
  ["single-dash switch value", [`-log=${PROFILE}\\log.txt`]],
  ["slash switch value", [`/out=${PROFILE}`]],
  ["junction into profile", ["C:\\links\\into\\Default"]],
];

const NOT_REFERENCES: Array<[string, string[]]> = [
  ["lone profile-backup sibling", [`${ROOT}\\profile-backup`]],
  ["non-user-data-dir root ancestor", [ROOT]],
  ["non-user-data-dir switch ancestor", [`--disk-cache-dir=${ROOT}`, "C:\\Users\\synthetic"]],
  ["resolved unrelated junction", ["C:\\links\\elsewhere\\scratch-not-here"]],
  ["relative path", ["profile", ".\\profile"]],
  ["environment variable", ["%LOCALAPPDATA%\\..\\scratch\\selector-witness-synthetic\\profile"]],
  ["file URI", [`file:///${PROFILE.replaceAll("\\", "/")}`]],
  ["non-fixed drive stays lexical", ["Z:\\profile"]],
  ["named pipe device", ["\\\\.\\pipe\\selector-synthetic"]],
];

function lawCases(): Case[] {
  const job = (pids: number[], open: Record<string, unknown>, limits = "0x0/0x0") => ({ job: { limits, pids, open } });
  return [
    census("L0 pre-launch switchless Chrome is DEFAULT and the census is CLEAR", "CLEAR"),
    census("L1 root equal to default User Data", "ROOT_CONFLICT", {}, { root: USER_DATA }),
    census("L1 nonexistent root inside default User Data", "ROOT_CONFLICT", {}, { root: `${USER_DATA}\\selector-new` }),
    census(
      "L1 case-variant root inside Chrome SxS User Data",
      "ROOT_CONFLICT",
      {},
      {
        root: `${LOCAL}\\GOOGLE\\CHROME SXS\\USER DATA\\x`,
      },
    ),
    census("L1 root ancestor of Chromium User Data", "ROOT_CONFLICT", {}, { root: LOCAL }),
    census("L1 root through a junction into User Data", "ROOT_CONFLICT", {}, { root: "C:\\links\\userdata\\x" }),
    census("L1 relative root refused", "CENSUS_INCOMPLETE", {}, { root: "scratch\\selector-witness-synthetic" }),
    census("L2 process enumeration failure", "CENSUS_INCOMPLETE", { processesThrow: true }),
    census("L2 vanished profile entry", "CENSUS_INCOMPLETE", { vanished: [`${PROFILE}\\Default\\Cookies`] }),
    census("L2 directory listing failure", "CENSUS_INCOMPLETE", { listThrow: [`${PROFILE}\\Default`] }),
    census("L2 more than 20000 profile entries", "CENSUS_INCOMPLETE", {
      bulk: { dir: `${PROFILE}\\Default`, count: 19998 },
    }),
    census("L2 exactly 20000 profile entries", "CLEAR", { bulk: { dir: `${PROFILE}\\Default`, count: 19997 } }),
    census("L2 collection timeout", "CENSUS_INCOMPLETE", { clockStepMs: 200000 }),
    census("L2 root resolution past the deadline", "CENSUS_INCOMPLETE", { slow: { path: ROOT, ms: 121000 } }),
    census("L2 reference resolution past the deadline", "CENSUS_INCOMPLETE", {
      ...withProcesses(tool(800, "C:\\slow\\reference")),
      slow: { path: "C:\\slow\\reference", ms: 121000 },
    }),
    census("L2 absent profile is zero entries", "CLEAR", {
      fs: fs({}, [PROFILE, `${PROFILE}\\Default`, `${PROFILE}\\Default\\Cookies`, `${ROOT}\\PROFIL~1`]),
    }),
    census(
      "L3 launched run whose job handle fails",
      "RUN_TRACKING_INCOMPLETE",
      { job: { limitsThrow: true } },
      { run: GRANTED },
    ),
    census("L3 launched run without a job", "RUN_TRACKING_INCOMPLETE", {}, { run: { ...GRANTED, job: null } }),
    census("L3 changed job limits", "RUN_TRACKING_INCOMPLETE", job([], {}, "0x2000/0x0"), { run: GRANTED }),
    census(
      "L3 member query failure",
      "RUN_TRACKING_INCOMPLETE",
      { job: { limits: "0x0/0x0", pids: [710], openDenied: [710] } },
      {
        run: GRANTED,
      },
    ),
    census("L3 ungranted driver alive", "RUN_TRACKING_INCOMPLETE", job([700], { 700: { ...MEMBER, created: 70 } }), {
      run: { ...GRANTED, state: "PENDING" },
    }),
    // The PID list held only 701, which created 702 and exited before its handle was opened.
    census(
      "L3 member born behind the job PID list as its parent exits",
      "RUN_TRACKING_INCOMPLETE",
      {
        ...job([701], { 701: "vanished", 702: { ...MEMBER, created: 72 } }),
        ...withProcesses({ ...chrome(702, "--type=renderer"), parentPid: 701, created: 72 }),
      },
      { run: GRANTED },
    ),
    census(
      "L3 job accounting failure with no listed member",
      "RUN_TRACKING_INCOMPLETE",
      { job: { limits: "0x0/0x0", pids: [], open: {}, activeThrow: true } },
      { run: GRANTED },
    ),
    census(
      "L4 switchless grandchild after intermediate and driver exit is RUN",
      "RUN_TREE_ALIVE",
      {
        ...job([702], { 702: { ...MEMBER, created: 72 } }),
        ...withProcesses({ ...chrome(702), parentPid: 701, created: 72 }),
      },
      { run: GRANTED },
    ),
    census(
      "L4 reused PID non-member is not RUN",
      "CLEAR",
      { ...job([703], { 703: { inJob: false, alive: true, created: 703 } }), ...withProcesses(chrome(703)) },
      { run: GRANTED },
    ),
    census("L4 vanished job member is ignored", "CLEAR", job([704], { 704: "vanished" }), { run: GRANTED }),
    census(
      "L4 admitted member with another creation time",
      "RUN_IDENTITY_MISMATCH",
      {
        ...job([710], { 710: { ...MEMBER, created: 71 } }),
        ...withProcesses({ ...chrome(710, `--user-data-dir=${PROFILE}`), created: 71 }),
      },
      { run: GRANTED, admitted: { pid: 710, created: 72 } },
    ),
    census(
      "L4 admitted PID names a live non-member",
      "RUN_IDENTITY_MISMATCH",
      { ...job([710], { 710: { ...MEMBER, created: 71 } }), ...withProcesses(tool(720)) },
      { run: GRANTED, admitted: { pid: 720, created: 720 } },
    ),
    census(
      "L4 live members with exited admitted browser",
      "RUN_TREE_ALIVE",
      job([710], { 710: { ...MEMBER, created: 71 } }),
      { run: GRANTED, admitted: { pid: 711, created: 711 } },
    ),
    census(
      "L4 empty job ignores a reused admitted PID",
      "CLEAR",
      { ...job([], {}), ...withProcesses(chrome(720)) },
      {
        run: GRANTED,
        admitted: { pid: 720, created: 1 },
      },
    ),
    census(
      "L4 run tree precedes a profile reference",
      "RUN_TREE_ALIVE",
      { ...job([710], { 710: { ...MEMBER, created: 71 } }), ...withProcesses(tool(800, PROFILE)) },
      { run: GRANTED },
    ),
    ...ALIASES.map(([name, argv]) =>
      census(`L5 alias blocks: ${name}`, "RUN_PROFILE_REFERENCED", withProcesses(tool(800, ...argv))),
    ),
    census("L5 case-variant tail before the profile exists", "RUN_PROFILE_REFERENCED", {
      fs: fs({}, [PROFILE, `${PROFILE}\\Default`, `${PROFILE}\\Default\\Cookies`, `${ROOT}\\PROFIL~1`]),
      ...withProcesses(tool(800, `${ROOT}\\PROFILE`)),
    }),
    census(
      "L5 user-data-dir switch is case-insensitive",
      "RUN_PROFILE_REFERENCED",
      withProcesses(tool(800, `/User-Data-Dir=${ROOT}`)),
    ),
    ...NOT_REFERENCES.map(([name, argv]) =>
      census(`L5 not a reference: ${name}`, "CLEAR", withProcesses(tool(800, ...argv))),
    ),
    census(
      "L5 denied lexically unrelated alias is UNRESOLVED",
      "REFERENCE_UNRESOLVED",
      withProcesses(tool(800, "C:\\gate\\alias")),
    ),
    census("L5 reparse loop is UNRESOLVED", "REFERENCE_UNRESOLVED", withProcesses(tool(800, "C:\\links\\loop\\x"))),
    census(
      "L5 existing dangling junction is UNRESOLVED",
      "REFERENCE_UNRESOLVED",
      withProcesses(tool(800, "C:\\links\\dangling")),
    ),
    census(
      "L5 volume GUID device path is UNRESOLVED",
      "REFERENCE_UNRESOLVED",
      withProcesses(tool(800, "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\x")),
    ),
    census(
      "L5 reference precedes unresolved",
      "RUN_PROFILE_REFERENCED",
      withProcesses(tool(800, "C:\\gate\\alias"), tool(801, PROFILE)),
    ),
    census("L6 non-run file holder", "RUN_PROFILE_HELD", { holders: { [`${PROFILE}\\Default\\Cookies`]: [8100] } }),
    census("L6 non-run directory holder", "RUN_PROFILE_HELD", { holders: { [`${PROFILE}\\Default`]: [8100] } }),
    census("L6 profile directory holder", "RUN_PROFILE_HELD", { holders: { [PROFILE]: [8100] } }),
    census("L6 census process holder is excluded by PID", "CLEAR", {
      holders: { [`${PROFILE}\\Default`]: [SELF.pid] },
    }),
    census("L6 same-name non-run holder is HELD", "RUN_PROFILE_HELD", {
      holders: { [`${PROFILE}\\Default`]: [SELF.pid, 9100] },
      ...withProcesses({ ...SELF_ROW, pid: 9100, created: 91 }),
    }),
    census("L6 holder precedes Chrome classification", "RUN_PROFILE_HELD", {
      holders: { [PROFILE]: [8100] },
      ...withProcesses({ ...chrome(810), argv: null }),
    }),
    census("L7 switchless Chrome root is DEFAULT and never blocks", "CLEAR", withProcesses(chrome(810))),
    census("L7 unreadable Chrome command line", "CHROME_UNREADABLE", withProcesses({ ...chrome(810), argv: null })),
    census("L7 unreadable Chrome creation", "CHROME_UNREADABLE", withProcesses({ ...chrome(810), created: null })),
    census("L7 unreadable Chrome executable", "CHROME_UNREADABLE", withProcesses({ ...chrome(810), executable: null })),
    census(
      "L7 Chromium missing user-data-dir value",
      "CHROME_AMBIGUOUS",
      withProcesses({ ...chrome(810, "--user-data-dir="), name: "chromium.exe" }),
    ),
    census(
      "L7 bare user-data-dir switch",
      "CHROME_AMBIGUOUS",
      withProcesses(chrome(810, "--user-data-dir", "C:\\elsewhere")),
    ),
    census(
      "L7 multiple user-data-dir values",
      "CHROME_AMBIGUOUS",
      withProcesses(chrome(810, "--user-data-dir=C:\\a", "-user-data-dir=C:\\b")),
    ),
    census("L7 relative user-data-dir", "CHROME_AMBIGUOUS", withProcesses(chrome(810, "--user-data-dir=profile"))),
    census(
      "L7 user-data-dir inside the root outside the profile",
      "ROOT_CONFLICT",
      withProcesses(chrome(810, `--user-data-dir=${ROOT}\\other`)),
    ),
    census(
      "L7 other user-data-dir is OTHER and never blocks",
      "CLEAR",
      withProcesses(chrome(810, "--user-data-dir=C:\\Users\\synthetic\\elsewhere")),
    ),
    census("L7 unreadable non-Chrome is counted, never blocking", "CLEAR", withProcesses({ ...tool(820), argv: null })),
  ];
}

const START = {
  limits: "0x0/0x0",
  limitsAfter: "0x0/0x0",
  createError: 0,
  inJob: true,
  created: 70,
  writeOk: true,
  exits: true,
  active: 0,
};
const start = (name: string, expected: string, overrides: Spec = {}): Case => ({
  name,
  kind: "start",
  native: native({ start: { ...START, ...overrides } }),
  expect: expected,
});

function startCases(): Case[] {
  return [
    start("start grants only after membership, unchanged limits and PID+start", "GRANTED"),
    start("start refuses a job with breakaway limits before creating a child", "REFUSED", { limits: "0x800/0x0" }),
    start("start refuses a job with UI limits before creating a child", "REFUSED", { limits: "0x0/0x1" }),
    start("start refuses a failed create (bad job handle) with no child", "REFUSED", { createError: 6 }),
    start("start refuses an absent driver with no child", "REFUSED", { createError: 2 }),
    start("start withholds the grant from a non-member driver", "REFUSED", { inJob: false }),
    start("start withholds the grant after a limit change", "REFUSED", { limitsAfter: "0x1000/0x0" }),
    start("start withholds the grant without a readable start time", "REFUSED", { created: null }),
    start("start withholds after a failed grant write", "REFUSED", { writeOk: false }),
    start("start closes the grant pipe after a thrown grant write", "REFUSED", { writeOk: "throw" }),
    start("start keeps a thrown grant write PENDING until the driver exits", "PENDING", {
      writeOk: "throw",
      exits: false,
    }),
    start("start keeps an unexited ungranted driver PENDING", "PENDING", { inJob: false, exits: false }),
    start("start keeps a withheld run with live members PENDING", "PENDING", { inJob: false, active: 1 }),
    start("start keeps an owner failure after creation PENDING", "PENDING", { inJob: "throw", exits: "throw" }),
  ];
}

const DEFAULT_ONLY = [SELF_ROW, CHROME_ROOT, CHROME_CHILD];
const RUN_ROWS = [
  {
    pid: 700,
    parentPid: SELF.pid,
    name: "node.exe",
    executable: "C:\\node\\node.exe",
    created: 70,
    argv: ["node", "C:\\seat\\witness.mjs"],
  },
  { ...chrome(710, `--user-data-dir=${PROFILE}`), parentPid: 700, created: 71 },
  { ...chrome(711, "--type=renderer"), parentPid: 710, created: 72 },
];
const RUN_JOB = {
  limits: "0x0/0x0",
  pids: [700, 710, 711],
  open: { 700: { ...MEMBER, created: 70 }, 710: { ...MEMBER, created: 71 }, 711: { ...MEMBER, created: 72 } },
};
const EMPTY_JOB = { limits: "0x0/0x0", pids: [], open: {} };
const NO_PROFILE = fs({}, [PROFILE, `${PROFILE}\\Default`, `${PROFILE}\\Default\\Cookies`, `${ROOT}\\PROFIL~1`]);
const PHASES = [
  { processes: DEFAULT_ONLY, job: EMPTY_JOB, fs: NO_PROFILE },
  { processes: [...DEFAULT_ONLY, ...RUN_ROWS], job: RUN_JOB, holders: { [PROFILE]: [710] } },
  { processes: DEFAULT_ONLY, job: EMPTY_JOB },
  { processes: DEFAULT_ONLY, job: EMPTY_JOB, fs: NO_PROFILE },
];
const BROWSER_LINE = JSON.stringify({ event: "browser", pid: 710, chromium: "a".repeat(64) });
const witness = (name: string, expected: string, overrides: Spec = {}, root = ROOT): Case => ({
  name,
  kind: "witness",
  root,
  native: native({
    start: START,
    witness: {
      exists: [false, false],
      line: BROWSER_LINE,
      admitted: { pid: 710, created: 71 },
      empties: true,
      ...(overrides.witness as Spec),
    },
    phases: (overrides.phases as unknown[]) ?? PHASES,
  }),
  expect: expected,
});

function witnessCases(): Case[] {
  const phase = (index: number, value: Spec) =>
    PHASES.map((entry, i) => (i === index ? { ...entry, ...value } : entry));
  return [
    witness("witness passes only through W1 CLEAR, W2 TREE_ALIVE, W3 CLEAR, gated deletion and W4", "PASS"),
    witness(
      "witness refuses a root in default User Data before any creation or deletion",
      "REFUSED",
      {},
      `${USER_DATA}\\selector-witness-x`,
    ),
    witness("witness refuses an existing scratch root", "REFUSED", { witness: { exists: [true] } }),
    witness("witness is NOT_EXERCISED without a switchless Chrome root", "NOT_EXERCISED", {
      phases: phase(0, { processes: [SELF_ROW, CHROME_CHILD] }),
    }),
    witness("witness keeps PENDING and never deletes when the job does not empty", "PENDING", {
      witness: { empties: false },
    }),
    witness("witness never deletes after a W3 holder", "FAIL", {
      phases: phase(2, { holders: { [PROFILE]: [8100] } }),
    }),
    witness("witness fails a W2 run tree with fewer than three members", "FAIL", {
      phases: phase(1, { job: { ...RUN_JOB, pids: [700, 710] } }),
    }),
    witness("witness is INVALID when the default Chrome roots changed", "INVALID", {
      phases: phase(2, { processes: [SELF_ROW, { ...CHROME_ROOT, created: 55 }, CHROME_CHILD] }),
    }),
    witness("witness is INVALID when a W3 default-root removal is restored by W4", "INVALID", {
      phases: phase(2, { processes: [SELF_ROW, CHROME_CHILD] }),
    }),
    witness("witness is INVALID when a default Chrome root restarts between W3 and W4", "INVALID", {
      phases: phase(3, { processes: [SELF_ROW, { ...CHROME_ROOT, created: 999 }, CHROME_CHILD] }),
    }),
    witness("witness is INVALID when the default Chrome root is gone at W4", "INVALID", {
      phases: phase(3, { processes: [SELF_ROW, CHROME_CHILD] }),
    }),
    witness("witness is INVALID when a default Chrome root is added at W4", "INVALID", {
      phases: phase(3, { processes: [...DEFAULT_ONLY, chrome(5100)] }),
    }),
    witness("witness fails without a browser event and still closes normally", "FAIL", { witness: { line: null } }),
    witness("witness fails when scratch is still present after deletion", "FAIL", {
      witness: { exists: [false, true] },
    }),
  ];
}

const HARNESS = String.raw`
$ErrorActionPreference = 'Stop'
. $env:SELECTOR_CENSUS_SCRIPT
function Add-SyntheticAncestors($Map) {
  foreach ($path in @($Map.Values | ForEach-Object { $_.path })) {
    for ($parent = $path.Substring(0, [Math]::Max(2, $path.LastIndexOf('\'))); $parent.Length -gt 2; $parent = $parent.Substring(0, [Math]::Max(2, $parent.LastIndexOf('\')))) {
      if (-not $Map.ContainsKey($parent.ToLowerInvariant())) { $Map[$parent.ToLowerInvariant()] = @{ kind = 'dir'; path = $parent } }
    }
  }
}
function Set-SyntheticPhase($Spec) {
  $script:fs = @{}
  foreach ($key in $Spec.fs.Keys) {
    $value = $Spec.fs[$key]
    $entry = if ($value -is [string]) { @{ kind = $value } } else { @{} + $value }
    $entry.path = $key
    $script:fs[$key.ToLowerInvariant()] = $entry
  }
  Add-SyntheticAncestors $script:fs
  $script:holders = @{}
  foreach ($key in $Spec.holders.Keys) { $script:holders[$key.ToLowerInvariant()] = @($Spec.holders[$key]) }
  $script:current = $Spec
}
function Invoke-SyntheticOpen([string]$Path, [bool]$Follow, [int]$Depth) {
  if ($Depth -gt 8) { return @{ Code = 1921 } }
  if ($Path -notmatch '^([A-Za-z]):(\\.*)?$') { return @{ Code = 123 } }
  $drive = $Matches[1].ToUpperInvariant() + ':'
  $parts = @(([string]$Matches[2]).Split('\') | Where-Object { $_ })
  $current = if ($script:current.substs -and $script:current.substs[$drive]) { $script:current.substs[$drive] } else { $drive }
  $last = $null
  for ($i = 0; $i -lt $parts.Count; $i++) {
    $final = $i -eq $parts.Count - 1
    $last = $script:fs[($current + '\' + $parts[$i]).ToLowerInvariant()]
    if (-not $last) { return @{ Code = $(if ($final) { 2 } else { 3 }) } }
    if ($last.deny) { return @{ Code = 5 } }
    if ($last.short) { $current = $last.short; $last = $script:fs[$current.ToLowerInvariant()]; continue }
    if (($last.link -or $last.loop) -and (-not $final -or $Follow)) {
      if ($last.loop) { return @{ Code = 1921 } }
      $target = Invoke-SyntheticOpen $last.link $true ($Depth + 1)
      if ($target.Code -ne 0) { return @{ Code = 3 } }
      $current = $target.Final.Substring(4).TrimEnd('\')
      $last = $script:fs[$current.ToLowerInvariant()]
      continue
    }
    $current = $last.path
  }
  $directory = (-not $last) -or $last.kind -ceq 'dir' -or [bool]$last.link -or [bool]$last.loop
  $reparse = $last -and ([bool]$last.link -or [bool]$last.loop)
  return @{ Code = 0; Final = '\\?\' + $current + $(if ($current.Length -eq 2) { '\' } else { '' }); Directory = $directory; Reparse = $reparse }
}
function New-SyntheticNative($Spec) {
  $script:spec = $Spec
  $script:calls = [Collections.Generic.List[string]]::new()
  $script:phase = -1
  $script:clock = [DateTime]::new(2026, 10, 14, 12, 0, 0, [DateTimeKind]::Utc)
  $script:exists = [Collections.Generic.Queue[object]]::new()
  foreach ($value in @($Spec.witness.exists)) { $script:exists.Enqueue($value) }
  Set-SyntheticPhase $Spec
  return @{
    Now = { $script:clock = $script:clock.AddMilliseconds([double]($script:current.clockStepMs ?? 1)); $script:clock }
    Self = {
      $script:calls.Add('Self')
      if ($script:spec.phases) {
        $script:phase++
        $merged = @{}
        foreach ($source in @($script:spec, $script:spec.phases[$script:phase])) { foreach ($key in $source.Keys) { $merged[$key] = $source[$key] } }
        Set-SyntheticPhase $merged
      }
      @{ pid = [long]$script:current.self.pid; created = [long]$script:current.self.created }
    }
    LocalAppData = { $script:current.localAppData }
    LocalNames = { $script:current.localNames }
    Processes = {
      if ($script:current.processesThrow) { throw 'synthetic enumeration failure' }
      foreach ($row in $script:current.processes) { @{} + $row }
    }
    DriveFixed = { param($Drive) $Drive -in $script:current.fixed }
    Open = {
      param($Path, $Follow)
      if ($script:current.slow -and $script:current.slow.path -ceq $Path) { $script:clock = $script:clock.AddMilliseconds([double]$script:current.slow.ms) }
      Invoke-SyntheticOpen $Path $Follow 0
    }
    Entry = { param($Path) Invoke-SyntheticOpen $Path $false 0 }
    List = {
      param($Directory)
      if ($script:current.listThrow -contains $Directory) { throw 'synthetic list failure' }
      $prefix = $Directory.ToLowerInvariant() + '\'
      foreach ($entry in $script:fs.Values) {
        $key = $entry.path.ToLowerInvariant()
        if ($key.StartsWith($prefix) -and $key.IndexOf('\', $prefix.Length) -lt 0) {
          @{ path = $entry.path; directory = $entry.kind -ceq 'dir' -or [bool]$entry.link; reparse = [bool]$entry.link -or [bool]$entry.loop }
        }
      }
      if ($script:current.bulk -and $script:current.bulk.dir -ceq $Directory) {
        for ($i = 0; $i -lt $script:current.bulk.count; $i++) { @{ path = "$Directory\bulk-$i"; directory = $false; reparse = $false } }
      }
    }
    Holders = {
      param($Path)
      if ($script:current.vanished -contains $Path) { throw 'synthetic vanished entry' }
      if ($script:holders.ContainsKey($Path.ToLowerInvariant())) { $script:holders[$Path.ToLowerInvariant()] }
    }
    JobLimits = {
      param($Job)
      $script:calls.Add('JobLimits')
      if ($script:current.start) {
        $script:limitReads = 1 + [int]$script:limitReads
        if ($script:limitReads -eq 1) { return $script:current.start.limits } else { return $script:current.start.limitsAfter }
      }
      if ($script:current.job.limitsThrow) { throw 'synthetic invalid job handle' }
      $script:current.job.limits
    }
    JobPids = { param($Job) foreach ($id in $script:current.job.pids) { [long]$id } }
    OpenMember = {
      param($Id, $Job)
      if ($script:current.job.openDenied -contains $Id) { throw 'synthetic access denied' }
      $value = $script:current.job.open["$Id"]
      if ($value -ceq 'vanished') { return $null }
      @{ Pid = [long]$Id; Created = [long]$value.created; InJob = [bool]$value.inJob; Alive = [bool]$value.alive }
    }
    NewJob = { $script:calls.Add('NewJob'); 'J1' }
    StartDriver = {
      param($Job, $Driver)
      $script:calls.Add('StartDriver')
      if ($script:current.start.createError) { return @{ Error = [int]$script:current.start.createError } }
      @{ Error = 0; Pid = 700; Process = 'P'; Stdin = 'I'; Stdout = 'O' }
    }
    InJob = { param($Process, $Job) $script:calls.Add('InJob'); if ("$($script:current.start.inJob)" -ceq 'throw') { throw 'synthetic' }; [bool]$script:current.start.inJob }
    Created = { param($Process) $script:calls.Add('Created'); if ($null -eq $script:current.start.created) { throw 'synthetic' }; [long]$script:current.start.created }
    WriteLine = {
      param($Writer, $Line)
      if ("$($script:current.start.writeOk)" -ceq 'throw') { throw 'synthetic pipe write failure' }
      $script:calls.Add('Grant:' + $Line); [bool]$script:current.start.writeOk
    }
    CloseWriter = { param($Writer) $script:calls.Add('CloseWriter') }
    WaitExit = { param($Process, $Ms) $script:calls.Add('WaitExit'); if ("$($script:current.start.exits)" -ceq 'throw') { throw 'synthetic' }; [bool]$script:current.start.exits }
    JobActive = {
      param($Job)
      $script:calls.Add('JobActive')
      if ($script:current.job.activeThrow) { throw 'synthetic job accounting failure' }
      if ($null -ne $script:current.job.active) { return [int]$script:current.job.active }
      # The job's own count: every live in-job process, listed or not.
      if ($script:current.job) { return @($script:current.job.open.Values | Where-Object { $_ -isnot [string] -and $_.inJob -and $_.alive }).Count }
      [int]$script:current.start.active
    }
    WitnessDriver = { 'C:\seat\selector-run-profile-census-witness.mjs' }
    ScriptSha256 = { 'b' * 64 }
    DriverSha256 = { 'c' * 64 }
    Exists = { param($Path) $script:calls.Add('Exists'); if ($script:exists.Count) { $script:exists.Dequeue() } else { $false } }
    CreateRoot = { param($Path) $script:calls.Add('CreateRoot') }
    RemoveScratch = { param($Path) $script:calls.Add('RemoveScratch') }
    ReadLine = { param($Run, $Ms) $script:calls.Add('ReadLine'); $script:spec.witness.line }
    AdmitBrowser = { param($Run, $Id) $script:calls.Add('AdmitBrowser'); @{ pid = [long]$script:spec.witness.admitted.pid; created = [long]$script:spec.witness.admitted.created } }
    ReleaseRun = { param($Run) $script:calls.Add('ReleaseRun') }
    WaitEmpty = { param($Run, $Ms) $script:calls.Add('WaitEmpty'); [bool]$script:spec.witness.empties }
  }
}
$cases = Get-Content -Raw -LiteralPath $env:SELECTOR_CENSUS_CASES | ConvertFrom-Json -AsHashtable
$results = [ordered]@{}
foreach ($case in $cases) {
  try {
    $script:limitReads = 0
    $native = New-SyntheticNative $case.native
    $startCalls = $null
    $value = switch ($case.kind) {
      'census' { Get-SelectorRunProfileCensus -Root $case.root -Run $case.run -Admitted $case.admitted -Native $native }
      'start' {
        $run = Start-SelectorRunOwned -Driver 'C:\seat\selector-run-profile-census-witness.mjs' -Payload @{ profile = 'C:\seat\run\profile' } -Native $native
        $startCalls = $script:calls.ToArray()
        $after = Get-SelectorRunProfileCensus -Root 'C:\Users\synthetic\scratch\selector-witness-synthetic' -Run $run -Native $native
        [ordered]@{ state = $run.state; code = $run.code; censusAfter = $after.code }
      }
      'witness' { Invoke-SelectorRunProfileWitness -Root $case.root -Native $native }
      'admission' { try { Read-SelectorWitnessAdmission $case.text } catch { 'REFUSED' } }
    }
    $results[$case.name] = [ordered]@{ value = $value; calls = @(if ($null -ne $startCalls) { $startCalls } else { $script:calls.ToArray() }) }
  } catch {
    $results[$case.name] = [ordered]@{ value = "HARNESS_ERROR: $($_.Exception.Message) $($_.InvocationInfo.PositionMessage)"; calls = @() }
  }
}
$results | ConvertTo-Json -Depth 12 -Compress
`;

type Census = {
  format: string;
  complete: boolean;
  verdict: string;
  code: string;
  counts: Record<string, number | null>;
  at: string;
  defaultRootDigest: string | null;
};
type Witness = {
  verdict: string;
  code: string;
  d0: string | null;
  d1: string | null;
  w1: Census | null;
  w2: Census | null;
  w3: Census | null;
  w4: Census | null;
  scratchDeleted: boolean;
  scratchAbsent: boolean;
};
const WITNESS_KEYS = [
  "format",
  "verdict",
  "code",
  "at",
  "scriptSha256",
  "driverSha256",
  "chromiumSha256",
  "d0",
  "d1",
  "w1",
  "w2",
  "w3",
  "w4",
  "scratchDeleted",
  "scratchAbsent",
];
type Started = { state: string; code: string; censusAfter: string };
type Outcome = { value: unknown; calls: string[] };
const asCensus = (outcome: Outcome) => outcome.value as Census;
let runIndex = 0;

function run(cases: Case[], source = script): Record<string, Outcome> {
  const directory = path.join(scratch, `run-${runIndex++}`);
  mkdirSync(directory);
  const harness = path.join(directory, "harness.ps1");
  const input = path.join(directory, "cases.json");
  writeFileSync(harness, HARNESS);
  writeFileSync(input, JSON.stringify(cases));
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", harness], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SELECTOR_CENSUS_SCRIPT: source, SELECTOR_CENSUS_CASES: input },
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

function code(outcome: Outcome | undefined) {
  const value = outcome?.value;
  if (typeof value !== "object" || value === null) return value;
  const result = value as { code?: string; state?: string };
  return result.code ?? result.state;
}

const COUNT_KEYS = [
  "processes",
  "members",
  "default",
  "defaultRoots",
  "other",
  "chromeUnreadable",
  "chromeAmbiguous",
  "chromeRootConflict",
  "referenced",
  "unresolved",
  "unreadable",
  "entries",
  "holders",
];
const CODES = [
  "CLEAR",
  "ROOT_CONFLICT",
  "CENSUS_INCOMPLETE",
  "RUN_TRACKING_INCOMPLETE",
  "RUN_IDENTITY_MISMATCH",
  "RUN_TREE_ALIVE",
  "RUN_PROFILE_REFERENCED",
  "REFERENCE_UNRESOLVED",
  "RUN_PROFILE_HELD",
  "CHROME_UNREADABLE",
  "CHROME_AMBIGUOUS",
];

function expectClosedCensus(value: unknown) {
  const census = value as Census;
  expect(Object.keys(census)).toEqual(["format", "complete", "verdict", "code", "counts", "at", "defaultRootDigest"]);
  expect(census.format).toBe("selector-run-profile-census/v1");
  expect(typeof census.complete).toBe("boolean");
  expect(CODES).toContain(census.code);
  expect(census.verdict).toBe(census.code === "CLEAR" ? "CLEAR" : "BLOCKED");
  expect(Object.keys(census.counts)).toEqual(COUNT_KEYS);
  for (const count of Object.values(census.counts)) expect(count === null || Number.isInteger(count)).toBe(true);
  expect(census.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(census.defaultRootDigest === null || /^[0-9a-f]{64}$/.test(census.defaultRootDigest)).toBe(true);
  // No paths, command lines, process names or exception text leave the census.
  expect(JSON.stringify(census)).not.toMatch(/\\|synthetic|chrome\.exe|node\.exe|pwsh|exception|failure/i);
}

describe("selector-run-profile-census-law", () => {
  const cases = lawCases();
  let outcomes: Record<string, Outcome>;
  beforeAll(() => {
    outcomes = run(cases);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const outcome = outcomes[entry.name];
    expect(code(outcome)).toBe(entry.expect);
    expectClosedCensus(outcome.value);
  });

  it("reports class counts for the census categories without zeroing unreadable processes", () => {
    const clear = asCensus(outcomes["L0 pre-launch switchless Chrome is DEFAULT and the census is CLEAR"]);
    expect(clear.complete).toBe(true);
    expect(clear.counts).toMatchObject({
      processes: 3,
      members: 0,
      default: 2,
      defaultRoots: 1,
      other: 0,
      entries: 3,
      holders: 0,
    });
    const unreadable = asCensus(outcomes["L7 unreadable non-Chrome is counted, never blocking"]);
    expect(unreadable.counts.unreadable).toBe(1);
    const tree = asCensus(outcomes["L4 switchless grandchild after intermediate and driver exit is RUN"]);
    expect(tree.counts.members).toBe(1);
    expect(tree.counts.default).toBe(2);
    const reused = asCensus(outcomes["L4 reused PID non-member is not RUN"]);
    expect(reused.counts).toMatchObject({ members: 0, default: 3, defaultRoots: 2 });
    const absent = asCensus(outcomes["L2 absent profile is zero entries"]);
    expect(absent.counts.entries).toBe(0);
    const bound = asCensus(outcomes["L2 exactly 20000 profile entries"]);
    expect(bound.counts.entries).toBe(20000);
  });

  it("never classifies possible run descendants as DEFAULT or OTHER while tracking is incomplete", () => {
    for (const entry of cases.filter((candidate) => candidate.expect === "RUN_TRACKING_INCOMPLETE")) {
      const value = asCensus(outcomes[entry.name]);
      expect(value.complete).toBe(false);
      expect([value.counts.default, value.counts.other, value.counts.defaultRoots, value.defaultRootDigest]).toEqual([
        null,
        null,
        null,
        null,
      ]);
    }
  });

  it("accepts a zero-member run as empty only on the same job's zero active count", () => {
    expect(outcomes["L3 member born behind the job PID list as its parent exits"].calls).toContain("JobActive");
    for (const name of [
      "L4 vanished job member is ignored",
      "L4 reused PID non-member is not RUN",
      "L4 empty job ignores a reused admitted PID",
    ]) {
      expect(code(outcomes[name])).toBe("CLEAR");
      expect(outcomes[name].calls).toContain("JobActive");
    }
    expect(outcomes["L0 pre-launch switchless Chrome is DEFAULT and the census is CLEAR"].calls).not.toContain(
      "JobActive",
    );
  });

  it("digests only the default Chrome roots by PID and start, so a restarted root changes D1", () => {
    const first = asCensus(outcomes["L0 pre-launch switchless Chrome is DEFAULT and the census is CLEAR"]);
    const second = asCensus(outcomes["L7 other user-data-dir is OTHER and never blocks"]);
    const third = asCensus(outcomes["L4 reused PID non-member is not RUN"]);
    expect(second.defaultRootDigest).toBe(first.defaultRootDigest);
    expect(third.defaultRootDigest).not.toBe(first.defaultRootDigest);
  });
});

const PARENT_SNAPSHOT = String.raw`$members = @(& { $rows = @(& $Native.Processes); $tree = @{ [long]$Run.driver.pid = $true }; do { $grew = $false; foreach ($row in $rows) { if ($tree[[long]$row.parentPid] -and -not $tree[[long]$row.pid]) { $tree[[long]$row.pid] = $true; $grew = $true } } } while ($grew); foreach ($row in $rows) { if ($tree[[long]$row.pid]) { @{ pid = [long]$row.pid; created = [long]$row.created } } } })`;
const NAME_EXCLUSION = String.raw`$selfName = @($processes | Where-Object { $_.pid -eq $self.pid })[0].name; $foreign = @($entries.pids | Where-Object { $holder = $_; $row = @($processes | Where-Object { $_.pid -eq $holder })[0]; -not ($row -and $row.name -eq $selfName) -and -not $memberPids.Contains([long]$holder) })`;

const MUTANTS: Array<{ name: string; from: string; to: string; killedBy: string }> = [
  {
    name: "switchless unknown",
    from: "$class = 'DEFAULT'",
    to: "$class = 'CHROME_AMBIGUOUS'",
    killedBy: "L7 switchless Chrome root is DEFAULT and never blocks",
  },
  {
    name: "parent-snapshot tree",
    from: "$members = @(Get-SelectorJobMembers $Run $Native $Held)",
    to: PARENT_SNAPSHOT,
    killedBy: "L4 switchless grandchild after intermediate and driver exit is RUN",
  },
  {
    name: "PID-only membership",
    from: "if ($member.InJob -and $member.Alive) {",
    to: "if ($member.Alive) {",
    killedBy: "L4 reused PID non-member is not RUN",
  },
  {
    name: "tracking loss DEFAULT",
    from: "if ($tracking.state -ceq 'LOST') { $result.code = 'RUN_TRACKING_INCOMPLETE'; return $result }",
    to: "",
    killedBy: "L3 launched run whose job handle fails",
  },
  {
    name: "raw substring",
    from: "return $Inner.Equals($Outer, $script:SelectorPathComparison) -or $Inner.StartsWith($Outer.TrimEnd('\\') + '\\', $script:SelectorPathComparison)",
    to: "return $Inner.IndexOf($Outer, $script:SelectorPathComparison) -ge 0",
    killedBy: "L5 not a reference: lone profile-backup sibling",
  },
  {
    name: "lexical failure gate",
    from: "if ($entry.Code -notin 2, 3) { return $unresolved }",
    to: "if ($false) { return $unresolved }",
    killedBy: "L5 denied lexically unrelated alias is UNRESOLVED",
  },
  {
    name: "ordinal case",
    from: "$script:SelectorPathComparison = [StringComparison]::OrdinalIgnoreCase",
    to: "$script:SelectorPathComparison = [StringComparison]::Ordinal",
    killedBy: "L5 case-variant tail before the profile exists",
  },
  {
    name: "file-only holders",
    from: "foreach ($holder in @(& $Native.Holders $entry.path)) { [void]$pids.Add([long]$holder) }",
    to: "if (-not $entry.directory) { foreach ($holder in @(& $Native.Holders $entry.path)) { [void]$pids.Add([long]$holder) } }",
    killedBy: "L6 non-run directory holder",
  },
  {
    name: "name self-exclusion",
    from: "$foreign = @($entries.pids | Where-Object { $_ -ne $self.pid -and -not $memberPids.Contains([long]$_) })",
    to: NAME_EXCLUSION,
    killedBy: "L6 same-name non-run holder is HELD",
  },
  {
    name: "unreadable Chrome DEFAULT",
    from: "$class = 'CHROME_UNREADABLE'",
    to: "$class = 'DEFAULT'",
    killedBy: "L7 unreadable Chrome command line",
  },
  {
    name: "CLEAR on collector error",
    from: "$result.code = 'CENSUS_INCOMPLETE' # collector or resolver failure",
    to: "$result.code = 'CLEAR'",
    killedBy: "L2 process enumeration failure",
  },
  {
    name: "stale PID list as empty job",
    from: "if (-not $members.Count -and (& $Native.JobActive $Run.job) -ne 0) { return @{ state = 'LOST'; members = @() } }",
    to: "",
    killedBy: "L3 member born behind the job PID list as its parent exits",
  },
  {
    name: "deadline after root resolution",
    from: "$deadline = (& $Native.Now).AddMilliseconds($script:SelectorCensusTimeoutMs)\n    $context = Get-SelectorRunPaths $Root $Native",
    to: "$context = Get-SelectorRunPaths $Root $Native\n    $deadline = (& $Native.Now).AddMilliseconds($script:SelectorCensusTimeoutMs)",
    killedBy: "L2 root resolution past the deadline",
  },
  {
    name: "no classification deadline",
    from: "if ((& $Native.Now) -gt $deadline) { throw 'CLASSIFICATION_TIMEOUT' }",
    to: "",
    killedBy: "L2 reference resolution past the deadline",
  },
];

const WITNESS_MUTANTS: Array<{ name: string; from: string; to: string; killedBy: string }> = [
  {
    name: "W3-bound D1",
    from: "$result.d1 = $result.w4.defaultRootDigest",
    to: "",
    killedBy: "witness is INVALID when a default Chrome root restarts between W3 and W4",
  },
  {
    name: "final-only D1",
    from: " -or $Result.w3.defaultRootDigest -cne $Result.d0",
    to: "",
    killedBy: "witness is INVALID when a W3 default-root removal is restored by W4",
  },
];

describe("selector-run-profile-census-law mutants", () => {
  const source = readFileSync(script, "utf8");
  const cases = lawCases();
  it.each(MUTANTS.map((mutant) => [mutant.name, mutant] as const))("%s FAILS its named law case", (_name, mutant) => {
    expect(source.split(mutant.from)).toHaveLength(2);
    const target = cases.find((entry) => entry.name === mutant.killedBy);
    expect(target).toBeDefined();
    const mutated = path.join(scratch, `mutant-${mutant.name.replaceAll(/[^a-z]+/gi, "-")}.ps1`);
    writeFileSync(mutated, source.replace(mutant.from, mutant.to));
    const outcomes = run([target!], mutated);
    // Killed behaviourally: the mutant still returns a closed census, just the wrong code.
    expectClosedCensus(outcomes[target!.name].value);
    expect(code(outcomes[target!.name])).not.toBe(target!.expect);
  });
});

describe("selector-run-profile-census-witness mutants", () => {
  const source = readFileSync(script, "utf8");
  const cases = witnessCases();
  it.each(WITNESS_MUTANTS.map((mutant) => [mutant.name, mutant] as const))(
    "%s FAILS its named witness case",
    (_name, mutant) => {
      expect(source.split(mutant.from)).toHaveLength(2);
      const target = cases.find((entry) => entry.name === mutant.killedBy);
      expect(target).toBeDefined();
      const mutated = path.join(scratch, `witness-mutant-${mutant.name.replaceAll(/[^a-z0-9]+/gi, "-")}.ps1`);
      writeFileSync(mutated, source.replace(mutant.from, mutant.to));
      const value = run([target!], mutated)[target!.name].value as Witness;
      // Killed behaviourally: a closed witness result that reaches the false PASS.
      expect(Object.keys(value)).toEqual(WITNESS_KEYS);
      expect(value.verdict).not.toBe(target!.expect);
      expect(value.verdict).toBe("PASS");
    },
  );
});

describe("selector-run-profile-census-boundary", () => {
  const starts = startCases();
  const witnesses = witnessCases();
  const admissions: Case[] = [
    {
      name: "admission valid",
      kind: "admission",
      text: JSON.stringify({ format: "selector-run-profile-census-witness-admission/v1", root: ROOT }),
    },
    {
      name: "admission extra key",
      kind: "admission",
      text: JSON.stringify({ format: "selector-run-profile-census-witness-admission/v1", root: ROOT, x: 1 }),
    },
    {
      name: "admission relative root",
      kind: "admission",
      text: JSON.stringify({
        format: "selector-run-profile-census-witness-admission/v1",
        root: "scratch\\selector-witness-x",
      }),
    },
    {
      name: "admission non-normalized root",
      kind: "admission",
      text: JSON.stringify({
        format: "selector-run-profile-census-witness-admission/v1",
        root: `${ROOT}\\..\\selector-witness-x`,
      }),
    },
    {
      name: "admission unscoped root name",
      kind: "admission",
      text: JSON.stringify({
        format: "selector-run-profile-census-witness-admission/v1",
        root: "C:\\Users\\synthetic\\scratch\\anything",
      }),
    },
    {
      name: "admission nested root",
      kind: "admission",
      text: JSON.stringify({ format: "selector-run-profile-census-witness-admission/v1", root: { path: ROOT } }),
    },
    {
      name: "admission wrong format",
      kind: "admission",
      text: JSON.stringify({ format: "selector-run-profile-census/v1", root: ROOT }),
    },
    { name: "admission not an object", kind: "admission", text: JSON.stringify([ROOT]) },
  ];
  let outcomes: Record<string, Outcome>;
  beforeAll(() => {
    outcomes = run([...starts, ...witnesses, ...admissions]);
  });

  it.each(starts.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const outcome = outcomes[entry.name];
    const value = outcome.value as Started;
    const startSpec = (entry.native as { start: typeof START }).start;
    expect(value.state).toBe(entry.expect);
    expect(value.code).toBe(
      entry.expect === "GRANTED"
        ? "RUN_GRANTED"
        : entry.expect === "PENDING"
          ? "RUN_TRACKING_INCOMPLETE"
          : "RUN_START_REFUSED",
    );
    const grants = outcome.calls.filter((call) => call.startsWith("Grant:"));
    if (entry.expect === "GRANTED") {
      // The grant follows creation-time membership, unchanged limits and the recorded PID+start.
      expect(outcome.calls).toEqual(["NewJob", "JobLimits", "StartDriver", "InJob", "JobLimits", "Created", grants[0]]);
      expect(JSON.parse(grants[0].slice(6))).toEqual({
        format: "selector-run-grant/v1",
        pid: 700,
        payload: { profile: "C:\\seat\\run\\profile" },
      });
      expect(value.censusAfter).not.toBe("RUN_TRACKING_INCOMPLETE");
      return;
    }
    expect(startSpec.writeOk ? grants : []).toEqual([]);
    const created = startSpec.createError === 0 && startSpec.limits === "0x0/0x0";
    expect(outcome.calls.includes("StartDriver")).toBe(startSpec.limits === "0x0/0x0");
    // A created driver is released only through EOF on its own grant pipe, never ended.
    expect(outcome.calls.includes("CloseWriter")).toBe(created);
    if (entry.expect === "PENDING") expect(value.censusAfter).toBe("RUN_TRACKING_INCOMPLETE");
  });

  it.each(witnesses.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const outcome = outcomes[entry.name];
    const value = outcome.value as Witness;
    expect({ verdict: value.verdict, code: value.code }).toMatchObject({ verdict: entry.expect });
    expect(Object.keys(value)).toEqual(WITNESS_KEYS);
    for (const step of [value.w1, value.w2, value.w3, value.w4]) if (step !== null) expectClosedCensus(step);
    expect(JSON.stringify(value)).not.toMatch(/\\|synthetic|seat/i);
    // D1 is the final post-deletion census whenever one exists.
    if (value.w4 !== null) expect(value.d1).toBe(value.w4.defaultRootDigest);
    if (entry.expect === "INVALID") expect(value.code).toBe("DEFAULT_ROOTS_CHANGED");
    const removals = outcome.calls.filter((call) => call === "RemoveScratch");
    if (entry.expect === "REFUSED") {
      expect(outcome.calls).not.toContain("CreateRoot");
      expect(removals).toEqual([]);
      return;
    }
    if (entry.expect === "PASS") {
      expect(value).toMatchObject({ code: "WITNESS_PASS", scratchDeleted: true, scratchAbsent: true, d1: value.d0 });
      expect([value.w1?.code, value.w2?.code, value.w3?.code, value.w4?.code]).toEqual([
        "CLEAR",
        "RUN_TREE_ALIVE",
        "CLEAR",
        "CLEAR",
      ]);
      expect(value.w2?.counts.members).toBe(3);
      expect(value.w3?.counts).toMatchObject({ members: 0, default: 2 });
    }
    // Deletion happens at most once and only right after a CLEAR census.
    expect(removals.length).toBeLessThanOrEqual(1);
    if (removals.length) {
      const before = outcome.calls.slice(0, outcome.calls.indexOf("RemoveScratch"));
      expect(before.lastIndexOf("Self")).toBeGreaterThan(-1);
      expect((value.w3 ?? value.w1)?.code).toBe("CLEAR");
    }
    if (entry.expect === "PENDING" || entry.name.includes("W3 holder")) expect(removals).toEqual([]);
    if (entry.expect === "NOT_EXERCISED") expect(outcome.calls).not.toContain("StartDriver");
    if (outcome.calls.includes("StartDriver") && entry.expect !== "PENDING")
      expect(outcome.calls).toContain("ReleaseRun");
  });

  it("admits only the closed witness admission shape", () => {
    expect(outcomes["admission valid"].value).toEqual({ root: ROOT });
    for (const entry of admissions.slice(1)) expect(outcomes[entry.name].value).toBe("REFUSED");
  });

  const cli = (args: string[], input = "") =>
    spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, ...args], { encoding: "utf8", input });
  const SECRET = "C:\\Users\\synthetic\\secret-path-9628";

  it.each([
    ["no action", []],
    ["invalid action", ["-Action", "census"]],
    ["path as action", ["-Action", SECRET]],
    ["path on argv after witness", ["-Action", "witness", SECRET]],
    ["positional path", [SECRET]],
    ["second action", ["-Action", "witness", "-Action", "witness"]],
  ])("CLI refuses %s with exit 1, a fixed code and no echo", (_name, args) => {
    const result = cli(args as string[]);
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('{"format":"selector-run-profile-census-refusal/v1","code":"CLI_REFUSED"}');
    expect(result.stderr).toBe("");
  });

  it.each([
    [
      "oversize admission",
      `{"format":"selector-run-profile-census-witness-admission/v1","root":"${SECRET.replaceAll("\\", "\\\\")}${"x".repeat(5000)}"}`,
    ],
    [
      "extra-key admission",
      JSON.stringify({ format: "selector-run-profile-census-witness-admission/v1", root: SECRET, extra: SECRET }),
    ],
    [
      "relative admission",
      JSON.stringify({
        format: "selector-run-profile-census-witness-admission/v1",
        root: "secret-path-9628\\selector-witness-x",
      }),
    ],
    ["malformed admission", `{"root":"${SECRET.replaceAll("\\", "\\\\")}"`],
    ["empty admission", ""],
  ])("CLI refuses an %s with exit 1, a fixed code and no echo", (_name, input) => {
    const result = cli(["-Action", "witness"], input as string);
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('{"format":"selector-run-profile-census-refusal/v1","code":"ADMISSION_REFUSED"}');
    expect(result.stderr).toBe("");
  });

  it("the witness driver refuses EOF, malformed and foreign grants before any browser exists", () => {
    for (const input of [
      "",
      "not-json\n",
      `${JSON.stringify({ format: "selector-run-grant/v1", pid: 1, payload: { profile: path.join(scratch, "profile") } })}\n`,
    ]) {
      const result = spawnSync(process.execPath, [driver], { encoding: "utf8", input });
      expect(result.status).toBe(3);
      expect(result.stdout.trim()).toBe('{"event":"refused"}');
      expect(result.stderr).toBe("");
    }
  });

  it("the witness driver accepts only its own closed grant and launches with chromeArguments", async () => {
    const witness = await import(new URL("./selector-run-profile-census-witness.mjs", import.meta.url).href);
    const profile = path.join(scratch, "profile");
    const grant = (value: unknown) => JSON.stringify(value);
    expect(witness.parseGrant(grant({ format: "selector-run-grant/v1", pid: 42, payload: { profile } }), 42)).toBe(
      profile,
    );
    for (const value of [
      { format: "selector-run-grant/v1", pid: 43, payload: { profile } },
      { format: "selector-run-grant/v1", pid: 42, payload: { profile }, extra: true },
      { format: "selector-run-grant/v1", pid: 42, payload: { profile, extra: true } },
      { format: "selector-run-grant/v1", pid: 42, payload: { profile: "relative" } },
      { format: "selector-run-grant/v2", pid: 42, payload: { profile } },
    ]) {
      expect(witness.parseGrant(grant(value), 42)).toBeNull();
    }
    const args = witness.witnessArguments(profile, 9);
    expect(args).not.toContain("about:blank");
    expect(args.some((arg: string) => arg.startsWith("--user-data-dir"))).toBe(false);
    expect(args).toContain("--proxy-server=http://127.0.0.1:9");
    expect(witness.CHROMIUM_REVISION).toBe("chromium-1223");
    expect(witness.CHROMIUM_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("forbidden-API scan: no ending, signalling, assignment or deletion outside the gated witness scratch", () => {
    const census = readFileSync(script, "utf8");
    const witness = readFileSync(driver, "utf8");
    const forbidden = [
      /Stop-Process/i,
      /taskkill/i,
      /TerminateProcess/i,
      /TerminateJobObject/i,
      /AssignProcessToJobObject/i,
      /SetInformationJobObject/i,
      /KILL_ON_JOB_CLOSE/i,
      /CloseMainWindow/i,
      /GenerateConsoleCtrlEvent/i,
      /PostMessage|SendMessage/i,
      /SuspendThread|ResumeThread|NtSuspendProcess|CREATE_SUSPENDED/i,
      /DebugActiveProcess/i,
      /\.Kill\(|\.kill\(|process\.kill/i,
      /Stop-Job|Remove-Job/i,
    ];
    for (const pattern of forbidden) {
      expect(census).not.toMatch(pattern);
      expect(witness).not.toMatch(pattern);
    }
    const deletion =
      /Remove-Item|::Delete\(|DeleteFile|RemoveDirectory|DELETE_ON_CLOSE|DeleteOnClose|SetFileInformationByHandle|FileDisposition|rmSync|unlink|rmdir|\brm\(/i;
    expect(witness).not.toMatch(deletion);
    const gated = census.match(/\r?\nfunction Remove-SelectorWitnessScratch[\s\S]*?\r?\n}\r?\n/);
    expect(gated).not.toBeNull();
    expect(census.replace(gated![0], "\n")).not.toMatch(deletion);
    expect(gated![0]).toMatch(deletion);
    expect(census.match(/Remove-SelectorWitnessScratch/g)).toHaveLength(2);
    expect(census.match(/& \$Native\.RemoveScratch /g)).toHaveLength(1);
    expect(census).toMatch(/if \(\$last\.code -ceq 'CLEAR'\) \{\r?\n\s+& \$Native\.RemoveScratch \$Root/);
  });
});
