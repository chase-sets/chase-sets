import { deflateRawSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { buildMergeQualificationDecision, buildMergeQualificationEvent } from "./merge-qualification-advisory.mjs";
import {
  DELIVERY_HEALTH_VERSION,
  buildDeliveryHealth,
  collectSourceData,
  createGitHubClient,
  normalizeDeliveryConclusion,
  parseSliMarker,
  percentileSummary,
  publishSliIssues,
  readDeliveryHealthPolicy,
  renderSliMarker,
  unzipJsonEntries,
} from "./release-health-delivery-health.mjs";

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
    await client.paginate("/issues?per_page=100", (value) => value, { source: "fixture" });
    expect(client.status().truncated).toEqual(["fixture"]);
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
        { candidateSha: passed.candidateSha, runId: passed.runId, runAttempt: passed.runAttempt },
        { candidateSha: failed.candidateSha, runId: failed.runId, runAttempt: failed.runAttempt },
        { candidateSha: notApplicable.candidateSha, runId: notApplicable.runId, runAttempt: notApplicable.runAttempt },
        { candidateSha: "9".repeat(40), runId: "9004", runAttempt: "1" },
      ],
      // No injected comparisons: the builder must execute the tree/digest/
      // time-safe join against these persistent-staging release identities.
      releases: [
        {
          candidateSha: passed.candidateSha,
          mainSha: "1".repeat(40),
          treeSha: "b".repeat(40),
          imageDigest: passed.imageDigest,
          completedAt: "2026-07-18T11:00:00.000Z",
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
      candidates: [{ candidateSha: passed.candidateSha, runId: passed.runId, runAttempt: passed.runAttempt }],
      releases: [
        {
          candidateSha: passed.candidateSha,
          mainSha: "1".repeat(40),
          treeSha: "b".repeat(40),
          imageDigest: passed.imageDigest,
          completedAt: "2026-07-18T09:00:00.000Z",
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
      candidates: [{ candidateSha: valid.candidateSha, runId: valid.runId, runAttempt: valid.runAttempt }],
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
    queue: { mergeSha: candidateSha },
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
            display_title: "Merge Qualification merge_group 8000-1",
            conclusion: "success",
            head_sha: candidateSha,
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
          { id: 9200, event: "workflow_run", conclusion: "success", run_attempt: 1, updated_at: iso(95) },
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

  it("collects qualification artifacts, the candidate inventory, staging identities, and executes the join end to end", async () => {
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient(),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(source.mergeQualification.events).toEqual([passedEvent]);
    expect(source.mergeQualification.candidates).toEqual([{ candidateSha, runId: "9001", runAttempt: "1" }]);
    expect(source.mergeQualification.failures).toEqual([]);
    expect(source.mergeQualification.releases).toEqual([
      {
        candidateSha,
        mainSha,
        treeSha: candidateTree,
        imageDigest: passedEvent.imageDigest,
        completedAt: "2026-07-18T11:00:00.000Z",
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

  it("negative control: a failed or malformed qualification artifact degrades completeness and orphans the candidate", async () => {
    const failing = await collectSourceData({
      options,
      policy,
      client: fakeClient({ "https://example.test/event-zip": () => new Error("artifact download failed") }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(failing.mergeQualification.events).toEqual([]);
    expect(failing.mergeQualification.failures).toEqual([
      expect.objectContaining({ source: "merge-qualification-artifacts:9001" }),
    ]);
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
    expect(foreignSchema.mergeQualification.failures).toEqual([
      expect.objectContaining({ source: "merge-qualification-artifacts:9001" }),
    ]);

    const missingEventJson = await collectSourceData({
      options,
      policy,
      client: fakeClient({
        "https://example.test/event-zip": () => buildZip([["other.json", JSON.stringify(passedEvent), 0]]),
      }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(missingEventJson.mergeQualification.events).toEqual([]);
    expect(missingEventJson.mergeQualification.failures).toEqual([
      expect.objectContaining({ source: "merge-qualification-artifacts:9001" }),
    ]);
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

  it("negative control: a valid event with a different head SHA is rejected by production binding", async () => {
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
    expect(source.mergeQualification.events).toEqual([]);
    expect(source.mergeQualification.candidates).toEqual([{ candidateSha, runId: "9001", runAttempt: "1" }]);
    expect(source.mergeQualification.failures).toEqual([
      expect.objectContaining({ source: "merge-qualification-artifacts:9001" }),
    ]);
  });

  it("negative control: old-attempt event cannot satisfy a missing latest attempt", async () => {
    const latestRun = {
      id: 9001,
      workflow_id: 1,
      path: ".github/workflows/platform-merge-qualification.yml",
      event: "workflow_run",
      display_title: "Merge Qualification merge_group 8000-2",
      conclusion: "success",
      head_sha: candidateSha,
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
      orphanEventCount: 1,
      complete: false,
    });
    expect(record.completeness.status).toBe("partial");
  });

  it("negative control: a failed release-tree resolution excludes the release and degrades completeness", async () => {
    const source = await collectSourceData({
      options,
      policy,
      client: fakeClient({ [`/git/commits/${mainSha}`]: () => new Error("commit lookup failed") }),
      queryStart: "2026-07-11T12:00:00.000Z",
    });
    expect(source.mergeQualification.releases).toEqual([]);
    expect(source.mergeQualification.failures).toEqual([
      expect.objectContaining({ source: `release-tree:${mainSha}` }),
    ]);
    const record = buildDeliveryHealth({
      checkedAt: options.checkedAt,
      publicationMode: "hourly",
      repository: options.repository,
      policy,
      source,
      apiStatus: source.apiStatus,
    }).record;
    expect(record.completeness.status).toBe("partial");
    expect(record.completeness.reasons).toContain(`merge-qualification:release-tree:${mainSha}`);
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
  const { event, errors } = buildMergeQualificationEvent({
    repository: "chase-sets/chase-sets",
    candidateSha: "a".repeat(40),
    candidateTreeSha: "b".repeat(40),
    imageDigest: `sha256:${"3".repeat(64)}`,
    classifierClass: "isolated",
    terminalState: "passed",
    reasonCodes: ["gate_passed"],
    provisioned: ["passed", "failed", "cancelled_evicted"].includes(overrides.terminalState ?? "passed"),
    startedAt: "2026-07-18T10:00:00.000Z",
    completedAt: "2026-07-18T10:20:00.000Z",
    runId: "9001",
    runAttempt: "1",
    evidenceLinks: ["https://github.com/chase-sets/chase-sets/actions/runs/9001/attempts/1"],
    providerHeadroom: null,
    ...overrides,
  });
  if (errors.length > 0) throw new Error(`invalid qualification event fixture: ${errors.join("; ")}`);
  return event;
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
