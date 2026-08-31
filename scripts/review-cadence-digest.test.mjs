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

function noncurrentIssue(number, ageDays = 30) {
  return {
    ...issue(number, ageDays),
    state: "closed",
    labels: [],
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

function connectionPage(nodes, after, cursor) {
  const start = after === null ? 0 : 100;
  const pageNodes = nodes.slice(start, start + 100);
  const hasNextPage = start + 100 < nodes.length;
  return {
    totalCount: nodes.length,
    pageInfo: { hasNextPage, endCursor: hasNextPage ? cursor : null },
    nodes: pageNodes,
  };
}

function authorityRequest(rows, mutate = {}) {
  const calls = [];
  const updatedRows = mutate.updatedRows ?? rows;
  const repositoryComments = mutate.repositoryComments ?? [];
  const byNumber = new Map([...rows, ...updatedRows].map((row) => [row.number, row]));
  const reads = new Map();
  const paged = (url, values) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    const start = (page - 1) * 100;
    const pageValues = values.slice(start, start + 100);
    let link = null;
    if (start + 100 < values.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      link = `<${next.href}>; rel="next"`;
    }
    return { pageValues, link };
  };
  const request = vi.fn(async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url: url.href, init });
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q");
      const current = query.includes("label:");
      if (current) {
        const perPage = Number(url.searchParams.get("per_page") ?? 100);
        return response({ total_count: rows.length, incomplete_results: false, items: rows.slice(0, perPage) });
      }
      const { pageValues, link } = paged(url, updatedRows);
      return response({ total_count: updatedRows.length, incomplete_results: false, items: pageValues }, link);
    }
    if (url.pathname.endsWith("/issues") && url.searchParams.has("labels")) {
      const { pageValues, link } = paged(url, rows);
      return response(pageValues, link);
    }
    if (url.pathname.endsWith("/issues/comments")) {
      const { pageValues, link } = paged(url, repositoryComments);
      let nextLink = link;
      if (!nextLink && mutate.repositoryCommentsHasContinuation) {
        const next = new URL(url);
        next.searchParams.set("page", String(Number(url.searchParams.get("page") ?? 1) + 1));
        nextLink = `<${next.href}>; rel="next"`;
      }
      return response(pageValues, nextLink);
    }
    if (url.pathname === "/graphql") {
      const body = JSON.parse(init.body);
      const marker = /REVIEW_CADENCE_(COMMENTS|DEPENDENCIES|LIFECYCLE)_(INITIAL|FINAL)_BATCH/.exec(body.query);
      if (!marker) throw new Error(`Unhandled synthetic GraphQL query: ${body.query}`);
      const kind = marker[1].toLowerCase();
      const phase = marker[2];
      const repository = {};
      for (let index = 0; body.variables[`number${index}`] !== undefined; index += 1) {
        const number = body.variables[`number${index}`];
        const after = body.variables[`after${index}`];
        const row = byNumber.get(number);
        const key = `${kind}:${phase}:${number}`;
        const read = (reads.get(key) ?? 0) + 1;
        reads.set(key, read);
        let nodes;
        if (kind === "comments") nodes = mutate.comments?.(number, phase, read, after) ?? [];
        else if (kind === "dependencies") nodes = mutate.dependencies?.(number, phase, read, after) ?? [];
        else
          nodes = mutate.lifecycle?.(number, phase, read, after) ?? [
            {
              id: `label-${number}`,
              __typename: "LabeledEvent",
              createdAt: day(row._ageDays),
              label: { name: "status:needs-replan" },
            },
            ...(row.state === "closed"
              ? [{ id: `closed-${number}`, __typename: "ClosedEvent", createdAt: day(1) }]
              : []),
          ];
        const connection = Array.isArray(nodes)
          ? { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes }
          : nodes;
        const normalized =
          kind === "comments"
            ? {
                ...connection,
                nodes: connection.nodes.map((comment) => ({
                  id: String(comment.id),
                  body: comment.body,
                  updatedAt: comment.updatedAt ?? comment.updated_at,
                })),
              }
            : connection;
        repository[`issue${index}`] = {
          number,
          ...(kind === "lifecycle"
            ? {
                state: row.state.toUpperCase(),
                title: row.title,
                url: row.html_url,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                labels: {
                  totalCount: row.labels.length,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: row.labels.map((label) => ({ name: label.name })),
                },
              }
            : {}),
          [kind === "comments" ? "comments" : kind === "dependencies" ? "blockedBy" : "timelineItems"]: normalized,
        };
      }
      return response({ data: { repository } });
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

  it("keeps production-shaped shelf authority below the global request ceiling with independent pagination", async () => {
    const current = Array.from({ length: 125 }, (_, index) => issue(index + 1));
    const updated = [...current.slice(110), ...Array.from({ length: 165 }, (_, index) => noncurrentIssue(index + 126))];
    const repositoryComments = Array.from({ length: 408 }, (_, index) => ({
      id: index + 1,
      body: `Synthetic cadence comment ${index + 1}`,
      updated_at: day(1),
    }));
    const paginatedComments = Array.from({ length: 101 }, (_, index) => ({
      id: `comment-${index + 1}`,
      body: `Ordinary comment ${index + 1}`,
      updatedAt: day(1),
    }));
    const paginatedDependencies = Array.from({ length: 101 }, (_, index) => ({
      id: `dependency-${index + 1}`,
      number: 10_000 + index,
      repository: { nameWithOwner: "synthetic-owner/synthetic-repo" },
    }));
    const paginatedLifecycle = [
      {
        id: "label-1",
        __typename: "LabeledEvent",
        createdAt: day(30),
        label: { name: "status:needs-replan" },
      },
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `other-label-${index + 1}`,
        __typename: "LabeledEvent",
        createdAt: day(29),
        label: { name: `synthetic:other-${index + 1}` },
      })),
    ];
    const mutation = {
      updatedRows: updated,
      repositoryComments,
      comments: (number, phase, _read, after) =>
        number === 1 ? connectionPage(paginatedComments, after, `comments-${phase}`) : [],
      dependencies: (number, phase, _read, after) =>
        number === 1 ? connectionPage(paginatedDependencies, after, `dependencies-${phase}`) : [],
      lifecycle: (number, phase, _read, after) => {
        if (number === 1) return connectionPage(paginatedLifecycle, after, `lifecycle-${phase}`);
        const row = updated.find((candidate) => candidate.number === number) ?? current[number - 1];
        return [
          {
            id: `label-${number}`,
            __typename: "LabeledEvent",
            createdAt: day(row._ageDays),
            label: { name: "status:needs-replan" },
          },
          ...(row.state === "closed" ? [{ id: `closed-${number}`, __typename: "ClosedEvent", createdAt: day(1) }] : []),
        ];
      },
    };
    const exactRequiredRequests = 63;
    const result = await collectDigestAuthority({
      repo: "synthetic-owner/synthetic-repo",
      token: "withheld-production-shape",
      request: authorityRequest(current, mutation).request,
      clock: () => new Date(DIGEST_AT),
      limits: { requests: exactRequiredRequests },
    });

    expect(result.budget.requests).toBe(exactRequiredRequests);
    expect(result.budget.requests).toBeLessThan(1_000);
    expect(result.currentCount).toEqual({ available: true, value: 125 });
    expect(result.ageBuckets).toEqual({
      available: true,
      value: { "[0,7)": 0, "[7,14)": 0, "[14,28)": 0, "[28,∞)": 125 },
    });
    expect(result.weeklyDelta).toEqual({ available: true, value: -165 });
    expect(result.escalations).toMatchObject({ available: true });

    const exhausted = await collectDigestAuthority({
      repo: "synthetic-owner/synthetic-repo",
      token: "withheld-production-shape",
      request: authorityRequest(current, mutation).request,
      clock: () => new Date(DIGEST_AT),
      limits: { requests: exactRequiredRequests - 1 },
    });
    expect([exhausted.currentCount, exhausted.ageBuckets, exhausted.weeklyDelta, exhausted.escalations]).toEqual(
      Array.from({ length: 4 }, () => ({ available: false, reason: "GLOBAL_REQUEST_BUDGET_EXHAUSTED" })),
    );
    const rendered = renderShelfDigest(exhausted);
    expect(rendered).not.toContain("Current count: 125");
    expect(rendered).not.toContain("Week-over-week delta: -165");
  });

  it("selects the weekly drain target only after structured successor authority is complete", async () => {
    const repo = "synthetic-owner/synthetic-repo";
    const canonical = {
      id: 1,
      body: "PLANNING_CONTRACT_VERSION: planning-repair/v1\nDISPOSITION: REPLACED\nORIGINAL_ISSUE: #6410\nREPLACEMENTS: #6415",
      updated_at: DIGEST_AT,
    };
    const legacy = {
      id: 2,
      body: `## Forced replan — disposition REPLACED (planning-repair/v1)

The second independent semantic review (round R2, 2026-08-01, BLOCK_REPLAN, 6 findings) established that this issue's governing surface claim — binding "packaged chart content" while excluding README.md because "Helm does not package it" — is contradicted by Helm 3.15.4, which packages README.md and all three upstream *-values.yaml files. Re-choosing that surface changes acceptance semantics, so per planning-repair/v1 this is a replacement, not a third in-place repair.

**Replacement: #6415 — Bind deployment-affecting doks-ingress chart content to a strictly increasing Chart.yaml version.**

- This issue is relabelled open **status:tracking-only** and stays open until #6415 lands and satisfies its outcome (continuity: #6125 → #6410 → #6415; #6125 stays open tracking behind it). Native edge wired: #6410 Blocked by #6415.
- R2 finding map, answered in #6415: R2-F1 → D2 + AC15 (truthful deployment-affecting partition with fail-closed default arm DOKS_INGRESS_UNCLASSIFIED_CHART_FILE); R2-F2 → native serial edge #6166 Blocked by #6415 (shared scripts/doks-cluster-addons.test.mjs) and corrected chain declarations in both bodies; R2-F3 → scope fence rewritten consistent with D5/D6/AC10; R2-F4 → AC6 full clause-11 matrix plus named type-order mutant; R2-F5 → AC7 three distinct pass shapes; R2-F6 → AC11 exact sequential same-absolute-root parity procedure.
- Round-R1 controls cleared by the R2 review are carried forward unchanged: AC7 reachability matrix and skip control (R1-F1), AC12 explicit-candidate aggregate perturbation (R1-F2), AC6 lossless/build-neutrality rows and Number-coercion mutant (R1-F3), AC8 values.yaml/Chart.yaml shape coverage and classifier mutant (R1-F4), AC4 exact-vector seam evidence (N1).
- Read-only salvage unchanged: codex/issue-6125-doks-chart-version-guard @ 71ab434ac6cdd631d6ae7161627ea68e22eac8e3 (merge-base 36479763bb7dbfea0da150d9cde3786577bbe555). PR #6134 stays closed, draft, untouched.
- #6415 live body identity (read twice): 62,610 UTF-8 bytes, SHA-256 3d1986bfa4ce7ab7115dd687bc0d05135e53e2851ef508835c096e4fd5b4a50a. Prospective structural readiness of that body with status:needs-replan simulated removed: ready, 11/11, 15 ACs.
- #6415 deliberately carries **status:needs-replan** until a fresh independent semantic review of that exact body passes; do not dispatch implementation before then.

This comment records planning-lane bookkeeping; no product code, branch, or PR was created.`,
      updated_at: DIGEST_AT,
    };
    const native = [{ id: "dependency-6415", number: 6415, repo }];
    const nonReplacementComments = [
      {
        number: 6419,
        comment: {
          id: "repair-in-place-6419",
          body: `PLANNING_CONTRACT_VERSION: planning-repair/v1
DISPOSITION: REPAIR_IN_PLACE — claim-token/content-revision/review-attempt unchanged
ORIGINAL_ISSUE: #6419
REPLACEMENTS: none`,
          updated_at: DIGEST_AT,
        },
      },
      {
        number: 6407,
        comment: {
          id: "version-only-prose-6407",
          body: `PLANNING_CONTRACT_VERSION: planning-repair/v1

ROLE: DOWNSTREAM CONTINUITY — operator execution remains blocked pending the current issue.`,
          updated_at: DIGEST_AT,
        },
      },
    ];

    expect(parseSuccessorAuthority([canonical], native, 6410, repo).value.classification).toBe("qualified");
    expect(parseSuccessorAuthority([legacy], native, 6410, repo).value.classification).toBe("qualified");
    expect(parseSuccessorAuthority([], [{ id: "decision", number: 7419, repo }], 7424, repo).value.classification).toBe(
      "confirmed-none",
    );
    for (const disposition of ["PASS", "BLOCK_FIXABLE"]) {
      const reviewReport = {
        id: `review-${disposition}`,
        body: `REVIEW_CONTRACT_VERSION: review-contract/v2\nDISPOSITION: ${disposition}\nThis report mentions planning-repair/v1 and requires REPAIR_IN_PLACE follow-up.`,
        updated_at: DIGEST_AT,
      };
      expect(parseSuccessorAuthority([reviewReport], [], 7424, repo)).toEqual({
        available: true,
        value: { classification: "confirmed-none", replacements: [] },
      });
    }
    expect(parseSuccessorAuthority([canonical], [], 6410, repo)).toEqual({
      available: false,
      reason: "SUCCESSOR_RECEIPT_NATIVE_LINK_MISSING",
    });
    expect(
      parseSuccessorAuthority([{ ...canonical, body: "DISPOSITION: REPLACED" }], native, 6410, repo).available,
    ).toBe(false);
    expect(parseSuccessorAuthority([canonical, legacy], native, 6410, repo).available).toBe(false);
    for (const { number, comment } of nonReplacementComments) {
      expect(parseSuccessorAuthority([comment], [], number, repo)).toEqual({
        available: true,
        value: { classification: "confirmed-none", replacements: [] },
      });
      const collected = await collectDigestAuthority({
        repo,
        token: "withheld",
        request: authorityRequest([issue(number)], {
          comments: (candidate) => (candidate === number ? [comment] : []),
        }).request,
        clock: () => new Date(DIGEST_AT),
      });
      expect(collected.escalations.value.eligible.map((row) => row.issue.number)).toEqual([number]);
      expect(collected.escalations.value.unavailable).toEqual([]);
      expect(renderShelfDigest(collected)).toContain(`**This week's drain target:** [#${number}]`);
    }
  });

  it("debits count-only search items and every lifecycle label node against the global node budget", async () => {
    const row = {
      ...issue(6410, 30),
      labels: [
        { name: "status:needs-replan" },
        ...Array.from({ length: 99 }, (_, index) => ({ name: `synthetic:other-${index + 1}` })),
      ],
    };

    const exhausted = await collectDigestAuthority({
      repo: "synthetic-owner/synthetic-repo",
      token: "withheld",
      request: authorityRequest([row]).request,
      clock: () => new Date(DIGEST_AT),
      limits: { nodes: 6 },
    });
    expect([exhausted.currentCount, exhausted.ageBuckets, exhausted.weeklyDelta, exhausted.escalations]).toEqual(
      Array.from({ length: 4 }, () => ({ available: false, reason: "GLOBAL_NODE_BUDGET_EXHAUSTED" })),
    );

    const complete = await collectDigestAuthority({
      repo: "synthetic-owner/synthetic-repo",
      token: "withheld",
      request: authorityRequest([row]).request,
      clock: () => new Date(DIGEST_AT),
      limits: { nodes: 208 },
    });
    expect(complete.currentCount).toEqual({ available: true, value: 1 });
    expect(complete.ageBuckets).toMatchObject({ available: true });
    expect(complete.weeklyDelta).toEqual({ available: true, value: 0 });
    expect(complete.escalations).toMatchObject({ available: true });
    expect(complete.budget.nodes).toBe(208);
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

    const thousandComments = Array.from({ length: 1_000 }, (_, index) => ({
      id: index + 1,
      body: `Repository comment ${index + 1}`,
      updated_at: day(1),
    }));
    const completeBoundary = await collectDigestAuthority({
      repo: "synthetic-owner/synthetic-repo",
      token: "withheld",
      request: authorityRequest([], { repositoryComments: thousandComments }).request,
      clock: () => new Date(DIGEST_AT),
    });
    expect(completeBoundary.cadenceComments).toMatchObject({ available: true });
    expect(completeBoundary.cadenceComments.value).toHaveLength(1_000);
    expect([
      completeBoundary.currentCount.available,
      completeBoundary.ageBuckets.available,
      completeBoundary.weeklyDelta.available,
      completeBoundary.escalations.available,
    ]).toEqual([true, true, true, true]);

    const continuedBoundary = await collectDigestAuthority({
      repo: "synthetic-owner/synthetic-repo",
      token: "withheld",
      request: authorityRequest([], {
        repositoryComments: thousandComments,
        repositoryCommentsHasContinuation: true,
      }).request,
      clock: () => new Date(DIGEST_AT),
    });
    expect(continuedBoundary.cadenceComments).toEqual({
      available: false,
      reason: "RECENT_REPOSITORY_COMMENTS_NODE_BUDGET_EXHAUSTED",
    });

    const moving = authorityRequest([issue(6410)], {
      lifecycle: (number, phase) => [
        {
          id: `label-${number}`,
          __typename: "LabeledEvent",
          createdAt: phase === "FINAL" ? day(29) : day(30),
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
      comments: (number, phase) => [
        {
          id: 1,
          body:
            phase === "FINAL"
              ? "PLANNING_CONTRACT_VERSION: planning-repair/v1\nDISPOSITION: REPLACED\nORIGINAL_ISSUE: #6410\nREPLACEMENTS: #6416"
              : "PLANNING_CONTRACT_VERSION: planning-repair/v1\nDISPOSITION: REPLACED\nORIGINAL_ISSUE: #6410\nREPLACEMENTS: #6415",
          updated_at: phase === "FINAL" ? day(0) : day(1),
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
      dependencies: (number, phase) =>
        phase === "FINAL"
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
