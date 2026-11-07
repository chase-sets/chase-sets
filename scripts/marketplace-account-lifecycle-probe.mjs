// Probe-only hosted classification of the development-target Marketplace Account
// suite. One job runs the unchanged suite twice in one compose project: Run 1 on a
// fresh runner with no sandbox volume (clean), Run 2 after `dev:down` kept that
// volume (retained). Each run's evidence is copied to its own directory before the
// next step, joined to the checked-out head, and classified by its first causal
// edge. The probe never repairs, retries, filters or re-times the suite.
//
// Two modes, chosen by the checked-out head. At the pinned baseline head the probe
// is the immutable pre-edit classification (base product tree plus probe paths
// only). At any other head it is the final repaired-head proof: the baseline must be
// an ancestor, the pull request may change only the probe paths and the bound repair
// footprint, and both runs must pass. Repaired evidence never reports a baseline
// decision, and baseline evidence is never re-earned by a repaired head.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildPackageManagerInvocation } from "./lib/process.mjs";
import { resolveWorktreeSandbox } from "./lib/sandbox.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

export const probeSchemaVersion = 1;
export const probeSuiteId = "marketplace_account";
export const probeSuiteGrep = "@marketplace-account";
export const probeDevelopmentTarget = "browser-e2e";
export const probeOwnedPaths = Object.freeze([
  ".github/workflows/marketplace-account-lifecycle-probe.yml",
  "scripts/marketplace-account-lifecycle-probe.mjs",
  "scripts/marketplace-account-lifecycle-probe.test.mjs",
]);
// The pre-edit classification this probe already produced (head 1 of the draft).
// Its hosted evidence is the AC1 record; a repaired head joins to it, never redoes it.
export const probeBaseline = Object.freeze({
  head: "be20aeed5f3108b1106676572c80bd7f823ae194",
  runId: "41403552667",
  jobId: "125140419898",
  artifactId: "13123187369",
  artifactSha256: "803f3aa0d5024ca129475f9a574d2e96e393c8ada4b8e6f3ffb3d4992f873093",
  decision: "CONTROL_FAILED",
});
// Product behavior a repaired head may change; one of these must change.
export const probeRepairPaths = Object.freeze([
  "bounded-contexts/auth/support/api-support/register-routes.ts",
  "bounded-contexts/auth/support/route-support/auth-action-errors.ts",
  "deployables/marketplace/e2e/support/auth.ts",
]);
// Their owner-local tests and the workflow's release-scope registration.
export const probeRepairSupportPaths = Object.freeze([
  "bounded-contexts/auth/support/api-support/register-routes.test.ts",
  "bounded-contexts/auth/support/route-support/auth-action-errors.test.ts",
  "deployables/marketplace/app/smoke-auth-support.test.ts",
  "deployables/marketplace/e2e/account-management-interruption.spec.ts",
  "deployables/marketplace/e2e/manual-sync-recovery.spec.ts",
  "deployables/marketplace/e2e/critical-flows.spec.ts",
  "deployables/marketplace/e2e/channel-connection-connect.spec.ts",
  "deployables/marketplace/e2e/agent-grant-revocation-real-route.spec.ts",
  "bounded-contexts/channels/features/manual-sync/tests/browser-recovery-fixture.ts",
  "bounded-contexts/channels/features/manual-sync/tests/browser-recovery-fixture.test.ts",
  "bounded-contexts/channels/features/manual-sync/api/seed.db.test.ts",
  "bounded-contexts/channels/support/seed-support/manual-sync-browser.ts",
  "bounded-contexts/channels/context.json",
  "deployables/marketplace/e2e/support/manual-sync-recovery.ts",
  "deployables/marketplace/app/manual-sync-recovery-support.test.ts",
  "infrastructure/playwright-evidence/responsive-evidence-manifest.json",
  "scripts/release-qualification-scope.mjs",
  "scripts/release-qualification-scope.test.mjs",
]);
export const probeRuns = Object.freeze([
  Object.freeze({ index: 1, mode: "clean", directory: "run-1-clean" }),
  Object.freeze({ index: 2, mode: "retained", directory: "run-2-retained" }),
]);
export const probeCiBranchMarker = "Primed projection wake relay cursors at";

// Seeded identities the Marketplace Account suite signs in with. The test file pins
// these to the canonical seed contract and identity seed ids so drift fails there.
export const seedReceiptIdentities = Object.freeze({
  buyer: Object.freeze({
    email: "collector@chasesets.test",
    accountId: "acc_seed_collector_account",
    userId: "usr_seed_collector_user",
    membershipId: "mbr_seed_collector_membership",
  }),
  seller: Object.freeze({
    email: "demo@chasesets.test",
    accountId: "acc_seed_demo_account",
    userId: "usr_seed_demo_user",
    membershipId: "mbr_seed_demo_membership",
  }),
});
export const seedReceiptCatalogItemIds = Object.freeze([
  "cat_seed_bulbasaur_base_set",
  "cat_seed_charizard_base_set",
  "cat_seed_japanese_charizard_base_set",
  "cat_seed_lugia_neo_genesis",
  "cat_seed_mewtwo_black_star_promo",
  "cat_seed_pikachu_jungle",
  "cat_seed_pikachu_prismatic_evolutions",
  "cat_seed_prismatic_evolutions_booster_pack",
  "cat_seed_surging_sparks_booster_box",
  "cat_seed_twilight_masquerade_elite_trainer_box",
]);

const signInFailurePattern =
  /password sign-in should start a session|marketplace sign-in form must expose|status=401\b|\b401 Unauthorized\b/i;
const failedResultStatuses = new Set(["failed", "timedOut", "interrupted"]);

export function requiredSeedStreams() {
  const identityStreams = Object.entries(seedReceiptIdentities).flatMap(([role, identity]) => [
    { role, streamId: `identity.account-${identity.accountId}` },
    { role, streamId: `identity.user-${identity.userId}` },
    { role, streamId: `identity.membership-${identity.membershipId}` },
  ]);
  const catalogStreams = seedReceiptCatalogItemIds.map((id) => ({ role: "browse", streamId: `catalog.item-${id}` }));
  return [...identityStreams, ...catalogStreams];
}

export function postgresVolumeName(composeProjectName) {
  return `${composeProjectName}_chase-sets-postgres-dev-data`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalDigest(value) {
  return sha256(JSON.stringify(value));
}

/** Paths a product-tree join forbids: anything the head changed beyond the probe. */
export function changedPathsOutsideProbe(changedPaths) {
  return changedPaths.filter((changedPath) => !probeOwnedPaths.includes(changedPath));
}

/** The pinned baseline head classifies the base product tree; every other head is a repaired-head proof. */
export function probeModeFor(head) {
  return head === probeBaseline.head ? "baseline" : "repaired";
}

/**
 * Joins a repaired head to the immutable baseline: the baseline is an ancestor, the
 * pull request's own change set stays inside the probe paths and the bound repair
 * footprint, and it changes at least one repair path. Any miss is an invalid control.
 */
export function evaluateRepairedHead({ head, baselineIsAncestor, changedPaths }) {
  const reasons = [];
  if (head === probeBaseline.head) reasons.push("repaired-head proof ran at the baseline head");
  if (!baselineIsAncestor)
    reasons.push(`baseline head ${probeBaseline.head} is not an ancestor of the checked-out head`);
  const allowed = new Set([...probeOwnedPaths, ...probeRepairPaths, ...probeRepairSupportPaths]);
  const outside = changedPaths.filter((changedPath) => !allowed.has(changedPath));
  if (outside.length > 0) reasons.push(`product tree changed beyond the bound repair footprint: ${outside.join(", ")}`);
  if (!changedPaths.some((changedPath) => probeRepairPaths.includes(changedPath))) {
    reasons.push("repaired head changes no repair path");
  }
  return { proven: reasons.length === 0, reasons };
}

function flattenSpecs(suite) {
  return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(flattenSpecs)];
}

/** Ordered (file, title, project) identity of the listed or executed suite. */
export function listedTests(report) {
  return (report?.suites ?? [])
    .flatMap(flattenSpecs)
    .flatMap((spec) =>
      (spec.tests ?? []).map((test) => ({ file: spec.file, title: spec.title, project: test.projectName })),
    )
    .sort((left, right) =>
      `${left.project}\u0000${left.file}\u0000${left.title}`.localeCompare(
        `${right.project}\u0000${right.file}\u0000${right.title}`,
        "en",
      ),
    );
}

export function summarizePerTest(report) {
  const tests = (report?.suites ?? []).flatMap(flattenSpecs).flatMap((spec) =>
    (spec.tests ?? []).map((test) => {
      const results = (test.results ?? []).map((result) => ({
        retry: result.retry,
        status: result.status,
        startTime: result.startTime ?? null,
        durationMs: result.duration ?? 0,
        errors: (result.errors ?? []).map((error) => String(error.message ?? "").slice(0, 2_000)),
      }));
      return {
        file: spec.file,
        title: spec.title,
        project: test.projectName,
        outcome: test.status,
        results,
      };
    }),
  );
  const executed = tests.filter((test) => test.results.length > 0);
  const resultEnds = executed.flatMap((test) =>
    test.results.filter((result) => result.startTime).map((result) => Date.parse(result.startTime) + result.durationMs),
  );
  const count = (outcome) => tests.filter((test) => test.outcome === outcome).length;
  const signInFailures = tests
    .filter((test) => test.outcome === "unexpected")
    .filter((test) =>
      test.results.some(
        (result) =>
          failedResultStatuses.has(result.status) && result.errors.some((error) => signInFailurePattern.test(error)),
      ),
    )
    .map((test) => ({ file: test.file, title: test.title, project: test.project }));
  return {
    schemaVersion: probeSchemaVersion,
    kind: "marketplace-account-per-test",
    startTime: report?.stats?.startTime ?? null,
    testsEndedAt: resultEnds.length > 0 ? new Date(Math.max(...resultEnds)).toISOString() : null,
    counts: {
      total: tests.length,
      executed: executed.length,
      expected: count("expected"),
      unexpected: count("unexpected"),
      flaky: count("flaky"),
      skipped: count("skipped"),
    },
    globalErrors: (report?.errors ?? []).map((error) => String(error.message ?? "").slice(0, 4_000)),
    signInFailures,
    tests,
  };
}

/**
 * Judges a seed receipt: every required stream must exist with at least one event,
 * and every context database must answer. Aggregate per-category counts and each
 * required stream's first event id are recorded so a retained run can prove it saw
 * the same seeded aggregates, not merely rows that look similar.
 */
export function evaluateSeedReceipt({ contexts, streams }) {
  const unreachable = contexts.filter((context) => context.error).map((context) => context.contextName);
  const missing = requiredSeedStreams()
    .filter((required) => !streams.some((stream) => stream.streamId === required.streamId && stream.events > 0))
    .map((required) => required.streamId);
  return {
    schemaVersion: probeSchemaVersion,
    kind: "marketplace-account-seed-receipt",
    complete: unreachable.length === 0 && missing.length === 0,
    unreachableContexts: unreachable,
    missingStreams: missing,
    identities: requiredSeedStreams().map((required) => {
      const stream = streams.find((candidate) => candidate.streamId === required.streamId);
      return {
        role: required.role,
        streamId: required.streamId,
        contextName: stream?.contextName ?? null,
        events: stream?.events ?? 0,
        version: stream?.version ?? null,
        firstEventId: stream?.firstEventId ?? null,
        firstEventType: stream?.firstEventType ?? null,
      };
    }),
    aggregate: contexts.map(({ contextName, categories = [], error = null }) => ({ contextName, categories, error })),
    aggregateDigest: canonicalDigest(contexts.map(({ contextName, categories = [] }) => ({ contextName, categories }))),
  };
}

export function evaluateCleanPrecondition({ volumeNames, composeProjectName, browserE2eRunsPresent }) {
  const reasons = [];
  const owned = volumeNames.filter((name) => name.startsWith(`${composeProjectName}_`));
  if (owned.length > 0) reasons.push(`clean run found sandbox volumes before start: ${owned.join(", ")}`);
  if (browserE2eRunsPresent) reasons.push("clean run found prior browser-e2e run evidence (pre-seeded checkout)");
  return { proven: reasons.length === 0, reasons };
}

/**
 * Run 2 is retained only when the same volume object (name and creation time)
 * survived `dev:down` and every seeded stream Run 1 left kept its first event id.
 * Run 1's own seed completeness is Run 1's verdict, not a retained-volume join.
 */
export function evaluateRetainedPrecondition({ run1Volume, afterDownVolume, beforeRun2Volume, run1Seed, run2Seed }) {
  const reasons = [];
  const sameVolume = (left, right) =>
    Boolean(left?.present && right?.present && left.name === right.name && left.createdAt === right.createdAt);
  if (!run1Volume?.present) reasons.push("Run 1 left no sandbox volume");
  if (!sameVolume(run1Volume, afterDownVolume)) reasons.push("dev:down did not keep Run 1's volume");
  if (!sameVolume(run1Volume, beforeRun2Volume)) reasons.push("Run 2 did not start on Run 1's volume");
  if (!run1Seed || !run2Seed) {
    reasons.push("retained seed identities are unjoinable without both seed receipts");
  } else {
    const changed = run1Seed.identities
      .filter((identity) => identity.firstEventId !== null)
      .filter((identity) => {
        const next = run2Seed.identities.find((candidate) => candidate.streamId === identity.streamId);
        return next?.firstEventId !== identity.firstEventId;
      })
      .map((identity) => identity.streamId);
    if (changed.length > 0) reasons.push(`retained seed identities changed: ${changed.join(", ")}`);
  }
  return { proven: reasons.length === 0, run1SeedComplete: run1Seed?.complete === true, reasons };
}

/** An unproven retained precondition makes Run 2 an invalid control, whatever its suite did. */
export function withRetainedPrecondition(summary, retained) {
  if (retained.proven || summary.classification.verdict === "invalid") {
    return { ...summary, retainedPrecondition: retained };
  }
  return {
    ...summary,
    retainedPrecondition: retained,
    classification: { ...summary.classification, verdict: "invalid", firstCausalEdge: "retained-precondition" },
  };
}

function isBootstrapService(service) {
  return service.name.startsWith("bootstrap-");
}

/**
 * Classifies one run by its first causal edge, in lifecycle order. Missing or
 * mismatched evidence makes the run invalid rather than a product signal.
 */
export function classifyRun({
  suiteExitCode,
  lifecycle,
  readiness,
  workerLogBytes,
  ciBranchObserved,
  seedReceipt,
  perTest,
  listedCount,
  productTreeUnchanged,
}) {
  const services = lifecycle?.services ?? [];
  const runtimeServices = services.filter((service) => !isBootstrapService(service));
  const exits = services
    .filter((service) => service.exitedAt)
    .sort((left, right) => Date.parse(left.exitedAt) - Date.parse(right.exitedAt));
  const firstChildExit = exits[0]
    ? {
        name: exits[0].name,
        exitedAt: exits[0].exitedAt,
        exitCode: exits[0].exitCode,
        signal: exits[0].signal,
        spawnError: exits[0].spawnError ?? null,
      }
    : null;
  const testsEndedAt = perTest?.testsEndedAt ? Date.parse(perTest.testsEndedAt) : null;

  const edges = [
    ["invalid", "product-tree", () => productTreeUnchanged === true],
    [
      "invalid",
      "lifecycle-evidence",
      () =>
        lifecycle?.kind === "browser-e2e-service-lifecycle" &&
        lifecycle.schemaVersion === 1 &&
        lifecycle.target === probeDevelopmentTarget,
    ],
    [
      "invalid",
      "readiness-evidence",
      () =>
        readiness?.kind === "browser-e2e-readiness" &&
        readiness.schemaVersion === 1 &&
        readiness.target === probeDevelopmentTarget,
    ],
    [
      "fail",
      "startup",
      () =>
        services
          .filter(isBootstrapService)
          .every((service) => service.status === "exited" && service.exitCode === 0 && !service.spawnError) &&
        services.some(isBootstrapService),
    ],
    ["fail", "readiness", () => readiness.outcome === "ready"],
    ["invalid", "ci-branch", () => ciBranchObserved === true],
    ["invalid", "worker-evidence", () => workerLogBytes > 0],
    ["invalid", "seed-evidence", () => seedReceipt?.kind === "marketplace-account-seed-receipt"],
    ["fail", "seed", () => seedReceipt.complete === true],
    ["invalid", "per-test-evidence", () => perTest?.kind === "marketplace-account-per-test"],
    // A runtime service that exits before the last test result ends lost
    // readiness mid-suite; Playwright's own teardown exits come after it.
    [
      "fail",
      "post-readiness-loss",
      () =>
        testsEndedAt === null ||
        runtimeServices.every((service) => !service.exitedAt || Date.parse(service.exitedAt) >= testsEndedAt),
    ],
    [
      "fail",
      "zero-specs",
      () => perTest.counts.total === listedCount && perTest.counts.expected + perTest.counts.flaky > 0,
    ],
    ["fail", "sign-in", () => perTest.signInFailures.length === 0],
    ["fail", "suite", () => suiteExitCode === 0 && perTest.counts.unexpected === 0],
  ];

  const evaluated = [];
  for (const [failureKind, edge, holds] of edges) {
    const passed = holds();
    evaluated.push({ edge, passed });
    if (!passed) {
      return { verdict: failureKind, firstCausalEdge: edge, firstChildExit, edges: evaluated };
    }
  }
  return { verdict: "pass", firstCausalEdge: null, firstChildExit, edges: evaluated };
}

/**
 * Applies the issue's first-match stop conditions to the paired controls. A
 * repaired head has no second repair: any failing run is that head's verdict.
 */
export function decideProbe({ mode, invalidReasons, runs }) {
  if (mode !== "baseline" && mode !== "repaired") throw new Error(`Unknown probe mode: ${mode}`);
  const invalidRuns = runs.filter((run) => run.classification.verdict === "invalid");
  if (invalidReasons.length > 0 || invalidRuns.length > 0 || runs.length !== probeRuns.length) {
    return {
      decision: "INVALID_CONTROL",
      next: "Not a product signal: rerun once on a fresh runner; a second invalid result stops to host.",
      reasons: [
        ...invalidReasons,
        ...invalidRuns.map((run) => `run ${run.index} (${run.mode}) invalid at ${run.classification.firstCausalEdge}`),
      ],
    };
  }
  const failures = runs
    .filter((run) => run.classification.verdict === "fail")
    .map((run) => `run ${run.index} (${run.mode}) failed at ${run.classification.firstCausalEdge}`);
  if (mode === "repaired") {
    return failures.length > 0
      ? {
          decision: "REPAIRED_FAIL",
          next: "The repaired head did not pass both runs: return this verdict to host; no further repair, filter or completion claim.",
          reasons: failures,
        }
      : {
          decision: "REPAIRED_PASS",
          next: "The repaired head passed the unchanged suite on both the clean and the retained run.",
          reasons: [],
        };
  }
  const failed = runs.find((run) => run.classification.verdict === "fail");
  if (failed) {
    return {
      decision: "CONTROL_FAILED",
      next: `Repair only the first causal edge '${failed.classification.firstCausalEdge}' of run ${failed.index} (${failed.mode}) and prove the unchanged suite on hosted CI.`,
      reasons: failures,
    };
  }
  return {
    decision: "BOTH_PASS",
    next: "No repair. RESIDUAL_DECISION: what hosted evidence satisfies the unchanged parent exit gate when hosted CI does not reproduce it.",
    reasons: [],
  };
}

export function probeExitCode(decision) {
  return { BOTH_PASS: 0, REPAIRED_PASS: 0, CONTROL_FAILED: 2, REPAIRED_FAIL: 2, INVALID_CONTROL: 3 }[decision] ?? 3;
}

function parseArgs(argv) {
  const index = argv.indexOf("--out-dir");
  const outDir = index >= 0 ? argv[index + 1] : undefined;
  if (!outDir) throw new Error("Usage: node scripts/marketplace-account-lifecycle-probe.mjs --out-dir <directory>");
  return { outDir: path.resolve(rootDir, outDir) };
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null,
  };
}

function git(...args) {
  const result = capture("git", args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.error ?? result.stderr}`);
  return result.stdout.trim();
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : null;
}

function createLogger(logPath) {
  return (message) => {
    const line = `[lifecycle-probe ${new Date().toISOString()}] ${message}`;
    console.log(line);
    appendFileSync(logPath, `${line}\n`);
  };
}

function captureDocker() {
  const info = capture("docker", ["info", "--format", "{{json .}}"]);
  const parsed = info.status === 0 ? JSON.parse(info.stdout) : null;
  const compose = capture("docker", ["compose", "version", "--short"]);
  return {
    available: info.status === 0,
    error: info.status === 0 ? null : (info.error ?? info.stderr.slice(0, 2_000)),
    serverVersion: parsed?.ServerVersion ?? null,
    operatingSystem: parsed?.OperatingSystem ?? null,
    kernelVersion: parsed?.KernelVersion ?? null,
    architecture: parsed?.Architecture ?? null,
    cpus: parsed?.NCPU ?? null,
    memTotalBytes: parsed?.MemTotal ?? null,
    storageDriver: parsed?.Driver ?? null,
    composeVersion: compose.status === 0 ? compose.stdout.trim() : null,
  };
}

function listVolumes() {
  const result = capture("docker", ["volume", "ls", "--format", "{{.Name}}"]);
  if (result.status !== 0) throw new Error(`docker volume ls failed: ${result.error ?? result.stderr}`);
  return result.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
}

function inspectVolume(name) {
  const result = capture("docker", ["volume", "inspect", name]);
  if (result.status !== 0) return { present: false, name, createdAt: null, labels: {} };
  const [volume] = JSON.parse(result.stdout);
  return {
    present: true,
    name: volume.Name,
    createdAt: volume.CreatedAt,
    labels: {
      project: volume.Labels?.["com.docker.compose.project"] ?? null,
      volume: volume.Labels?.["com.docker.compose.volume"] ?? null,
    },
  };
}

function captureIdentity(sandbox, phase, sourceHeadSha) {
  const head = git("rev-parse", "HEAD");
  const trackedChanges = git("status", "--porcelain", "--untracked-files=no");
  return {
    phase,
    capturedAt: new Date().toISOString(),
    git: {
      head,
      tree: git("rev-parse", "HEAD^{tree}"),
      sourceHeadSha,
      headMatchesSource: head === sourceHeadSha,
      trackedChanges: trackedChanges === "" ? [] : trackedChanges.split(/\r?\n/),
    },
    ciMode: {
      CI: process.env.CI ?? null,
      CHASE_SETS_BROWSER_E2E_SYSTEM: process.env.CHASE_SETS_BROWSER_E2E_SYSTEM ?? null,
    },
    composeProject: sandbox.composeProjectName,
    volumes: listVolumes(),
    postgresVolume: inspectVolume(postgresVolumeName(sandbox.composeProjectName)),
  };
}

export function evaluateSuiteListing(result) {
  const status = Number.isSafeInteger(result?.status) ? result.status : null;
  let report = null;
  try {
    const stdout = typeof result?.stdout === "string" ? result.stdout : "";
    const reportStart = stdout.indexOf('{\n  "config"');
    const start = reportStart >= 0 ? reportStart : stdout.indexOf("{");
    if (start >= 0) report = JSON.parse(stdout.slice(start));
  } catch {
    /* Only the closed diagnostic crosses this boundary. */
  }
  const failure = (code) => {
    const diagnostic = { code, status };
    const candidate = report?.errors?.[0]?.location;
    if (
      candidate &&
      typeof candidate.file === "string" &&
      candidate.file.length <= 240 &&
      /^[A-Za-z0-9_.\/-]+$/.test(candidate.file) &&
      !candidate.file.startsWith("/") &&
      candidate.file.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
      Number.isSafeInteger(candidate.line) &&
      candidate.line > 0 &&
      candidate.line <= 2147483647
    ) {
      diagnostic.location = { file: candidate.file, line: candidate.line };
    }
    return { report: null, diagnostic };
  };
  if (status !== 0) return failure("LIST_PROCESS_FAILED");
  if (
    !report ||
    typeof report !== "object" ||
    !Array.isArray(report.suites) ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0
  )
    return failure("LIST_REPORT_INVALID");
  const validSuite = (suite) =>
    suite &&
    typeof suite === "object" &&
    (Array.isArray(suite.specs) || Array.isArray(suite.suites)) &&
    Array.isArray(suite.specs ?? []) &&
    Array.isArray(suite.suites ?? []) &&
    (suite.specs ?? []).every(
      (spec) =>
        spec &&
        typeof spec.file === "string" &&
        typeof spec.title === "string" &&
        Array.isArray(spec.tests) &&
        spec.tests.length > 0 &&
        spec.tests.every((test) => test && typeof test === "object" && typeof test.projectName === "string"),
    ) &&
    (suite.suites ?? []).every(validSuite);
  if (!report.suites.every(validSuite)) return failure("LIST_REPORT_INVALID");
  const tests = listedTests(report);
  if (tests.length === 0) return failure("LIST_EMPTY");
  if (tests.length !== 73 || new Set(tests.map((test) => JSON.stringify(test))).size !== 73)
    return failure("LIST_INCOMPLETE");
  return { report, diagnostic: null };
}

function listSuite(log) {
  const invocation = buildPackageManagerInvocation([
    "exec",
    "playwright",
    "test",
    "--grep",
    probeSuiteGrep,
    "--list",
    "--reporter=json",
  ]);
  const result = capture(invocation.command, invocation.args);
  const listing = evaluateSuiteListing(result);
  if (listing.diagnostic) log(`suite listing failed: ${JSON.stringify(listing.diagnostic)}`);
  return listing;
}

function playwrightVersion() {
  const invocation = buildPackageManagerInvocation(["exec", "playwright", "--version"]);
  const result = capture(invocation.command, invocation.args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function runStreamed(command, args, { env, logPath }) {
  return new Promise((resolve) => {
    const output = createWriteStream(logPath);
    const child = spawn(command, args, { cwd: rootDir, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      output.write(chunk);
    });
    child.on("error", (error) => {
      output.end(`\n[lifecycle-probe] spawn error: ${error.message}\n`);
      resolve({ exitCode: null, spawnError: error.message });
    });
    child.on("close", (code, signal) => {
      output.end(() => resolve({ exitCode: code, signal, spawnError: null }));
    });
  });
}

async function captureSeedReceipt(sandbox) {
  const contexts = [];
  const streams = [];
  const requiredIds = requiredSeedStreams().map((required) => required.streamId);
  for (const [contextName, connectionString] of Object.entries(sandbox.contextDatabaseUrls).sort()) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000, statement_timeout: 60_000 });
    try {
      await client.connect();
      const table = await client.query("SELECT to_regclass('event_store_events') IS NOT NULL AS present");
      if (!table.rows[0]?.present) {
        contexts.push({ contextName, categories: [], error: null });
        continue;
      }
      const categories = await client.query(
        `SELECT stream_category AS category, count(*)::bigint AS events,
                count(DISTINCT stream_id)::bigint AS streams
           FROM event_store_events GROUP BY stream_category ORDER BY stream_category`,
      );
      contexts.push({
        contextName,
        categories: categories.rows.map((row) => ({
          category: row.category,
          events: Number(row.events),
          streams: Number(row.streams),
        })),
        error: null,
      });
      const found = await client.query(
        `SELECT stream_id, count(*)::bigint AS events, max(stream_version)::bigint AS version,
                (array_agg(event_id ORDER BY global_position))[1] AS first_event_id,
                (array_agg(event_type ORDER BY global_position))[1] AS first_event_type
           FROM event_store_events WHERE stream_id = ANY($1::text[]) GROUP BY stream_id`,
        [requiredIds],
      );
      for (const row of found.rows) {
        streams.push({
          contextName,
          streamId: row.stream_id,
          events: Number(row.events),
          version: Number(row.version),
          firstEventId: row.first_event_id,
          firstEventType: row.first_event_type,
        });
      }
    } catch (error) {
      contexts.push({ contextName, categories: [], error: error instanceof Error ? error.message : String(error) });
    } finally {
      await client.end().catch(() => {});
    }
  }
  return { capturedAt: new Date().toISOString(), ...evaluateSeedReceipt({ contexts, streams }) };
}

function browserE2eRunDirectories(sandbox) {
  const runsRoot = path.join(rootDir, "artifacts", "browser-e2e", "runs", sandbox.id);
  return existsSync(runsRoot) ? readdirSync(runsRoot).map((name) => path.join(runsRoot, name)) : [];
}

function copyIfPresent(source, destination) {
  if (!existsSync(source)) return false;
  cpSync(source, destination, { recursive: true });
  return true;
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

function fileDigests(directory) {
  return listFiles(directory)
    .map((filePath) => ({
      path: path.relative(directory, filePath).split(path.sep).join("/"),
      sha256: sha256(readFileSync(filePath)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function directoryDigest(directory) {
  return canonicalDigest(fileDigests(directory));
}

async function runControl({ run, sandbox, outDir, sourceHeadSha, listedCount, log }) {
  const runDir = path.join(outDir, run.directory);
  mkdirSync(runDir, { recursive: false });
  const before = captureIdentity(sandbox, `before-run-${run.index}`, sourceHeadSha);
  const evidenceBefore = new Set(browserE2eRunDirectories(sandbox));
  writeJson(path.join(runDir, "pre-run.json"), { ...before, browserE2eRunsBefore: [...evidenceBefore] });
  log(`run ${run.index} (${run.mode}) starting at ${before.git.head}; volume present=${before.postgresVolume.present}`);

  const startedAt = new Date().toISOString();
  const invocation = buildPackageManagerInvocation(["run", "test:e2e:suite", probeSuiteId]);
  const suite = await runStreamed(invocation.command, invocation.args, {
    env: {
      ...process.env,
      CI: "true",
      CHASE_SETS_BROWSER_E2E_SYSTEM: "development",
      // Additive observer only: the config's reporters, grep, workers, retries and
      // timeouts stay unchanged; this writes Playwright's JSON report per run.
      PW_TEST_REPORTER: "json",
      PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(runDir, "playwright-report.json"),
    },
    logPath: path.join(runDir, "suite.log"),
  });
  const finishedAt = new Date().toISOString();
  log(`run ${run.index} suite exited code=${suite.exitCode} signal=${suite.signal ?? null}`);

  const newEvidence = browserE2eRunDirectories(sandbox).filter((directory) => !evidenceBefore.has(directory));
  for (const directory of newEvidence) {
    cpSync(directory, path.join(runDir, "browser-e2e", path.basename(directory)), { recursive: true });
  }
  copyIfPresent(path.join(rootDir, "artifacts", "playwright", "report"), path.join(runDir, "playwright-html"));
  copyIfPresent(path.join(rootDir, "artifacts", "playwright", "test-results"), path.join(runDir, "test-results"));

  const evidenceDirectory =
    newEvidence.length === 1 ? path.join(runDir, "browser-e2e", path.basename(newEvidence[0])) : null;
  const lifecycle = evidenceDirectory ? readJson(path.join(evidenceDirectory, "lifecycle.json")) : null;
  const readiness = evidenceDirectory ? readJson(path.join(evidenceDirectory, "readiness.json")) : null;
  const workerLogPath = evidenceDirectory ? path.join(evidenceDirectory, "platform-worker.jsonl") : null;
  const workerLogBytes = workerLogPath && existsSync(workerLogPath) ? statSync(workerLogPath).size : 0;
  const suiteLog = readFileSync(path.join(runDir, "suite.log"), "utf8");
  const ciBranchObserved = suiteLog.includes(probeCiBranchMarker);

  const seedReceipt = await captureSeedReceipt(sandbox);
  writeJson(path.join(runDir, "seed-receipt.json"), seedReceipt);
  const rawReport = readJson(path.join(runDir, "playwright-report.json"));
  const perTest = rawReport ? summarizePerTest(rawReport) : null;
  if (perTest) writeJson(path.join(runDir, "per-test.json"), perTest);
  const after = captureIdentity(sandbox, `after-run-${run.index}`, sourceHeadSha);
  const productTreeUnchanged =
    before.git.head === after.git.head &&
    before.git.tree === after.git.tree &&
    after.git.headMatchesSource &&
    before.git.trackedChanges.length === 0 &&
    after.git.trackedChanges.length === 0;

  const classification = classifyRun({
    suiteExitCode: suite.exitCode,
    lifecycle,
    readiness,
    workerLogBytes,
    ciBranchObserved,
    seedReceipt,
    perTest,
    listedCount,
    productTreeUnchanged,
  });
  const bootstrap = (lifecycle?.services ?? []).filter(isBootstrapService).map((service) => ({
    name: service.name,
    exitCode: service.exitCode,
    durationMs: service.exitedAt ? Date.parse(service.exitedAt) - Date.parse(service.spawnedAt) : null,
  }));
  const summary = {
    schemaVersion: probeSchemaVersion,
    kind: "marketplace-account-probe-run",
    index: run.index,
    mode: run.mode,
    suite: probeSuiteId,
    startedAt,
    finishedAt,
    suiteExitCode: suite.exitCode,
    suiteSignal: suite.signal ?? null,
    evidenceDirectories: newEvidence.map((directory) => path.basename(directory)),
    readiness: readiness
      ? { outcome: readiness.outcome, startedAt: readiness.startedAt, completedAt: readiness.completedAt }
      : null,
    bootstrap,
    ciBranchObserved,
    workerLogBytes,
    seedComplete: seedReceipt.complete,
    testCounts: perTest?.counts ?? null,
    listedCount,
    productTreeUnchanged,
    postgresVolume: after.postgresVolume,
    classification,
  };
  writeJson(path.join(runDir, "run.json"), summary);
  writeJson(path.join(runDir, "post-run.json"), after);
  log(
    `run ${run.index} (${run.mode}) verdict=${classification.verdict} firstCausalEdge=${classification.firstCausalEdge ?? "none"} ` +
      `tests=${JSON.stringify(perTest?.counts ?? null)} seedComplete=${seedReceipt.complete}`,
  );
  return { summary, seedReceipt, after };
}

async function main(outDir) {
  if (existsSync(outDir)) throw new Error(`Probe output directory already exists: ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  const log = createLogger(path.join(outDir, "probe-job.log"));
  const sourceHeadSha = process.env.PROBE_SOURCE_HEAD_SHA ?? "";
  const sandbox = resolveWorktreeSandbox();
  const invalidReasons = [];

  const jobStart = captureIdentity(sandbox, "job-start", sourceHeadSha);
  const mode = probeModeFor(jobStart.git.head);
  const eventBaseSha = process.env.PROBE_EVENT_BASE_SHA ?? "";
  // Baseline: the probe commit over the base product tree. Repaired: the pull
  // request's own change set, measured from its merge base with the event base.
  const executedBase =
    mode === "baseline" ? git("rev-parse", "HEAD^") : eventBaseSha ? git("merge-base", eventBaseSha, "HEAD") : null;
  const changedPaths = executedBase
    ? git("diff", "--name-only", executedBase, "HEAD").split(/\r?\n/).filter(Boolean)
    : [];
  const outsideProbe = changedPathsOutsideProbe(changedPaths);
  const repairedHead =
    mode === "repaired"
      ? evaluateRepairedHead({
          head: jobStart.git.head,
          baselineIsAncestor: capture("git", ["merge-base", "--is-ancestor", probeBaseline.head, "HEAD"]).status === 0,
          changedPaths,
        })
      : null;
  const job = {
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
    eventName: process.env.GITHUB_EVENT_NAME ?? null,
    eventBaseSha: process.env.PROBE_EVENT_BASE_SHA ?? null,
  };
  const runner = {
    os: process.env.RUNNER_OS ?? os.platform(),
    arch: process.env.RUNNER_ARCH ?? os.arch(),
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    cpus: os.cpus().length,
    memTotalBytes: os.totalmem(),
    docker: captureDocker(),
    node: process.version,
    playwright: playwrightVersion(),
  };
  writeJson(path.join(outDir, "job-start.json"), {
    ...jobStart,
    mode,
    baseline: probeBaseline,
    job,
    runner,
    executedBase,
    executedBaseTree: executedBase ? git("rev-parse", `${executedBase}^{tree}`) : null,
    changedPaths,
    repairedHead,
  });
  log(
    `mode=${mode} head=${jobStart.git.head} tree=${jobStart.git.tree} executedBase=${executedBase} project=${sandbox.composeProjectName}`,
  );

  if (!jobStart.git.headMatchesSource) invalidReasons.push("checked-out head is not the pull request head");
  if (!executedBase) invalidReasons.push("repaired-head proof has no pull request base to measure its change set");
  if (mode === "baseline" && outsideProbe.length > 0)
    invalidReasons.push(`product tree changed beyond probe paths: ${outsideProbe.join(", ")}`);
  if (repairedHead) invalidReasons.push(...repairedHead.reasons);
  if (jobStart.git.trackedChanges.length > 0) invalidReasons.push("tracked checkout was dirty at job start");
  if (process.env.CI !== "true" || process.env.CHASE_SETS_BROWSER_E2E_SYSTEM !== "development") {
    invalidReasons.push("job is not in CI=true development-target mode");
  }
  if (!runner.docker.available) invalidReasons.push("docker is unavailable on the runner");
  const clean = evaluateCleanPrecondition({
    volumeNames: jobStart.volumes,
    composeProjectName: sandbox.composeProjectName,
    browserE2eRunsPresent: browserE2eRunDirectories(sandbox).length > 0,
  });
  invalidReasons.push(...clean.reasons);

  const listing = listSuite(log);
  const listed = listedTests(listing.report);
  writeJson(path.join(outDir, "suite-listing.json"), {
    count: listed.length,
    digest: canonicalDigest(listed),
    tests: listed,
    diagnostic: listing.diagnostic,
  });
  if (listing.diagnostic) invalidReasons.push(`suite listing failed: ${listing.diagnostic.code}`);
  log(`suite ${probeSuiteId} lists ${listed.length} tests (digest ${canonicalDigest(listed)})`);

  const runs = [];
  let run1;
  let afterDownVolume = null;
  if (invalidReasons.length === 0) {
    run1 = await runControl({
      run: probeRuns[0],
      sandbox,
      outDir,
      sourceHeadSha,
      listedCount: listed.length,
      log,
    });
    runs.push(run1.summary);

    const downInvocation = buildPackageManagerInvocation(["run", "dev:down"]);
    const down = await runStreamed(downInvocation.command, downInvocation.args, {
      env: process.env,
      logPath: path.join(outDir, "run-1-clean", "dev-down.log"),
    });
    const afterDown = captureIdentity(sandbox, "after-dev-down", sourceHeadSha);
    afterDownVolume = afterDown.postgresVolume;
    writeJson(path.join(outDir, "run-1-clean", "after-dev-down.json"), {
      ...afterDown,
      devDownExitCode: down.exitCode,
    });
    log(
      `dev:down exit=${down.exitCode}; volume kept=${afterDownVolume.present} createdAt=${afterDownVolume.createdAt}`,
    );
    if (down.exitCode !== 0) invalidReasons.push("dev:down failed between runs");
    const run1EvidenceDigest = directoryDigest(path.join(outDir, "run-1-clean"));

    const beforeRun2Volume = inspectVolume(postgresVolumeName(sandbox.composeProjectName));
    const run2 = await runControl({
      run: probeRuns[1],
      sandbox,
      outDir,
      sourceHeadSha,
      listedCount: listed.length,
      log,
    });
    const retained = evaluateRetainedPrecondition({
      run1Volume: run1.after.postgresVolume,
      afterDownVolume,
      beforeRun2Volume,
      run1Seed: run1.seedReceipt,
      run2Seed: run2.seedReceipt,
    });
    writeJson(path.join(outDir, "run-2-retained", "retained-precondition.json"), {
      ...retained,
      run1Volume: run1.after.postgresVolume,
      afterDownVolume,
      beforeRun2Volume,
    });
    runs.push(withRetainedPrecondition(run2.summary, retained));
    writeJson(path.join(outDir, "run-2-retained", "run.json"), runs.at(-1));
    if (directoryDigest(path.join(outDir, "run-1-clean")) !== run1EvidenceDigest) {
      invalidReasons.push("Run 1 evidence changed after Run 1 completed");
    }
  }

  const cleanupInvocation = buildPackageManagerInvocation(["run", "dev:down"]);
  const cleanupDown = await runStreamed(cleanupInvocation.command, cleanupInvocation.args, {
    env: process.env,
    logPath: path.join(outDir, "cleanup-dev-down.log"),
  });
  const ownedVolume = postgresVolumeName(sandbox.composeProjectName);
  const removal = inspectVolume(ownedVolume).present ? capture("docker", ["volume", "rm", ownedVolume]) : null;
  const cleanup = {
    schemaVersion: probeSchemaVersion,
    kind: "marketplace-account-probe-cleanup",
    composeProject: sandbox.composeProjectName,
    ownedVolume,
    devDownExitCode: cleanupDown.exitCode,
    volumeRemoveExitCode: removal?.status ?? null,
    volumesAfter: listVolumes(),
  };
  cleanup.ownedStateRemoved = !cleanup.volumesAfter.some((name) => name.startsWith(`${sandbox.composeProjectName}_`));
  writeJson(path.join(outDir, "cleanup-receipt.json"), cleanup);
  log(`cleanup devDown=${cleanup.devDownExitCode} ownedStateRemoved=${cleanup.ownedStateRemoved}`);

  const decision = decideProbe({ mode, invalidReasons, runs });
  log(`decision=${decision.decision} next=${decision.next}`);
  for (const reason of decision.reasons) log(`reason: ${reason}`);

  const files = fileDigests(outDir);
  writeJson(path.join(outDir, "manifest.json"), {
    schemaVersion: probeSchemaVersion,
    kind: "marketplace-account-lifecycle-probe",
    claim: "hosted CI=true development-target path only; the CI-unset lane-host path is not claimed",
    mode,
    baseline: probeBaseline,
    repairedHead,
    suite: {
      id: probeSuiteId,
      grep: probeSuiteGrep,
      listedCount: listed.length,
      listingDigest: canonicalDigest(listed),
    },
    job,
    runner,
    checkout: {
      head: jobStart.git.head,
      tree: jobStart.git.tree,
      sourceHeadSha,
      executedBase,
      changedPaths,
    },
    composeProject: sandbox.composeProjectName,
    ciMode: jobStart.ciMode,
    runs,
    cleanup,
    decision,
    files,
    artifactDigest: canonicalDigest(files),
  });
  process.exitCode = probeExitCode(decision.decision);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outDir } = parseArgs(process.argv.slice(2));
  main(outDir).catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    // A crash before a decision is an invalid control (runner or harness failure).
    if (existsSync(outDir)) {
      writeJson(path.join(outDir, "probe-crash.json"), { decision: "INVALID_CONTROL", error: message });
    }
    process.exitCode = 3;
  });
}
