import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  inspectChecker,
  parseCommand,
  parseManifest,
  preflightWorkflow,
  readArtifactZip,
  sha256,
  validateArtifact,
  validateIndependentProfile,
  validateLiterals,
  validateReceipt,
  validateWorkloadBaseline,
} from "./bootstrap-db-oracle-memo-artifact.mjs";

const directories = [];
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
const options = (p) => ({ objectRoot: p.directory, helperSha: p.m.T.commit, event: p.event, inputRoot: p.directory });

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
    const p = await profile("990000201", 23, (v) => {
      Object.values(v.bootstrapDbEnrollmentManifest)[0].cases[0].unexpected = true;
    });
    const actual = await inspectChecker(readFileSync(join(p.directory, CHECKER), "utf8"));
    expect(Object.values(actual.values.bootstrapDbEnrollmentManifest)[0].cases[0].unexpected).toBe(true);
    expect(() => parseManifest(bytes(p.m), p.digest)).toThrow("unknown/missing");
    await expect(admitProfile(p.m, options(p))).rejects.toThrow("unknown/missing");
  });

  it("independent source census rejects the same foreign map member in E and manifest", async () => {
    const p = await profile("990000301", 31, (v) => {
      v.platformApiNonBootstrapDbCensus.entries["__tests__/foreign.db.test.ts"] = "test:db:1";
    });
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

  it("admitProfile binds two profiles and rejects stale foreign dirty widened input", async () => {
    for (const p of [first, second]) {
      expect(parseManifest(bytes(p.m), p.digest)).toEqual(p.m);
      expect(await admitProfile(p.m, options(p))).toMatchObject({ current: p.current, paired: p.paired });
      cleanInput(p.directory, p.m);
      await expect(admitProfile(p.m, { ...options(p), helperSha: p.m.E.commit })).rejects.toThrow("wrong helper");
      const stale = copy(p.m);
      stale.E.tree = "a".repeat(40);
      await expect(admitProfile(stale, options(p))).rejects.toThrow("E tree");
      const foreign = copy(p.m);
      foreign.repository = "foreign/repository";
      expect(() => parseManifest(bytes(foreign), sha256(bytes(foreign)))).toThrow("repository");
      p.put("dirty.txt", "untracked synthetic drift\n");
      await expect(admitProfile(p.m, options(p))).rejects.toThrow("dirty E");
      rmSync(join(p.directory, "dirty.txt"));
      expect(await admitProfile(p.m, options(p))).toMatchObject({ current: p.current });
    }
    const wrongParent = copy(first.event);
    wrongParent.head = first.m.E;
    await expect(admitProfile(first.m, { ...options(first), event: wrongParent })).rejects.toThrow("D sole E");
    const widened = copy(first.m);
    widened.inputDelta[0].path = "scripts/foreign.mjs";
    expect(() => parseManifest(bytes(widened), sha256(bytes(widened)))).toThrow("delta path");
    const wrongMerge = copy(first.event);
    wrongMerge.merge = first.m.E;
    await expect(admitProfile(first.m, { ...options(first), event: wrongMerge })).rejects.toThrow();
  });

  it("independently derived null floor is eligible but malformed or mismatched pairs are not", async () => {
    const m = copy(first.m);
    const paired = copy(first.paired);
    paired.files.forEach((f, i) => {
      f.executionUnit = `test:db:${(i % 2) + 1}`;
    });
    const result = deriveBootstrapDbMeasuredOneFewerUnitFloor({ shippedCapture: first.current, pairedCapture: paired });
    expect(result.floor).toBeNull();
    expect(result.refusal).toMatch(/within the .* per-unit ceiling$/);
    m.checkerLiterals.bootstrapDbMeasuredOneFewerUnitFloor = null;
    const fixtures = { current: first.current, paired };
    await expect(validateIndependentProfile(m, fixtures, options(first))).resolves.toBeUndefined();
    const malformed = copy(fixtures);
    malformed.paired.files[0].cases[0].durationMs = -1;
    await expect(validateIndependentProfile(m, malformed, options(first))).rejects.toThrow();
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
