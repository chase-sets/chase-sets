import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { crc32, deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CI_GATE_DEFINITIONS } from "./ci-gate-plan.mjs";
import { gitListingOptions } from "./lib/git-listing.mjs";
import {
  deriveBootstrapDbCaseIdentities,
  deriveBootstrapDbMeasuredOneFewerUnitFloor,
} from "../deployables/platform-api/scripts/check-bootstrap-db-enrollment.mjs";
import {
  CHECKER,
  FIXTURES,
  INPUT_SCHEMA,
  LITERALS,
  MANIFEST,
  MEMO,
  MEMO_SCHEMA,
  ORACLE,
  PAYLOADS,
  PLATFORM,
  PRODUCER,
  WORKFLOW,
  acceptCompletedArtifact,
  admitProfile,
  canonical,
  checkApplication,
  cleanInput,
  collectPages,
  discoverCompletedArtifact,
  expectedKeys,
  hashGitFiles,
  inspectChecker,
  parseCommand,
  parseManifest,
  preOpenMergeability,
  preflightWorkflow,
  readArtifactZip,
  sha256,
  spawnGit,
  validateArtifact,
  validateIndependentProfile,
  validateLiterals,
  validateReceipt,
  validateWorkloadBaseline,
} from "./bootstrap-db-oracle-memo-artifact.mjs";

const directories = [];
afterAll(() => {
  expect(resolve(hashFixture.directory).startsWith(join(resolve(tmpdir()), "11214-impl-g7-"))).toBe(true);
});
afterAll(() => {
  for (const directory of directories) {
    expect(directory.startsWith(join(tmpdir(), "11214-impl-g7-"))).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
const bytes = (v) => Buffer.from(canonical(v));
const copy = (v) => structuredClone(v);
const workflowText = readFileSync(WORKFLOW, "utf8");
const shape = await inspectChecker(readFileSync(CHECKER, "utf8"));
const git = (cwd, args) =>
  execFileSync(
    "git",
    ["-C", cwd, ...args],
    gitListingOptions({ encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
  ).trim();

const hashFixture = (() => {
  const directory = resolve(mkdtempSync(join(tmpdir(), "11214-impl-g7-hashes-")));
  directories.push(directory);
  git(directory, ["init", "--quiet"]);
  const entries = [];
  const expected = new Map();
  const store = (data) => ({
    oid: execFileSync("git", ["-C", directory, "hash-object", "-w", "--stdin"], {
      input: data,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim(),
    digest: createHash("sha256").update(data).digest("hex"),
    size: data.length,
  });
  const add = (path, object, mode = "100644") => {
    entries.push(`${mode} blob ${object.oid}\t${path}\0`);
    expected.set(path, object.digest);
  };
  const small = [store(Buffer.from([0, 10, 13, 128, 255, 1])), store(Buffer.from([255, 13, 0, 254, 10, 2]))];
  add("small-a.bin", small[0]);
  add("small-b.bin", small[1], "100755");
  add("link.bin", small[0], "120000");
  const countPaths = Array.from({ length: 129 }, (_, i) => `count-${String(i).padStart(3, "0")}.bin`);
  for (const [i, path] of countPaths.entries()) add(path, small[i % 2]);
  const largeBytes = Buffer.alloc(16 * 1024 * 1024 + 1, 0xa5);
  largeBytes.set([0, 10, 13, 255]);
  const large = store(largeBytes);
  add("large.bin", large);
  const mediumPaths = Array.from({ length: 4 }, (_, i) => `medium-${i}.bin`);
  for (const [i, path] of mediumPaths.entries()) {
    const data = Buffer.alloc(8 * 1024 * 1024 + 1, 0x80 + i);
    data.set([0, 10, 13, 255, i]);
    add(path, store(data));
  }
  const tree = execFileSync("git", ["-C", directory, "mktree", "-z"], {
    input: Buffer.from(entries.join("")),
    encoding: "utf8",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  const commit = git(directory, [
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit-tree",
    tree,
    "-m",
    "Synthetic immutable hashing fixture, not hosted evidence",
  ]);
  return { directory, commit, expected, countPaths, mediumPaths, large };
})();

async function traceHashCall(name, call) {
  const path = join(hashFixture.directory, `${name}.trace`);
  const previous = process.env.GIT_TRACE;
  try {
    process.env.GIT_TRACE = path;
    const hashes = await call();
    const commands = readFileSync(path, "utf8").split(/\r?\n/);
    const batches = commands.filter((line) => /built-in: git cat-file --batch$/.test(line)).length;
    const streams = commands.filter((line) => /built-in: git cat-file blob [a-f0-9]{40}$/.test(line));
    console.info(`hashGitFiles ${name}: payload batches=${batches}, streaming children=${streams.length}`);
    return { hashes, batches, streams };
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previous;
  }
}

const renderChecker = (values) =>
  LITERALS.reduce((s, n) => s.replace(`<${n}>`, `Object.freeze(${JSON.stringify(values[n])})`), shape.skeleton);

async function profile(runId, offset, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "11214-impl-g7-profile-"));
  directories.push(directory);
  const put = (path, data) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), data);
  };
  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "core.autocrlf", "false"]);
  const commit = (message) => {
    git(directory, ["add", "."]);
    git(directory, [
      "-c",
      "user.name=Synthetic Test",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "--quiet",
      "-m",
      message,
    ]);
    return { commit: git(directory, ["rev-parse", "HEAD"]), tree: git(directory, ["rev-parse", "HEAD^{tree}"]) };
  };
  const literals = copy(shape.values);
  const names = Object.keys(literals.bootstrapDbEnrollmentManifest);
  const files = [];
  put(`${PLATFORM}/src/test-support/bootstrap-db-test-support.ts`, "export const synthetic = true;\n");
  for (const [i, name] of names.entries()) {
    const source = `import {synthetic,createPlatformApiBootstrapTestHarness} from '../src/test-support/bootstrap-db-test-support';\nconst harness=createPlatformApiBootstrapTestHarness('synthetic_${i}');\nit('synthetic ${i}',()=>{ expect(synthetic).toBe(true); });\n`;
    put(`${PLATFORM}/__tests__/${name}`, source);
    const [{ identity }] = deriveBootstrapDbCaseIdentities(name, source);
    const durationMs = 95000 + 2 ** i + offset;
    const executionUnit = `test:db:${(i % 3) + 1}`;
    literals.bootstrapDbEnrollmentManifest[name] = {
      executionUnit,
      databaseSuffix: `synthetic_${i}`,
      bootBearingCases: "all",
      cases: [{ name: `synthetic ${i}`, referenceDurationMs: Math.ceil(durationMs), identity }],
    };
    files.push({
      fileName: name,
      testPath: `__tests__/${name}`,
      sourceSha256: sha256(Buffer.from(source)),
      executionUnit,
      cases: [{ name: `synthetic ${i}`, durationMs, referenceDurationMs: Math.ceil(durationMs), identity }],
      residualMs: 60000,
    });
  }
  const nonSource = "it('non-bootstrap',()=>{ expect(process.env.TEST_DATABASE_URL).toBeDefined(); });\n";
  put(`${PLATFORM}/__tests__/non-bootstrap.db.test.ts`, nonSource);
  put(`${PLATFORM}/vitest.config.ts`, "export default {test:{include:['__tests__/**/*.test.ts']}};\n");
  const scripts = Object.fromEntries(
    [1, 2, 3].map((n) => [
      `test:db:${n}`,
      `vitest run ${files
        .filter((f) => f.executionUnit === `test:db:${n}`)
        .map((f) => f.testPath)
        .join(" ")}${n === 1 ? " __tests__/non-bootstrap.db.test.ts" : ""}`,
    ]),
  );
  put(`${PLATFORM}/package.json`, bytes({ scripts }));
  put("package.json", bytes({ packageManager: "pnpm@11.0.9" }));
  put("pnpm-lock.yaml", "synthetic locked dependencies\n");
  put(CHECKER, renderChecker(literals));
  for (const path of [PRODUCER, ORACLE, MEMO]) put(path, readFileSync(path));
  const S = commit("Synthetic source, not hosted evidence");
  put(".github/workflows/10365-bootstrap-db-input-capture.yml", "name: Synthetic capture only\n");
  const W = commit("Synthetic capture-only child");
  git(directory, ["switch", "--quiet", "--detach", S.commit]);
  put(WORKFLOW, workflowText);
  const T = commit("Synthetic landed route");
  git(directory, ["update-ref", "refs/remotes/origin/main", T.commit]);
  git(directory, ["switch", "--quiet", "--detach", S.commit]);
  const provenance = {
    repository: "chase-sets/chase-sets",
    runId,
    runAttempt: "1",
    referenceJobId: Number(runId) + 1,
    checkoutSha: W.commit,
    sourceBase: S.commit,
    captureParent: S.commit,
    parents: [S.commit],
    node: "v24.22.1",
    pnpm: "11.0.9",
    vitest: "synthetic",
    imageOS: "synthetic",
    imageVersion: "synthetic",
    postgresImageDigests: [],
    maxWorkers: 3,
    workspaceConcurrency: 2,
    laneMode: null,
    modeledUnitCeilingMs: 420000,
    modeledAggregateCeilingMs: 1080000,
    artifactSha256: "a".repeat(64),
  };
  const model = {
    ...literals.bootstrapDbScheduleModel,
    referenceRunId: Number(runId),
    referenceJobId: Number(runId) + 1,
    referenceJobName: "Synthetic accepted capture",
    referenceHeadSha: W.commit,
    referenceEvent: "workflow_dispatch",
    testFileFixedCostMs: 60000,
    executionUnitFixedCostMs: 0,
    jobOverheadMs: 0,
  };
  const current = {
    provenance: { ...provenance, role: "current-three-unit" },
    jobWallMs: 0,
    model,
    measuredUnits: [1, 2, 3].map((n) => ({ unit: `test:db:${n}`, observedDurationMs: 0, residualMs: 0 })),
    files,
    nonBootstrapFiles: [
      {
        testPath: "__tests__/non-bootstrap.db.test.ts",
        sourceSha256: sha256(Buffer.from(nonSource)),
        executionUnit: "test:db:1",
      },
    ],
    sourceBindings: {},
  };
  const paired = copy(current);
  paired.provenance.role = "paired-two-unit";
  paired.provenance.referenceJobId = Number(runId) + 2;
  paired.model.referenceJobId = Number(runId) + 2;
  paired.files.forEach((f, i) => {
    f.executionUnit = i >= 8 ? "test:db:2" : "test:db:1";
  });
  const floor = deriveBootstrapDbMeasuredOneFewerUnitFloor({ shippedCapture: current, pairedCapture: paired });
  expect(floor.refusal).toBeNull();
  literals.bootstrapDbScheduleModel = model;
  literals.bootstrapDbExecutionUnitBootBearingCaseCeilings = { "test:db:1": 4, "test:db:2": 4, "test:db:3": 4 };
  literals.platformApiNonBootstrapDbCensus = {
    referenceRunId: Number(runId),
    referenceJobId: Number(runId) + 1,
    entries: { "__tests__/non-bootstrap.db.test.ts": "test:db:1" },
  };
  literals.bootstrapDbMeasuredOneFewerUnitFloor = floor.floor;
  mutate(literals);
  const fixtures = {
    current: { path: `${FIXTURES}/bootstrap-db-capture-${runId}.json`, sha256: sha256(bytes(current)) },
    paired: { path: `${FIXTURES}/bootstrap-db-capture-${runId}-paired.json`, sha256: sha256(bytes(paired)) },
    baseline: {
      path: `${FIXTURES}/db-enrollment-workload-${runId}.json`,
      sha256: sha256(bytes({ synthetic: "baseline data; workload tested separately" })),
    },
  };
  put(CHECKER, renderChecker(literals));
  put(fixtures.current.path, bytes(current));
  put(fixtures.paired.path, bytes(paired));
  put(fixtures.baseline.path, bytes({ synthetic: "baseline data; workload tested separately" }));
  const E = commit("Synthetic accepted E projection");
  const changed = git(directory, ["diff", "--name-only", S.commit, E.commit]).split("\n").sort();
  const m = {
    schema: INPUT_SCHEMA,
    repository: "chase-sets/chase-sets",
    S,
    W,
    R: { runId, attempt: 1, currentJobId: String(Number(runId) + 1), pairedJobId: String(Number(runId) + 2) },
    E,
    T,
    fixtures,
    checkerLiterals: literals,
    inputDelta: changed.map((path) => ({
      path,
      beforeSha256:
        path === CHECKER ? sha256(execFileSync("git", ["-C", directory, "show", `${S.commit}:${path}`])) : null,
      afterSha256: sha256(readFileSync(join(directory, path))),
    })),
    readClosureSha256: sha256(
      execFileSync("git", ["-C", directory, "ls-tree", "-rz", "--full-tree", E.commit], gitListingOptions({})),
    ),
    toolchain: {
      node: "v24.22.1",
      pnpm: "11.0.9",
      lockSha256: sha256(readFileSync(join(directory, "pnpm-lock.yaml"))),
    },
  };
  put(MANIFEST, bytes(m));
  put(WORKFLOW, workflowText);
  const D = commit("Synthetic data-only D");
  const G = {
    commit: git(directory, [
      "-c",
      "user.name=Synthetic Test",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit-tree",
      D.tree,
      "-p",
      T.commit,
      "-p",
      D.commit,
      "-m",
      "Synthetic merge identity",
    ]),
    tree: D.tree,
  };
  git(directory, ["switch", "--quiet", "--detach", E.commit]);
  const digest = sha256(bytes(m));
  const event = {
    eventName: "pull_request",
    action: "opened",
    repository: "chase-sets/chase-sets",
    prNumber: 9001 + offset,
    headRef: `memo-derivation/synthetic-${runId}`,
    head: D,
    base: T,
    merge: G,
    openedMergeState: "null",
    openedMergeSha: null,
    ref: `refs/pull/${9001 + offset}/merge`,
    bodySha256: sha256(Buffer.from(`bootstrap-db-oracle-memo-input-sha256: ${digest}\n`)),
    bodyBytes: 104,
  };
  return { directory, m, current, paired, event, digest, put, commit };
}

const first = await profile("990000001", 0);
const second = await profile("990000101", 11);
const sameExtra = await profile("990000201", 23, (v) => {
  Object.values(v.bootstrapDbEnrollmentManifest)[0].cases[0].unexpected = true;
});
const foreignMap = await profile("990000301", 31, (v) => {
  v.platformApiNonBootstrapDbCensus.entries["__tests__/foreign.db.test.ts"] = "test:db:1";
});
const admissionPrefix = "admitProfile binds two profiles and rejects stale foreign dirty widened input";
const nullFloorPrefix = "independently derived null floor is eligible but malformed or mismatched pairs are not";
const nullFloorProfile = () => {
  const m = copy(first.m);
  const paired = copy(first.paired);
  paired.files.forEach((f, i) => {
    f.executionUnit = `test:db:${(i % 2) + 1}`;
  });
  m.checkerLiterals.bootstrapDbMeasuredOneFewerUnitFloor = null;
  return { m, fixtures: { current: first.current, paired } };
};
const options = (p) => ({ objectRoot: p.directory, helperSha: p.m.T.commit, event: p.event, inputRoot: p.directory });

// Synthetic B/D pairs for the pre-open mergeability guard; no identity here is a real tuple.
const merge = (() => {
  const directory = mkdtempSync(join(tmpdir(), "11214-impl-g7-mergeability-"));
  directories.push(directory);
  git(directory, ["init", "--quiet"]);
  const run = (args, input) =>
    execFileSync("git", ["-C", directory, ...args], {
      input,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_INDEX_FILE: join(directory, ".git", "synthetic-index") },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const commit = (parents, files, message) => {
    run(parents.length ? ["read-tree", parents[0].commit] : ["read-tree", "--empty"]);
    for (const [path, value] of Object.entries(files)) {
      if (value === null) run(["update-index", "--force-remove", "--", path]);
      else {
        const [mode, data] = Array.isArray(value) ? value : ["100644", value];
        run(["update-index", "--add", "--cacheinfo", `${mode},${run(["hash-object", "-w", "--stdin"], data)},${path}`]);
      }
    }
    const tree = run(["write-tree"]);
    const identity = ["-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.invalid"];
    const parentArgs = parents.flatMap((p) => ["-p", p.commit]);
    return { commit: run([...identity, "commit-tree", tree, ...parentArgs, "-m", `${message}, not evidence`]), tree };
  };
  const route = "name: Synthetic memo route\n";
  const changedRoute = "name: Synthetic changed memo route\n";
  const manifest = (T) => bytes({ ...first.m, T });
  const T = commit([], { [WORKFLOW]: route, "shared.txt": "one\ntwo\nthree\n" }, "Synthetic landed route T");
  const B = commit([T], { "main-only.txt": "main\n" }, "Synthetic main B");
  const E = commit([T], { "input.txt": "input\n" }, "Synthetic input E");
  const D = commit([E], { [MANIFEST]: manifest(T) }, "Synthetic data-only D");
  const conflictD = commit(
    [commit([T], { "shared.txt": "one\nINPUT\nthree\n" }, "Synthetic conflicting E")],
    { [MANIFEST]: manifest(T) },
    "Synthetic conflicting D",
  );
  const otherT = commit([T], { [WORKFLOW]: changedRoute }, "Synthetic other route T");
  const left = commit([T], { "left.txt": "left\n" }, "Synthetic left");
  const right = commit([T], { "right.txt": "right\n" }, "Synthetic right");
  const corruptB = commit([B], { "corrupt.txt": "synthetic main side\n" }, "Synthetic B for a removed blob");
  return {
    directory,
    branch: "memo-derivation/synthetic-11222",
    // Independent expectations, computed once while building the fixture.
    cleanTree: run(["merge-tree", "--write-tree", B.commit, D.commit]),
    workflowBlob: run(["rev-parse", `${T.commit}:${WORKFLOW}`]),
    changedWorkflowBlob: run(["rev-parse", `${otherT.commit}:${WORKFLOW}`]),
    corruptBlob: run(["rev-parse", `${corruptB.commit}:corrupt.txt`]),
    T,
    B,
    E,
    D,
    conflictB: commit([T], { "shared.txt": "one\nMAIN\nthree\n" }, "Synthetic conflicting B"),
    conflictD,
    deleteB: commit([T], { "shared.txt": null }, "Synthetic structural B"),
    otherTD: commit([E], { [MANIFEST]: manifest(otherT) }, "Synthetic D naming other T"),
    routeB: commit([B], { [WORKFLOW]: changedRoute }, "Synthetic B with changed route"),
    routeD: commit([D], { [WORKFLOW]: changedRoute }, "Synthetic D with changed route"),
    executableD: commit([D], { [WORKFLOW]: ["100755", route] }, "Synthetic D with executable route"),
    garbledD: commit([E], { [MANIFEST]: "{not json\n" }, "Synthetic unparsable D"),
    shortTD: commit(
      [E],
      { [MANIFEST]: manifest({ commit: T.commit.slice(0, 12), tree: T.tree }) },
      "Synthetic short T",
    ),
    crossB: commit([left, right], { "right.txt": "right\n" }, "Synthetic criss-cross B"),
    crossD: commit([right, left], { "left.txt": "left\n" }, "Synthetic criss-cross D"),
    lonelyD: commit([], { "lonely.txt": "lonely\n" }, "Synthetic unrelated D"),
    corruptB,
    corruptD: commit([D], { "corrupt.txt": "synthetic head side\n" }, "Synthetic D for a removed blob"),
    manifest,
  };
})();
const liveRefs =
  (main, head, calls = []) =>
  (path) => {
    calls.push(path);
    if (path === "git/ref/heads/main") return { ref: "refs/heads/main", object: { sha: main, type: "commit" } };
    if (path === `git/ref/heads/${merge.branch}`)
      return { ref: `refs/heads/${merge.branch}`, object: { sha: head, type: "commit" } };
    throw Error("unexpected API request");
  };
// Fixture objects are immutable, so identical Git reads are memoized; every control still parses real Git output.
const gitReads = new Map();
const cachedGit = (directory, args, input = "") => {
  const key = JSON.stringify([directory, args, input]);
  if (!gitReads.has(key)) gitReads.set(key, spawnGit(directory, args, input));
  return gitReads.get(key);
};
const mergeInput = (base, head, overrides = {}) => ({
  base: base.commit,
  head: head.commit,
  branch: merge.branch,
  objectRoot: merge.directory,
  readApi: liveRefs(base.commit, head.commit),
  runGit: cachedGit,
  ...overrides,
});
const forcedGit = (command, result) => (directory, args, input) =>
  args[0] === command ? result : cachedGit(directory, args, input);
function refusesMergeability(input, message) {
  let record;
  expect(() => {
    record = preOpenMergeability(input);
  }).toThrow(message);
  expect(record).toBeUndefined();
}

function artifactFor(p) {
  const m = p.m;
  const memo = bytes({
    oracleSha256: "d3b96de0c4051a7021f8f00869d19dd13314166b8dc81244c2bb554a2493847b",
    entries: Object.fromEntries(expectedKeys(m.checkerLiterals).map((k) => [k, 1])),
  });
  const r = {
    schema: MEMO_SCHEMA,
    kind: "deterministic-derivation",
    manifestSha256: p.digest,
    profile: m,
    readClosure: { before: "b".repeat(64), after: "b".repeat(64) },
    producer: {
      command: "node __tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs",
      cwd: PLATFORM,
      stdout: { mode: "write", entries: 4095, sha256: sha256(memo), durationMs: 1.5 },
      startedAt: "2026-11-10T00:00:02.100Z",
      completedAt: "2026-11-10T00:00:03.100Z",
    },
    output: {
      path: PAYLOADS[0],
      sha256: sha256(memo),
      oracleSha256: "d3b96de0c4051a7021f8f00869d19dd13314166b8dc81244c2bb554a2493847b",
      keys: 4095,
    },
    event: p.event,
    run: {
      repository: m.repository,
      workflow: WORKFLOW,
      workflowRef: `${m.repository}/${WORKFLOW}@${p.event.ref}`,
      workflowSha: p.event.merge.commit,
      ref: p.event.ref,
      runId: "990000501",
      attempt: 1,
      jobKey: "deriveMemo",
      checkRunId: "990000502",
      checkout: m.E,
      helper: m.T,
      node: m.toolchain.node,
      pnpm: m.toolchain.pnpm,
      runnerOs: "Linux",
      runnerImage: "ubuntu-latest",
      runnerImageVersion: "synthetic",
    },
  };
  const rb = bytes(r);
  return {
    r,
    files: new Map([
      [PAYLOADS[0], memo],
      ["receipt.json", rb],
      ["SHA256SUMS", Buffer.from(`${sha256(memo)}  ${PAYLOADS[0]}\n${sha256(rb)}  receipt.json\n`)],
    ]),
  };
}

function zipFor(files, mutate = () => {}) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, b] of files) {
    const n = Buffer.from(name),
      compressed = deflateRawSync(b),
      crc = crc32(b);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(8, 8);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(compressed.length, 18);
    l.writeUInt32LE(b.length, 22);
    l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(b.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    mutate(c, l, name);
    local.push(l, n, compressed);
    central.push(c, n);
    offset += l.length + n.length + compressed.length;
  }
  const cd = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

function acceptance(p = first) {
  const { r, files } = artifactFor(p);
  const zip = zipFor(files);
  const freeze = {
    head: p.event.head.commit,
    base: p.event.base.commit,
    input: p.m.E.commit,
    manifestSha256: p.digest,
    bodySha256: p.event.bodySha256,
    observedAt: "2026-11-09T23:59:59.000Z",
    preflight: {
      workflowId: 990000701,
      path: WORKFLOW,
      state: "active",
      runs: [],
      observedAt: "2026-11-09T23:59:58.000Z",
    },
  };
  const run = {
    id: 990000501,
    workflow_id: 990000701,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    head_sha: freeze.head,
    path: WORKFLOW,
    event: "pull_request",
    repository: { full_name: p.m.repository },
    head_branch: p.event.headRef,
  };
  const jobs = [
    {
      id: 990000599,
      run_id: run.id,
      run_attempt: 1,
      head_sha: freeze.head,
      status: "completed",
      conclusion: "success",
      name: "Derive Canonical Bootstrap Memo",
      check_run_url: `https://api.github.com/repos/${p.m.repository}/check-runs/${r.run.checkRunId}`,
      started_at: "2026-11-10T00:00:00Z",
      completed_at: "2026-11-10T00:00:05Z",
      steps: [
        "Admit immutable profile",
        "Verify clean input",
        "Run fixed producer",
        "Validate canonical payloads",
        "Upload canonical memo",
      ].map((name, i) => ({
        name,
        status: "completed",
        conclusion: "success",
        started_at: `2026-11-10T00:00:0${i}Z`,
        completed_at: `2026-11-10T00:00:0${i + 1}Z`,
      })),
    },
  ];
  const artifact = {
    id: 990000601,
    name: `bootstrap-db-oracle-memo-${run.id}-1`,
    expired: false,
    workflow_run: { id: run.id, head_sha: freeze.head },
    digest: `sha256:${sha256(zip)}`,
    size_in_bytes: zip.length,
    created_at: "2026-11-10T00:00:04Z",
    expires_at: "2099-11-10T00:00:05Z",
  };
  const currentPr = {
    number: p.event.prNumber,
    head: { sha: freeze.head },
    base: { sha: freeze.base },
    body: `bootstrap-db-oracle-memo-input-sha256: ${p.digest}\n`,
    created_at: "2026-11-10T00:00:00Z",
    state: "open",
    merged: false,
  };
  return { m: p.m, manifestSha256: p.digest, freeze, currentPr, lifecycle: [], run, jobs, artifact, zip };
}

describe("PR-isolated canonical bootstrap memos", () => {
  it("actual opened bootstrap preserves absent/null M and refuses bad G context digest and members before code", () => {
    const script = parse(workflowText).jobs.deriveMemo.steps.find((s) => s.id === "bootstrap").run;
    const functionSource = script.slice(script.indexOf("function bootstrap("), script.indexOf("const context="));
    const normalizedAssert = Object.assign((value) => assert(value), assert, {
      deepEqual: (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))),
    });
    const bootstrap = runInNewContext(`${functionSource}; bootstrap`, {
      assert: normalizedAssert,
      Buffer,
      hash: sha256,
      sha: (s) => typeof s === "string" && /^[a-f0-9]{40}$/.test(s),
      repository: first.m.repository,
      workflow: WORKFLOW,
      manifestPath: MANIFEST,
    });
    const e = first.event;
    const event = {
      action: "opened",
      repository: { full_name: first.m.repository },
      pull_request: {
        number: e.prNumber,
        head: { repo: { full_name: first.m.repository }, ref: e.headRef, sha: e.head.commit },
        base: { repo: { full_name: first.m.repository }, ref: "main", sha: e.base.commit },
        body: `bootstrap-db-oracle-memo-input-sha256: ${first.digest}\n`,
        merge_commit_sha: null,
      },
    };
    const context = {
      eventName: "pull_request",
      attempt: "1",
      githubSha: e.merge.commit,
      ref: e.ref,
      workflowRef: `${first.m.repository}/${WORKFLOW}@${e.ref}`,
      workflowSha: e.merge.commit,
    };
    const read = (s, p) => (p === MANIFEST ? bytes(first.m) : Buffer.from(workflowText));
    const commit = (s) => ({
      sha: s,
      tree: {
        sha:
          s === e.merge.commit
            ? e.merge.tree
            : s === e.head.commit
              ? e.head.tree
              : s === first.m.E.commit
                ? first.m.E.tree
                : first.m.T.tree,
      },
      parents:
        s === e.merge.commit
          ? [{ sha: e.base.commit }, { sha: e.head.commit }]
          : s === e.head.commit
            ? [{ sha: first.m.E.commit }]
            : [],
    });
    const call = (ev = event, c = context, rd = read, cm = commit) => bootstrap(ev, c, rd, cm, () => {});
    expect(call().event.openedMergeState).toBe("null");
    const absent = copy(event);
    delete absent.pull_request.merge_commit_sha;
    expect(call(absent).event.openedMergeState).toBe("absent");
    const present = copy(event);
    present.pull_request.merge_commit_sha = e.merge.commit;
    expect(call(present).event.openedMergeState).toBe("sha");
    for (const mutate of [
      (x) => {
        x.pull_request.merge_commit_sha = "malformed";
      },
      (x) => {
        x.pull_request.merge_commit_sha = e.head.commit;
      },
      (x) => {
        x.pull_request.body = x.pull_request.body.replace(first.digest, "a".repeat(64));
      },
      (x) => {
        x.action = "synchronize";
      },
      (x) => {
        x.action = "reopened";
      },
      (x) => {
        x.pull_request.head.repo.full_name = "foreign/repo";
      },
    ]) {
      const bad = copy(event);
      mutate(bad);
      expect(() => call(bad)).toThrow();
    }
    for (const mutate of [
      (c) => {
        delete c.githubSha;
      },
      (c) => {
        delete c.workflowSha;
      },
      (c) => {
        c.attempt = "2";
      },
      (c) => {
        c.workflowRef = "foreign";
      },
    ]) {
      const bad = copy(context);
      mutate(bad);
      expect(() => call(event, bad)).toThrow();
    }
    expect(() =>
      call(event, context, (s, p) =>
        p === WORKFLOW && s === e.base.commit ? Buffer.from("wrong workflow") : read(s, p),
      ),
    ).toThrow();
    expect(() =>
      call(event, context, read, (s) =>
        s === e.merge.commit
          ? { ...commit(s), parents: [{ sha: first.m.E.commit }, { sha: e.head.commit }] }
          : commit(s),
      ),
    ).toThrow();
    expect(call().manifestSha256).toBe(first.digest);
  });

  it("actual parser closes every nested input/receipt object with unknown missing type duplicate and range controls", () => {
    const objects = (value, path = []) => {
      if (!value || typeof value !== "object") return [];
      const result = Array.isArray(value) ? [] : [path];
      for (const [k, v] of Object.entries(value)) result.push(...objects(v, [...path, k]));
      return result;
    };
    const at = (value, path) => path.reduce((v, k) => v[k], value);
    for (const p of [first, second]) {
      for (const path of objects(p.m)) {
        const unknown = copy(p.m);
        at(unknown, path).unexpected = true;
        expect(() => parseManifest(bytes(unknown), sha256(bytes(unknown))), `unknown ${path.join(".")}`).toThrow();
        const original = at(p.m, path),
          key = Object.keys(original)[0];
        if (key) {
          const missing = copy(p.m);
          delete at(missing, path)[key];
          if (path.at(-1) !== "entries")
            expect(() => parseManifest(bytes(missing), sha256(bytes(missing))), `missing ${path.join(".")}`).toThrow();
          const wrong = copy(p.m);
          at(wrong, path)[key] = [];
          expect(() => parseManifest(bytes(wrong), sha256(bytes(wrong))), `type ${path.join(".")}`).toThrow();
          const serialized = bytes(p.m).toString();
          const needle = JSON.stringify(key) + ":";
          const duplicate = Buffer.from(serialized.replace(needle, `${needle} null, ${needle}`));
          expect(() => parseManifest(duplicate, sha256(duplicate)), `duplicate ${path.join(".")}`).toThrow();
        }
      }
      const { r } = artifactFor(p);
      for (const path of objects(r).filter((path) => path[0] !== "profile")) {
        const unknown = copy(r);
        at(unknown, path).unexpected = true;
        expect(() => validateReceipt(unknown, p.m, p.digest), `receipt unknown ${path}`).toThrow();
        const key = Object.keys(at(r, path))[0];
        const missing = copy(r);
        delete at(missing, path)[key];
        expect(() => validateReceipt(missing, p.m, p.digest)).toThrow();
        const wrong = copy(r);
        at(wrong, path)[key] = [];
        expect(() => validateReceipt(wrong, p.m, p.digest)).toThrow();
      }
      const badCases = [0, 600001, true, 1.5, Number.MAX_SAFE_INTEGER + 1];
      const firstFile = Object.keys(p.m.checkerLiterals.bootstrapDbEnrollmentManifest)[0];
      for (const duration of badCases) {
        const bad = copy(p.m);
        bad.checkerLiterals.bootstrapDbEnrollmentManifest[firstFile].cases[0].referenceDurationMs = duration;
        expect(() => parseManifest(bytes(bad), sha256(bytes(bad)))).toThrow();
      }
      for (const ms of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        const bad = copy(p.m);
        bad.checkerLiterals.bootstrapDbMeasuredOneFewerUnitFloor.unitMakespansMs["test:db:1"] = ms;
        expect(() => parseManifest(bytes(bad), sha256(bytes(bad)))).toThrow();
      }
      const deep = copy(p.m);
      let nested = {};
      deep.toolchain.node = nested;
      for (let i = 0; i < 100; i++) {
        nested.child = {};
        nested = nested.child;
      }
      expect(() => parseManifest(bytes(deep), sha256(bytes(deep)))).toThrow("depth");
      expect(() => parseManifest(Buffer.alloc(262145), "a".repeat(64))).toThrow();
      for (const badDate of ["2026-02-30T00:00:00.000Z", "2026-11-10", "2026-11-10T00:00:00+00:00"]) {
        const bad = copy(r);
        bad.producer.startedAt = badDate;
        expect(() => validateReceipt(bad, p.m, p.digest)).toThrow();
      }
    }
  });

  it("same extra E and manifest field cannot manufacture schema authority", async () => {
    const p = sameExtra;
    const actual = await inspectChecker(readFileSync(join(p.directory, CHECKER), "utf8"));
    expect(Object.values(actual.values.bootstrapDbEnrollmentManifest)[0].cases[0].unexpected).toBe(true);
    expect(() => parseManifest(bytes(p.m), p.digest)).toThrow("unknown/missing");
    await expect(admitProfile(p.m, options(p))).rejects.toThrow("unknown/missing");
  });

  it("independent source census rejects the same foreign map member in E and manifest", async () => {
    const p = foreignMap;
    expect(parseManifest(bytes(p.m), p.digest)).toEqual(p.m);
    await expect(admitProfile(p.m, options(p))).rejects.toThrow("independently accepted S/pair keys/values/order");
  });

  it("uses the unchanged workload freshness validator and rejects baseline drift", async () => {
    const path = `${FIXTURES}/bootstrap-db-capture-41551303861.json`;
    const captureBytes = readFileSync(path);
    const current = JSON.parse(captureBytes);
    const baseline = JSON.parse(readFileSync(`${FIXTURES}/db-enrollment-workload-41551303861.json`));
    const m = { S: { commit: baseline.source.commit }, fixtures: { current: { path, sha256: sha256(captureBytes) } } };
    const derivation = { gaps: [], bindings: baseline.bindings };
    await expect(validateWorkloadBaseline(m, current, baseline, derivation)).resolves.toBeUndefined();
    const bad = copy(derivation);
    bad.bindings[0][2] = "changed";
    await expect(validateWorkloadBaseline(m, current, baseline, bad)).rejects.toThrow("independent baseline values");
  });

  for (const [name, p] of [
    ["first", first],
    ["second", second],
  ]) {
    it(`${admissionPrefix}: ${name} positive`, async () => {
      expect(parseManifest(bytes(p.m), p.digest)).toEqual(p.m);
      expect(await admitProfile(p.m, options(p))).toMatchObject({ current: p.current, paired: p.paired });
      cleanInput(p.directory, p.m);
    });

    it(`${admissionPrefix}: ${name} wrong helper`, async () => {
      await expect(admitProfile(p.m, { ...options(p), helperSha: p.m.E.commit })).rejects.toThrow("wrong helper");
    });

    it(`${admissionPrefix}: ${name} stale tree`, async () => {
      const stale = copy(p.m);
      stale.E.tree = "a".repeat(40);
      await expect(admitProfile(stale, options(p))).rejects.toThrow("E tree");
    });

    it(`${admissionPrefix}: ${name} foreign repository`, () => {
      const foreign = copy(p.m);
      foreign.repository = "foreign/repository";
      expect(() => parseManifest(bytes(foreign), sha256(bytes(foreign)))).toThrow("repository");
    });

    it(`${admissionPrefix}: ${name} dirty input`, async () => {
      try {
        p.put("dirty.txt", "untracked synthetic drift\n");
        await expect(admitProfile(p.m, options(p))).rejects.toThrow("dirty E");
      } finally {
        rmSync(join(p.directory, "dirty.txt"));
      }
    });

    it(`${admissionPrefix}: ${name} restored input`, async () => {
      try {
        p.put("dirty.txt", "untracked synthetic drift\n");
      } finally {
        rmSync(join(p.directory, "dirty.txt"));
      }
      expect(await admitProfile(p.m, options(p))).toMatchObject({ current: p.current });
    });
  }

  it(`${admissionPrefix}: wrong parent`, async () => {
    const wrongParent = copy(first.event);
    wrongParent.head = first.m.E;
    await expect(admitProfile(first.m, { ...options(first), event: wrongParent })).rejects.toThrow("D sole E");
  });

  it(`${admissionPrefix}: widened delta`, () => {
    const widened = copy(first.m);
    widened.inputDelta[0].path = "scripts/foreign.mjs";
    expect(() => parseManifest(bytes(widened), sha256(bytes(widened)))).toThrow("delta path");
  });

  it(`${admissionPrefix}: wrong merge`, async () => {
    const wrongMerge = copy(first.event);
    wrongMerge.merge = first.m.E;
    await expect(admitProfile(first.m, { ...options(first), event: wrongMerge })).rejects.toThrow();
  });

  it("hashGitFiles hashes immutable binary bytes and deduplicates unordered paths", async () => {
    const { directory, commit, expected } = hashFixture;
    const paths = ["small-b.bin", "small-a.bin", "small-b.bin", "small-a.bin"];
    const wanted = new Map(["small-a.bin", "small-b.bin"].map((path) => [path, expected.get(path)]));
    expect(await hashGitFiles(directory, commit, paths)).toEqual(wanted);
    const mutable = join(directory, "small-a.bin");
    try {
      writeFileSync(mutable, Buffer.from([99, 0, 255, 10]));
      expect(await hashGitFiles(directory, commit, paths)).toEqual(wanted);
    } finally {
      rmSync(mutable, { force: true });
    }
  });

  it("hashGitFiles streams a real binary blob above 16 MiB", async () => {
    const { directory, commit, expected, large } = hashFixture;
    expect(large.size).toBe(16 * 1024 * 1024 + 1);
    expect(large.size).toBeGreaterThan(16 * 1024 * 1024);
    const result = await traceHashCall("large", () => hashGitFiles(directory, commit, ["large.bin"]));
    expect(result.hashes).toEqual(new Map([["large.bin", expected.get("large.bin")]]));
    expect(result.batches).toBe(0);
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]).toMatch(new RegExp(`built-in: git cat-file blob ${large.oid}$`));
  });

  it("hashGitFiles splits 129 distinct regular paths at the 128-object boundary", async () => {
    const { directory, commit, expected, countPaths } = hashFixture;
    const result = await traceHashCall("count", () => hashGitFiles(directory, commit, countPaths));
    expect(result.hashes).toEqual(new Map(countPaths.map((path) => [path, expected.get(path)])));
    expect(result.hashes.size).toBe(129);
    expect(result.batches).toBeGreaterThanOrEqual(2);
    expect(result.streams).toHaveLength(0);
  });

  it("hashGitFiles splits four below-threshold blobs at the 16 MiB payload boundary", async () => {
    const { directory, commit, expected, mediumPaths } = hashFixture;
    const result = await traceHashCall("payload", () => hashGitFiles(directory, commit, mediumPaths));
    expect(result.hashes).toEqual(new Map(mediumPaths.map((path) => [path, expected.get(path)])));
    expect(result.batches).toBeGreaterThanOrEqual(4);
    expect(result.streams).toHaveLength(0);
  });

  it("hashGitFiles distinguishes missing, nonregular, mutable and unsafe source refusals", async () => {
    const { directory, commit, expected } = hashFixture;
    await expect(hashGitFiles(directory, commit, ["small-a.bin"])).resolves.toEqual(
      new Map([["small-a.bin", expected.get("small-a.bin")]]),
    );
    await expect(hashGitFiles(directory, commit, ["missing.bin"])).rejects.toThrow(
      "missing/nonregular immutable source: missing.bin",
    );
    await expect(hashGitFiles(directory, commit, ["link.bin"])).rejects.toThrow(
      "missing/nonregular immutable source: link.bin",
    );
    await expect(hashGitFiles(directory, "HEAD", ["small-a.bin"])).rejects.toThrow("immutable source commit required");
    await expect(hashGitFiles(directory, commit, ["../small-a.bin"])).rejects.toThrow("path traversal");
  });

  it("immutable object batches retain real bytes and refuse malformed framing", () => {
    const source = readFileSync(new URL("./bootstrap-db-oracle-memo-artifact.mjs", import.meta.url), "utf8");
    const parser = runInNewContext(
      `${source.slice(source.indexOf("function parseObjectBatch("), source.indexOf("function immutableReads("))}; parseObjectBatch`,
      {
        createHash: process.getBuiltinModule("node:crypto").createHash,
        same: assert.deepStrictEqual,
        requireThat: assert,
      },
    );
    const path = `${first.m.S.commit}:${CHECKER}`;
    const oid = git(first.directory, ["rev-parse", path]);
    const expected = execFileSync("git", ["-C", first.directory, "cat-file", "blob", oid]);
    const framed = execFileSync("git", ["-C", first.directory, "cat-file", "--batch"], { input: `${oid}\n` });
    const entries = [{ oid, type: "blob", size: expected.length }];
    expect(parser(framed, entries)[0]).toEqual(expected);
    for (const malformed of [
      framed.subarray(0, 20),
      framed.subarray(0, framed.indexOf(10)),
      framed.subarray(0, framed.length - 1),
      Buffer.concat([framed, Buffer.from("extra\n")]),
      Buffer.from(framed.toString("utf8").replace(`${oid} blob`, `${"a".repeat(40)} blob`)),
      Buffer.from(framed.toString("utf8").replace(`${oid} blob`, `${oid} tree`)),
      Buffer.from(framed.toString("utf8").replace(`blob ${expected.length}`, `blob ${expected.length + 1}`)),
    ])
      expect(() => parser(malformed, entries)).toThrow();
    const corrupt = Buffer.from(framed);
    corrupt[corrupt.indexOf(10) + 1] ^= 1;
    expect(() => parser(corrupt, entries)).toThrow("immutable object digest differs");
  });

  it(`${nullFloorPrefix}: valid null`, async () => {
    const { m, fixtures } = nullFloorProfile();
    const result = deriveBootstrapDbMeasuredOneFewerUnitFloor({
      shippedCapture: first.current,
      pairedCapture: fixtures.paired,
    });
    expect(result.floor).toBeNull();
    expect(result.refusal).toMatch(/within the .* per-unit ceiling$/);
    await expect(validateIndependentProfile(m, fixtures, options(first))).resolves.toBeUndefined();
  });

  it(`${nullFloorPrefix}: malformed pair`, async () => {
    const { m, fixtures } = nullFloorProfile();
    const malformed = copy(fixtures);
    malformed.paired.files[0].cases[0].durationMs = -1;
    await expect(validateIndependentProfile(m, malformed, options(first))).rejects.toThrow();
  });

  it(`${nullFloorPrefix}: mismatched pair`, async () => {
    const { m, fixtures } = nullFloorProfile();
    const mismatch = copy(fixtures);
    mismatch.paired.model.executionUnitCeilingMs++;
    await expect(validateIndependentProfile(m, mismatch, options(first))).rejects.toThrow();
  });

  it("admits only fixed producer and output", () => {
    expect(
      parseCommand(["derive", "--out", "../artifacts/bootstrap-db-oracle-memo/bootstrap-db-oracle-schedule-memo.json"])
        .command,
    ).toBe("derive");
    for (const argv of [
      [],
      ["node", "evil.mjs"],
      ["derive"],
      ["derive", "--out", "/tmp/memo"],
      ["admit", "--skip"],
      ["accept", "NaN", "1"],
      ["application", "main", "1", "2"],
    ])
      expect(() => parseCommand(argv)).toThrow();
    const job = parse(workflowText).jobs.deriveMemo;
    expect(job["timeout-minutes"]).toBe(30);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.steps.filter((s) => s.run?.includes(".mjs derive --out"))).toHaveLength(1);
    expect(job.steps.some((s) => s.uses?.includes("download-artifact"))).toBe(false);
    expect(
      job.steps
        .filter((s) => s.uses?.startsWith("actions/checkout@"))
        .every((s) => s.with["persist-credentials"] === false),
    ).toBe(true);
    const admit = job.steps.findIndex((s) => s.name === "Admit immutable profile");
    const inputInstall = job.steps.findIndex((s) => s.name === "Install locked input dependencies");
    expect(admit).toBeLessThan(inputInstall);
    expect(job.steps.findIndex((s) => s.name === "Bind opened data before selected code")).toBeLessThan(
      job.steps.findIndex((s) => s.name === "Install locked trusted tools"),
    );
  });

  it("rejects partial artifact and wrong bytes paths keys provenance", () => {
    for (const p of [first, second]) {
      const { files } = artifactFor(p);
      expect(validateArtifact(files, p.m, p.digest).schema).toBe(MEMO_SCHEMA);
      expect(readArtifactZip(zipFor(files))).toEqual(files);
      for (const name of PAYLOADS) {
        const missing = new Map(files);
        missing.delete(name);
        expect(() => validateArtifact(missing, p.m, p.digest)).toThrow("partial artifact");
      }
      const extra = new Map(files);
      extra.set("diagnostic.json", Buffer.from("not canonical"));
      expect(() => validateArtifact(extra, p.m, p.digest)).toThrow("extra paths");
      const corrupt = new Map(files);
      corrupt.set(PAYLOADS[0], Buffer.concat([files.get(PAYLOADS[0]), Buffer.from(" ")]));
      expect(() => validateArtifact(corrupt, p.m, p.digest)).toThrow("canonical");
      const bad = copy(artifactFor(p).r);
      bad.run.checkout = p.m.S;
      expect(() => validateReceipt(bad, p.m, p.digest)).toThrow("input E");
      bad.schema = "bootstrap-db-oracle-memo/v1";
      expect(JSON.parse(canonical(bad)).schema).toBe("bootstrap-db-oracle-memo/v1");
      expect(() => validateReceipt(bad, p.m, p.digest)).toThrow("v1");
    }
  });

  it("readArtifactZip refuses path links CRC bombs duplicate missing and malformed records", () => {
    const { files } = artifactFor(first);
    for (const name of ["../receipt.json", "dir/receipt.json", "/receipt.json"]) {
      const bad = new Map(files);
      bad.delete("receipt.json");
      bad.set(name, Buffer.from("invalid"));
      expect(() => readArtifactZip(zipFor(bad))).toThrow("path");
    }
    for (const mutate of [
      (c) => c.writeUInt32LE((0xa000 << 16) >>> 0, 38),
      (c) => c.writeUInt32LE(0, 16),
      (c) => c.writeUInt32LE(3 * 1024 * 1024, 24),
      (c) => c.writeUInt32LE(0xffffffff, 42),
    ])
      expect(() => readArtifactZip(zipFor(files, mutate))).toThrow();
    const duplicate = zipFor(files);
    const firstCentral = duplicate.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    duplicate.writeUInt16LE(0xffff, firstCentral + 28);
    expect(() => readArtifactZip(duplicate)).toThrow("bounds");
    const missing = new Map(files);
    missing.delete("receipt.json");
    expect(() => readArtifactZip(zipFor(missing))).toThrow("count");
    const duplicateEntries = Object.assign(
      [
        [PAYLOADS[0], files.get(PAYLOADS[0])],
        ["receipt.json", files.get("receipt.json")],
        ["receipt.json", files.get("receipt.json")],
      ],
      { size: 3 },
    );
    expect(() => readArtifactZip(zipFor(duplicateEntries))).toThrow("duplicate");
    expect(() => readArtifactZip(Buffer.alloc(4 * 1024 * 1024 + 1))).toThrow("limit");
    expect(() => readArtifactZip(Buffer.alloc(22))).toThrow("end");
    expect(() => readArtifactZip(Buffer.concat([zipFor(files), Buffer.from("tail")]))).toThrow();
  });

  it("acceptCompletedArtifact refuses skipped jobs wrong attempts input drift and freeze drift", () => {
    const input = acceptance();
    const result = acceptCompletedArtifact(input);
    expect(result.jobId).not.toBe(Number(result.checkRunId));
    expect(result.jobUrl).toContain(`/job/${input.jobs[0].id}`);
    const mutants = [
      (x) => x.jobs.splice(0),
      (x) => x.jobs.push(copy(x.jobs[0])),
      (x) => {
        x.run.run_attempt = 2;
      },
      (x) => {
        x.run.head_sha = first.m.E.commit;
      },
      (x) => {
        x.jobs[0].head_sha = first.m.E.commit;
      },
      (x) => {
        x.jobs[0].conclusion = "failure";
      },
      (x) => {
        x.jobs[0].steps[2].conclusion = "skipped";
      },
      (x) => {
        x.jobs[0].steps.splice(3, 1);
      },
      (x) => {
        x.jobs[0].steps.push(copy(x.jobs[0].steps[2]));
      },
      (x) => {
        x.jobs[0].check_run_url = "https://foreign.invalid/check-runs/990000502";
      },
      (x) => {
        x.artifact.expired = true;
      },
      (x) => {
        x.artifact.digest = "sha256:" + "a".repeat(64);
      },
      (x) => {
        x.artifact.created_at = "2026-02-30T00:00:00Z";
      },
      (x) => {
        x.jobs[0].started_at = "2026-11-10";
      },
      (x) => {
        x.currentPr.head.sha = first.m.E.commit;
      },
      (x) => {
        x.currentPr.body = "changed";
      },
      (x) => {
        x.currentPr.state = "closed";
      },
      (x) => {
        x.freeze.observedAt = "2026-11-11T00:00:00.000Z";
      },
      (x) => {
        x.freeze.input = first.m.S.commit;
      },
      (x) => {
        x.run.status = "in_progress";
      },
      (x) => {
        x.lifecycle = [{ id: 1, event: "reopened" }];
      },
      (x) => {
        x.freeze.preflight.runs = [{ workflow_id: 990000701, status: "queued" }];
      },
    ];
    for (const mutate of mutants) {
      const bad = copy(input);
      mutate(bad);
      expect(() => acceptCompletedArtifact(bad)).toThrow();
    }
    expect(acceptCompletedArtifact(input)).toEqual(result);
  });

  it("real collector joins discovery download and canonical-author application", () => {
    const a = acceptance();
    const calls = [];
    const readApi = (url, binary) => {
      calls.push([url, binary]);
      if (url === `actions/runs/${a.run.id}`) return a.run;
      if (url.includes("/attempts/1/jobs?")) return { total_count: 1, jobs: a.jobs };
      if (url.includes("/artifacts?")) return { total_count: 1, artifacts: [a.artifact] };
      if (url === `actions/artifacts/${a.artifact.id}/zip`) return a.zip;
      if (url === `git/commits/${first.event.merge.commit}`)
        return {
          sha: first.event.merge.commit,
          tree: { sha: first.event.merge.tree },
          parents: [{ sha: first.event.base.commit }, { sha: first.event.head.commit }],
        };
      if (url === `pulls/${a.currentPr.number}`) return a.currentPr;
      if (url === `issues/${a.currentPr.number}/events?per_page=100&page=1`) return [];
      throw Error("unexpected API request");
    };
    const result = discoverCompletedArtifact({
      m: first.m,
      manifestSha256: first.digest,
      freeze: a.freeze,
      runId: String(a.run.id),
      artifactId: String(a.artifact.id),
      readApi,
    });
    expect(result.accepted.artifactUrl).toContain(`/artifacts/${a.artifact.id}`);
    expect(calls).toHaveLength(7);
    expect(calls[3]).toEqual([`actions/artifacts/${a.artifact.id}/zip`, true]);
    expect(() =>
      checkApplication(first.m, first.m.E.commit, {
        objectRoot: first.directory,
        acceptedMemoSha256: result.accepted.memoSha256,
      }),
    ).toThrow("publication memo");
    first.put(MEMO, artifactFor(first).files.get(PAYLOADS[0]));
    const publication = first.commit("Synthetic canonical-author application");
    expect(
      checkApplication(first.m, publication.commit, {
        objectRoot: first.directory,
        acceptedMemoSha256: result.accepted.memoSha256,
      }),
    ).toMatchObject({
      rawCheck: "PENDING_HOST",
      mergeGroupRawCheck: "PENDING_HOST",
      authority: "canonical-author-only; no automatic application or landing",
    });
  });

  it("single flight refuses queued inventory without unrelated-PR eviction", () => {
    const workflow = { id: 990000701, path: WORKFLOW, state: "active" };
    expect(preflightWorkflow(workflow, []).workflowId).toBe(workflow.id);
    for (const status of ["queued", "in_progress", "pending", "requested", "waiting", undefined])
      expect(() => preflightWorkflow(workflow, [{ workflow_id: workflow.id, status }])).toThrow("single flight");
    expect(() => preflightWorkflow({ ...workflow, state: "disabled_manually" }, [])).toThrow("registration");
    expect(() => collectPages(() => ({ total_count: 101, jobs: [{ id: 1 }] }), "jobs", "jobs")).toThrow("partial");
    expect(() => collectPages(() => ({ total_count: 1001, jobs: [] }), "jobs", "jobs")).toThrow("range");
    expect(() => collectPages(() => ({ total_count: 2, jobs: [{ id: 1 }, { id: 1 }] }), "jobs", "jobs")).toThrow(
      "duplicate",
    );
    expect(parse(workflowText).concurrency).toBeUndefined();
    expect(parse(workflowText).jobs.deriveMemo.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });
  it("single flight admits only opened same-repository memo PRs", () => {
    const path = ".github/workflows/bootstrap-db-oracle-memo.yml";
    expect(existsSync(path)).toBe(true);
    const workflow = parse(readFileSync(path, "utf8"));
    expect(workflow.on).toEqual({ pull_request: { types: ["opened"] } });
    expect(workflow.jobs.deriveMemo.concurrency).toEqual({
      group: "bootstrap-db-oracle-memo-global",
      "cancel-in-progress": false,
    });
  });

  it("selects the eighteenth memo gate as HOSTED_ONLY without a local executor", () => {
    expect(CI_GATE_DEFINITIONS).toHaveLength(18);
    expect(CI_GATE_DEFINITIONS.find((gate) => gate.id === "bootstrap-db-oracle-memo-check")).toMatchObject({
      executability: "HOSTED_ONLY",
    });
  });
});

describe("pre-open B/D mergeability guard", () => {
  it("mergeability clean pair prints one diagnostic record only after the final live recheck", () => {
    const calls = [];
    const record = preOpenMergeability(
      mergeInput(merge.B, merge.D, { readApi: liveRefs(merge.B.commit, merge.D.commit, calls) }),
    );
    expect(calls).toEqual(["git/ref/heads/main", `git/ref/heads/${merge.branch}`]);
    expect(Object.keys(record)).toEqual([
      "kind",
      "authority",
      "observedAt",
      "base",
      "head",
      "branch",
      "T",
      "manifestSha256",
      "mergeBase",
      "result",
      "unmergedPaths",
      "diagnosticMergeTree",
      "workflow",
    ]);
    expect(record).toMatchObject({
      kind: "pre-open-mergeability-record",
      base: merge.B.commit,
      head: merge.D.commit,
      branch: merge.branch,
      T: merge.T,
      manifestSha256: sha256(merge.manifest(merge.T)),
      mergeBase: merge.T.commit,
      result: "clean",
      unmergedPaths: [],
      diagnosticMergeTree: merge.cleanTree,
      workflow: {
        path: WORKFLOW,
        mode: "100644",
        blob: merge.workflowBlob,
      },
    });
    expect(record.authority).toContain("never G");
    expect(record.observedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(JSON.parse(canonical(record))).toEqual(record);
    expect(parseCommand(["mergeability", merge.B.commit, merge.D.commit, merge.branch]).command).toBe("mergeability");
  });

  it("mergeability content-conflicted and structural pairs refuse naming unmerged paths before any live read", () => {
    for (const base of [merge.conflictB, merge.deleteB]) {
      const calls = [];
      refusesMergeability(
        mergeInput(base, merge.conflictD, { readApi: liveRefs(base.commit, merge.conflictD.commit, calls) }),
        'B/D merge conflict refuses opening: 1 unmerged ["shared.txt"]',
      );
      expect(calls).toEqual([]);
    }
  });

  it("mergeability missing-object, non-commit, abbreviated and ref inputs refuse", () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    refusesMergeability(mergeInput({ commit: missing }, merge.D), `B/D missing object ${missing}`);
    refusesMergeability(mergeInput(merge.B, { commit: missing }), `B/D missing object ${missing}`);
    refusesMergeability(mergeInput({ commit: merge.T.tree }, merge.D), `B/D non-commit object ${merge.T.tree}`);
    for (const [base, head, branch] of [
      [merge.B.commit.slice(0, 12), merge.D.commit, merge.branch],
      [merge.B.commit, merge.D.commit.slice(0, 39), merge.branch],
      ["main", merge.D.commit, merge.branch],
      ["refs/heads/main", merge.D.commit, merge.branch],
      [merge.B.commit, "HEAD", merge.branch],
      [merge.B.commit.toUpperCase(), merge.D.commit, merge.branch],
      [`${merge.B.commit}^0`, merge.D.commit, merge.branch],
      [merge.D.commit, merge.D.commit, merge.branch],
      [merge.B.commit, merge.D.commit, "main"],
      [merge.B.commit, merge.D.commit, "memo-derivation/../main"],
    ]) {
      expect(() =>
        preOpenMergeability({ ...mergeInput(merge.B, merge.D), base, head, branch, readApi: () => assert.fail() }),
      ).toThrow();
      expect(() => parseCommand(["mergeability", base, head, branch])).toThrow();
    }
    expect(() => parseCommand(["mergeability", merge.B.commit, merge.D.commit])).toThrow();
    expect(() => parseCommand(["mergeability", merge.B.commit, merge.D.commit, merge.branch, "--force"])).toThrow();
  });

  it("mergeability forced Git exit, signal and spawn errors and unsupported Git refuse before any live read", () => {
    const stdout = (text) => Buffer.from(text);
    const tree = merge.cleanTree;
    for (const [runGit, message] of [
      [forcedGit("version", { status: 0, signal: null, stdout: stdout("git version 2.39.5\n") }), "Git without"],
      [forcedGit("version", { status: 0, signal: null, stdout: stdout("not git\n") }), "Git without"],
      [forcedGit("cat-file", { status: 0, signal: null, stdout: stdout(`${merge.B.commit} commit 1\n`) }), "count"],
      [forcedGit("merge-base", { status: 1, signal: null, stdout: stdout("") }), "merge-base: unexpected Git exit"],
      [forcedGit("merge-tree", { status: 2, signal: null, stdout: stdout("") }), "unexpected Git exit"],
      [forcedGit("merge-tree", { status: 128, signal: null, stdout: stdout(`${tree}\0`) }), "unexpected Git exit"],
      [forcedGit("merge-tree", { status: null, signal: "SIGKILL", stdout: stdout("") }), "unexpected Git exit"],
      [forcedGit("merge-tree", { error: Error("spawnSync git ENOBUFS"), status: 0, signal: null }), "Git exit"],
    ]) {
      const calls = [];
      refusesMergeability(
        mergeInput(merge.B, merge.D, { runGit, readApi: liveRefs(merge.B.commit, merge.D.commit, calls) }),
        message,
      );
      expect(calls).toEqual([]);
    }
  });

  it("mergeability truncated, malformed, unbounded or contradictory merge output refuses as unknown", () => {
    const stdout = (text) => Buffer.from(text);
    const tree = merge.cleanTree;
    const record = `100644 ${"a".repeat(40)} 2\tshared.txt`;
    for (const [status, output, message] of [
      [0, tree, "incomplete output"],
      [0, "", "malformed tree"],
      [0, `${tree}\0${record}\0`, "unexpected clean output"],
      [1, `${tree}\0`, "0 unmerged []"],
      [1, `${tree}\0garbled\0`, "malformed unmerged record"],
      [1, `${tree}\0${`${record}\0`.repeat(193)}`, "unmerged bound exceeded"],
    ]) {
      const calls = [];
      const runGit = forcedGit("merge-tree", { status, signal: null, stdout: stdout(output) });
      refusesMergeability(
        mergeInput(merge.B, merge.D, { runGit, readApi: liveRefs(merge.B.commit, merge.D.commit, calls) }),
        message,
      );
      expect(calls).toEqual([]);
    }
  });

  it("mergeability multiple or absent merge bases refuse as unknown", () => {
    refusesMergeability(mergeInput(merge.crossB, merge.crossD), "multiple or malformed bases");
    refusesMergeability(mergeInput(merge.B, merge.lonelyD), "merge-base: unexpected Git exit");
  });

  it("mergeability refuses a real Git failure on an unreadable object", () => {
    const loose = join(merge.directory, ".git", "objects", merge.corruptBlob.slice(0, 2), merge.corruptBlob.slice(2));
    expect(existsSync(loose)).toBe(true);
    chmodSync(loose, 0o644);
    rmSync(loose);
    refusesMergeability(
      mergeInput(merge.corruptB, merge.corruptD, { runGit: spawnGit }),
      "B/D merge probe: unexpected Git exit",
    );
  });

  it("mergeability base drift and head drift with fixed other input refuse with no success record", () => {
    expect(preOpenMergeability(mergeInput(merge.B, merge.D)).result).toBe("clean");
    refusesMergeability(
      mergeInput(merge.B, merge.D, { readApi: liveRefs(merge.routeB.commit, merge.D.commit) }),
      "stale B: live main differs",
    );
    refusesMergeability(
      mergeInput(merge.B, merge.D, { readApi: liveRefs(merge.B.commit, merge.routeD.commit) }),
      "stale D: live derivation head differs",
    );
    const tagged = (path) => ({
      ref: `refs/${path.slice("git/ref/".length)}`,
      object: { sha: merge.B.commit, type: "tag" },
    });
    refusesMergeability(mergeInput(merge.B, merge.D, { readApi: tagged }), "live refs/heads/main unavailable");
    refusesMergeability(
      mergeInput(merge.B, merge.D, {
        readApi: () => {
          throw Error("live read failed");
        },
      }),
      "live read failed",
    );
  });

  it("mergeability workflow mismatch at T with fixed B and D workflow refuses before the live recheck", () => {
    const calls = [];
    refusesMergeability(
      mergeInput(merge.B, merge.otherTD, { readApi: liveRefs(merge.B.commit, merge.otherTD.commit, calls) }),
      "workflow blob differs across T/B/D/merge tree",
    );
    expect(calls).toEqual([]);
  });

  it("mergeability workflow mismatch at B with fixed T and D refuses before the live recheck", () => {
    const calls = [];
    refusesMergeability(
      mergeInput(merge.routeB, merge.D, { readApi: liveRefs(merge.routeB.commit, merge.D.commit, calls) }),
      "workflow blob differs across T/B/D/merge tree",
    );
    expect(calls).toEqual([]);
  });

  it("mergeability workflow mismatch at D with fixed T and B refuses before the live recheck", () => {
    const calls = [];
    refusesMergeability(
      mergeInput(merge.B, merge.routeD, { readApi: liveRefs(merge.B.commit, merge.routeD.commit, calls) }),
      "workflow blob differs across T/B/D/merge tree",
    );
    expect(calls).toEqual([]);
  });

  it("mergeability nonregular workflow mode at D refuses before the live recheck", () => {
    const calls = [];
    refusesMergeability(
      mergeInput(merge.B, merge.executableD, { readApi: liveRefs(merge.B.commit, merge.executableD.commit, calls) }),
      "missing/nonregular D workflow",
    );
    expect(calls).toEqual([]);
  });

  it("mergeability workflow mismatch at the merge tree refuses before the live recheck", () => {
    const otherListing = Buffer.from(`100644 blob ${merge.changedWorkflowBlob}\t${WORKFLOW}\0`);
    const calls = [];
    refusesMergeability(
      mergeInput(merge.B, merge.D, {
        readApi: liveRefs(merge.B.commit, merge.D.commit, calls),
        runGit: (directory, args, input) =>
          args[0] === "ls-tree" && args[3] === merge.cleanTree
            ? { status: 0, signal: null, stdout: otherListing }
            : cachedGit(directory, args, input),
      }),
      "workflow blob differs across T/B/D/merge tree",
    );
    expect(calls).toEqual([]);
  });

  it("mergeability refuses a missing manifest at the exact D", () => {
    refusesMergeability(mergeInput(merge.B, merge.E), "missing/nonregular D manifest");
  });

  it("mergeability refuses an unparsable manifest at the exact D", () => {
    refusesMergeability(mergeInput(merge.B, merge.garbledD), "unparsable D manifest");
  });

  it("mergeability refuses an abbreviated T in the manifest at the exact D", () => {
    refusesMergeability(mergeInput(merge.B, merge.shortTD), "D manifest T: commit/tree");
  });

  const cli = (argv) =>
    spawnSync(process.execPath, [resolve("scripts/bootstrap-db-oracle-memo-artifact.mjs"), "mergeability", ...argv], {
      encoding: "utf8",
      windowsHide: true,
    });

  it("mergeability CLI refuses an abbreviated OID with no stdout record", () => {
    const result = cli([merge.B.commit.slice(0, 12), merge.D.commit, merge.branch]);
    expect([result.status, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain("STOP_TO_HOST: full B/D OIDs and memo-derivation branch only");
  });

  it("mergeability CLI refuses missing objects with no stdout record", () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const result = cli([missing, missing.replace("0", "1"), merge.branch]);
    expect([result.status, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain(`STOP_TO_HOST: B/D missing object ${missing}`);
  });
});
