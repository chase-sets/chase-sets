import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildDigestWindows,
  buildFlakeDigest,
  collectPerSpecFlakeTelemetry,
  collectReleaseHealthFlakeDigest,
  collapsePerSpecTelemetry,
  extractPlaywrightSpecTelemetry,
  parseReleaseHealthFlakeDigestArgs,
  runProducesPerSpecTelemetry,
  workflowProducesPerSpecTelemetry,
  summarizeDeliverySignatureFlakes,
  summarizePerSpecFlakes,
  summarizeWorkflowRuns,
  writeReleaseHealthFlakeDigest,
} from "./release-health-flake-digest.mjs";
import { renderCircuitMarker } from "./release-health-merge-group-failure-signatures.mjs";
import { normalizePlaywrightPerSpecReport } from "./playwright-per-spec-report.mjs";

describe("release health flake digest", () => {
  it("keeps breach issue filing authenticated, milestone-safe, and after artifact upload", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/platform-ci-flake-digest.yml", import.meta.url),
      "utf8",
    );
    const uploadIndex = workflow.indexOf("uses: actions/upload-artifact@");
    const issueIndex = workflow.indexOf("- name: Create or update flake breach issue");
    const issueStep = workflow.slice(issueIndex);

    expect(workflow).toContain("issues: write");
    expect(issueStep).toContain("GH_TOKEN: ${{ github.token }}");
    expect(issueStep).not.toContain("--milestone");
    expect(uploadIndex).toBeGreaterThan(-1);
    expect(issueIndex).toBeGreaterThan(uploadIndex);
  });

  it("publishes a versioned, attempt-safe machine artifact apart from the diagnostic bundle", async () => {
    const workflow = await readFile(new URL("../.github/workflows/platform-pr.yml", import.meta.url), "utf8");
    const e2e = workflow.slice(workflow.indexOf("  e2e-tests:"), workflow.indexOf("\n  build:"));
    expect(e2e).toContain("if: always()");
    expect(e2e).toContain("PER_SPEC_FLAKE_TELEMETRY_SCHEMA=playwright-per-spec-flake/v1");
    expect(e2e).toContain(
      "name: playwright-e2e-results-v1-${{ github.run_id }}-${{ github.run_attempt }}-${{ strategy.job-index }}",
    );
    expect(e2e).toContain("artifacts/playwright/per-spec-flake-telemetry/results/playwright-results.json");
    expect(e2e).toContain("node scripts/playwright-per-spec-report.mjs");
    expect(e2e).toContain("name: playwright-e2e-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}-");
    expect(e2e).toContain("if-no-files-found: error");
  });

  it("includes retry-pass delivery signature recovery without classifying deterministic holds as flakes", () => {
    const issue = (number, state, recoveryReason) => ({
      number,
      body: renderCircuitMarker({
        schemaVersion: "delivery-failure-signature/v1",
        signature: `signature-${number}`,
        lane: "merge-group",
        job: "Unit Tests",
        state,
        recoveredAt: "2026-07-17T12:00:00.000Z",
        recoveryReason,
      }),
    });
    expect(
      summarizeDeliverySignatureFlakes(
        [issue(1, "recovered", "retry-pass evidence classified this occurrence as a flake"), issue(2, "holding", "")],
        { start: "2026-07-17T00:00:00.000Z", end: "2026-07-18T00:00:00.000Z" },
      ),
    ).toEqual([expect.objectContaining({ issueNumber: 1, signature: "signature-1" })]);
  });

  it("summarizes retry telemetry by workflow name", () => {
    const summary = summarizeWorkflowRuns([
      { name: "Platform PR", run_attempt: 3, conclusion: "success" },
      { name: "Platform PR", run_attempt: 2, conclusion: "failure" },
      { name: "Platform Production", run_attempt: 1, conclusion: "success" },
    ]);

    expect(summary.retryCount).toBe(3);
    expect(summary.flakyFailureCount).toBe(2);
    expect([...summary.jobs.values()]).toEqual([{ name: "Platform PR", retryCount: 3, flakyFailureCount: 2 }]);
  });

  it("ranks terminal per-spec retry recovery and failed jobs without double-counting retries", () => {
    const telemetry = collapsePerSpecTelemetry([
      {
        occurrenceId: "1:0:checkout",
        name: "checkout",
        terminalStatus: "passed",
        terminalRetry: 2,
        runUrl: "https://run/1",
      },
      {
        occurrenceId: "1:0:checkout",
        name: "checkout",
        terminalStatus: "passed",
        terminalRetry: 2,
        runUrl: "https://run/1",
      },
      {
        occurrenceId: "2:0:checkout",
        name: "checkout",
        terminalStatus: "failed",
        terminalRetry: 2,
        runUrl: "https://run/2",
      },
    ]);
    expect(summarizePerSpecFlakes(telemetry)).toEqual([
      { name: "checkout", passedOnRetryCount: 1, failedJobCount: 1, runUrl: "https://run/1" },
    ]);
    expect(() =>
      collapsePerSpecTelemetry([
        { occurrenceId: "1:0:checkout", terminalStatus: "passed", terminalRetry: 1 },
        { occurrenceId: "1:0:checkout", terminalStatus: "failed", terminalRetry: 1 },
      ]),
    ).toThrow("Conflicting terminal Playwright outcomes");
  });

  it("collects authoritative completed attempts, skips placeholders, and rejects bad producer evidence through the real ZIP path", async () => {
    const report = JSON.stringify(
      perSpecReport({
        suiteTitle: "marketplace",
        specTitle: "can buy",
        test: {
          expectedStatus: "passed",
          projectName: "chromium",
          results: [
            { retry: 0, status: "failed" },
            { retry: 1, status: "passed" },
          ],
          status: "flaky",
        },
      }),
    );
    const workflow = Buffer.from(
      `name: x\n# PER_SPEC_FLAKE_TELEMETRY_SCHEMA=playwright-per-spec-flake/v1\n- name: Upload per-spec flake telemetry v1\n  if: always()\n  name: playwright-e2e-results-v1-${"${{ github.run_id }}"}-${"${{ github.run_attempt }}"}-${"${{ strategy.job-index }}"}\n  path: artifacts/playwright/per-spec-flake-telemetry`,
    ).toString("base64");
    const response = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      arrayBuffer: async () => body,
    });
    const run = { id: 12, run_attempt: 2, head_sha: "new", html_url: "https://run/12" };
    const calls = [];
    const fetchImpl = async (url) => {
      const value = String(url);
      calls.push(value);
      if (value.includes("contents"))
        return response({
          content: value.includes("ref=old") ? Buffer.from("name: old").toString("base64") : workflow,
        });
      if (value.includes("/jobs"))
        return response({
          jobs: [
            { name: "E2E Tests (catalog)", run_attempt: 1, status: "completed", conclusion: "failure" },
            { name: "E2E Tests (catalog)", run_attempt: 2, status: "completed", conclusion: "success" },
            {
              name: "E2E Tests (${{ matrix.suite_batch }})",
              run_attempt: 2,
              status: "completed",
              conclusion: "skipped",
            },
          ],
        });
      if (value.includes("/artifacts"))
        return response({
          artifacts: [
            { id: 98, name: "playwright-e2e-results-v1-12-1-0", archive_download_url: "https://artifact/98" },
            { id: 99, name: "playwright-e2e-results-v1-12-2-0", archive_download_url: "https://artifact/99" },
          ],
        });
      return response(buildStoredZip([["results/playwright-results.json", report]]));
    };
    const options = { repository: "chase-sets/chase-sets", fetchImpl };
    expect(Buffer.from(workflow, "base64").toString("utf8")).toContain("artifacts/playwright/per-spec-flake-telemetry");
    expect(workflowProducesPerSpecTelemetry(Buffer.from(workflow, "base64").toString("utf8"))).toBe(true);
    const producer = await runProducesPerSpecTelemetry(options, run);
    expect(calls).toEqual([expect.stringContaining("contents")]);
    expect(producer).toBe(true);
    await expect(collectPerSpecFlakeTelemetry(options, [run])).resolves.toEqual([
      expect.objectContaining({ name: "marketplace › can buy › chromium", terminalStatus: "passed", terminalRetry: 1 }),
    ]);
    await expect(
      collectPerSpecFlakeTelemetry(
        {
          ...options,
          fetchImpl: async (url) => (String(url).includes("/artifacts") ? response({ artifacts: [] }) : fetchImpl(url)),
        },
        [run],
      ),
    ).rejects.toThrow("1 eligible E2E jobs but 0 per-spec report artifacts");
    await expect(
      collectPerSpecFlakeTelemetry(
        {
          ...options,
          fetchImpl: async (url) =>
            String(url) === "https://artifact/99"
              ? response(buildStoredZip([["wrong/playwright-results.json", report]]))
              : fetchImpl(url),
        },
        [run],
      ),
    ).rejects.toThrow("exactly one results/playwright-results.json");
    await expect(
      collectPerSpecFlakeTelemetry(
        {
          ...options,
          fetchImpl: async (url) =>
            String(url) === "https://artifact/99"
              ? response(buildStoredZip([["results/playwright-results.json", "not json"]]))
              : fetchImpl(url),
        },
        [run],
      ),
    ).rejects.toThrow("malformed results/playwright-results.json");
    await expect(
      collectPerSpecFlakeTelemetry(
        {
          ...options,
          fetchImpl: async (url) =>
            String(url) === "https://artifact/99"
              ? response(buildStoredZip([["results/playwright-results.json", "{}"]]))
              : fetchImpl(url),
        },
        [run],
      ),
    ).rejects.toThrow("malformed results/playwright-results.json");
    await expect(collectPerSpecFlakeTelemetry(options, [{ ...run, id: 13, head_sha: "old" }])).resolves.toEqual([]);
  });

  it("rejects duplicate, malformed, and oversized canonical payloads while accepting a large diagnostic-shaped archive", async () => {
    const validReport = JSON.stringify(perSpecReport());
    const baseWorkflow = Buffer.from(
      `# PER_SPEC_FLAKE_TELEMETRY_SCHEMA=playwright-per-spec-flake/v1\n- name: Upload per-spec flake telemetry v1\n  if: always()\n  name: playwright-e2e-results-v1-${"${{ github.run_id }}"}-${"${{ github.run_attempt }}"}-${"${{ strategy.job-index }}"}\n  path: artifacts/playwright/per-spec-flake-telemetry`,
    ).toString("base64");
    const response = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      arrayBuffer: async () => body,
    });
    const run = { id: 15, run_attempt: 1, head_sha: "new", html_url: "https://run/15" };
    const collect = async (archive) =>
      collectPerSpecFlakeTelemetry(
        {
          repository: "chase-sets/chase-sets",
          fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes("contents")) return response({ content: baseWorkflow });
            if (value.includes("/jobs"))
              return response({
                jobs: [{ name: "E2E Tests (catalog)", run_attempt: 1, status: "completed", conclusion: "failure" }],
              });
            if (value.includes("/artifacts"))
              return response({
                artifacts: [
                  { id: 1, name: "playwright-e2e-results-v1-15-1-0", archive_download_url: "https://artifact/1" },
                ],
              });
            return response(archive);
          },
        },
        [run],
      );
    await expect(
      collect(
        buildStoredZip([
          ["results/playwright-results.json", validReport],
          ["trace/video.webm", "x".repeat(11 * 1024 * 1024)],
        ]),
      ),
    ).resolves.toHaveLength(1);
    await expect(
      collect(
        buildStoredZip([
          ["results/playwright-results.json", validReport],
          ["results/playwright-results.json", validReport],
        ]),
      ),
    ).rejects.toThrow("exactly one results/playwright-results.json");
    for (const invalid of [
      "{}",
      JSON.stringify({ suites: [{ title: "not-a-complete-playwright-suite" }] }),
      JSON.stringify({
        suites: [
          {
            title: "suite",
            suites: [],
            specs: [{ title: "spec", tests: [], unknown: true }],
          },
        ],
      }),
      JSON.stringify(
        perSpecReport({
          test: {
            expectedStatus: "passed",
            projectName: "chromium",
            results: [{ retry: 0, status: "failed" }],
            status: "expected",
          },
        }),
      ),
      JSON.stringify({ suites: [{ title: "suite", specs: "wrong" }] }),
      JSON.stringify({
        suites: [
          {
            title: "suite",
            suites: [],
            specs: [
              {
                title: "spec",
                tests: [
                  {
                    expectedStatus: "passed",
                    projectName: "chromium",
                    results: [{ retry: 0, status: "unknown" }],
                    status: "unexpected",
                  },
                ],
              },
            ],
          },
        ],
      }),
    ]) {
      await expect(collect(buildStoredZip([["results/playwright-results.json", invalid]]))).rejects.toThrow(
        "malformed results/playwright-results.json",
      );
    }
    await expect(
      collect(buildStoredZip([["results/playwright-results.json", `{"suites":[]}${" ".repeat(2 * 1024 * 1024)}`]])),
    ).rejects.toThrow("exceeds 2 MiB");
  });

  it("keeps skipped results neutral and recognizes all supported terminal statuses", () => {
    const entries = ["passed", "skipped", "failed", "timedOut", "interrupted"].map((terminalStatus) => ({
      occurrenceId: `1:1:0:${terminalStatus}`,
      name: terminalStatus,
      terminalStatus,
      terminalRetry: terminalStatus === "passed" ? 1 : 0,
      runUrl: "https://run/1",
    }));
    expect(summarizePerSpecFlakes(entries)).toEqual([
      { name: "failed", passedOnRetryCount: 0, failedJobCount: 1, runUrl: "https://run/1" },
      { name: "interrupted", passedOnRetryCount: 0, failedJobCount: 1, runUrl: "https://run/1" },
      { name: "passed", passedOnRetryCount: 1, failedJobCount: 0, runUrl: "https://run/1" },
      { name: "timedOut", passedOnRetryCount: 0, failedJobCount: 1, runUrl: "https://run/1" },
    ]);
  });

  (process.env.PLAYWRIGHT_REAL_REPORTER_PROBE === "true" ? it : it.skip)(
    "classifies the complete Playwright 1.60 outcome taxonomy from real JSON reporter output",
    async () => {
      const reports = await runRealPlaywrightTaxonomyProbe();
      const normalized = {
        suites: reports.flatMap((report) => normalizePlaywrightPerSpecReport(report).suites),
      };
      const entries = extractPlaywrightSpecTelemetry(normalized, {
        run: { id: 160, html_url: "https://run/160" },
        runAttempt: 1,
        matrixIndex: "0",
      });
      const entryFor = (title) => entries.find((entry) => entry.name.split(" › ").includes(title));

      expect(entryFor("ordinary pass")).toMatchObject({ terminalStatus: "passed", terminalRetry: 0 });
      expect(entryFor("ordinary unexpected failure")).toMatchObject({ terminalStatus: "failed", terminalRetry: 1 });
      expect(entryFor("skip")).toMatchObject({ terminalStatus: "skipped", terminalRetry: 0 });
      expect(entryFor("expected failure")).toMatchObject({ terminalStatus: "expected", terminalRetry: 0 });
      expect(entryFor("unexpected pass")).toMatchObject({ terminalStatus: "failed", terminalRetry: 1 });
      expect(entryFor("retry pass")).toMatchObject({ terminalStatus: "passed", terminalRetry: 1 });
      expect(entryFor("timedOut")).toMatchObject({ terminalStatus: "timedOut", terminalRetry: 1 });
      expect(entryFor("interrupted")).toMatchObject({ terminalStatus: "interrupted", terminalRetry: 0 });

      const summary = summarizePerSpecFlakes(
        entries.filter((entry) => !entry.name.includes("failure that stops the run")),
      );
      const summaryFor = (title) => summary.find((item) => item.name.split(" › ").includes(title));
      expect(summaryFor("expected failure")).toBeUndefined();
      expect(summaryFor("retry pass")).toMatchObject({ passedOnRetryCount: 1 });
      expect(summary.filter((item) => item.failedJobCount > 0)).toHaveLength(4);
    },
    60_000,
  );

  it("builds a weekly digest with previous-window trends and breaches", () => {
    const windows = buildDigestWindows("2026-07-08T00:00:00.000Z", 7);
    const digest = buildFlakeDigest({
      checkedAt: "2026-07-08T00:00:00.000Z",
      repository: "chase-sets/chase-sets",
      windows,
      thresholds: { retryCount: 3, flakyFailureCount: 1 },
      currentRuns: [
        { name: "Platform PR", run_attempt: 3, conclusion: "success" },
        { name: "Platform PR", run_attempt: 2, conclusion: "success" },
        { name: "Platform Production", run_attempt: 2, conclusion: "failure" },
      ],
      previousRuns: [{ name: "Platform PR", run_attempt: 2, conclusion: "success" }],
    });

    expect(digest).toMatchObject({
      schemaVersion: "release-health-flake-digest/v1",
      retryCount: 4,
      flakyFailureCount: 3,
      previousRetryCount: 1,
      previousFlakyFailureCount: 1,
      breachCount: 1,
      issueTitle: "CI flake digest breach: 2026-07-01 to 2026-07-08",
    });
    expect(digest.topFlakyJobs[0]).toMatchObject({
      name: "Platform PR",
      retryCount: 3,
      flakyFailureCount: 3,
      previousRetryCount: 1,
      retryTrend: 2,
      flakyFailureTrend: 2,
      breached: true,
    });
    expect(digest.markdown).toContain("| Platform PR | 3 | +2 | 3 | +2 | yes |");
    expect(digest.issueBody).toContain("Follow-up policy");
  });

  it("collects current and previous workflow windows from GitHub", async () => {
    const seen = [];
    const digest = await collectReleaseHealthFlakeDigest({
      repository: "chase-sets/chase-sets",
      token: "token",
      checkedAt: "2026-07-08T00:00:00.000Z",
      windowDays: 7,
      retryThreshold: 3,
      flakyFailureThreshold: 1,
      fetchImpl: async (url, options) => {
        seen.push({ url: new URL(url), options });
        if (url.pathname.endsWith("/issues")) {
          return { ok: true, headers: { get: () => null }, json: async () => [] };
        }
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => ({
            workflow_runs: url.searchParams.get("created")?.startsWith("2026-07-01")
              ? [{ name: "Platform PR", run_attempt: 2, conclusion: "success" }]
              : [],
          }),
        };
      },
    });

    expect(seen).toHaveLength(3);
    expect(seen[0].options.headers.Authorization).toBe("Bearer token");
    expect(
      seen
        .map((call) => call.url.searchParams.get("created"))
        .filter(Boolean)
        .sort(),
    ).toEqual([
      "2026-06-24T00:00:00.000Z..2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z..2026-07-08T00:00:00.000Z",
    ]);
    expect(digest.retryCount).toBe(1);
  });

  it("writes json, markdown, and GitHub outputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flake-digest-"));
    try {
      const outPath = join(dir, "digest.json");
      const markdownOutPath = join(dir, "digest.md");
      const githubOutputPath = join(dir, "github-output.txt");
      await writeReleaseHealthFlakeDigest({
        repository: "chase-sets/chase-sets",
        checkedAt: "2026-07-08T00:00:00.000Z",
        windowDays: 7,
        retryThreshold: 1,
        flakyFailureThreshold: 1,
        outPath,
        markdownOutPath,
        githubOutputPath,
        fetchImpl: async (url) => {
          if (url.pathname.endsWith("/issues")) {
            return { ok: true, headers: { get: () => null }, json: async () => [] };
          }
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => ({
              workflow_runs: url.searchParams.get("created")?.startsWith("2026-07-01")
                ? [{ name: "Platform PR", run_attempt: 2, conclusion: "success" }]
                : [],
            }),
          };
        },
      });

      expect(JSON.parse(await readFile(outPath, "utf8"))).toMatchObject({ breachCount: 1 });
      expect(await readFile(markdownOutPath, "utf8")).toContain("CI flake digest");
      expect(await readFile(githubOutputPath, "utf8")).toContain("breach_count=1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses workflow defaults from the environment", () => {
    expect(
      parseReleaseHealthFlakeDigestArgs(["--window-days", "14"], {
        GITHUB_REPOSITORY: "chase-sets/chase-sets",
        GH_TOKEN: "token",
        GITHUB_OUTPUT: "github-output.txt",
      }),
    ).toMatchObject({
      repository: "chase-sets/chase-sets",
      token: "token",
      windowDays: 14,
      retryThreshold: 3,
      flakyFailureThreshold: 1,
      githubOutputPath: "github-output.txt",
    });
  });
});

function perSpecReport({
  suiteTitle = "suite",
  specTitle = "spec",
  test = {
    expectedStatus: "passed",
    projectName: "chromium",
    results: [{ retry: 0, status: "passed" }],
    status: "expected",
  },
} = {}) {
  return {
    suites: [
      {
        title: suiteTitle,
        specs: [{ title: specTitle, tests: [test] }],
        suites: [],
      },
    ],
  };
}

async function runRealPlaywrightTaxonomyProbe() {
  await mkdir(join(process.cwd(), "artifacts"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), "artifacts", "playwright-taxonomy-"));
  const playwrightCli = join(process.cwd(), "node_modules", "@playwright", "test", "cli.js");
  try {
    const taxonomy = join(root, "taxonomy");
    await mkdir(taxonomy);
    await writeFile(
      join(taxonomy, "playwright.config.mjs"),
      `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", outputDir: "test-results", retries: 1, workers: 1, timeout: 40, reporter: [["json", { outputFile: "report.json" }]] });\n`,
    );
    await writeFile(
      join(taxonomy, "taxonomy.spec.mjs"),
      `import { test, expect } from "@playwright/test";
test("ordinary pass", () => expect(1).toBe(1));
test("ordinary unexpected failure", () => expect(1).toBe(2));
test.skip("skip", () => {});
test("expected failure", () => { test.fail(); expect(1).toBe(2); });
test("unexpected pass", () => { test.fail(); expect(1).toBe(1); });
test("retry pass", ({}, testInfo) => expect(testInfo.retry).toBe(1));
test("timedOut", async () => new Promise((resolve) => setTimeout(resolve, 250)));\n`,
    );
    await runPlaywright(playwrightCli, taxonomy);

    const interrupted = join(root, "interrupted");
    await mkdir(interrupted);
    await writeFile(
      join(interrupted, "playwright.config.mjs"),
      `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", outputDir: "test-results", fullyParallel: true, maxFailures: 1, retries: 0, workers: 2, timeout: 10_000, reporter: [["json", { outputFile: "report.json" }]] });\n`,
    );
    await writeFile(
      join(interrupted, "interrupted.spec.mjs"),
      `import { test, expect } from "@playwright/test";
test("failure that stops the run", async () => { await new Promise((resolve) => setTimeout(resolve, 500)); expect(1).toBe(2); });
test("interrupted", async () => new Promise((resolve) => setTimeout(resolve, 5_000)));\n`,
    );
    await runPlaywright(playwrightCli, interrupted);

    return [
      JSON.parse(await readFile(join(taxonomy, "report.json"), "utf8")),
      JSON.parse(await readFile(join(interrupted, "report.json"), "utf8")),
    ];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runPlaywright(playwrightCli, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, "test", "--config", "playwright.config.mjs"], {
      cwd,
      env: { ...process.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", () => {
      // The taxonomy intentionally contains unexpected outcomes. The artifact,
      // rather than the runner exit code, is the evidence under test.
      readFile(join(cwd, "report.json"), "utf8").then(resolve, () => reject(new Error(stderr)));
    });
  });
}

function buildStoredZip(entries) {
  const locals = [];
  const directories = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name);
    const contents = Buffer.from(text);
    const local = Buffer.alloc(30 + nameBytes.length + contents.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    contents.copy(local, 30 + nameBytes.length);
    locals.push(local);
    const directory = Buffer.alloc(46 + nameBytes.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(contents.length, 20);
    directory.writeUInt32LE(contents.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    nameBytes.copy(directory, 46);
    directories.push(directory);
    offset += local.length;
  }
  const central = Buffer.concat(directories);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
