import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Software-only evidence for #9651 AC1/AC2 (#9628's law with R1/R2). Every native primitive below the
// census law is synthetic; the collector, job and actual-host witness (AC3/AC4) belong to the host verifier.
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
    "C:\\tools": "dir",
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

// Compound argv tokens as CommandLineToArgvW returns them from `cmd /c "…"` wrappers: a drive path
// whose middle component embeds a second drive path or a redirection, which the OS reports as 123.
const COMPOUND_DRIVE = `C:\\tools\\wrapper.cmd ${PROFILE}`;
const COMPOUND_REDIRECT = `C:\\tools\\job.cmd > ${PROFILE}\\log.txt`;
const INVALID_TAIL = "run.cmd > C:\\Temp\\log.txt";
const NO_ROOT_DRIVE = { fixed: ["C", "S", "T"] };
// An injected probe result for the existing entry C:\fault, reached after the 123s of an invalid tail.
const fault = (probe: Spec): Spec => ({
  fs: fs({ "C:\\fault": "dir" }),
  faults: { "C:\\fault": probe },
  ...withProcesses(tool(800, `C:\\fault\\${INVALID_TAIL}`)),
});

// #9651 R1: an L5 argv candidate's entry-open 123 only continues the canonical-prefix walk.
function continuationCases(): Case[] {
  const referenced = (name: string, token: string, overrides: Spec = {}) =>
    census(`L5 123 (ii) ${name} is REFERENCED`, "RUN_PROFILE_REFERENCED", {
      ...withProcesses(tool(800, token)),
      ...overrides,
    });
  const unresolved = (name: string, overrides: Spec) =>
    census(`L5 123 ${name} is UNRESOLVED`, "REFERENCE_UNRESOLVED", overrides);
  return [
    census(
      "L5 123 (i) embedded-drive compound token over an unrelated prefix is CLEAR",
      "CLEAR",
      withProcesses(tool(800, COMPOUND_DRIVE)),
    ),
    census(
      "L5 123 (i) redirection compound token over an unrelated prefix is CLEAR",
      "CLEAR",
      withProcesses(tool(800, COMPOUND_REDIRECT)),
    ),
    referenced("invalid tail under the profile", `${PROFILE}\\Default\\${INVALID_TAIL}`),
    referenced("invalid tail before the profile exists", `${PROFILE}\\${INVALID_TAIL}`, { fs: NO_PROFILE }),
    referenced("invalid tail through a junction into the profile", `C:\\links\\into\\${INVALID_TAIL}`),
    referenced("invalid tail through an 8.3 name of the profile", `${ROOT}\\PROFIL~1\\${INVALID_TAIL}`),
    referenced("invalid tail through a subst drive", `S:\\profile\\${INVALID_TAIL}`),
    census(
      "L5 123 (ii) invalid tail under a non-user-data-dir root ancestor is CLEAR",
      "CLEAR",
      withProcesses(tool(800, `${ROOT}\\${INVALID_TAIL}`)),
    ),
    unresolved(
      "(iii) invalid tail under a denied lexically unrelated alias",
      withProcesses(tool(800, `C:\\gate\\alias\\${INVALID_TAIL}`)),
    ),
    unresolved(
      "(iii) invalid tail behind a reparse loop",
      withProcesses(tool(800, `C:\\links\\loop\\x\\${INVALID_TAIL}`)),
    ),
    unresolved(
      "(iii) invalid tail under an existing dangling junction",
      withProcesses(tool(800, `C:\\links\\dangling\\${INVALID_TAIL}`)),
    ),
    ...[5, 1920, 1921, 21].map((code) => unresolved(`(iv) entry-open ${code} after a 123`, fault({ entry: code }))),
    ...[2, 3, 123].map((code) => unresolved(`(iv) failed follow ${code} after a 123`, fault({ follow: code }))),
    ...[2, 123].map((code) =>
      unresolved(`(iv) metadata query ${code} on an opened entry`, fault({ entry: code, opened: true })),
    ),
    unresolved("(iv) final-path query failure after a 123", fault({ follow: 1 })),
    unresolved(
      "(iv) unparseable final path after a 123",
      fault({ final: "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\fault" }),
    ),
    ...[3, 123].map((code) =>
      unresolved(`(iv) no canonical existing prefix (drive root ${code})`, {
        ...NO_ROOT_DRIVE,
        faults: { "T:\\": { entry: code } },
        ...withProcesses(tool(800, `T:\\${INVALID_TAIL}`)),
      }),
    ),
    census("L5 no canonical existing prefix is UNRESOLVED without a 123", "REFERENCE_UNRESOLVED", {
      ...NO_ROOT_DRIVE,
      faults: { "T:\\": { entry: 3 } },
      ...withProcesses(tool(800, "T:\\absent\\x")),
    }),
    census(
      "L5 123 (v) run root 123 refuses before collection",
      "CENSUS_INCOMPLETE",
      {},
      { root: "C:\\Users\\synthetic\\bad:dir\\selector-witness-synthetic" },
    ),
    census("L5 123 (v) injected run-root 123 refuses before collection", "CENSUS_INCOMPLETE", {
      faults: { [ROOT]: { entry: 123 } },
    }),
    census("L5 123 (v) default-root 123 refuses before collection", "CENSUS_INCOMPLETE", {
      localAppData: "C:\\Users\\synthetic\\App:Data\\Local",
    }),
    census("L5 123 (v) profile-entry enumeration 123 stays CENSUS_INCOMPLETE", "CENSUS_INCOMPLETE", {
      entryCodes: { [PROFILE]: 123 },
    }),
    census(
      "L5 123 (v) Chrome user-data-dir 123 stays CHROME_AMBIGUOUS",
      "CHROME_AMBIGUOUS",
      withProcesses(chrome(810, `--user-data-dir=C:\\Users\\synthetic\\${INVALID_TAIL}`)),
    ),
    census(
      "L5 123 (v) UNC compound token stays lexical",
      "CLEAR",
      withProcesses(tool(800, `\\\\fileserver\\share\\${INVALID_TAIL}`)),
    ),
    census(
      "L5 123 (vi) profile argument beside an unrelated compound token is REFERENCED",
      "RUN_PROFILE_REFERENCED",
      withProcesses(tool(800, COMPOUND_DRIVE, PROFILE)),
    ),
    census("L5 123 (vi) holder beside an unrelated compound token is HELD", "RUN_PROFILE_HELD", {
      holders: { [`${PROFILE}\\Default`]: [8100] },
      ...withProcesses(tool(800, COMPOUND_REDIRECT)),
    }),
    unresolved(
      "(vi) denied alias beside an unrelated compound token",
      withProcesses(tool(800, COMPOUND_DRIVE), tool(801, "C:\\gate\\alias")),
    ),
  ];
}

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
    ...continuationCases(),
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

const transportCase: Case = {
  name: "selector-run-profile-census-transport",
  kind: "transport",
  native: native({
    start: { ...START },
    transport: { protocol: '{"event":"protocol"}', stderr: "STDERR_SENTINEL" },
  }),
};

const stderrOwnershipCase = (): Case => ({
  name: "selector-run-profile-census-stderr-ownership",
  kind: "witness",
  root: ROOT,
  native: native({
    start: { ...START },
    witness: { exists: [false, false], line: null, admitted: { pid: 710, created: 71 }, empties: false },
    phases: PHASES,
  }),
  expect: "PENDING",
});

const admissionCustodyCase: Case = {
  name: "selector-run-profile-census-admission-custody",
  kind: "admission-custody",
  native: native(),
};

const SELECTOR_GRANT_TIMEOUT_MS = 30000;
const WRITES: Array<[string, Spec]> = [
  ["withheld grant", { inJob: false }],
  ["failed grant write", { writeOk: false }],
  ["thrown grant write", { writeOk: "throw" }],
];
// #9651 R2: one fixed deadline covers the driver's exit and the held job draining. `active` is the
// job's count at each poll after exit; `exitMs` is when the exit is observed inside the wait.
const DRAINS: Array<[string, string, Spec]> = [
  ["driver exits, then the held job drains 1->0 inside the budget", "REFUSED", { active: [1, 0] }],
  ["driver exits into an already empty job", "REFUSED", { active: [0] }],
  ["driver exits, but the job stays nonzero through the deadline", "PENDING", { active: [1] }],
  [
    "driver exit spends the budget and zero comes only after the deadline",
    "PENDING",
    { exitMs: SELECTOR_GRANT_TIMEOUT_MS, active: [0] },
  ],
  ["driver exits, but job accounting throws", "PENDING", { active: "throw" }],
  ["driver never exits", "PENDING", { exits: false, active: [0] }],
];
function drainCases(): Case[] {
  return WRITES.flatMap(([write, writeSpec]) =>
    DRAINS.map(([history, expected, drainSpec]) =>
      start(`start ${write}: ${history}`, expected, { ...writeSpec, ...drainSpec }),
    ),
  );
}

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
    start("start keeps a run PENDING when closing the grant pipe throws", "PENDING", {
      inJob: false,
      closeThrows: true,
    }),
    start("start keeps a failed exit wait PENDING even when the job is empty", "PENDING", {
      inJob: false,
      exits: false,
      exitMs: 0,
      active: [0],
    }),
    ...drainCases(),
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
    witness(
      "witness refuses a root the OS reports as 123 before any creation or deletion",
      "REFUSED",
      {},
      "C:\\Users\\synthetic\\bad:dir\\selector-witness-x",
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
  # The OS reports 123 (ERROR_INVALID_NAME) for a name no entry can have: a reserved character, a
  # colon in a middle component or an empty stream name. A final name:stream is an absent stream.
  for ($i = 0; $i -lt $parts.Count; $i++) {
    if ($parts[$i] -match '[<>|*?"]' -or ($parts[$i].Contains(':') -and ($i -lt $parts.Count - 1 -or $parts[$i].EndsWith(':')))) { return @{ Code = 123 } }
  }
  $current =if ($script:current.substs -and $script:current.substs[$drive]) { $script:current.substs[$drive] } else { $drive }
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
      # An injected entry-open or metadata (opened) code, failed follow, or final path for one exact prefix.
      $fault = if ($script:current.faults) { $script:current.faults[$Path] } else { $null }
      $probe = if ($fault -and -not $Follow -and $null -ne $fault.entry) { @{ Code = [int]$fault.entry; Opened = [bool]$fault.opened } }
        elseif ($fault -and $Follow -and $null -ne $fault.follow) { @{ Code = [int]$fault.follow; Opened = $false } }
        elseif ($fault -and $Follow -and $fault.final) { @{ Code = 0; Opened = $true; Final = $fault.final } }
        else { Invoke-SyntheticOpen $Path $Follow 0 }
      $script:calls.Add("Open:$([int][bool]$Follow):$Path=$($probe.Code)")
      $probe
    }
    Entry = {
      param($Path)
      if ($script:current.entryCodes -and $null -ne $script:current.entryCodes[$Path]) { return @{ Code = [int]$script:current.entryCodes[$Path] } }
      Invoke-SyntheticOpen $Path $false 0
    }
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
      @{ Error = 0; Pid = 700; Process = 'P'; Stdin = 'I'; Stdout = 'O'; Stderr = 'E' }
    }
    InJob = { param($Process, $Job) $script:calls.Add('InJob'); if ("$($script:current.start.inJob)" -ceq 'throw') { throw 'synthetic' }; [bool]$script:current.start.inJob }
    Created = { param($Process) $script:calls.Add('Created'); if ($null -eq $script:current.start.created) { throw 'synthetic' }; [long]$script:current.start.created }
    WriteLine = {
      param($Writer, $Line)
      if ("$($script:current.start.writeOk)" -ceq 'throw') { throw 'synthetic pipe write failure' }
      $script:calls.Add('Grant:' + $Line); [bool]$script:current.start.writeOk
    }
    CloseWriter = { param($Writer) $script:calls.Add('CloseWriter'); if ($script:current.start.closeThrows) { throw 'synthetic close failure' } }
    WaitExit = {
      param($Process, $Ms)
      $script:calls.Add("WaitExit:$Ms")
      if ("$($script:current.start.exits)" -ceq 'throw') { throw 'synthetic' }
      # The wait ends exitMs in (an exit, or a failed wait), else at once on exit or after the whole wait.
      $exits = [bool]$script:current.start.exits
      $script:clock = $script:clock.AddMilliseconds([Math]::Min([double]$Ms, [double]($script:current.start.exitMs ?? $(if ($exits) { 0 } else { $Ms }))))
      $exits
    }
    Sleep = { param($Ms) $script:calls.Add("Sleep:$Ms"); $script:clock = $script:clock.AddMilliseconds([double]$Ms) }
    ExitCode = { param($Process) 42 }
    JobActive = {
      param($Job)
      $script:calls.Add('JobActive')
      if ($script:current.job.activeThrow) { throw 'synthetic job accounting failure' }
      if ($null -ne $script:current.job.active) { return [int]$script:current.job.active }
      # The job's own count: every live in-job process, listed or not.
      if ($script:current.job) { return @($script:current.job.open.Values | Where-Object { $_ -isnot [string] -and $_.inJob -and $_.alive }).Count }
      if ("$($script:current.start.active)" -ceq 'throw') { throw 'synthetic job accounting failure' }
      # A start's counts are read in order; the last one repeats.
      $counts = @($script:current.start.active)
      $script:activeReads = 1 + [int]$script:activeReads
      [int]$counts[[Math]::Min($script:activeReads, $counts.Count) - 1]
    }
    WitnessDriver = { 'C:\seat\selector-run-profile-census-witness.mjs' }
    ScriptSha256 = { 'b' * 64 }
    DriverSha256 = { 'c' * 64 }
    Exists = { param($Path) $script:calls.Add('Exists'); if ($script:exists.Count) { $script:exists.Dequeue() } else { $false } }
    CreateRoot = { param($Path) $script:calls.Add('CreateRoot') }
    RemoveScratch = { param($Path) $script:calls.Add('RemoveScratch') }
    ReadLine = {
      param($Run, $Ms)
      $script:calls.Add('ReadLine')
      if ($script:spec.transport) { return $script:spec.transport.protocol }
      $script:spec.witness.line
    }
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
    $script:activeReads = 0
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
      'transport' {
        $run = Start-SelectorRunOwned -Driver 'C:\seat\selector-run-profile-census-witness.mjs' -Payload @{ profile = 'C:\seat\run\profile' } -Native $native
        $protocol = & $native.ReadLine $run 1
        [ordered]@{
          stdout = $run.stdout
          stderr = $run.stderr
          handlesDistinct = $run.stdout -ne $run.stderr
          stderrReader = $run.stderrReader
          stderrPending = $run.stderrPending
          protocol = $protocol
          exitCode = & $native.ExitCode $run.process
        }
      }
      'admission-custody' {
        function Initialize-SelectorRunProfileNative {}
        Add-Type @'
public sealed class SelectorRunMember : System.IDisposable {
  public long Pid; public long Created; public bool InJob; public bool Alive; public bool Disposed;
  public void Dispose() { Disposed = true; SelectorRunProfileNative.Disposals++; }
}
public static class SelectorRunProfileNative {
  public static int Disposals;
  public static SelectorRunMember Member(long pid, System.IntPtr job) {
    if (pid == 100) return null;
    return new SelectorRunMember { Pid = pid, Created = pid, InJob = pid == 103, Alive = pid != 102 };
  }
}
'@
        $managed = New-SelectorRunProfileNative
        $run = @{ job = [IntPtr]::Zero; held = [Collections.Generic.List[object]]::new() }
        $observations = foreach ($id in @(100, 101, 102, 103)) {
          $result = & $managed.AdmitBrowser $run $id
          [ordered]@{ id = $id; result = $result; held = $run.held.Count; disposals = [SelectorRunProfileNative]::Disposals }
        }
        [ordered]@{ observations = @($observations) }
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

  it("continues past an L5 candidate's 123 only by opening and following a shorter existing prefix", () => {
    const continued = (name: string, invalid: string, prefix: string, followCode = 0) => {
      const calls = outcomes[name].calls;
      const rejected = calls.indexOf(`Open:0:${invalid}=123`);
      expect(rejected).toBeGreaterThan(-1);
      const opened = calls.indexOf(`Open:0:${prefix}=0`, rejected);
      expect(opened).toBeGreaterThan(rejected);
      expect(calls.indexOf(`Open:1:${prefix}=${followCode}`, opened)).toBe(opened + 1);
    };
    // The compound token itself is no synthetic entry: CLEAR comes from the walk, not a mocked answer.
    expect(Object.keys(fs())).not.toContain(COMPOUND_DRIVE);
    continued(
      "L5 123 (i) embedded-drive compound token over an unrelated prefix is CLEAR",
      "C:\\tools\\wrapper.cmd C:",
      "C:\\tools",
    );
    continued(
      "L5 123 (i) redirection compound token over an unrelated prefix is CLEAR",
      "C:\\tools\\job.cmd > C:",
      "C:\\tools",
    );
    continued(
      "L5 123 (ii) invalid tail through a junction into the profile is REFERENCED",
      "C:\\links\\into\\run.cmd > C:",
      "C:\\links\\into",
    );
    continued(
      "L5 123 (iii) invalid tail under an existing dangling junction is UNRESOLVED",
      "C:\\links\\dangling\\run.cmd > C:",
      "C:\\links\\dangling",
      3,
    );
    // Run-root resolution keeps the 2/3-only gate: its 123 never reaches a shorter prefix.
    const root = outcomes["L5 123 (v) run root 123 refuses before collection"].calls;
    expect(root).toContain("Open:0:C:\\Users\\synthetic\\bad:dir\\selector-witness-synthetic=123");
    expect(root.some((call) => call.startsWith("Open:0:C:\\Users\\synthetic\\bad:dir="))).toBe(false);
    const unc = outcomes["L5 123 (v) UNC compound token stays lexical"].calls;
    expect(unc.some((call) => call.includes("fileserver"))).toBe(false);
  });
});

const PARENT_SNAPSHOT = String.raw`$members = @(& { $rows = @(& $Native.Processes); $tree = @{ [long]$Run.driver.pid = $true }; do { $grew = $false; foreach ($row in $rows) { if ($tree[[long]$row.parentPid] -and -not $tree[[long]$row.pid]) { $tree[[long]$row.pid] = $true; $grew = $true } } } while ($grew); foreach ($row in $rows) { if ($tree[[long]$row.pid]) { @{ pid = [long]$row.pid; created = [long]$row.created } } } })`;
const NAME_EXCLUSION = String.raw`$selfName = @($processes | Where-Object { $_.pid -eq $self.pid })[0].name; $foreign = @($entries.pids | Where-Object { $holder = $_; $row = @($processes | Where-Object { $_.pid -eq $holder })[0]; -not ($row -and $row.name -eq $selfName) -and -not $memberPids.Contains([long]$holder) })`;

describe("selector-run-profile-census-transport-contract", () => {
  it("selector-run-profile-census-transport", () => {
    const value = run([transportCase])[transportCase.name].value as {
      stdout: string;
      stderr: string;
      handlesDistinct: boolean;
      stderrReader: unknown;
      stderrPending: unknown;
      protocol: string;
      exitCode: number;
    };
    expect(value).toMatchObject({
      stdout: "O",
      stderr: "E",
      handlesDistinct: true,
      stderrReader: null,
      stderrPending: null,
      protocol: '{"event":"protocol"}',
      exitCode: 42,
    });
    const source = readFileSync(script, "utf8");
    expect(source).toMatch(/ExitCode\s*=\s*\{\s*param\(\$Process\)/);
    expect(source).toMatch(/\$run\.stderr\s*=\s*\$start\.Stderr/);
  });

  it("selector-run-profile-census-stderr-ownership", () => {
    const caseSpec = stderrOwnershipCase();
    const value = run([caseSpec])[caseSpec.name].value as Witness;
    expect(value).toMatchObject({ verdict: "PENDING", code: "RUN_TRACKING_INCOMPLETE" });
    const source = readFileSync(script, "utf8");
    const functionBodies = [...source.matchAll(/\nfunction ([A-Za-z0-9-]+) \{([\s\S]*?)(?=\nfunction |\n# ---|$)/g)];
    for (const [, name, body] of functionBodies) {
      if (name !== "Start-SelectorRunOwned") expect(body).not.toMatch(/\$run\.(stderr|stderrReader|stderrPending)/);
    }
    expect(JSON.stringify(value)).not.toContain("STDERR_SENTINEL");
  });

  it("selector-run-profile-census-admission-custody", () => {
    const value = run([admissionCustodyCase])[admissionCustodyCase.name].value as {
      observations: Array<{ id: number; result: { pid: number; created: number }; held: number; disposals: number }>;
    };
    expect(value.observations).toEqual([
      { id: 100, result: { pid: 100, created: -1 }, held: 0, disposals: 0 },
      { id: 101, result: { pid: 101, created: -1 }, held: 0, disposals: 1 },
      { id: 102, result: { pid: 102, created: -1 }, held: 0, disposals: 2 },
      { id: 103, result: { pid: 103, created: 103 }, held: 1, disposals: 2 },
    ]);
    const source = readFileSync(script, "utf8");
    expect(source).toMatch(/AdmitBrowser = \{[\s\S]*?Member\([\s\S]*?InJob -and \$member\.Alive[\s\S]*?Dispose\(\)[\s\S]*?created = -1/);
  });

  it("selector-run-profile-census-byte-identity", () => {
    const bytes = readFileSync(script);
    const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    const blobHeader = Buffer.from(`blob ${bytes.length}\0`, "utf8");
    const gitBlob = createHash("sha1").update(Buffer.concat([blobHeader, bytes])).digest("hex");
    expect(sha256).toBe("4B99F11BE7576C0469E769314C20629B457800A8BE09C2731FA27F7B0B1E812B");
    expect(gitBlob).toBe("4716df010310c49d51ab27bdf3812cd4364ceb1b");
    expect(bytes.length).toBe(53364);
    const sourceText = bytes.toString("utf8");
    expect(sourceText.split("\n").length - (sourceText.endsWith("\n") ? 1 : 0)).toBe(912);
    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.includes(0x0d)).toBe(false);
  });
});

type Mutant = { name: string; from: string; to: string; killedBy: string[]; wrong: string };

// Each mutant must load, reach the public result and return its named wrong closed code.
const MUTANTS: Mutant[] = [
  {
    name: "switchless unknown",
    from: "$class = 'DEFAULT'",
    to: "$class = 'CHROME_AMBIGUOUS'",
    killedBy: ["L7 switchless Chrome root is DEFAULT and never blocks"],
    wrong: "CHROME_AMBIGUOUS",
  },
  {
    name: "parent-snapshot tree",
    from: "$members = @(Get-SelectorJobMembers $Run $Native $Held)",
    to: PARENT_SNAPSHOT,
    killedBy: ["L4 switchless grandchild after intermediate and driver exit is RUN"],
    wrong: "RUN_TRACKING_INCOMPLETE",
  },
  {
    name: "PID-only membership",
    from: "if ($member.InJob -and $member.Alive) {",
    to: "if ($member.Alive) {",
    killedBy: ["L4 reused PID non-member is not RUN"],
    wrong: "RUN_TREE_ALIVE",
  },
  {
    name: "tracking loss DEFAULT",
    from: "if ($tracking.state -ceq 'LOST') { $result.code = 'RUN_TRACKING_INCOMPLETE'; return $result }",
    to: "",
    killedBy: ["L3 launched run whose job handle fails"],
    wrong: "CLEAR",
  },
  {
    name: "raw substring",
    from: "return $Inner.Equals($Outer, $script:SelectorPathComparison) -or $Inner.StartsWith($Outer.TrimEnd('\\') + '\\', $script:SelectorPathComparison)",
    to: "return $Inner.IndexOf($Outer, $script:SelectorPathComparison) -ge 0",
    killedBy: ["L5 not a reference: lone profile-backup sibling"],
    wrong: "RUN_PROFILE_REFERENCED",
  },
  {
    // Retargeted for #9651 R1; every failed entry open still continues the walk.
    name: "lexical failure gate",
    from: "if ($entry.Opened -or $entry.Code -notin $absent) { break }",
    to: "if ($false) { break }",
    killedBy: [
      "L5 denied lexically unrelated alias is UNRESOLVED",
      "L5 123 (iii) invalid tail under a denied lexically unrelated alias is UNRESOLVED",
    ],
    wrong: "CLEAR",
  },
  {
    name: "ordinal case",
    from: "$script:SelectorPathComparison = [StringComparison]::OrdinalIgnoreCase",
    to: "$script:SelectorPathComparison = [StringComparison]::Ordinal",
    killedBy: ["L5 case-variant tail before the profile exists"],
    wrong: "CLEAR",
  },
  {
    name: "file-only holders",
    from: "foreach ($holder in @(& $Native.Holders $entry.path)) { [void]$pids.Add([long]$holder) }",
    to: "if (-not $entry.directory) { foreach ($holder in @(& $Native.Holders $entry.path)) { [void]$pids.Add([long]$holder) } }",
    killedBy: ["L6 non-run directory holder"],
    wrong: "CLEAR",
  },
  {
    name: "name self-exclusion",
    from: "$foreign = @($entries.pids | Where-Object { $_ -ne $self.pid -and -not $memberPids.Contains([long]$_) })",
    to: NAME_EXCLUSION,
    killedBy: ["L6 same-name non-run holder is HELD"],
    wrong: "CLEAR",
  },
  {
    name: "unreadable Chrome DEFAULT",
    from: "$class = 'CHROME_UNREADABLE'",
    to: "$class = 'DEFAULT'",
    killedBy: ["L7 unreadable Chrome command line"],
    wrong: "CLEAR",
  },
  {
    name: "CLEAR on collector error",
    from: "$result.code = 'CENSUS_INCOMPLETE' # collector or resolver failure",
    to: "$result.code = 'CLEAR'",
    killedBy: ["L2 process enumeration failure"],
    wrong: "CLEAR",
  },
  {
    name: "stale PID list as empty job",
    from: "if (-not $members.Count -and (& $Native.JobActive $Run.job) -ne 0) { return @{ state = 'LOST'; members = @() } }",
    to: "",
    killedBy: ["L3 member born behind the job PID list as its parent exits"],
    wrong: "CLEAR",
  },
  {
    name: "deadline after root resolution",
    from: "$deadline = (& $Native.Now).AddMilliseconds($script:SelectorCensusTimeoutMs)\n    $context = Get-SelectorRunPaths $Root $Native",
    to: "$context = Get-SelectorRunPaths $Root $Native\n    $deadline = (& $Native.Now).AddMilliseconds($script:SelectorCensusTimeoutMs)",
    killedBy: ["L2 root resolution past the deadline"],
    wrong: "CLEAR",
  },
  {
    name: "no classification deadline",
    from: "if ((& $Native.Now) -gt $deadline) { throw 'CLASSIFICATION_TIMEOUT' }",
    to: "",
    killedBy: ["L2 reference resolution past the deadline"],
    wrong: "CLEAR",
  },
  {
    name: "123 unresolved",
    from: "$absent = if ($Candidate) { 2, 3, 123 } else { 2, 3 }",
    to: "$absent = 2, 3",
    killedBy: [
      "L5 123 (i) embedded-drive compound token over an unrelated prefix is CLEAR",
      "L5 123 (i) redirection compound token over an unrelated prefix is CLEAR",
    ],
    wrong: "REFERENCE_UNRESOLVED",
  },
  {
    name: "123 discard candidate",
    from: "if ($entry.Opened -or $entry.Code -notin $absent) { break }",
    to: "if ($Candidate -and $entry.Code -eq 123) { $resolved = @{ state = 'RESOLVED'; text = $null }; break }; if ($entry.Opened -or $entry.Code -notin $absent) { break }",
    killedBy: [
      "L5 123 (ii) invalid tail under the profile is REFERENCED",
      "L5 123 (ii) invalid tail before the profile exists is REFERENCED",
      "L5 123 (ii) invalid tail through a junction into the profile is REFERENCED",
      "L5 123 (ii) invalid tail through an 8.3 name of the profile is REFERENCED",
      "L5 123 (ii) invalid tail through a subst drive is REFERENCED",
    ],
    wrong: "CLEAR",
  },
  {
    name: "123 anywhere is absent",
    from: "$entry = & $Context.native.Open $prefix $false",
    to: "$entry = & $Context.native.Open $prefix $false; if ($entry.Code -eq 123 -or ($entry.Code -eq 0 -and (& $Context.native.Open $prefix $true).Code -eq 123)) { continue }",
    killedBy: [
      "L5 123 (iv) failed follow 123 after a 123 is UNRESOLVED",
      "L5 123 (iv) metadata query 123 on an opened entry is UNRESOLVED",
    ],
    wrong: "CLEAR",
  },
  {
    name: "failed-follow skip",
    from: "$final = if ($followed.Code -eq 0) { ConvertTo-SelectorPath $followed.Final $Context.names } else { $null }",
    to: "$final = if ($followed.Code -eq 0) { ConvertTo-SelectorPath $followed.Final $Context.names } else { $null }; if ($final -isnot [hashtable]) { continue }",
    killedBy: [
      "L5 123 (iii) invalid tail under an existing dangling junction is UNRESOLVED",
      "L5 123 (iv) failed follow 2 after a 123 is UNRESOLVED",
      "L5 123 (iv) failed follow 3 after a 123 is UNRESOLVED",
      "L5 123 (iv) final-path query failure after a 123 is UNRESOLVED",
      "L5 123 (iv) unparseable final path after a 123 is UNRESOLVED",
    ],
    wrong: "CLEAR",
  },
  {
    name: "metadata failure as absent",
    from: "if ($entry.Opened -or $entry.Code -notin $absent) { break }",
    to: "if ($entry.Code -notin $absent) { break }",
    killedBy: [
      "L5 123 (iv) metadata query 2 on an opened entry is UNRESOLVED",
      "L5 123 (iv) metadata query 123 on an opened entry is UNRESOLVED",
    ],
    wrong: "CLEAR",
  },
  {
    name: "lexical text without a canonical prefix",
    from: "$resolved = $unresolved",
    to: "$resolved = @{ state = 'RESOLVED'; text = $text }",
    killedBy: [
      "L5 123 (iv) no canonical existing prefix (drive root 3) is UNRESOLVED",
      "L5 123 (iv) no canonical existing prefix (drive root 123) is UNRESOLVED",
      "L5 no canonical existing prefix is UNRESOLVED without a 123",
    ],
    wrong: "CLEAR",
  },
  {
    name: "123 continues root resolution",
    from: "$absent = if ($Candidate) { 2, 3, 123 } else { 2, 3 }",
    to: "$absent = 2, 3, 123",
    killedBy: [
      "L5 123 (v) injected run-root 123 refuses before collection",
      "L5 123 (v) default-root 123 refuses before collection",
      "L5 123 (v) Chrome user-data-dir 123 stays CHROME_AMBIGUOUS",
    ],
    wrong: "CLEAR",
  },
  {
    name: "shared candidate cache",
    from: "$cache = if ($Candidate) { $Context.candidateCache } else { $Context.cache }",
    to: "$cache = $Context.cache",
    killedBy: ["L5 123 (v) Chrome user-data-dir 123 stays CHROME_AMBIGUOUS"],
    wrong: "CLEAR",
  },
];

const WITNESS_MUTANTS: Mutant[] = [
  {
    name: "W3-bound D1",
    from: "$result.d1 = $result.w4.defaultRootDigest",
    to: "",
    killedBy: ["witness is INVALID when a default Chrome root restarts between W3 and W4"],
    wrong: "PASS",
  },
  {
    name: "final-only D1",
    from: " -or $Result.w3.defaultRootDigest -cne $Result.d0",
    to: "",
    killedBy: ["witness is INVALID when a W3 default-root removal is restored by W4"],
    wrong: "PASS",
  },
  {
    // #9651 R1 (v): the run root is admitted under the strict gate before anything is created.
    name: "123 continues root resolution before creation",
    from: "$absent = if ($Candidate) { 2, 3, 123 } else { 2, 3 }",
    to: "$absent = 2, 3, 123",
    killedBy: ["witness refuses a root the OS reports as 123 before any creation or deletion"],
    wrong: "FAIL",
  },
];

describe("selector-run-profile-census-law mutants", () => {
  const source = readFileSync(script, "utf8");
  const cases = lawCases();
  it.each(MUTANTS.map((mutant) => [mutant.name, mutant] as const))("%s FAILS its named law cases", (_name, mutant) => {
    expect(source.split(mutant.from)).toHaveLength(2);
    const targets = mutant.killedBy.map((name) => cases.find((entry) => entry.name === name));
    for (const target of targets) expect(target).toBeDefined();
    const mutated = path.join(scratch, `mutant-${mutant.name.replaceAll(/[^a-z0-9]+/gi, "-")}.ps1`);
    writeFileSync(
      mutated,
      source.replace(mutant.from, () => mutant.to),
    );
    const outcomes = run(targets as Case[], mutated);
    for (const target of targets as Case[]) {
      // Killed behaviourally: the mutant still returns a closed census, with the named wrong code.
      expectClosedCensus(outcomes[target.name].value);
      expect(target.expect).not.toBe(mutant.wrong);
      expect(code(outcomes[target.name])).toBe(mutant.wrong);
    }
  });
});

describe("selector-run-profile-census-witness mutants", () => {
  const source = readFileSync(script, "utf8");
  const cases = witnessCases();
  it.each(WITNESS_MUTANTS.map((mutant) => [mutant.name, mutant] as const))(
    "%s FAILS its named witness case",
    (_name, mutant) => {
      expect(source.split(mutant.from)).toHaveLength(2);
      const targets = mutant.killedBy.map((name) => cases.find((entry) => entry.name === name));
      for (const target of targets) expect(target).toBeDefined();
      const mutated = path.join(scratch, `witness-mutant-${mutant.name.replaceAll(/[^a-z0-9]+/gi, "-")}.ps1`);
      writeFileSync(
        mutated,
        source.replace(mutant.from, () => mutant.to),
      );
      const outcomes = run(targets as Case[], mutated);
      for (const target of targets as Case[]) {
        // Killed behaviourally: a closed witness result with the named wrong verdict.
        const value = outcomes[target.name].value as Witness;
        expect(Object.keys(value)).toEqual(WITNESS_KEYS);
        expect(target.expect).not.toBe(mutant.wrong);
        expect(value.verdict).toBe(mutant.wrong);
      }
    },
  );
});

const drainsOf = (history: string) => WRITES.map(([write]) => `start ${write}: ${history}`);
const START_MUTANTS: Mutant[] = [
  {
    name: "instant empty check",
    from: "& $Native.Sleep $script:SelectorDrainPollMs",
    to: "break",
    killedBy: drainsOf("driver exits, then the held job drains 1->0 inside the budget"),
    wrong: "PENDING",
  },
  {
    name: "timeout reset",
    from: "while ($exited) {",
    to: "if ($exited) { $deadline = (& $Native.Now).AddMilliseconds($script:SelectorGrantTimeoutMs) }; while ($exited) {",
    killedBy: drainsOf("driver exit spends the budget and zero comes only after the deadline"),
    wrong: "REFUSED",
  },
  {
    name: "drain without exit",
    from: "while ($exited) {",
    to: "while ($true) {",
    killedBy: ["start keeps a failed exit wait PENDING even when the job is empty"],
    wrong: "REFUSED",
  },
];

describe("selector-run-profile-census-boundary mutants", () => {
  const source = readFileSync(script, "utf8");
  const cases = startCases();
  it.each(START_MUTANTS.map((mutant) => [mutant.name, mutant] as const))(
    "%s FAILS its named start cases",
    (_name, mutant) => {
      expect(source.split(mutant.from)).toHaveLength(2);
      const targets = mutant.killedBy.map((name) => cases.find((entry) => entry.name === name));
      for (const target of targets) expect(target).toBeDefined();
      const mutated = path.join(scratch, `start-mutant-${mutant.name.replaceAll(/[^a-z0-9]+/gi, "-")}.ps1`);
      writeFileSync(
        mutated,
        source.replace(mutant.from, () => mutant.to),
      );
      const outcomes = run(targets as Case[], mutated);
      for (const target of targets as Case[]) {
        // Killed behaviourally: a closed start result with the named wrong state, never a load failure.
        const value = outcomes[target.name].value as Started;
        expect(["GRANTED", "PENDING", "REFUSED"]).toContain(value.state);
        expect(target.expect).not.toBe(mutant.wrong);
        expect(value.state).toBe(mutant.wrong);
      }
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

  it("refuses a withheld, failed or thrown grant only after exit and drain inside one fixed budget", () => {
    const drains = drainCases();
    expect(drains).toHaveLength(WRITES.length * DRAINS.length);
    for (const entry of drains) {
      const calls = outcomes[entry.name].calls;
      const closed = calls.indexOf("CloseWriter");
      const waits = calls.filter((call) => call.startsWith("WaitExit:"));
      // One wait, after EOF on the grant pipe, for no more than the single fixed budget.
      expect(waits).toHaveLength(1);
      const waited = calls.indexOf(waits[0]);
      expect(closed).toBeGreaterThan(-1);
      expect(closed).toBeLessThan(waited);
      expect(Number(waits[0].slice("WaitExit:".length))).toBeGreaterThan(SELECTOR_GRANT_TIMEOUT_MS - 10);
      expect(Number(waits[0].slice("WaitExit:".length))).toBeLessThanOrEqual(SELECTOR_GRANT_TIMEOUT_MS);
      // Job accounting is polled only after the driver's exit, and only that job's count.
      expect(calls.slice(0, waited)).not.toContain("JobActive");
      const polls = calls.slice(waited + 1);
      expect(polls.every((call) => call === "JobActive" || call.startsWith("Sleep:") || call === "CloseWriter")).toBe(
        true,
      );
      if (entry.name.endsWith("driver never exits")) expect(polls).not.toContain("JobActive");
      if (entry.name.endsWith("drains 1->0 inside the budget")) {
        expect(polls.filter((call) => call === "JobActive")).toHaveLength(2);
        expect(polls).toContain("Sleep:25");
      }
    }
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
