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

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8"));
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
    const [failure] = extractFailureSignatures(log, {
      lane: "merge-group",
      workflow: "Platform PR",
      jobName: "Full Battery",
      stepName: "Run checks",
      jobId: 42,
    });
    expect(failure.schemaVersion).toBe(DELIVERY_FAILURE_SIGNATURE_VERSION);
    expect(failure.signature).toHaveLength(24);
    expect(failure.testTitle).toBe(expectedTitle);
    expect(failure.rootCauseCode).toBe(expectedRootCause);
    expect(failure.blocking).toBe(true);
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
  it("uses bounded GETs and creates then canonicalizes one machine-readable issue", async () => {
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
              steps: [{ name: "Run unit tests", conclusion: "failure" }],
            },
          ],
        });
      }
      if (parsed.pathname.endsWith("/actions/jobs/456/logs")) {
        const bytes = new TextEncoder().encode(
          "FAIL tests/a.test.ts > a\nAssertionError: expected 1 to be 2 and this tail must not be buffered",
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
      maxLogBytes: 32,
      mutate: true,
      fetchImpl,
      apiBaseUrl: "https://api.github.test",
    });

    expect(result.record.counts).toMatchObject({ evaluatedRuns: 1, activeSignatures: 1 });
    expect(parseCircuitMarker(issueBody)).toMatchObject({ canonicalIssueNumber: 6000, lane: "merge-group" });
    expect(calls.filter((call) => call.url.endsWith("/issues") && call.request.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/labels") && call.request.method === "POST")).toHaveLength(1);
    expect(calls.find((call) => call.url.endsWith("/actions/jobs/456/logs")).request.headers.Range).toBe("bytes=0-31");
    expect(logReadCancelled).toBe(true);
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
