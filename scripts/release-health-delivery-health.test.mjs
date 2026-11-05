import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  DELIVERY_HEALTH_VERSION,
  buildDeliveryHealth,
  collectDeliveryHealth,
  createGitHubClient,
  fetchPullFiles,
  normalizeDeliveryConclusion,
  parseSliMarker,
  percentileSummary,
  publishSliIssues,
  readDeliveryHealthPolicy,
  readEphemeralVerificationArchive,
  readBoundedQualificationArchive,
  readQualificationArchive,
  readStagingAdvisoryArchive,
  renderSliMarker,
  unzipJsonEntries,
  validateEphemeralVerificationRecord,
  runDeliveryHealthCommand,
} from "./release-health-delivery-health.mjs";
import {
  buildMergeQualificationCandidate,
  buildMergeQualificationDecision,
  buildMergeQualificationEvent,
  reconcileMergeQualificationProducerAttempt,
} from "./merge-qualification.mjs";
import { SUBCOMMANDS } from "./ops.mjs";

let policy;
let stagingFixture;
let realStagingFixture;

const qualificationRepository = "chase-sets/chase-sets";
const qualificationCheckedAt = "2026-07-21T12:00:00.000Z";
function qualificationTransport({
  attempts = [1],
  omitted = false,
  malformed = false,
  disabled = false,
  conclusion = "success",
  advisoryId = 5000,
  terminalState = "passed",
  orphan = false,
  lateAdvisory = false,
  repository = qualificationRepository,
} = {}) {
  const qualificationRepository = repository;
  const ledger = [];
  const policyContent = JSON.stringify({
    schemaVersion: "merge-qualification-policy/v1",
    enabled: !disabled,
    owner: disabled ? null : "synthetic-owner",
    ceiling: disabled ? null : { dollarCeilingUsd: 25, maxQualificationsPerDay: 20 },
    enabledAt: disabled ? null : "2026-07-20T00:00:00Z",
    expiresAt: disabled ? null : "2026-08-10T00:00:00Z",
  });
  const run = (attempt) => ({
    id: advisoryId,
    run_attempt: attempt,
    workflow_id: 77,
    path: ".github/workflows/platform-merge-qualification.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion,
    head_sha: "a".repeat(40),
    repository: { full_name: qualificationRepository },
    display_title: "Merge Qualification producer 4000-1",
    created_at: lateAdvisory ? "2026-07-21T10:40:00.000Z" : "2026-07-21T10:00:00.000Z",
    run_started_at: lateAdvisory ? "2026-07-21T10:40:00.000Z" : "2026-07-21T10:00:00.000Z",
  });
  const decision = buildMergeQualificationDecision({
    repository: qualificationRepository,
    workflowId: "77",
    workflowPath: run(1).path,
    runId: "5000",
    runAttempt: "1",
    parentWorkflowId: "11",
    parentWorkflowPath: ".github/workflows/platform-pr.yml",
    parentRunId: "4000",
    parentRunAttempt: "1",
    candidateSha: "b".repeat(40),
    candidateTreeSha: "c".repeat(40),
    builtImageDigest: `sha256:${"d".repeat(64)}`,
    policyRevision: "a".repeat(40),
    policyEnabled: true,
    classifierClass: "isolated",
    classifierReasonCodes: ["application_runtime"],
    observedAt: run(1).run_started_at,
  });
  const cancelled = terminalState === "cancelled_evicted";
  const built = buildMergeQualificationEvent({
    ...decision.decision,
    terminalState,
    reasonCodes: [cancelled ? "candidate_evicted" : "gate_passed"],
    builtImageDigest: cancelled ? null : decision.decision.builtImageDigest,
    imageDigest: cancelled ? null : `sha256:${"d".repeat(64)}`,
    gateCandidateSha: cancelled ? null : "b".repeat(40),
    gateCandidateTreeSha: cancelled ? null : "c".repeat(40),
    provisioned: !cancelled,
    startedAt: run(1).run_started_at,
    completedAt: lateAdvisory ? "2026-07-21T10:50:00.000Z" : "2026-07-21T10:10:00.000Z",
    evidenceLinks: ["https://example.invalid/synthetic-qualification/5000/1"],
    providerHeadroom: null,
  });
  const event = malformed ? { ...built.event, secretMarker: "PRIVATE_SECRET_MARKER" } : built.event;
  const candidate = buildMergeQualificationCandidate({
    repository: qualificationRepository,
    workflowId: "11",
    workflowPath: ".github/workflows/platform-pr.yml",
    runId: "4000",
    runAttempt: "1",
    queueBaseSha: "e".repeat(40),
    pullRequests: [{ number: 1, headSha: "f".repeat(40) }],
    candidateSha: "b".repeat(40),
    candidateTreeSha: "c".repeat(40),
    builtImageDigest: `sha256:${"d".repeat(64)}`,
    policyRevision: "a".repeat(40),
    capturedAt: "2026-07-21T10:00:00.000Z",
  });
  const parent = {
    id: 4000,
    run_attempt: 1,
    workflow_id: 11,
    path: ".github/workflows/platform-pr.yml",
    event: "merge_group",
    status: "completed",
    conclusion: "success",
    head_sha: "b".repeat(40),
    repository: { full_name: qualificationRepository },
    created_at: "2026-07-21T10:00:00.000Z",
    run_started_at: "2026-07-21T10:00:00.000Z",
    updated_at: "2026-07-21T10:10:00.000Z",
  };
  const loss = reconcileMergeQualificationProducerAttempt({
    producer: parent,
    candidate: candidate.record,
    policy: { enabled: true },
    now: new Date(qualificationCheckedAt),
  }).event;
  const archives = new Map([
    [503, buildZip([["event.json", JSON.stringify(loss), 8]])],
    [500, buildZip([["candidate.json", JSON.stringify(candidate.record), 8]])],
    [501, buildZip([["decision.json", JSON.stringify(decision.decision), 8]])],
    [
      502,
      buildZip([
        ["event.json", JSON.stringify(event), 8],
        ["sibling.json", "x".repeat(1_000_000), 8],
      ]),
    ],
  ]);
  const artifact = (id, name, writer) => ({
    id,
    name,
    expired: false,
    workflow_run: { id: writer },
    size_in_bytes: archives.get(id).length,
  });
  const decisionArtifact = artifact(501, "merge-qualification-decision-5000-1", 5000);
  const candidateArtifact = artifact(500, "merge-qualification-candidate-4000-1", 4000);
  const terminalArtifact = orphan
    ? artifact(503, "merge-qualification-producer-terminal-4000-1", 9000)
    : artifact(502, "merge-qualification-terminal-5000-1", 9000);
  const terminalArtifacts = lateAdvisory
    ? [terminalArtifact, artifact(503, "merge-qualification-producer-terminal-4000-1", 9000)]
    : [terminalArtifact];
  const fetchImpl = async (url, request = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(`/repos/${qualificationRepository}`, "");
    ledger.push({ path, search: parsed.search, method: request.method ?? "GET" });
    let body;
    if (path === "/graphql")
      body = {
        data: {
          search: {
            issueCount: 0,
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    else if (path.startsWith("/contents/"))
      body = { encoding: "base64", content: Buffer.from(policyContent).toString("base64") };
    else if (path.includes("/workflows/platform-merge-qualification.yml/runs"))
      body = { total_count: orphan ? 0 : attempts.length, workflow_runs: orphan ? [] : attempts.map(run) };
    else if (
      (orphan || lateAdvisory) &&
      path.includes("/workflows/platform-pr.yml/runs") &&
      parsed.searchParams.has("created")
    )
      body = { total_count: 1, workflow_runs: [parent] };
    else if (path.includes("/workflows/")) body = { total_count: 0, workflow_runs: [] };
    else if (path === "/search/issues") body = { total_count: 0, items: [] };
    else if (path === "/actions/artifacts") {
      const artifacts = omitted
        ? []
        : terminalArtifacts.filter((item) => item.name === parsed.searchParams.get("name"));
      body = { total_count: artifacts.length, artifacts };
    } else if (path === "/actions/runs/4000/attempts/1") body = parent;
    else if (path === "/actions/runs/5000/attempts/1") body = run(1);
    else if (path === "/actions/runs/4000/attempts/1/jobs")
      body = {
        total_count: 1,
        jobs: [
          {
            id: 600,
            name: "Docker Image Build",
            conclusion: "success",
            steps: [{ name: "Push boot-smoked merge-group image", conclusion: "success" }],
          },
        ],
      };
    else if (path === "/commits")
      body = [{ sha: "a".repeat(40), commit: { committer: { date: "2026-07-21T09:00:00Z" } } }];
    else if (path === `/commits/${"a".repeat(40)}/pulls`)
      body = [{ id: 700, base: { ref: "main" }, merged_at: "2026-07-21T09:30:00Z", merge_commit_sha: "a".repeat(40) }];
    else if (path === "/actions/runs/4000/artifacts") body = { total_count: 1, artifacts: [candidateArtifact] };
    else if (path === "/actions/runs/5000/artifacts") body = { total_count: 1, artifacts: [decisionArtifact] };
    else if (path === "/actions/runs/9000/artifacts")
      body = { total_count: terminalArtifacts.length, artifacts: terminalArtifacts };
    else if (path === "/actions/runs/9000")
      body = {
        id: 9000,
        repository: { full_name: qualificationRepository },
        head_repository: { full_name: qualificationRepository },
        head_branch: "main",
        path: ".github/workflows/platform-merge-qualification-observer.yml",
        event: "schedule",
      };
    else if (/\/actions\/artifacts\/\d+\/zip$/.test(path))
      return new Response(archives.get(Number(path.split("/")[3])));
    else throw new Error(`Unexpected synthetic request ${path}${parsed.search}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetchImpl, ledger, decision, built, archives, loss, candidate: candidate.record, parent };
}

function stagingQualificationTransport({ defect = null } = {}) {
  const fixture = stagingFixture;
  const base = qualificationTransport({ repository: fixture.repository });
  const candidate = base.candidate;
  const image = {
    releaseCommit: fixture.releaseCommit,
    platformImage: `registry.example.invalid/synthetic-platform:${fixture.releaseCommit}`,
    platformImageDigest: candidate.builtImageDigest,
  };
  const summary = {
    schemaVersion: "staging-advisory-evidence/v2",
    checkedAt: fixture.checkedAt,
    ...image,
    admission: { outcome: "admitted", error: "" },
    freshness: {
      status: "fresh",
      reason: "synthetic complete window",
      requested: { ...image },
      observed: { ...image, supersedingIdentity: false },
      publicationAt: fixture.checkedAt,
      windowCensus: { admissionAt: "2026-07-21T10:30:00.000Z", publicationAt: fixture.checkedAt, overlaps: [] },
    },
    postWindow: { outcome: "success", error: "" },
    scenarioSeed: { outcome: "success" },
    marketplaceE2e: { outcome: "success" },
    failedPhases: [],
  };
  const deployRun = {
    id: Number(fixture.deployRunId),
    run_attempt: 1,
    workflow_id: Number(fixture.deployWorkflowId),
    path: ".github/workflows/platform-production.yml",
    repository: { full_name: fixture.repository },
    head_sha: fixture.releaseCommit,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    created_at: fixture.deployStartedAt,
    updated_at: fixture.deployCompletedAt,
  };
  const evidenceRun = {
    id: Number(fixture.evidenceRunId),
    run_attempt: 1,
    workflow_id: Number(fixture.evidenceWorkflowId),
    path: ".github/workflows/platform-staging-advisory-evidence.yml",
    repository: { full_name: fixture.repository },
    head_sha: fixture.releaseCommit,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    created_at: "2026-07-21T10:30:00.000Z",
    updated_at: fixture.checkedAt,
  };
  const step = (name, started_at, completed_at) => ({
    name,
    status: "completed",
    conclusion: "success",
    started_at,
    completed_at,
  });
  const job = {
    id: Number(fixture.deployJobId),
    run_id: deployRun.id,
    run_attempt: deployRun.run_attempt,
    head_sha: deployRun.head_sha,
    name: "Deploy Staging",
    status: "completed",
    conclusion: "success",
    started_at: fixture.deployStartedAt,
    completed_at: fixture.deployCompletedAt,
    steps: [
      step(
        "Activate immutable release before staging mutation",
        "2026-07-21T10:16:00.000Z",
        "2026-07-21T10:16:01.000Z",
      ),
      step("Verify immutable active release image", "2026-07-21T10:17:00.000Z", "2026-07-21T10:17:01.000Z"),
      step("Deploy staging Kubernetes release", "2026-07-21T10:18:00.000Z", fixture.deployAppliedAt),
    ],
  };
  if (defect === "skipped-job") job.conclusion = "skipped";
  if (defect === "wrong-job-attempt") job.run_attempt = 2;
  if (defect === "wrong-job-commit") job.head_sha = "2".repeat(40);
  if (defect === "wrong-job-run") job.run_id = 6001;
  if (defect === "skipped-deploy-step") job.steps[2].conclusion = "skipped";
  if (defect === "green-resolver-only")
    job.steps = [step("Resolve Release", fixture.deployStartedAt, fixture.deployAppliedAt)];
  if (defect === "duplicate-step") job.steps.push(structuredClone(job.steps[2]));
  if (defect === "unknown-freshness") summary.freshness.status = "unknown";
  if (defect === "malformed-summary") summary.freshness.observed.privateMarker = "PRIVATE_SECRET_MARKER";
  const releaseRecord = {
    schemaVersion: "release-health/v1",
    releaseCommit: fixture.releaseCommit,
    workflowRunId: fixture.deployRunId,
    workflowRunAttempt: fixture.deployRunAttempt,
    checkedAt: fixture.deployCompletedAt,
    deploymentRequired: true,
    dispatch: { source: "automatic", runId: "5500", attempt: "1", reason: null },
    staging: {
      result: "success",
      applied: true,
      startedAt: fixture.deployStartedAt,
      completedAt: fixture.deployCompletedAt,
    },
    queue: { mergeSha: fixture.releaseCommit },
  };
  if (defect === "queue-candidate-substitution") releaseRecord.queue.mergeSha = candidate.candidateSha;
  if (defect === "pre-activation-evidence") {
    evidenceRun.created_at = "2026-07-19T10:30:00.000Z";
    job.started_at = "2026-07-19T10:15:00.000Z";
    job.completed_at = "2026-07-19T10:25:00.000Z";
    job.steps = job.steps.map((entry) => ({
      ...entry,
      started_at: entry.started_at.replace("2026-07-21", "2026-07-19"),
      completed_at: entry.completed_at.replace("2026-07-21", "2026-07-19"),
    }));
  }
  const summaryText = JSON.stringify(summary);
  let entries = [["summary.json", summaryText, 8]];
  if (defect === "nested-summary") entries = [["nested/summary.json", summaryText, 8]];
  if (defect === "missing-summary") entries = [["notes.json", "{}", 8]];
  if (defect === "duplicate-summary") entries.push(["summary.json", summaryText, 8]);
  if (defect === "unsafe-zip") entries.push(["../unsafe.json", "{}", 0]);
  if (defect === "bad-json") entries = [["summary.json", "{invalid", 8]];
  if (defect === "oversized-summary")
    entries = [["summary.json", summaryText + " ".repeat(64 * 1024 + 1 - Buffer.byteLength(summaryText)), 8]];
  if (defect === "summary-cap-boundary")
    entries = [["summary.json", summaryText + " ".repeat(64 * 1024 - Buffer.byteLength(summaryText)), 8]];
  if (defect === "large-sibling") entries.push(["sibling.json", "x".repeat(11 * 1024 * 1024), 0]);
  const archive = buildZip(entries);
  const artifact = {
    id: Number(fixture.artifactId),
    name: `staging-advisory-evidence-${fixture.evidenceRunId}-${fixture.evidenceRunAttempt}`,
    expired: false,
    created_at: "2026-07-21T11:00:01.000Z",
    expires_at: "2026-08-20T11:00:01.000Z",
    size_in_bytes: archive.length,
    workflow_run: { id: evidenceRun.id },
    digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
  };
  if (defect === "expired-artifact") artifact.expired = true;
  if (defect === "wrong-artifact-run") artifact.workflow_run.id = 7001;
  if (defect === "wrong-artifact-digest") artifact.digest = `sha256:${"0".repeat(64)}`;
  if (defect === "oversized-archive") artifact.size_in_bytes = 256 * 1024 * 1024 + 1;
  const response = (body, headers) => new Response(JSON.stringify(body), { headers });
  const fetchImpl = async (url, request = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(`/repos/${fixture.repository}`, "");
    const track = () => base.ledger.push({ path, search: parsed.search, method: request.method ?? "GET" });
    if (path.includes("/workflows/platform-staging-advisory-evidence.yml/runs")) {
      track();
      if (defect === "truncated-staging-runs") return response({ total_count: 1000, workflow_runs: [evidenceRun] });
      if (defect === "missing-staging-total") return response({ workflow_runs: [evidenceRun] });
      return response({
        total_count: defect === "omitted-staging-gather" ? 0 : 1,
        workflow_runs: defect === "omitted-staging-gather" ? [] : [evidenceRun],
      });
    }
    if (path.includes("/workflows/platform-production.yml/runs")) {
      track();
      return response({ total_count: 1, workflow_runs: [deployRun] });
    }
    if (path === "/actions/runs/6000/jobs" || path === "/actions/runs/6000/attempts/1/jobs") {
      track();
      return response({ total_count: 1, jobs: [job] });
    }
    if (path === "/actions/runs/6000/artifacts") {
      track();
      return response({
        total_count: 1,
        artifacts: [{ id: 601, name: "staging-release-health", size_in_bytes: 100, expired: false }],
      });
    }
    if (path === "/actions/artifacts/601/zip") {
      track();
      return new Response(buildZip([["staging-release.json", JSON.stringify(releaseRecord), 8]]));
    }
    if (path === "/actions/runs/7000/artifacts") {
      track();
      if (
        [
          "paged-artifacts",
          "changed-artifact-total",
          "malformed-artifact-link",
          "shifted-artifact-page",
          "duplicate-artifact-id",
        ].includes(defect)
      ) {
        const page = Number(parsed.searchParams.get("page"));
        const siblings = Array.from({ length: 100 }, (_, index) => ({
          id: 800 + index,
          name: `synthetic-sibling-${index}`,
        }));
        const headers = {};
        if (page === 1) {
          const next = new URL(parsed);
          next.searchParams.set("page", "2");
          if (defect === "shifted-artifact-page") next.searchParams.set("per_page", "10");
          headers.link = defect === "malformed-artifact-link" ? "invalid-link" : `<${next.href}>; rel="next"`;
        }
        return response(
          {
            total_count: defect === "changed-artifact-total" && page === 2 ? 102 : 101,
            artifacts:
              page === 1 ? siblings : [defect === "duplicate-artifact-id" ? { ...artifact, id: 800 } : artifact],
          },
          headers,
        );
      }
      const artifacts =
        defect === "omitted-staging-artifact"
          ? []
          : defect === "duplicate-artifact"
            ? [artifact, { ...artifact, id: 702 }]
            : [artifact];
      return response({ total_count: defect === "truncated-artifacts" ? 101 : artifacts.length, artifacts });
    }
    if (path === "/actions/artifacts/701/zip") {
      track();
      return new Response(archive);
    }
    if (path === `/git/commits/${candidate.candidateSha}` || path === `/git/commits/${fixture.releaseCommit}`) {
      track();
      return response({
        sha: path.split("/").at(-1),
        tree: { sha: candidate.candidateTreeSha },
        parents: [{ sha: candidate.queueBaseSha }],
      });
    }
    if (path === "/actions/runs/4000") {
      track();
      return response({
        ...base.parent,
        run_attempt: defect === "superseded-attempt" ? 2 : 1,
        workflow_id: defect === "wrong-latest-workflow" ? 12 : base.parent.workflow_id,
        conclusion: defect === "contradictory-latest-result" ? "failure" : base.parent.conclusion,
      });
    }
    if (path === `/commits/${fixture.releaseCommit}/pulls`) {
      track();
      return response([{ id: 1, number: 1 }]);
    }
    if (path === "/pulls/1") {
      track();
      return response({
        number: 1,
        head: { sha: defect === "superseded-pr" ? "2".repeat(40) : candidate.pullRequests[0].headSha },
        base: { ref: "main", repo: { full_name: fixture.repository } },
        merge_commit_sha: fixture.releaseCommit,
        merged_at: fixture.mergedAt,
      });
    }
    if (path === "/issues/1/timeline") {
      track();
      return response([
        {
          ...(defect === "identityless-timeline" ? {} : { id: 1 }),
          event: "added_to_merge_queue",
          created_at: fixture.queuedAt,
        },
        {
          ...(defect === "identityless-timeline" ? {} : { id: 2 }),
          event: "merged",
          commit_id: fixture.releaseCommit,
          created_at: fixture.mergedAt,
        },
      ]);
    }
    if (defect === "omitted-s-gather" && path.includes("/workflows/platform-merge-qualification.yml/runs")) {
      track();
      return response({ total_count: 0, workflow_runs: [] });
    }
    return base.fetchImpl(url, request);
  };
  return { ...base, fetchImpl, summary, archive, releaseRecord };
}

describe("canonical advisory collection", () => {
  const collect = async (fixture) =>
    collectDeliveryHealth(
      {
        repository: fixture.candidate?.repository ?? qualificationRepository,
        checkedAt: qualificationCheckedAt,
        publicationMode: "hourly",
        updateIssues: false,
        fetchImpl: fixture.fetchImpl,
        sleep: async () => {},
      },
      { policy },
    );

  it("scheduled collection joins S records without replacing source", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/platform-delivery-health.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("pnpm run ops -- release-health:delivery-health");
    expect(workflow).toContain("--update-issues true");
    expect(SUBCOMMANDS["release-health:delivery-health"].script).toBe("release-health-delivery-health.mjs");
    const fixture = stagingQualificationTransport();
    expect(buildMergeQualificationCandidate(stagingFixture.candidateInput).record).toEqual(fixture.candidate);
    const directory = await mkdtemp(join(tmpdir(), "synthetic-staging-lineage-command-"));
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(fixture.fetchImpl);
    try {
      const out = join(directory, "health.json");
      const markdownOut = join(directory, "health.md");
      const summaryOut = join(directory, "summary.md");
      expect(
        await runDeliveryHealthCommand(
          [
            "--repository",
            stagingFixture.repository,
            "--checked-at",
            qualificationCheckedAt,
            "--out",
            out,
            "--markdown-out",
            markdownOut,
            "--github-summary",
            summaryOut,
            "--update-issues",
            "false",
          ],
          {},
          { policy },
        ),
      ).toBe(0);
      const record = JSON.parse(await readFile(out, "utf8"));
      expect(record.qualification).toMatchObject({
        schemaVersion: "delivery-health-qualification/v2",
        status: "complete",
        candidates: [fixture.candidate],
        stagingJoins: [
          {
            status: "joined",
            candidateSha: fixture.candidate.candidateSha,
            mergeSha: stagingFixture.releaseCommit,
            stagingRunId: "6000",
            evidenceRunId: "7000",
          },
        ],
      });
      expect(record.qualification.events).toEqual([fixture.built.event]);
      expect(record.qualification.stagingEvidence[0].summary).toEqual(fixture.summary);
      const markdown = await readFile(markdownOut, "utf8");
      expect(markdown).toContain("5000 / 1 | joined | staging-lineage-joined");
      expect(markdown).toContain(stagingFixture.releaseCommit);
      expect(markdown).toContain(`| ${fixture.candidate.builtImageDigest} |`);
      expect(await readFile(summaryOut, "utf8")).toContain("6000 / 1 | 7000 / 1");
      expect(
        fixture.ledger.some((entry) => entry.path.includes("/workflows/platform-staging-advisory-evidence.yml/runs")),
      ).toBe(true);
      expect(fixture.ledger.some((entry) => entry.path === "/actions/artifacts/701/zip")).toBe(true);
      expect(fixture.ledger.some((entry) => entry.path === "/actions/runs/6000/attempts/1/jobs")).toBe(true);
      expect(fixture.ledger.some((entry) => entry.path === "/actions/artifacts/500/zip")).toBe(true);
      expect(fixture.ledger.some((entry) => entry.path === "/issues/1/timeline")).toBe(true);
      expect(fixture.ledger.every((entry) => entry.method === "GET" || entry.path === "/graphql")).toBe(true);
    } finally {
      spy.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
    for (const defect of ["omitted-staging-gather", "omitted-staging-artifact", "omitted-s-gather", "superseded-pr"]) {
      const omitted = await collect(stagingQualificationTransport({ defect }));
      expect(
        omitted.record.qualification.stagingJoins.some((entry) => entry.status === "joined"),
        defect,
      ).toBe(false);
      if (defect !== "omitted-s-gather") expect(omitted.record.qualification.status, defect).toBe("partial");
    }
  });

  it("reads exact real transport ZIP bytes as unknown orphan evidence without inventing S", async () => {
    const real = realStagingFixture;
    const archive = Buffer.from(real.archiveBase64, "base64");
    expect(createHash("sha256").update(archive).digest("hex")).toBe(real.archiveSha256);
    const parsed = readStagingAdvisoryArchive(archive);
    expect(parsed.summarySha256).toBe(real.summarySha256);
    expect(createHash("sha256").update(real.summaryJson, "utf8").digest("hex")).toBe(real.summarySha256);
    expect(parsed.summary).toEqual(JSON.parse(real.summaryJson));
    expect(parsed.summary.platformImageDigest).toBe(
      "sha256:053ea5cc75fb22d233bda8cb7f6cc47f68267a7fe7565d755a13fd748a605c00",
    );
    expect(parsed.summary.freshness.status).toBe("unknown");
    expect(parsed.summary.postWindow.outcome).toBe("failure");
    const producer = await readFile(
      new URL("../.github/workflows/platform-staging-advisory-evidence.yml", import.meta.url),
      "utf8",
    );
    expect(producer).toContain(
      'schemaVersion:"staging-advisory-evidence/v2",checkedAt:$checkedAt,releaseCommit:$releaseCommit,platformImage:$platformImage,platformImageDigest:$platformImageDigest',
    );
    expect(producer).toContain("name: staging-advisory-evidence-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(producer).toContain("path: artifacts/staging-advisory-evidence/summary.json");
    expect(real.deployJob.steps.find((step) => step.name === "Deploy staging Kubernetes release")).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
    const ledger = [];
    const result = await collectDeliveryHealth(
      {
        repository: real.evidenceRun.repository.full_name,
        checkedAt: "2026-11-05T12:00:00Z",
        publicationMode: "hourly",
        updateIssues: false,
        sleep: async () => {},
        fetchImpl: async (url) => {
          const path = new URL(url).pathname.replace("/repos/chase-sets/chase-sets", "");
          ledger.push(path);
          const response = (body) => new Response(JSON.stringify(body));
          if (path === "/graphql")
            return response({
              data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
            });
          if (path.startsWith("/contents/"))
            return response({
              encoding: "base64",
              content: Buffer.from(
                JSON.stringify({
                  schemaVersion: "merge-qualification-policy/v1",
                  enabled: true,
                  owner: "synthetic-transport-control",
                  ceiling: { dollarCeilingUsd: 25, maxQualificationsPerDay: 20 },
                  enabledAt: "2026-10-20T00:00:00Z",
                  expiresAt: "2026-11-10T00:00:00Z",
                }),
              ).toString("base64"),
            });
          if (path.includes("/workflows/platform-staging-advisory-evidence.yml/runs"))
            return response({ total_count: 1, workflow_runs: [real.evidenceRun] });
          if (path.includes("/workflows/")) return response({ total_count: 0, workflow_runs: [] });
          if (path === "/search/issues") return response({ total_count: 0, items: [] });
          if (path === `/actions/runs/${real.evidenceRun.id}/artifacts`)
            return response({ total_count: 1, artifacts: [real.artifact] });
          if (path === `/actions/artifacts/${real.artifact.id}/zip`) return new Response(archive);
          throw new Error(`unexpected real replay request ${path}`);
        },
      },
      { policy },
    );
    expect(result.record.qualification).toMatchObject({
      status: "partial",
      events: [],
      candidates: [],
      stagingJoins: [],
      reasons: ["qualification:staging:orphan-unknown-freshness"],
      stagingEvidence: [{ deployment: null, summarySha256: real.summarySha256 }],
    });
    expect(ledger).toContain(`/actions/artifacts/${real.artifact.id}/zip`);
    expect(result.markdown).toContain("qualification:staging:orphan-unknown-freshness");
  });

  it("staging source refuses unsafe archives, incomplete artifacts and nonexecuted deployment authority", async () => {
    expect(
      (await collect(stagingQualificationTransport({ defect: "large-sibling" }))).record.qualification.stagingJoins[0]
        .status,
    ).toBe("joined");
    for (const defect of ["summary-cap-boundary", "paged-artifacts", "identityless-timeline"])
      expect(
        (await collect(stagingQualificationTransport({ defect }))).record.qualification.stagingJoins[0].status,
        defect,
      ).toBe("joined");
    for (const defect of [
      "nested-summary",
      "missing-summary",
      "duplicate-summary",
      "unsafe-zip",
      "bad-json",
      "oversized-summary",
      "expired-artifact",
      "wrong-artifact-run",
      "wrong-artifact-digest",
      "oversized-archive",
      "duplicate-artifact",
      "truncated-artifacts",
      "truncated-staging-runs",
      "missing-staging-total",
      "changed-artifact-total",
      "malformed-artifact-link",
      "shifted-artifact-page",
      "duplicate-artifact-id",
      "skipped-deploy-step",
      "wrong-job-attempt",
      "wrong-job-commit",
      "wrong-job-run",
      "green-resolver-only",
      "duplicate-step",
      "unknown-freshness",
      "malformed-summary",
      "superseded-attempt",
      "wrong-latest-workflow",
      "contradictory-latest-result",
      "queue-candidate-substitution",
    ]) {
      const result = await collect(stagingQualificationTransport({ defect }));
      expect(result.record.qualification.status, defect).toBe("partial");
      expect(
        result.record.qualification.stagingJoins.some((entry) => entry.status === "joined"),
        defect,
      ).toBe(false);
      expect(JSON.stringify(result), defect).not.toContain("PRIVATE_SECRET_MARKER");
    }
    const skipped = await collect(stagingQualificationTransport({ defect: "skipped-job" }));
    expect(skipped.record.qualification.status).toBe("complete");
    expect(skipped.record.qualification.stagingJoins[0].status).toBe("unknown");
    const preActivation = await collect(stagingQualificationTransport({ defect: "pre-activation-evidence" }));
    expect(preActivation.record.qualification.status).toBe("complete");
    expect(preActivation.record.qualification.reasons).toEqual([]);
    expect(preActivation.record.qualification.stagingJoins[0].status).toBe("unknown");
  });

  it("scheduled collection reaches render without replacing source", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/platform-delivery-health.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("pnpm run ops -- release-health:delivery-health");
    expect(SUBCOMMANDS["release-health:delivery-health"].script).toBe("release-health-delivery-health.mjs");
    const fixture = qualificationTransport();
    expect(fixture.decision.errors).toEqual([]);
    expect(fixture.built.errors).toEqual([]);
    const directory = await mkdtemp(join(tmpdir(), "10968-impl-g1-command-"));
    const out = join(directory, "health.json");
    const markdownOut = join(directory, "health.md");
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(fixture.fetchImpl);
    try {
      expect(
        await runDeliveryHealthCommand(
          [
            "--repository",
            qualificationRepository,
            "--checked-at",
            qualificationCheckedAt,
            "--out",
            out,
            "--markdown-out",
            markdownOut,
            "--github-summary",
            join(directory, "summary.md"),
            "--update-issues",
            "false",
          ],
          {},
          { policy },
        ),
      ).toBe(0);
      const record = JSON.parse(await readFile(out, "utf8"));
      expect(record.qualification).toMatchObject({
        status: "complete",
        attempts: [{ runId: "5000", runAttempt: "1", status: "terminal", terminalState: "passed" }],
      });
      expect(record.qualification.events).toEqual([fixture.built.event]);
      const markdown = await readFile(markdownOut, "utf8");
      expect(markdown).toContain("5000 / 1 | success | terminal | passed");
      expect(markdown.indexOf("| rolling24h |")).toBeLessThan(markdown.indexOf("### Advisory qualification evidence"));
      expect(fixture.ledger.filter((entry) => entry.path.endsWith("/zip")).map((entry) => entry.path)).toEqual([
        "/actions/artifacts/501/zip",
        "/actions/artifacts/500/zip",
        "/actions/artifacts/502/zip",
      ]);
      expect(fixture.ledger.every((entry) => entry.method === "GET" || entry.path === "/graphql")).toBe(true);
    } finally {
      spy.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
    const omitted = await collect(qualificationTransport({ omitted: true }));
    expect(omitted.record.qualification.status).toBe("partial");
    expect(omitted.record.qualification.events).toEqual([]);
  });

  it("latest attempt inventory preserves terminal conclusions and zero-event renders", async () => {
    for (const attempts of [
      [1, 2],
      [2, 1],
    ]) {
      const fixture = qualificationTransport({ attempts });
      const result = await collect(fixture);
      expect(result.record.qualification.attempts).toEqual([
        {
          runId: "5000",
          runAttempt: "2",
          conclusion: "success",
          status: "invalid",
          terminalState: null,
          classifierClass: null,
          eligible: null,
          identityAvailable: null,
        },
      ]);
      expect(result.record.qualification.events).toEqual([]);
      expect(result.record.qualification.reasons).toEqual(["qualification:5000/2:invalid"]);
      expect(result.markdown).toContain("5000 / 2 | success | invalid | unknown");
    }
    for (const conclusion of [
      "success",
      "failure",
      "neutral",
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
      "future_unknown",
    ]) {
      const result = await collect(qualificationTransport({ conclusion, omitted: true }));
      expect(result.record.qualification.attempts).toMatchObject([
        { conclusion: conclusion === "future_unknown" ? "unknown" : conclusion, status: "missing" },
      ]);
      expect(result.record.qualification.status).toBe("partial");
      expect(result.record.qualification.events).toEqual([]);
    }
    for (const id of ["9007199254740993", "9007199254740992"]) {
      const result = await collect(qualificationTransport({ advisoryId: id }));
      expect(result.record.qualification).toMatchObject({
        status: "partial",
        attempts: [{ runId: id, status: "invalid" }],
        events: [],
      });
      expect(result.markdown).toContain(`${id} / 1`);
    }
    const fixture = qualificationTransport({ terminalState: "cancelled_evicted", conclusion: "cancelled" });
    expect(fixture.built.errors).toEqual([]);
    const evicted = await collect(fixture);
    expect(evicted.record.qualification.events).toMatchObject([
      { terminalState: "cancelled_evicted", provisioned: false, identityAvailable: false },
    ]);
    expect(evicted.record.windows.rolling24h.releases.ephemeral.denominator).toBe(0);
  });

  it("gathers a synthetic dispatch-loss terminal through the canonical producer reader", async () => {
    const fixture = qualificationTransport({ orphan: true });
    expect(fixture.loss).toBeTruthy();
    const result = await collect(fixture);
    expect(result.record.qualification).toMatchObject({
      status: "complete",
      attempts: [
        {
          kind: "producer",
          runId: "4000",
          runAttempt: "1",
          status: "terminal",
          terminalState: "infrastructure_error",
          eligible: true,
        },
      ],
    });
    expect(result.record.qualification.producerEvents).toEqual([fixture.loss]);
    expect(fixture.ledger.some((entry) => entry.path === "/actions/artifacts/503/zip")).toBe(true);
    expect(fixture.ledger.some((entry) => entry.path === "/commits")).toBe(true);
  });

  it("preserves a late-advisory cleanup conflict instead of accepting dispatch loss", async () => {
    const fixture = qualificationTransport({ lateAdvisory: true });
    expect(fixture.built.errors).toEqual([]);
    const result = await collect(fixture);
    expect(result.record.qualification).toMatchObject({
      status: "partial",
      attempts: [
        { runId: "5000", runAttempt: "1", status: "terminal", terminalState: "passed" },
        { kind: "producer", runId: "4000", runAttempt: "1", status: "conflict", terminalState: null },
      ],
      producerEvents: [],
      reasons: ["qualification:4000/1:advisory_cleanup_complete"],
    });
    expect(fixture.ledger.some((entry) => entry.path === "/actions/runs/5000/attempts/1")).toBe(true);
  });

  it("does not demand a terminal for proven scope-skipped decisions", async () => {
    for (const [classifierClass, reason] of [
      ["not_applicable", "docs_or_test_only"],
      ["persistent_required", "migration_schema"],
    ]) {
      const fixture = qualificationTransport({ omitted: true });
      fixture.archives.set(
        501,
        buildZip([
          [
            "decision.json",
            JSON.stringify({ ...fixture.decision.decision, classifierClass, classifierReasonCodes: [reason] }),
            8,
          ],
        ]),
      );
      const result = await collect(fixture);
      expect(result.record.qualification).toMatchObject({
        status: "complete",
        attempts: [{ status: "not-required", eligible: false, classifierClass }],
        events: [],
      });
      expect(fixture.ledger.some((entry) => entry.path === "/actions/artifacts")).toBe(false);
    }
  });

  it("paged collection rejects truncation and exact-payload violations", async () => {
    const control = qualificationTransport();
    const text = JSON.stringify(control.built.event);
    control.archives.set(
      502,
      buildZip([
        ["event.json", text + " ".repeat(64 * 1024 - Buffer.byteLength(text)), 8],
        ["sibling.json", "x".repeat(11 * 1024 * 1024), 0],
      ]),
    );
    expect(Buffer.byteLength(readQualificationArchive(control.archives.get(502)))).toBe(64 * 1024);
    expect(() =>
      readQualificationArchive(
        buildZip([["event.json", text + " ".repeat(64 * 1024 + 1 - Buffer.byteLength(text)), 8]]),
      ),
    ).toThrow("exceeds its byte bound");
    expect((await collect(control)).record.qualification.status).toBe("complete");
    for (const entries of [
      [["nested/event.json", text, 8]],
      [["notes.json", "{}", 8]],
      [["event.json", "{not-json", 8]],
      [
        ["event.json", text, 8],
        ["event.json", text, 8],
      ],
      [["event.json", text + " ".repeat(64 * 1024 + 1 - Buffer.byteLength(text)), 8]],
      [
        ["event.json", text, 8],
        ["../unsafe.json", "{}", 0],
      ],
      [["event.json", JSON.stringify({ ...control.built.event, schemaVersion: "merge-qualification-event/v999" }), 8]],
    ]) {
      const fixture = qualificationTransport();
      fixture.archives.set(502, buildZip(entries));
      const result = await collect(fixture);
      expect(result.record.qualification.status).toBe("partial");
      expect(result.record.qualification.events).toEqual([]);
    }
    await expect(
      readBoundedQualificationArchive(
        new Response("tiny", { headers: { "content-length": String(256 * 1024 * 1024 + 1) } }),
      ),
    ).rejects.toThrow("qualification_archive_size_invalid");
    let cancelled = false;
    await expect(
      readBoundedQualificationArchive({
        body: {
          getReader: () => ({
            read: async () => ({ done: false, value: { byteLength: 256 * 1024 * 1024 + 1 } }),
            cancel: async () => {
              cancelled = true;
            },
            releaseLock: () => {},
          }),
        },
      }),
    ).rejects.toThrow("qualification_archive_size_invalid");
    expect(cancelled).toBe(true);
  });

  it("mixed windows preserve legacy alerts and isolate one malformed record", async () => {
    const valid = await collect(qualificationTransport());
    const invalid = await collect(qualificationTransport({ malformed: true }));
    const source = representativeSource();
    const health = (qualification) =>
      buildDeliveryHealth({
        checkedAt: "2026-07-18T12:00:00.000Z",
        publicationMode: "hourly",
        repository: qualificationRepository,
        policy,
        source: { ...source, qualification },
        apiStatus: {},
      });
    const legacy = health(undefined);
    const disabled = await collect(qualificationTransport({ disabled: true }));
    expect(health(disabled.record.qualification).record.slis).toEqual(legacy.record.slis);
    expect(health(valid.record.qualification).record.slis).toEqual(legacy.record.slis);
    const malformed = health(invalid.record.qualification);
    expect(malformed.record.completeness.reasons).toEqual(["qualification:5000/1:invalid"]);
    expect(malformed.record.slis.every((sli) => sli.status === "insufficient-data")).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain("PRIVATE_SECRET_MARKER");
    expect(health(valid.record.qualification).record.slis).toEqual(legacy.record.slis);
  });

  it("mixed windows isolate an eligible malformed lineage record beside complete legacy v1 evidence", async () => {
    const joined = await collect(stagingQualificationTransport());
    const source = representativeSource();
    const legacyRecords = structuredClone(source.deployRuns);
    const health = (qualification) =>
      buildDeliveryHealth({
        checkedAt: "2026-07-18T12:00:00.000Z",
        publicationMode: "hourly",
        repository: stagingFixture.repository,
        policy,
        source: { ...source, qualification },
        apiStatus: {},
      });
    const baseline = health(undefined);
    expect(health(joined.record.qualification).record.slis).toEqual(baseline.record.slis);
    const mixed = structuredClone(joined.record.qualification);
    const malformed = structuredClone(mixed.stagingEvidence[0]);
    malformed.deployment.mapping.release.pullRequests[0].extra = "PRIVATE_SECRET_MARKER";
    mixed.stagingEvidence.push(malformed);
    const refused = health(mixed);
    expect(refused.record.completeness.reasons).toEqual(["qualification:record-invalid"]);
    expect(refused.record.slis.every((sli) => sli.status === "insufficient-data")).toBe(true);
    expect(JSON.stringify(refused)).not.toContain("PRIVATE_SECRET_MARKER");
    mixed.stagingEvidence.pop();
    expect(health(mixed).record.slis).toEqual(baseline.record.slis);
    expect(source.deployRuns).toEqual(legacyRecords);
    expect(joined.record.qualification.stagingEvidence[0].deployment.mapping.release.mergeSha).toBe(
      stagingFixture.releaseCommit,
    );
    const legacy = qualificationTransport({ repository: stagingFixture.repository });
    const v1 = structuredClone((await collect(legacy)).record.qualification);
    v1.schemaVersion = "delivery-health-qualification/v1";
    delete v1.enabledAt;
    delete v1.candidates;
    delete v1.stagingEvidence;
    delete v1.stagingJoins;
    expect(health(v1).record.slis).toEqual(baseline.record.slis);
  });

  it("refuses future, open, inconsistent and oversized persisted lineage envelopes", async () => {
    const valid = (await collect(stagingQualificationTransport())).record.qualification;
    const health = (qualification) =>
      buildDeliveryHealth({
        checkedAt: qualificationCheckedAt,
        publicationMode: "hourly",
        repository: stagingFixture.repository,
        policy,
        source: { qualification },
        apiStatus: {},
      });
    for (const mutate of [
      (value) => {
        value.schemaVersion = "delivery-health-qualification/v999";
      },
      (value) => {
        value.extra = "PRIVATE_SECRET_MARKER";
      },
      (value) => {
        value.enabledAt = "2026-02-30T00:00:00Z";
      },
      (value) => {
        value.stagingEvidence[0].summarySha256 = "0".repeat(64);
      },
      (value) => {
        value.stagingEvidence[0].summaryJson += " ";
      },
      (value) => {
        value.stagingEvidence[0].workflowPath = ".github/workflows/other.yml";
      },
      (value) => {
        value.stagingEvidence[0].deployment.mapping.release.pullRequests[0].mergedAt = "2026-02-30T00:00:00Z";
      },
      (value) => {
        value.stagingJoins[0].mergeSha = value.candidates[0].candidateSha;
      },
      (value) => {
        value.candidates[0].repository = "synthetic-other/fixture";
      },
      (value) => {
        value.stagingEvidence = Array(1025).fill(value.stagingEvidence[0]);
      },
      (value) => {
        value.stagingJoins = [];
      },
    ]) {
      const value = structuredClone(valid);
      mutate(value);
      const result = health(value);
      expect(result.record.completeness.reasons).toEqual(["qualification:record-invalid"]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET_MARKER");
    }
  });

  it("default-off real-scale command preserves legacy alerts, old retries and independent last-N cohorts", async () => {
    const fixture = qualificationTransport({ disabled: true });
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const timestamps = Array.from({ length: 14624 }, (_, index) => new Date(epoch + index * 1000).toISOString());
    const old = (index) => timestamps[index];
    const pulls = Array.from({ length: 4207 }, (_, index) => ({
      number: index + 1,
      state: "MERGED",
      isDraft: false,
      createdAt: old(index),
      updatedAt: old(index + 1),
      mergedAt: old(index + 1),
      changedFiles: 1,
      files: { totalCount: 1, nodes: [{ path: "scripts/example.mjs", additions: 1, deletions: 0 }] },
      reviews: { totalCount: 0, nodes: [] },
    }));
    const historicalRun = run(10000, "push", "success");
    const runs = Array.from({ length: 14623 }, (_, index) => ({
      ...historicalRun,
      id: index + 10000,
      created_at: old(index),
      updated_at: old(index + 1),
    }));
    for (let index = 0; index < 10; index += 1) {
      Object.assign(runs[index], {
        event: "pull_request",
        conclusion: "failure",
        created_at: "2026-07-21T10:00:00Z",
        updated_at: "2026-07-21T11:00:00Z",
        repository: { full_name: qualificationRepository },
        workflow_id: 12,
        head_sha: "a".repeat(40),
        status: "completed",
      });
    }
    Object.assign(runs[10], {
      event: "pull_request",
      run_attempt: 2,
      updated_at: "2026-07-21T11:30:00Z",
      repository: { full_name: qualificationRepository },
      workflow_id: 12,
      head_sha: "a".repeat(40),
      status: "completed",
    });
    for (let index = 11; index < 32; index += 1)
      Object.assign(runs[index], { event: "merge_group", updated_at: "2026-07-01T11:00:00Z" });
    const requests = [];
    const partitions = [];
    const selectRange = (values, timestamp) => {
      const indexed = values
        .map((value) => ({ value, created: Date.parse(timestamp(value)) }))
        .sort((left, right) => left.created - right.created);
      const lowerBound = (target) => {
        let left = 0;
        let right = indexed.length;
        while (left < right) {
          const midpoint = Math.floor((left + right) / 2);
          if (indexed[midpoint].created < target) left = midpoint + 1;
          else right = midpoint;
        }
        return left;
      };
      const cache = new Map();
      return (range) => {
        if (!cache.has(range)) {
          const [start, end] = range ? range.split("..").map(Date.parse) : [-Infinity, Infinity];
          const first = lowerBound(start);
          const last = lowerBound(end + 1);
          cache.set(range, {
            length: last - first,
            slice: (from, to) =>
              indexed
                .slice(Math.max(first, last - to), Math.max(first, last - from))
                .reverse()
                .map(({ value }) => value),
          });
        }
        return cache.get(range);
      };
    };
    const selectPulls = selectRange(pulls, (pull) => pull.createdAt);
    const selectRuns = selectRange(runs, (entry) => entry.created_at);
    const response = (values, total, url, key) => {
      const page = Number(url.searchParams.get("page") ?? 1);
      const headers = {};
      if (page * 100 < total) {
        const next = new URL(url);
        next.searchParams.set("page", String(page + 1));
        headers.link = `<${next.href}>; rel="next"`;
      }
      return new Response(JSON.stringify({ total_count: total, [key]: values.slice((page - 1) * 100, page * 100) }), {
        headers,
      });
    };
    const fetchImpl = async (input, request = {}) => {
      const url = new URL(input);
      requests.push({ path: url.pathname, search: url.search, body: request.body });
      if (url.pathname === "/graphql") {
        const variables = JSON.parse(request.body).variables;
        const range = /created:([^ ]+)/.exec(variables.query ?? "")?.[1];
        const selected = selectPulls(range);
        const offset = Number(variables.cursor ?? 0);
        const connection = {
          issueCount: selected.length,
          totalCount: selected.length,
          nodes: selected.slice(offset, offset + 100),
          pageInfo: { hasNextPage: offset + 100 < selected.length, endCursor: String(offset + 100) },
        };
        return new Response(JSON.stringify({ data: { search: connection } }));
      }
      if (url.pathname.endsWith("/workflows/platform-pr.yml/runs")) {
        const range = url.searchParams.get("created");
        const selected = selectRuns(range);
        // Synthetic rows, matching the recorded provider's saturated 2500 counts.
        const total = Math.min(selected.length, 2500);
        if (!url.searchParams.has("page")) partitions.push({ range, total });
        return response(selected, total, url, "workflow_runs");
      }
      if (url.pathname.endsWith(`/runs/${runs[10].id}/attempts/1`))
        return new Response(JSON.stringify({ ...runs[10], run_attempt: 1, updated_at: runs[10].created_at }));
      return fixture.fetchImpl(input, request);
    };
    const directory = await mkdtemp(join(tmpdir(), "10968-impl-g3-scale-"));
    const out = join(directory, "health.json");
    const markdownOut = join(directory, "health.md");
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    try {
      expect(
        await runDeliveryHealthCommand(
          [
            "--repository",
            qualificationRepository,
            "--checked-at",
            qualificationCheckedAt,
            "--out",
            out,
            "--markdown-out",
            markdownOut,
            "--github-summary",
            join(directory, "summary.md"),
            "--update-issues",
            "false",
          ],
          {},
          { policy },
        ),
      ).toBe(0);
      const record = JSON.parse(await readFile(out, "utf8"));
      expect(record.completeness).toMatchObject({ status: "complete", reasons: [] });
      expect(record.qualification).toMatchObject({ status: "disabled" });
      expect(record.slis).toContainEqual(
        expect.objectContaining({ id: "pull-request-ci-success", status: "breaching", sample: 11 }),
      );
      expect(record.windows.rolling24h.prs.platformPr.pullRequest).toMatchObject({
        runCount: 11,
        numerator: 1,
        denominator: 11,
      });
      expect(record.windows.lastN.prs.platformPr.mergeGroup.runCount).toBe(20);
      expect(record.windows.lastN.prs.created).toBe(20);
      expect(record.windows.lastN.prs.merged).toBe(20);
      expect(await readFile(markdownOut, "utf8")).not.toContain("Alerts are suppressed");
      expect(requests.some((entry) => entry.search.includes("created="))).toBe(true);
      expect(requests.some((entry) => entry.path.endsWith(`/runs/${runs[10].id}/attempts/1`))).toBe(true);
      expect(partitions[0].total).toBe(2500);
      expect(
        partitions.some(({ range, total }) => {
          if (total !== 2500) return false;
          const [start, end] = range.split("..").map(Date.parse);
          const midpoint = Math.floor((start / 1000 + Math.floor(end / 1000)) / 2) * 1000;
          return [
            [start, midpoint + 999],
            [midpoint + 1000, end],
          ].every(([from, to]) =>
            partitions.some((child) => {
              const bounds = child.range.split("..").map(Date.parse);
              return child.total === 2500 && bounds[0] === from && bounds[1] === to;
            }),
          );
        }),
      ).toBe(true);
    } finally {
      spy.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("partitioned history reconciles exact parents split by the page policy", async () => {
    const end = Date.parse(qualificationCheckedAt);
    const runs = Array.from({ length: 201 }, (_, index) => {
      const created = new Date(Math.floor((index * end) / 201_000) * 1000).toISOString();
      return run(index + 40000, "push", "success", { created_at: created, updated_at: created });
    });
    for (const changed of [false, true]) {
      const fixture = qualificationTransport({ disabled: true });
      const fetchImpl = async (input, request) => {
        const url = new URL(input);
        if (!url.pathname.endsWith("/workflows/platform-pr.yml/runs")) return fixture.fetchImpl(input, request);
        const [start, finish] = url.searchParams.get("created").split("..").map(Date.parse);
        const selected = runs.filter((entry) => {
          const created = Date.parse(entry.created_at);
          return created >= start && created <= finish;
        });
        return new Response(
          JSON.stringify({
            total_count: selected.length + (changed && start === 0 && finish === end + 999 ? 1 : 0),
            workflow_runs: selected.slice(0, 100),
          }),
        );
      };
      const result = await collectDeliveryHealth(
        {
          repository: qualificationRepository,
          checkedAt: qualificationCheckedAt,
          publicationMode: "hourly",
          updateIssues: false,
          fetchImpl,
          sleep: async () => {},
        },
        { policy: { ...policy, collection: { ...policy.collection, maxPages: 1 } } },
      );
      expect(result.record.completeness.reasons, String(changed)).toEqual(changed ? ["source:platform-pr-runs"] : []);
      expect(result.record.completeness.status, String(changed)).toBe(changed ? "partial" : "complete");
    }
  });

  it("partitioned history refuses changed totals, shifted rows, unsplittable caps and budget exhaustion", async () => {
    for (const defect of [
      null,
      "parent-total",
      "parent-total-low",
      "saturated-deficit",
      "shifted-row",
      "capped-second",
      "budget",
    ]) {
      const fixture = qualificationTransport({ disabled: true });
      const runs = Array.from({ length: 1001 }, (_, index) =>
        run(index + 30000, "push", "success", {
          created_at: new Date(
            Date.parse("2026-01-01T00:00:00Z") + (defect === "capped-second" ? 0 : index * 1000),
          ).toISOString(),
          updated_at: "2026-01-02T00:00:00Z",
        }),
      );
      const calls = [];
      const fetchImpl = async (input, request) => {
        const url = new URL(input);
        if (!url.pathname.endsWith("/workflows/platform-pr.yml/runs")) return fixture.fetchImpl(input, request);
        const range = url.searchParams.get("created");
        const [start, end] = range.split("..").map(Date.parse);
        const selected = runs.filter((run) => Date.parse(run.created_at) >= start && Date.parse(run.created_at) <= end);
        const page = Number(url.searchParams.get("page") ?? 1);
        const values = selected.slice((page - 1) * 100, page * 100);
        let total = selected.length;
        if (start === 0 && end === Date.parse(qualificationCheckedAt) + 999) {
          if (defect === "parent-total") total += 1;
          if (defect === "parent-total-low") total -= 1;
          if (defect === "saturated-deficit") total = 2500;
        }
        if (defect === "shifted-row" && selected.length < 1000 && values.length)
          values[0] = { ...values[0], created_at: "1970-01-01T00:00:00Z" };
        calls.push({ range, page, probe: !url.searchParams.has("page"), count: selected.length });
        const headers = {};
        if (page * 100 < selected.length) {
          const next = new URL(url);
          next.searchParams.set("page", String(page + 1));
          headers.link = `<${next.href}>; rel="next"`;
        }
        return new Response(
          JSON.stringify({
            total_count: total,
            workflow_runs: values,
          }),
          { headers },
        );
      };
      const result = await collectDeliveryHealth(
        {
          repository: qualificationRepository,
          checkedAt: qualificationCheckedAt,
          publicationMode: "hourly",
          updateIssues: false,
          fetchImpl,
          sleep: async () => {},
        },
        { policy: defect === "budget" ? { ...policy, collection: { ...policy.collection, maxPages: 1 } } : policy },
      );
      expect(result.record.completeness.reasons, defect).toEqual(defect ? ["source:platform-pr-runs"] : []);
      expect(result.record.completeness.status, defect).toBe(defect ? "partial" : "complete");
      expect(result.record.query.sourceRunIds.platformPr, defect).toHaveLength(defect ? 0 : 20);
      if (defect === "capped-second")
        expect(calls.at(-1).range.split("..").map(Date.parse)).toEqual([
          Date.parse("2026-01-01T00:00:00Z"),
          Date.parse("2026-01-01T00:00:00.999Z"),
        ]);
      if (defect === "budget") expect(calls.filter((call) => call.probe)).toHaveLength(8);
    }
  });

  it("refuses recursively open workflow collection policy before requesting data", async () => {
    for (const collection of [
      { ...policy.collection, surprise: true },
      { ...policy.collection, workflowSources: { ...policy.collection.workflowSources, surprise: "other.yml" } },
      { ...policy.collection, maxPages: 21 },
    ]) {
      const fetchImpl = vi.fn();
      await expect(
        collectDeliveryHealth(
          {
            repository: qualificationRepository,
            checkedAt: qualificationCheckedAt,
            publicationMode: "hourly",
            fetchImpl,
          },
          { policy: { ...policy, collection } },
        ),
      ).rejects.toThrow("Invalid delivery-health collection policy.");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});

beforeAll(async () => {
  policy = await readDeliveryHealthPolicy();
  stagingFixture = JSON.parse(
    await readFile(new URL("./fixtures/release-health/synthetic-staging-lineage.json", import.meta.url), "utf8"),
  );
  realStagingFixture = JSON.parse(
    await readFile(
      new URL("./fixtures/release-health/real-staging-advisory-evidence-40606948173.json", import.meta.url),
      "utf8",
    ),
  );
});

describe("first-attempt workflow success", () => {
  const checkedAt = "2026-10-04T12:00:00.000Z";
  const repository = "chase-sets/chase-sets";
  const options = {
    repository,
    checkedAt,
    publicationMode: "hourly",
    updateIssues: false,
    fetchImpl: globalThis.fetch,
  };
  const synthetic = (id = 1001, overrides = {}) => ({
    id,
    workflow_id: 123,
    event: "pull_request",
    head_sha: "a".repeat(40),
    repository: { full_name: repository },
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-10-04T11:00:00Z",
    ...overrides,
  });
  const clientFor = (runs, attempts = {}, { truncated = false, unavailable = false } = {}) => {
    const calls = [];
    return {
      calls,
      json: async (request) => {
        calls.push(request);
        if (request === "https://api.github.com/graphql")
          return {
            data: { search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } },
          };
        if (request.includes("/attempts/1")) {
          if (unavailable) throw new Error("inaccessible");
          return attempts[request.split("/")[3]];
        }
        if (request.includes("platform-pr.yml")) return { total_count: runs.length, workflow_runs: runs };
        return { total_count: 0, workflow_runs: [] };
      },
      paginate: async (request) => (request.includes("platform-pr.yml") ? runs : []),
      markTruncated: () => {},
      status: () => ({
        truncated: truncated ? [`workflow:${policy.collection.workflowSources.platformPr}`] : [],
        errors: [],
      }),
    };
  };
  const collect = (runs, attempts, flags, customPolicy = policy) =>
    collectDeliveryHealth(options, { policy: customPolicy, client: clientFor(runs, attempts, flags) });
  const metric = (result, window = "rolling24h", event = "pullRequest") =>
    result.record.windows[window].prs.platformPr[event];

  it.each([
    ["success", "completed", 1, 1, null, 0],
    ...["failure", "timed_out", "startup_failure", "action_required"].map((value) => [
      value,
      "completed",
      0,
      1,
      null,
      0,
    ]),
    ...["cancelled", "skipped", "neutral"].map((value) => [value, "completed", 0, 0, value, 0]),
    ...["queued", "in_progress", "waiting", "requested", "pending"].map((status) => [null, status, 0, 0, "pending", 0]),
    [null, "completed", 0, 0, null, 1],
    ["unrecognized", "completed", 0, 0, null, 1],
  ])(
    "classifies %s / %s without inventing a zero-denominator rate",
    async (conclusion, status, numerator, denominator, excluded, unknown) => {
      const first = metric(await collect([synthetic(1001, { conclusion, status })])).firstAttempt;
      expect(first).toMatchObject({
        numerator,
        denominator,
        unknown,
        successRate: denominator ? numerator / denominator : null,
      });
      if (excluded) expect(first.excluded[excluded]).toBe(1);
    },
  );

  it("preserves the observed retry-success / first-failure pair through the real collector", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/delivery-health-first-attempt.json", import.meta.url), "utf8"),
    );
    const result = await collectDeliveryHealth(
      { ...options, checkedAt: "2026-09-27T12:00:00Z" },
      {
        policy,
        client: clientFor([fixture.latest, fixture.mergeGroupLatest], {
          [fixture.latest.id]: fixture.firstAttempt,
        }),
      },
    );
    expect(metric(result)).toMatchObject({
      numerator: 1,
      denominator: 1,
      retries: 1,
      firstAttempt: { numerator: 0, denominator: 1, successRate: 0 },
    });
    expect(metric(result, "rolling24h", "mergeGroup").firstAttempt).toMatchObject({ numerator: 0, denominator: 1 });
  });

  it("keeps synthetic first success when a later attempt fails and caches across windows", async () => {
    const latest = synthetic(1001, { run_attempt: 2, conclusion: "failure" });
    const client = clientFor([latest], { 1001: synthetic() });
    const result = await collectDeliveryHealth(options, { policy, client });
    for (const window of ["rolling24h", "rolling7d", "lastN"]) {
      expect(metric(result, window)).toMatchObject({
        numerator: 0,
        denominator: 1,
        firstAttempt: { numerator: 1, denominator: 1 },
      });
    }
    expect(client.calls.filter((call) => call.includes("/attempts/1"))).toHaveLength(1);
  });

  it.each([
    ["missing", undefined],
    ["id", { id: 1002 }],
    ["workflow", { workflow_id: 456 }],
    ["event", { event: "merge_group" }],
    ["head", { head_sha: "b".repeat(40) }],
    ["attempt", { run_attempt: 2 }],
    ["repository", { repository: { full_name: "other/repo" } }],
    ["incomplete", { status: undefined }],
    ["incomplete pending", { status: "queued", conclusion: undefined }],
    ["unrecognized status", { status: "invalid" }],
    ["inconsistent pending", { status: "queued", conclusion: "success" }],
  ])("makes %s authority unknown while retaining partial observed counts", async (_name, overrides) => {
    const attempt = overrides ? synthetic(1001, overrides) : undefined;
    const first = metric(
      await collect([synthetic(1001, { run_attempt: 2 }), synthetic(1002)], { 1001: attempt }),
    ).firstAttempt;
    expect(first).toMatchObject({ numerator: 1, denominator: 1, unknown: 1, coverage: "partial", successRate: null });
  });

  it("keeps inaccessible and truncated authority unavailable without changing latest SLIs", async () => {
    const runs = [synthetic(1001, { run_attempt: 2 })];
    const good = await collect(runs, { 1001: synthetic() });
    const missing = await collect(runs, {}, { unavailable: true });
    expect(missing.record.slis).toEqual(good.record.slis);
    expect(metric(missing).firstAttempt).toMatchObject({ unknown: 1, successRate: null });
    const truncated = await collect([synthetic()], {}, { truncated: true });
    expect(metric(truncated).firstAttempt).toMatchObject({
      numerator: 1,
      denominator: 1,
      collectionComplete: false,
      coverage: "partial",
      successRate: null,
    });
  });

  it("isolates inaccessible advisory authority through the production HTTP client and keeps canonical issues unchanged", async () => {
    const collectHttp = async (attemptStatus) => {
      const calls = [];
      const optionsHttp = {
        ...options,
        updateIssues: true,
        sleep: async () => {},
        fetchImpl: async (url, request) => {
          calls.push({ url, method: request.method, body: request.body });
          const path = new URL(url).pathname;
          if (path.endsWith("/attempts/1"))
            return new Response(JSON.stringify(synthetic(Number(/\/runs\/(\d+)\/attempts\/1$/.exec(path)[1]))), {
              status: attemptStatus,
            });
          const body =
            path === "/graphql"
              ? {
                  data: {
                    search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
                  },
                }
              : path.includes("platform-pr.yml")
                ? {
                    total_count: 10,
                    workflow_runs: Array.from({ length: 10 }, (_, index) =>
                      synthetic(1001 + index, { run_attempt: 2 }),
                    ),
                  }
                : path.includes("/actions/workflows/")
                  ? { total_count: 0, workflow_runs: [] }
                  : path === "/search/issues"
                    ? {
                        total_count: 1,
                        items: [
                          {
                            id: 2001,
                            number: 2001,
                            state: "open",
                            body: renderSliMarker({
                              sli: "pull-request-ci-success",
                              schemaVersion: "delivery-health-sli/v1",
                            }),
                          },
                        ],
                      }
                    : path.includes("/jobs")
                      ? { total_count: 0, jobs: [] }
                      : path.includes("/contents/")
                        ? {
                            encoding: "base64",
                            content: Buffer.from(JSON.stringify({ enabled: false })).toString("base64"),
                          }
                        : [];
          return new Response(JSON.stringify(body), { status: 200 });
        },
      };
      const result = await collectDeliveryHealth(optionsHttp, { policy });
      return { result, calls };
    };
    const good = await collectHttp(200);
    const missing = await collectHttp(404);
    expect(metric(missing.result).firstAttempt).toMatchObject({ unknown: 10, coverage: "partial", successRate: null });
    expect(missing.result.record.completeness).toEqual(good.result.record.completeness);
    expect(missing.result.record.slis).toEqual(good.result.record.slis);
    expect(missing.result.issueUpdates).toEqual(good.result.issueUpdates);
    expect(missing.result.issueUpdates).toContainEqual({
      sli: "pull-request-ci-success",
      action: "closed",
      issueNumber: 2001,
    });
    expect(missing.calls.filter((call) => call.method !== "GET")).toEqual(
      good.calls.filter((call) => call.method !== "GET"),
    );
  });

  it("rejects duplicate run identities and unsafe latest authority without attempt I/O", async () => {
    const client = clientFor([synthetic(), synthetic(), synthetic(1002, { head_sha: "invalid", run_attempt: 2 })]);
    const result = await collectDeliveryHealth(options, { policy, client });
    expect(metric(result).firstAttempt).toMatchObject({ numerator: 0, denominator: 0, unknown: 3, successRate: null });
    expect(client.calls.filter((call) => call.includes("/attempts/1"))).toEqual([]);
  });

  it("keeps an empty cohort unavailable", async () => {
    expect(metric(await collect([])).firstAttempt).toMatchObject({
      runCount: 0,
      numerator: 0,
      denominator: 0,
      successRate: null,
    });
  });

  it("uses unchanged latest-activity 24h, 7d and independent last-N selection for both views", async () => {
    const runs = [
      synthetic(1001),
      synthetic(1002, { updated_at: "2026-10-02T11:00:00Z", conclusion: "failure" }),
      synthetic(1003, { updated_at: "2026-09-26T11:00:00Z" }),
      synthetic(1004, { event: "merge_group" }),
    ];
    const result = await collect(runs, {}, {}, { ...policy, windows: { ...policy.windows, lastN: 1 } });
    for (const [window, ids] of [
      ["rolling24h", [1001]],
      ["rolling7d", [1001, 1002]],
      ["lastN", [1001]],
    ]) {
      expect(metric(result, window).runCount).toBe(ids.length);
      expect(metric(result, window).firstAttempt.runIds).toEqual(ids);
      expect(metric(result, window)).toMatchObject({ numerator: 1, denominator: ids.length });
      expect(metric(result, window).firstAttempt).toMatchObject({ numerator: 1, denominator: ids.length });
      expect(metric(result, window, "mergeGroup").firstAttempt.runIds).toEqual([1004]);
    }
  });

  it("publishes via the actual scheduled command seam, with omitted authority as a negative control", async () => {
    const directory = await mkdtemp(join(tmpdir(), "delivery-health-8266-"));
    try {
      const out = join(directory, "delivery-health.json");
      const markdown = join(directory, "delivery-health.md");
      const summary = join(directory, "summary.md");
      const output = join(directory, "output.txt");
      const runs = [synthetic(1001, { run_attempt: 2 }), synthetic(1002, { event: "merge_group" })];
      const args = [
        "--repository",
        repository,
        "--checked-at",
        checkedAt,
        "--publication-mode",
        "hourly",
        "--out",
        out,
        "--markdown-out",
        markdown,
        "--github-summary",
        summary,
        "--github-output",
        output,
      ];
      const deps = { policy, client: clientFor(runs, { 1001: synthetic(1001, { conclusion: "failure" }) }) };
      expect(await runDeliveryHealthCommand(args, {}, deps)).toBe(0);
      const good = JSON.parse(await readFile(out, "utf8"));
      const rendered = await readFile(markdown, "utf8");
      expect(await readFile(summary, "utf8")).toContain(rendered);
      expect(rendered).toContain("existing latest-activity run cohort");
      expect(rendered).toContain("completed attempt-1 success over determinate completed success/failure outcomes");
      expect(rendered).toContain("pull_request | 100% (1/1) | 0/1 (0.0%) | complete | 0");
      expect(rendered).toContain("merge_group | 100% (1/1) | 1/1 (100.0%) | complete | 0");
      expect(rendered).toContain("Exclusions (cancelled / skipped / neutral / pending)");
      expect(await runDeliveryHealthCommand(args, {}, { policy, client: clientFor(runs) })).toBe(0);
      const missing = JSON.parse(await readFile(out, "utf8"));
      expect(missing.slis).toEqual(good.slis);
      expect(missing.slis).toHaveLength(8);
      expect(await readFile(markdown, "utf8")).toContain("0/0 (unavailable) | partial | 1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
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
  it("accepts provider-shaped multi-page search links but refuses a changed search path", async () => {
    const execute = async (changed) => {
      const client = createGitHubClient(
        {
          repository: "chase-sets/chase-sets",
          fetchImpl: async (url) => {
            const parsed = new URL(url);
            const page = Number(parsed.searchParams.get("page"));
            const headers = {};
            if (page === 1) {
              const next = new URL(parsed);
              if (changed) next.pathname += "X";
              next.searchParams.set("page", "2");
              headers.link = `<${next.href}>; rel="next"`;
            }
            return new Response(JSON.stringify({ total_count: 2, items: [{ id: page }] }), { headers });
          },
          sleep: async () => {},
        },
        { maxPages: 2, retries: 0 },
      );
      return client.paginate(
        "https://api.github.com/search/issues?q=repo%3Achase-sets%2Fchase-sets&per_page=1",
        (payload) => payload.items,
        {
          source: "search",
          requireTotal: true,
        },
      );
    };
    await expect(execute(false)).resolves.toHaveLength(2);
    await expect(execute(true)).rejects.toThrow("collection_incomplete");
  });

  it("uses REST filename as pull-file identity when provider omits ids", async () => {
    const client = createGitHubClient(
      {
        repository: qualificationRepository,
        fetchImpl: async () =>
          new Response(JSON.stringify([{ filename: "pnpm-lock.yaml" }, { filename: "src/feature.ts" }])),
        sleep: async () => {},
      },
      { maxPages: 1, retries: 0 },
    );
    await expect(fetchPullFiles(client, 1, 1)).resolves.toHaveLength(2);
  });

  it("keeps selected PR enrichment bounded and partial per PR", async () => {
    let active = 0;
    let maxActive = 0;
    const queries = [];
    const pulls = Array.from({ length: 8 }, (_, index) => ({
      number: index + 1,
      state: "MERGED",
      isDraft: true,
      createdAt: "2026-07-20T00:00:00Z",
      updatedAt: "2026-07-20T02:00:00Z",
      mergedAt: "2026-07-20T01:00:00Z",
      timelineItems: { nodes: [{ createdAt: "2026-07-20T01:00:00Z" }] },
    }));
    const enter = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    };
    const client = {
      json: async (path, request = {}) => {
        if (path === "https://api.github.com/graphql") queries.push(request.body.query);
        if (path === "https://api.github.com/graphql")
          return {
            data: {
              search: { issueCount: pulls.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: pulls },
            },
          };
        if (String(path).endsWith("/pulls/8")) throw new Error("GitHub API request failed: 403");
        await enter();
        if (String(path).includes("/workflows/")) return { total_count: 0, workflow_runs: [] };
        return { changed_files: 2 };
      },
      paginate: async (path, _select, pagination = {}) => {
        if (String(path).includes("/pulls/") && String(path).includes("/files")) {
          const files = [
            { filename: "pnpm-lock.yaml", additions: 500, deletions: 0 },
            { filename: "src/feature.ts", additions: 10, deletions: 2 },
          ];
          for (const file of files) expect(() => pagination.identity(file)).not.toThrow();
          await enter();
          return files;
        }
        if (String(path).includes("/pulls/") && String(path).includes("/reviews")) {
          await enter();
          return [];
        }
        return [];
      },
      status: () => ({ truncated: [], errors: [] }),
    };
    const result = await collectDeliveryHealth(
      {
        repository: qualificationRepository,
        checkedAt: qualificationCheckedAt,
        publicationMode: "hourly",
        updateIssues: false,
        fetchImpl: async () => new Response("{}"),
      },
      { policy, client },
    );
    expect(maxActive).toBeLessThanOrEqual(policy.collection.concurrency);
    expect(queries.every((query) => !query.includes("files(") && !query.includes("reviews("))).toBe(true);
    expect(queries.some((query) => query.includes("READY_FOR_REVIEW_EVENT"))).toBe(true);
    expect(result.record.completeness.reasons).toContain("truncated:pull-request-nested-data");
    expect(result.record.completeness.reasons).not.toContain("source:pull-requests");
    expect(result.record.windows.rolling7d.prs.created).toBe(8);
    expect(result.record.windows.rolling7d.prs.nonGeneratedChurn.p50).toBe(12);
    expect(result.record.windows.rolling7d.prs.creationToReadySeconds.p50).toBe(3600);
  });

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

  it("accepts provider repository-id Link paths while pinning one repository id", async () => {
    const client = createGitHubClient(
      {
        repository: "chase-sets/chase-sets",
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          const page = Number(parsed.searchParams.get("page"));
          const headers = {};
          if (page === 1) {
            const next = new URL(parsed);
            next.pathname = "/repositories/1151866225/issues";
            next.searchParams.set("page", "2");
            headers.link = `<${next.href}>; rel="next"`;
          }
          return new Response(JSON.stringify({ total_count: 2, items: [{ id: page }] }), { headers });
        },
        sleep: async () => {},
      },
      { maxPages: 2, retries: 0 },
    );
    await expect(client.paginate("/issues?per_page=1", (payload) => payload.items)).resolves.toHaveLength(2);
  });

  it("refuses a provider repository-id Link that changes identity between pages", async () => {
    const client = createGitHubClient(
      {
        repository: "chase-sets/chase-sets",
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          const page = Number(parsed.searchParams.get("page"));
          const headers = {};
          if (page === 1) {
            const next = new URL(parsed);
            next.pathname = "/repositories/100/issues";
            next.searchParams.set("page", "2");
            headers.link = `<${next.href}>; rel="next"`;
          } else if (page === 2) {
            const next = new URL(parsed);
            next.pathname = "/repositories/200/issues";
            next.searchParams.set("page", "3");
            headers.link = `<${next.href}>; rel="next"`;
          }
          return new Response(JSON.stringify({ items: page < 3 ? [{ id: page }] : [] }), { headers });
        },
        sleep: async () => {},
      },
      { maxPages: 3, retries: 0 },
    );
    await expect(
      client.paginate("https://api.github.com/repositories/100/issues?per_page=1", (payload) => payload.items),
    ).rejects.toThrow("collection_incomplete");
  });

  it("refuses a repository-id Link whose suffix changes", async () => {
    const client = createGitHubClient(
      {
        repository: "chase-sets/chase-sets",
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          const page = Number(parsed.searchParams.get("page"));
          if (page === 1) {
            const next = new URL(parsed);
            next.pathname = "/repositories/100/pulls";
            next.searchParams.set("page", "2");
            return new Response(JSON.stringify({ items: [{ id: 1 }] }), {
              headers: { link: `<${next.href}>; rel="next"` },
            });
          }
          return new Response(JSON.stringify({ items: [] }));
        },
        sleep: async () => {},
      },
      { maxPages: 2, retries: 0 },
    );
    await expect(
      client.paginate("https://api.github.com/repositories/100/issues?per_page=1", (payload) => payload.items),
    ).rejects.toThrow("collection_incomplete");
  });

  it("retries an empty successful body inside the request budget", async () => {
    let calls = 0;
    const client = createGitHubClient(
      {
        repository: "chase-sets/chase-sets",
        fetchImpl: async () => new Response(++calls === 1 ? "" : JSON.stringify({ ok: true })),
        sleep: async () => {},
      },
      { retries: 1 },
    );
    await expect(client.json("/synthetic-empty-body")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("refuses a persistent empty successful body", async () => {
    let calls = 0;
    const client = createGitHubClient(
      {
        repository: "chase-sets/chase-sets",
        fetchImpl: async () => {
          calls += 1;
          return new Response("");
        },
        sleep: async () => {},
      },
      { retries: 1 },
    );
    await expect(client.json("/synthetic-empty-body")).rejects.toThrow("github-response-invalid");
    expect(calls).toBe(2);
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
      "collection_incomplete",
    );
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
    expect(record.slis.every((sli) => sli.status === "insufficient-data")).toBe(true);
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
    expect(omitted.record.slis.every((sli) => sli.status === "insufficient-data")).toBe(true);
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
            search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        };
      }
      if (String(request).includes("platform-ephemeral-verification.yml")) {
        return { total_count: 1, workflow_runs: [ephemeralRun] };
      }
      return { total_count: 0, workflow_runs: [] };
    },
    paginate: async (request) => {
      if (String(request).includes("platform-ephemeral-verification.yml")) return [ephemeralRun];
      if (String(request).includes("/actions/runs/900/jobs")) return [ephemeralJob("success")];
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
