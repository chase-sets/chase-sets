import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  captureCensusFiles,
  captureGroups,
  deriveCaptureCensusCaseNames,
} from "../deployables/platform-api/scripts/b3-capture-census.mjs";
import { validateBootstrapDbEvidence } from "../deployables/platform-api/scripts/validate-bootstrap-db-evidence.mjs";
import {
  classifyGuardScreen,
  nonminimalCaptureViolation,
} from "../deployables/platform-api/scripts/b3-guard-screen-policy.mjs";

const api = resolve("deployables/platform-api");
const frozen = JSON.parse(readFileSync(resolve(api, "scripts/b3-capture-manifest.json"), "utf8"));
const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true });
});

function evidence(change = () => {}) {
  const parent = resolve("artifacts/7993-b3-input-source-r1/test-fixtures");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "synthetic-"));
  temporary.push(directory);
  const groups = {};
  for (const [unit, files] of Object.entries(captureGroups)) {
    groups[unit] = [
      {
        kind: "runStart",
        unit,
        startedAt: "2026-01-01T00:00:00.000Z",
        checkoutSha: "a".repeat(40),
        githubSha: "a".repeat(40),
        eventHeadSha: null,
        event: "push",
        runId: "SYNTHETIC-RUN",
        runAttempt: "1",
        job: "SYNTHETIC-JOB",
        rawParents: ["b".repeat(40)],
      },
      ...files.map((file) => {
        const entry = frozen[basename(file)];
        return {
          kind: "module",
          file: basename(file),
          sourceSha256: entry.sourceSha256,
          identities: entry.cases,
          state: "passed",
          errors: [],
          diagnostic: { duration: 5 },
          cases: (entry.censusCaseNames ?? entry.cases.map(({ name }) => name)).map((name) => ({
            name,
            fullName: "SYNTHETIC SUITE " + name,
            result: { state: "passed" },
            durationMs: 1,
            diagnostic: { duration: 1 },
          })),
        };
      }),
      {
        kind: "runEnd",
        finishedAt: "2026-01-01T00:00:01.000Z",
        wallMs: 1000,
        moduleCount: files.length,
        reason: "passed",
        errors: [],
      },
    ];
  }
  const manifest = structuredClone(frozen);
  change(groups, manifest);
  for (const [unit, rows] of Object.entries(groups))
    writeFileSync(
      resolve(directory, unit.replaceAll(":", "-") + ".jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
  return validateBootstrapDbEvidence({ directory, manifest, expectedHead: "a".repeat(40) });
}

describe("B3 exact census transport", () => {
  it("freezes all 18 entries and every one of the 61 expanded census cases", () => {
    expect(Object.values(captureGroups).flat()).toHaveLength(18);
    const fixture = readFileSync(resolve(api, "__tests__/operator-session/fixture.ts"), "utf8");
    for (const file of captureCensusFiles) {
      const names = deriveCaptureCensusCaseNames(file, readFileSync(resolve(api, "__tests__", file), "utf8"), fixture);
      expect(names).toEqual(frozen[basename(file)].censusCaseNames);
    }
    expect(Object.values(frozen).flatMap((entry) => entry.censusCaseNames ?? [])).toHaveLength(61);
    expect(evidence()).toMatchObject({ valid: true, violations: [] });
  });
  it.each([
    ["missing census module", (rows) => rows["test:db:2"].splice(4, 1)],
    ["duplicate module", (rows) => rows["test:db:2"].splice(4, 0, rows["test:db:2"][4])],
    [
      "unknown module",
      (rows) => {
        rows["test:db:2"][4].file = "SYNTHETIC-UNKNOWN.db.test.ts";
      },
    ],
    ["missing expanded case", (rows) => rows["test:db:2"][4].cases.pop()],
    [
      "skipped expanded case",
      (rows) => {
        rows["test:db:2"][4].cases[0].result.state = "skipped";
      },
    ],
    [
      "failed expanded case",
      (rows) => {
        rows["test:db:2"][4].cases[0].result.state = "failed";
      },
    ],
    [
      "renamed expanded case",
      (rows) => {
        rows["test:db:2"][4].cases[0].name = "SYNTHETIC OTHER";
      },
    ],
    ["partial unit", (rows) => rows["test:db:3"].pop()],
    [
      "different owner",
      (rows) => {
        rows["test:db:2"][0].runId = "SYNTHETIC-OTHER-RUN";
      },
    ],
    [
      "source mismatch",
      (rows) => {
        rows["test:db:2"][4].sourceSha256 = "0".repeat(64);
      },
    ],
    [
      "incomplete census manifest",
      (_rows, manifest) => {
        delete manifest["seed-command-catalog.db.test.ts"];
      },
    ],
    [
      "census moved to unit 1",
      (_rows, manifest) => {
        manifest["seed-command-catalog.db.test.ts"].executionUnit = "test:db:1";
      },
    ],
  ])("refuses labeled synthetic %s", (_name, change) => {
    expect(evidence(change).valid).toBe(false);
  });
  it("refuses an unknown census file or table without executing it", () => {
    expect(() => deriveCaptureCensusCaseNames("SYNTHETIC.db.test.ts", "", "")).toThrow();
    expect(() =>
      deriveCaptureCensusCaseNames(captureCensusFiles[0], 'it.each(untrusted())("case %#", () => {});', ""),
    ).toThrow();
  });
});

function screen(minimum = 3) {
  return {
    complete: true,
    elapsedMs: 60000,
    exitCode: 0,
    result: {
      caseCount: 62,
      expectedCaseCount: 62,
      fileCount: 12,
      partitionUnitCount: 3,
      violations: minimum === 3 ? [] : [nonminimalCaptureViolation(minimum)],
      schedule: {
        observedUnitCount: 3,
        minimumUnitCount: minimum,
        units: [100000, 200000, 300000].map((makespanMs) => ({ makespanMs })),
        aggregateWithOverheadMs: 700000,
      },
    },
    census: { bootstrapEntries: Array(12).fill("SYNTHETIC"), dbEntries: Array(18).fill("SYNTHETIC"), violations: [] },
  };
}
describe("B3 screen classification, synthetic data only", () => {
  it.each([1, 2, 3])("classifies minimum %i without exposing or inventing a witness", (minimum) => {
    expect(classifyGuardScreen(screen(minimum))).toMatchObject({
      classification: minimum === 3 ? "SCREEN_OK" : "EXPECTED_CAPTURE_NONMINIMAL",
      productQualification: false,
      derivedMinimumProjectionBound: { unitMs: 480000, aggregateMs: 1080000 + minimum * 60000 },
    });
  });
  it.each([
    ["extra violation", (x) => x.result.violations.push("SYNTHETIC extra")],
    [
      "zero violations below observed",
      (x) => {
        x.result.violations = [];
      },
    ],
    [
      "substring",
      (x) => {
        x.result.violations[0] += "SYNTHETIC suffix";
      },
    ],
    [
      "near match",
      (x) => {
        x.result.violations[0] = x.result.violations[0].replace("spends", "spend");
      },
    ],
    [
      "null minimum",
      (x) => {
        x.result.schedule.minimumUnitCount = null;
      },
    ],
    [
      "below-minimum topology",
      (x) => {
        x.result.schedule.minimumUnitCount = 4;
      },
    ],
    [
      "60001 ms",
      (x) => {
        x.elapsedMs = 60001;
      },
    ],
    [
      "truncated output",
      (x) => {
        x.complete = false;
      },
    ],
    [
      "process failure",
      (x) => {
        x.exitCode = 1;
      },
    ],
    [
      "wrong case count",
      (x) => {
        x.result.caseCount = 61;
      },
    ],
    [
      "raw unit over bound",
      (x) => {
        x.result.schedule.units[0].makespanMs = 420001;
      },
    ],
  ])("refuses %s", (_name, mutate) => {
    const input = screen(2);
    mutate(input);
    expect(classifyGuardScreen(input).classification).toBe("REFUSAL");
  });
});

it("retains the exact push-only one-job producer, resources, reporters and explicit deadlines", () => {
  const text = readFileSync(".github/workflows/7993-b3-input-capture.yml", "utf8");
  const workflow = parse(text);
  expect(Object.keys(workflow.on)).toEqual(["push"]);
  expect(workflow.on.push.branches).toEqual(["codex/7993-b3-input-capture-r1"]);
  expect(Object.keys(workflow.jobs)).toEqual(["measurement"]);
  expect(workflow.jobs.measurement["timeout-minutes"]).toBe(30);
  expect(workflow.jobs.measurement.if).toContain("github.event_name == 'push'");
  expect(workflow.jobs.measurement.if).toContain("github.run_attempt == 1");
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.measurement.services.postgres.image).toBe("pgvector/pgvector:pg16");
  for (const required of [
    "deadlineMs: 600000",
    "600000 - (performance.now() - start)",
    "record.durationMs <= 600000",
    "units.length !== 3",
    "target_max_locks_per_transaction=512",
    "target_max_connections=300",
    "--maxWorkers=3 --reporter=default --reporter=./scripts/bootstrap-db-evidence-reporter.mjs",
    "'--reporter=json'",
    "membersAfterCleanup",
    "if-no-files-found: error",
  ])
    expect(text).toContain(required);
  expect(text).not.toContain("workflow_dispatch:");
});

it("executes the producer's literal identity guard against synthetic direct-push and shallow controls", () => {
  const text = readFileSync(".github/workflows/7993-b3-input-capture.yml", "utf8");
  const start = text.indexOf("          if (identity.checkoutSha");
  const end = text.indexOf("          const { createHash }", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const check = new Function("identity", text.slice(start, end));
  const positive = {
    checkoutSha: "a".repeat(40),
    githubSha: "a".repeat(40),
    pushAfter: "a".repeat(40),
    sourceBase: "b".repeat(40),
    parents: ["b".repeat(40)],
    headParents: ["a".repeat(40)],
    event: "push",
    runAttempt: "1",
    repository: "chase-sets/chase-sets",
    ref: "refs/heads/codex/7993-b3-input-capture-r1",
    laneMode: null,
    node: "v24.0.0",
    pnpm: "11.0.9",
    imageOS: "SYNTHETIC-OS",
    imageVersion: "SYNTHETIC-VERSION",
    postgresImageDigests: ["SYNTHETIC-DIGEST"],
  };
  expect(() => check(positive)).not.toThrow();
  for (const patch of [
    { parents: [] },
    { parents: ["c".repeat(40)] },
    { parents: ["b".repeat(40), "c".repeat(40)] },
    { checkoutSha: "c".repeat(40) },
    { pushAfter: "c".repeat(40) },
    { ref: "refs/heads/SYNTHETIC-WRONG" },
    { event: "workflow_dispatch" },
    { runAttempt: "2" },
    { laneMode: "1" },
  ])
    expect(() => check({ ...positive, ...patch })).toThrow();
});
