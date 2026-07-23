import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  COMMENT_MARKER,
  RiskReviewBoundaryError,
  createGithubClient,
  evaluateApprovalState,
  evaluatePullRequest,
  projectChangedFile,
  projectPullRequest,
  projectReview,
  renderComment,
  resolveMergeGroupPullRequests,
  summaryMarkdown,
  upsertStableComment,
  validateEligibilityConfig,
} from "./platform-risk-review.mjs";

const headSha = "1111111111111111111111111111111111111111";
const oldSha = "2222222222222222222222222222222222222222";
const mergeSha = "3333333333333333333333333333333333333333";
const baseSha = "4444444444444444444444444444444444444444";

function config(principals = [{ login: "reviewer", allowBot: false }], teams = []) {
  return validateEligibilityConfig({
    schemaVersion: "risk-review-eligibility/v1",
    mode: "advisory",
    eligiblePrincipals: principals,
    eligibleTeams: teams,
  });
}

function pullRequest(overrides = {}) {
  return {
    number: 5503,
    state: "open",
    author: "author",
    headSha,
    baseRef: "main",
    mergeCommitSha: null,
    changedFilesCount: 1,
    labels: [],
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    id: 1,
    actor: "reviewer",
    actorType: "User",
    state: "APPROVED",
    commitId: headSha,
    submittedAt: "2026-07-22T12:00:00Z",
    ...overrides,
  };
}

function rawPull(number = 5503, overrides = {}) {
  return {
    number,
    state: "open",
    user: { login: "author", type: "User" },
    head: { sha: headSha },
    base: { ref: "main" },
    merge_commit_sha: null,
    changed_files: 1,
    labels: [],
    ...overrides,
  };
}

function rawFile(filename, overrides = {}) {
  return {
    filename,
    status: "modified",
    previous_filename: null,
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -1 +1 @@",
    ...overrides,
  };
}

function rawReview(overrides = {}) {
  return {
    id: 1,
    user: { login: "reviewer", type: "User" },
    state: "APPROVED",
    commit_id: headSha,
    submitted_at: "2026-07-22T12:00:00Z",
    ...overrides,
  };
}

describe("platform risk review API projections", () => {
  it("accepts recorded live read-only GitHub API shapes", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("./fixtures/platform-risk-review/recorded-github-api-shapes.json", import.meta.url),
        "utf8",
      ),
    );

    expect(fixture.readOnlySources).toHaveLength(4);
    expect(projectPullRequest(fixture.pullRequest)).toMatchObject({ number: 5916, baseRef: "main" });
    expect(projectChangedFile(fixture.file)).toMatchObject({
      filename: "bounded-contexts/public-presence/context.json",
      previousFilename: null,
    });
    expect(projectReview(fixture.review)).toMatchObject({ state: "PENDING", submittedAt: null });
    expect(projectPullRequest(fixture.mergeGroupAssociatedPullRequest)).toMatchObject({
      number: 5948,
      mergeCommitSha: "c30f992fab4518dd6ea271413db553e521b65e52",
    });
  });

  it("allows commit-associated PR summaries to omit the detail-only changed_files count", () => {
    const summary = rawPull();
    delete summary.changed_files;

    expect(projectPullRequest(summary)).toMatchObject({ number: 5503, changedFilesCount: null });
  });

  it("adapts arbitrary paths and rename/delete metadata through the real GitHub file projection", () => {
    expect(projectChangedFile(rawFile("arbitrary/new/place.ts"))).toMatchObject({
      filename: "arbitrary/new/place.ts",
      status: "modified",
    });
    expect(
      projectChangedFile(
        rawFile("archive/old.tf", {
          status: "renamed",
          previous_filename: "infrastructure/digitalocean/old.tf",
        }),
      ),
    ).toMatchObject({ previousFilename: "infrastructure/digitalocean/old.tf", status: "renamed" });
    expect(projectChangedFile(rawFile("bounded-contexts/payments/old.ts", { status: "removed" }))).toMatchObject({
      status: "removed",
    });
  });

  it.each([
    () => projectReview(rawReview({ state: "UNKNOWN" })),
    () => projectReview(rawReview({ user: { login: "reviewer", type: "Organization" } })),
    () => projectChangedFile(rawFile("x.ts", { changes: "1" })),
    () => projectPullRequest(rawPull(1, { head: { sha: "short" } })),
    () => projectPullRequest(rawPull(1, { changed_files: "1" })),
  ])("fails malformed authoritative API shapes explicitly", (operation) => {
    expect(operation).toThrow(RiskReviewBoundaryError);
  });

  it("closes every nested eligibility shape and rejects configuration drift", () => {
    expect(() =>
      validateEligibilityConfig({
        schemaVersion: "risk-review-eligibility/v1",
        mode: "advisory",
        eligiblePrincipals: [{ login: "reviewer", allowBot: false, mystery: true }],
        eligibleTeams: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "eligibility-principal-schema" }));
    expect(() =>
      validateEligibilityConfig({
        schemaVersion: "risk-review-eligibility/v1",
        mode: "enforcing",
        eligiblePrincipals: [],
        eligibleTeams: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "eligibility-version-or-mode" }));
  });
});

describe("approval lifecycle", () => {
  it.each([
    ["valid current-head approval", [review()], "approved"],
    ["author approval", [review({ actor: "author" })], "approval-required"],
    ["ineligible approval", [review({ actor: "stranger" })], "approval-required"],
    ["stale approval", [review({ commitId: oldSha })], "approval-required"],
    ["dismissed approval", [review({ state: "DISMISSED" })], "approval-required"],
    ["pending review", [review({ state: "PENDING", submittedAt: null })], "approval-required"],
    [
      "later changes request",
      [review(), review({ id: 2, actor: "second", state: "CHANGES_REQUESTED", submittedAt: "2026-07-22T13:00:00Z" })],
      "approval-required",
      [
        { login: "reviewer", allowBot: false },
        { login: "second", allowBot: false },
      ],
    ],
    [
      "approval after changes request",
      [review({ id: 1, state: "CHANGES_REQUESTED" }), review({ id: 2, submittedAt: "2026-07-22T13:00:00Z" })],
      "approved",
    ],
  ])("evaluates %s", (_label, reviews, expected, principals) => {
    expect(evaluateApprovalState({ pullRequest: pullRequest(), reviews, config: config(principals) }).state).toBe(
      expected,
    );
  });

  it("excludes bots unless their exact governed identity explicitly allows bots", () => {
    const botReview = review({ actor: "review-bot[bot]", actorType: "Bot" });
    expect(
      evaluateApprovalState({
        pullRequest: pullRequest(),
        reviews: [botReview],
        config: config([{ login: "review-bot[bot]", allowBot: false }]),
      }).state,
    ).toBe("approval-required");
    expect(
      evaluateApprovalState({
        pullRequest: pullRequest(),
        reviews: [botReview],
        config: config([{ login: "review-bot[bot]", allowBot: true }]),
      }).state,
    ).toBe("approved");
  });

  it("never lets team membership implicitly authorize a bot identity", () => {
    expect(
      evaluateApprovalState({
        pullRequest: pullRequest(),
        reviews: [review({ actor: "review-bot[bot]", actorType: "Bot" })],
        config: config([], [{ organization: "chase-sets", slug: "reviewers" }]),
        teamEligibleActors: ["review-bot[bot]"],
      }).state,
    ).toBe("approval-required");
  });

  it("uses the explicit submitted_at,id,actor total order", () => {
    const result = evaluateApprovalState({
      pullRequest: pullRequest(),
      reviews: [review({ id: 8, state: "APPROVED" }), review({ id: 9, actor: "second", state: "CHANGES_REQUESTED" })],
      config: config([
        { login: "reviewer", allowBot: false },
        { login: "second", allowBot: false },
      ]),
    });
    expect(result).toMatchObject({ state: "approval-required", latestDecision: "CHANGES_REQUESTED" });
    expect(result.ordering).toBe("submitted_at,id,actor");
  });

  it("converges on routine day-after evaluation and resets immediately on a head change", () => {
    const input = { pullRequest: pullRequest(), reviews: [review()], config: config() };
    expect(evaluateApprovalState(input)).toEqual(evaluateApprovalState(input));
    expect(evaluateApprovalState({ ...input, pullRequest: pullRequest({ headSha: oldSha }) })).toMatchObject({
      state: "approval-required",
      counts: { stale: 1 },
    });
  });

  it("does not permanently block after dismissal or a later request once a new approval arrives", () => {
    const lifecycle = [
      review({ id: 1, state: "DISMISSED" }),
      review({ id: 2, state: "CHANGES_REQUESTED", submittedAt: "2026-07-22T13:00:00Z" }),
      review({ id: 3, state: "APPROVED", submittedAt: "2026-07-23T09:00:00Z" }),
    ];
    expect(evaluateApprovalState({ pullRequest: pullRequest(), reviews: lifecycle, config: config() }).state).toBe(
      "approved",
    );
  });

  it("rejects unknown fields in a retained review projection", () => {
    expect(() =>
      evaluateApprovalState({
        pullRequest: pullRequest(),
        reviews: [{ ...review(), mystery: true }],
        config: config(),
      }),
    ).toThrowError(expect.objectContaining({ code: "review-0" }));
  });
});

describe("GitHub boundary and convergence", () => {
  it.each([
    [2_999, "low-risk", undefined],
    [3_000, "unknown", "api-files-truncated"],
    [3_001, "unknown", "api-files-truncated"],
  ])(
    "reconciles authoritative changed_files at the provider cap boundary: %i",
    async (changedFilesCount, expectedState, expectedCode) => {
      const completeFiles = Array.from({ length: changedFilesCount }, (_entry, index) =>
        rawFile(
          index === 3_000
            ? "infrastructure/stripe-payments/index.ts"
            : `arbitrary/safe/file-${String(index).padStart(4, "0")}.ts`,
        ),
      );
      const collectedFiles = completeFiles.slice(0, 3_000);
      const requests = [];
      const client = {
        request: async () => ({ data: rawPull(5503, { changed_files: changedFilesCount }) }),
        paginate: async (pathname) => {
          if (pathname.endsWith("/files")) return collectedFiles;
          if (pathname.endsWith("/comments")) {
            return [
              {
                id: 99,
                user: { login: "github-actions[bot]", type: "Bot" },
                body: `${COMMENT_MARKER}\nClassification: **low-risk**`,
              },
            ];
          }
          throw new Error(`unexpected pagination path ${pathname}`);
        },
      };
      const result = await evaluatePullRequest({ client, pullRequestNumber: 5503, config: config() });
      client.request = async (pathname, options) => requests.push({ pathname, options });
      await upsertStableComment({
        client,
        pullRequestNumber: 5503,
        body: renderComment(result),
        createWhenMissing: result.classification.classification === "high" || result.advisoryState === "unknown",
      });

      expect(completeFiles.at(-1)?.filename).toBe(
        changedFilesCount === 3_001
          ? "infrastructure/stripe-payments/index.ts"
          : `arbitrary/safe/file-${String(changedFilesCount - 1).padStart(4, "0")}.ts`,
      );
      expect(result).toMatchObject({ advisoryState: expectedState, ...(expectedCode ? { code: expectedCode } : {}) });
      expect(requests).toHaveLength(1);
      expect(requests[0].options.body.body).toContain(`Evaluation: **${expectedState}**`);
      if (expectedCode) {
        expect(requests[0].options.body.body).toContain(`Safe code: \`${expectedCode}\``);
        expect(requests[0].options.body.body).not.toContain("Classification: **low-risk**");
      }
    },
  );

  it("bounds a collected-count mismatch below the provider cap", async () => {
    const client = {
      request: async () => ({ data: rawPull(5503, { changed_files: 2 }) }),
      paginate: async () => [rawFile("arbitrary/safe.ts")],
    };

    await expect(evaluatePullRequest({ client, pullRequestNumber: 5503, config: config() })).resolves.toMatchObject({
      advisoryState: "unknown",
      code: "api-files-truncated",
    });
  });

  it("maps adversarial API exceptions to safe advisory output everywhere", async () => {
    const adversarial = "Authorization: Bearer super-secret-token REVIEW_BODY_SENTINEL <!-- injected-review-marker -->";
    const client = {
      request: async () => ({ data: rawPull() }),
      paginate: async () => {
        throw new Error(adversarial);
      },
    };

    const result = await evaluatePullRequest({ client, pullRequestNumber: 5503, config: config() });
    const record = { schemaVersion: "risk-review-evaluation/v1", mode: "advisory", results: [result] };
    for (const output of [JSON.stringify(result), renderComment(result), summaryMarkdown(record)]) {
      expect(output).not.toContain("super-secret-token");
      expect(output).not.toContain("REVIEW_BODY_SENTINEL");
      expect(output).not.toContain("injected-review-marker");
    }
    expect(result).toMatchObject({ advisoryState: "unknown", code: "internal-failure" });
  });

  it("bounds an authoritative PR detail response that omits changed_files", async () => {
    const detail = rawPull();
    delete detail.changed_files;
    const client = {
      request: async () => ({ data: detail }),
      paginate: vi.fn(),
    };

    await expect(evaluatePullRequest({ client, pullRequestNumber: 5503, config: config() })).resolves.toMatchObject({
      advisoryState: "unknown",
      code: "pull-request-files-count-shape",
    });
    expect(client.paginate).not.toHaveBeenCalled();
  });

  it("follows every API page and rejects unsafe or malformed next links", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 1 }],
        headers: { get: () => '<https://api.github.com/repos/chase-sets/chase-sets/pulls/1/files?page=2>; rel="next"' },
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: 2 }], headers: { get: () => null } });
    const client = createGithubClient({ repository: "chase-sets/chase-sets", token: "test", fetchImpl });
    expect(await client.paginate("/pulls/1/files")).toEqual([{ id: 1 }, { id: 2 }]);

    const unsafe = createGithubClient({
      repository: "chase-sets/chase-sets",
      token: "test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => [],
        headers: { get: () => '<https://attacker.invalid/page/2>; rel="next"' },
      }),
    });
    await expect(unsafe.paginate("/pulls/1/files")).rejects.toMatchObject({ code: "api-pagination-shape" });
  });

  it("maps secret-bearing boundary exceptions to a bounded safe code", async () => {
    const client = createGithubClient({
      repository: "chase-sets/chase-sets",
      token: "test",
      fetchImpl: async () => {
        throw new Error("Authorization=Bearer super-secret-token");
      },
    });
    let caught;
    try {
      await client.request("/pulls/1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "api-network" });
    expect(JSON.stringify(caught)).not.toContain("super-secret-token");
  });

  it("evaluates current PR truth through API adaptation and keeps arbitrary safe files low-risk", async () => {
    const calls = [];
    const client = {
      request: async (pathname) => {
        calls.push(pathname);
        return { data: rawPull() };
      },
      paginate: async (pathname) => {
        calls.push(pathname);
        if (pathname.endsWith("/files")) return [rawFile("arbitrary/new/location.ts")];
        throw new Error("reviews must not be requested for low risk");
      },
    };
    const result = await evaluatePullRequest({ client, pullRequestNumber: 5503, config: config() });
    expect(result).toMatchObject({ advisoryState: "low-risk", approval: { state: "not-required" } });
    expect(calls).toEqual(["/pulls/5503", "/pulls/5503/files"]);
  });

  it("keeps unreadable team eligibility bounded and advisory", async () => {
    const teamConfig = config([], [{ organization: "chase-sets", slug: "reviewers" }]);
    const client = {
      request: async (pathname) => {
        if (pathname === "/pulls/5503") return { data: rawPull() };
        throw new RiskReviewBoundaryError("api-http-403");
      },
      paginate: async (pathname) =>
        pathname.endsWith("/files") ? [rawFile("bounded-contexts/payments/domain/capture.ts")] : [rawReview()],
    };
    await expect(evaluatePullRequest({ client, pullRequestNumber: 5503, config: teamConfig })).resolves.toMatchObject({
      advisoryState: "unknown",
      code: "api-http-403",
    });
  });

  it("accepts an active member of an exact configured eligible team", async () => {
    const teamConfig = config([], [{ organization: "chase-sets", slug: "reviewers" }]);
    const client = {
      request: async (pathname) => {
        if (pathname === "/pulls/5503") return { data: rawPull() };
        if (pathname === "/orgs/chase-sets/teams/reviewers") {
          return { data: { slug: "reviewers", organization: { login: "chase-sets" } } };
        }
        if (pathname.endsWith("/memberships/reviewer")) return { data: { state: "active" } };
        throw new Error(`unexpected path ${pathname}`);
      },
      paginate: async (pathname) =>
        pathname.endsWith("/files") ? [rawFile("bounded-contexts/payments/domain/capture.ts")] : [rawReview()],
    };
    await expect(evaluatePullRequest({ client, pullRequestNumber: 5503, config: teamConfig })).resolves.toMatchObject({
      advisoryState: "approved",
    });
  });

  it("isolates merge-group constituents by exact synthetic merge SHA and base", async () => {
    const client = {
      paginate: async (pathname) =>
        pathname === `/commits/${mergeSha}/pulls`
          ? [
              rawPull(10, { merge_commit_sha: mergeSha }),
              rawPull(11, { merge_commit_sha: oldSha }),
              rawPull(12, { merge_commit_sha: mergeSha, base: { ref: "release" } }),
            ]
          : [rawPull(13, { head: { sha: headSha } }), rawPull(14, { head: { sha: oldSha } })],
      request: async () => ({ data: { total_commits: 1, commits: [{ sha: headSha }] } }),
    };
    await expect(
      resolveMergeGroupPullRequests({ client, mergeGroup: { headSha: mergeSha, baseSha, baseRef: "refs/heads/main" } }),
    ).resolves.toEqual([10, 13]);
  });

  it("rejects incomplete merge-group compare fallback instead of accepting unrelated PR truth", async () => {
    const client = {
      paginate: async () => [],
      request: async () => ({ data: { total_commits: 2, commits: [{ sha: headSha }] } }),
    };
    await expect(
      resolveMergeGroupPullRequests({ client, mergeGroup: { headSha: mergeSha, baseSha, baseRef: "main" } }),
    ).rejects.toMatchObject({ code: "merge-group-compare-incomplete" });
  });

  it("updates one marker comment to a stable steady state without spam", async () => {
    const requests = [];
    const client = {
      paginate: async () => [
        { id: 99, user: { login: "github-actions[bot]", type: "Bot" }, body: `${COMMENT_MARKER}\nold` },
      ],
      request: async (pathname, options) => requests.push({ pathname, options }),
    };
    const first = await upsertStableComment({ client, pullRequestNumber: 5503, body: "new", createWhenMissing: true });
    const second = await upsertStableComment({ client, pullRequestNumber: 5503, body: "new", createWhenMissing: true });
    expect(first).toBe("updated");
    expect(second).toBe("updated");
    expect(requests).toEqual([
      { pathname: "/issues/comments/99", options: { method: "PATCH", body: { body: "new" } } },
      { pathname: "/issues/comments/99", options: { method: "PATCH", body: { body: "new" } } },
    ]);
  });

  it("does not create a new comment for a low-risk result", async () => {
    const client = { paginate: async () => [], request: vi.fn() };
    await expect(
      upsertStableComment({ client, pullRequestNumber: 5503, body: "low", createWhenMissing: false }),
    ).resolves.toBe("absent");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not let an actor-spoofed marker hijack the stable workflow comment", async () => {
    const requests = [];
    const client = {
      paginate: async () => [{ id: 7, user: { login: "attacker", type: "User" }, body: `${COMMENT_MARKER}\nspoof` }],
      request: async (pathname, options) => requests.push({ pathname, options }),
    };
    await expect(
      upsertStableComment({ client, pullRequestNumber: 5503, body: "trusted", createWhenMissing: true }),
    ).resolves.toBe("created");
    expect(requests[0]).toMatchObject({ pathname: "/issues/5503/comments", options: { method: "POST" } });
  });

  it("renders bounded classification state without review bodies or credentials", () => {
    const body = renderComment({
      classification: {
        classification: "high",
        categories: ["money-movement"],
        findings: [{ path: "bounded-contexts/payments/domain/capture.ts" }],
        scan: { pathsScanned: 1, totalSurface: 1, filesScanned: 1 },
      },
      advisoryState: "approval-required",
    });
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain("advisory only");
    expect(body).not.toContain("Authorization");
  });
});

describe("workflow advisory and trust boundaries", () => {
  it("never checks out untrusted head code and contains child failure at the workflow level", async () => {
    const workflow = await readFile(new URL("../.github/workflows/platform-risk-review.yml", import.meta.url), "utf8");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("pull_request_review:");
    expect(workflow).toContain("merge_group:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("ref: context.payload.repository.default_branch");
    expect(workflow).not.toContain("actions/checkout@");
    expect(workflow).not.toMatch(/pull_request\.head\.(?:sha|ref)/);
    expect(workflow).toContain("exit 0");
  });

  it("does not propagate advisory evaluation into the existing required rollup or live ruleset posture", async () => {
    const [platformPr, rulesetPolicy] = await Promise.all([
      readFile(new URL("../.github/workflows/platform-pr.yml", import.meta.url), "utf8"),
      readFile(new URL("./release-health-merge-queue-policy.json", import.meta.url), "utf8").then(JSON.parse),
    ]);
    expect(platformPr).not.toContain("Risk Review");
    expect(rulesetPolicy.requiredStatusChecks).toEqual(["PR Required"]);
  });
});
