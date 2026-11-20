import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ghApi, ghApiTransport, readConnectorDrillDeployBinding } from "./connector-pairing-drill-deploy-binding.mjs";

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/staging-deploy-generation/${name}`, import.meta.url), "utf8");
// The staging deploy generation's captured, read-only Platform Deploy shapes: run 39252891660's Deploy Staging job
// 118064914233 applied head 175d48ba…; the other runs are rejected or superseded.
const captured = JSON.parse(fixture("captured-platform-deploy.json"));
const capturedLog = fixture("deploy-staging-118064914233-log.txt");
const capturedRun = "39252891660";
const capturedHead = "175d48ba08d9cc5de352b0505bb586eca4c1f902";
const capturedNow = "2026-10-19T13:00:00Z";
const repo = "repos/chase-sets/chase-sets";
// Labeled synthetic merge commits for the required issues' closing PRs.
const mergeOf = (issue) => issue.toString(16).padStart(40, "e");
const pairingIssues = [10110, 9985, 10639, 10640];

const linkedPr = (overrides = {}) => ({
  __typename: "PullRequest",
  number: 19001,
  merged: true,
  mergeCommit: { oid: mergeOf(10640) },
  baseRefName: "main",
  repository: { nameWithOwner: "chase-sets/chase-sets" },
  ...overrides,
});
const crossReference = (pr = linkedPr()) => ({ __typename: "CrossReferencedEvent", source: pr });
// Synthetic API payload for the production mapping's identity; never live GitHub evidence.
const mappedPr = (overrides = {}) => ({
  number: 10944,
  merged: true,
  merge_commit_sha: mergeOf(10640),
  base: { ref: "main", repo: { full_name: "chase-sets/chase-sets" } },
  ...overrides,
});

/**
 * A fake `gh api`: Platform Deploy listings, attempts' jobs and the deploy log from the captured fixture, one
 * merged closing PR per issue, mapped implementation metadata, incidental references, and merge comparisons.
 */
function fakeGh({
  closing = {},
  linked = [],
  implementation = mappedPr(),
  state = "CLOSED",
  truncated = false,
  closingTruncated = false,
  compare = {},
  fail = () => false,
} = {}) {
  const calls = [];
  const gh = vi.fn(async (args) => {
    calls.push(args);
    if (fail(args)) throw new Error("gh-api-refused");
    const json = (value) => Buffer.from(JSON.stringify(value));
    if (args[0] === "graphql") {
      const issue = Number(args.find((arg) => arg.startsWith("number=")).slice("number=".length));
      const nodes = closing[issue] ?? [{ number: issue, merged: true, mergeCommit: { oid: mergeOf(issue) } }];
      return json({
        data: {
          repository: {
            issue: {
              state,
              closedByPullRequestsReferences: { nodes, pageInfo: { hasNextPage: closingTruncated } },
              timelineItems: { nodes: linked, pageInfo: { hasNextPage: truncated } },
            },
          },
        },
      });
    }
    const path = args.at(-1);
    if (path === `${repo}/pulls/10944`) return json(implementation);
    let match = /^repos\/chase-sets\/chase-sets\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=1$/.exec(path);
    if (match) return json({ status: compare[match[1]] ?? "ahead" });
    match =
      /^repos\/chase-sets\/chase-sets\/actions\/workflows\/platform-production\.yml\/runs\?per_page=100&page=(\d+)&created=(\S+)\.\.(\S+)$/.exec(
        path,
      );
    if (match) {
      const [from, to] = [Date.parse(match[2]), Date.parse(match[3])];
      const listed = captured.runs
        .filter((run) => Date.parse(run.created_at) >= from && Date.parse(run.created_at) <= to)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
      return json({
        total_count: listed.length,
        workflow_runs: listed.slice((Number(match[1]) - 1) * 100, Number(match[1]) * 100),
      });
    }
    match = /^repos\/chase-sets\/chase-sets\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100&page=1$/.exec(
      path,
    );
    if (match) return json(captured.jobs[`${match[1]}/${match[2]}`]);
    // `gh api` follows the job log's signed redirect itself and returns the log.
    if (path === `${repo}/actions/jobs/118064914233/logs`) return Buffer.from(capturedLog);
    throw new Error(`unexpected gh api path ${path}`);
  });
  return { gh, calls };
}

const request = (overrides = {}) => ({
  run: capturedRun,
  commit: capturedHead,
  requiredIssues: pairingIssues,
  requireReceiptFloor: true,
  ...overrides,
});
const read = (overrides, deps) =>
  readConnectorDrillDeployBinding(request(overrides), { now: () => capturedNow, ...deps });

describe("connector-pairing-drill-deploy-binding", () => {
  it("binds the newest applied Deploy Staging job and each required issue's contained closing merge", async () => {
    const { gh, calls } = fakeGh();
    const result = await read({}, { gh, readReceiptFloor: async () => "39079933000" });
    expect(result).toEqual({
      binding: {
        runId: capturedRun,
        runAttempt: 1,
        jobId: "118064914233",
        jobCompletedAt: "2026-10-19T12:56:22Z",
        deployedHead: capturedHead,
        requiredMerges: pairingIssues.map((issue) => ({
          issue,
          pullRequest: issue,
          mergeCommit: mergeOf(issue),
          contained: true,
        })),
        receiptFloorRunId: "39079933000",
      },
    });
    // Every read is `gh api`: this repository's REST paths, and the closing-merge GraphQL query.
    expect(calls.filter((args) => args[0] !== "graphql" && !args.at(-1).startsWith(`${repo}/`))).toEqual([]);
    expect(calls.filter((args) => args[0] === "graphql").map((args) => args.at(-1))).toEqual(
      pairingIssues.map((issue) => `number=${issue}`),
    );
    expect(calls.map((args) => args.at(-1))).toContain(`${repo}/actions/jobs/118064914233/logs`);
    expect(calls.some((args) => args.some((arg) => arg.includes("timelineItems")))).toBe(false);
    expect(calls.some((args) => args.at(-1).includes("/pulls/"))).toBe(false);
  });

  it("returns the selector's stop for a newer unfinished, indeterminate or missing deploy", async () => {
    for (const stop of ["deploy-in-progress", "deploy-outcome-indeterminate", "no-applied-deploy-found"]) {
      const selectGeneration = vi.fn(async () => ({ stop, deployment: null, deployGeneration: null }));
      expect(await read({}, { gh: fakeGh().gh, selectGeneration })).toEqual({ stop });
      expect(selectGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ requestTimeoutMs: 30_000, now: capturedNow, maxAgeSeconds: 604_800 }),
      );
    }
    const throwing = vi.fn(async () => {
      throw new TypeError("staging-deploy-generation-input-invalid");
    });
    expect(await read({}, { gh: fakeGh().gh, selectGeneration: throwing })).toEqual({
      stop: "deploy-generation-unavailable",
    });
  });

  const failedGh = (code, stderr = "") =>
    ghApi([], {
      run: (_file, _args, _options, done) =>
        done(
          Object.assign(new Error("token=private-error"), { code }),
          Buffer.from("private-body"),
          Buffer.from(stderr),
        ),
    });

  it.each([
    ["bare 503", () => failedGh(1, "gh: HTTP 503\r\n")],
    ["429", () => failedGh(1, "gh: private-stderr (HTTP 429)")],
    ["transport", () => failedGh(1, 'Get "https://private-url": unexpected EOF')],
    ["timeout", () => failedGh("ABORT_ERR")],
  ])("retries a transient jobs GET and binds the exact applied job (%s)", async (_kind, fail) => {
    const { gh } = fakeGh();
    let firstJobsPage;
    let calls = 0;
    const flaky = (args) => {
      const path = args.at(-1);
      if (path.includes("/attempts/")) firstJobsPage ??= path;
      return path === firstJobsPage && ++calls === 1 ? fail() : gh(args);
    };
    expect(await read({}, { gh: flaky, readReceiptFloor: async () => capturedRun })).toMatchObject({
      binding: { runId: capturedRun, jobId: "118064914233", deployedHead: capturedHead },
    });
    expect(calls).toBe(2);
  });

  it.each([
    ["workflow-runs", "/workflows/", 1, "gh: private-stderr\ncontinued (HTTP 403)", "http-403", 1],
    ["attempt-jobs", "/attempts/", 1, "gh: private-stderr (HTTP 404)", "http-404", 1],
    ["attempt-jobs", "/attempts/", 1, "gh: private-stderr (HTTP 503)", "http-503", 3],
    ["deploy-job-log", "/logs", 4, "private-stderr", "exit-4", 1],
  ])("refuses an unreadable %s phase with only the safe class", async (phase, match, code, stderr, reason, count) => {
    const { gh } = fakeGh();
    const fail = vi.fn(() => failedGh(code, stderr));
    const readReceiptFloor = vi.fn();
    const result = await read(
      {},
      {
        gh: (args) => (args.at(-1).includes(match) ? fail() : gh(args)),
        readReceiptFloor,
      },
    );
    expect(result).toEqual({ stop: `github-request-failed:${phase}:${reason}` });
    expect(fail).toHaveBeenCalledTimes(count);
    expect(readReceiptFloor).not.toHaveBeenCalled();
  });

  it("does not retry a GraphQL POST even on a retryable HTTP status", async () => {
    const { gh } = fakeGh();
    const fail = vi.fn(() => failedGh(1, "gh: private-stderr (HTTP 503)"));
    expect(await read({}, { gh: (args) => (args[0] === "graphql" ? fail() : gh(args)) })).toEqual({
      stop: "required-merge-unreadable:required-merges:http-503",
    });
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it.each([{ linked: [] }, { linked: [crossReference(), crossReference(linkedPr({ number: 19002 }))] }])(
    "accepts only the mapped implementation regardless of incidental timeline references: %j",
    async ({ linked }) => {
      const { gh, calls } = fakeGh({
        closing: { 10640: [] },
        linked,
      });
      const result = await read({}, { gh, readReceiptFloor: async () => capturedRun });
      expect(result.binding.requiredMerges.at(-1)).toEqual({
        issue: 10640,
        pullRequest: 10944,
        mergeCommit: mergeOf(10640),
        contained: true,
      });
      expect(calls.map((args) => args.at(-1))).toContain(`${repo}/pulls/10944`);
      expect(calls.some((args) => args.some((arg) => arg.includes("timelineItems")))).toBe(false);
    },
  );

  it.each([
    ["open issue", { state: "OPEN" }],
    ["unmerged PR", { implementation: mappedPr({ merged: false }) }],
    [
      "PR targeting another branch",
      { implementation: mappedPr({ base: { ref: "release", repo: { full_name: "chase-sets/chase-sets" } } }) },
    ],
    [
      "foreign repository PR",
      { implementation: mappedPr({ base: { ref: "main", repo: { full_name: "other/repo" } } }) },
    ],
    ["wrong PR identity", { implementation: mappedPr({ number: 900000003 }) }],
    ["missing merge SHA", { implementation: mappedPr({ merge_commit_sha: null }) }],
    ["malformed merge SHA", { implementation: mappedPr({ merge_commit_sha: "unknown" }) }],
    ["missing PR metadata", { implementation: null }],
    ["uncontained PR", { compare: { [mergeOf(10640)]: "behind" } }],
    ["diverged PR", { compare: { [mergeOf(10640)]: "diverged" } }],
  ])("refuses a manual closeout with %s", async (_name, options) => {
    const { gh, calls } = fakeGh({ closing: { 10640: [] }, linked: [crossReference()], ...options });
    const { binding } = await read({}, { gh, readReceiptFloor: async () => capturedRun });
    expect(binding.requiredMerges.at(-1)).toMatchObject({ issue: 10640, contained: false });
    if (Object.hasOwn(options, "implementation"))
      expect(calls.map((args) => args.at(-1))).not.toContain(
        `${repo}/compare/${mergeOf(10640)}...${capturedHead}?per_page=1`,
      );
  });

  it("refuses unreadable mapped PR metadata without consulting the timeline", async () => {
    const { gh, calls } = fakeGh({ closing: { 10640: [] }, fail: (args) => args.at(-1).includes("/pulls/") });
    expect(await read({}, { gh, readReceiptFloor: async () => capturedRun })).toEqual({
      stop: "required-merge-unreadable",
    });
    expect(calls.some((args) => args.some((arg) => arg.includes("timelineItems")))).toBe(false);
  });

  it("refuses an incidental reference alone for an unknown manual closeout", async () => {
    const issue = 900000001;
    const { gh, calls } = fakeGh({ closing: { [issue]: [] }, linked: [crossReference()] });
    const { binding } = await read({ requiredIssues: [issue], requireReceiptFloor: false }, { gh });
    expect(binding.requiredMerges).toEqual([{ issue, pullRequest: null, mergeCommit: null, contained: false }]);
    expect(calls.some((args) => args.at(-1).includes("/compare/") || args.at(-1).includes("/pulls/"))).toBe(false);
  });

  it("refuses an uncontained implementation beside a contained incidental reference", async () => {
    const incidentalMerge = "f".repeat(40);
    const { gh, calls } = fakeGh({
      closing: { 10640: [] },
      linked: [crossReference(), crossReference(linkedPr({ mergeCommit: { oid: incidentalMerge } }))],
      compare: { [mergeOf(10640)]: "behind", [incidentalMerge]: "ahead" },
    });
    const { binding } = await read({}, { gh, readReceiptFloor: async () => capturedRun });
    expect(binding.requiredMerges.at(-1)).toMatchObject({ pullRequest: 10944, contained: false });
    expect(calls.map((args) => args.at(-1))).not.toContain(
      `${repo}/compare/${incidentalMerge}...${capturedHead}?per_page=1`,
    );
  });

  it("refuses incomplete closing-PR authority instead of falling back", async () => {
    const { gh } = fakeGh({ closingTruncated: true, linked: [crossReference()] });
    expect(await read({}, { gh, readReceiptFloor: async () => capturedRun })).toEqual({
      stop: "required-merge-unreadable",
    });
  });

  it("refuses an unknown mapped comparison even beside a contained incidental reference", async () => {
    const { gh } = fakeGh({
      closing: { 10640: [] },
      linked: [crossReference(), crossReference(linkedPr({ number: 19002, mergeCommit: { oid: "f".repeat(40) } }))],
      compare: { [mergeOf(10640)]: "unknown" },
    });
    expect(await read({}, { gh, readReceiptFloor: async () => capturedRun })).toEqual({
      stop: "required-merge-unreadable",
    });
  });

  it("refuses a run or commit that is not the newest applied deploy", async () => {
    expect(await read({ run: "39135494514" }, { gh: fakeGh().gh })).toEqual({ stop: "deploy-run-not-newest" });
    expect(await read({ commit: "f".repeat(40) }, { gh: fakeGh().gh })).toEqual({ stop: "deploy-commit-mismatch" });
  });

  it("marks a merge the deployed head lacks, an unmerged issue and an ambiguous closing merge as not contained", async () => {
    const { gh } = fakeGh({
      compare: { [mergeOf(10110)]: "behind", [mergeOf(9985)]: "diverged" },
      closing: {
        10639: [{ number: 10648, merged: false, mergeCommit: null }],
        10640: [
          { number: 1, merged: true, mergeCommit: { oid: "1".repeat(40) } },
          { number: 2, merged: true, mergeCommit: { oid: "2".repeat(40) } },
        ],
      },
    });
    const { binding } = await read({}, { gh, readReceiptFloor: async () => capturedRun });
    expect(binding.requiredMerges).toEqual([
      { issue: 10110, pullRequest: 10110, mergeCommit: mergeOf(10110), contained: false },
      { issue: 9985, pullRequest: 9985, mergeCommit: mergeOf(9985), contained: false },
      { issue: 10639, pullRequest: null, mergeCommit: null, contained: false },
      { issue: 10640, pullRequest: null, mergeCommit: null, contained: false },
    ]);
    expect(
      (
        await read(
          {},
          { gh: fakeGh({ compare: { [mergeOf(10640)]: "identical" } }).gh, readReceiptFloor: async () => capturedRun },
        )
      ).binding.requiredMerges.at(-1),
    ).toMatchObject({ contained: true });
  });

  it("stops on an unreadable closing merge or comparison", async () => {
    for (const fail of [(args) => args[0] === "graphql", (args) => args.at(-1).includes("/compare/")])
      expect(await read({}, { gh: fakeGh({ fail }).gh, readReceiptFloor: async () => capturedRun })).toEqual({
        stop: "required-merge-unreadable",
      });
  });

  it("requires staging sign-in's receipt floor for a pairing run, and none for smoke", async () => {
    expect(await read({}, { gh: fakeGh().gh })).toEqual({ stop: "receipt-floor-unavailable" });
    expect(await read({}, { gh: fakeGh().gh, readReceiptFloor: async () => "run-1" })).toEqual({
      stop: "receipt-floor-unavailable",
    });
    const smoke = await read({ requiredIssues: [10639], requireReceiptFloor: false }, { gh: fakeGh().gh });
    expect(smoke.binding).toMatchObject({
      receiptFloorRunId: null,
      requiredMerges: [expect.objectContaining({ issue: 10639 })],
    });
  });

  it("refuses malformed inputs before any read", async () => {
    const { gh } = fakeGh();
    for (const overrides of [
      { run: "0" },
      { run: "run" },
      { commit: "abc" },
      { requiredIssues: [] },
      { requiredIssues: [0] },
    ])
      expect(await read(overrides, { gh })).toEqual({ stop: "deploy-binding-input-invalid" });
    expect(gh).not.toHaveBeenCalled();
  });

  it("sends only GitHub API paths through gh, never the reader's bearer token", async () => {
    const gh = vi.fn(async () => Buffer.from("{}"));
    const transport = ghApiTransport(gh);
    const response = await transport(`https://api.github.com/${repo}/actions/runs/1/attempts/1?x=1`, {
      headers: { authorization: "Bearer gh-api", accept: "application/vnd.github.raw+json" },
    });
    expect(response.status).toBe(200);
    expect(gh).toHaveBeenCalledWith(
      ["-H", "Accept: application/vnd.github.raw+json", `${repo}/actions/runs/1/attempts/1?x=1`],
      { signal: undefined },
    );
    expect((await transport("https://synthetic.blob.core.windows.net/logs/1")).status).toBe(599);
    expect((await transport(`https://api.github.com/${repo}`, { method: "POST" })).status).toBe(599);
    expect(gh).toHaveBeenCalledTimes(1);
    const refusing = ghApiTransport(async () => {
      throw new Error("gh-api-refused");
    });
    expect((await refusing(`https://api.github.com/${repo}/compare/a...b`)).status).toBe(502);
  });

  it("runs gh api with a bounded, value-free failure", async () => {
    const run = vi.fn((file, args, options, callback) => callback(null, Buffer.from("ok")));
    expect((await ghApi(["graphql"], { run })).toString()).toBe("ok");
    expect(run).toHaveBeenCalledWith(
      "gh",
      ["api", "graphql"],
      expect.objectContaining({ timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }),
      expect.any(Function),
    );
    const failing = vi.fn((file, args, options, callback) => callback(new Error("token=secret-value")));
    await expect(ghApi(["graphql"], { run: failing })).rejects.toThrow(/^gh-api-refused$/);
  });
});
