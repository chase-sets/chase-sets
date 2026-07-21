import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION,
  MERGE_QUALIFICATION_POLICY_PATH,
  MERGE_QUALIFICATION_TERMINAL_STATES,
  buildMergeQualificationEvent,
  evaluateMergeQualificationPolicy,
  joinMergeQualificationToStaging,
  resolveMergeQualificationOutcome,
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
    ["missing owner", { ...enabledPolicy, owner: "  " }, "policy_malformed"],
    ["missing ceiling", { ...enabledPolicy, ceiling: null }, "policy_malformed"],
    [
      "non-positive ceiling",
      { ...enabledPolicy, ceiling: { dollarCeilingUsd: 0, maxQualificationsPerDay: 20 } },
      "policy_malformed",
    ],
    ["missing enabledAt", { ...enabledPolicy, enabledAt: null }, "policy_malformed"],
    ["future enabledAt", { ...enabledPolicy, enabledAt: "2026-07-22T00:00:00.000Z" }, "policy_malformed"],
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

describe("terminal advisory state machine (exactly one of six per enabled candidate)", () => {
  const enabledBase = { policyEnabled: true, planResult: "success" };

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
    [
      "isolated gate pass",
      { ...enabledBase, classifierClass: "isolated", gateResult: "success" },
      "passed",
      ["gate_passed"],
    ],
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

  it("resolves exactly one valid terminal state across the whole input product space", () => {
    const planResults = ["success", "failure", "cancelled", "skipped", ""];
    const classes = [null, "not_applicable", "isolated", "persistent_required", "mystery"];
    const gateResults = ["success", "failure", "cancelled", "skipped", ""];
    const imageStates = [true, false];
    let evaluated = 0;
    for (const planResult of planResults) {
      for (const classifierClass of classes) {
        for (const gateResult of gateResults) {
          for (const imageAvailable of imageStates) {
            const outcome = resolveMergeQualificationOutcome({
              policyEnabled: true,
              planResult,
              classifierClass,
              gateResult,
              imageAvailable,
            });
            evaluated += 1;
            expect(MERGE_QUALIFICATION_TERMINAL_STATES).toContain(outcome.terminalState);
            expect(outcome.reasonCodes.length).toBeGreaterThan(0);
          }
        }
      }
    }
    // Real discovery over the full matrix, not a hand-picked subset.
    expect(evaluated).toBe(planResults.length * classes.length * gateResults.length * imageStates.length);
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
  imageDigest: `sha256:${"1".repeat(64)}`,
  classifierClass: "isolated",
  terminalState: "passed",
  reasonCodes: ["gate_passed"],
  provisioned: true,
  startedAt: "2026-07-21T11:00:00.000Z",
  completedAt: "2026-07-21T11:20:00.000Z",
  runId: "12345",
  runAttempt: "1",
  evidenceLinks: ["https://github.com/chase-sets/chase-sets/actions/runs/12345/attempts/1"],
};

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
    ["completedAt before startedAt", { completedAt: "2026-07-21T10:00:00.000Z" }],
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

describe("staging comparison join (tree-keyed, never branch names)", () => {
  const tree = (n) => `${String(n).repeat(4).padEnd(40, "e")}`.slice(0, 40).replaceAll(/[^0-9a-f]/g, "e");
  const sha = (prefix, n) => `${prefix}${n}`.padEnd(40, "0").slice(0, 40);
  const isolatedEvent = (n, terminalState, overrides = {}) => ({
    candidateSha: sha("aaa", n),
    candidateTreeSha: tree(n),
    imageDigest: `sha256:${String(n).repeat(64).slice(0, 64)}`,
    classifierClass: "isolated",
    terminalState,
    ...overrides,
  });
  const release = (n, stagingResult, rootCauseCode = null, overrides = {}) => ({
    mainSha: sha("bbb", n),
    treeSha: tree(n),
    imageDigest: `sha256:${String(n).repeat(64).slice(0, 64)}`,
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
    expect(entry).toMatchObject({ mapping: "superseded", mainSha: null, caught: false });
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

  it("flags a digest mismatch on a joined same-tree release instead of dropping the join", () => {
    const [entry] = joinMergeQualificationToStaging({
      events: [isolatedEvent(9, "passed")],
      releases: [release(9, "success", null, { imageDigest: `sha256:${"f".repeat(64)}` })],
    });
    expect(entry).toMatchObject({ mapping: "same-tree-different-commit", digestMatched: false });
  });
});

describe("delivery-health summarizer over the synthetic 20-candidate fixture set", () => {
  const shas = Array.from({ length: 20 }, (_, index) => String(index).padStart(2, "0").repeat(20));
  const minutes = (n) => n * 60;
  const event = (index, terminalState, durationMinutes, headroomRuns) => ({
    candidateSha: shas[index],
    candidateTreeSha: shas[index],
    classifierClass: ["not_applicable", "persistent_required"].includes(terminalState) ? terminalState : "isolated",
    terminalState,
    startedAt: "2026-07-21T10:00:00.000Z",
    completedAt: new Date(Date.parse("2026-07-21T10:00:00.000Z") + minutes(durationMinutes) * 1000).toISOString(),
    providerHeadroom: Number.isFinite(headroomRuns) ? { headroomRuns } : null,
  });

  // 18 events over 20 candidates: 2 candidates never reached a terminal
  // state (run-level eviction before the publisher) and count as orphans.
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
  const comparisons = [
    { mapping: "same-tree-different-commit", caught: true, classifierRoutingEvidence: false },
    { mapping: "same-tree-different-commit", caught: false, classifierRoutingEvidence: true },
    { mapping: "superseded", caught: false, classifierRoutingEvidence: false },
  ];

  it("reports terminal counts, p50/p90/p95 durations, catches, orphans, and provider headroom", () => {
    const summary = summarizeMergeQualification({ events, comparisons, candidates: shas });
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
    expect(summary.orphanCount).toBe(2);
    // The latest sample by completedAt is the 60-minute run (index 9).
    expect(summary.providerHeadroom).toEqual({ sampleCount: 13, minHeadroomRuns: 2, latestHeadroomRuns: 2 });
  });

  it("counts an event without a valid terminal state as an orphan, never silently", () => {
    const summary = summarizeMergeQualification({
      events: [...events, { candidateSha: shas[18], terminalState: "in-progress" }],
      comparisons: [],
      candidates: shas,
    });
    // Candidate 18 now has an (invalid) event, candidate 19 still has none.
    expect(summary.orphanCount).toBe(2);
  });

  it("reports a zero steady state while the policy is disabled", () => {
    expect(summarizeMergeQualification({})).toMatchObject({
      sampleCount: 0,
      counts: { success: 0, applicationFailure: 0, cancellation: 0, infrastructure: 0 },
      durationSeconds: { sampleCount: 0, p50: null, p90: null, p95: null },
      stagingCatchCount: 0,
      orphanCount: 0,
      providerHeadroom: { sampleCount: 0, minHeadroomRuns: null, latestHeadroomRuns: null },
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
