import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildMergeGroupFailureSignatureReport,
  buildWindow,
  collectMergeGroupFailureSignatures,
  extractFailureSignatures,
  parseMergeGroupFailureSignaturesArgs,
} from "./release-health-merge-group-failure-signatures.mjs";

const FIXTURE_ROOT = new URL("./fixtures/release-health-merge-group-failure-signatures/", import.meta.url);

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8"));
}

describe("merge-group failure signatures", () => {
  it("extracts a bounded Vitest signature and masks assertion values", () => {
    const [failure] = extractFailureSignatures(
      [
        " FAIL  tests/marketplace-seed.test.ts > support requests are seeded",
        "AssertionError: expected [] to have a length of 2",
        "    at tests/marketplace-seed.test.ts:132:18",
      ].join("\n"),
      { jobName: "marketplace-seed-testing", jobId: 42 },
    );

    expect(failure).toMatchObject({
      testFile: "tests/marketplace-seed.test.ts",
      testName: "support requests are seeded",
      assertionShape: "to have a length of <number>",
      failureClass: "test",
      jobName: "marketplace-seed-testing",
    });
    expect(failure.signature).toHaveLength(16);
  });

  it("exonerates an unchanged failure after the next group passes", async () => {
    const fixture = await readFixture("flaky-exonerated.json");
    const result = buildMergeGroupFailureSignatureReport({
      checkedAt: "2026-07-12T22:00:00.000Z",
      repository: "chase-sets/chase-sets",
      window: buildWindow("2026-07-12T22:00:00.000Z"),
      groups: fixture.groups,
    });

    expect(result.record.counts).toMatchObject({ trackedSignatures: 1, suspectFlaky: 1, attributed: 0 });
    expect(result.record.failures[0]).toMatchObject({
      signature: "seed-support-request",
      occurrenceCount: 1,
      classification: "suspect-flaky",
      attributedPr: null,
      unchangedFailurePassed: true,
    });
    expect(result.markdown).toContain("suspect-flaky");
    expect(result.markdown).toContain("do not auto-ignore");
  });

  it("attributes a signature whose failures are perfectly correlated with one PR", async () => {
    const fixture = await readFixture("composition-attributed.json");
    const result = buildMergeGroupFailureSignatureReport({
      checkedAt: "2026-07-12T22:20:00.000Z",
      repository: "chase-sets/chase-sets",
      window: buildWindow("2026-07-12T22:20:00.000Z"),
      groups: fixture.groups,
    });

    expect(result.record.counts).toMatchObject({ trackedSignatures: 1, suspectFlaky: 0, attributed: 1 });
    expect(result.record.failures[0]).toMatchObject({
      classification: "attributed-to-pr",
      attributedPr: 4980,
      unchangedFailurePassed: true,
    });
    expect(result.markdown).toContain("PR #4980");
  });

  it("deduplicates the same signature across job fan-out and runs", () => {
    const baseGroup = {
      createdAt: "2026-07-12T20:00:00.000Z",
      conclusion: "failure",
      composition: [{ number: 5000, headSha: "3".repeat(40), changedFiles: [] }],
      failures: [
        { signature: "same", testFile: "tests/a.test.ts", testName: "a", assertionShape: "to fail", jobName: "one" },
        { signature: "same", testFile: "tests/a.test.ts", testName: "a", assertionShape: "to fail", jobName: "two" },
      ],
    };
    const result = buildMergeGroupFailureSignatureReport({
      checkedAt: "2026-07-12T22:20:00.000Z",
      repository: "chase-sets/chase-sets",
      groups: [
        { ...baseGroup, runId: 1 },
        { ...baseGroup, runId: 2, createdAt: "2026-07-12T21:00:00.000Z" },
      ],
    });

    expect(result.record.failures).toHaveLength(1);
    expect(result.record.failures[0].occurrenceCount).toBe(2);
    expect(result.record.failures[0].runs).toHaveLength(2);
  });

  it("requires a new commit for a deterministic repeat and resets on a changed PR head", () => {
    const group = (runId, createdAt, headSha, failure = true) => ({
      runId,
      createdAt,
      conclusion: failure ? "failure" : "success",
      composition: [{ number: 5000, headSha, changedFiles: [] }],
      failures: failure
        ? [{ signature: "repeat", testFile: "tests/a.test.ts", testName: "a", assertionShape: "to fail" }]
        : [],
    });
    const repeat = buildMergeGroupFailureSignatureReport({
      checkedAt: "2026-07-12T22:20:00.000Z",
      repository: "chase-sets/chase-sets",
      groups: [
        group(1, "2026-07-12T20:00:00.000Z", "3".repeat(40)),
        group(2, "2026-07-12T21:00:00.000Z", "3".repeat(40)),
      ],
    });
    const changedHead = buildMergeGroupFailureSignatureReport({
      checkedAt: "2026-07-12T22:20:00.000Z",
      repository: "chase-sets/chase-sets",
      groups: [
        group(1, "2026-07-12T20:00:00.000Z", "3".repeat(40)),
        group(2, "2026-07-12T21:00:00.000Z", "4".repeat(40)),
      ],
    });

    expect(repeat.record.failures[0]).toMatchObject({ classification: "new-commit-required", changedHeadCount: 1 });
    expect(changedHead.record.failures[0]).toMatchObject({ classification: "observed", changedHeadCount: 2 });
  });

  it("allows one explicit retry for an infrastructure failure without inventing a test signature", () => {
    const [failure] = extractFailureSignatures("Runner lost communication with the host", {
      jobName: "full-battery",
      jobId: 99,
    });
    expect(failure).toMatchObject({ failureClass: "infrastructure", testFile: null, testName: null });
    const result = buildMergeGroupFailureSignatureReport({
      checkedAt: "2026-07-12T22:20:00.000Z",
      repository: "chase-sets/chase-sets",
      groups: [
        {
          runId: 99,
          createdAt: "2026-07-12T20:00:00.000Z",
          conclusion: "failure",
          composition: [],
          failures: [failure],
        },
      ],
    });
    expect(result.record.failures[0].action).toContain("one explicit infrastructure retry");
  });

  it("uses the read-only API defaults", () => {
    expect(
      parseMergeGroupFailureSignaturesArgs([], {
        GITHUB_REPOSITORY: "chase-sets/chase-sets",
        GITHUB_TOKEN: "token",
      }),
    ).toMatchObject({ repository: "chase-sets/chase-sets", token: "token", windowDays: 7 });
  });

  it("collects merge-group runs, failed job logs, composition, and changed files with GET requests", async () => {
    const calls = [];
    const jsonResponse = (body) => ({
      ok: true,
      headers: { get: () => null },
      json: async () => body,
      text: async () => "",
    });
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      const path = new URL(url).pathname;
      if (path.endsWith("/actions/runs")) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 123,
              created_at: "2026-07-12T20:00:00.000Z",
              conclusion: "failure",
              head_sha: "a".repeat(40),
              pull_requests: [{ number: 4980, head: { sha: "b".repeat(40) } }],
            },
          ],
        });
      }
      if (path.endsWith("/actions/runs/123/jobs")) {
        return jsonResponse({ jobs: [{ id: 456, name: "seed", conclusion: "failure" }] });
      }
      if (path.endsWith("/actions/jobs/456/logs")) {
        return {
          ok: true,
          headers: { get: () => null },
          text: async () => "FAIL tests/a.test.ts > a\nAssertionError: expected [] to have a length of 2",
        };
      }
      if (path.endsWith("/pulls/4980/files")) {
        return jsonResponse([{ filename: "bounded-contexts/marketplace/src/projections/display-reference.ts" }]);
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await collectMergeGroupFailureSignatures({
      repository: "chase-sets/chase-sets",
      token: "token",
      checkedAt: "2026-07-12T22:00:00.000Z",
      windowDays: 7,
      fetchImpl,
    });

    expect(result.record.counts).toMatchObject({ mergeGroupRuns: 1, failedRuns: 1, trackedSignatures: 1 });
    expect(result.record.failures[0]).toMatchObject({ firstFailingJob: "seed", testFile: "tests/a.test.ts" });
    expect(calls.every((call) => call.options.headers.Authorization === "Bearer token")).toBe(true);
    expect(calls.every((call) => call.options.method === "GET")).toBe(true);
  });
});
