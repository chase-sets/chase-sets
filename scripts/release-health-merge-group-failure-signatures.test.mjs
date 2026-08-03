import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_FAILURE_SIGNATURE_VERSION,
  advanceCircuitRecovery,
  buildDeliveryFailureSignature,
  collectMergeGroupFailureSignatures,
  evaluateCircuitGuardDecision,
  extractFailureSignatures,
  mergeCircuitRecord,
  normalizeFailureFingerprint,
  parseCircuitMarker,
  parseMergeGroupFailureSignaturesArgs,
  renderCircuitMarker,
  thresholdForObservations,
} from "./release-health-merge-group-failure-signatures.mjs";

const FIXTURE_ROOT = new URL("./fixtures/release-health-merge-group-failure-signatures/", import.meta.url);
const FAILED_STEP_CONTEXT = Object.freeze({
  failedStepStartedAt: "2026-07-17T12:00:00Z",
  failedStepCompletedAt: "2026-07-17T12:00:00Z",
});

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8"));
}

function completeFailedStepLog(output) {
  const outputLines = String(output)
    .split(/\r?\n/)
    .map((line, index) => `2026-07-17T12:00:00.${String(200 + index).padStart(3, "0")}0000Z ${line}`);
  return [
    "2026-07-17T11:59:59.9000000Z ##[group]Run prepare environment",
    "2026-07-17T11:59:59.9100000Z   TF_VAR_ucp_ap2_verifier_timeout_ms: 5000",
    "2026-07-17T11:59:59.9200000Z ##[endgroup]",
    "2026-07-17T12:00:00.1000000Z ##[group]Run pnpm test",
    "2026-07-17T12:00:00.1100000Z \u001b[36;1mpnpm test\u001b[0m",
    "2026-07-17T12:00:00.1200000Z   TF_VAR_ucp_ap2_verifier_timeout_ms: 5000",
    "2026-07-17T12:00:00.1300000Z ##[endgroup]",
    ...outputLines,
    "2026-07-17T12:00:00.9000000Z ##[error]Process completed with exit code 1.",
    "2026-07-17T12:00:01.1000000Z ##[group]Run post-failure diagnostics",
  ].join("\n");
}

function predecessorSemanticFailureLine(log) {
  return (
    String(log ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /(?:error|fail|timeout|refused|missing|invalid|collision|mismatch)/i.test(line)) ??
    "unknown failure"
  );
}

function occurrence(overrides = {}) {
  return {
    runId: 100,
    runAttempt: 1,
    observedAt: "2026-07-17T12:00:00.000Z",
    url: "https://github.com/chase-sets/chase-sets/actions/runs/100",
    baseSha: "a".repeat(40),
    candidateSha: "b".repeat(40),
    jobId: 200,
    ...overrides,
  };
}

function signature(overrides = {}) {
  return buildDeliveryFailureSignature({
    lane: "merge-group",
    workflow: "Platform PR",
    job: "Unit Tests",
    step: "Run unit tests",
    testFile: "bounded-contexts/catalog/unit.test.ts",
    testTitle: "projects a listing",
    errorText: "AssertionError: expected 2 to equal 3",
    ...overrides,
  });
}

function circuit(overrides = {}) {
  return {
    ...mergeCircuitRecord(null, signature(), [occurrence()], "2026-07-17T12:00:00.000Z"),
    state: "holding",
    canonicalIssueNumber: 5500,
    ...overrides,
  };
}

describe("delivery failure fingerprint normalization", () => {
  it("keeps semantic identity stable while removing dynamic values", async () => {
    const cases = await readFixture("normalization-cases.json");
    for (const fixture of cases.equivalent) {
      expect(normalizeFailureFingerprint(fixture.left)).toBe(normalizeFailureFingerprint(fixture.right));
    }
  });

  it("redacts credentials, tokens, cookies, temporary paths, and namespace ids", async () => {
    const cases = await readFixture("normalization-cases.json");
    const normalized = normalizeFailureFingerprint(cases.redaction.input);
    for (const secret of cases.redaction.mustNotContain) expect(normalized).not.toContain(secret.toLowerCase());
    expect(normalized).toContain("[redacted");
  });

  it("does not collapse different tests or deployment root-cause codes", () => {
    const baseline = signature();
    expect(signature({ testTitle: "projects a different listing" }).signature).not.toBe(baseline.signature);
    expect(
      signature({
        testFile: null,
        testTitle: null,
        rootCauseCode: "staging-dns",
        errorText: "DomainZoneInvalid",
      }).signature,
    ).not.toBe(
      signature({
        testFile: null,
        testTitle: null,
        rootCauseCode: "terraform-provider-or-state",
        errorText: "DomainZoneInvalid",
      }).signature,
    );
  });

  it("includes the normalized provider root cause in signature identity", () => {
    const shared = {
      testFile: null,
      testTitle: null,
      rootCauseCode: "unknown",
      errorText: "Error: provider request failed",
    };
    const quota = signature({
      ...shared,
      providerReason: "  Provider quota   EXHAUSTED ",
      rootCauseSignature: "quota-signature",
    });
    const normalizedQuota = signature({
      ...shared,
      providerReason: "provider quota exhausted",
      rootCauseSignature: "QUOTA-SIGNATURE",
    });
    const permission = signature({
      ...shared,
      providerReason: "Provider permission denied",
      rootCauseSignature: "permission-signature",
    });

    expect(normalizedQuota.signature).toBe(quota.signature);
    expect(permission.signature).not.toBe(quota.signature);
  });

  it("records the predecessor collapse onto the timeout environment assignment", async () => {
    const fixture = await readFixture("production-failed-step-errors.json");
    const predecessorShapes = fixture.cases.map((entry) =>
      normalizeFailureFingerprint(predecessorSemanticFailureLine(entry.log.join("\n"))),
    );

    expect(new Set(predecessorShapes)).toEqual(new Set(["<timestamp> tf_var_ucp_ap2_verifier_timeout_ms: 5000"]));
  });

  it("binds production fingerprints to three distinct terminal failed-step errors", async () => {
    const fixture = await readFixture("production-failed-step-errors.json");
    const failures = fixture.cases.map((entry) => {
      const [failure] = extractFailureSignatures(entry.log.join("\n"), entry.context);
      expect(failure.errorShape).toBe(entry.expectedErrorShape);
      expect(failure.errorFingerprint).toBe(entry.expectedErrorFingerprint);
      expect(failure.signature).toBe(entry.expectedSignature);
      expect(failure.errorShape).not.toContain("tf_var_ucp_ap2_verifier_timeout_ms");
      return failure;
    });

    expect(new Set(failures.map((failure) => failure.errorShape)).size).toBe(3);
    expect(new Set(failures.map((failure) => failure.errorFingerprint)).size).toBe(3);
  });

  it("reconciles keyword-free failed-step retries across mutable run and revision digits", () => {
    const messages = [
      "PRODUCTION_RESTORE_POINT_QUOTA_EXCEEDED: snapshot quota of 4 exhausted for droplet pool. run_id=111 revision 12",
      "PRODUCTION_RESTORE_POINT_QUOTA_EXCEEDED: snapshot quota of 4 exhausted for droplet pool. run_id=999 revision 87",
    ];
    const failures = messages.map((message) => {
      const [failure] = extractFailureSignatures(completeFailedStepLog(message), {
        lane: "production",
        workflow: "Platform Deploy",
        jobName: "Deploy Production",
        stepName: "Create production database restore point",
        ...FAILED_STEP_CONTEXT,
      });
      return failure;
    });
    const expectedErrorShape = normalizeFailureFingerprint(messages[0]);

    expect(normalizeFailureFingerprint(messages[1])).toBe(expectedErrorShape);
    expect(expectedErrorShape).toContain(
      "production_restore_point_quota_exceeded: snapshot quota of 4 exhausted for droplet pool.",
    );
    expect(expectedErrorShape).not.toMatch(/\b(?:111|999|12|87)\b/);
    expect(failures.map((failure) => failure.errorShape)).toEqual([expectedErrorShape, expectedErrorShape]);
    expect(failures[0].errorShape).not.toBe("unknown failure");
    expect(failures[0].rootCauseSignature).toBe(failures[1].rootCauseSignature);
    expect(failures[0].signature).toBe(failures[1].signature);
  });

  it("keeps one release-health root-cause fingerprint across volatile node-readiness renditions", () => {
    const messages = [
      "Warning FailedScheduling 50m (x8 over 39m) default-scheduler 0/5 nodes are available: 4 node(s) had untolerated taint(s). readiness.k8s.io/DOKSCriticalComponentsReady=pending:NoSchedule run_id=30202917958 pod marketplace-api-6ff7f59b68-bn8vx",
      "Warning FailedScheduling 4m19s (x2 over 3m) default-scheduler 0/2 nodes are available: 2 node(s) had untolerated taint(s). readiness.k8s.io/DOKSCriticalComponentsReady=pending:NoSchedule run_id=30525227116 pod marketplace-api-7cc8d6f579-q2k7m",
    ];
    const failures = messages.map(
      (message) =>
        extractFailureSignatures(completeFailedStepLog(message), {
          lane: "staging",
          workflow: "Platform Deploy",
          jobName: "Deploy Staging",
          stepName: "Deploy staging Kubernetes release",
          ...FAILED_STEP_CONTEXT,
        })[0],
    );

    expect(failures.every(({ rootCauseSignature }) => rootCauseSignature !== null)).toBe(true);
    expect(new Set(failures.map(({ rootCauseSignature }) => rootCauseSignature)).size).toBe(1);
    expect(new Set(failures.map(({ rootCauseFingerprint }) => rootCauseFingerprint)).size).toBe(1);
  });

  it("ignores workflow-command and ANSI tails after a keyword-free semantic line", () => {
    const message = "PRODUCTION_RESTORE_POINT_QUOTA_EXCEEDED: snapshot capacity is exhausted";
    const [failure] = extractFailureSignatures(
      completeFailedStepLog(`${message}\n::notice::runner annotation\n\u001b[33;1mrunner command echo\u001b[0m`),
      {
        lane: "production",
        workflow: "Platform Deploy",
        jobName: "Deploy Production",
        stepName: "Create production database restore point",
        ...FAILED_STEP_CONTEXT,
      },
    );

    expect(failure.errorShape).toBe(normalizeFailureFingerprint(message));
  });

  it.each([
    ["missing failed-step timestamps", {}, completeFailedStepLog("Error: actual failure")],
    [
      "truncated runner error boundary",
      FAILED_STEP_CONTEXT,
      completeFailedStepLog("Error: actual failure").replace(
        "2026-07-17T12:00:00.9000000Z ##[error]Process completed with exit code 1.",
        "",
      ),
    ],
    [
      "ambiguous duplicate failed-step boundaries",
      FAILED_STEP_CONTEXT,
      `${completeFailedStepLog("Error: first failure")}\n${completeFailedStepLog("Error: second failure")}`,
    ],
  ])("fails closed when the %s prevents complete segment identification", (_name, boundary, log) => {
    const [failure] = extractFailureSignatures(log, {
      lane: "production",
      workflow: "Platform Deploy",
      jobName: "Deploy Production",
      stepName: "Run production operation",
      ...boundary,
    });

    expect(failure).toMatchObject({
      rootCauseCode: "unknown",
      errorShape: "unknown failure",
    });
  });

  it.each([
    [
      "Playwright",
      "1) [chromium] › playwright/tests/checkout.spec.ts:42:7 › checkout completes",
      "checkout completes",
      null,
    ],
    ["unit", "bounded-contexts/catalog/unit.test.ts > projects a listing", "projects a listing", null],
    ["typecheck", "TypeError: Type 'string' is not assignable to type 'number'", null, "unknown"],
    ["staging DNS", "DomainZoneInvalid: staging domain already exists", null, "staging-dns"],
    ["bootstrap", "Schema bootstrap command timed out after 600000 ms", null, "doks-bootstrap-or-migration"],
    [
      "image missing",
      "promoted image does not exist: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      null,
      "unknown",
    ],
    ["unknown", "ProviderFailure: unexpected opaque response", null, "unknown"],
  ])("creates a bounded %s signature", (_name, log, expectedTitle, expectedRootCause) => {
    const [failure] = extractFailureSignatures(completeFailedStepLog(log), {
      lane: "merge-group",
      workflow: "Platform PR",
      jobName: "Full Battery",
      stepName: "Run checks",
      jobId: 42,
      ...FAILED_STEP_CONTEXT,
    });
    expect(failure.schemaVersion).toBe(DELIVERY_FAILURE_SIGNATURE_VERSION);
    expect(failure.signature).toHaveLength(24);
    expect(failure.testTitle).toBe(expectedTitle);
    expect(failure.rootCauseCode).toBe(expectedRootCause);
    expect(failure.blocking).toBe(true);
  });

  it("keeps timeout semantics when the timeout is the failed-step terminal error", () => {
    const [failure] = extractFailureSignatures(
      completeFailedStepLog("Schema bootstrap command timed out after 600000 ms"),
      {
        lane: "production",
        workflow: "Platform Deploy",
        jobName: "Deploy Production",
        stepName: "Run schema bootstrap",
        ...FAILED_STEP_CONTEXT,
      },
    );

    expect(failure).toMatchObject({
      rootCauseCode: "doks-bootstrap-or-migration",
      errorShape: "schema bootstrap command timed out after <number> ms",
    });
  });
});

describe("delivery circuit state", () => {
  it("holds after two distinct candidates within 30 minutes", () => {
    const entries = [
      occurrence({ runId: 1, candidateSha: "1".repeat(40), observedAt: "2026-07-17T12:00:00.000Z" }),
      occurrence({ runId: 2, candidateSha: "2".repeat(40), observedAt: "2026-07-17T12:20:00.000Z" }),
    ];
    expect(thresholdForObservations(entries, "2026-07-17T12:20:00.000Z")).toMatchObject({ crossed: true });
    expect(mergeCircuitRecord(null, signature(), entries, "2026-07-17T12:20:00.000Z")).toMatchObject({
      state: "holding",
      occurrenceCount: 2,
      distinctCandidateCount: 2,
    });
  });

  it("holds after three occurrences in six hours on one candidate", () => {
    const entries = [0, 1, 2].map((index) =>
      occurrence({ runId: index + 1, observedAt: `2026-07-17T1${index}:00:00.000Z` }),
    );
    expect(thresholdForObservations(entries, "2026-07-17T12:00:00.000Z")).toMatchObject({
      crossed: true,
      reason: expect.stringContaining("3 times"),
    });
  });

  it("does not double count event delivery during reconciliation", () => {
    const first = mergeCircuitRecord(null, signature(), [occurrence()], "2026-07-17T12:00:00.000Z");
    const replayed = mergeCircuitRecord(first, signature(), [occurrence()], "2026-07-17T12:05:00.000Z");
    expect(replayed.occurrenceCount).toBe(1);
  });

  it("keeps event-driven and daily reconciliation output equal for the seven-day fixture", async () => {
    const fixture = await readFixture("seven-day-events.json");
    let eventRecord = null;
    for (const entry of fixture.observations) {
      eventRecord = mergeCircuitRecord(eventRecord, fixture.signature, [entry], entry.observedAt);
    }
    const reconciled = mergeCircuitRecord(
      null,
      fixture.signature,
      fixture.observations,
      fixture.observations.at(-1).observedAt,
    );
    expect(eventRecord).toEqual(reconciled);
  });

  it("round-trips nested machine state through the hidden marker", () => {
    const record = circuit({ testIdentity: { file: "tests/a.test.ts", title: "a nested test" } });
    expect(parseCircuitMarker(`human text\n${renderCircuitMarker(record)}`)).toEqual(record);
  });

  it("recovers retry-pass flakes without retaining a deterministic hold", () => {
    const held = circuit({ observations: [occurrence({ runId: 77, runAttempt: 1 })] });
    expect(
      advanceCircuitRecovery(
        held,
        { runId: 77, runAttempt: 2, workflow: "Platform PR", lanes: ["merge-group"] },
        "2026-07-17T13:00:00.000Z",
      ),
    ).toMatchObject({
      record: { state: "recovered", recoveryReason: expect.stringContaining("retry-pass") },
      flake: true,
    });
  });

  it("requires the successful repair battery before an actual release closes a merge-group circuit", () => {
    const repairing = circuit({ state: "repairing", repairPrNumber: 88, repairBatteryPassedAt: null });
    const unrelatedRelease = {
      runId: 99,
      runAttempt: 1,
      workflow: "Platform Deploy",
      candidateSha: "c".repeat(40),
      lanes: ["staging", "production"],
      pullRequestNumbers: [99],
    };
    expect(advanceCircuitRecovery(repairing, unrelatedRelease, "2026-07-17T13:00:00.000Z")).toBeNull();
    const battery = advanceCircuitRecovery(
      repairing,
      {
        runId: 88,
        runAttempt: 1,
        workflow: "Platform PR",
        candidateSha: "d".repeat(40),
        lanes: ["merge-group"],
        pullRequestNumbers: [88],
      },
      "2026-07-17T13:00:00.000Z",
    ).record;
    expect(battery).toMatchObject({ state: "repairing", repairBatteryRunId: 88 });
    expect(advanceCircuitRecovery(battery, unrelatedRelease, "2026-07-17T14:00:00.000Z")).toBeNull();
    expect(
      advanceCircuitRecovery(
        battery,
        { ...unrelatedRelease, runId: 100, pullRequestNumbers: [88] },
        "2026-07-17T14:00:00.000Z",
      ),
    ).toMatchObject({
      record: { state: "recovered", recoveryReason: expect.stringContaining("actual release") },
    });
  });

  it("requires the actual repair candidate to pass the lane it repairs", () => {
    const repairing = circuit({
      state: "repairing",
      lane: "staging",
      repairCandidateSha: "a".repeat(40),
    });
    const releaseDispatchOnly = {
      runId: 91,
      runAttempt: 1,
      workflow: "Platform Deploy",
      candidateSha: "a".repeat(40),
      lanes: ["release-dispatch"],
    };
    const wrongCandidate = {
      ...releaseDispatchOnly,
      runId: 92,
      candidateSha: "b".repeat(40),
      lanes: ["staging"],
    };
    expect(advanceCircuitRecovery(repairing, releaseDispatchOnly, "2026-07-17T13:00:00.000Z")).toBeNull();
    expect(advanceCircuitRecovery(repairing, wrongCandidate, "2026-07-17T13:05:00.000Z")).toBeNull();
    expect(
      advanceCircuitRecovery(
        repairing,
        { ...releaseDispatchOnly, runId: 93, lanes: ["staging"] },
        "2026-07-17T13:10:00.000Z",
      ),
    ).toMatchObject({ record: { state: "recovered" } });
  });

  it("recovers after three consecutive affected-lane successes without a repair", () => {
    let record = circuit({ state: "holding", consecutiveSuccesses: 0 });
    for (let runId = 1; runId <= 3; runId += 1) {
      record = advanceCircuitRecovery(
        record,
        { runId, runAttempt: 1, workflow: "Platform PR", lanes: ["merge-group"] },
        `2026-07-17T1${runId}:00:00.000Z`,
      ).record;
    }
    expect(record).toMatchObject({ state: "recovered", consecutiveSuccesses: 3 });
  });

  it("keeps reconciliation replay from double-counting success or resetting its streak", () => {
    const held = circuit({ state: "holding", consecutiveSuccesses: 0 });
    const success = { runId: 9, runAttempt: 1, workflow: "Platform PR", lanes: ["merge-group"] };
    const advanced = advanceCircuitRecovery(held, success, "2026-07-17T13:00:00.000Z").record;
    expect(advanceCircuitRecovery(advanced, success, "2026-07-17T13:05:00.000Z")).toBeNull();
    const replayedFailure = mergeCircuitRecord(advanced, signature(), [occurrence()], "2026-07-17T13:05:00.000Z");
    expect(replayedFailure.consecutiveSuccesses).toBe(1);
  });

  it("starts a fresh occurrence window after recovery", () => {
    const recovered = circuit({
      state: "recovered",
      recoveredAt: "2026-07-10T12:00:00.000Z",
      observations: [
        occurrence({ runId: 1, candidateSha: "1".repeat(40), observedAt: "2026-07-10T10:00:00.000Z" }),
        occurrence({ runId: 2, candidateSha: "2".repeat(40), observedAt: "2026-07-10T10:20:00.000Z" }),
      ],
      occurrenceCount: 2,
      candidateShas: ["1".repeat(40), "2".repeat(40)],
    });
    const recurrence = occurrence({
      runId: 3,
      candidateSha: "3".repeat(40),
      observedAt: "2026-07-17T12:00:00.000Z",
    });

    expect(mergeCircuitRecord(recovered, signature(), [recurrence], recurrence.observedAt)).toMatchObject({
      state: "observed",
      occurrenceCount: 1,
      distinctCandidateCount: 1,
      observations: [recurrence],
    });
  });
});

describe("known failure guard", () => {
  it("blocks only requested affected automatic lanes", () => {
    expect(
      evaluateCircuitGuardDecision({
        circuits: [circuit({ lane: "staging" })],
        lanes: ["staging", "production"],
        automatic: true,
      }),
    ).toMatchObject({ decision: "block" });
    expect(
      evaluateCircuitGuardDecision({
        circuits: [circuit({ lane: "merge-group" })],
        lanes: ["staging"],
        automatic: true,
      }),
    ).toMatchObject({ decision: "allow" });
  });

  it("keeps unknown signatures blocking and visible", () => {
    const unknown = circuit({ rootCauseCode: "unknown", errorShape: "unknown failure", blocking: true });
    expect(
      evaluateCircuitGuardDecision({ circuits: [unknown], lanes: ["merge-group"], automatic: true }),
    ).toMatchObject({ decision: "block", holds: [expect.objectContaining({ rootCauseCode: "unknown" })] });
  });

  it("requires the canonical issue, reason, write actor, and valid repair PR for an escape", () => {
    const base = {
      circuits: [circuit()],
      lanes: ["merge-group"],
      automatic: false,
      circuitIssueNumber: 5500,
      circuitReason: "prove the repair",
      actorAuthorized: true,
      repairPrValid: true,
      candidateSha: "c".repeat(40),
    };
    expect(evaluateCircuitGuardDecision(base)).toMatchObject({ decision: "escape" });
    expect(evaluateCircuitGuardDecision({ ...base, circuitReason: "" })).toMatchObject({ decision: "block" });
    expect(evaluateCircuitGuardDecision({ ...base, actorAuthorized: false })).toMatchObject({ decision: "block" });
    expect(evaluateCircuitGuardDecision({ ...base, repairPrValid: false })).toMatchObject({ decision: "block" });
  });

  it("does not let one escape bypass a second circuit", () => {
    const result = evaluateCircuitGuardDecision({
      circuits: [circuit(), circuit({ signature: "other", canonicalIssueNumber: 5501 })],
      lanes: ["merge-group"],
      automatic: false,
      circuitIssueNumber: 5500,
      circuitReason: "repair one",
      actorAuthorized: true,
      repairPrValid: true,
    });
    expect(result).toMatchObject({ decision: "block", reason: expect.stringContaining("another active circuit") });
  });

  it("allows only the candidate that already owns a repairing escape", () => {
    const repairing = circuit({ state: "repairing", repairCandidateSha: "a".repeat(40), repairPrNumber: 77 });
    expect(
      evaluateCircuitGuardDecision({
        circuits: [repairing],
        lanes: ["merge-group"],
        automatic: false,
        circuitIssueNumber: 5500,
        circuitReason: "second repair",
        actorAuthorized: true,
        repairPrValid: true,
        repairPrNumber: 78,
        candidateSha: "b".repeat(40),
      }),
    ).toMatchObject({ decision: "block", reason: expect.stringContaining("already owns") });
  });

  it("keeps amended and requeued heads of the same repair PR authorized", () => {
    const repairing = circuit({ state: "repairing", repairCandidateSha: "a".repeat(40), repairPrNumber: 77 });
    expect(
      evaluateCircuitGuardDecision({
        circuits: [repairing],
        lanes: ["merge-group"],
        automatic: false,
        circuitIssueNumber: 5500,
        circuitReason: "amended repair",
        actorAuthorized: true,
        repairPrValid: true,
        repairPrNumber: 77,
        candidateSha: "b".repeat(40),
      }),
    ).toMatchObject({ decision: "escape" });
  });
});

describe("GitHub event evaluation", () => {
  it("streams a bounded failed-step window and creates then canonicalizes one machine-readable issue", async () => {
    const calls = [];
    let issueBody = "";
    let logReadCancelled = false;
    const response = (body, extra = {}) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      arrayBuffer: async () => Buffer.from(String(body)),
      ...extra,
    });
    const fetchImpl = async (url, request) => {
      calls.push({ url: String(url), request });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/labels/ci-circuit-repair")) {
        return response({}, { ok: false, status: 404 });
      }
      if (parsed.pathname.endsWith("/labels") && request.method === "POST") {
        return response({ name: "ci-circuit-repair" });
      }
      if (parsed.pathname.endsWith("/issues") && request.method === "GET") return response([]);
      if (parsed.pathname.endsWith("/actions/runs/123")) {
        return response({
          id: 123,
          name: "Platform PR",
          event: "merge_group",
          conclusion: "failure",
          head_sha: "b".repeat(40),
          run_attempt: 1,
          updated_at: "2026-07-17T12:00:00.000Z",
          html_url: "https://github.com/chase-sets/chase-sets/actions/runs/123",
        });
      }
      if (parsed.pathname.endsWith(`/commits/${"b".repeat(40)}`)) {
        return response({ parents: [{ sha: "a".repeat(40) }] });
      }
      if (parsed.pathname.endsWith("/actions/runs/123/jobs")) {
        return response({
          jobs: [
            {
              id: 456,
              name: "Unit Tests",
              conclusion: "failure",
              steps: [
                {
                  name: "Run unit tests",
                  conclusion: "failure",
                  started_at: FAILED_STEP_CONTEXT.failedStepStartedAt,
                  completed_at: FAILED_STEP_CONTEXT.failedStepCompletedAt,
                },
              ],
            },
          ],
        });
      }
      if (parsed.pathname.endsWith("/actions/jobs/456/logs")) {
        const bytes = new TextEncoder().encode(
          [
            ...Array.from(
              { length: 200 },
              (_, index) => `2026-07-17T11:59:58.${String(index).padStart(7, "0")}Z setup noise`,
            ),
            completeFailedStepLog("FAIL tests/a.test.ts > a\nAssertionError: expected 1 to be 2"),
          ].join("\n"),
        );
        let read = false;
        return response("", {
          body: {
            getReader: () => ({
              read: async () => {
                if (read) return { done: true };
                read = true;
                return { done: false, value: bytes };
              },
              cancel: async () => {
                logReadCancelled = true;
              },
              releaseLock: () => {},
            }),
          },
        });
      }
      if (parsed.pathname.endsWith("/issues") && request.method === "POST") {
        issueBody = JSON.parse(request.body).body;
        return response({ number: 6000, state: "open", title: "created", body: issueBody });
      }
      if (parsed.pathname.endsWith("/issues/6000") && request.method === "PATCH") {
        issueBody = JSON.parse(request.body).body;
        return response({ number: 6000, state: "open", title: "created", body: issueBody });
      }
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    };

    const result = await collectMergeGroupFailureSignatures({
      repository: "chase-sets/chase-sets",
      token: "token",
      checkedAt: "2026-07-17T12:00:00.000Z",
      sourceRunId: "123",
      maxRuns: 1,
      maxJobs: 10,
      maxLogBytes: 1024,
      mutate: true,
      fetchImpl,
      apiBaseUrl: "https://api.github.test",
    });

    expect(result.record.counts).toMatchObject({ evaluatedRuns: 1, activeSignatures: 1 });
    expect(parseCircuitMarker(issueBody)).toMatchObject({
      canonicalIssueNumber: 6000,
      lane: "merge-group",
      errorShape: "to be <number>",
    });
    expect(calls.filter((call) => call.url.endsWith("/issues") && call.request.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/labels") && call.request.method === "POST")).toHaveLength(1);
    expect(calls.find((call) => call.url.endsWith("/actions/jobs/456/logs")).request.headers.Range).toBeUndefined();
    expect(logReadCancelled).toBe(true);
  });

  it("reconciles the three production controls into separate open incident records", async () => {
    const fixture = await readFixture("production-failed-step-errors.json");
    const incidentNumbers = [6267, 6268, 6270];
    const incidents = fixture.cases.map((entry, index) => ({
      number: incidentNumbers[index],
      state: "open",
      title: `Incident: Platform Deploy fixture ${entry.runId}`,
      body: `Deployment evidence: https://github.com/chase-sets/chase-sets/actions/runs/${entry.runId}`,
    }));
    const response = (body) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      arrayBuffer: async () => Buffer.from(String(body)),
    });
    const fetchImpl = async (url, request) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/issues") && request.method === "GET") return response(incidents);
      if (parsed.pathname.endsWith("/actions/runs")) {
        return response({
          workflow_runs: fixture.cases.map((entry, index) => ({
            id: entry.runId,
            name: "Platform Deploy",
            event: "workflow_dispatch",
            conclusion: "failure",
            head_sha: String(index + 1).repeat(40),
            run_attempt: 1,
            updated_at: entry.context.failedStepCompletedAt,
          })),
        });
      }
      const runMatch = parsed.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
      if (runMatch) {
        const entry = fixture.cases.find((candidate) => candidate.runId === Number(runMatch[1]));
        return response({
          jobs: [
            {
              id: entry.context.jobId,
              name: entry.context.jobName,
              conclusion: "failure",
              steps: [
                {
                  name: entry.context.stepName,
                  conclusion: "failure",
                  started_at: entry.context.failedStepStartedAt,
                  completed_at: entry.context.failedStepCompletedAt,
                },
              ],
            },
          ],
        });
      }
      const jobMatch = parsed.pathname.match(/\/actions\/jobs\/(\d+)\/logs$/);
      if (jobMatch) {
        const entry = fixture.cases.find((candidate) => candidate.context.jobId === Number(jobMatch[1]));
        return response(entry.log.join("\n"));
      }
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    };

    const result = await collectMergeGroupFailureSignatures({
      repository: "chase-sets/chase-sets",
      checkedAt: "2026-07-29T03:00:00.000Z",
      windowDays: 1,
      maxRuns: 3,
      maxJobs: 10,
      maxLogBytes: 8192,
      mutate: false,
      fetchImpl,
      apiBaseUrl: "https://api.github.test",
    });

    expect(result.record.circuits).toHaveLength(3);
    expect(new Set(result.record.circuits.map((record) => record.errorFingerprint)).size).toBe(3);
    expect(result.record.circuits.map((record) => record.canonicalIssueNumber).sort()).toEqual(incidentNumbers);
    expect(incidents.every((incident) => incident.state === "open")).toBe(true);
  });

  it("does not let two deploy signatures overwrite one imported incident marker", async () => {
    const issueBodies = new Map([
      [5309, "Deployment evidence: https://github.com/chase-sets/chase-sets/actions/runs/123"],
    ]);
    const response = (body, extra = {}) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      arrayBuffer: async () => Buffer.from(String(body)),
      ...extra,
    });
    const fetchImpl = async (url, request) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/labels/ci-circuit-repair")) return response({ name: "ci-circuit-repair" });
      if (parsed.pathname.endsWith("/issues") && request.method === "GET") {
        return response([
          {
            number: 5309,
            state: "open",
            title: "Incident: Platform Deploy 123",
            body: issueBodies.get(5309),
          },
        ]);
      }
      if (parsed.pathname.endsWith("/actions/runs/123")) {
        return response({
          id: 123,
          name: "Platform Deploy",
          event: "workflow_dispatch",
          conclusion: "failure",
          head_sha: "b".repeat(40),
          run_attempt: 1,
          updated_at: "2026-07-17T12:00:00.000Z",
        });
      }
      if (parsed.pathname.endsWith("/actions/runs/123/jobs")) {
        return response({
          jobs: [
            {
              id: 451,
              name: "Deploy Staging",
              conclusion: "failure",
              steps: [{ name: "Apply staging", conclusion: "failure" }],
            },
            {
              id: 452,
              name: "Deploy Production",
              conclusion: "failure",
              steps: [{ name: "Verify production", conclusion: "failure" }],
            },
          ],
        });
      }
      if (parsed.pathname.endsWith("/actions/jobs/451/logs")) return response("DomainZoneInvalid: staging collision");
      if (parsed.pathname.endsWith("/actions/jobs/452/logs")) return response("Provider quota exhausted");
      if (parsed.pathname.endsWith("/issues") && request.method === "POST") {
        const body = JSON.parse(request.body).body;
        issueBodies.set(6001, body);
        return response({ number: 6001, state: "open", title: "created", body });
      }
      const issueMatch = parsed.pathname.match(/\/issues\/(5309|6001)$/);
      if (issueMatch && request.method === "PATCH") {
        const number = Number(issueMatch[1]);
        const body = JSON.parse(request.body).body;
        issueBodies.set(number, body);
        return response({
          number,
          state: "open",
          title: number === 5309 ? "Incident: Platform Deploy 123" : "created",
          body,
        });
      }
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    };

    const result = await collectMergeGroupFailureSignatures({
      repository: "chase-sets/chase-sets",
      checkedAt: "2026-07-17T12:00:00.000Z",
      sourceRunId: "123",
      maxRuns: 1,
      maxJobs: 10,
      maxLogBytes: 1024,
      mutate: true,
      fetchImpl,
      apiBaseUrl: "https://api.github.test",
    });

    const imported = parseCircuitMarker(issueBodies.get(5309));
    const separate = parseCircuitMarker(issueBodies.get(6001));
    expect(result.record.circuits).toHaveLength(2);
    expect(imported.canonicalIssueNumber).toBe(5309);
    expect(separate.canonicalIssueNumber).toBe(6001);
    expect(separate.signature).not.toBe(imported.signature);
  });

  it("filters pull requests before the circuit issue lookup cap", async () => {
    const active = circuit({ canonicalIssueNumber: 5309 });
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      const page = Number(parsed.searchParams.get("page") ?? 1);
      const body =
        page <= 3
          ? Array.from({ length: 100 }, (_, index) => ({
              number: page * 1000 + index,
              pull_request: {},
              title: `PR ${page}-${index}`,
              body: "",
            }))
          : [{ number: 5309, state: "open", title: "circuit", body: renderCircuitMarker(active) }];
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) =>
            name === "link" && page < 4
              ? `<https://api.github.test/repos/chase-sets/chase-sets/issues?state=all&per_page=100&page=${page + 1}>; rel="next"`
              : null,
        },
        json: async () => body,
      };
    };

    const result = await collectMergeGroupFailureSignatures({
      command: "guard",
      repository: "chase-sets/chase-sets",
      checkedAt: "2026-07-17T12:00:00.000Z",
      lanes: ["merge-group"],
      automatic: true,
      mutate: false,
      fetchImpl,
      apiBaseUrl: "https://api.github.test",
    });

    expect(result.record).toMatchObject({ decision: "block", holds: [{ issueNumber: 5309 }] });
  });

  it("audits amended heads while retaining repair ownership by PR number", async () => {
    let issueBody = renderCircuitMarker(circuit());
    const firstCandidate = "1".repeat(40);
    const amendedCandidate = "2".repeat(40);
    const firstHead = "a".repeat(40);
    const amendedHead = "b".repeat(40);
    const response = (body) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    });
    const fetchImpl = async (url, request) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/issues") && request.method === "GET") {
        return response([{ number: 5500, state: "open", title: "circuit", body: issueBody }]);
      }
      if (parsed.pathname.includes("/commits/") && parsed.pathname.endsWith("/pulls")) {
        const headSha = parsed.pathname.includes(firstCandidate) ? firstHead : amendedHead;
        return response([
          {
            number: 77,
            body: "Repairs #5500",
            labels: [{ name: "ci-circuit-repair" }],
            user: { login: "repair-author" },
            head: { sha: headSha },
          },
        ]);
      }
      if (parsed.pathname.endsWith("/collaborators/repair-author/permission")) {
        return response({ permission: "write" });
      }
      if (parsed.pathname.endsWith("/issues/5500") && request.method === "PATCH") {
        issueBody = JSON.parse(request.body).body;
        return response({ number: 5500, state: "open", title: "circuit", body: issueBody });
      }
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    };
    const guard = (candidateSha, workflowRunId, checkedAt) =>
      collectMergeGroupFailureSignatures({
        command: "guard",
        repository: "chase-sets/chase-sets",
        checkedAt,
        workflowRunId,
        lanes: ["merge-group"],
        automatic: false,
        circuitIssueNumber: 5500,
        circuitReason: "repair amended head",
        candidateSha,
        mutate: true,
        fetchImpl,
        apiBaseUrl: "https://api.github.test",
      });

    await expect(guard(firstCandidate, "900", "2026-07-17T12:00:00.000Z")).resolves.toMatchObject({
      record: { decision: "escape" },
    });
    await expect(guard(amendedCandidate, "901", "2026-07-17T12:10:00.000Z")).resolves.toMatchObject({
      record: { decision: "escape" },
    });

    expect(parseCircuitMarker(issueBody)).toMatchObject({
      state: "repairing",
      repairPrNumber: 77,
      repairCandidateSha: amendedCandidate,
      repairHeadSha: amendedHead,
      repairHeadShas: [firstHead, amendedHead],
      repairAttempts: [
        { candidateSha: firstCandidate, workflowRunId: "900" },
        { candidateSha: amendedCandidate, workflowRunId: "901" },
      ],
    });
  });

  it("reconciles a non-deploy circuit by title when its marker is malformed", async () => {
    const log = "FAIL tests/a.test.ts > a\nAssertionError: expected 1 to be 2";
    const [expected] = extractFailureSignatures(log, {
      lane: "merge-group",
      workflow: "Platform PR",
      jobName: "Unit Tests",
      stepName: "Run unit tests",
      jobId: 456,
    });
    let patchedBody = "";
    let created = false;
    const response = (body, extra = {}) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      arrayBuffer: async () => Buffer.from(String(body)),
      ...extra,
    });
    const fetchImpl = async (url, request) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/labels/ci-circuit-repair")) return response({ name: "ci-circuit-repair" });
      if (parsed.pathname.endsWith("/issues") && request.method === "GET") {
        return response([
          {
            number: 5309,
            state: "open",
            title: `[Delivery circuit] merge-group: Unit Tests / Run unit tests [${expected.signature.slice(0, 12)}]`,
            body: "<!-- delivery-failure-signature/v1 {malformed} -->",
          },
        ]);
      }
      if (parsed.pathname.endsWith("/actions/runs/123")) {
        return response({
          id: 123,
          name: "Platform PR",
          event: "merge_group",
          conclusion: "failure",
          head_sha: "b".repeat(40),
          run_attempt: 1,
          updated_at: "2026-07-17T12:00:00.000Z",
        });
      }
      if (parsed.pathname.endsWith(`/commits/${"b".repeat(40)}`)) {
        return response({ parents: [{ sha: "a".repeat(40) }] });
      }
      if (parsed.pathname.endsWith("/actions/runs/123/jobs")) {
        return response({
          jobs: [
            {
              id: 456,
              name: "Unit Tests",
              conclusion: "failure",
              steps: [{ name: "Run unit tests", conclusion: "failure" }],
            },
          ],
        });
      }
      if (parsed.pathname.endsWith("/actions/jobs/456/logs")) return response(log);
      if (parsed.pathname.endsWith("/issues") && request.method === "POST") {
        created = true;
        return response({ number: 6000, state: "open", body: JSON.parse(request.body).body });
      }
      if (parsed.pathname.endsWith("/issues/5309") && request.method === "PATCH") {
        patchedBody = JSON.parse(request.body).body;
        return response({ number: 5309, state: "open", title: "existing", body: patchedBody });
      }
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    };

    await collectMergeGroupFailureSignatures({
      repository: "chase-sets/chase-sets",
      checkedAt: "2026-07-17T12:00:00.000Z",
      sourceRunId: "123",
      maxRuns: 1,
      maxJobs: 10,
      maxLogBytes: 1024,
      mutate: true,
      fetchImpl,
      apiBaseUrl: "https://api.github.test",
    });

    expect(created).toBe(false);
    expect(parseCircuitMarker(patchedBody)).toMatchObject({
      signature: expected.signature,
      canonicalIssueNumber: 5309,
    });
  });

  it("surfaces API unavailable and rate-limited state", async () => {
    await expect(
      collectMergeGroupFailureSignatures({
        repository: "chase-sets/chase-sets",
        checkedAt: "2026-07-17T12:00:00.000Z",
        fetchImpl: async () => ({ ok: false, status: 503, headers: { get: () => null } }),
        apiBaseUrl: "https://api.github.test",
      }),
    ).rejects.toThrow("503");
    await expect(
      collectMergeGroupFailureSignatures({
        repository: "chase-sets/chase-sets",
        checkedAt: "2026-07-17T12:00:00.000Z",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: (name) => (name === "x-ratelimit-remaining" ? "19" : null) },
          json: async () => [],
        }),
        apiBaseUrl: "https://api.github.test",
      }),
    ).rejects.toThrow("rate limit");
  });

  it("parses event, guard, rollout, and repeated lane inputs", () => {
    expect(
      parseMergeGroupFailureSignaturesArgs(
        [
          "--command",
          "guard",
          "--lane",
          "staging",
          "--lane",
          "production",
          "--enforcement",
          "true",
          "--circuit-issue-number",
          "5500",
        ],
        { GITHUB_REPOSITORY: "chase-sets/chase-sets" },
      ),
    ).toMatchObject({
      command: "guard",
      lanes: ["staging", "production"],
      enforcement: true,
      circuitIssueNumber: 5500,
    });
  });
});

describe("workflow contracts", () => {
  it("runs event detection and guards merge-group and release mutation lanes", async () => {
    const detector = await readFile(
      new URL("../.github/workflows/platform-merge-group-failure-signatures.yml", import.meta.url),
      "utf8",
    );
    const platformPr = await readFile(new URL("../.github/workflows/platform-pr.yml", import.meta.url), "utf8");
    const production = await readFile(new URL("../.github/workflows/platform-production.yml", import.meta.url), "utf8");
    expect(detector).toContain("workflow_run:");
    expect(detector).toContain("workflows: [Platform PR, Platform Deploy, Platform Ephemeral Verification]");
    expect(detector).toContain("issues: write");
    expect(platformPr).toContain("known-failure-guard:");
    expect(platformPr).toContain("DELIVERY_FAILURE_MERGE_GROUP_CIRCUIT_ENFORCEMENT");
    expect(platformPr.indexOf("known-failure-guard:")).toBeLessThan(platformPr.indexOf("  static:"));
    expect(production).toContain("--lane staging");
    expect(production).toContain("DELIVERY_FAILURE_RELEASE_CIRCUIT_ENFORCEMENT");
    expect(production).toContain("--circuit-issue-number");
    expect(production.indexOf("Known Failure Guard")).toBeLessThan(
      production.indexOf("Activate immutable release before staging mutation"),
    );
    expect(production).toContain("Wait for staging ingress URLs");
  });
});
