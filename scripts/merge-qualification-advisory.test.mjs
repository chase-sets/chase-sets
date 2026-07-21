import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MERGE_QUALIFICATION_COMPARISON_SCHEMA_VERSION,
  MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION,
  MERGE_QUALIFICATION_POLICY_PATH,
  MERGE_QUALIFICATION_TERMINAL_STATES,
  buildMergeQualificationEvent,
  dedupeMergeQualificationEvents,
  evaluateMergeQualificationPolicy,
  joinMergeQualificationToStaging,
  resolveMergeQualificationOutcome,
  resolveRunTerminalization,
  summarizeMergeQualification,
  validateMergeQualificationEvent,
} from "./merge-qualification-advisory.mjs";
import {
  classifyReleaseQualificationScope,
  releaseQualificationScopeRegistry,
} from "./release-qualification-scope.mjs";
import { repoRoot } from "./lib/repo.mjs";

const NOW = () => new Date("2026-07-21T12:00:00.000Z");
const DAY_AFTER = () => new Date("2026-07-22T12:00:00.000Z");

const enabledPolicy = {
  schemaVersion: "merge-qualification-policy/v1",
  enabled: true,
  owner: "todd.skelton@chasesets.com",
  ceiling: { dollarCeilingUsd: 25, maxQualificationsPerDay: 20 },
  enabledAt: "2026-07-20T00:00:00.000Z",
  expiresAt: "2026-08-10T00:00:00.000Z",
};

function evaluate(policy, now = NOW) {
  return evaluateMergeQualificationPolicy(policy === null ? null : JSON.stringify(policy), { now });
}

describe("enablement policy fail-closed validation (merge-qualification-policy/v1)", () => {
  it("treats the shipped checked-in policy as disabled (this leaf must stay provider-inert)", () => {
    const content = readFileSync(path.join(repoRoot, MERGE_QUALIFICATION_POLICY_PATH), "utf8");
    const decision = evaluateMergeQualificationPolicy(content, { now: NOW });
    expect(decision.enabled).toBe(false);
    expect(decision.reasonCode).toBe("policy_disabled");
  });

  it.each([
    ["absent file", null, "policy_absent"],
    ["disabled policy", { schemaVersion: "merge-qualification-policy/v1", enabled: false }, "policy_disabled"],
    [
      "unsupported future schema",
      { ...enabledPolicy, schemaVersion: "merge-qualification-policy/v2" },
      "policy_schema_unsupported",
    ],
    ["non-boolean enabled", { ...enabledPolicy, enabled: "yes" }, "policy_malformed"],
    ["unknown field", { ...enabledPolicy, laneOverride: "force" }, "policy_malformed"],
    // Recursively closed nested schema: unknown ceiling fields fail closed
    // exactly like unknown top-level fields (review probe: ceiling.extra).
    [
      "unknown nested ceiling field",
      { ...enabledPolicy, ceiling: { ...enabledPolicy.ceiling, extra: true } },
      "policy_malformed",
    ],
    ["missing owner", { ...enabledPolicy, owner: "  " }, "policy_malformed"],
    ["missing ceiling", { ...enabledPolicy, ceiling: null }, "policy_malformed"],
    ["array ceiling", { ...enabledPolicy, ceiling: [25, 20] }, "policy_malformed"],
    [
      "non-positive ceiling",
      { ...enabledPolicy, ceiling: { dollarCeilingUsd: 0, maxQualificationsPerDay: 20 } },
      "policy_malformed",
    ],
    ["missing enabledAt", { ...enabledPolicy, enabledAt: null }, "policy_malformed"],
    // Timezone-bearing instants only (review probe: date-only values enable
    // through permissive Date.parse).
    ["date-only enabledAt", { ...enabledPolicy, enabledAt: "2026-07-20" }, "policy_malformed"],
    ["date-only expiresAt", { ...enabledPolicy, expiresAt: "2026-08-10" }, "policy_malformed"],
    ["zone-less enabledAt", { ...enabledPolicy, enabledAt: "2026-07-20T00:00:00" }, "policy_malformed"],
    ["future enabledAt", { ...enabledPolicy, enabledAt: "2026-07-22T00:00:00.000Z" }, "policy_malformed"],
    // Explicit bounds: enabledAt < expiresAt is asserted directly, so equal
    // and reversed timestamps are malformed rather than accidentally expired.
    ["expiresAt equal to enabledAt", { ...enabledPolicy, expiresAt: enabledPolicy.enabledAt }, "policy_malformed"],
    ["expiresAt before enabledAt", { ...enabledPolicy, expiresAt: "2026-07-19T00:00:00.000Z" }, "policy_malformed"],
    [
      "expired policy",
      { ...enabledPolicy, enabledAt: "2026-06-01T00:00:00.000Z", expiresAt: "2026-06-20T00:00:00.000Z" },
      "policy_expired",
    ],
    [
      "expiry beyond the 30-day wager horizon",
      { ...enabledPolicy, expiresAt: "2026-08-25T00:00:00.000Z" },
      "policy_expiry_horizon_exceeded",
    ],
    [
      "expiry one millisecond beyond exactly 30 days",
      {
        ...enabledPolicy,
        enabledAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-07-31T00:00:00.001Z",
      },
      "policy_expiry_horizon_exceeded",
    ],
  ])("fails closed to disabled on %s", (_name, policy, reasonCode) => {
    const decision = evaluate(policy);
    expect(decision.enabled).toBe(false);
    expect(decision.reasonCode).toBe(reasonCode);
    expect(decision.errors.length).toBeGreaterThan(0);
  });

  it("fails closed to disabled on unparseable JSON", () => {
    const decision = evaluateMergeQualificationPolicy("{ not json", { now: NOW });
    expect(decision).toMatchObject({ enabled: false, reasonCode: "policy_malformed" });
  });

  it("accepts a complete enabled policy inside the 30-day window", () => {
    const decision = evaluate(enabledPolicy);
    expect(decision).toMatchObject({ enabled: true, state: "enabled", reasonCode: null, errors: [] });
    expect(decision.policy).toMatchObject({ owner: "todd.skelton@chasesets.com" });
  });

  it("accepts exactly enabledAt + 30 days and offset-bearing (non-Z) instants", () => {
    expect(
      evaluate({ ...enabledPolicy, enabledAt: "2026-07-01T00:00:00.000Z", expiresAt: "2026-07-31T00:00:00.000Z" }),
    ).toMatchObject({ enabled: true });
    expect(
      evaluate({ ...enabledPolicy, enabledAt: "2026-07-20T02:00:00+02:00", expiresAt: "2026-08-10T02:00:00+02:00" }),
    ).toMatchObject({ enabled: true });
  });

  describe("day-after probes (steady state in both directions)", () => {
    it("disabled policy is still disabled on the next routine run, byte-for-byte the same decision", () => {
      const disabled = { schemaVersion: "merge-qualification-policy/v1", enabled: false };
      expect(evaluate(disabled, NOW)).toEqual(evaluate(disabled, DAY_AFTER));
      expect(evaluate(disabled, DAY_AFTER).enabled).toBe(false);
    });

    it("enabled policy stays enabled the day after while inside the expiry window", () => {
      expect(evaluate(enabledPolicy, DAY_AFTER)).toMatchObject({ enabled: true, reasonCode: null });
    });

    it("enabled policy that expires overnight is disabled the day after with policy_expired", () => {
      const expiringTonight = { ...enabledPolicy, expiresAt: "2026-07-21T23:00:00.000Z" };
      expect(evaluate(expiringTonight, NOW)).toMatchObject({ enabled: true });
      expect(evaluate(expiringTonight, DAY_AFTER)).toMatchObject({ enabled: false, reasonCode: "policy_expired" });
    });
  });
});

const DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;

describe("terminal advisory state machine (exactly one of six per enabled candidate)", () => {
  const enabledBase = { policyEnabled: true, planResult: "success" };
  const gatePass = {
    ...enabledBase,
    classifierClass: "isolated",
    gateResult: "success",
    gateImageDigest: DIGEST,
    builtImageDigest: DIGEST,
  };

  it("asserts nothing and requires no record when the policy is disabled", () => {
    const outcome = resolveMergeQualificationOutcome({ policyEnabled: false, policyReasonCode: "policy_disabled" });
    expect(outcome).toMatchObject({
      terminalState: null,
      recordRequired: false,
      assertsAdvisoryCheck: false,
      provisionsAllowed: false,
    });
  });

  it.each([
    ["plan job failed", { policyEnabled: true, planResult: "failure" }, "infrastructure_error", ["plan_failed"]],
    [
      "plan job cancelled (whole-run cancellation reaches planning)",
      { policyEnabled: true, planResult: "cancelled" },
      "cancelled_evicted",
      ["plan_cancelled"],
    ],
    [
      "classifier output missing",
      { ...enabledBase, classifierClass: null },
      "infrastructure_error",
      ["classifier_output_missing"],
    ],
    [
      "unknown classifier class",
      { ...enabledBase, classifierClass: "mystery" },
      "infrastructure_error",
      ["classifier_class_unknown"],
    ],
    [
      "not_applicable with deterministic reason codes",
      { ...enabledBase, classifierClass: "not_applicable", classifierReasonCodes: "docs_or_test_only" },
      "not_applicable",
      ["docs_or_test_only"],
    ],
    [
      "persistent_required without provisioning",
      {
        ...enabledBase,
        classifierClass: "persistent_required",
        classifierReasonCodes: "migration_schema,terraform_infrastructure",
      },
      "persistent_required",
      ["migration_schema", "terraform_infrastructure"],
    ],
    ["isolated gate pass on the exact built digest", gatePass, "passed", ["gate_passed"]],
    [
      "isolated gate failure",
      { ...enabledBase, classifierClass: "isolated", gateResult: "failure" },
      "failed",
      ["gate_failed"],
    ],
    [
      "queue cancellation/eviction reported separately from failure",
      { ...enabledBase, classifierClass: "isolated", gateResult: "cancelled" },
      "cancelled_evicted",
      ["gate_cancelled"],
    ],
    [
      "docker image job cancelled before the gate",
      { ...enabledBase, classifierClass: "isolated", gateResult: "skipped", imageResult: "cancelled" },
      "cancelled_evicted",
      ["image_cancelled"],
    ],
    [
      "missing candidate image is never silent",
      { ...enabledBase, classifierClass: "isolated", gateResult: "skipped", imageAvailable: false },
      "infrastructure_error",
      ["candidate_image_unavailable"],
    ],
    [
      "gate not invoked despite an available image",
      { ...enabledBase, classifierClass: "isolated", gateResult: "skipped", imageAvailable: true },
      "infrastructure_error",
      ["gate_not_invoked"],
    ],
  ])("resolves %s", (_name, input, terminalState, reasonCodes) => {
    const outcome = resolveMergeQualificationOutcome(input);
    expect(outcome.terminalState).toBe(terminalState);
    expect(outcome.reasonCodes).toEqual(reasonCodes);
    expect(outcome.recordRequired).toBe(true);
  });

  describe("end-to-end identity comparison (review probe: retag/digest substitution)", () => {
    it("refuses passed when a successful gate reports no immutable digest", () => {
      const outcome = resolveMergeQualificationOutcome({ ...gatePass, gateImageDigest: "" });
      expect(outcome.terminalState).toBe("infrastructure_error");
      expect(outcome.reasonCodes).toEqual(["gate_digest_missing"]);
    });

    it("refuses passed when a mutable reference stands in for the gate digest", () => {
      const outcome = resolveMergeQualificationOutcome({ ...gatePass, gateImageDigest: "tree-89abcdef" });
      expect(outcome.terminalState).toBe("infrastructure_error");
      expect(outcome.reasonCodes).toEqual(["gate_digest_missing"]);
    });

    it("refuses passed when the gate resolved a different digest than this run built (retag between push and gate)", () => {
      const outcome = resolveMergeQualificationOutcome({ ...gatePass, gateImageDigest: OTHER_DIGEST });
      expect(outcome.terminalState).toBe("infrastructure_error");
      expect(outcome.reasonCodes).toEqual(["image_digest_mismatch"]);
    });

    it("refuses passed when the gate qualified a different candidate SHA or tree", () => {
      const sha = resolveMergeQualificationOutcome({
        ...gatePass,
        candidateSha: "a".repeat(40),
        gateCandidateSha: "b".repeat(40),
      });
      expect(sha.terminalState).toBe("infrastructure_error");
      expect(sha.reasonCodes).toEqual(["candidate_sha_mismatch"]);
      const tree = resolveMergeQualificationOutcome({
        ...gatePass,
        candidateTreeSha: "c".repeat(40),
        gateCandidateTreeSha: "d".repeat(40),
      });
      expect(tree.terminalState).toBe("infrastructure_error");
      expect(tree.reasonCodes).toEqual(["candidate_tree_mismatch"]);
    });

    it("accepts matching identity echoes end to end", () => {
      const outcome = resolveMergeQualificationOutcome({
        ...gatePass,
        candidateSha: "a".repeat(40),
        gateCandidateSha: "A".repeat(40),
        candidateTreeSha: "c".repeat(40),
        gateCandidateTreeSha: "c".repeat(40),
      });
      expect(outcome.terminalState).toBe("passed");
    });
  });

  it("resolves exactly one valid terminal state across the whole input product space", () => {
    const planResults = ["success", "failure", "cancelled", "skipped", ""];
    const classes = [null, "not_applicable", "isolated", "persistent_required", "mystery"];
    const gateResults = ["success", "failure", "cancelled", "skipped", ""];
    const imageResults = ["success", "cancelled", "skipped", ""];
    const imageStates = [true, false];
    const digests = [DIGEST, ""];
    let evaluated = 0;
    for (const planResult of planResults) {
      for (const classifierClass of classes) {
        for (const gateResult of gateResults) {
          for (const imageResult of imageResults) {
            for (const imageAvailable of imageStates) {
              for (const gateImageDigest of digests) {
                const outcome = resolveMergeQualificationOutcome({
                  policyEnabled: true,
                  planResult,
                  classifierClass,
                  gateResult,
                  imageResult,
                  imageAvailable,
                  gateImageDigest,
                  builtImageDigest: gateImageDigest,
                });
                evaluated += 1;
                expect(MERGE_QUALIFICATION_TERMINAL_STATES).toContain(outcome.terminalState);
                expect(outcome.reasonCodes.length).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    }
    // Real discovery over the full matrix, not a hand-picked subset.
    expect(evaluated).toBe(
      planResults.length *
        classes.length *
        gateResults.length *
        imageResults.length *
        imageStates.length *
        digests.length,
    );
  });

  it("never allows provisioning for not_applicable, persistent_required, or infrastructure_error", () => {
    for (const input of [
      { ...enabledBase, classifierClass: "not_applicable" },
      { ...enabledBase, classifierClass: "persistent_required" },
      { ...enabledBase, classifierClass: null },
      { ...enabledBase, classifierClass: "isolated", gateResult: "skipped", imageAvailable: false },
    ]) {
      expect(resolveMergeQualificationOutcome(input).provisionsAllowed).toBe(false);
    }
  });
});

const validEvent = {
  repository: "chase-sets/chase-sets",
  candidateSha: "0123456789abcdef0123456789abcdef01234567",
  candidateTreeSha: "89abcdef0123456789abcdef0123456789abcdef",
  imageDigest: DIGEST,
  classifierClass: "isolated",
  terminalState: "passed",
  reasonCodes: ["gate_passed"],
  provisioned: true,
  startedAt: "2026-07-21T11:00:00.000Z",
  completedAt: "2026-07-21T11:20:00.000Z",
  runId: "12345",
  runAttempt: "1",
  evidenceLinks: ["https://github.com/chase-sets/chase-sets/actions/runs/12345/attempts/1"],
  providerHeadroom: { headroomRuns: 3 },
};

function builtEvent(overrides = {}) {
  return buildMergeQualificationEvent({ ...validEvent, ...overrides }).event;
}

describe("merge-qualification-event/v1 fixtures", () => {
  it("accepts a complete terminal event", () => {
    const { event, errors } = buildMergeQualificationEvent(validEvent);
    expect(errors).toEqual([]);
    expect(event.schemaVersion).toBe(MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION);
  });

  it.each([
    [
      "a provisioned not_applicable record",
      { terminalState: "not_applicable", reasonCodes: ["docs_or_test_only"], provisioned: true },
    ],
    [
      "a provisioned persistent_required record",
      { terminalState: "persistent_required", reasonCodes: ["migration_schema"], provisioned: true },
    ],
    [
      "a provisioned infrastructure_error record",
      { terminalState: "infrastructure_error", reasonCodes: ["gate_not_invoked"], provisioned: true },
    ],
    ["an unknown terminal state", { terminalState: "maybe" }],
    ["empty reason codes", { reasonCodes: [] }],
    ["a mutable image reference instead of a digest", { imageDigest: "tree-89abcdef" }],
    // Review probe: passed + imageDigest:null validated with zero errors.
    ["a passed record without an image digest", { imageDigest: null }],
    ["completedAt before startedAt", { completedAt: "2026-07-21T10:00:00.000Z" }],
    ["a malformed providerHeadroom shape", { providerHeadroom: { headroomRuns: 3, extra: true } }],
    ["a negative providerHeadroom", { providerHeadroom: { headroomRuns: -1 } }],
  ])("rejects %s", (_name, overrides) => {
    const { errors } = buildMergeQualificationEvent({ ...validEvent, ...overrides });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("fails closed on parsed records carrying unknown fields or foreign schema versions", () => {
    const { event } = buildMergeQualificationEvent(validEvent);
    expect(validateMergeQualificationEvent({ ...event, extra: true })).toEqual([
      `unknown field extra is not part of ${MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION}.`,
    ]);
    expect(validateMergeQualificationEvent({ ...event, schemaVersion: "merge-qualification-event/v2" })).toHaveLength(
      1,
    );
  });

  it("accepts digest-less records for states that never touched the image", () => {
    const { errors } = buildMergeQualificationEvent({
      ...validEvent,
      imageDigest: null,
      classifierClass: "not_applicable",
      terminalState: "not_applicable",
      reasonCodes: ["docs_or_test_only"],
      provisioned: false,
    });
    expect(errors).toEqual([]);
  });
});

describe("independent idempotent run terminalization (cancellation/eviction backstop)", () => {
  const enabledBase = { policyEnabled: true, runEvent: "merge_group" };
  const jobs = (overrides = {}) => [
    { name: "Merge Qualification Plan", conclusion: overrides.plan ?? "success" },
    { name: "Docker Image Build", conclusion: overrides.image ?? "success" },
    { name: "Merge Qualification Gate / Merge Gate Preflight", conclusion: overrides.gate ?? "success" },
    { name: "Merge Qualification Gate / Verify Merge Candidate", conclusion: overrides.gate ?? "success" },
    { name: "Merge Qualification (advisory)", conclusion: overrides.publisher ?? "success" },
  ];

  it("skips non-merge-group runs and disabled policies (no records while disabled)", () => {
    expect(resolveRunTerminalization({ policyEnabled: true, runEvent: "pull_request" })).toEqual({
      action: "skip",
      reason: "not_merge_group",
    });
    expect(
      resolveRunTerminalization({ policyEnabled: false, policyReasonCode: "policy_disabled", runEvent: "merge_group" }),
    ).toEqual({ action: "skip", reason: "policy_disabled" });
  });

  it("recognizes a definitively-disabled run from its skipped publisher and asserts nothing", () => {
    const resolution = resolveRunTerminalization({
      ...enabledBase,
      runConclusion: "success",
      jobs: jobs({ publisher: "skipped" }),
      artifactNames: [],
    });
    expect(resolution).toEqual({ action: "skip", reason: "publisher_skipped_disabled" });
  });

  it("is idempotent: a run that already carries a terminal event artifact is never terminalized again", () => {
    const resolution = resolveRunTerminalization({
      ...enabledBase,
      runConclusion: "cancelled",
      jobs: jobs({ publisher: "cancelled" }),
      artifactNames: ["merge-qualification-events-99-1"],
    });
    expect(resolution).toEqual({ action: "skip", reason: "already_terminalized" });
  });

  // Review probe: cancellation before every stage must land cancelled_evicted
  // with a stage-distinct reason, even though the publisher never emitted.
  // The earliest cancelled stage wins; later cancelled jobs are collateral.
  it.each([
    [
      "plan",
      jobs({ plan: "cancelled", image: "cancelled", gate: "skipped", publisher: "cancelled" }),
      "plan_cancelled",
    ],
    ["docker image", jobs({ image: "cancelled", gate: "skipped", publisher: "cancelled" }), "image_cancelled"],
    ["gate", jobs({ gate: "cancelled", publisher: "cancelled" }), "gate_cancelled"],
    ["publisher", jobs({ publisher: "cancelled" }), "publisher_cancelled"],
  ])("terminalizes cancellation at the %s stage", (_stage, cancelledJobs, reason) => {
    const resolution = resolveRunTerminalization({
      ...enabledBase,
      runConclusion: "cancelled",
      jobs: cancelledJobs,
      artifactNames: [],
    });
    expect(resolution.action).toBe("terminalize");
    expect(resolution.terminalState).toBe("cancelled_evicted");
    expect(resolution.reasonCodes).toEqual([reason]);
  });

  it("terminalizes a force-cancelled run with no per-job cancellation evidence", () => {
    const resolution = resolveRunTerminalization({
      ...enabledBase,
      runConclusion: "cancelled",
      jobs: [],
      artifactNames: [],
    });
    expect(resolution).toMatchObject({
      action: "terminalize",
      terminalState: "cancelled_evicted",
      reasonCodes: ["run_force_cancelled"],
      provisioned: false,
    });
  });

  it("marks provisioning possible when the gate had started before cancellation", () => {
    const resolution = resolveRunTerminalization({
      ...enabledBase,
      runConclusion: "cancelled",
      jobs: jobs({ gate: "cancelled", publisher: "cancelled" }),
      artifactNames: [],
    });
    expect(resolution).toMatchObject({ terminalState: "cancelled_evicted", provisioned: true });
  });

  it("terminalizes an enabled completed run with no terminal event as infrastructure_error, never silent", () => {
    const resolution = resolveRunTerminalization({
      ...enabledBase,
      runConclusion: "failure",
      jobs: jobs(),
      artifactNames: ["some-other-artifact"],
    });
    expect(resolution).toMatchObject({
      action: "terminalize",
      terminalState: "infrastructure_error",
      reasonCodes: ["advisory_result_missing"],
      provisioned: false,
    });
  });
});

describe("terminalize CLI determinism (byte-identical events across observer re-runs)", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "merge-qualification-terminalize-"));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  it("rebuilds a byte-identical valid event from run-derived data alone", () => {
    writeFileSync(path.join(workDir, "policy.json"), JSON.stringify(enabledPolicy));
    writeFileSync(
      path.join(workDir, "run.json"),
      JSON.stringify({
        id: 4242,
        run_attempt: 2,
        event: "merge_group",
        conclusion: "cancelled",
        head_sha: "0123456789abcdef0123456789abcdef01234567",
        run_started_at: "2026-07-21T10:00:00Z",
        updated_at: "2026-07-21T10:12:34Z",
      }),
    );
    writeFileSync(
      path.join(workDir, "jobs.json"),
      JSON.stringify({ jobs: [{ name: "Merge Qualification Plan", conclusion: "cancelled" }] }),
    );
    writeFileSync(path.join(workDir, "artifacts.json"), JSON.stringify({ artifacts: [] }));
    const invoke = (outName) =>
      execFileSync(
        process.execPath,
        [
          "scripts/merge-qualification-advisory.mjs",
          "terminalize",
          "--policy",
          path.join(workDir, "policy.json"),
          "--run",
          path.join(workDir, "run.json"),
          "--jobs",
          path.join(workDir, "jobs.json"),
          "--run-artifacts",
          path.join(workDir, "artifacts.json"),
          "--repository",
          "chase-sets/chase-sets",
          "--candidate-tree",
          "89abcdef0123456789abcdef0123456789abcdef",
          "--now",
          "2026-07-21T12:00:00.000Z",
          "--out",
          path.join(workDir, outName),
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
    invoke("event-first.json");
    invoke("event-second.json");
    const first = readFileSync(path.join(workDir, "event-first.json"), "utf8");
    const second = readFileSync(path.join(workDir, "event-second.json"), "utf8");
    expect(first).toBe(second);
    const event = JSON.parse(first);
    expect(validateMergeQualificationEvent(event)).toEqual([]);
    expect(event).toMatchObject({
      terminalState: "cancelled_evicted",
      reasonCodes: ["plan_cancelled"],
      runId: "4242",
      runAttempt: "2",
      imageDigest: null,
    });
    // Duplicate terminalization dedupes instead of double counting.
    const summary = summarizeMergeQualification({ events: [event, JSON.parse(second)] });
    expect(summary.sampleCount).toBe(1);
    expect(summary.evidence).toMatchObject({ duplicateEventCount: 1, conflictCount: 0, complete: true });
  });
});

describe("staging comparison join (tree-keyed, temporally and identity safe)", () => {
  const tree = (n) => `${String(n).repeat(4).padEnd(40, "e")}`.slice(0, 40).replaceAll(/[^0-9a-f]/g, "e");
  const sha = (prefix, n) => `${prefix}${n}`.padEnd(40, "0").slice(0, 40);
  const digestFor = (n) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
  const isolatedEvent = (n, terminalState, overrides = {}) => ({
    candidateSha: sha("aaa", n),
    candidateTreeSha: tree(n),
    imageDigest: digestFor(n),
    classifierClass: "isolated",
    terminalState,
    completedAt: "2026-07-21T10:00:00.000Z",
    ...overrides,
  });
  const release = (n, stagingResult, rootCauseCode = null, overrides = {}) => ({
    mainSha: sha("bbb", n),
    treeSha: tree(n),
    imageDigest: digestFor(n),
    completedAt: `2026-07-21T1${n}:00:00.000Z`,
    staging: { result: stagingResult, rootCauseCode },
    ...overrides,
  });

  it("maps a same-tree/different-commit candidate to the merged main release", () => {
    const [entry] = joinMergeQualificationToStaging({
      events: [isolatedEvent(1, "passed")],
      releases: [release(1, "success")],
    });
    expect(entry).toMatchObject({
      joinStatus: "joined",
      mapping: "same-tree-different-commit",
      mainSha: sha("bbb", 1),
      digestMatched: true,
      caught: false,
      classifierRoutingEvidence: false,
    });
  });

  it("maps a same-commit release (direct main candidate) distinctly", () => {
    const event = isolatedEvent(2, "passed", { candidateSha: sha("bbb", 2) });
    const [entry] = joinMergeQualificationToStaging({ events: [event], releases: [release(2, "success")] });
    expect(entry.mapping).toBe("same-commit");
  });

  it("marks a candidate whose tree never became a main release as superseded", () => {
    const [entry] = joinMergeQualificationToStaging({
      events: [isolatedEvent(3, "passed")],
      releases: [release(4, "success")],
    });
    expect(entry).toMatchObject({ joinStatus: "superseded", mapping: "superseded", mainSha: null, caught: false });
  });

  it("counts a staging application/contract failure after a passed qualification as caught", () => {
    const [entry] = joinMergeQualificationToStaging({
      events: [isolatedEvent(5, "passed")],
      releases: [release(5, "failure", "blocking-staging-verification")],
    });
    expect(entry).toMatchObject({ caught: true, stagingFailureKind: "application", classifierRoutingEvidence: false });
  });

  it("treats terraform/provider-topology staging failures as classifier-routing evidence, not catches", () => {
    for (const code of ["terraform-provider-or-state", "staging-dns", "doks-bootstrap-or-migration"]) {
      const [entry] = joinMergeQualificationToStaging({
        events: [isolatedEvent(6, "passed")],
        releases: [release(6, "failure", code)],
      });
      expect(entry).toMatchObject({
        caught: false,
        classifierRoutingEvidence: true,
        stagingFailureKind: "classifier-routing",
      });
    }
  });

  it("fails closed: an unknown staging root cause surfaces as a catch for the soak review", () => {
    const [entry] = joinMergeQualificationToStaging({
      events: [isolatedEvent(7, "passed")],
      releases: [release(7, "failure", "never-seen-before-code")],
    });
    expect(entry.caught).toBe(true);
  });

  it("only compares eligible isolated outcomes (passed/failed), never records or disabled notes", () => {
    const comparisons = joinMergeQualificationToStaging({
      events: [
        isolatedEvent(8, "not_applicable", { classifierClass: "not_applicable" }),
        isolatedEvent(8, "cancelled_evicted"),
        isolatedEvent(8, "infrastructure_error"),
        isolatedEvent(8, "failed"),
      ],
      releases: [release(8, "success")],
    });
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].terminalState).toBe("failed");
  });

  // Review probe: an event completed July 21 with identical-tree releases on
  // July 20 and July 21 joined to the July 20 failure and falsely reported a
  // staging catch. The join must never look backward in time.
  it("never joins a release that completed before the qualification (revert-reland probe)", () => {
    const event = isolatedEvent(5, "passed", { completedAt: "2026-07-21T12:00:00.000Z" });
    const older = release(5, "failure", "blocking-staging-verification", {
      mainSha: sha("bb0", 5),
      completedAt: "2026-07-20T12:00:00.000Z",
    });
    const newer = release(5, "success", null, { completedAt: "2026-07-21T13:00:00.000Z" });
    const [entry] = joinMergeQualificationToStaging({ events: [event], releases: [older, newer] });
    expect(entry).toMatchObject({
      joinStatus: "joined",
      mainSha: newer.mainSha,
      releaseCompletedAt: "2026-07-21T13:00:00.000Z",
      caught: false,
    });
  });

  it("surfaces a candidate whose only same-tree releases predate qualification as an explicit orphan", () => {
    const event = isolatedEvent(5, "passed", { completedAt: "2026-07-21T12:00:00.000Z" });
    const older = release(5, "failure", "blocking-staging-verification", {
      completedAt: "2026-07-20T12:00:00.000Z",
    });
    const [entry] = joinMergeQualificationToStaging({ events: [event], releases: [older] });
    expect(entry).toMatchObject({
      joinStatus: "no_subsequent_release",
      mainSha: null,
      caught: false,
      classifierRoutingEvidence: false,
    });
  });

  it("turns a digest disagreement into an explicit identity_mismatch orphan, never a catch", () => {
    const event = isolatedEvent(9, "passed");
    const mismatched = release(9, "failure", "blocking-staging-verification", {
      imageDigest: `sha256:${"f".repeat(64)}`,
    });
    const [entry] = joinMergeQualificationToStaging({ events: [event], releases: [mismatched] });
    expect(entry).toMatchObject({
      joinStatus: "identity_mismatch",
      digestMatched: false,
      mainSha: null,
      caught: false,
      classifierRoutingEvidence: false,
    });
  });

  it("joins across a digest-less release with digestMatched null (identity unproven, not mismatched)", () => {
    const [entry] = joinMergeQualificationToStaging({
      events: [isolatedEvent(1, "passed")],
      releases: [release(1, "success", null, { imageDigest: null })],
    });
    expect(entry).toMatchObject({ joinStatus: "joined", digestMatched: null });
  });

  it("selects deterministically among multiple qualifying releases regardless of input order", () => {
    const event = isolatedEvent(3, "passed", { completedAt: "2026-07-21T10:00:00.000Z" });
    const digestless = release(3, "success", null, {
      mainSha: sha("bb1", 3),
      imageDigest: null,
      completedAt: "2026-07-21T11:00:00.000Z",
    });
    const exactLater = release(3, "success", null, {
      mainSha: sha("bb2", 3),
      completedAt: "2026-07-21T12:00:00.000Z",
    });
    const forward = joinMergeQualificationToStaging({ events: [event], releases: [digestless, exactLater] });
    const reversed = joinMergeQualificationToStaging({ events: [event], releases: [exactLater, digestless] });
    // Exact digest agreement outranks an earlier digest-less release, and the
    // choice is stable under permutation.
    expect(forward[0].mainSha).toBe(exactLater.mainSha);
    expect(reversed[0].mainSha).toBe(exactLater.mainSha);
    const twoDigestless = [
      release(3, "success", null, {
        mainSha: sha("bb4", 3),
        imageDigest: null,
        completedAt: "2026-07-21T12:00:00.000Z",
      }),
      release(3, "success", null, {
        mainSha: sha("bb3", 3),
        imageDigest: null,
        completedAt: "2026-07-21T11:00:00.000Z",
      }),
    ];
    const eventNoDigest = isolatedEvent(3, "passed", { imageDigest: null });
    expect(joinMergeQualificationToStaging({ events: [eventNoDigest], releases: twoDigestless })[0].mainSha).toBe(
      sha("bb3", 3),
    );
  });

  it("excludes releases without a full identity instead of joining on partial data", () => {
    const [entry] = joinMergeQualificationToStaging({
      events: [isolatedEvent(1, "passed")],
      releases: [release(1, "success", null, { mainSha: "not-a-sha" })],
    });
    expect(entry.joinStatus).toBe("superseded");
  });
});

describe("evidence dedupe and authoritative-attempt selection", () => {
  const candidate = validEvent.candidateSha;

  it("collapses byte-identical duplicates of one attempt", () => {
    const event = builtEvent({});
    const dedupe = dedupeMergeQualificationEvents([event, structuredClone(event)]);
    expect(dedupe.authoritative).toHaveLength(1);
    expect(dedupe.duplicateEventCount).toBe(1);
    expect(dedupe.conflictedCandidates).toEqual([]);
  });

  // Review probe: passed attempt 1 plus failed attempt 2 produced
  // sampleCount 2, success 1, application failure 1. The latest attempt must
  // be authoritative and the superseded attempt must leave the denominators.
  it("selects the latest attempt as authoritative across retries", () => {
    const passedFirst = builtEvent({ runAttempt: "1" });
    const failedSecond = builtEvent({
      terminalState: "failed",
      reasonCodes: ["gate_failed"],
      runAttempt: "2",
    });
    const summary = summarizeMergeQualification({
      events: [passedFirst, failedSecond],
      comparisons: [],
      candidates: [candidate],
    });
    expect(summary.sampleCount).toBe(1);
    expect(summary.counts).toMatchObject({ success: 0, applicationFailure: 1 });
    expect(summary.orphanCount).toBe(0);
    expect(summary.evidence).toMatchObject({ supersededAttemptCount: 1, conflictCount: 0, complete: true });
  });

  it("treats a requeued candidate (higher run id) as superseding the earlier run", () => {
    const earlierRun = builtEvent({ runId: "100", terminalState: "failed", reasonCodes: ["gate_failed"] });
    const laterRun = builtEvent({ runId: "200" });
    const dedupe = dedupeMergeQualificationEvents([laterRun, earlierRun]);
    expect(dedupe.authoritative).toEqual([laterRun]);
    expect(dedupe.supersededAttemptCount).toBe(1);
  });

  it("exposes same-attempt contradictions as conflicts and removes the candidate from every denominator", () => {
    const passed = builtEvent({});
    const contradiction = builtEvent({ terminalState: "failed", reasonCodes: ["gate_failed"] });
    const summary = summarizeMergeQualification({
      events: [passed, contradiction],
      comparisons: [],
      candidates: [candidate],
    });
    expect(summary.sampleCount).toBe(0);
    expect(summary.counts).toMatchObject({ success: 0, applicationFailure: 0 });
    // A conflicted candidate is exposed as a conflict, not hidden as an orphan.
    expect(summary.orphanCount).toBe(0);
    expect(summary.evidence).toMatchObject({
      conflictCount: 1,
      conflictingCandidates: [candidate],
      complete: false,
    });
  });

  it("keeps malformed events (unknown reasons, bad digests) out of the denominators and degrades completeness", () => {
    const malformed = [
      builtEvent({ terminalState: "in-progress" }),
      builtEvent({ imageDigest: "tree-89abcdef" }),
      { schemaVersion: "merge-qualification-event/v2" },
    ];
    const summary = summarizeMergeQualification({ events: malformed, comparisons: [], candidates: [candidate] });
    expect(summary.sampleCount).toBe(0);
    expect(summary.evidence).toMatchObject({ invalidEventCount: 3, complete: false });
    // The candidate never reached a valid terminal state: still an orphan.
    expect(summary.orphanCount).toBe(1);
  });

  it("rejects comparisons that are not join outputs", () => {
    const summary = summarizeMergeQualification({
      events: [],
      comparisons: [{ mapping: "same-tree-different-commit", caught: true }],
      candidates: null,
    });
    expect(summary.stagingCatchCount).toBe(0);
    expect(summary.evidence).toMatchObject({ invalidComparisonCount: 1, complete: false });
  });
});

describe("delivery-health summarizer over the synthetic 20-candidate fixture set", () => {
  const shas = Array.from({ length: 20 }, (_, index) => String(index).padStart(2, "0").repeat(20));
  const minutes = (n) => n * 60;
  const digestFor = (index) => `sha256:${String(index % 10).repeat(64)}`;
  const event = (index, terminalState, durationMinutes, headroomRuns) =>
    builtEvent({
      candidateSha: shas[index],
      candidateTreeSha: shas[index],
      imageDigest: ["passed", "failed"].includes(terminalState) ? digestFor(index) : null,
      classifierClass: ["not_applicable", "persistent_required"].includes(terminalState) ? terminalState : "isolated",
      terminalState,
      reasonCodes: ["fixture_reason"],
      provisioned: ["passed", "failed", "cancelled_evicted"].includes(terminalState),
      startedAt: "2026-07-21T10:00:00.000Z",
      completedAt: new Date(Date.parse("2026-07-21T10:00:00.000Z") + minutes(durationMinutes) * 1000).toISOString(),
      runId: String(9000 + index),
      runAttempt: "1",
      providerHeadroom: Number.isFinite(headroomRuns) ? { headroomRuns } : null,
    });

  // 18 events over 20 candidates: 2 candidates never reached a terminal
  // state (run-level eviction before publisher AND terminalizer evidence)
  // and count as orphans.
  const events = [
    event(0, "passed", 18, 5),
    event(1, "passed", 20, 5),
    event(2, "passed", 22, 4),
    event(3, "passed", 24, 4),
    event(4, "passed", 26, 4),
    event(5, "passed", 28, 3),
    event(6, "passed", 30, 3),
    event(7, "passed", 32, 3),
    event(8, "passed", 34, 2),
    event(9, "passed", 60, 2),
    event(10, "failed", 25, 2),
    event(11, "failed", 35, 2),
    event(12, "cancelled_evicted", 5, 3),
    event(13, "infrastructure_error", 2, null),
    event(14, "not_applicable", 1, null),
    event(15, "not_applicable", 1, null),
    event(16, "persistent_required", 1, null),
    event(17, "persistent_required", 1, null),
  ];
  const comparison = (joinStatus, overrides = {}) => ({
    schemaVersion: MERGE_QUALIFICATION_COMPARISON_SCHEMA_VERSION,
    joinStatus,
    caught: false,
    classifierRoutingEvidence: false,
    ...overrides,
  });
  const comparisons = [
    comparison("joined", { caught: true }),
    comparison("joined", { classifierRoutingEvidence: true }),
    comparison("superseded"),
    comparison("identity_mismatch"),
    comparison("no_subsequent_release"),
  ];

  it("reports terminal counts, p50/p90/p95 durations, catches, orphans, and provider headroom", () => {
    const summary = summarizeMergeQualification({ events, comparisons, candidates: shas });
    expect(events.every((entry) => validateMergeQualificationEvent(entry).length === 0)).toBe(true);
    expect(summary.sampleCount).toBe(18);
    expect(summary.candidateCount).toBe(20);
    expect(summary.counts).toEqual({
      success: 10,
      applicationFailure: 2,
      cancellation: 1,
      infrastructure: 1,
      notApplicable: 2,
      persistentRequired: 2,
    });
    // Durations cover the 12 passed/failed qualifications; nearest-rank
    // percentiles over sorted minutes [18,20,22,24,25,26,28,30,32,34,35,60].
    expect(summary.durationSeconds).toEqual({
      sampleCount: 12,
      p50: minutes(26),
      p90: minutes(35),
      p95: minutes(60),
    });
    expect(summary.stagingCatchCount).toBe(1);
    expect(summary.classifierRoutingCount).toBe(1);
    expect(summary.supersededCount).toBe(1);
    expect(summary.identityMismatchCount).toBe(1);
    expect(summary.temporalOrphanCount).toBe(1);
    expect(summary.orphanCount).toBe(2);
    // The latest sample by completedAt is the 60-minute run (index 9).
    expect(summary.providerHeadroom).toEqual({ sampleCount: 13, minHeadroomRuns: 2, latestHeadroomRuns: 2 });
    expect(summary.evidence).toMatchObject({ eventCount: 18, invalidEventCount: 0, conflictCount: 0, complete: true });
  });

  it("keeps an event without a valid terminal state out of the denominators and visible as evidence", () => {
    const summary = summarizeMergeQualification({
      events: [...events, { ...events[0], candidateSha: shas[18], terminalState: "in-progress" }],
      comparisons: [],
      candidates: shas,
    });
    expect(summary.sampleCount).toBe(18);
    // Candidate 18's only evidence is invalid (still unresolved → orphan),
    // candidate 19 has none.
    expect(summary.orphanCount).toBe(2);
    expect(summary.evidence).toMatchObject({ invalidEventCount: 1, complete: false });
  });

  it("reports a zero steady state while the policy is disabled", () => {
    expect(summarizeMergeQualification({})).toMatchObject({
      sampleCount: 0,
      counts: { success: 0, applicationFailure: 0, cancellation: 0, infrastructure: 0 },
      durationSeconds: { sampleCount: 0, p50: null, p90: null, p95: null },
      stagingCatchCount: 0,
      orphanCount: 0,
      providerHeadroom: { sampleCount: 0, minHeadroomRuns: null, latestHeadroomRuns: null },
      evidence: { eventCount: 0, invalidEventCount: 0, conflictCount: 0, complete: true },
    });
  });
});

describe("policy CLI (workflow entry point)", () => {
  it("reports the shipped policy as disabled with the policy_disabled reason and exit code 0", () => {
    const stdout = execFileSync(
      process.execPath,
      ["scripts/merge-qualification-advisory.mjs", "policy", "--policy", MERGE_QUALIFICATION_POLICY_PATH],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(JSON.parse(stdout)).toMatchObject({ enabled: false, reasonCode: "policy_disabled" });
  });

  it("fails closed to disabled when pointed at a missing policy path", () => {
    const stdout = execFileSync(
      process.execPath,
      ["scripts/merge-qualification-advisory.mjs", "policy", "--policy", "scripts/does-not-exist-policy.json"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(JSON.parse(stdout)).toMatchObject({ enabled: false, reasonCode: "policy_absent" });
  });
});

describe("classifier registration for the enablement policy", () => {
  const DUMMY = { sha: "1".repeat(40), treeSha: "2".repeat(40) };

  it("classifies a policy change persistent_required via the registered release-machinery surface", () => {
    const record = classifyReleaseQualificationScope({
      base: DUMMY,
      candidate: { sha: "3".repeat(40), treeSha: "4".repeat(40) },
      changedFiles: [{ path: MERGE_QUALIFICATION_POLICY_PATH, status: "modified" }],
      readFileAt: () => readFileSync(path.join(repoRoot, MERGE_QUALIFICATION_POLICY_PATH), "utf8"),
      releaseWorkflowScriptReferences: new Set(),
    });
    expect(record.class).toBe("persistent_required");
    expect(record.reasonCodes).toContain("deployment_release_workflow");
    expect(releaseQualificationScopeRegistry.operationalScriptPaths).toContain(MERGE_QUALIFICATION_POLICY_PATH);
  });
});
