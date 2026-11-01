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

/**
 * A fake `gh api`: Platform Deploy listings, attempts' jobs and the deploy log from the captured fixture, one
 * merged closing PR per issue, and a compare status per merge commit.
 */
function fakeGh({ closing = {}, compare = {}, fail = () => false } = {}) {
  const calls = [];
  const gh = vi.fn(async (args) => {
    calls.push(args);
    if (fail(args)) throw new Error("gh-api-refused");
    const json = (value) => Buffer.from(JSON.stringify(value));
    if (args[0] === "graphql") {
      const issue = Number(args.find((arg) => arg.startsWith("number=")).slice("number=".length));
      const nodes = closing[issue] ?? [{ number: issue, merged: true, mergeCommit: { oid: mergeOf(issue) } }];
      return json({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes } } } } });
    }
    const path = args.at(-1);
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
    expect(gh).toHaveBeenCalledWith([
      "-H",
      "Accept: application/vnd.github.raw+json",
      `${repo}/actions/runs/1/attempts/1?x=1`,
    ]);
    expect((await transport("https://synthetic.blob.core.windows.net/logs/1")).status).toBe(599);
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
