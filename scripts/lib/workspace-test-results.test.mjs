import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTestResultsInvocation,
  finalizeWorkspaceTestResults,
  normalizeVitestReport,
  resolveVitestResultsProfile,
  validateWorkspaceTestResults,
} from "./workspace-test-results.mjs";

// Synthetic identities, shaped like Vitest 4.1's built-in JSON reporter.
function report(state = "passed") {
  return {
    numTotalTests: 1,
    testResults: [
      {
        name: path.resolve("bounded-contexts/synthetic/example.test.ts"),
        status: state === "failed" ? "failed" : "passed",
        message: "",
        assertionResults: [
          {
            ancestorTitles: ["suite"],
            title: "test",
            fullName: "suite test",
            status: state,
            ...(state === "passed" || state === "failed" ? { duration: 1.25 } : {}),
          },
        ],
      },
    ],
  };
}

function env(directory) {
  return {
    CHASE_SETS_TEST_RESULTS_DIR: directory,
    CHASE_SETS_TEST_RESULTS_HEAD_SHA: "a".repeat(40),
    GITHUB_REPOSITORY: "synthetic/repository",
    GITHUB_SHA: "b".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "unit-tests",
  };
}

function withDirectory(action) {
  const directory = mkdtempSync(path.join(tmpdir(), "workspace-test-results-"));
  try {
    return action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function payload(directory) {
  const workspace = { name: "@chase-sets/synthetic" };
  const collector = createTestResultsInvocation(env(directory), [{ workspace }], "test");
  const started = collector.start(workspace, "test");
  writeFileSync(started.output, JSON.stringify(report()));
  collector.complete(workspace, started);
  collector.finish();
  return finalizeWorkspaceTestResults(directory);
}

describe("workspace test results contract", () => {
  it("requires explicit directory and unique absolute child path, not CI=true", () => {
    expect(
      resolveVitestResultsProfile({ CI: "true", CHASE_SETS_VITEST_JSON_FILE: path.resolve("unused.json") }),
    ).toEqual({});
    expect(() => resolveVitestResultsProfile(env("results"))).toThrow(/absolute/);
    expect(() =>
      resolveVitestResultsProfile({ ...env("results"), CHASE_SETS_VITEST_JSON_FILE: "relative.json" }),
    ).toThrow(/absolute/);
    expect(
      resolveVitestResultsProfile({ ...env("results"), CHASE_SETS_VITEST_JSON_FILE: path.resolve("result.json") }),
    ).toEqual({
      reporters: ["default", "json"],
      outputFile: { json: path.resolve("result.json") },
    });
    expect(createTestResultsInvocation({ CI: "true" }, [], "test")).toBeUndefined();
  });

  it("pins all actual Vitest states, totals, relative names, durations and zero unconfigured retries", () => {
    for (const state of ["passed", "failed", "skipped", "pending", "todo", "disabled"]) {
      const normalized = normalizeVitestReport(report(state));
      expect(normalized.assertionCount).toBe(1);
      expect(normalized.rows[0]).toEqual({
        file: "bounded-contexts/synthetic/example.test.ts",
        fullName: "suite test",
        state,
        durationMs: ["passed", "failed"].includes(state) ? 1.25 : 0,
        retryCount: 0,
      });
    }
    expect(() => normalizeVitestReport(report("unknown"))).toThrow(/state/);
    expect(() => normalizeVitestReport({ ...report(), numTotalTests: 2 })).toThrow(/total/);
    const suiteFailure = report("skipped");
    suiteFailure.testResults[0].status = "failed";
    suiteFailure.testResults[0].message = "beforeAll failed";
    expect(normalizeVitestReport(suiteFailure).fileFailureCount).toBe(1);
    const zeroAssertionFailure = {
      numTotalTests: 0,
      testResults: [{ name: path.resolve("example.test.ts"), status: "failed", assertionResults: [] }],
    };
    expect(normalizeVitestReport(zeroAssertionFailure)).toMatchObject({ fileFailureCount: 1, assertionCount: 0 });
  });

  it("recursively closes the normalized schema and rejects invalid fields and ambiguous identities", () =>
    withDirectory((directory) => {
      const valid = payload(directory);
      const invalid = [
        (p) => {
          p.extra = true;
        },
        (p) => {
          p.producer.extra = true;
        },
        (p) => {
          p.producer.runId = 123;
        },
        (p) => {
          p.invocations[0].extra = true;
        },
        (p) => {
          p.invocations[0].tasks[0].extra = true;
        },
        (p) => {
          p.invocations[0].tasks[0].rows[0].extra = true;
        },
        (p) => {
          p.invocations[0].tasks[0].rows[0].durationMs = -1;
        },
        (p) => {
          p.invocations[0].tasks[0].rows[0].durationMs = Infinity;
        },
        (p) => {
          p.invocations[0].tasks[0].rows[0].retryCount = 1;
        },
        (p) => {
          p.invocations[0].tasks[0].rows[0].file = "../escape.test.ts";
        },
        (p) => {
          p.invocations[0].tasks[0].rows[0].fullName = "";
        },
        (p) => {
          p.invocations[0].tasks[0].rows[0].state = "unknown";
        },
        (p) => {
          p.invocations[0].startedAt = "2026-10-04T00:00:00";
        },
        (p) => {
          p.invocations.push(structuredClone(p.invocations[0]));
        },
        (p) => {
          p.invocations[0].tasks.push(structuredClone(p.invocations[0].tasks[0]));
        },
        (p) => {
          p.invocations[0].tasks[0].rows.push(structuredClone(p.invocations[0].tasks[0].rows[0]));
          p.invocations[0].tasks[0].assertionCount++;
        },
      ];
      for (const change of invalid) {
        const candidate = structuredClone(valid);
        change(candidate);
        expect(() => validateWorkspaceTestResults(candidate)).toThrow();
      }
    }));

  it("keeps missing started reports unknown and never-started partitions neutral beside failed assertions", () =>
    withDirectory((directory) => {
      const workspace = { name: "@chase-sets/synthetic" };
      const collector = createTestResultsInvocation(
        env(directory),
        [{ workspace, scriptNames: ["test:db:1", "test:db:2"] }],
        "test:db*",
      );
      const started = collector.start(workspace, "test:db:1");
      writeFileSync(started.output, JSON.stringify(report("failed")));
      collector.complete(workspace, started);
      collector.finish();
      const missing = createTestResultsInvocation(env(directory), [{ workspace }], "test:unit");
      const absent = missing.start(workspace, "test:unit");
      missing.complete(workspace, absent);
      missing.finish();
      const result = finalizeWorkspaceTestResults(directory);
      const tasks = result.invocations.flatMap((invocation) => invocation.tasks);
      expect(tasks.find((task) => task.script === "test:db:1").rows[0].state).toBe("failed");
      expect(tasks.find((task) => task.script === "test:db:2").status).toBe("not-started");
      expect(tasks.find((task) => task.script === "test:unit").status).toBe("unknown");
      expect(started.output).not.toBe(absent.output);
    }));

  it("rejects missing invocation manifests rather than treating diagnostic directories as proof", () =>
    withDirectory((directory) => {
      const collector = createTestResultsInvocation(env(directory), [], "test");
      collector.finish();
      const result = finalizeWorkspaceTestResults(directory);
      expect(result.invocations).toHaveLength(1);
      const invalid = structuredClone(result);
      invalid.invocations = [];
      expect(() => validateWorkspaceTestResults(invalid)).toThrow(/Invocation/);
      rmSync(path.join(directory, "invocations", result.invocations[0].id, "workspace-test-results.json"));
      expect(() => finalizeWorkspaceTestResults(directory)).toThrow(/ENOENT/);
    }));
});
