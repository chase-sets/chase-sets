import { deflateRawSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DELIVERY_HEALTH_VERSION,
  buildDeliveryHealth,
  collectDeliveryHealth,
  createGitHubClient,
  normalizeDeliveryConclusion,
  parseRepositoryVariablesAuthority,
  parseSliMarker,
  percentileSummary,
  publishSliIssues,
  readDeliveryHealthPolicy,
  readEphemeralVerificationArchive,
  renderSliMarker,
  unzipJsonEntries,
  validateEphemeralVerificationRecord,
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
    expect(percentileSummary([])).toEqual({ sampleCount: 0, p50: null, p90: null });
    expect(percentileSummary([10, 50, 20, 40, 30])).toEqual({ sampleCount: 5, p50: 30, p90: 50 });
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
    expect(current.releases.ephemeral).toMatchObject({
      automaticRuns: 20,
      manualRuns: 1,
      eligible: 20,
      success: 19,
      failure: 1,
      skipped: 0,
    });
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
      run(1_000 + index, "workflow_dispatch", "success", {
        updated_at: iso(index),
        jobs: [ephemeralJob("success")],
        verificationArtifact: verificationRecord({ workflowRunId: String(1_000 + index) }),
        artifactCollectionStatus: "collected",
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

  it("feeds normalized PR scope from the production collector's own per-pull file data, not an injected fixture", () => {
    const smallPull = {
      number: 9001,
      state: "OPEN",
      createdAt: iso(60),
      updatedAt: iso(50),
      changedFiles: 1,
      files: [{ path: "scripts/small-change.mjs", additions: 5, deletions: 2 }],
    };
    const largePull = {
      number: 9002,
      state: "OPEN",
      createdAt: iso(70),
      updatedAt: iso(65),
      changedFiles: 36,
      files: Array.from({ length: 36 }, (_, index) => ({
        path: `bounded-contexts/catalog/domain/f${index}.ts`,
        additions: 10,
        deletions: 0,
      })),
    };
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source: { pulls: [smallPull, largePull] },
      apiStatus: {},
    }).record;

    const prScope = record.windows.rolling24h.prs.prScope;
    expect(prScope.schemaVersion).toBe("pr-scope-policy/v1");
    expect(prScope.evaluated).toBe(2);
    expect(prScope.statusCounts).toEqual({ normal: 1, large: 1 });
    expect(prScope.normalizedFiles.p90).toBe(36);

    // A truncated pull's files are incomplete (not the real changed-file set)
    // and must be skipped rather than silently under-scoped.
    const withTruncation = structuredClone({ pulls: [smallPull, largePull] });
    withTruncation.pulls[1].filesTruncated = true;
    const truncatedRecord = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source: withTruncation,
      apiStatus: {},
    }).record;
    const truncatedScope = truncatedRecord.windows.rolling24h.prs.prScope;
    expect(truncatedScope.evaluated).toBe(1);
    expect(truncatedScope.skippedIncomplete).toBe(1);
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
    expect(record.slis.filter((sli) => sli.status === "insufficient-data").map((sli) => sli.id)).toEqual([
      "pull-request-ci-success",
      "merge-group-success",
      "actual-release-success",
      "pr-ci-p90",
      "repeated-failure-detection",
    ]);
    expect(record.slis.find((sli) => sli.id === "open-mutation-circuit").status).toBe("breaching");
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

describe("ephemeral verification release assurance", () => {
  it("closes the retained schema and requires bounded timezone-bearing evidence", () => {
    const valid = verificationRecord();
    expect(validateEphemeralVerificationRecord(valid)).toEqual(valid);
    for (const [name, candidate, error] of [
      ["top-level unknown", { ...valid, unknown: { nested: true } }, "closed schema mismatch"],
      ["nested unknown", { ...valid, workloads: [{ name: "platform-smoke", unknown: true }] }, "workloads"],
      ["date-only", { ...valid, checkedAt: "2026-07-18" }, "checkedAt"],
      ["malformed instant", { ...valid, checkedAt: "not-an-instant" }, "checkedAt"],
      ["out-of-range instant", { ...valid, checkedAt: "2200-01-01T00:00:00.000Z" }, "checkedAt"],
      [
        "missing discriminator",
        Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "trigger")),
        "missing=trigger",
      ],
      ["mutable image identity", { ...valid, imageDigest: "latest" }, "imageDigest"],
    ]) {
      expect(() => validateEphemeralVerificationRecord(candidate), name).toThrow(error);
    }
  });

  it("counts only artifact-proven automatic runs and round-trips their discriminator", () => {
    const source = {
      ephemeralRuns: [
        run(29_788_571_657, "workflow_dispatch", "failure", {
          head_branch: "codex/issue-5828",
          jobs: [ephemeralJob("failure")],
          verificationArtifact: verificationRecord({
            workflowRunId: "29788571657",
            trigger: "manual",
            producerRunId: null,
            producerRunAttempt: null,
            result: "failure",
            failurePhase: "provider-registration",
            persistentStagingResult: "not-applicable",
          }),
          artifactCollectionStatus: "collected",
        }),
        run(29_788_571_658, "workflow_dispatch", "success", {
          jobs: [ephemeralJob("success")],
          verificationArtifact: verificationRecord({ workflowRunId: "29788571658" }),
          artifactCollectionStatus: "collected",
        }),
      ],
    };
    const result = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    });
    expect(result.record.windows.rolling24h.releases.ephemeral).toMatchObject({
      automaticRuns: 1,
      manualRuns: 1,
      numerator: 1,
      denominator: 1,
    });
    const persisted = JSON.parse(JSON.stringify(result.record));
    expect(persisted.query.sourceRuns.ephemeralVerification).toContainEqual(
      expect.objectContaining({
        id: 29_788_571_658,
        trigger: "automatic",
        producerRunId: "400",
        producerRunAttempt: "1",
      }),
    );
    expect(result.markdown).toContain("1 automatic runs; 1 manual proofs");
  });

  it("keeps pending-timeout failures out of the numerator and retains rerun identity", () => {
    const source = {
      ephemeralRuns: [
        run(700, "workflow_dispatch", "failure", {
          jobs: [ephemeralJob("failure")],
          verificationArtifact: verificationRecord({
            workflowRunId: "700",
            result: "failure",
            failurePhase: "promoted-release-handoff-pending-timeout",
            imageRepository: null,
            imageDigest: null,
            releaseCommit: null,
            teardownResult: "not-required",
          }),
          artifactCollectionStatus: "collected",
        }),
        run(701, "workflow_dispatch", "success", {
          run_attempt: 2,
          jobs: [ephemeralJob("success")],
          verificationArtifact: verificationRecord({ workflowRunId: "701", workflowRunAttempt: "2" }),
          artifactCollectionStatus: "collected",
        }),
      ],
    };
    const ephemeral = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    }).record.windows.rolling24h.releases.ephemeral;
    expect(ephemeral).toMatchObject({
      numerator: 1,
      denominator: 2,
      failure: 1,
      outcomes: { "retry-pass/flake": 1, "deterministic-failure": 1 },
    });
  });

  it("windows all counts and separates inferred displacement from other cancellation", () => {
    const source = {
      ephemeralRuns: [
        run(800, "workflow_dispatch", "cancelled", {
          created_at: iso(80),
          run_started_at: iso(79),
          updated_at: iso(60),
          jobs: [ephemeralJob("cancelled")],
          verificationArtifact: verificationRecord({
            workflowRunId: "800",
            result: "failure",
            failurePhase: "workflow-cancelled-or-setup",
          }),
          artifactCollectionStatus: "collected",
        }),
        run(801, "workflow_dispatch", "success", {
          created_at: iso(70),
          updated_at: iso(50),
          jobs: [ephemeralJob("success")],
          verificationArtifact: verificationRecord({ workflowRunId: "801" }),
          artifactCollectionStatus: "collected",
        }),
        run(802, "workflow_dispatch", "cancelled", {
          created_at: iso(40),
          run_started_at: iso(39),
          updated_at: iso(30),
          jobs: [ephemeralJob("cancelled")],
          verificationArtifact: verificationRecord({
            workflowRunId: "802",
            result: "failure",
            failurePhase: "workflow-cancelled-or-setup",
          }),
          artifactCollectionStatus: "collected",
        }),
        run(803, "workflow_dispatch", "success", {
          updated_at: iso(1_500),
          jobs: [ephemeralJob("success")],
          verificationArtifact: verificationRecord({ workflowRunId: "803" }),
          artifactCollectionStatus: "collected",
        }),
      ],
    };
    const ephemeral = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
    }).record.windows.rolling24h.releases.ephemeral;
    expect(ephemeral).toMatchObject({
      automaticRuns: 3,
      displaced: 1,
      cancelledOther: 1,
      numerator: 1,
      denominator: 2,
    });
  });

  it("collects the discriminator through artifact discovery and fails completeness when the payload is omitted", async () => {
    const archive = buildZip([
      [
        "ephemeral-verification/ephemeral-verification.json",
        JSON.stringify(verificationRecord({ workflowRunId: "900" })),
        8,
      ],
    ]);
    const collect = async (withArtifact) =>
      collectDeliveryHealth(
        {
          repository: "chase-sets/chase-sets",
          checkedAt: "2026-07-18T12:00:00.000Z",
          publicationMode: "hourly",
          ephemeralProducerState: "enabled",
          updateIssues: false,
          fetchImpl: async () => new Response(),
        },
        { policy, client: collectorClient({ archive, withArtifact }) },
      );

    const collected = await collect(true);
    expect(collected.record.windows.rolling24h.releases.ephemeral).toMatchObject({ numerator: 1, denominator: 1 });
    expect(collected.record.query.sourceRuns.ephemeralVerification).toContainEqual(
      expect.objectContaining({ id: 900, trigger: "automatic", artifactCollectionStatus: "collected" }),
    );

    const omitted = await collect(false);
    expect(omitted.record.completeness.reasons).toContain("missing-ephemeral-evidence:900");
    expect(omitted.record.slis.find((sli) => sli.id === "ephemeral-verification-success")).toMatchObject({
      status: "insufficient-data",
      reasons: [{ reasonCode: "artifact-missing", reasonSource: "run:900" }],
    });
    expect(omitted.record.slis.find((sli) => sli.id === "open-mutation-circuit").status).toBe("passing");
  });

  it("reads the canonical record without rejecting a large sibling payload", () => {
    const archive = buildZip([
      ["ephemeral-verification/ephemeral-verification.json", JSON.stringify(verificationRecord()), 8],
      ["ephemeral-verification/representative-commerce-state.json", `{"padding":"${"x".repeat(11 * 1024 * 1024)}"}`, 0],
    ]);
    const entries = unzipJsonEntries(archive, {
      include: (name) => name.endsWith("ephemeral-verification.json"),
      maxEntryBytes: 256 * 1024,
    });
    expect([...entries.keys()]).toEqual(["ephemeral-verification/ephemeral-verification.json"]);
  });

  it("rejects an artifact directory whose canonical payload is absent or malformed", () => {
    expect(() => readEphemeralVerificationArchive(buildZip([["notes.json", "{}", 0]]), 91)).toThrow(
      "ephemeral-verification-canonical-payload-absent: artifact 91",
    );
    expect(() =>
      readEphemeralVerificationArchive(
        buildZip([["ephemeral-verification/ephemeral-verification.json", "{not-json", 0]]),
        92,
      ),
    ).toThrow("ephemeral-verification-canonical-payload-malformed: artifact 92");
  });
});

describe("canonical SLI issues", () => {
  it("round-trips hidden markers and updates one existing issue per SLI", async () => {
    const marker = renderSliMarker({ schemaVersion: "delivery-health-sli/v1", sli: "merge-group-success" });
    expect(parseSliMarker(marker)).toEqual({ schemaVersion: "delivery-health-sli/v1", sli: "merge-group-success" });

    const calls = [];
    const client = {
      request: async () =>
        new Response(
          JSON.stringify({
            total_count: 2,
            incomplete_results: false,
            items: [
              { number: 55, state: "open", body: marker },
              { number: 56, state: "open", body: "not a machine issue" },
            ],
          }),
        ),
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

    expect(updates).toEqual({
      status: "complete",
      reasons: [],
      actions: [
        { sli: "merge-group-success", action: "updated", issueNumber: 55 },
        { sli: "actual-release-success", action: "created", issueNumber: 57 },
      ],
    });
    expect(calls.map((call) => call.path)).toEqual(["/issues/55", "/issues"]);
    expect(parseSliMarker(calls[0].request.body.body)).toEqual({
      schemaVersion: "delivery-health-sli/v1",
      sli: "merge-group-success",
    });
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

describe("#7530 delivery-health alert contract", () => {
  it("pins the dated eight-target alert-control crosswalk", async () => {
    expect(Object.keys(policy.targets)).toEqual([
      "pull-request-ci-success",
      "merge-group-success",
      "actual-release-success",
      "ephemeral-verification-success",
      "pr-ci-p90",
      "creation-to-merge-p90",
      "repeated-failure-detection",
      "open-mutation-circuit",
    ]);
    expect(
      Object.fromEntries(
        Object.entries(policy.targets).map(([id, target]) => [
          id,
          {
            value: target.value,
            observedAt: target.baseline.observedAt,
            sourceWindow: target.baseline.sourceWindow,
            statistic: target.baseline.statistic,
            sample: target.baseline.sample,
            observedValue: target.baseline.observedValue,
            rounding: target.baseline.rounding,
          },
        ]),
      ),
    ).toEqual({
      "pull-request-ci-success": {
        value: 0.738,
        observedAt: "2026-08-30T03:20:23Z",
        sourceWindow: "rolling7d",
        statistic: "prs.platformPr.pullRequest.successRate",
        sample: { count: 84, numerator: 62, denominator: 84 },
        observedValue: 0.7380952380952381,
        rounding: "floor-4dp",
      },
      "merge-group-success": {
        value: 0.9428,
        observedAt: "2026-08-30T03:20:23Z",
        sourceWindow: "rolling7d",
        statistic: "prs.platformPr.mergeGroup.successRate",
        sample: { count: 35, numerator: 33, denominator: 35 },
        observedValue: 0.9428571428571428,
        rounding: "floor-4dp",
      },
      "actual-release-success": {
        value: 0.7857,
        observedAt: "2026-08-30T03:20:23Z",
        sourceWindow: "lastN",
        statistic: "releases.actual.successRate",
        sample: { count: 14, numerator: 11, denominator: 14 },
        observedValue: 0.7857142857142857,
        rounding: "floor-4dp",
      },
      "ephemeral-verification-success": {
        value: 0.95,
        observedAt: "2026-08-30T03:20:23Z",
        sourceWindow: "unavailable",
        statistic: "releases.ephemeral.successRate",
        sample: { count: 0, numerator: null, denominator: null },
        observedValue: null,
        rounding: "unavailable-preserve",
      },
      "pr-ci-p90": {
        value: 993,
        observedAt: "2026-08-30T03:20:23Z",
        sourceWindow: "rolling7d",
        statistic: "prs.platformPr.combined.executionSeconds.p90",
        sample: { count: 126, numerator: null, denominator: null },
        observedValue: 993,
        rounding: "exact-integer",
      },
      "creation-to-merge-p90": {
        value: 119829,
        observedAt: "2026-08-30T03:20:23Z",
        sourceWindow: "rolling7d",
        statistic: "prs.creationToMergeSeconds.p90",
        sample: { count: 31, numerator: null, denominator: null },
        observedValue: 119829,
        rounding: "exact-integer",
      },
      "repeated-failure-detection": {
        value: 0,
        observedAt: "2026-08-30T03:20:23Z",
        sourceWindow: "rolling7d",
        statistic: "failureSignatures.detectionSeconds.p90",
        sample: { count: 2, numerator: null, denominator: null },
        observedValue: 0,
        rounding: "exact-integer",
      },
      "open-mutation-circuit": {
        value: 0,
        observedAt: "2026-08-30T03:20:23Z",
        sourceWindow: "rolling24h",
        statistic: "failureSignatures.openMutationCircuitCount",
        sample: { count: 0, numerator: null, denominator: null },
        observedValue: 0,
        rounding: "exact-integer",
      },
    });
    expect(
      Object.fromEntries(
        Object.entries(policy.targets).map(([id, target]) => [
          id,
          {
            window: target.window,
            metric: target.metric,
            sampleMetric: target.sampleMetric,
            operator: target.operator,
            minimumSample: target.minimumSample,
            severity: target.severity,
            p0Below: target.p0Below ?? null,
            p0At: target.p0At ?? null,
          },
        ]),
      ),
    ).toEqual({
      "pull-request-ci-success": {
        window: "rolling24h",
        metric: "prs.platformPr.pullRequest.successRate",
        sampleMetric: "prs.platformPr.pullRequest.denominator",
        operator: "gte",
        minimumSample: 10,
        severity: "p1",
        p0Below: null,
        p0At: null,
      },
      "merge-group-success": {
        window: "rolling24h",
        metric: "prs.platformPr.mergeGroup.successRate",
        sampleMetric: "prs.platformPr.mergeGroup.denominator",
        operator: "gte",
        minimumSample: 10,
        severity: "p1",
        p0Below: null,
        p0At: null,
      },
      "actual-release-success": {
        window: "lastN",
        metric: "releases.actual.successRate",
        sampleMetric: "releases.actual.denominator",
        operator: "gte",
        minimumSample: 10,
        severity: "p1",
        p0Below: 0.5,
        p0At: null,
      },
      "ephemeral-verification-success": {
        window: "lastN",
        metric: "releases.ephemeral.successRate",
        sampleMetric: "releases.ephemeral.denominator",
        operator: "gte",
        minimumSample: 10,
        severity: "p1",
        p0Below: null,
        p0At: 0,
      },
      "pr-ci-p90": {
        window: "rolling24h",
        metric: "prs.platformPr.combined.executionSeconds.p90",
        sampleMetric: "prs.platformPr.combined.executionSeconds.sampleCount",
        operator: "lte",
        minimumSample: 10,
        severity: "p1",
        p0Below: null,
        p0At: null,
      },
      "creation-to-merge-p90": {
        window: "rolling7d",
        metric: "prs.creationToMergeSeconds.p90",
        sampleMetric: "prs.creationToMergeSeconds.sampleCount",
        operator: "lte",
        minimumSample: 10,
        severity: "p1",
        p0Below: null,
        p0At: null,
      },
      "repeated-failure-detection": {
        window: "rolling7d",
        metric: "failureSignatures.detectionSeconds.p90",
        sampleMetric: "failureSignatures.detectionSeconds.sampleCount",
        operator: "lte",
        minimumSample: 1,
        severity: "p1",
        p0Below: null,
        p0At: null,
      },
      "open-mutation-circuit": {
        window: "rolling24h",
        metric: "failureSignatures.openMutationCircuitCount",
        sampleMetric: "failureSignatures.sourceCount",
        operator: "eq",
        minimumSample: 0,
        severity: "p0",
        p0Below: null,
        p0At: null,
      },
    });
    expect(Object.values(policy.targets).map((target) => target.baseline.rationale)).toEqual([
      "The configured rolling24h window had 4 samples; rolling7d met minimumSample and observed 62 successes in 84 pass/fail outcomes.",
      "The configured rolling24h window had 4 samples; rolling7d met minimumSample and observed 33 successes in 35 pass/fail outcomes.",
      "The authoritative latest attempts in the configured lastN window observed 11 successes in 14 pass/fail release outcomes; 6 not-eligible decisions remained excluded.",
      "The automatic producer was disabled and supplied no eligible observation, so the existing dormant value is preserved without fabricating a sample.",
      "The configured rolling24h window had 8 samples; rolling7d met minimumSample and observed an exact nearest-rank p90 of 993 seconds.",
      "The configured rolling7d window met minimumSample and observed an exact nearest-rank p90 of 119829 seconds.",
      "The configured rolling7d window met minimumSample and observed an exact nearest-rank p90 of 0 seconds.",
      "The complete rolling24h failure-signature source was empty; minimumSample is 0 and the exact open-circuit count was 0.",
    ]);
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source: representativeSource(),
      apiStatus: {},
      ephemeralProducerState: "enabled",
    }).record;
    expect(record.policy.targets).toEqual(policy.targets);
    const mutants = [];
    const missingTarget = structuredClone(policy);
    delete missingTarget.targets["open-mutation-circuit"];
    mutants.push(missingTarget);
    for (const mutate of [
      (candidate) => (candidate.targets["pull-request-ci-success"].value = 0.9),
      (candidate) => (candidate.targets["pull-request-ci-success"].baseline.statistic = "wrong"),
      (candidate) => (candidate.targets["pull-request-ci-success"].baseline.sample.count = 83),
      (candidate) => (candidate.targets["pull-request-ci-success"].baseline.rounding = "exact-integer"),
      (candidate) => (candidate.targets["ephemeral-verification-success"].baseline.observedValue = 0),
    ]) {
      const candidate = structuredClone(policy);
      mutate(candidate);
      mutants.push(candidate);
    }
    for (const mutant of mutants) {
      await expect(
        collectDeliveryHealth(
          {
            repository: "chase-sets/chase-sets",
            checkedAt: "2026-07-18T12:00:00.000Z",
            publicationMode: "hourly",
            ephemeralProducerState: "disabled",
            updateIssues: false,
            fetchImpl: async () => new Response(),
          },
          { policy: mutant, source: {} },
        ),
      ).rejects.toThrow(/Policy/u);
    }
  });

  it("evaluates every configured target by its own eligibility contract", () => {
    const source = representativeSource();
    source.pulls[9].mergedAt = null;
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
      ephemeralProducerState: "disabled",
    }).record;
    expect(record.slis).toHaveLength(8);
    expect(new Set(record.slis.map((entry) => entry.status))).toEqual(
      new Set(["passing", "breaching", "insufficient-data", "disabled"]),
    );
    expect(record.slis.find((entry) => entry.id === "ephemeral-verification-success")).toMatchObject({
      status: "disabled",
      reasons: [
        { reasonCode: "producer-disabled", reasonSource: "repo-variable:PLATFORM_EPHEMERAL_VERIFICATION_ENABLED" },
      ],
    });
    expect(record.slis.find((entry) => entry.id === "open-mutation-circuit")).toMatchObject({
      status: "breaching",
      sample: 2,
    });

    const missingPathPolicy = structuredClone(policy);
    missingPathPolicy.targets["merge-group-success"].metric = "prs.platformPr.mergeGroup.missing";
    const missingPath = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy: missingPathPolicy,
      source,
      apiStatus: {},
      ephemeralProducerState: "disabled",
    }).record.slis.find((entry) => entry.id === "merge-group-success");
    expect(missingPath).toMatchObject({
      status: "insufficient-data",
      reasons: [
        {
          reasonCode: "metric-path-missing",
          reasonSource: "target:merge-group-success:metric:prs.platformPr.mergeGroup.missing",
        },
      ],
    });
  });

  it("keeps a complete empty mutation circuit passing", () => {
    const source = representativeSource();
    source.circuits = [];
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
      ephemeralProducerState: "disabled",
    }).record;
    expect(record.slis.find((entry) => entry.id === "open-mutation-circuit")).toMatchObject({
      status: "passing",
      value: 0,
      sample: 0,
      reasons: [],
    });
  });

  it("localizes completeness by target source window and lastN frontier", () => {
    const source = representativeSource();
    source.platformPrRuns[0].run_started_at = null;
    source.sourceFailures = [{ source: "pull-reviews:1", error: "fixture" }];
    const record = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source,
      apiStatus: {},
      ephemeralProducerState: "disabled",
    }).record;
    expect(record.slis.find((entry) => entry.id === "pr-ci-p90").status).toBe("insufficient-data");
    expect(record.slis.find((entry) => entry.id === "pull-request-ci-success").status).not.toBe("insufficient-data");
    expect(record.slis.find((entry) => entry.id === "actual-release-success").status).not.toBe("insufficient-data");
  });

  it("propagates authoritative ephemeral producer state", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/platform-delivery-health.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("RAW_EPHEMERAL_PRODUCER_ENABLED: ${{ vars.PLATFORM_EPHEMERAL_VERIFICATION_ENABLED }}");
    expect(workflow).toContain('if [ "$RAW_EPHEMERAL_PRODUCER_ENABLED" = "true" ]; then');
    expect(workflow).toContain('--ephemeral-producer-state "$ephemeral_producer_state"');
    expect(workflow).not.toMatch(/vars\.PLATFORM_EPHEMERAL_VERIFICATION_ENABLED\s*==/u);
    expect(parseRepositoryVariablesAuthority([{ total_count: 0, variables: [] }])).toBe("disabled");
    expect(
      parseRepositoryVariablesAuthority([
        { total_count: 1, variables: [{ name: "PLATFORM_EPHEMERAL_VERIFICATION_ENABLED", value: "true" }] },
      ]),
    ).toBe("enabled");
    for (const value of ["True", "TRUE", "1", "yes"]) {
      expect(
        parseRepositoryVariablesAuthority([
          { total_count: 1, variables: [{ name: "PLATFORM_EPHEMERAL_VERIFICATION_ENABLED", value }] },
        ]),
      ).toBe("disabled");
    }
    for (const pages of [
      [{ total_count: 1, variables: [{}] }],
      [
        {
          total_count: 2,
          variables: [
            { name: "A", value: "1" },
            { name: "a", value: "2" },
          ],
        },
      ],
      [
        {
          total_count: 2,
          variables: [
            { name: "PLATFORM_EPHEMERAL_VERIFICATION_ENABLED", value: "true" },
            { name: "platform_ephemeral_verification_enabled", value: "false" },
          ],
        },
      ],
      [{ total_count: 2, variables: [{ name: "A", value: "1" }] }],
      [{}],
      null,
    ]) {
      expect(parseRepositoryVariablesAuthority(pages)).toBe("unknown");
    }
  });

  it("holds canonical ephemeral issue across disabled lifecycle", async () => {
    const marker = renderSliMarker({ schemaVersion: "delivery-health-sli/v1", sli: "ephemeral-verification-success" });
    const calls = [];
    const makeClient = (issues) => ({
      request: async () =>
        new Response(JSON.stringify({ total_count: issues.length, incomplete_results: false, items: issues })),
      json: async (path, request) => {
        calls.push({ path, request });
        return { number: Number(path.split("/").at(-1)) || 90 };
      },
    });
    const record = {
      generatedAt: "2026-08-30T00:00:00.000Z",
      completeness: { status: "complete" },
      slis: [
        {
          ...sli("ephemeral-verification-success", "disabled"),
          reasons: [
            { reasonCode: "producer-disabled", reasonSource: "repo-variable:PLATFORM_EPHEMERAL_VERIFICATION_ENABLED" },
          ],
        },
      ],
    };
    expect(
      (await publishSliIssues({ client: makeClient([]), repository: "chase-sets/chase-sets", record })).actions,
    ).toEqual([]);
    expect(
      (
        await publishSliIssues({
          client: makeClient([{ number: 90, state: "closed", body: marker }]),
          repository: "chase-sets/chase-sets",
          record,
        })
      ).actions,
    ).toEqual([]);
    expect(
      (
        await publishSliIssues({
          client: makeClient([{ number: 90, state: "open", body: `${marker}\n- Status: **breaching**` }]),
          repository: "chase-sets/chase-sets",
          record,
        })
      ).actions,
    ).toEqual([{ sli: "ephemeral-verification-success", action: "held-open-disabled", issueNumber: 90 }]);
    const writesAfterFirstDisabled = calls.length;
    expect(
      (
        await publishSliIssues({
          client: makeClient([{ number: 90, state: "open", body: `${marker}\n- Status: **disabled**` }]),
          repository: "chase-sets/chase-sets",
          record,
        })
      ).actions,
    ).toEqual([{ sli: "ephemeral-verification-success", action: "unchanged-disabled", issueNumber: 90 }]);
    expect(calls).toHaveLength(writesAfterFirstDisabled);
  });

  it("drives one canonical SLI mutation through collector evaluator and publisher", async () => {
    const writes = [];
    const client = productionSeamClient({
      platformRuns: Array.from({ length: 10 }, (_, index) =>
        run(50_000 + index, "pull_request", "failure", { updated_at: iso(index), run_started_at: iso(index + 1) }),
      ),
      writes,
    });
    const outputDirectory = mkdtempSync(path.join(tmpdir(), "delivery-health-production-seam-"));
    let result;
    try {
      result = await collectDeliveryHealth(
        {
          repository: "chase-sets/chase-sets",
          checkedAt: "2026-07-18T12:00:00.000Z",
          publicationMode: "hourly",
          ephemeralProducerState: "disabled",
          outPath: path.join(outputDirectory, "delivery-health.json"),
          markdownOutPath: path.join(outputDirectory, "delivery-health.md"),
          updateIssues: true,
          fetchImpl: async () => new Response(),
        },
        { policy, client },
      );
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
    expect(result.record.slis.find((entry) => entry.id === "pull-request-ci-success")).toMatchObject({
      status: "breaching",
      sample: 10,
      reasons: [],
    });
    expect(result.issueUpdates).toMatchObject({ status: "complete", reasons: [] });
    expect(result.issueUpdates.actions).toEqual([
      { sli: "pull-request-ci-success", action: "created", issueNumber: 7001 },
    ]);
    expect(writes.map((entry) => entry.path)).toEqual(["/issues"]);

    const omittedLiveSource = await collectDeliveryHealth(
      {
        repository: "chase-sets/chase-sets",
        checkedAt: "2026-07-18T12:00:00.000Z",
        publicationMode: "daily",
        ephemeralProducerState: "disabled",
        updateIssues: false,
        fetchImpl: async () => new Response(),
      },
      { policy, source: { pulls: [] }, client },
    );
    expect(omittedLiveSource.record.observations.metaWorkShare).toMatchObject({
      status: "unavailable",
      reasons: [{ reasonCode: "meta-source-failure", reasonSource: "pull-requests" }],
    });
  });

  it("publishes complete daily meta-work share from status-aware PR files", async () => {
    const client = productionSeamClient({
      pulls: [
        {
          number: 42,
          state: "MERGED",
          isDraft: false,
          createdAt: "2026-07-17T10:00:00.000Z",
          updatedAt: "2026-07-18T10:00:00.000Z",
          mergedAt: "2026-07-18T10:00:00.000Z",
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          timelineItems: { nodes: [] },
          reviews: { totalCount: 0, nodes: [] },
          files: { totalCount: 1, nodes: [{ path: "scripts/tool.mjs", additions: 1, deletions: 0 }] },
        },
      ],
      pullFiles: new Map([[42, [{ filename: "scripts/tool.mjs", status: "added", additions: 1, deletions: 0 }]]]),
    });
    const result = await collectDeliveryHealth(
      {
        repository: "chase-sets/chase-sets",
        checkedAt: "2026-07-18T12:00:00.000Z",
        publicationMode: "daily",
        ephemeralProducerState: "disabled",
        updateIssues: false,
        fetchImpl: async () => new Response(),
      },
      { policy, client },
    );
    expect(result.record.observations.metaWorkShare).toMatchObject({
      counts: { metaOnly: 1, mixed: 0, product: 0, unknown: 0 },
      numerator: 1,
      denominator: 1,
      share: 1,
      status: "available",
      reasons: [],
    });
    expect(result.markdown).toContain("### 14-day work purpose");
    const hourly = buildDeliveryHealth({
      checkedAt: "2026-07-18T12:00:00.000Z",
      publicationMode: "hourly",
      repository: "chase-sets/chase-sets",
      policy,
      source: representativeSource(),
      apiStatus: {},
      ephemeralProducerState: "disabled",
    });
    expect(hourly.record).not.toHaveProperty("observations");
    expect(hourly.markdown).not.toContain("### 14-day work purpose");
  });

  it("rejects a noncanonical artifact directory before issue publication", async () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), "delivery-health-payload-negative-"));
    const writes = [];
    writeFileSync(path.join(outputDirectory, "unexpected.json"), "{}", "utf8");
    try {
      await expect(
        collectDeliveryHealth(
          {
            repository: "chase-sets/chase-sets",
            checkedAt: "2026-07-18T12:00:00.000Z",
            publicationMode: "hourly",
            ephemeralProducerState: "disabled",
            outPath: path.join(outputDirectory, "delivery-health.json"),
            markdownOutPath: path.join(outputDirectory, "delivery-health.md"),
            updateIssues: true,
            fetchImpl: async () => new Response(),
          },
          {
            policy,
            client: productionSeamClient({
              platformRuns: Array.from({ length: 10 }, (_, index) =>
                run(60_000 + index, "pull_request", "failure", {
                  updated_at: iso(index),
                  run_started_at: iso(index + 1),
                }),
              ),
              writes,
            }),
          },
        ),
      ).rejects.toThrow("exactly the two canonical payloads");
      expect(writes).toEqual([]);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("blocks every write for an incomplete canonical snapshot and isolates duplicate SLI markers", async () => {
    const marker = (id) => renderSliMarker({ schemaVersion: "delivery-health-sli/v1", sli: id });
    const writes = [];
    const record = {
      generatedAt: "2026-08-30T00:00:00.000Z",
      completeness: { status: "complete" },
      slis: [sli("pull-request-ci-success", "breaching"), sli("merge-group-success", "breaching")],
    };
    const incomplete = await publishSliIssues({
      client: {
        request: async () =>
          new Response(
            JSON.stringify({
              total_count: 1,
              incomplete_results: false,
              items: [
                {
                  number: 9,
                  state: "open",
                  body: `${marker("pull-request-ci-success")}\n${marker("merge-group-success")}`,
                },
              ],
            }),
          ),
        json: async (...args) => writes.push(args),
      },
      repository: "chase-sets/chase-sets",
      record,
    });
    expect(incomplete).toEqual({
      status: "canonical-lookup-incomplete",
      reasons: [{ reasonCode: "canonical-marker-malformed", reasonSource: "issue:9" }],
      actions: [],
    });
    expect(writes).toEqual([]);

    const duplicates = await publishSliIssues({
      client: {
        request: async () =>
          new Response(
            JSON.stringify({
              total_count: 2,
              incomplete_results: false,
              items: [
                { number: 12, state: "open", body: marker("pull-request-ci-success") },
                { number: 3, state: "open", body: marker("pull-request-ci-success") },
              ],
            }),
          ),
        json: async (path) => {
          writes.push(path);
          return { number: 77 };
        },
      },
      repository: "chase-sets/chase-sets",
      record,
    });
    expect(duplicates.actions).toEqual([
      { action: "duplicate-marker-conflict", sli: "pull-request-ci-success", issueNumbers: [3, 12] },
      { action: "created", sli: "merge-group-success", issueNumber: 77 },
    ]);
    expect(writes).toEqual(["/issues"]);
  });

  it("closes a canonical zero-sample recovery without creating or reopening one", async () => {
    const marker = renderSliMarker({ schemaVersion: "delivery-health-sli/v1", sli: "open-mutation-circuit" });
    const record = {
      generatedAt: "2026-08-30T00:00:00.000Z",
      completeness: { status: "complete" },
      slis: [{ ...sli("open-mutation-circuit", "passing"), sample: 0, value: 0, reasons: [] }],
    };
    const calls = [];
    const publish = (issues) =>
      publishSliIssues({
        client: {
          request: async () =>
            new Response(JSON.stringify({ total_count: issues.length, incomplete_results: false, items: issues })),
          json: async (path, request) => {
            calls.push({ path, request });
            return { number: 91 };
          },
        },
        repository: "chase-sets/chase-sets",
        record,
      });
    expect((await publish([])).actions).toEqual([]);
    expect((await publish([{ number: 91, state: "closed", body: marker }])).actions).toEqual([]);
    expect((await publish([{ number: 91, state: "open", body: marker }])).actions).toEqual([
      { sli: "open-mutation-circuit", action: "closed", issueNumber: 91 },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("binds every current-attempt release phase", () => {
    const releaseRun = (id, attempt, result) =>
      run(id, "workflow_dispatch", result, {
        run_attempt: attempt,
        jobs: [
          stageJob("Resolve Release", "success", id),
          stageJob("Deploy Staging", "success", id),
          stageJob("Deploy Production", result, id),
        ],
        releaseArtifacts: [releaseRecord(result, { index: id })],
      });
    const stable = Array.from({ length: 9 }, (_, index) => releaseRun(80_000 + index, 1, "success"));
    const evaluate = (deployRuns) =>
      buildDeliveryHealth({
        checkedAt: "2026-07-18T12:00:00.000Z",
        publicationMode: "hourly",
        repository: "chase-sets/chase-sets",
        policy,
        source: { deployRuns, circuits: [] },
        apiStatus: {},
        ephemeralProducerState: "disabled",
      }).record;

    const latestPass = evaluate([...stable, releaseRun(81_000, 2, "success"), releaseRun(81_000, 1, "failure")]);
    expect(latestPass.windows.lastN.releases.actual).toMatchObject({ numerator: 10, denominator: 10 });
    expect(latestPass.windows.lastN.releases.actual.outcomes).toMatchObject({ "retry-pass/flake": 1 });

    const latestFail = evaluate([
      releaseRun(81_001, 1, "success"),
      ...stable.reverse(),
      releaseRun(81_001, 2, "failure"),
    ]);
    expect(latestFail.windows.lastN.releases.actual).toMatchObject({ numerator: 9, denominator: 10 });

    const conflicting = evaluate([...stable, releaseRun(81_002, 2, "success"), releaseRun(81_002, 2, "failure")]);
    expect(conflicting.slis.find((entry) => entry.id === "actual-release-success")).toMatchObject({
      status: "insufficient-data",
      reasons: [
        {
          reasonCode: "attempt-conflict",
          reasonSource: "workflow:platform-production.yml:run:81002:attempt:2",
        },
      ],
    });
  });

  it("rejects truncated meta authority when the decisive PR is beyond a page boundary", async () => {
    const collect = (complete) =>
      collectDeliveryHealth(
        {
          repository: "chase-sets/chase-sets",
          checkedAt: "2026-07-18T12:00:00.000Z",
          publicationMode: "daily",
          ephemeralProducerState: "disabled",
          updateIssues: false,
          fetchImpl: async () => new Response(),
        },
        { policy, client: metaPaginationClient(complete) },
      );
    const complete = await collect(true);
    expect(complete.record.observations.metaWorkShare).toMatchObject({
      counts: { metaOnly: 1, mixed: 0, product: 0, unknown: 0 },
      share: 1,
      status: "available",
      reasons: [],
    });
    const truncated = await collect(false);
    expect(truncated.record.observations.metaWorkShare).toMatchObject({
      counts: { metaOnly: 0, mixed: 0, product: 0, unknown: 0 },
      share: null,
      status: "unavailable",
      reasons: [{ reasonCode: "meta-source-truncated", reasonSource: "pull-requests" }],
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
  const coalescedRelease = run(411, "workflow_dispatch", "success", {
    jobs: [
      stageJob("Resolve Release", "success", 11),
      stageJob("Deploy Staging", "success", 11),
      stageJob("Deploy Production", "skipped", 11),
    ],
    releaseArtifacts: [
      {
        ...releaseRecord("skipped", {
          index: 11,
          stagingResult: "skipped",
          stagingApplied: false,
          productionResult: "skipped",
        }),
        attempt: {
          result: "skipped",
          phase: "queue",
          reason: "candidate-superseded-before-staging-mutation",
          supersededByCommit: "c".repeat(40),
        },
      },
    ],
  });
  const ephemeralRuns = [
    ...Array.from({ length: 19 }, (_, index) =>
      run(500 + index, "workflow_dispatch", "success", {
        jobs: [ephemeralJob("success")],
        verificationArtifact: verificationRecord({ workflowRunId: String(500 + index) }),
        artifactCollectionStatus: "collected",
      }),
    ),
    run(520, "workflow_dispatch", "failure", {
      jobs: [ephemeralJob("failure")],
      verificationArtifact: verificationRecord({
        workflowRunId: "520",
        result: "failure",
        failurePhase: "release-deploy",
      }),
      artifactCollectionStatus: "collected",
    }),
    run(521, "workflow_dispatch", "success", {
      jobs: [ephemeralJob("success")],
      verificationArtifact: verificationRecord({
        workflowRunId: "521",
        trigger: "manual",
        producerRunId: null,
        producerRunAttempt: null,
        persistentStagingResult: "not-applicable",
      }),
      artifactCollectionStatus: "collected",
    }),
  ];
  return {
    ephemeralProducerState: "enabled",
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
        checkedAt: iso(79),
        observations: [],
      },
    ],
    artifactFailures: [],
  };
}

function run(id, event, conclusion, overrides = {}) {
  const value = {
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
  const attempt = value.run_attempt ?? value.runAttempt;
  if (
    (value.releaseArtifacts ?? []).some((record) => record?.schemaVersion === "release-health/v1") &&
    !(value.jobs ?? []).some((job) => job?.name === "Resolve Release")
  ) {
    value.jobs = [{ name: "Resolve Release", conclusion: "success", steps: [] }, ...(value.jobs ?? [])];
  }
  value.jobs = (value.jobs ?? []).map((job) => ({ run_attempt: attempt, ...job }));
  value.releaseArtifacts = (value.releaseArtifacts ?? []).flatMap((record) => {
    if (record?.schemaVersion !== "release-health/v1") return [record];
    const identified = {
      workflowRunId: String(id),
      workflowRunAttempt: String(attempt),
      ...record,
    };
    if (identified.attempt?.phase !== "production") return [identified];
    const staging = {
      ...structuredClone(identified),
      attempt: {
        ...structuredClone(identified.attempt),
        phase: "staging",
        result: identified.staging?.result,
      },
    };
    return identified.production?.result === "skipped" ? [staging] : [staging, identified];
  });
  return value;
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

function verificationRecord(overrides = {}) {
  const record = {
    schemaVersion: "ephemeral-verification/v1",
    releaseCommit: "a".repeat(40),
    imageRepository: "registry.digitalocean.com/chase-sets/chase-sets-platform",
    imageDigest: `sha256:${"b".repeat(64)}`,
    producerRunId: "400",
    producerRunAttempt: "1",
    trigger: "automatic",
    namespace: "chase-sets-verify-500-1",
    workflowRunId: "500",
    workflowRunAttempt: "1",
    result: "success",
    failurePhase: null,
    teardownResult: "success",
    persistentStagingResult: "success",
    persistentStagingRetained: true,
    workloads: ["representative-commerce-state", "platform-smoke", "stripe-money-smoke"],
    checkedAt: "2026-07-18T11:20:00.000Z",
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "namespace")) {
    record.namespace = `chase-sets-verify-${record.workflowRunId}-${record.workflowRunAttempt}`;
  }
  return record;
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

function collectorClient({ archive, withArtifact }) {
  const ephemeralRun = run(900, "workflow_dispatch", "success", {
    head_branch: "main",
    created_at: iso(60),
    updated_at: iso(40),
  });
  return {
    json: async (request) => {
      if (request === "https://api.github.com/graphql") {
        return {
          data: {
            repository: {
              pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        };
      }
      if (String(request).includes("platform-ephemeral-verification.yml")) {
        return { workflow_runs: [ephemeralRun] };
      }
      return { workflow_runs: [] };
    },
    paginate: async (request) => {
      if (String(request).includes("/actions/runs/900/jobs")) return [{ ...ephemeralJob("success"), run_attempt: 1 }];
      if (String(request).includes("/actions/runs/900/artifacts")) {
        return withArtifact
          ? [
              {
                id: 90,
                name: `ephemeral-verification-${"a".repeat(40)}-900-1`,
                expired: false,
                size_in_bytes: archive.length,
                archive_download_url: "https://example.invalid/artifacts/90.zip",
              },
            ]
          : [];
      }
      return [];
    },
    request: async () => new Response(archive),
    markTruncated: () => {},
    status: () => ({ truncated: [], errors: [] }),
  };
}

function productionSeamClient({ platformRuns = [], pulls = [], pullFiles = new Map(), writes = [] } = {}) {
  return {
    json: async (request, options) => {
      if (request === "https://api.github.com/graphql") {
        return {
          data: {
            repository: {
              pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: pulls },
            },
          },
        };
      }
      if (String(request).includes("platform-pr.yml")) return { workflow_runs: platformRuns };
      if (String(request).includes("/actions/workflows/")) return { workflow_runs: [] };
      const pullFilesMatch = String(request).match(/^\/pulls\/(\d+)\/files\?/u);
      if (pullFilesMatch) return pullFiles.get(Number(pullFilesMatch[1])) ?? [];
      const pullMatch = String(request).match(/^\/pulls\/(\d+)$/u);
      if (pullMatch) {
        const pull = pulls.find((entry) => entry.number === Number(pullMatch[1]));
        return pull ? { number: pull.number, changed_files: pull.changedFiles, merged_at: pull.mergedAt } : null;
      }
      if (request === "/issues" || String(request).startsWith("/issues/")) {
        writes.push({ path: request, request: options });
        return { number: request === "/issues" ? 7001 : Number(String(request).split("/").at(-1)) };
      }
      throw new Error(`Unexpected JSON request: ${request}`);
    },
    paginate: async () => [],
    request: async (request) => {
      if (String(request).startsWith("https://api.github.com/search/issues")) {
        const isPullSearch = new URL(String(request)).searchParams.get("q")?.includes("is:pr");
        const items = isPullSearch ? pulls.map((pull) => ({ number: pull.number })) : [];
        return new Response(JSON.stringify({ total_count: items.length, incomplete_results: false, items }));
      }
      throw new Error(`Unexpected request: ${request}`);
    },
    markTruncated: () => {},
    status: () => ({ truncated: [], errors: [] }),
  };
}

function metaPaginationClient(complete) {
  return {
    request: async (request) => {
      const url = new URL(String(request));
      const page = Number(url.searchParams.get("page"));
      const items = page === 1 ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })) : [{ number: 101 }];
      const headers = {};
      if (page === 1 && complete) {
        const next = new URL(url);
        next.searchParams.set("page", "2");
        headers.link = `<${next}>; rel="next"`;
      }
      return new Response(JSON.stringify({ total_count: 101, incomplete_results: false, items }), { headers });
    },
    json: async (request) => {
      if (request === "https://api.github.com/graphql") {
        return {
          data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
        };
      }
      if (String(request).includes("/actions/workflows/")) return { workflow_runs: [] };
      const detail = String(request).match(/^\/pulls\/(\d+)$/u);
      if (detail) {
        const number = Number(detail[1]);
        return {
          number,
          changed_files: number === 101 ? 1 : 0,
          merged_at: number === 101 ? "2026-07-18T10:00:00.000Z" : "2026-06-01T00:00:00.000Z",
        };
      }
      if (String(request).startsWith("/pulls/101/files?")) {
        return [{ filename: "scripts/decisive.mjs", status: "added" }];
      }
      throw new Error(`Unexpected JSON request: ${request}`);
    },
    paginate: async () => [],
    markTruncated: () => {},
    status: () => ({ truncated: [], errors: [] }),
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
