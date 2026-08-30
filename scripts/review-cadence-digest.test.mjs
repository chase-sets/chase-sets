import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import {
  buildCadenceDigest,
  classifyCadenceComment,
  collectDigestAuthority,
  DEFAULT_LEDGER_COMMENT_LIMIT,
  DEFAULT_REVIEW_PASS_LIMIT,
  parseSuccessorAuthority,
  renderShelfDigest,
  runReviewCadenceDigest,
} from "./review-cadence-digest.mjs";

const DIGEST_AT = "2026-08-30T12:00:00.000Z";
const day = (days) => new Date(Date.parse(DIGEST_AT) - days * 86_400_000).toISOString();

function issue(number, ageDays = 30) {
  return {
    number,
    state: "open",
    title: `Synthetic shelf issue ${number}`,
    html_url: `https://github.synthetic.invalid/issues/${number}`,
    created_at: day(100),
    updated_at: day(1),
    labels: [{ name: "status:needs-replan" }],
    _ageDays: ageDays,
  };
}

function response(body, link = null) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === "link" ? link : null) },
    json: async () => body,
    text: async () => "",
  };
}

function authorityRequest(rows, mutate = {}) {
  const calls = [];
  const byNumber = new Map(rows.map((row) => [row.number, row]));
  let lifecycleReads = 0;
  let successorReads = 0;
  const request = vi.fn(async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url: url.href, init });
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q");
      const current = query.includes("label:");
      if (current) return response({ total_count: rows.length, incomplete_results: false, items: [] });
      const page = Number(url.searchParams.get("page") ?? 1);
      const values = page === 1 ? rows.slice(0, 100) : rows.slice(100);
      const link =
        page === 1 && rows.length > 100
          ? `<${url.origin}${url.pathname}?${new URLSearchParams({ q: query, per_page: "100", page: "2" })}>; rel="next"`
          : null;
      return response({ total_count: rows.length, incomplete_results: false, items: values }, link);
    }
    if (url.pathname.endsWith("/issues") && url.searchParams.has("labels")) {
      const page = Number(url.searchParams.get("page") ?? 1);
      const values = page === 1 ? rows.slice(0, 100) : rows.slice(100);
      const link =
        page === 1 && rows.length > 100
          ? `<${url.origin}${url.pathname}?${new URLSearchParams({ state: "open", labels: "status:needs-replan", per_page: "100", page: "2" })}>; rel="next"`
          : null;
      return response(values, link);
    }
    if (url.pathname.endsWith("/issues/comments")) return response([]);
    const commentMatch = /\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentMatch) {
      successorReads += 1;
      return response(mutate.comments?.(Number(commentMatch[1]), successorReads) ?? []);
    }
    const issueMatch = /\/issues\/(\d+)$/.exec(url.pathname);
    if (issueMatch) return response(byNumber.get(Number(issueMatch[1])));
    if (url.pathname === "/graphql") {
      const body = JSON.parse(init.body);
      const number = body.variables.number;
      if (body.query.includes("REVIEW_CADENCE_DEPENDENCIES")) {
        successorReads += 1;
        const nodes = mutate.dependencies?.(number, successorReads) ?? [];
        return response({
          data: {
            repository: {
              issue: {
                blockedBy: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes },
              },
            },
          },
        });
      }
      lifecycleReads += 1;
      const row = byNumber.get(number);
      const nodes = mutate.lifecycle?.(number, lifecycleReads) ?? [
        {
          id: `label-${number}`,
          __typename: "LabeledEvent",
          createdAt: day(row._ageDays),
          label: { name: "status:needs-replan" },
        },
      ];
      return response({
        data: {
          repository: {
            issue: {
              number: row.number,
              state: "OPEN",
              title: row.title,
              url: row.html_url,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              labels: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ name: "status:needs-replan" }],
              },
              timelineItems: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes },
            },
          },
        },
      });
    }
    throw new Error(`Unhandled synthetic request: ${url.href}`);
  });
  return { calls, request };
}

describe("review cadence digest", () => {
  it("classifies comprehensive review passes", () => {
    expect(classifyCadenceComment("Twenty-ninth Comprehensive Review Update — no new issue was needed")).toBe(
      "review-pass",
    );
    expect(classifyCadenceComment("30th comprehensive review")).toBe("review-pass");
  });

  it("classifies ledger-style evidence comments", () => {
    expect(classifyCadenceComment("Evidence update: record this row in the #1116 launch matrix")).toBe("ledger");
    expect(classifyCadenceComment("Latest-main correction: deploy run superseded")).toBe("ledger");
    expect(classifyCadenceComment("current-main revalidation required before closure")).toBe("ledger");
  });

  it("leaves ordinary comments unclassified", () => {
    expect(classifyCadenceComment("LGTM, merging after CI")).toBe("other");
    expect(classifyCadenceComment("The review of this PR found a bug in the cart totals")).toBe("other");
  });

  it("stays clean within limits", () => {
    const digest = buildCadenceDigest([
      { body: "Weekly comprehensive review: closed #1, delivered #2", html_url: "u1" },
      { body: "normal discussion", html_url: "u2" },
    ]);
    expect(digest.flagged).toBe(false);
    expect(digest.reviewPassCount).toBe(1);
    expect(digest.markdown).toContain("Clean");
  });

  it("flags when review passes exceed the weekly cap", () => {
    const digest = buildCadenceDigest([
      { body: "29th Comprehensive Review Update", html_url: "u1" },
      { body: "30th Comprehensive Review Update", html_url: "u2" },
    ]);
    expect(digest.flagged).toBe(true);
    expect(digest.markdown).toContain("Flagged");
    expect(digest.markdown).toContain("u1");
  });

  it("flags ledger comment storms", () => {
    const comments = Array.from({ length: DEFAULT_LEDGER_COMMENT_LIMIT + 1 }, (_, index) => ({
      body: `Evidence update ${index}: add to the launch matrix`,
      html_url: `u${index}`,
    }));
    const digest = buildCadenceDigest(comments);
    expect(digest.flagged).toBe(true);
    expect(digest.ledgerCommentCount).toBe(DEFAULT_LEDGER_COMMENT_LIMIT + 1);
  });

  it("exposes the default limits", () => {
    expect(DEFAULT_REVIEW_PASS_LIMIT).toBe(1);
    expect(DEFAULT_LEDGER_COMMENT_LIMIT).toBe(10);
  });

  it("reports complete needs-replan count, age buckets, and week-over-week delta at one stable digest instant", async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      issue(index + 1, index === 100 ? 40 : index === 0 ? 7 : index === 1 ? 14 : index === 2 ? 28 : 30),
    );
    const fixture = authorityRequest(rows);

    const result = await collectDigestAuthority({
      repo: "synthetic-owner/synthetic-repo",
      token: "withheld-synthetic-token",
      request: fixture.request,
      clock: () => new Date(DIGEST_AT),
    });

    expect(result.currentCount).toEqual({ available: true, value: 101 });
    expect(result.ageBuckets).toEqual({
      available: true,
      value: { "[0,7)": 0, "[7,14)": 1, "[14,28)": 1, "[28,∞)": 99 },
    });
    expect(result.weeklyDelta).toEqual({ available: true, value: 0 });
    expect(result.escalations.value.eligible).toHaveLength(99);
    expect(result.escalations.value.eligible[0].issue.number).toBe(101);
    expect(fixture.calls.some((call) => new URL(call.url).searchParams.get("page") === "2")).toBe(true);
    expect(
      fixture.calls.filter(
        (call) => call.init.method && !(call.init.method === "POST" && new URL(call.url).pathname === "/graphql"),
      ),
    ).toEqual([]);
    expect(result.budget.requests).toBeLessThanOrEqual(1_000);
    expect(result.budget.nodes).toBeLessThanOrEqual(50_000);
  });

  it("selects the weekly drain target only after structured successor authority is complete", () => {
    const repo = "synthetic-owner/synthetic-repo";
    const canonical = {
      id: 1,
      body: "PLANNING_CONTRACT_VERSION: planning-repair/v1\nDISPOSITION: REPLACED\nORIGINAL_ISSUE: #6410\nREPLACEMENTS: #6415",
      updated_at: DIGEST_AT,
    };
    const legacy = {
      id: 2,
      body: "disposition REPLACED (planning-repair/v1)\nReplacement: #6415",
      updated_at: DIGEST_AT,
    };
    const native = [{ id: "dependency-6415", number: 6415, repo }];

    expect(parseSuccessorAuthority([canonical], native, 6410, repo).value.classification).toBe("qualified");
    expect(parseSuccessorAuthority([legacy], native, 6410, repo).value.classification).toBe("qualified");
    expect(parseSuccessorAuthority([], [{ id: "decision", number: 7419, repo }], 7424, repo).value.classification).toBe(
      "confirmed-none",
    );
    expect(parseSuccessorAuthority([canonical], [], 6410, repo)).toEqual({
      available: false,
      reason: "SUCCESSOR_RECEIPT_NATIVE_LINK_MISSING",
    });
    expect(
      parseSuccessorAuthority([{ ...canonical, body: "DISPOSITION: REPLACED" }], native, 6410, repo).available,
    ).toBe(false);
    expect(parseSuccessorAuthority([canonical, legacy], native, 6410, repo).available).toBe(false);
  });

  it("returns unavailable instead of clipping or overrunning bounded shelf authority", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => issue(index + 1));
    const clipped = await collectDigestAuthority({
      repo: "synthetic-owner/synthetic-repo",
      token: "withheld",
      request: authorityRequest(rows).request,
      clock: () => new Date(DIGEST_AT),
      limits: { connectionNodes: 100 },
    });
    expect(clipped.currentCount).toEqual({ available: false, reason: "CURRENT_INITIAL_LIST_NODE_BUDGET_EXHAUSTED" });

    const moving = authorityRequest([issue(6410)], {
      lifecycle: (number, read) => [
        {
          id: `label-${number}`,
          __typename: "LabeledEvent",
          createdAt: read > 1 ? day(29) : day(30),
          label: { name: "status:needs-replan" },
        },
      ],
    });
    const moved = await collectDigestAuthority({
      repo: "synthetic-owner/synthetic-repo",
      token: "withheld",
      request: moving.request,
      clock: () => new Date(DIGEST_AT),
    });
    expect(moved.currentCount.available).toBe(false);
    expect(renderShelfDigest(moved)).toContain("unavailable (ISSUE_6410_AUTHORITY_MOVED)");

    const receiptEdit = authorityRequest([issue(6410)], {
      comments: (number, read) => [
        {
          id: 1,
          body:
            read >= 3
              ? "PLANNING_CONTRACT_VERSION: planning-repair/v1\nDISPOSITION: REPLACED\nORIGINAL_ISSUE: #6410\nREPLACEMENTS: #6416"
              : "PLANNING_CONTRACT_VERSION: planning-repair/v1\nDISPOSITION: REPLACED\nORIGINAL_ISSUE: #6410\nREPLACEMENTS: #6415",
          updated_at: read >= 3 ? day(0) : day(1),
        },
      ],
      dependencies: () => [
        {
          id: "dependency-6415",
          number: 6415,
          repository: { nameWithOwner: "synthetic-owner/synthetic-repo" },
        },
      ],
    });
    const edited = await collectDigestAuthority({
      repo: "synthetic-owner/synthetic-repo",
      token: "withheld",
      request: receiptEdit.request,
      clock: () => new Date(DIGEST_AT),
    });
    expect(edited.escalations.value.unavailable[0].reason).toBe("ISSUE_6410_SUCCESSOR_AUTHORITY_MOVED");

    const dependencyAdd = authorityRequest([issue(7424)], {
      dependencies: (number, read) =>
        read >= 4
          ? [{ id: "dependency-7419", number: 7419, repository: { nameWithOwner: "synthetic-owner/synthetic-repo" } }]
          : [],
    });
    const relinked = await collectDigestAuthority({
      repo: "synthetic-owner/synthetic-repo",
      token: "withheld",
      request: dependencyAdd.request,
      clock: () => new Date(DIGEST_AT),
    });
    expect(relinked.escalations.value.unavailable[0].reason).toBe("ISSUE_7424_SUCCESSOR_AUTHORITY_MOVED");
  });

  it("drives the scheduled digest entrypoint from collected shelf authority, not fixture-only input", async () => {
    const output = [];
    const summaries = [];
    const authority = {
      digestAt: DIGEST_AT,
      cadenceComments: { available: true, value: [] },
      currentCount: { available: true, value: 0 },
      ageBuckets: { available: true, value: { "[0,7)": 0, "[7,14)": 0, "[14,28)": 0, "[28,∞)": 0 } },
      weeklyDelta: { available: true, value: 0 },
      escalations: { available: true, value: { eligible: [], unavailable: [] } },
    };
    const run = await runReviewCadenceDigest({
      env: { GITHUB_REPOSITORY: "synthetic/repo", GITHUB_TOKEN: "withheld" },
      collectAuthority: vi.fn(async () => authority),
      writeOutput: (value) => output.push(value),
      appendSummary: async (value) => summaries.push(value),
    });
    expect(run).toBe(0);
    expect(output[0]).toContain("## Needs-replan shelf");
    expect(summaries[0]).toContain("Current count: 0");

    const omitted = await runReviewCadenceDigest({
      env: { GITHUB_REPOSITORY: "synthetic/repo", GITHUB_TOKEN: "withheld" },
      collectAuthority: vi.fn(async () => ({ cadenceComments: { available: true, value: [] } })),
      writeOutput: (value) => output.push(value),
    });
    expect(omitted).toBe(2);
    expect(output.at(-1)).toContain("omitted the live needs-replan shelf source");

    const withheldCollector = vi.fn();
    expect(
      await runReviewCadenceDigest({
        env: { GITHUB_REPOSITORY: "synthetic/repo" },
        collectAuthority: withheldCollector,
        writeOutput: (value) => output.push(value),
      }),
    ).toBe(2);
    expect(withheldCollector).not.toHaveBeenCalled();
  });

  it("keeps shelf collection query-only and isolates issue-write permission to the reporter job", () => {
    const workflow = parse(readFileSync(".github/workflows/review-cadence-digest.yml", "utf8"));
    const jobs = Object.values(workflow.jobs);
    const reporterCandidates = jobs.filter((job) =>
      job.steps?.some((step) => step.uses === "./.github/actions/report-scheduled-workflow-alert"),
    );
    const scanned = { scannedCandidates: jobs.length, totalCandidates: reporterCandidates.length };
    expect(scanned).toEqual({ scannedCandidates: 2, totalCandidates: 1 });
    expect(workflow.jobs.digest.permissions).toEqual({ contents: "read", issues: "read" });
    expect(reporterCandidates[0].permissions).toEqual({ contents: "read", issues: "write" });
    expect(workflow.jobs.digest.steps.filter((step) => step.uses?.includes("report-scheduled-workflow-alert"))).toEqual(
      [],
    );
    expect(workflow.jobs.digest.steps.find((step) => step.name === "Build digest").env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
    });
  });
});
