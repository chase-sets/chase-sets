import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  INPUT_SCHEMA,
  MEMO_SCHEMA,
  WORKFLOW,
  PLATFORM,
  FIXTURES,
  MEMO,
  PRODUCER,
  ORACLE,
  CHECKER,
  PAYLOADS,
  LITERALS,
  acceptCompletedArtifact,
  admitProfile,
  canonical,
  checkApplication,
  cleanInput,
  expectedKeys,
  inspectChecker,
  parseManifest,
  preflightWorkflow,
  readArtifactZip,
  sha256,
  validateArtifact,
  validateCapturePair,
  validateMemo,
  hashGitFiles,
  parseCommand,
  validateWorkloadBaseline,
} from "./bootstrap-db-oracle-memo-artifact.mjs";

const directories = [];
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
const copy = (value) => structuredClone(value);
const read = (path) => readFileSync(path);
const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
const source = read(CHECKER).toString("utf8");
const inspected = await inspectChecker(source);
const workflow = read(WORKFLOW).toString("utf8");
const workflowValue = parse(workflow);

async function syntheticProfile(runId, offset) {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-memo-profile-"));
  directories.push(directory);
  const put = (path, bytes) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), bytes);
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
    const head = git(directory, ["rev-parse", "HEAD"]);
    return { commit: head, tree: git(directory, ["rev-parse", "HEAD^{tree}"]) };
  };
  for (const path of [PRODUCER, ORACLE, CHECKER, MEMO]) put(path, read(path));
  put("package.json", canonical({ packageManager: "pnpm@11.0.9" }));
  put("pnpm-lock.yaml", "synthetic locked dependencies\n");
  put("synthetic/source.ts", "export const synthetic = true;\n");
  for (const fileName of Object.keys(inspected.values.bootstrapDbEnrollmentManifest)) {
    put(`${PLATFORM}/__tests__/${fileName}`, "synthetic source, never executed\n");
  }
  const S = commit("Synthetic product source, not hosted evidence");
  put(".github/workflows/10365-bootstrap-db-input-capture.yml", "name: Synthetic capture, never executed\n");
  const W = commit("Synthetic capture-only child");
  git(directory, ["switch", "--quiet", "--detach", S.commit]);
  put(WORKFLOW, workflow);
  const T = commit("Synthetic reviewed landed route");
  git(directory, ["update-ref", "refs/remotes/origin/main", T.commit]);
  git(directory, ["switch", "--quiet", "--detach", S.commit]);
  const literals = copy(inspected.values);
  const model = literals.bootstrapDbScheduleModel;
  model.referenceRunId = Number(runId);
  model.referenceJobId = Number(runId) + 1;
  model.referenceHeadSha = W.commit;
  model.testFileFixedCostMs += offset;
  const files = Object.entries(literals.bootstrapDbEnrollmentManifest).map(([fileName, file], index) => {
    file.cases = [
      { name: `synthetic case ${index}`, referenceDurationMs: 2 ** index + offset, identity: "0000000000000000" },
    ];
    return {
      fileName,
      testPath: `__tests__/${fileName}`,
      sourceSha256: sha256(Buffer.from("synthetic source, never executed\n")),
      cases: copy(file.cases),
    };
  });
  const provenance = {
    repository: "chase-sets/chase-sets",
    workflow: "Synthetic, never dispatched",
    runId,
    runAttempt: "1",
    referenceJobId: model.referenceJobId,
    checkoutSha: W.commit,
    sourceBase: S.commit,
    captureParent: S.commit,
    parents: [S.commit],
  };
  const current = {
    provenance: { ...provenance, role: "current-three-unit" },
    files,
    sourceBindings: {},
    model: copy(model),
  };
  const paired = { provenance: { ...provenance, role: "paired-two-unit" }, files: copy(files), sourceBindings: {} };
  const entries = {
    current: [`${FIXTURES}/bootstrap-db-capture-${runId}.json`, Buffer.from(canonical(current))],
    paired: [`${FIXTURES}/bootstrap-db-capture-${runId}-paired.json`, Buffer.from(canonical(paired))],
  };
  const bindings = [["W1 file", "synthetic/source.ts", sha256(readFileSync(join(directory, "synthetic/source.ts")))]];
  const baselineValue = {
    schema: "db-enrollment-workload/v1",
    capture: { fixtureSha256: sha256(entries.current[1]), runId, checkoutSha: W.commit },
    source: { commit: S.commit },
    bindings,
    bindingsSha256: "a".repeat(64),
  };
  entries.baseline = [`${FIXTURES}/db-enrollment-workload-${runId}.json`, Buffer.from(canonical(baselineValue))];
  let checker = inspected.skeleton;
  for (const name of LITERALS)
    checker = checker.replace(`<${name}>`, `Object.freeze(${JSON.stringify(literals[name])})`);
  put(CHECKER, checker);
  for (const [path, bytes] of Object.values(entries)) put(path, bytes);
  const E = commit("Synthetic accepted input projection");
  put(WORKFLOW, workflow);
  const D = commit("Synthetic dispatch-only workflow child");
  git(directory, ["switch", "--quiet", "--detach", E.commit]);
  const changed = git(directory, ["diff", "--name-only", S.commit, E.commit]).split("\n").sort();
  const m = {
    schema: INPUT_SCHEMA,
    repository: "chase-sets/chase-sets",
    S,
    W,
    R: { runId, attempt: 1, currentJobId: String(model.referenceJobId), pairedJobId: String(model.referenceJobId) },
    E,
    T,
    D,
    fixtures: Object.fromEntries(
      Object.entries(entries).map(([key, [path, bytes]]) => [key, { path, sha256: sha256(bytes) }]),
    ),
    checkerLiterals: literals,
    inputDelta: changed.map((path) => ({
      path,
      beforeSha256: path === CHECKER ? sha256(read(CHECKER)) : null,
      afterSha256: sha256(readFileSync(join(directory, path))),
    })),
    readClosureSha256: sha256(execFileSync("git", ["-C", directory, "ls-tree", "-rz", "--full-tree", E.commit])),
    toolchain: {
      node: "v24.22.1",
      pnpm: "11.0.9",
      lockSha256: sha256(readFileSync(join(directory, "pnpm-lock.yaml"))),
    },
  };
  return { directory, m, current, paired, baselineValue };
}

const first = await syntheticProfile("999000001", 0);
const second = await syntheticProfile("999000101", 11);
const options = (profile) => ({
  objectRoot: profile.directory,
  dispatchSha: profile.m.D.commit,
  helperSha: profile.m.T.commit,
});

function artifactFor(m) {
  const manifestSha256 = sha256(Buffer.from(canonical(m)));
  const memo = Buffer.from(
    canonical({
      oracleSha256: "d3b96de0c4051a7021f8f00869d19dd13314166b8dc81244c2bb554a2493847b",
      entries: Object.fromEntries(expectedKeys(m.checkerLiterals).map((key) => [key, 1])),
    }),
  );
  const receipt = {
    schema: MEMO_SCHEMA,
    kind: "deterministic-derivation",
    manifestSha256,
    profile: m,
    readClosure: { before: "b".repeat(64), after: "b".repeat(64) },
    producer: {
      command: "node __tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs",
      cwd: PLATFORM,
      stdout: { mode: "write", entries: 4095, sha256: sha256(memo), durationMs: 1000 },
      startedAt: "2026-11-09T00:01:00.000Z",
      completedAt: "2026-11-09T00:01:01.000Z",
    },
    output: {
      path: PAYLOADS[0],
      sha256: sha256(memo),
      oracleSha256: "d3b96de0c4051a7021f8f00869d19dd13314166b8dc81244c2bb554a2493847b",
      keys: 4095,
    },
    run: {
      repository: "chase-sets/chase-sets",
      workflow: WORKFLOW,
      workflowRef: `chase-sets/chase-sets/${WORKFLOW}@refs/heads/synthetic-memo`,
      workflowSha: m.D.commit,
      ref: "refs/heads/synthetic-memo",
      runId: "999000301",
      attempt: 1,
      jobKey: "deriveMemo",
      checkRunId: "999000302",
      checkout: m.E,
      helper: m.T,
      node: m.toolchain.node,
      pnpm: m.toolchain.pnpm,
      runnerOs: "Linux",
      runnerImage: "ubuntu-latest",
      runnerImageVersion: "synthetic",
    },
  };
  const files = new Map();
  const refresh = () => {
    const receiptBytes = Buffer.from(canonical(receipt));
    files.set(PAYLOADS[0], memo);
    files.set("receipt.json", receiptBytes);
    files.set("SHA256SUMS", Buffer.from(`${sha256(memo)}  ${PAYLOADS[0]}\n${sha256(receiptBytes)}  receipt.json\n`));
  };
  refresh();
  return { manifestSha256, memo, receipt, files, refresh };
}

function zipFiles(files, { names = [...files.keys()], mode = 0x81a4, deflate = false, descriptor = false } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const bytes = files.get(name) ?? Buffer.from("synthetic");
    const filename = Buffer.from(name);
    const compressed = deflate ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(deflate ? 8 : 0, 8);
    header.writeUInt16LE(descriptor ? 8 : 0, 6);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const trailer = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      trailer.writeUInt32LE(0x08074b50); trailer.writeUInt32LE(crc32(bytes), 4);
      trailer.writeUInt32LE(compressed.length, 8); trailer.writeUInt32LE(bytes.length, 12);
      local.push(trailer);
    }
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt16LE(descriptor ? 8 : 0, 8);
    entry.writeUInt32LE(crc32(bytes), 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE((mode * 65536) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + compressed.length + trailer.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

describe("immutable hosted memo artifacts (synthetic controls, no producer execution)", () => {
  it("binds two profiles and rejects stale foreign dirty widened input", async () => {
    for (const profile of [first, second]) {
      const bytes = Buffer.from(canonical(profile.m));
      expect(parseManifest(bytes, sha256(bytes))).toEqual(profile.m);
      await expect(admitProfile(profile.m, options(profile))).resolves.toBeDefined();
      expect(() => cleanInput(profile.directory, profile.m)).not.toThrow();
      const stale = copy(profile.m);
      stale.E.tree = "0".repeat(40);
      await expect(admitProfile(stale, options(profile))).rejects.toThrow("tree resolution");
    }
    const foreign = copy(first.m);
    foreign.repository = "synthetic/foreign";
    const bytes = Buffer.from(canonical(foreign));
    expect(() => parseManifest(bytes, sha256(bytes))).toThrow("foreign repository");
    const wide = copy(first.m);
    wide.inputDelta = [];
    await expect(admitProfile(wide, options(first))).rejects.toThrow("reviewed E delta");
    writeFileSync(join(first.directory, "synthetic/dirty.ts"), "synthetic dirt\n");
    expect(() => cleanInput(first.directory, first.m)).toThrow("dirty E");
    rmSync(join(first.directory, "synthetic/dirty.ts"));
    const wrong = copy(first.m);
    wrong.checkerLiterals.bootstrapDbScheduleModel.testFileFixedCostMs++;
    await expect(admitProfile(wrong, options(first))).rejects.toThrow("reviewed checker literals");
    const reordered = copy(first.m);
    reordered.checkerLiterals.bootstrapDbEnrollmentManifest = Object.fromEntries(Object.entries(reordered.checkerLiterals.bootstrapDbEnrollmentManifest).reverse());
    await expect(admitProfile(reordered, options(first))).rejects.toThrow("literals/order");
    await expect(admitProfile(first.m, { ...options(first), dispatchSha: first.m.S.commit })).rejects.toThrow(
      "wrong dispatch",
    );
  });

  it("binds captured-real inputs without replacing externally owned identities", async () => {
    const current = JSON.parse(read(`${FIXTURES}/bootstrap-db-capture-41551303861.json`));
    const paired = JSON.parse(read(`${FIXTURES}/bootstrap-db-capture-41551303861-paired.json`));
    const baselineValue = JSON.parse(read(`${FIXTURES}/db-enrollment-workload-41551303861.json`));
    const m = copy(first.m);
    m.S.commit = current.provenance.sourceBase;
    m.W.commit = current.provenance.checkoutSha;
    m.R = {
      runId: String(current.provenance.runId),
      attempt: 1,
      currentJobId: String(current.provenance.referenceJobId),
      pairedJobId: String(paired.provenance.referenceJobId),
    };
    m.fixtures.current.sha256 = sha256(read(`${FIXTURES}/bootstrap-db-capture-41551303861.json`));
    m.fixtures.current.path = `${FIXTURES}/bootstrap-db-capture-41551303861.json`;
    m.checkerLiterals = inspected.values;
    const paths = [current, paired].flatMap((capture) => [
      ...[...capture.files, ...(capture.nonBootstrapFiles ?? [])].map((file) => `${PLATFORM}/${file.testPath}`),
      ...Object.keys(capture.sourceBindings),
    ]);
    const sourceHashes = await hashGitFiles(process.cwd(), m.S.commit, paths);
    expect(() =>
      validateCapturePair(m, current, paired, baselineValue, (path) => sourceHashes.get(path)),
    ).not.toThrow();
    expect(() => validateCapturePair(m, current, paired, baselineValue, () => "0".repeat(64))).toThrow(
      "capture input drift",
    );
    const derivation = { gaps: [], bindings: baselineValue.bindings };
    await expect(validateWorkloadBaseline(m, current, baselineValue, derivation)).resolves.toBeUndefined();
    const syntheticCorruption = { ...baselineValue, selectorsSha256: "0".repeat(64) };
    await expect(validateWorkloadBaseline(m, current, syntheticCorruption, derivation)).rejects.toThrow("canonical baseline/workload drift");
  });

  it("admits only fixed producer and output", () => {
    for (const args of [
      [],
      ["generate"],
      ["derive", "--out", "foreign.json"],
      ["validate", "--skip"],
      ["accept", "latest", "1"],
    ]) {
      expect(() => parseCommand(args)).toThrow();
    }
    expect(Object.keys(workflowValue.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(workflowValue.jobs)).toEqual(["deriveMemo"]);
    expect(workflowValue.permissions).toEqual({ contents: "read" });
    const job = workflowValue.jobs.deriveMemo;
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBe(30);
    expect(workflow).not.toMatch(
      /secrets\.|environment:|id-token:|continue-on-error|always\(\)|workflow_run|services:|gh workflow|gh run/,
    );
    const checkouts = job.steps.filter(({ uses }) => uses?.startsWith("actions/checkout@"));
    expect(checkouts.map(({ with: settings }) => [settings.ref, settings["persist-credentials"]])).toEqual([
      ["${{ inputs.helper_sha }}", false],
      ["${{ inputs.input_sha }}", false],
    ]);
    const run = job.steps.find(({ name }) => name === "Run fixed producer");
    expect(run.run).toBe(
      "node trusted/scripts/bootstrap-db-oracle-memo-artifact.mjs derive --out artifacts/bootstrap-db-oracle-memo/bootstrap-db-oracle-schedule-memo.json",
    );
    expect(job.steps.find(({ name }) => name === "Refuse reruns and mutable selectors").run).toContain(
      'test "$GITHUB_RUN_ATTEMPT" = 1',
    );
    const upload = job.steps.at(-1);
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(upload.with.path.trim().split("\n")).toEqual(
      PAYLOADS.map((name) => `artifacts/bootstrap-db-oracle-memo/${name}`),
    );
    const helper = read("scripts/bootstrap-db-oracle-memo-artifact.mjs").toString("utf8");
    expect(helper).toMatch(/spawnSync\(\s*process\.execPath,\s*\[resolve\(inputRoot, PRODUCER\)\]/);
    expect(
      parseCommand(["derive", "--out", "artifacts/bootstrap-db-oracle-memo/bootstrap-db-oracle-schedule-memo.json"])
        .command,
    ).toBe("derive");
  });

  it("rejects partial artifact", () => {
    const a = artifactFor(first.m);
    expect(validateArtifact(a.files, first.m, a.manifestSha256)).toEqual(a.receipt);
    for (const deflate of [false, true]) {
      for (const descriptor of [false, true]) expect(readArtifactZip(zipFiles(a.files, { deflate, descriptor }))).toEqual(a.files);
    }
    for (const path of PAYLOADS) {
      const files = new Map(a.files);
      files.delete(path);
      expect(() => validateArtifact(files, first.m, a.manifestSha256)).toThrow("partial artifact");
    }
    const files = new Map(a.files);
    files.set("diagnostic.txt", Buffer.from("not canonical"));
    expect(() => validateArtifact(files, first.m, a.manifestSha256)).toThrow("extra paths");
  });

  it("rejects wrong bytes paths keys provenance", () => {
    const a = artifactFor(first.m);
    const bad = Buffer.from(a.memo);
    bad[0] ^= 1;
    expect(() => validateMemo(bad, first.m.checkerLiterals, a.receipt.producer.stdout)).toThrow();
    const value = JSON.parse(a.memo);
    delete value.entries[Object.keys(value.entries)[0]];
    expect(() =>
      validateMemo(Buffer.from(canonical(value)), first.m.checkerLiterals, a.receipt.producer.stdout),
    ).toThrow("corpus");
    value.entries["[3,[999999999]]"] = 1;
    expect(Object.keys(value.entries)).toHaveLength(4095);
    expect(() =>
      validateMemo(Buffer.from(canonical(value)), first.m.checkerLiterals, a.receipt.producer.stdout),
    ).toThrow("corpus");
    const paths = new Map(a.files);
    paths.set(`../${PAYLOADS[0]}`, paths.get(PAYLOADS[0]));
    paths.delete(PAYLOADS[0]);
    expect(() => validateArtifact(paths, first.m, a.manifestSha256)).toThrow();
    a.receipt.run.checkout = first.m.S;
    a.refresh();
    expect(() => validateArtifact(a.files, first.m, a.manifestSha256)).toThrow("input E");
    for (const names of [
      ["../receipt.json", PAYLOADS[0], "SHA256SUMS"],
      [PAYLOADS[0], PAYLOADS[0], "receipt.json"],
      ["receipt.json"],
    ]) {
      expect(() => readArtifactZip(zipFiles(a.files, { names }))).toThrow();
    }
    expect(() => readArtifactZip(zipFiles(a.files, { mode: 0xa1ff }))).toThrow("link");
    expect(() => readArtifactZip(Buffer.alloc(4 * 1024 * 1024 + 1))).toThrow("compressed limit");
    const zip = zipFiles(artifactFor(first.m).files);
    zip[35] ^= 1;
    expect(() => readArtifactZip(zip)).toThrow();
    const duplicate = Buffer.from(canonical(first.m).replace('"schema":', '"repository":"foreign", "schema":'));
    expect(() => parseManifest(duplicate, sha256(duplicate))).toThrow("canonical");
  });

  it("refuses skipped jobs wrong attempts input drift", () => {
    const a = artifactFor(first.m);
    const zip = zipFiles(a.files);
    const run = {
      id: 999000301,
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      head_sha: first.m.D.commit,
      head_branch: "synthetic-memo",
      path: WORKFLOW,
      event: "workflow_dispatch",
      repository: { full_name: "chase-sets/chase-sets" },
      html_url: "https://example.invalid/synthetic/run",
    };
    const job = {
      id: 999000303,
      run_id: run.id,
      head_sha: run.head_sha,
      name: "Derive Canonical Bootstrap Memo",
      status: "completed",
      conclusion: "success",
      check_run_url: "https://example.invalid/check-runs/999000302",
      html_url: "https://example.invalid/synthetic/job",
      started_at: "2026-11-09T00:00:00Z",
      completed_at: "2026-11-09T00:02:00Z",
      steps: [
        "Admit immutable profile",
        "Verify clean input",
        "Run fixed producer",
        "Validate canonical payloads",
        "Upload canonical memo",
      ].map((name) => ({
        name,
        status: "completed",
        conclusion: "success",
        started_at: "2026-11-09T00:00:00Z",
        completed_at: "2026-11-09T00:02:00Z",
      })),
    };
    const artifact = {
      id: 999000304,
      expired: false,
      name: `bootstrap-db-oracle-memo-${run.id}-1`,
      workflow_run: { id: run.id, head_sha: run.head_sha },
      digest: `sha256:${sha256(zip)}`,
    };
    const input = { m: first.m, manifestSha256: a.manifestSha256, run, jobs: [job], artifact, zip };
    expect(acceptCompletedArtifact(input).jobId).toBe(job.id);
    for (const status of ["queued", "in_progress"])
      expect(() => acceptCompletedArtifact({ ...input, run: { ...run, status } })).toThrow("completed");
    expect(() => acceptCompletedArtifact({ ...input, run: { ...run, run_attempt: 2 } })).toThrow("attempt 1");
    expect(() => acceptCompletedArtifact({ ...input, jobs: [{ ...job, conclusion: "skipped" }] })).toThrow(
      "numeric job",
    );
    expect(() => acceptCompletedArtifact({ ...input, jobs: [{ ...job, steps: job.steps.slice(1) }] })).toThrow(
      "missing step",
    );
    expect(() => acceptCompletedArtifact({ ...input, artifact: { ...artifact, expired: true } })).toThrow("expired");
    expect(() => acceptCompletedArtifact({ ...input, jobs: [job, job] })).toThrow("join");
    const applicationOptions = { objectRoot: first.directory, acceptedMemoSha256: sha256(read(MEMO)) };
    expect(checkApplication(first.m, first.m.E.commit, applicationOptions).rawCheck).toBe("PENDING_HOST");
    expect(() => checkApplication(first.m, first.m.S.commit, applicationOptions)).toThrow("publication input drift");
  });

  it("serializes without cancellation and invalidates drift", async () => {
    expect(workflowValue.concurrency).toEqual({
      group: "bootstrap-db-oracle-memo-global",
      "cancel-in-progress": false,
    });
    const stale = copy(first.m);
    stale.readClosureSha256 = "0".repeat(64);
    await expect(admitProfile(stale, options(first))).rejects.toThrow("read closure");
    const wrong = copy(first.m);
    wrong.D = wrong.W;
    await expect(admitProfile(wrong, { ...options(first), dispatchSha: wrong.D.commit })).rejects.toThrow();
  });

  it("preflight refuses queued run", () => {
    const registration = { id: 999000500, path: WORKFLOW, state: "active" };
    expect(preflightWorkflow(registration, []).workflowId).toBe(registration.id);
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      expect(() => preflightWorkflow(registration, [{ workflow_id: registration.id, status }])).toThrow(
        "dispatch refused",
      );
    }
    expect(() => preflightWorkflow({ ...registration, state: "disabled_manually" }, [])).toThrow("registration");
  });
});
