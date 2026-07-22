import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildMergeQualificationCandidate,
  buildMergeQualificationDecision,
  buildMergeQualificationEvent,
  resolveRunTerminalization,
} from "./merge-qualification-advisory.mjs";
import { collectReleaseHealthGithubMetadata } from "./release-health-github-metadata.mjs";
import {
  DELIVERY_HEALTH_VERSION,
  GITHUB_ACTIONS_COMPLETED_CONCLUSIONS,
  buildDeliveryHealth,
  collectSourceData,
  createGitHubClient,
  normalizeDeliveryConclusion,
  parseSliMarker,
  percentileSummary,
  publishSliIssues,
  readDeliveryHealthPolicy,
  validateDeliveryHealthPolicy,
  renderSliMarker,
  unzipJsonEntries,
} from "./release-health-delivery-health.mjs";
import { repoRoot } from "./lib/repo.mjs";

let policy;

beforeAll(async () => {
  policy = await readDeliveryHealthPolicy();
});

describe("delivery health conclusion normalization", () => {
  it.each([
    [{ conclusion: "success", runAttempt: 1 }, "success"],
    [{ conclusion: "success", runAttempt: 2 }, "retry-pass/flake"],
    [{ conclusion: "failure" }, "deterministic-failure"],
    [{ conclusion: "cancelled", reason: "candidate superseded by latest main" }, "intentional-superseded/coalesced"],
    [{ conclusion: "cancelled", reason: "cancelled by newer candidate" }, "cancelled-by-newer-candidate"],
    [{ conclusion: "skipped", eligible: false }, "skipped/not-eligible"],
    [{ conclusion: "cancelled" }, "unknown"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeDeliveryConclusion(input)).toBe(expected);
  });

  it("uses nearest-rank percentiles and keeps empty samples explicit", () => {
    expect(percentileSummary([])).toEqual({ sampleCount: 0, p50: null, p90: null, p95: null });
    expect(percentileSummary([10, 50, 20, 40, 30])).toEqual({ sampleCount: 5, p50: 30, p90: 50, p95: 50 });
  });
});

describe("closed delivery-health policy contract", () => {
  it("accepts the complete checked-in nested workflow-source contract", () => {
    expect(() => validateDeliveryHealthPolicy(structuredClone(policy))).not.toThrow();
  });

  it.each([
    ["missing source", (value) => delete value.collection.workflowSources.mergeQualificationTerminalizer],
    [
      "extra source",
      (value) => {
        value.collection.workflowSources.legacy = "legacy.yml";
      },
    ],
    [
      "extra collection field",
      (value) => {
        value.collection.cursor = "mutable";
      },
    ],
    [
      "extra baseline metric field",
      (value) => {
        Object.values(value.baseline.metrics)[0].extra = true;
      },
    ],
    [
      "calendar-invalid capturedAt",
      (value) => {
        value.baseline.capturedAt = "2026-02-30T12:00:00.000Z";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const invalid = structuredClone(policy);
    mutate(invalid);
    expect(() => validateDeliveryHealthPolicy(invalid)).toThrow("Invalid delivery-health policy");
  });
});

describe("GitHub collection conventions", () => {
  it("paginates beyond one API page and reports the observed rate limit", async () => {
    const calls = [];
    const client = createGitHubClient(
      {
        repository: "chase-sets/chase-sets",
        token: "test-token",
        fetchImpl: async (url) => {
          calls.push(url);
          const page = Number(new URL(url).searchParams.get("page"));
          return new Response(
            JSON.stringify(page === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }]),
            {
              status: 200,
              headers: { "content-type": "application/json", "x-ratelimit-remaining": "4321" },
            },
          );
        },
        sleep: async () => {},
      },
      { maxPages: 3, retries: 1 },
    );

    const result = await client.paginate("/issues?per_page=100", (value) => value, { source: "fixture" });

    expect(result).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(client.status()).toMatchObject({ truncated: [], rateLimitRemaining: 4321 });
  });

  it("makes max-page truncation visible", async () => {
    const client = createGitHubClient(
      {
        repository: "chase-sets/chase-sets",
        fetchImpl: async () =>
          new Response(JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id }))), { status: 200 }),
        sleep: async () => {},
      },
      { maxPages: 1, retries: 0 },
    );
    await expect(client.paginate("/issues?per_page=100", (value) => value, { source: "fixture" })).rejects.toThrow(
      "exceeded the bounded 1 pages",
    );
    expect(client.status().truncated).toEqual(["fixture"]);
  });

  it("reconciles declared totals across short, duplicate, and out-of-order pages", async () => {
    const pages = [
      {
        items: [{ id: 2 }, { id: 1 }],
        link: '<https://api.github.com/repos/chase-sets/chase-sets/items?per_page=3&page=2>; rel="next"',
      },
      { items: [{ id: 1 }, { id: 3 }, { id: 2 }], link: null },
    ];
    let call = 0;
    const client = createGitHubClient(
      {
        repository: "chase-sets/chase-sets",
        fetchImpl: async () => {
          const page = pages[call++];
          return new Response(JSON.stringify({ total_count: 3, items: page.items }), {
            status: 200,
            headers: page.link ? { link: page.link } : {},
          });
        },
        sleep: async () => {},
      },
      { maxPages: 3, retries: 0 },
    );
    await expect(
      client.paginate("/items?per_page=3", (payload) => payload.items, {
        source: "canonical-items",
        perPage: 3,
        identity: (item) => item.id,
      }),
    ).resolves.toEqual([{ id: 2 }, { id: 1 }, { id: 3 }]);
  });

  it("fails explicitly on a missing short page, conflicting duplicate, repeated cursor, and bounded refusal", async () => {
    const clientFor = (responses, maxPages = 2) => {
      let call = 0;
      return createGitHubClient(
        {
          repository: "chase-sets/chase-sets",
          fetchImpl: async () => responses[Math.min(call++, responses.length - 1)],
          sleep: async () => {},
        },
        { maxPages, retries: 0 },
      );
    };
    const page = (body, link) => new Response(JSON.stringify(body), { status: 200, headers: link ? { link } : {} });
    const options = { source: "canonical-items", perPage: 2, identity: (item) => item.id };

    const missing = clientFor([
      page({ total_count: 3, items: [{ id: 1 }, { id: 2 }] }),
      page({ total_count: 3, items: [] }),
    ]);
    await expect(missing.paginate("/items?per_page=2", (payload) => payload.items, options)).rejects.toThrow(
      "bounded 2 pages",
    );
    expect(missing.status().truncated).toEqual(["canonical-items"]);

    const conflict = clientFor([
      page({ total_count: 2, items: [{ id: 1, value: "a" }] }),
      page({ total_count: 2, items: [{ id: 1, value: "b" }] }),
    ]);
    await expect(conflict.paginate("/items?per_page=2", (payload) => payload.items, options)).rejects.toThrow(
      "conflicting duplicate 1",
    );

    const same = '<https://api.github.com/repos/chase-sets/chase-sets/items?per_page=2&page=1>; rel="next"';
    const repeated = clientFor(
      [page({ total_count: 3, items: [{ id: 1 }] }, same), page({ total_count: 3, items: [{ id: 1 }] }, same)],
      3,
    );
    await expect(repeated.paginate("/items?per_page=2", (payload) => payload.items, options)).rejects.toThrow(
      "repeated pagination cursor",
    );

    const oversized = clientFor([page({ total_count: 5, items: [] })], 2);
    await expect(oversized.paginate("/items?per_page=2", (payload) => payload.items, options)).rejects.toThrow(
      "beyond the 4 item bound",
    );
  });
});

describe("delivery-health/v1", () => {
  it("separates workflow events and release stages with explicit denominators", () => {
    const source = representativeSource();
    const result = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: { rateLimitRemaining: 4000 },
    });
    const current = result.record.windows.rolling24h;

    expect(result.record.schemaVersion).toBe(DELIVERY_HEALTH_VERSION);
    expect(result.record.baselineComparison).toMatchObject({
      sourceIssue: 5496,
      metrics: { actualReleaseSuccess: { baseline: 0.5333333333, current: 0.9 } },
    });
    expect(result.record.rolloutComparisons).toContainEqual({ issue: 5501, status: "pending", landedAt: null });
    expect(result.record.query.sourceRunIds.platformPr).toHaveLength(32);
    expect(current.prs).toMatchObject({ created: 12, merged: 10, stillOpen: 2 });
    expect(current.prs.changedFiles).toMatchObject({ sampleCount: 12, p50: 6, p90: 11 });
    expect(current.prs.nonGeneratedChurn.p90).toBe(22);
    expect(current.prs.reviews).toEqual({ submitted: 12, approved: 6 });
    expect(current.prs.platformPr.pullRequest).toMatchObject({ numerator: 10, denominator: 12 });
    expect(current.prs.platformPr.mergeGroup).toMatchObject({ numerator: 19, denominator: 20, successRate: 0.95 });
    expect(current.releases.dispatch).toMatchObject({ runCount: 3, denominator: 3 });
    expect(current.releases.actual).toMatchObject({
      runCount: 11,
      numerator: 9,
      denominator: 10,
      supersededOrCoalesced: 1,
      preMutationFailures: 1,
    });
    expect(current.releases.staging).toMatchObject({ eligible: 10, applied: 9, denominator: 10 });
    expect(current.releases.production).toMatchObject({ eligible: 9, numerator: 9, denominator: 9, rollbacks: 0 });
    expect(current.releases.ephemeral).toMatchObject({ eligible: 20, success: 19, failure: 1, skipped: 1 });
    expect(current.failureSignatures).toMatchObject({
      sourceCount: 2,
      openMutationCircuitCount: 1,
      rootCauseDistribution: { "staging-dns": 1, unknown: 1 },
      meanTimeToRecoverySeconds: 600,
    });
    expect(result.record.slis).toContainEqual(
      expect.objectContaining({ id: "open-mutation-circuit", status: "breaching", severity: "p0" }),
    );
    expect(result.markdown).toContain(
      "Intentional outcomes remain visible and are excluded from success denominators.",
    );
  });

  it("keeps cancellations visible without reducing actual-release success", () => {
    const source = representativeSource();
    source.deployRuns = source.deployRuns.filter(
      (run) => run.event !== "workflow_dispatch" || run.conclusion !== "failure",
    );
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "daily",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    }).record;
    expect(record.windows.rolling24h.releases.actual).toMatchObject({
      runCount: 10,
      numerator: 9,
      denominator: 9,
      successRate: 1,
      supersededOrCoalesced: 1,
    });
  });

  it("does not count read-only cutover plans as actual releases", () => {
    const source = representativeSource();
    source.deployRuns.push(
      run(590, "workflow_dispatch", "success", {
        jobs: [
          { name: "Production Cutover Live Plans", conclusion: "success" },
          { name: "Resolve Release", conclusion: "skipped" },
          { name: "Deploy Staging", conclusion: "skipped" },
          { name: "Deploy Production", conclusion: "skipped" },
        ],
      }),
    );
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    }).record;
    expect(record.windows.rolling24h.releases.actual.runCount).toBe(11);
    expect(record.completeness.status).toBe("complete");
  });

  it("reports resolve-only no-deployment decisions without adding them to the release denominator", () => {
    const source = representativeSource();
    source.deployRuns.push(
      run(591, "workflow_dispatch", "success", {
        jobs: [
          { name: "Resolve Release", conclusion: "success" },
          { name: "Deploy Staging", conclusion: "skipped" },
          { name: "Deploy Production", conclusion: "skipped" },
        ],
      }),
    );
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    }).record;
    expect(record.windows.rolling24h.releases.actual).toMatchObject({
      runCount: 12,
      denominator: 10,
      outcomes: { "skipped/not-eligible": 1 },
    });
    expect(record.completeness.status).toBe("complete");
  });

  it("applies last-N independently to each event and release series", () => {
    const source = representativeSource();
    source.platformPrRuns = [
      ...Array.from({ length: 25 }, (_, index) =>
        run(600 + index, "pull_request", "success", { updated_at: iso(index) }),
      ),
      ...Array.from({ length: 25 }, (_, index) =>
        run(700 + index, "merge_group", "success", { updated_at: iso(index) }),
      ),
    ];
    source.deployRuns = [
      ...Array.from({ length: 25 }, (_, index) => run(800 + index, "push", "success", { updated_at: iso(index) })),
      ...Array.from({ length: 25 }, (_, index) =>
        run(900 + index, "workflow_dispatch", "success", {
          updated_at: iso(index),
          jobs: [stageJob("Deploy Staging", "success", index), stageJob("Deploy Production", "success", index)],
          releaseArtifacts: [releaseRecord("success", { index })],
        }),
      ),
    ];
    source.ephemeralRuns = Array.from({ length: 25 }, (_, index) =>
      run(1_000 + index, "workflow_run", "success", {
        updated_at: iso(index),
        jobs: [ephemeralJob("success")],
      }),
    );
    const lastN = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    }).record.windows.lastN;

    expect(lastN.prs.platformPr.pullRequest.denominator).toBe(20);
    expect(lastN.prs.platformPr.mergeGroup.denominator).toBe(20);
    expect(lastN.releases.dispatch.denominator).toBe(20);
    expect(lastN.releases.actual.denominator).toBe(20);
    expect(lastN.releases.ephemeral.denominator).toBe(20);
  });

  it("treats a complete empty mutation-circuit set as passing", () => {
    const source = representativeSource();
    source.circuits = [];
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    }).record;
    expect(record.slis).toContainEqual(
      expect.objectContaining({ id: "open-mutation-circuit", value: 0, sample: 0, status: "passing" }),
    );
  });

  it("suppresses alerts when API data is truncated or release artifacts are missing", () => {
    const source = representativeSource();
    source.deployRuns.find(
      (run) => run.event === "workflow_dispatch" && run.conclusion === "success",
    ).releaseArtifacts = [];
    source.pulls[0].nestedDataTruncated = true;
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: { truncated: ["workflow:platform-pr.yml"], rateLimited: true },
    }).record;
    expect(record.completeness).toMatchObject({ status: "partial", api: { rateLimited: true } });
    expect(record.completeness.reasons).toContain("truncated:workflow:platform-pr.yml");
    expect(record.completeness.reasons).toContain("truncated:pull-request-nested-data");
    expect(record.slis.every((sli) => sli.status === "insufficient-data")).toBe(true);
  });

  it("reports a zero merge-qualification steady state while the advisory policy is disabled", () => {
    const result = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source: representativeSource(),
      apiStatus: {},
    });
    expect(result.record.mergeQualification).toMatchObject({
      schemaVersion: "merge-qualification-summary/v1",
      sampleCount: 0,
      counts: { success: 0, applicationFailure: 0, cancellation: 0, infrastructure: 0 },
      stagingCatchCount: 0,
      orphanCount: 0,
    });
    // Disabled steady state: the canonical record carries the block, the
    // markdown stays quiet instead of rendering an empty advisory section.
    expect(result.markdown).not.toContain("Merge qualification (advisory)");
  });

  it("summarizes advisory merge-qualification stage events and executes the staging join inside the canonical record", () => {
    const source = representativeSource();
    const passed = qualificationEvent({
      candidateSha: "a".repeat(40),
      candidateTreeSha: "b".repeat(40),
      terminalState: "passed",
      completedAt: "2026-07-18T10:20:00.000Z",
      providerHeadroom: { headroomRuns: 3 },
      runId: "9001",
    });
    const failed = qualificationEvent({
      candidateSha: "c".repeat(40),
      candidateTreeSha: "d".repeat(40),
      terminalState: "failed",
      reasonCodes: ["gate_failed"],
      completedAt: "2026-07-18T10:30:00.000Z",
      providerHeadroom: { headroomRuns: 2 },
      runId: "9002",
    });
    const notApplicable = qualificationEvent({
      candidateSha: "e".repeat(40),
      candidateTreeSha: "f".repeat(40),
      classifierClass: "not_applicable",
      terminalState: "not_applicable",
      reasonCodes: ["docs_or_test_only"],
      imageDigest: null,
      provisioned: false,
      completedAt: "2026-07-18T10:00:30.000Z",
      runId: "9003",
    });
    source.mergeQualification = {
      events: [passed, failed, notApplicable],
      candidates: [
        candidateFor(passed),
        candidateFor(failed),
        candidateFor(notApplicable),
        { parentRunId: "8003", parentRunAttempt: "1", candidateSha: "9".repeat(40), runId: "9004", runAttempt: "1" },
      ],
      // No injected comparisons: the builder must execute the tree/digest/
      // time-safe join against these persistent-staging release identities.
      releases: [
        {
          candidateSha: passed.candidateSha,
          candidateTreeSha: passed.candidateTreeSha,
          mainSha: "1".repeat(40),
          mainTreeSha: passed.candidateTreeSha,
          imageDigest: passed.imageDigest,
          completedAt: "2026-07-18T11:00:00.000Z",
          causalBridge: causalBridgeFor(passed),
          staging: { result: "failure", rootCauseCode: "blocking-staging-verification" },
        },
      ],
      failures: [],
    };
    const result = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    });
    expect(result.record.mergeQualification).toMatchObject({
      sampleCount: 3,
      candidateCount: 4,
      counts: { success: 1, applicationFailure: 1, notApplicable: 1 },
      durationSeconds: { sampleCount: 2, p50: 1200, p90: 1800, p95: 1800 },
      stagingCatchCount: 1,
      supersededCount: 1,
      orphanCount: 1,
      providerHeadroom: { sampleCount: 2, minHeadroomRuns: 2, latestHeadroomRuns: 2 },
      evidence: { invalidEventCount: 0, conflictCount: 0, complete: false, missingTerminalCount: 1 },
    });
    expect(result.record.completeness.status).toBe("partial");
    expect(result.markdown).toContain("### Merge qualification (advisory)");
    expect(result.markdown).toContain("1 staging catches");
  });

  it("keeps the join temporally safe inside the canonical record: a pre-qualification same-tree release never counts as a catch", () => {
    const source = representativeSource();
    const passed = qualificationEvent({
      candidateSha: "a".repeat(40),
      candidateTreeSha: "b".repeat(40),
      terminalState: "passed",
      completedAt: "2026-07-18T10:20:00.000Z",
      runId: "9001",
    });
    source.mergeQualification = {
      events: [passed],
      candidates: [candidateFor(passed)],
      releases: [
        {
          candidateSha: passed.candidateSha,
          candidateTreeSha: passed.candidateTreeSha,
          mainSha: "1".repeat(40),
          mainTreeSha: passed.candidateTreeSha,
          imageDigest: passed.imageDigest,
          completedAt: "2026-07-18T09:00:00.000Z",
          causalBridge: causalBridgeFor(passed),
          staging: { result: "failure", rootCauseCode: "blocking-staging-verification" },
        },
      ],
      failures: [],
    };
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    }).record;
    expect(record.mergeQualification.stagingCatchCount).toBe(0);
    expect(record.mergeQualification.temporalOrphanCount).toBe(1);
  });

  it("degrades completeness on merge-qualification collection failures and invalid or conflicting evidence", () => {
    const source = representativeSource();
    const valid = qualificationEvent({ runId: "9001" });
    const contradiction = { ...valid, terminalState: "failed", reasonCodes: ["gate_failed"] };
    source.mergeQualification = {
      events: [valid, contradiction, { schemaVersion: "merge-qualification-event/v2" }],
      candidates: [candidateFor(valid)],
      releases: [],
      failures: [{ source: "merge-qualification-artifacts:9001", error: "download failed" }],
    };
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    }).record;
    expect(record.completeness.status).toBe("partial");
    expect(record.completeness.reasons).toContain("merge-qualification:merge-qualification-artifacts:9001");
    expect(record.completeness.reasons).toContain("merge-qualification:invalid-events:1");
    expect(record.completeness.reasons).toContain("merge-qualification:conflicting-candidates:1");
    // Alerts are suppressed while advisory evidence is incomplete.
    expect(record.slis.every((sli) => sli.status === "insufficient-data")).toBe(true);
    // Conflicting evidence never reaches the denominators.
    expect(record.mergeQualification.sampleCount).toBe(0);
  });

  it("keeps the artifact support-safe and never copies logs or pull request titles", () => {
    const source = representativeSource();
    source.platformPrRuns[0].logs = "Authorization: Bearer secret-value";
    source.pulls[0].title = "private customer incident";
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    }).record;
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("private customer incident");
    expect(serialized).not.toContain('"logs"');
  });
});

describe("canonical SLI issues", () => {
  it("round-trips hidden markers and updates one existing issue per SLI", async () => {
    const marker = renderSliMarker({ schemaVersion: "delivery-health-sli/v1", sli: "merge-group-success" });
    expect(parseSliMarker(marker)).toEqual({ schemaVersion: "delivery-health-sli/v1", sli: "merge-group-success" });

    const calls = [];
    const client = {
      paginate: async () => [
        { number: 55, state: "open", body: marker },
        { number: 56, state: "open", body: "not a machine issue" },
      ],
      json: async (path, request) => {
        calls.push({ path, request });
        return { number: path === "/issues" ? 57 : Number(path.split("/").at(-1)) };
      },
    };
    const record = {
      generatedAt: "2026-07-18T12:00:00.000Z",
      completeness: { status: "complete" },
      slis: [sli("merge-group-success", "breaching"), sli("actual-release-success", "breaching")],
    };
    const updates = await publishSliIssues({ client, repository: "chase-sets/chase-sets", record });

    expect(updates).toEqual([
      { sli: "merge-group-success", action: "updated", issueNumber: 55 },
      { sli: "actual-release-success", action: "created", issueNumber: 57 },
    ]);
    expect(calls.map((call) => call.path)).toEqual(["/issues/55", "/issues"]);
    expect(parseSliMarker(calls[0].request.body.body)).toEqual({
      schemaVersion: "delivery-health-sli/v1",
      sli: "merge-group-success",
    });
  });
});

describe("scheduled merge-qualification collection (production wiring)", () => {
  const candidateSha = "a".repeat(40);
  const candidateTree = "b".repeat(40);
  const mainSha = "1".repeat(40);
  const passedEvent = qualificationEvent({
    candidateSha,
    candidateTreeSha: candidateTree,
    terminalState: "passed",
    completedAt: "2026-07-18T10:20:00.000Z",
    providerHeadroom: { headroomRuns: 3 },
    runId: "9001",
  });
  const disabledDecision = buildMergeQualificationDecision({
    repository: "chase-sets/chase-sets",
    workflowId: "1",
    workflowPath: ".github/workflows/platform-merge-qualification.yml",
    runId: "9001",
    runAttempt: "1",
    parentWorkflowId: "2",
    parentWorkflowPath: ".github/workflows/platform-pr.yml",
    parentRunId: "8000",
    parentRunAttempt: "1",
    candidateSha,
    candidateTreeSha: candidateTree,
    builtImageDigest: null,
    policyEnabled: false,
    policyReasonCode: "policy_disabled",
    classifierClass: null,
    classifierReasonCodes: [],
    observedAt: "2026-07-18T10:00:00.000Z",
  }).decision;
  const stagingHealthRecord = {
    schemaVersion: "release-health/v1",
    releaseCommit: mainSha,
    pullRequest: { number: 5839 },
    queue: {
      mergeQualificationLineageVersion: "release-candidate-linkage/v1",
      candidateSha,
      candidateTreeSha: candidateTree,
      candidateArtifactId: "18000",
      candidateArtifactName: "merge-qualification-candidate-8000-1",
      mergeGroupWorkflowId: "2",
      mergeGroupWorkflowPath: ".github/workflows/platform-pr.yml",
      candidateImageDigest: passedEvent.imageDigest,
      mergeGroupRunId: "8000",
      mergeGroupRunAttempt: "1",
      mergeSha: mainSha,
      mergeTreeSha: candidateTree,
      lineageComplete: true,
      lineageReasons: [],
    },
    staging: { result: "failure", applied: true, startedAt: iso(60), completedAt: "2026-07-18T11:00:00.000Z" },
    production: { result: "skipped" },
    recovery: { mode: "none" },
    releaseState: { transitions: [{ type: "promoted", imageDigest: passedEvent.imageDigest }] },
  };
  const rootCauseRecord = {
    schemaVersion: "platform-deploy-root-cause/v1",
    rootCauseCode: "blocking-staging-verification",
  };

  function fakeClient(overrides = {}) {
    const routes = {
      "https://api.github.com/graphql": () => ({
        data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
      }),
      "/actions/workflows/platform-pr.yml/runs": () => ({ workflow_runs: [] }),
      "/actions/workflows/platform-merge-qualification.yml/runs": () => ({
        workflow_runs: [
          {
            id: 9001,
            workflow_id: 1,
            path: ".github/workflows/platform-merge-qualification.yml",
            event: "workflow_run",
            status: "completed",
            display_title: "Merge Qualification merge_group 8000-1",
            conclusion: "success",
            // Real workflow_run semantics: this is the default-branch SHA,
            // not the upstream merge-group candidate.
            head_sha: "d".repeat(40),
            run_attempt: 1,
            created_at: iso(120),
            run_started_at: iso(119),
            updated_at: iso(100),
          },
        ],
      }),
      "/actions/workflows/platform-release-candidate.yml/runs": () => ({ workflow_runs: [] }),
      "/actions/workflows/platform-production.yml/runs": () => ({
        workflow_runs: [
          {
            id: 9101,
            event: "workflow_dispatch",
            conclusion: "failure",
            run_attempt: 1,
            created_at: iso(90),
            run_started_at: iso(89),
            updated_at: iso(50),
          },
        ],
      }),
      "/actions/workflows/platform-ephemeral-verification.yml/runs": () => ({ workflow_runs: [] }),
      "/actions/workflows/platform-merge-qualification-terminalizer.yml/runs": () => ({
        workflow_runs: [
          {
            id: 9200,
            event: "workflow_run",
            status: "completed",
            conclusion: "success",
            run_attempt: 1,
            updated_at: iso(95),
          },
        ],
      }),
      "/actions/runs/9101/jobs": () => ({
        jobs: [
          { name: "Deploy Staging", conclusion: "failure", started_at: iso(80), completed_at: iso(60), steps: [] },
        ],
      }),
      "/actions/runs/9101/artifacts": () => ({
        artifacts: [
          { id: 1, name: "staging-release-health-9101", archive_download_url: "https://example.test/release-zip" },
        ],
      }),
      "/actions/runs/9001/artifacts": () => ({
        artifacts: [
          { id: 2, name: "merge-qualification-events-9001-1", archive_download_url: "https://example.test/event-zip" },
        ],
      }),
      "/actions/runs/9200/artifacts": () => ({ artifacts: [] }),
      [`/git/commits/${mainSha}`]: () => ({ tree: { sha: candidateTree } }),
      "https://api.github.com/search/issues": () => ({ items: [] }),
      "https://example.test/release-zip": () =>
        buildZip([
          ["staging-release.json", JSON.stringify(stagingHealthRecord), 0],
          ["staging-deploy-root-cause.json", JSON.stringify(rootCauseRecord), 0],
        ]),
      "https://example.test/event-zip": () => buildZip([["event.json", JSON.stringify(passedEvent), 0]]),
      ...overrides,
    };
    const resolve = (pathOrUrl) => {
      const key = Object.keys(routes).find((route) => String(pathOrUrl).startsWith(route));
      if (!key) throw new Error(`no fixture route for ${pathOrUrl}`);
      const payload = routes[key]();
      if (payload instanceof Error) throw payload;
      return payload;
    };
    return {
      status: () => ({ truncated: [], errors: [], rateLimited: false, retryCount: 0 }),
      markTruncated: () => {},
      async json(pathOrUrl) {
        return resolve(pathOrUrl);
      },
      async paginate(path, select) {
        const chosen = select(resolve(path));
        return Array.isArray(chosen) ? chosen : [];
      },
      async request(url) {
        const payload = resolve(url);
        return { arrayBuffer: async () => payload };
      },
    };
  }

  const options = { repository: "chase-sets/chase-sets", checkedAt: "2026-07-18T12:00:00.000Z" };

  it("defines a closed disposition for every completed GitHub Actions conclusion", () => {
    expect(Object.keys(GITHUB_ACTIONS_COMPLETED_CONCLUSIONS).sort()).toEqual(
      [
        "action_required",
        "cancelled",
        "failure",
        "neutral",
        "skipped",
        "stale",
        "startup_failure",
        "success",
        "timed_out",
      ].sort(),
    );
  });

  it.each(["startup_failure", "action_required"])(
    "inventories a production-shaped %s attempt as visibly incomplete when terminal evidence is absent",
    async (conclusion) => {
      const runId = conclusion === "startup_failure" ? 9301 : 9302;
      const source = await collectSourceData({
        options,
        policy,
        client: fakeClient({
          "/actions/workflows/platform-merge-qualification.yml/runs": () => ({
            workflow_runs: [
              {
                id: runId,
                workflow_id: 1,
                path: ".github/workflows/platform-merge-qualification.yml",
                event: "workflow_run",
                status: "completed",
                display_title: "Merge Qualification merge_group 8300-1",
                conclusion,
                run_attempt: 1,
                created_at: iso(120),
                run_started_at: iso(119),
                updated_at: iso(100),
              },
            ],
          }),
          [`/actions/runs/${runId}/artifacts`]: () => ({ artifacts: [] }),
        }),
        queryStart: "2026-07-11T12:00:00.000Z",
      });
      expect(source.mergeQualification.candidates).toEqual([
        {
          parentRunId: "8300",
          parentRunAttempt: "1",
          runId: String(runId),
          runAttempt: "1",
          candidateSha: null,
        },
      ]);
      expect(source.mergeQualification.events).toEqual([]);
      expect(source.mergeQualification.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: `merge-qualification-completed-attempt:${runId}:1` }),
        ]),
      );
      const record = buildDeliveryHealth({
        checkedAt: options.checkedAt,
        publicationMode: "hourly",
        repository: options.repository,
        policy,
        source,
        apiStatus: source.apiStatus,
      }).record;
      expect(record.mergeQualification).toMatchObject({ candidateCount: 1, sampleCount: 0 });
      expect(record.mergeQualification.evidence.complete).toBe(false);
    },
  );

  it("fails an unknown future completed conclusion visibly", async () => {
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient({
        "/actions/workflows/platform-merge-qualification.yml/runs": () => ({
          workflow_runs: [
            {
              id: 9303,
              workflow_id: 1,
              path: ".github/workflows/platform-merge-qualification.yml",
              event: "workflow_run",
              status: "completed",
              display_title: "Merge Qualification merge_group 8301-1",
              conclusion: "future_conclusion",
              run_attempt: 1,
              updated_at: iso(100),
            },
          ],
        }),
        "/actions/runs/9303/artifacts": () => ({ artifacts: [] }),
      }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(source.mergeQualification.candidates).toHaveLength(1);
    expect(source.mergeQualification.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "merge-qualification-conclusion:9303:1" })]),
    );
  });

  it("collects qualification artifacts, the candidate inventory, staging identities, and executes the join end to end", async () => {
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient(),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(source.mergeQualification.events).toEqual([passedEvent]);
    expect(source.mergeQualification.candidates).toEqual([
      { parentRunId: "8000", parentRunAttempt: "1", candidateSha, runId: "9001", runAttempt: "1" },
    ]);
    expect(source.mergeQualification.failures).toEqual([]);
    expect(source.mergeQualification.releases).toEqual([
      {
        candidateSha,
        mainSha,
        candidateTreeSha: candidateTree,
        mainTreeSha: candidateTree,
        imageDigest: passedEvent.imageDigest,
        completedAt: "2026-07-18T11:00:00.000Z",
        causalBridge: causalBridgeFor(passedEvent),
        staging: { result: "failure", rootCauseCode: "blocking-staging-verification" },
      },
    ]);

    const record = buildDeliveryHealth({
      checkedAt: options.checkedAt,
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source,
      apiStatus: source.apiStatus,
    }).record;
    expect(record.mergeQualification).toMatchObject({
      sampleCount: 1,
      candidateCount: 1,
      counts: { success: 1 },
      stagingCatchCount: 1,
      orphanCount: 0,
      providerHeadroom: { sampleCount: 1, latestHeadroomRuns: 3 },
      evidence: { complete: true },
    });
  });

  it("drives the recorded real empty-pull run identity through the scheduled collector and causal join", async () => {
    const realFixture = JSON.parse(
      readFileSync(
        path.join(
          repoRoot,
          "scripts/fixtures/merge-qualification/real-successful-merge-group-empty-actions-pulls.json",
        ),
        "utf8",
      ),
    );
    expect(realFixture.run.pull_requests).toEqual([]);
    const associated = realFixture.associatedPullRequestPages[0][0];
    const eventRunId = 30000000001;
    const releaseRunId = 30000000002;
    const event = qualificationEvent({
      workflowId: "1",
      parentWorkflowId: String(realFixture.run.workflow_id),
      parentRunId: String(realFixture.run.id),
      parentRunAttempt: String(realFixture.run.run_attempt),
      candidateSha: realFixture.run.head_sha,
      candidateTreeSha: realFixture.run.head_commit.tree_id,
      startedAt: "2026-07-22T01:27:00.000Z",
      completedAt: "2026-07-22T01:30:00.000Z",
      runId: String(eventRunId),
      evidenceLinks: [`https://github.com/chase-sets/chase-sets/actions/runs/${eventRunId}/attempts/1`],
    });
    const release = {
      ...stagingHealthRecord,
      releaseCommit: realFixture.run.head_sha,
      pullRequest: { number: associated.number },
      queue: {
        mergeQualificationLineageVersion: "release-candidate-linkage/v1",
        candidateSha: realFixture.run.head_sha,
        candidateTreeSha: realFixture.run.head_commit.tree_id,
        candidateArtifactId: "40000000001",
        candidateArtifactName: `merge-qualification-candidate-${realFixture.run.id}-${realFixture.run.run_attempt}`,
        mergeGroupWorkflowId: String(realFixture.run.workflow_id),
        mergeGroupWorkflowPath: realFixture.run.path,
        candidateImageDigest: event.imageDigest,
        mergeGroupRunId: String(realFixture.run.id),
        mergeGroupRunAttempt: String(realFixture.run.run_attempt),
        mergeSha: realFixture.run.head_sha,
        mergeTreeSha: realFixture.run.head_commit.tree_id,
        lineageComplete: true,
        lineageReasons: [],
      },
      staging: { ...stagingHealthRecord.staging, completedAt: "2026-07-22T01:40:00.000Z" },
      releaseState: { transitions: [{ type: "promoted", imageDigest: event.imageDigest }] },
    };
    const source = await collectSourceData({
      options: { repository: options.repository, checkedAt: "2026-07-22T02:00:00.000Z" },
      policy,
      client: fakeClient({
        "/actions/workflows/platform-merge-qualification.yml/runs": () => ({
          workflow_runs: [
            {
              id: eventRunId,
              workflow_id: 1,
              path: ".github/workflows/platform-merge-qualification.yml",
              event: "workflow_run",
              status: "completed",
              display_title: `Merge Qualification merge_group ${realFixture.run.id}-${realFixture.run.run_attempt}`,
              conclusion: "success",
              head_sha: "d".repeat(40),
              run_attempt: 1,
              created_at: "2026-07-22T01:27:00.000Z",
              run_started_at: "2026-07-22T01:27:00.000Z",
              updated_at: "2026-07-22T01:31:00.000Z",
            },
          ],
        }),
        "/actions/workflows/platform-production.yml/runs": () => ({
          workflow_runs: [
            {
              id: releaseRunId,
              event: "workflow_dispatch",
              conclusion: "failure",
              run_attempt: 1,
              created_at: "2026-07-22T01:32:00.000Z",
              run_started_at: "2026-07-22T01:32:00.000Z",
              updated_at: "2026-07-22T01:41:00.000Z",
            },
          ],
        }),
        [`/actions/runs/${eventRunId}/artifacts`]: () => ({
          artifacts: [
            {
              id: 40000000002,
              name: `merge-qualification-events-${eventRunId}-1`,
              archive_download_url: "https://example.test/real-event-zip",
            },
          ],
        }),
        [`/actions/runs/${releaseRunId}/jobs`]: () => ({ jobs: [] }),
        [`/actions/runs/${releaseRunId}/artifacts`]: () => ({
          artifacts: [
            {
              id: 40000000003,
              name: `staging-release-health-${releaseRunId}`,
              archive_download_url: "https://example.test/real-release-zip",
            },
          ],
        }),
        "https://example.test/real-event-zip": () => buildZip([["event.json", JSON.stringify(event), 0]]),
        "https://example.test/real-release-zip": () =>
          buildZip([
            ["staging-release.json", JSON.stringify(release), 0],
            ["staging-deploy-root-cause.json", JSON.stringify(rootCauseRecord), 0],
          ]),
      }),
      queryStart: "2026-07-15T02:00:00.000Z",
    });
    expect(source.mergeQualification.failures).toEqual([]);
    expect(source.mergeQualification.candidates).toEqual([
      {
        parentRunId: String(realFixture.run.id),
        parentRunAttempt: String(realFixture.run.run_attempt),
        candidateSha: realFixture.run.head_sha,
        runId: String(eventRunId),
        runAttempt: "1",
      },
    ]);
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-22T02:00:00.000Z",
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source,
      apiStatus: source.apiStatus,
    }).record;
    expect(record.mergeQualification).toMatchObject({
      sampleCount: 1,
      stagingCatchCount: 1,
      orphanCount: 0,
      evidence: { complete: true },
    });
  });

  it("carries executable early-cancellation terminalization through the observer collector and canonical summary", async () => {
    const resolution = resolveRunTerminalization({
      runEvent: "workflow_run",
      runConclusion: "cancelled",
      runDisplayTitle: "Merge Qualification merge_group 8004-1",
      runId: "9004",
      runAttempt: "1",
      jobs: [],
      artifactNames: [],
      decision: null,
    });
    expect(resolution).toMatchObject({
      action: "terminalize",
      terminalState: "cancelled_evicted",
      reasonCodes: ["run_force_cancelled"],
    });
    const built = buildMergeQualificationEvent({
      repository: options.repository,
      workflowId: "1",
      workflowPath: ".github/workflows/platform-merge-qualification.yml",
      parentWorkflowId: "2",
      parentWorkflowPath: ".github/workflows/platform-pr.yml",
      parentRunId: "8004",
      parentRunAttempt: "1",
      candidateSha: null,
      candidateTreeSha: null,
      imageDigest: null,
      classifierClass: null,
      terminalState: resolution.terminalState,
      reasonCodes: resolution.reasonCodes,
      provisioned: false,
      startedAt: "2026-07-18T10:00:00.000Z",
      completedAt: "2026-07-18T10:01:00.000Z",
      runId: "9004",
      runAttempt: "1",
      evidenceLinks: ["https://github.com/chase-sets/chase-sets/actions/runs/9004/attempts/1"],
      providerHeadroom: null,
    });
    expect(built.errors).toEqual([]);
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient({
        "/actions/workflows/platform-merge-qualification.yml/runs": () => ({
          workflow_runs: [
            {
              id: 9004,
              workflow_id: 1,
              path: ".github/workflows/platform-merge-qualification.yml",
              event: "workflow_run",
              status: "completed",
              display_title: "Merge Qualification merge_group 8004-1",
              conclusion: "cancelled",
              run_attempt: 1,
              updated_at: iso(100),
            },
          ],
        }),
        "/actions/workflows/platform-merge-qualification-terminalizer.yml/runs": () => ({
          workflow_runs: [
            { id: 9204, event: "workflow_run", status: "completed", conclusion: "success", run_attempt: 1 },
          ],
        }),
        "/actions/workflows/platform-production.yml/runs": () => ({ workflow_runs: [] }),
        "/actions/runs/9004/artifacts": () => ({ artifacts: [] }),
        "/actions/runs/9204/artifacts": () => ({
          artifacts: [
            {
              id: 24,
              name: "merge-qualification-terminal-9004-1",
              archive_download_url: "https://example.test/terminal-event-zip",
            },
          ],
        }),
        "https://example.test/terminal-event-zip": () => buildZip([["event.json", JSON.stringify(built.event), 0]]),
      }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(source.mergeQualification).toMatchObject({
      events: [built.event],
      candidates: [
        {
          parentRunId: "8004",
          parentRunAttempt: "1",
          runId: "9004",
          runAttempt: "1",
          candidateSha: null,
        },
      ],
      failures: [],
    });
    const record = buildDeliveryHealth({
      checkedAt: options.checkedAt,
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source,
      apiStatus: source.apiStatus,
    }).record;
    expect(record.mergeQualification).toMatchObject({
      candidateCount: 1,
      sampleCount: 1,
      counts: { cancellation: 1 },
      evidence: { complete: true },
    });
  });

  it("joins production metadata collected from a distinct same-tree merge candidate to its final main commit", async () => {
    const queueBaseSha = "4".repeat(40);
    const pullHeadSha = "5".repeat(40);
    const mergeGroupRun = {
      id: 8000,
      run_attempt: 1,
      workflow_id: 2,
      event: "merge_group",
      path: ".github/workflows/platform-pr.yml",
      status: "completed",
      conclusion: "success",
      head_sha: candidateSha,
      pull_requests: [],
      head_commit: { id: candidateSha, tree_id: candidateTree },
      repository: { full_name: "chase-sets/chase-sets" },
      created_at: "2026-07-18T10:00:00Z",
      updated_at: "2026-07-18T10:20:00Z",
    };
    const candidateRecord = buildMergeQualificationCandidate({
      repository: "chase-sets/chase-sets",
      workflowId: "2",
      workflowPath: ".github/workflows/platform-pr.yml",
      runId: "8000",
      runAttempt: "1",
      queueBaseSha,
      pullRequests: [{ number: 5839, headSha: pullHeadSha }],
      candidateSha,
      candidateTreeSha: candidateTree,
      builtImageDigest: passedEvent.imageDigest,
      capturedAt: "2026-07-18T10:10:00Z",
    }).record;
    const responses = new Map([
      [`/repos/chase-sets/chase-sets/commits/${mainSha}/pulls`, [{ number: 5839 }]],
      [
        "/repos/chase-sets/chase-sets/pulls/5839",
        {
          number: 5839,
          created_at: "2026-07-18T09:00:00Z",
          draft: false,
          merged_at: "2026-07-18T10:30:00Z",
          merge_commit_sha: mainSha,
          base: { sha: queueBaseSha },
          head: { sha: pullHeadSha },
        },
      ],
      ["/repos/chase-sets/chase-sets/pulls/5839/reviews?per_page=100", []],
      [
        "/repos/chase-sets/chase-sets/issues/5839/timeline?per_page=100",
        [{ event: "added_to_merge_queue", created_at: "2026-07-18T09:50:00Z" }],
      ],
      [
        "/repos/chase-sets/chase-sets/actions/workflows/platform-pr.yml/runs?event=merge_group&per_page=100&page=1",
        {
          total_count: 1,
          workflow_runs: [mergeGroupRun],
        },
      ],
      [
        "/repos/chase-sets/chase-sets/actions/runs/8000/artifacts?per_page=100&page=1",
        {
          total_count: 1,
          artifacts: [
            {
              id: 18000,
              name: "merge-qualification-candidate-8000-1",
              expired: false,
              archive_download_url: "https://example.test/candidate-zip",
            },
          ],
        },
      ],
      [
        `/repos/chase-sets/chase-sets/commits/${candidateSha}/pulls?per_page=100`,
        [
          {
            number: 5839,
            merge_commit_sha: candidateSha,
            base: { sha: queueBaseSha },
            head: { sha: pullHeadSha },
          },
        ],
      ],
      [`/repos/chase-sets/chase-sets/git/commits/${mainSha}`, { tree: { sha: candidateTree } }],
      ["/repos/chase-sets/chase-sets/rules/branches/main?per_page=100", []],
    ]);
    const metadata = await collectReleaseHealthGithubMetadata(
      { repository: "chase-sets/chase-sets", releaseCommit: mainSha, token: "fixture" },
      {
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          if (parsed.href === "https://example.test/candidate-zip") {
            return new Response(buildZip([["candidate.json", JSON.stringify(candidateRecord), 8]]), { status: 200 });
          }
          const key = parsed.pathname + parsed.search;
          if (!responses.has(key)) throw new Error(`no production metadata fixture route for ${key}`);
          return new Response(JSON.stringify(responses.get(key)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    expect(metadata).toMatchObject({
      candidateSha,
      candidateTreeSha: candidateTree,
      candidateArtifactId: "18000",
      candidateArtifactName: "merge-qualification-candidate-8000-1",
      mergeGroupWorkflowId: "2",
      mergeGroupWorkflowPath: ".github/workflows/platform-pr.yml",
      candidateImageDigest: passedEvent.imageDigest,
      mergeGroupRunId: "8000",
      mergeGroupRunAttempt: "1",
      mergeSha: mainSha,
      mergeTreeSha: candidateTree,
      lineageComplete: true,
      lineageReasons: [],
    });
    expect(metadata.candidateSha).not.toBe(metadata.mergeSha);

    const productionRecord = {
      ...stagingHealthRecord,
      pullRequest: { number: metadata.pullRequestNumber },
      queue: {
        mergeQualificationLineageVersion: "release-candidate-linkage/v1",
        candidateSha: metadata.candidateSha,
        candidateTreeSha: metadata.candidateTreeSha,
        candidateArtifactId: metadata.candidateArtifactId,
        candidateArtifactName: metadata.candidateArtifactName,
        mergeGroupWorkflowId: metadata.mergeGroupWorkflowId,
        mergeGroupWorkflowPath: metadata.mergeGroupWorkflowPath,
        candidateImageDigest: metadata.candidateImageDigest,
        mergeGroupRunId: metadata.mergeGroupRunId,
        mergeGroupRunAttempt: metadata.mergeGroupRunAttempt,
        mergeSha: metadata.mergeSha,
        mergeTreeSha: metadata.mergeTreeSha,
        lineageComplete: metadata.lineageComplete,
        lineageReasons: metadata.lineageReasons,
      },
    };
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient({
        "https://example.test/release-zip": () =>
          buildZip([
            ["staging-release.json", JSON.stringify(productionRecord), 0],
            ["staging-deploy-root-cause.json", JSON.stringify(rootCauseRecord), 0],
          ]),
      }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    const record = buildDeliveryHealth({
      checkedAt: options.checkedAt,
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source,
      apiStatus: source.apiStatus,
    }).record;
    expect(record.mergeQualification).toMatchObject({ sampleCount: 1, stagingCatchCount: 1, orphanCount: 0 });
  });

  it("keeps candidates distinct across a shared default SHA, rerun lineage, and current-main movement", async () => {
    const second = qualificationEvent({
      parentRunId: "8001",
      runId: "9002",
      candidateSha: "c".repeat(40),
      candidateTreeSha: "d".repeat(40),
    });
    const third = qualificationEvent({
      parentRunId: "8002",
      runId: "9003",
      candidateSha: "e".repeat(40),
      candidateTreeSha: "f".repeat(40),
    });
    const advisoryRun = (id, parent, defaultSha) => ({
      id,
      workflow_id: 1,
      path: ".github/workflows/platform-merge-qualification.yml",
      event: "workflow_run",
      status: "completed",
      display_title: `Merge Qualification merge_group ${parent}-1`,
      conclusion: "success",
      head_sha: defaultSha,
      run_attempt: 1,
      created_at: iso(120),
      run_started_at: iso(119),
      updated_at: iso(100),
    });
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient({
        "/actions/workflows/platform-merge-qualification.yml/runs": () => ({
          workflow_runs: [
            advisoryRun(9001, 8000, "9".repeat(40)),
            advisoryRun(9002, 8001, "9".repeat(40)),
            advisoryRun(9003, 8002, "8".repeat(40)),
          ],
        }),
        "/actions/runs/9002/artifacts": () => ({
          artifacts: [
            {
              id: 22,
              name: "merge-qualification-events-9002-1",
              archive_download_url: "https://example.test/event-2-zip",
            },
          ],
        }),
        "/actions/runs/9003/artifacts": () => ({
          artifacts: [
            {
              id: 23,
              name: "merge-qualification-events-9003-1",
              archive_download_url: "https://example.test/event-3-zip",
            },
          ],
        }),
        "https://example.test/event-2-zip": () => buildZip([["event.json", JSON.stringify(second), 0]]),
        "https://example.test/event-3-zip": () => buildZip([["event.json", JSON.stringify(third), 0]]),
      }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(source.mergeQualification.events).toHaveLength(3);
    expect(source.mergeQualification.candidates.map((candidate) => candidate.candidateSha)).toEqual([
      candidateSha,
      second.candidateSha,
      third.candidateSha,
    ]);
    expect(new Set(source.mergeQualification.candidates.map((candidate) => candidate.parentRunId))).toEqual(
      new Set(["8000", "8001", "8002"]),
    );
  });

  it("negative control: a failed or malformed qualification artifact degrades completeness and orphans the candidate", async () => {
    const failing = await collectSourceData({
      options,
      policy,
      client: fakeClient({ "https://example.test/event-zip": () => new Error("artifact download failed") }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(failing.mergeQualification.events).toEqual([]);
    expect(failing.mergeQualification.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "merge-qualification-artifacts:9001" }),
        expect.objectContaining({ source: "merge-qualification-completed-attempt:9001:1" }),
      ]),
    );
    const record = buildDeliveryHealth({
      checkedAt: options.checkedAt,
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source: failing,
      apiStatus: failing.apiStatus,
    }).record;
    expect(record.completeness.status).toBe("partial");
    expect(record.completeness.reasons).toContain("merge-qualification:merge-qualification-artifacts:9001");
    expect(record.mergeQualification.orphanCount).toBe(1);

    const foreignSchema = await collectSourceData({
      options,
      policy,
      client: fakeClient({
        "https://example.test/event-zip": () =>
          buildZip([["event.json", JSON.stringify({ schemaVersion: "merge-qualification-event/v2" }), 0]]),
      }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(foreignSchema.mergeQualification.events).toEqual([]);
    expect(foreignSchema.mergeQualification.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "merge-qualification-artifacts:9001" }),
        expect.objectContaining({ source: "merge-qualification-completed-attempt:9001:1" }),
      ]),
    );

    const missingEventJson = await collectSourceData({
      options,
      policy,
      client: fakeClient({
        "https://example.test/event-zip": () => buildZip([["other.json", JSON.stringify(passedEvent), 0]]),
      }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(missingEventJson.mergeQualification.events).toEqual([]);
    expect(missingEventJson.mergeQualification.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "merge-qualification-artifacts:9001" }),
        expect.objectContaining({ source: "merge-qualification-completed-attempt:9001:1" }),
      ]),
    );
  });

  it("negative control: candidate=1/event=0 stays visible and partial", async () => {
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient({ "/actions/runs/9001/artifacts": () => ({ artifacts: [] }) }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    const result = buildDeliveryHealth({
      checkedAt: options.checkedAt,
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source,
      apiStatus: source.apiStatus,
    });
    expect(result.record.mergeQualification).toMatchObject({
      candidateCount: 1,
      sampleCount: 0,
      orphanCount: 1,
      evidence: { missingTerminalCount: 1, complete: false },
    });
    expect(result.record.completeness.status).toBe("partial");
    expect(result.markdown).toContain("### Merge qualification (advisory)");
  });

  it("keeps a valid exact default-off decision provider-inert and outside candidate inventory", async () => {
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient({
        "/actions/runs/9001/artifacts": () => ({
          artifacts: [
            {
              id: 3,
              name: "merge-qualification-decision-9001-1",
              archive_download_url: "https://example.test/decision-zip",
            },
          ],
        }),
        "https://example.test/decision-zip": () => buildZip([["decision.json", JSON.stringify(disabledDecision), 0]]),
      }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(source.mergeQualification).toMatchObject({ events: [], candidates: [], failures: [] });
    const result = buildDeliveryHealth({
      checkedAt: options.checkedAt,
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source,
      apiStatus: source.apiStatus,
    });
    expect(result.record.mergeQualification).toMatchObject({ candidateCount: 0, sampleCount: 0 });
    expect(result.markdown).not.toContain("### Merge qualification (advisory)");
  });

  it("accepts a candidate that differs from workflow_run.head_sha because the event is the causal proof", async () => {
    const differentHead = "f".repeat(40);
    const mismatched = {
      ...passedEvent,
      candidateSha: differentHead,
      gateCandidateSha: differentHead,
    };
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient({
        "https://example.test/event-zip": () => buildZip([["event.json", JSON.stringify(mismatched), 0]]),
      }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(source.mergeQualification.events).toEqual([mismatched]);
    expect(source.mergeQualification.candidates).toEqual([
      { parentRunId: "8000", parentRunAttempt: "1", candidateSha: differentHead, runId: "9001", runAttempt: "1" },
    ]);
    expect(source.mergeQualification.failures).toEqual([]);
  });

  it("negative control: old-attempt event cannot satisfy a missing latest attempt", async () => {
    const latestRun = {
      id: 9001,
      workflow_id: 1,
      path: ".github/workflows/platform-merge-qualification.yml",
      event: "workflow_run",
      status: "completed",
      display_title: "Merge Qualification merge_group 8000-2",
      conclusion: "success",
      head_sha: "e".repeat(40),
      run_attempt: 2,
      created_at: iso(120),
      run_started_at: iso(119),
      updated_at: iso(100),
    };
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient({
        "/actions/workflows/platform-merge-qualification.yml/runs": () => ({ workflow_runs: [latestRun] }),
      }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    const record = buildDeliveryHealth({
      checkedAt: options.checkedAt,
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source,
      apiStatus: source.apiStatus,
    }).record;
    expect(record.mergeQualification).toMatchObject({ sampleCount: 0, orphanCount: 1 });
    expect(record.mergeQualification.evidence).toMatchObject({
      missingTerminalCount: 1,
      orphanEventCount: 0,
      complete: false,
    });
    expect(record.completeness.status).toBe("partial");
  });

  it("ratchets merge-lineage only for explicitly eligible release-health records in one mixed rolling window", async () => {
    const { mergeQualificationLineageVersion: _legacyAbsent, ...legacyQueue } = stagingHealthRecord.queue;
    const preRollout = {
      ...stagingHealthRecord,
      releaseCommit: "2".repeat(40),
      queue: {
        batchSize: 1,
        mergeSha: "2".repeat(40),
        mergeTreeSha: "6".repeat(40),
      },
      staging: { ...stagingHealthRecord.staging, result: "success", completedAt: "2026-07-18T10:45:00.000Z" },
      releaseState: { transitions: [{ type: "promoted", imageDigest: `sha256:${"6".repeat(64)}` }] },
    };
    expect(Object.hasOwn(preRollout.queue, "mergeQualificationLineageVersion")).toBe(false);
    expect(Object.hasOwn(legacyQueue, "mergeQualificationLineageVersion")).toBe(false);

    const correctlyLinked = stagingHealthRecord;
    const eligibleMalformed = {
      ...stagingHealthRecord,
      releaseCommit: "3".repeat(40),
      queue: { ...stagingHealthRecord.queue, candidateTreeSha: null, mergeSha: "3".repeat(40) },
      staging: { ...stagingHealthRecord.staging, completedAt: "2026-07-18T11:15:00.000Z" },
    };
    const run = (id, conclusion) => ({
      id,
      event: "workflow_dispatch",
      conclusion,
      run_attempt: 1,
      created_at: iso(90),
      run_started_at: iso(89),
      updated_at: iso(50),
    });
    const releaseRuns = [run(9100, "success"), run(9101, "failure"), run(9102, "failure")];
    const releaseArtifact = (id, url) => ({
      artifacts: [{ id, name: `staging-release-health-${id}`, archive_download_url: url }],
    });
    const client = fakeClient({
      "/actions/workflows/platform-production.yml/runs": () => ({ workflow_runs: releaseRuns }),
      "/actions/runs/9100/jobs": () => ({ jobs: [] }),
      "/actions/runs/9101/jobs": () => ({ jobs: [] }),
      "/actions/runs/9102/jobs": () => ({ jobs: [] }),
      "/actions/runs/9100/artifacts": () => releaseArtifact(10, "https://example.test/pre-rollout-release"),
      "/actions/runs/9101/artifacts": () => releaseArtifact(11, "https://example.test/linked-release"),
      "/actions/runs/9102/artifacts": () => releaseArtifact(12, "https://example.test/malformed-release"),
      "https://example.test/pre-rollout-release": () =>
        buildZip([["staging-release.json", JSON.stringify(preRollout), 0]]),
      "https://example.test/linked-release": () =>
        buildZip([
          ["staging-release.json", JSON.stringify(correctlyLinked), 0],
          ["staging-deploy-root-cause.json", JSON.stringify(rootCauseRecord), 0],
        ]),
      "https://example.test/malformed-release": () =>
        buildZip([["staging-release.json", JSON.stringify(eligibleMalformed), 0]]),
    });
    const source = await collectSourceData({
      options,
      policy,
      client,
      queryStart: "2026-07-11T12:00:00.000Z",
    });

    expect(source.mergeQualification.releases).toHaveLength(1);
    expect(source.mergeQualification.releases[0]).toMatchObject({
      mainSha,
      causalBridge: { lineageVersion: "release-candidate-linkage/v1", lineageComplete: true },
    });
    // The legacy release is intentionally absent from both releases and
    // failures. Only the explicitly eligible malformed release fails closed.
    expect(source.mergeQualification.failures).toEqual([
      { source: "release-identity:9102", error: "unusable staging release identity" },
    ]);
    const partial = buildDeliveryHealth({
      checkedAt: options.checkedAt,
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source,
      apiStatus: source.apiStatus,
    }).record;
    expect(partial.completeness.reasons).toContain("merge-qualification:release-identity:9102");
    expect(partial.completeness.reasons).not.toContain("merge-qualification:release-identity:9100");
    expect(partial.slis.every((sli) => sli.status === "insufficient-data")).toBe(true);

    const withoutMalformed = {
      ...source,
      deployRuns: source.deployRuns.filter((entry) => entry.id !== 9102),
      mergeQualification: { ...source.mergeQualification, failures: [] },
    };
    const complete = buildDeliveryHealth({
      checkedAt: options.checkedAt,
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source: withoutMalformed,
      apiStatus: source.apiStatus,
    }).record;
    expect(complete.completeness).toMatchObject({ status: "complete", reasons: [] });
    expect(complete.slis.find((sli) => sli.id === "open-mutation-circuit")?.status).toBe("passing");
  });

  it("negative control: incomplete production lineage excludes the release and degrades completeness", async () => {
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient({
        "https://example.test/release-zip": () =>
          buildZip([
            [
              "staging-release.json",
              JSON.stringify({
                ...stagingHealthRecord,
                queue: { ...stagingHealthRecord.queue, candidateTreeSha: null },
              }),
              0,
            ],
            ["staging-deploy-root-cause.json", JSON.stringify(rootCauseRecord), 0],
          ]),
      }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(source.mergeQualification.releases).toEqual([]);
    expect(source.mergeQualification.failures).toEqual([expect.objectContaining({ source: "release-identity:9101" })]);
    const record = buildDeliveryHealth({
      checkedAt: options.checkedAt,
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source,
      apiStatus: source.apiStatus,
    }).record;
    expect(record.completeness.status).toBe("partial");
    expect(record.completeness.reasons).toContain("merge-qualification:release-identity:9101");
    // Without a release identity the passed candidate reports superseded,
    // never a fabricated catch.
    expect(record.mergeQualification.stagingCatchCount).toBe(0);
    expect(record.mergeQualification.supersededCount).toBe(1);
  });
});

describe("release-health artifact archives", () => {
  it("reads only JSON entries from stored and deflated ZIP members", () => {
    const archive = buildZip([
      ["production-release.json", JSON.stringify({ schemaVersion: "release-health/v1" }), 8],
      ["notes.txt", "do not collect raw logs", 0],
      ["staging-release.json", JSON.stringify({ schemaVersion: "release-health/v1", staging: {} }), 0],
    ]);
    const entries = unzipJsonEntries(archive);
    expect([...entries.keys()]).toEqual(["production-release.json", "staging-release.json"]);
    expect(JSON.parse(entries.get("production-release.json").toString("utf8"))).toEqual({
      schemaVersion: "release-health/v1",
    });
  });
});

function representativeSource() {
  const pulls = Array.from({ length: 12 }, (_, index) => ({
    number: index + 1,
    state: index < 10 ? "MERGED" : "OPEN",
    createdAt: iso(index * 60 + 60),
    updatedAt: iso(index * 60 + 50),
    readyForReviewAt: iso(index * 60 + 55),
    mergedAt: index < 10 ? iso(index * 60 + 30) : null,
    changedFiles: index + 1,
    reviewCount: 1,
    approvedReviewCount: index % 2,
    files: [
      { path: `scripts/change-${index}.mjs`, additions: index + 1, deletions: index + 1 },
      { path: "pnpm-lock.yaml", additions: 1000, deletions: 1000 },
    ],
  }));
  const pullRequestRuns = Array.from({ length: 12 }, (_, index) =>
    run(100 + index, "pull_request", index < 9 ? "success" : index === 9 ? "success" : "failure", {
      run_attempt: index === 9 ? 2 : 1,
      jobs: index >= 10 ? [failedJob("Unit Tests", "Run unit tests")] : [],
    }),
  );
  const mergeGroupRuns = Array.from({ length: 20 }, (_, index) =>
    run(200 + index, "merge_group", index < 19 ? "success" : "failure", {
      jobs: index === 19 ? [failedJob("E2E Tests", "Run Playwright")] : [],
    }),
  );
  const dispatchRuns = Array.from({ length: 3 }, (_, index) => run(300 + index, "push", "success"));
  const successfulReleases = Array.from({ length: 9 }, (_, index) =>
    run(400 + index, "workflow_dispatch", "success", {
      jobs: [stageJob("Deploy Staging", "success", index), stageJob("Deploy Production", "success", index)],
      releaseArtifacts: [releaseRecord("success", { index })],
    }),
  );
  const failedRelease = run(410, "workflow_dispatch", "failure", {
    jobs: [stageJob("Deploy Staging", "failure", 10), stageJob("Deploy Production", "skipped", 10)],
    releaseArtifacts: [
      releaseRecord("failure", {
        index: 10,
        stagingResult: "failure",
        stagingApplied: false,
        productionResult: "skipped",
      }),
    ],
  });
  const coalescedRelease = run(411, "workflow_dispatch", "cancelled", {
    jobs: [stageJob("Resolve Release", "success", 11)],
    releaseArtifacts: [
      {
        ...releaseRecord("cancelled", {
          index: 11,
          stagingResult: "skipped",
          stagingApplied: false,
          productionResult: "skipped",
        }),
        attempt: { result: "cancelled", phase: "staging", reason: "superseded-pre-mutation" },
      },
    ],
  });
  const ephemeralRuns = [
    ...Array.from({ length: 19 }, (_, index) =>
      run(500 + index, "workflow_run", "success", { jobs: [ephemeralJob("success")] }),
    ),
    run(520, "workflow_run", "failure", { jobs: [ephemeralJob("failure")] }),
    run(521, "workflow_run", "success", { jobs: [ephemeralJob("skipped")] }),
  ];
  return {
    pulls,
    platformPrRuns: [...pullRequestRuns, ...mergeGroupRuns],
    deployRuns: [...dispatchRuns, ...successfulReleases, failedRelease, coalescedRelease],
    ephemeralRuns,
    circuits: [
      {
        schemaVersion: "delivery-failure-signature/v1",
        signature: "dns-signature",
        lane: "staging",
        rootCauseCode: "staging-dns",
        state: "holding",
        occurrenceCount: 2,
        firstObservedAt: iso(180),
        lastObservedAt: iso(120),
        canonicalIssueNumber: 5500,
        canonicalIssueCreatedAt: iso(118),
        observations: [
          { observedAt: iso(180), candidateSha: "a".repeat(40) },
          { observedAt: iso(120), candidateSha: "b".repeat(40) },
        ],
      },
      {
        schemaVersion: "delivery-failure-signature/v1",
        signature: "recovered-signature",
        lane: "merge-group",
        rootCauseCode: "unknown",
        state: "recovered",
        occurrenceCount: 3,
        firstObservedAt: iso(90),
        lastObservedAt: iso(80),
        recoveredAt: iso(80),
        observations: [],
      },
    ],
    artifactFailures: [],
  };
}

// Fully valid merge-qualification-event/v1 fixture: the canonical reader now
// validates every event, so partial shapes would land in the invalid bucket.
function qualificationEvent(overrides = {}) {
  const terminalState = overrides.terminalState ?? "passed";
  const candidateSha = overrides.candidateSha ?? "a".repeat(40);
  const candidateTreeSha = overrides.candidateTreeSha ?? "b".repeat(40);
  const imageDigest = overrides.imageDigest === undefined ? `sha256:${"3".repeat(64)}` : overrides.imageDigest;
  const runId = overrides.runId ?? "9001";
  const parentRunId = overrides.parentRunId ?? String(BigInt(runId) - 1001n);
  const candidateLevel = ["passed", "failed"].includes(terminalState);
  const { event, errors } = buildMergeQualificationEvent({
    repository: "chase-sets/chase-sets",
    workflowId: "1",
    workflowPath: ".github/workflows/platform-merge-qualification.yml",
    parentWorkflowId: "2",
    parentWorkflowPath: ".github/workflows/platform-pr.yml",
    parentRunId,
    parentRunAttempt: overrides.parentRunAttempt ?? "1",
    candidateSha,
    candidateTreeSha,
    imageDigest,
    builtImageDigest: candidateLevel ? imageDigest : null,
    gateCandidateSha: candidateLevel ? candidateSha : null,
    gateCandidateTreeSha: candidateLevel ? candidateTreeSha : null,
    classifierClass: "isolated",
    terminalState,
    reasonCodes: ["gate_passed"],
    provisioned: ["passed", "failed", "cancelled_evicted"].includes(overrides.terminalState ?? "passed"),
    startedAt: "2026-07-18T10:00:00.000Z",
    completedAt: "2026-07-18T10:20:00.000Z",
    runId,
    runAttempt: "1",
    evidenceLinks: ["https://github.com/chase-sets/chase-sets/actions/runs/9001/attempts/1"],
    providerHeadroom: null,
    ...overrides,
  });
  if (errors.length > 0) throw new Error(`invalid qualification event fixture: ${errors.join("; ")}`);
  return event;
}

function candidateFor(event) {
  return {
    parentRunId: event.parentRunId,
    parentRunAttempt: event.parentRunAttempt,
    candidateSha: event.candidateSha,
    runId: event.runId,
    runAttempt: event.runAttempt,
  };
}

function causalBridgeFor(event, pullRequestNumber = 5839, overrides = {}) {
  return {
    lineageVersion: "release-candidate-linkage/v1",
    pullRequestNumber,
    candidateArtifactId: "18000",
    candidateArtifactName: `merge-qualification-candidate-${event.parentRunId}-${event.parentRunAttempt}`,
    workflowId: event.parentWorkflowId,
    workflowPath: event.parentWorkflowPath,
    mergeGroupRunId: event.parentRunId,
    mergeGroupRunAttempt: event.parentRunAttempt,
    candidateImageDigest: event.imageDigest,
    lineageComplete: true,
    lineageReasons: [],
    ...overrides,
  };
}

function run(id, event, conclusion, overrides = {}) {
  return {
    id,
    event,
    conclusion,
    run_attempt: 1,
    created_at: iso(50),
    run_started_at: iso(49),
    updated_at: iso(40),
    jobs: [],
    releaseArtifacts: [],
    ...overrides,
  };
}

function releaseRecord(result, overrides = {}) {
  const index = overrides.index ?? 0;
  return {
    schemaVersion: "release-health/v1",
    attempt: { result, phase: "production", reason: "production-release" },
    staging: {
      result: overrides.stagingResult ?? "success",
      applied: overrides.stagingApplied ?? true,
      startedAt: iso(35 + index),
      completedAt: iso(30 + index),
    },
    production: {
      result: overrides.productionResult ?? result,
      startedAt: iso(25 + index),
      completedAt: iso(20 + index),
    },
    recovery: { mode: "none" },
  };
}

function failedJob(name, step) {
  return { name, conclusion: "failure", steps: [{ name: step, conclusion: "failure" }] };
}

function stageJob(name, conclusion, index) {
  return { name, conclusion, started_at: iso(35 + index), completed_at: iso(30 + index), steps: [] };
}

function ephemeralJob(conclusion) {
  return { name: "Verify Release in Ephemeral Namespace", conclusion, steps: [] };
}

function iso(minutesAgo) {
  return new Date(Date.parse("2026-07-18T12:00:00.000Z") - minutesAgo * 60_000).toISOString();
}

function sli(id, status) {
  return {
    id,
    status,
    severity: "p1",
    window: "rolling24h",
    value: 0.5,
    sample: 10,
    target: { operator: "gte", value: 0.9, minimumSample: 10 },
  };
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, text, method] of entries) {
    const nameBytes = Buffer.from(name);
    const contents = Buffer.from(text);
    const compressed = method === 8 ? deflateRawSync(contents) : contents;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
