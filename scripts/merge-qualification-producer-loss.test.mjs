import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildMergeQualificationCandidate,
  buildMergeQualificationEvent,
  inventoryMergeQualificationProducerAttempts,
  readMergeQualificationProducerTerminalRecords,
  readMergeQualificationProducerImageEligibility,
  readMergeQualificationAdvisoryCleanupMarkers,
  readHistoricalProducerPolicy,
  reconcileMergeQualificationProducerAttempt,
  validateMergeQualificationCandidate,
  validateMergeQualificationProducerTerminal,
  main,
} from "./merge-qualification.mjs";

const sha = "a".repeat(40);
const tree = "b".repeat(40);
const policyRevision = "c".repeat(40);
const now = new Date("2026-07-21T12:00:00.000Z");

const producer = (overrides = {}) => ({
  id: 4000,
  run_attempt: 1,
  workflow_id: 11,
  path: ".github/workflows/platform-pr.yml",
  event: "merge_group",
  status: "completed",
  conclusion: "success",
  created_at: "2026-07-21T10:00:00Z",
  run_started_at: "2026-07-21T10:00:00Z",
  updated_at: "2026-07-21T10:01:00Z",
  head_sha: sha,
  repository: { full_name: "chase-sets/chase-sets" },
  ...overrides,
});

const candidate = buildMergeQualificationCandidate({
  repository: "chase-sets/chase-sets",
  workflowId: "11",
  workflowPath: ".github/workflows/platform-pr.yml",
  runId: "4000",
  runAttempt: "1",
  queueBaseSha: "d".repeat(40),
  pullRequests: [{ number: 1, headSha: "e".repeat(40) }],
  candidateSha: sha,
  candidateTreeSha: tree,
  builtImageDigest: `sha256:${"f".repeat(64)}`,
  policyRevision,
  capturedAt: "2026-07-21T10:00:00Z",
}).record;

const cliGhPreload = `
import { readFileSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const fixture = JSON.parse(readFileSync(process.env.MERGE_QUALIFICATION_TEST_FIXTURE, "utf8"));
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
  if (command === "git") {
    if (args[0] === "log") return \`${"${fixture.policyRevision}\\t2026-07-21T09:00:00Z\\n"}\`;
    if (args[0] === "cat-file") return "";
    if (args[0] === "ls-tree") return "scripts/merge-qualification-policy.json\\n";
    if (args[0] === "show") return fixture.policyContent;
    throw new Error(\`unexpected git call: \${args.join(" ")}\`);
  }
  if (command !== "gh") return originalExecFileSync(command, args, options);
  if (args[0] === "api") {
    const endpoint = args[1];
    if (endpoint.includes("workflows/platform-pr.yml/runs")) return JSON.stringify(fixture.producerRuns);
    if (endpoint.includes("workflows/platform-merge-qualification.yml/runs"))
      return JSON.stringify(fixture.advisoryRuns);
    if (endpoint.includes("/jobs?")) return JSON.stringify(fixture.jobs);
    if (endpoint.includes("/commits/") && endpoint.endsWith("/pulls")) return JSON.stringify(fixture.landing);
    const artifactName = endpoint.match(/\\/artifacts\\?name=([^&]+)/u)?.[1];
    if (artifactName) return JSON.stringify({ total_count: (fixture.artifacts[artifactName] ?? []).length, artifacts: fixture.artifacts[artifactName] ?? [] });
    const ownerId = endpoint.match(/\\/runs\\/(\\d+)$/u)?.[1];
    if (ownerId) return JSON.stringify(fixture.owners[ownerId]);
    throw new Error(\`unexpected gh api call: \${endpoint}\`);
  }
  if (args[0] === "run" && args[1] === "download") {
    const name = args[args.indexOf("--name") + 1];
    const directory = args[args.indexOf("--dir") + 1];
    for (const [fileName, bytes] of Object.entries(fixture.downloads[name] ?? {}))
      writeFileSync(path.join(directory, fileName), bytes);
    return "";
  }
  throw new Error(\`unexpected gh call: \${args.join(" ")}\`);
};
syncBuiltinESMExports();
`;

function runQualificationCli(commandArgs, fixture, inputFiles = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "qualification-cli-process-"));
  const fixturePath = path.join(dir, "fixture.json");
  const preloadPath = path.join(dir, "gh-preload.mjs");
  const scriptPath = "scripts/merge-qualification.mjs";
  writeFileSync(fixturePath, JSON.stringify(fixture));
  writeFileSync(preloadPath, cliGhPreload);
  const producerPath = path.join(dir, "producer.json");
  const advisoryPath = path.join(dir, "advisory.json");
  if (fixture.producer) writeFileSync(producerPath, JSON.stringify(fixture.producer));
  if (fixture.advisory) writeFileSync(advisoryPath, JSON.stringify(fixture.advisory));
  const outputPath = path.join(dir, "out.json");
  const args = [
    "--import",
    pathToFileURL(preloadPath).href,
    scriptPath,
    ...commandArgs.map((arg) =>
      arg === "__CLI_OUTPUT__"
        ? outputPath
        : arg === "__CLI_PRODUCER__"
          ? producerPath
          : arg === "__CLI_ADVISORY__"
            ? advisoryPath
            : arg,
    ),
  ];
  const env = { ...process.env, MERGE_QUALIFICATION_TEST_FIXTURE: fixturePath };
  try {
    try {
      const stdout = execFileSync(process.execPath, args, { cwd: process.cwd(), env, encoding: "utf8" });
      return {
        status: 0,
        stdout,
        stderr: "",
        files: {
          ...Object.fromEntries(Object.entries(inputFiles).map(([name, file]) => [name, readFileSync(file, "utf8")])),
          output: readFileSync(outputPath, "utf8"),
        },
      };
    } catch (error) {
      return {
        status: error.status ?? 1,
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? ""),
        files: {},
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const artifact = (id, name, writerId) => ({ id, name, expired: false, workflow_run: { id: writerId } });
const observerWriter = (id) => ({
  id,
  repository: { full_name: "chase-sets/chase-sets" },
  head_repository: { full_name: "chase-sets/chase-sets" },
  head_branch: "main",
  path: ".github/workflows/platform-merge-qualification-observer.yml",
  event: "schedule",
});

describe("producer dispatch-loss reconciliation", () => {
  it("inventories complete producer and advisory windows before filtering", async () => {
    const calls = [];
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) => {
        calls.push(endpoint);
        if (endpoint.includes("platform-pr.yml")) {
          return { total_count: 1, workflow_runs: [producer()] };
        }
        return { total_count: 0, workflow_runs: [] };
      },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ enabled: true }),
        decision: { enabled: true, reasonCode: "policy_enabled" },
      }),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("platform-pr.yml/runs");
    expect(calls[1]).toContain("platform-merge-qualification.yml/runs");
    expect(result.errors).toEqual([]);
    expect(result.attempts).toMatchObject([{ run_id: "4000", run_attempt: "1", advisoryRunPresent: false }]);
  });

  it("does not read candidate or policy before a missing-advisory join", async () => {
    const reads = [];
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => new Date("2026-07-21T10:05:00Z"),
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 1, workflow_runs: [{ display_title: "Merge Qualification producer 4000-1" }] },
      readHistoricalPolicyContent: async () => reads.push("policy"),
    });
    expect(result.attempts).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("does not admit a producer to per-item inspection before the fifteen-minute tick", async () => {
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => new Date("2026-07-21T10:05:00Z"),
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ enabled: true }),
        decision: { enabled: true, reasonCode: "policy_enabled" },
      }),
    });
    expect(result).toEqual({ attempts: [], settled: 0, errors: [] });
  });

  it("anchors producer admission to completion rather than start", async () => {
    const completed = producer({
      run_started_at: "2026-07-21T09:30:00Z",
      created_at: "2026-07-21T09:30:00Z",
      updated_at: "2026-07-21T10:01:00Z",
    });
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => new Date("2026-07-21T10:10:00Z"),
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [completed] }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ enabled: true }),
        decision: { enabled: true, reasonCode: "policy_enabled" },
      }),
    });
    expect(result).toEqual({ attempts: [], settled: 0, errors: [] });
  });

  it("anchors the tick to producer completion and admits a late advisory", async () => {
    const completed = producer({
      run_started_at: "2026-07-21T09:30:00Z",
      created_at: "2026-07-21T09:30:00Z",
      updated_at: "2026-07-21T10:01:00Z",
    });
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => new Date("2026-07-21T10:20:00Z"),
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [completed] }
          : {
              total_count: 1,
              workflow_runs: [
                {
                  display_title: "Merge Qualification producer 4000-1",
                  created_at: "2026-07-21T10:17:00Z",
                },
              ],
            },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ enabled: true }),
        decision: { enabled: true, reasonCode: "policy_enabled" },
      }),
      readProducerImageEligibility: async () => true,
    });
    expect(result.attempts).toHaveLength(1);
  });

  it("keeps policy authority failure as one producer unknown", async () => {
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => {
        throw new Error("producer_policy_landing_evidence_unavailable");
      },
      readProducerImageEligibility: async () => true,
    });
    expect(result.errors).toEqual([]);
    expect(result.attempts).toMatchObject([
      {
        historicalPolicyState: "unknown",
        historicalPolicyReason: "producer_policy_landing_evidence_unavailable",
      },
    ]);
  });

  it("does not emit policy authority unknown before the completion tick", async () => {
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => new Date("2026-07-21T10:05:00Z"),
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => {
        throw new Error("producer_policy_landing_evidence_unavailable");
      },
    });
    expect(result).toEqual({ attempts: [], settled: 0, errors: [] });
  });

  it("does not read image eligibility for an advisory joined before the tick", async () => {
    let eligibilityReads = 0;
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : {
              total_count: 1,
              workflow_runs: [
                {
                  display_title: "Merge Qualification producer 4000-1",
                  created_at: "2026-07-21T10:02:00Z",
                },
              ],
            },
      readProducerImageEligibility: async () => {
        eligibilityReads += 1;
        return true;
      },
    });
    expect(result).toEqual({ attempts: [], settled: 0, errors: [] });
    expect(eligibilityReads).toBe(0);
  });

  it("returns zero attempts for 31 completed producers when default-branch policy was disabled", async () => {
    const producers = Array.from({ length: 31 }, (_, index) => producer({ id: 5000 + index }));
    let reconcileCalls = 0;
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: producers.length, workflow_runs: producers }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ schemaVersion: "merge-qualification-policy/v1", enabled: false }),
        decision: { enabled: false, reasonCode: "policy_disabled" },
      }),
    });
    if (result.attempts.length) reconcileCalls += result.attempts.length;
    expect(result).toEqual({ attempts: [], settled: 0, errors: [] });
    expect(reconcileCalls).toBe(0);
  });

  it.each([
    {
      name: "a ran image job without a push step",
      jobs: {
        total_count: 1,
        jobs: [{ id: 77, name: "Docker Image Build", conclusion: "success", steps: [] }],
      },
      reason: "producer_image_eligibility_invalid",
    },
    {
      name: "a malformed jobs payload",
      jobs: { total_count: 1, jobs: [] },
      reason: "producer_image_eligibility_invalid",
    },
    {
      name: "a jobs transport failure",
      jobs: null,
      reason: "synthetic_transport_502",
    },
  ])("orders policy and tick decisions before image eligibility for $name", async ({ jobs, reason }) => {
    const inventory = async ({ decision, at }) => {
      let jobsGets = 0;
      const result = await inventoryMergeQualificationProducerAttempts({
        repository: "chase-sets/chase-sets",
        now: () => new Date(at),
        requestJson: async (endpoint) => {
          if (endpoint.includes("/jobs?")) {
            jobsGets += 1;
            if (jobs === null) throw new Error(reason);
            return jobs;
          }
          return endpoint.includes("platform-pr.yml")
            ? { total_count: 1, workflow_runs: [producer()] }
            : { total_count: 0, workflow_runs: [] };
        },
        readHistoricalPolicyContent: async () => ({
          revision: policyRevision,
          content: JSON.stringify({ enabled: decision }),
          decision: { enabled: decision, reasonCode: decision ? "policy_enabled" : "policy_disabled" },
        }),
        readProducerImageEligibility: ({ run, repository }) =>
          readMergeQualificationProducerImageEligibility({
            repository,
            run,
            requestJson: async (endpoint) => {
              jobsGets += 1;
              if (jobs === null) throw new Error(reason);
              return jobs;
            },
          }),
      });
      return { result, jobsGets };
    };

    await expect(inventory({ decision: false, at: "2026-07-21T12:00:00Z" })).resolves.toMatchObject({
      result: { attempts: [], errors: [] },
      jobsGets: 0,
    });
    await expect(inventory({ decision: true, at: "2026-07-21T10:05:00Z" })).resolves.toMatchObject({
      result: { attempts: [], errors: [] },
      jobsGets: 0,
    });
    await expect(inventory({ decision: true, at: "2026-07-21T12:00:00Z" })).resolves.toMatchObject({
      result: {
        attempts: [
          {
            historicalPolicyState: "unknown",
            historicalPolicyReason: jobs === null || jobs.jobs.length > 0 ? reason : "run_collection_incomplete",
            imageEligible: null,
          },
        ],
        errors: [],
      },
      jobsGets: 1,
    });
  });

  it("runs producer-inventory through the real image eligibility reader", () => {
    const result = runQualificationCli(
      [
        "producer-inventory",
        "--repository",
        "chase-sets/chase-sets",
        "--default-branch",
        "main",
        "--github-output",
        "__CLI_OUTPUT__",
        "--now",
        now.toISOString(),
      ],
      {
        policyRevision,
        policyContent: JSON.stringify({
          schemaVersion: "merge-qualification-policy/v1",
          enabled: true,
          owner: "synthetic-owner",
          ceiling: { dollarCeilingUsd: 25, maxQualificationsPerDay: 20 },
          enabledAt: "2026-07-20T00:00:00Z",
          expiresAt: "2026-08-10T00:00:00Z",
        }),
        producerRuns: { total_count: 1, workflow_runs: [producer()] },
        advisoryRuns: { total_count: 0, workflow_runs: [] },
        jobs: { total_count: 1, jobs: [{ id: 77, name: "Docker Image Build", conclusion: "skipped", steps: [] }] },
        landing: [
          {
            base: { ref: "main" },
            merged_at: "2026-07-21T09:30:00Z",
            merge_commit_sha: policyRevision,
          },
        ],
        artifacts: {},
        downloads: {},
        owners: {},
      },
    );
    expect(result.status).toBe(0);
    expect(result.files.output).toContain('matrix={"include":[]}');
  });

  it("binds historical policy landing evidence to the requested repository", async () => {
    const endpoints = [];
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) => {
        endpoints.push(endpoint);
        if (endpoint.includes("platform-pr.yml")) return { total_count: 1, workflow_runs: [producer()] };
        if (endpoint.includes("platform-merge-qualification.yml")) return { total_count: 0, workflow_runs: [] };
        if (endpoint === `repos/chase-sets/chase-sets/commits/${policyRevision}/pulls`)
          return [{ base: { ref: "main" }, merged_at: "2026-07-21T09:30:00Z", merge_commit_sha: policyRevision }];
        throw new Error(`unexpected endpoint: ${endpoint}`);
      },
      execFile: (_command, args) => {
        if (args[0] === "log") {
          expect(args).toEqual([
            "log",
            "--format=%H%x09%cI",
            "origin/main",
            "--",
            "scripts/merge-qualification-policy.json",
          ]);
          return `${policyRevision}\t2026-07-21T09:00:00Z\n`;
        }
        if (args[0] === "cat-file" || args[0] === "ls-tree") return "scripts/merge-qualification-policy.json\n";
        if (args[0] === "show") return "policy";
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
      readPolicy: () =>
        JSON.stringify({
          schemaVersion: "merge-qualification-policy/v1",
          enabled: true,
          owner: "todd.skelton@chasesets.com",
          ceiling: { dollarCeilingUsd: 25, maxQualificationsPerDay: 20 },
          enabledAt: "2026-07-20T00:00:00Z",
          expiresAt: "2026-08-10T00:00:00Z",
        }),
      readProducerImageEligibility: async () => true,
    });
    expect(result.errors).toEqual([]);
    expect(result.attempts).toHaveLength(1);
    expect(endpoints).toContain(`repos/chase-sets/chase-sets/commits/${policyRevision}/pulls`);
  });

  it.each([
    {
      name: "cleanup marker",
      cleanupArtifacts: [artifact(2, "merge-qualification-cleanup-complete-5000-1", 9001)],
      cleanupFiles: {
        "cleanup-complete.json": JSON.stringify({ runId: "5000", runAttempt: "1", cleanup: "complete" }),
      },
      expectedState: "advisory_cleanup_complete",
    },
    {
      name: "missing cleanup marker",
      cleanupArtifacts: [],
      cleanupFiles: {},
      expectedState: "awaiting_advisory_cleanup",
    },
    {
      name: "cleanup marker with an extra file",
      cleanupArtifacts: [artifact(2, "merge-qualification-cleanup-complete-5000-1", 9001)],
      cleanupFiles: {
        "cleanup-complete.json": JSON.stringify({ runId: "5000", runAttempt: "1", cleanup: "complete" }),
        "extra.json": "{}",
      },
      expectedError: "terminal_payload_extra_files",
    },
  ])(
    "runs the producer terminal downloader for a $name",
    ({ cleanupArtifacts, cleanupFiles, expectedState, expectedError }) => {
      const loss = reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        advisoryRun: null,
        now,
      }).event;
      const terminalName = "merge-qualification-producer-terminal-4000-1";
      const cleanupName = "merge-qualification-cleanup-complete-5000-1";
      const result = runQualificationCli(
        [
          "producer-terminal-inventory",
          "--repository",
          "chase-sets/chase-sets",
          "--default-branch",
          "main",
          "--producer",
          "__CLI_PRODUCER__",
          "--advisory-run",
          "__CLI_ADVISORY__",
          "--out",
          "__CLI_OUTPUT__",
        ],
        {
          producer: producer(),
          advisory: {
            id: 5000,
            run_attempt: 1,
            repository: { full_name: "chase-sets/chase-sets" },
            path: ".github/workflows/platform-merge-qualification.yml",
            event: "workflow_dispatch",
          },
          artifacts: {
            [terminalName]: [artifact(1, terminalName, 9000)],
            [cleanupName]: cleanupArtifacts,
            "merge-qualification-terminal-5000-1": [],
          },
          downloads: {
            [terminalName]: { "event.json": JSON.stringify(loss) },
            [cleanupName]: cleanupFiles,
          },
          owners: { 9000: observerWriter(9000), 9001: observerWriter(9001) },
        },
      );
      if (expectedError) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedError);
        return;
      }
      expect(result.status).toBe(0);
      expect(JSON.parse(result.files.output)).toMatchObject({
        state: expectedState,
        advisoryCleanupComplete: expectedState === "advisory_cleanup_complete",
      });
    },
  );

  it.each([
    { name: "an extra file", terminalFiles: { "event.json": "{}", "extra.json": "{}" } },
    { name: "the wrong filename", terminalFiles: { "cleanup-complete.json": "{}" } },
  ])("rejects a terminal download containing $name", ({ terminalFiles }) => {
    const terminalName = "merge-qualification-producer-terminal-4000-1";
    const result = runQualificationCli(
      [
        "producer-terminal-inventory",
        "--repository",
        "chase-sets/chase-sets",
        "--default-branch",
        "main",
        "--producer",
        "__CLI_PRODUCER__",
        "--advisory-run",
        "__CLI_ADVISORY__",
        "--out",
        "__CLI_OUTPUT__",
      ],
      {
        producer: producer(),
        advisory: {
          id: 5000,
          run_attempt: 1,
          repository: { full_name: "chase-sets/chase-sets" },
          path: ".github/workflows/platform-merge-qualification.yml",
          event: "workflow_dispatch",
        },
        artifacts: {
          [terminalName]: [artifact(1, terminalName, 9000)],
          "merge-qualification-cleanup-complete-5000-1": [],
          "merge-qualification-terminal-5000-1": [],
        },
        downloads: { [terminalName]: terminalFiles },
        owners: { 9000: observerWriter(9000) },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("terminal_authority_unavailable");
  });

  it.each([{ reasonCode: "policy_expired" }, { reasonCode: "policy_schema_invalid" }, {}])(
    "keeps canonically disabled history inert (%o)",
    async (decision) => {
      const result = await inventoryMergeQualificationProducerAttempts({
        repository: "chase-sets/chase-sets",
        now: () => now,
        requestJson: async (endpoint) =>
          endpoint.includes("platform-pr.yml")
            ? { total_count: 1, workflow_runs: [producer()] }
            : { total_count: 0, workflow_runs: [] },
        readHistoricalPolicyContent: async () => ({
          revision: policyRevision,
          content: "malformed",
          decision: { enabled: false, ...decision },
        }),
        readProducerImageEligibility: async () => true,
      });
      expect(result).toEqual({ attempts: [], settled: 0, errors: [] });
    },
  );

  it("skips a producer whose Docker Image Build job was skipped", async () => {
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ enabled: true }),
        decision: { enabled: true, reasonCode: "policy_enabled" },
      }),
      readProducerImageEligibility: async () => false,
    });
    expect(result).toEqual({ attempts: [], settled: 0, errors: [] });
  });

  it.each([
    ["success", true],
    ["skipped", false],
    ["cancelled", false],
    ["failure", false],
  ])("requires one successful image push step (%s)", async (conclusion, expected) => {
    const result = await readMergeQualificationProducerImageEligibility({
      repository: "chase-sets/chase-sets",
      run: producer(),
      requestJson: async () => ({
        total_count: 1,
        jobs: [
          {
            id: 77,
            name: "Docker Image Build",
            conclusion: "success",
            steps: [{ name: "Push boot-smoked merge-group image", conclusion }],
          },
        ],
      }),
    });
    expect(result).toBe(expected);
  });

  it("treats a skipped Docker Image Build with no steps as ineligible", async () => {
    await expect(
      readMergeQualificationProducerImageEligibility({
        repository: "chase-sets/chase-sets",
        run: producer(),
        requestJson: async () => ({
          total_count: 1,
          jobs: [{ id: 77, name: "Docker Image Build", conclusion: "skipped", steps: [] }],
        }),
      }),
    ).resolves.toBe(false);
  });

  it("refuses missing or duplicate image push evidence", async () => {
    await expect(
      readMergeQualificationProducerImageEligibility({
        repository: "chase-sets/chase-sets",
        run: producer(),
        requestJson: async () => ({
          total_count: 1,
          jobs: [{ id: 77, name: "Docker Image Build", conclusion: "success", steps: [] }],
        }),
      }),
    ).rejects.toThrow("producer_image_eligibility_invalid");
    await expect(
      readMergeQualificationProducerImageEligibility({
        repository: "chase-sets/chase-sets",
        run: producer(),
        requestJson: async () => ({
          total_count: 1,
          jobs: [
            {
              id: 77,
              name: "Docker Image Build",
              steps: [
                { name: "Push boot-smoked merge-group image", conclusion: "success" },
                { name: "Push boot-smoked merge-group image", conclusion: "success" },
              ],
            },
          ],
        }),
      }),
    ).rejects.toThrow("producer_image_eligibility_invalid");
  });

  it("keeps malformed image evidence as one producer unknown", async () => {
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ enabled: true }),
        decision: { enabled: true, reasonCode: "policy_enabled" },
      }),
      readProducerImageEligibility: async () => {
        throw new Error("producer_image_eligibility_invalid");
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.attempts).toMatchObject([
      {
        historicalPolicyState: "unknown",
        historicalPolicyReason: "producer_image_eligibility_invalid",
        imageEligible: null,
      },
    ]);
  });

  it("refuses a producer head as historical policy authority even when it appears before run start", async () => {
    const producerHead = "d".repeat(40);
    await expect(
      readHistoricalProducerPolicy({
        run: producer({ head_sha: producerHead }),
        execFile: (command, args) => {
          if (args[0] === "log") return `${producerHead}\t2026-07-21T09:00:00Z\n`;
          return "";
        },
        readPolicy: () => JSON.stringify({ enabled: true }),
        readLandingEvidence: async () => [
          {
            base: { ref: "main" },
            merged_at: "2026-07-21T09:30:00Z",
            merge_commit_sha: producerHead,
          },
        ],
      }),
    ).rejects.toThrow("producer_policy_authority_unavailable");
  });

  it("uses real git history plus landing time, not committer time, for authority", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "qualification-policy-history-"));
    try {
      const git = (args, options = {}) => execFileSync("git", args, { ...options, cwd: repo, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "user.name", "Test"]);
      mkdirSync(path.join(repo, "scripts"));
      writeFileSync(path.join(repo, "scripts/merge-qualification-policy.json"), '{"enabled":false}\n');
      git(["add", "."]);
      git(["commit", "-qm", "disabled"], {
        env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-21T08:00:00Z", GIT_COMMITTER_DATE: "2026-07-21T08:00:00Z" },
      });
      const disabled = git(["rev-parse", "HEAD"]).trim();
      writeFileSync(path.join(repo, "scripts/merge-qualification-policy.json"), '{"enabled":true}\n');
      git(["add", "."]);
      git(["commit", "-qm", "enable"], {
        env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-21T09:30:00Z", GIT_COMMITTER_DATE: "2026-07-21T09:30:00Z" },
      });
      const enabled = git(["rev-parse", "HEAD"]).trim();
      git(["update-ref", "refs/remotes/origin/main", enabled]);
      const result = await readHistoricalProducerPolicy({
        repository: "chase-sets/chase-sets",
        run: producer({ run_started_at: "2026-07-21T10:00:00Z", head_sha: sha }),
        execFile: (command, args, options) => git(args, options),
        readLandingEvidence: async ({ revision }) => [
          {
            base: { ref: "main" },
            merged_at: revision === enabled ? "2026-07-21T10:30:00Z" : "2026-07-21T08:30:00Z",
            merge_commit_sha: revision,
          },
        ],
        readPolicy: async (revision) => (revision === disabled ? '{"enabled":false}' : '{"enabled":true}'),
      });
      expect(result).toMatchObject({ revision: disabled, decision: { enabled: false } });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous, missing, misbound, and wrong-base landing evidence", async () => {
    const newest = "1".repeat(40);
    const older = "2".repeat(40);
    const run = producer({ head_sha: "3".repeat(40) });
    const execFile = (_command, args) =>
      args[0] === "log" ? `${newest}\t2026-07-21T09:30:00Z\n${older}\t2026-07-21T08:30:00Z\n` : "";
    const base = { run, repository: "chase-sets/chase-sets", execFile, readPolicy: async () => '{"enabled":true}' };
    await expect(
      readHistoricalProducerPolicy({
        ...base,
        readLandingEvidence: async () => [
          { base: { ref: "main" }, merged_at: "2026-07-21T09:00:00Z", merge_commit_sha: newest },
          { base: { ref: "main" }, merged_at: "2026-07-21T09:01:00Z", merge_commit_sha: newest },
        ],
      }),
    ).rejects.toThrow("producer_policy_landing_evidence_ambiguous");
    await expect(
      readHistoricalProducerPolicy({
        ...base,
        readLandingEvidence: async ({ revision }) =>
          revision === newest
            ? []
            : [{ base: { ref: "main" }, merged_at: "2026-07-21T09:00:00Z", merge_commit_sha: revision }],
      }),
    ).rejects.toThrow("producer_policy_landing_evidence_unavailable");
    await expect(
      readHistoricalProducerPolicy({
        ...base,
        readLandingEvidence: async ({ revision }) => [
          { base: { ref: "main" }, merged_at: "2026-07-21T09:00:00Z", merge_commit_sha: `${revision.slice(0, -1)}0` },
        ],
      }),
    ).rejects.toThrow("producer_policy_landing_evidence_unavailable");
    await expect(
      readHistoricalProducerPolicy({
        ...base,
        readLandingEvidence: async () => [
          { base: { ref: "release" }, merged_at: "2026-07-21T09:00:00Z", merge_commit_sha: newest },
        ],
      }),
    ).rejects.toThrow("producer_policy_landing_evidence_unavailable");
    const calls = [];
    await expect(
      readHistoricalProducerPolicy({
        ...base,
        readLandingEvidence: async ({ revision }) => {
          calls.push(revision);
          return [{ base: { ref: "main" }, merged_at: "2026-07-21T09:00:00Z", merge_commit_sha: revision }];
        },
      }),
    ).resolves.toMatchObject({ revision: newest });
    expect(calls).toEqual([newest]);
  });

  it("uses the production landing endpoint once for shared policy authority", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "qualification-inventory-history-"));
    try {
      const git = (args, options = {}) => execFileSync("git", args, { ...options, cwd: repo, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "user.name", "Test"]);
      mkdirSync(path.join(repo, "scripts"));
      writeFileSync(path.join(repo, "scripts/merge-qualification-policy.json"), JSON.stringify({ enabled: true }));
      git(["add", "."]);
      git(["commit", "-qm", "enabled"], {
        env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-21T08:00:00Z", GIT_COMMITTER_DATE: "2026-07-21T08:00:00Z" },
      });
      const revision = git(["rev-parse", "HEAD"]).trim();
      git(["update-ref", "refs/remotes/origin/main", revision]);
      const producers = [producer({ id: 4100 }), producer({ id: 4101 })];
      const landingCalls = [];
      const result = await inventoryMergeQualificationProducerAttempts({
        repository: "chase-sets/chase-sets",
        now: () => now,
        execFile: (command, args, options) => git(args, options),
        readPolicy: async () =>
          JSON.stringify({
            schemaVersion: "merge-qualification-policy/v1",
            enabled: true,
            owner: "synthetic-owner",
            ceiling: { dollarCeilingUsd: 25, maxQualificationsPerDay: 20 },
            enabledAt: "2026-07-20T00:00:00Z",
            expiresAt: "2026-08-10T00:00:00Z",
          }),
        requestJson: async (endpoint) => {
          if (endpoint.includes("platform-pr.yml")) return { total_count: 2, workflow_runs: producers };
          if (endpoint.includes("platform-merge-qualification.yml")) return { total_count: 0, workflow_runs: [] };
          if (endpoint.includes("/commits/") && endpoint.endsWith("/pulls")) {
            landingCalls.push(endpoint);
            return [{ base: { ref: "main" }, merged_at: "2026-07-21T09:00:00Z", merge_commit_sha: revision }];
          }
          throw new Error(`unexpected endpoint ${endpoint}`);
        },
      });
      expect(result.errors).toEqual([]);
      expect(result.attempts).toHaveLength(2);
      expect(landingCalls).toHaveLength(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a duplicate advisory identity and a non-completed producer", async () => {
    const duplicate = { display_title: "Merge Qualification producer 4000-1", id: 9001, run_attempt: 1 };
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 2, workflow_runs: [duplicate, { ...duplicate, id: 9002 }] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: "{}",
        decision: { enabled: true },
      }),
    });
    expect(result).toEqual({ attempts: [], settled: 0, errors: ["advisory_identity_invalid"] });
    const pending = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer({ status: "in_progress" })] }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: "{}",
        decision: { enabled: true },
      }),
    });
    expect(pending).toEqual({ attempts: [], settled: 0, errors: [] });
    const foreign = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer({ path: ".github/workflows/other.yml" })] }
          : { total_count: 0, workflow_runs: [] },
    });
    expect(foreign.errors).toEqual(["producer_identity_invalid"]);
  });

  it("settles one producer-keyed terminal after one tick and is byte-idempotent", () => {
    const first = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    });
    expect(first.state).toBe("dispatch_loss");
    expect(first.event).toMatchObject({
      producerRunId: "4000",
      producerRunAttempt: "1",
      terminalState: "infrastructure_error",
      reasonCodes: ["advisory_dispatch_missing"],
      cleanupLegs: 0,
      idempotencyKey: "merge-qualification-producer:chase-sets/chase-sets:4000:1",
    });
    const replay = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      existingTerminal: first.event,
      now,
    });
    expect(replay).toMatchObject({ state: "idempotent", event: null });
  });

  it("refuses producer page drift, the search ceiling, and matrix overflow", async () => {
    const drift = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) => {
        const page = Number(new URL(endpoint, "https://api.invalid").searchParams.get("page"));
        return endpoint.includes("platform-pr.yml")
          ? page === 1
            ? {
                total_count: 101,
                workflow_runs: Array.from({ length: 100 }, (_, index) => producer({ id: 6000 + index })),
              }
            : { total_count: 102, workflow_runs: [producer({ id: 7000 }), producer({ id: 7001 })] }
          : { total_count: 0, workflow_runs: [] };
      },
    });
    expect(drift.errors).toEqual(["producer_inventory_incomplete"]);
    const ceiling = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? {
              total_count: 1000,
              workflow_runs: Array.from({ length: 100 }, (_, index) => producer({ id: 8000 + index })),
            }
          : { total_count: 0, workflow_runs: [] },
    });
    expect(ceiling.errors).toEqual(["producer_inventory_incomplete"]);
    const overflowRuns = Array.from({ length: 257 }, (_, index) => producer({ id: 9000 + index }));
    const overflow = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) => {
        if (!endpoint.includes("platform-pr.yml")) return { total_count: 0, workflow_runs: [] };
        const page = Number(new URL(endpoint, "https://api.invalid").searchParams.get("page"));
        return { total_count: 257, workflow_runs: overflowRuns.slice((page - 1) * 100, page * 100) };
      },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: "{}",
        decision: { enabled: true },
      }),
    });
    expect(overflow.errors).toEqual(["producer_worker_capacity_exceeded"]);
    expect(validateMergeQualificationProducerTerminal({ cleanupLegs: 1 })).not.toEqual([]);
  });

  it("names awaiting, ineligible, advisory-present, and late-race conflict states", () => {
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        now: new Date("2026-07-21T10:05:00Z"),
      }).state,
    ).toBe("awaiting_tick");
    expect(
      reconcileMergeQualificationProducerAttempt({ producer: producer(), candidate, policy: { enabled: false }, now })
        .state,
    ).toBe("ineligible");
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        advisoryRun: { id: 5000, run_attempt: 1 },
        now,
      }).state,
    ).toBe("advisory_present");
    const terminal = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        advisoryRun: { id: 5000, run_attempt: 1 },
        existingTerminal: terminal,
        advisoryCleanupComplete: true,
        now,
      }),
    ).toMatchObject({ state: "conflict", event: { terminalState: "conflict" } });
  });

  it("anchors reconciliation tick to producer completion", () => {
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer({ run_started_at: "2026-07-21T09:30:00Z" }),
        candidate,
        policy: { enabled: true },
        now: new Date("2026-07-21T10:10:00Z"),
      }),
    ).toMatchObject({ state: "awaiting_tick", reason: "awaiting_advisory_dispatch_tick" });
  });

  it("accepts the observer's explicit cleanup value flag in the real reconcile CLI", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qualification-cli-"));
    try {
      const producerPath = path.join(dir, "producer.json");
      const candidatePath = path.join(dir, "candidate.json");
      const policyPath = path.join(dir, "policy.json");
      const terminalPath = path.join(dir, "terminal.json");
      const outPath = path.join(dir, "out.json");
      writeFileSync(producerPath, JSON.stringify(producer()));
      writeFileSync(candidatePath, JSON.stringify(candidate));
      writeFileSync(
        policyPath,
        JSON.stringify({
          schemaVersion: "merge-qualification-policy/v1",
          enabled: true,
          owner: "todd.skelton@chasesets.com",
          ceiling: { dollarCeilingUsd: 25, maxQualificationsPerDay: 20 },
          enabledAt: "2026-07-20T00:00:00Z",
          expiresAt: "2026-08-10T00:00:00Z",
        }),
      );
      const loss = reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        now,
      }).event;
      writeFileSync(terminalPath, JSON.stringify(loss));
      const code = await main([
        "producer-reconcile",
        "--producer",
        producerPath,
        "--candidate",
        candidatePath,
        "--policy",
        policyPath,
        "--advisory-run",
        terminalPath,
        "--existing-terminal",
        terminalPath,
        "--advisory-cleanup-complete",
        "true",
        "--out",
        outPath,
        "--now",
        now.toISOString(),
      ]);
      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(outPath, "utf8"))).toMatchObject({ terminalState: "conflict" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the policy authority error as the CLI's authoritative unknown", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qualification-cli-"));
    try {
      const producerPath = path.join(dir, "producer.json");
      const candidatePath = path.join(dir, "candidate.json");
      const policyPath = path.join(dir, "policy.json");
      const outPath = path.join(dir, "out");
      writeFileSync(producerPath, JSON.stringify(producer()));
      writeFileSync(candidatePath, JSON.stringify(candidate));
      writeFileSync(
        policyPath,
        JSON.stringify({
          schemaVersion: "merge-qualification-policy/v1",
          enabled: true,
          owner: "todd.skelton@chasesets.com",
          ceiling: { dollarCeilingUsd: 25, maxQualificationsPerDay: 20 },
          enabledAt: "2026-07-20T00:00:00Z",
          expiresAt: "2026-08-10T00:00:00Z",
        }),
      );
      const result = reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        policyAuthorityError: "producer_policy_landing_evidence_unavailable",
        now,
      });
      expect(result).toMatchObject({ state: "unknown", reason: "producer_policy_landing_evidence_unavailable" });
      const code = await main([
        "producer-reconcile",
        "--producer",
        producerPath,
        "--candidate",
        candidatePath,
        "--policy",
        policyPath,
        "--policy-authority-error",
        "producer_policy_landing_evidence_unavailable",
        "--github-output",
        outPath,
        "--now",
        now.toISOString(),
      ]);
      expect(code).toBe(1);
      expect(readFileSync(outPath, "utf8")).toContain("state=unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for cleanup before conflict and settles a two-record replay", () => {
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        advisoryRun: { id: 5000 },
        existingTerminal: loss,
        now,
      }),
    ).toMatchObject({ state: "awaiting_advisory_cleanup", event: null });
    const conflict = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      advisoryRun: { id: 5000, run_attempt: 1 },
      existingTerminal: loss,
      advisoryCleanupComplete: true,
      now,
    }).event;
    expect(conflict).toMatchObject({ terminalState: "conflict" });
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        advisoryRun: { id: 5000, run_attempt: 1 },
        existingTerminals: [loss, conflict],
        advisoryCleanupComplete: true,
        now,
      }),
    ).toMatchObject({ state: "conflict_settled", event: null });
  });

  it("classifies byte-identical producer terminal replay and refuses foreign writers", async () => {
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const bytes = JSON.stringify(loss);
    const requestJson = async (endpoint) => {
      if (endpoint.includes("/artifacts?"))
        return {
          total_count: 1,
          artifacts: [
            { id: 1, name: "merge-qualification-producer-terminal-4000-1", expired: false, workflow_run: { id: 9000 } },
          ],
        };
      return writer;
    };
    const result = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson,
      downloadArtifact: async () => bytes,
    });
    expect(result).toMatchObject({ state: "dispatch_loss", records: [bytes], errors: [] });
    const refused = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?")
          ? requestJson(endpoint)
          : { ...writer, head_repository: { full_name: "evil/repo" } },
      downloadArtifact: async () => bytes,
    });
    expect(refused.errors).toEqual(["terminal_writer_invalid"]);
    const wrongPath = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?") ? requestJson(endpoint) : { ...writer, path: ".github/workflows/other.yml" },
      downloadArtifact: async () => bytes,
    });
    expect(wrongPath.errors).toEqual(["terminal_writer_invalid"]);
  });

  it("refuses terminal page drift and foreign producer bindings", async () => {
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    const artifact = (id) => ({
      id,
      name: "merge-qualification-producer-terminal-4000-1",
      expired: false,
      workflow_run: { id: 9000 },
    });
    const base = {
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      downloadArtifact: async () => JSON.stringify(loss),
    };
    const drift = await readMergeQualificationProducerTerminalRecords({
      ...base,
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?")
          ? Number(new URL(endpoint, "https://api.invalid").searchParams.get("page")) === 1
            ? { total_count: 2, artifacts: [artifact(1)] }
            : { total_count: 1, artifacts: [artifact(2)] }
          : writer,
    });
    expect(drift.errors).toEqual(["terminal_inventory_incomplete"]);
    const foreign = await readMergeQualificationProducerTerminalRecords({
      ...base,
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?") ? { total_count: 1, artifacts: [artifact(1)] } : writer,
      downloadArtifact: async () =>
        JSON.stringify({
          ...loss,
          producerRunId: "4001",
          idempotencyKey: "merge-qualification-producer:chase-sets/chase-sets:4001:1",
        }),
    });
    expect(foreign.errors).toEqual(["terminal_payload_binding_invalid"]);
  });

  it("refuses producer terminal total drift after a complete first page", async () => {
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    const artifact = (id) => ({
      id,
      name: "merge-qualification-producer-terminal-4000-1",
      expired: false,
      workflow_run: { id: 9000 },
    });
    const result = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson: async (endpoint) => {
        if (!endpoint.includes("/artifacts?")) return writer;
        const page = Number(new URL(endpoint, "https://api.invalid").searchParams.get("page"));
        return page === 1
          ? { total_count: 101, artifacts: Array.from({ length: 100 }, (_, index) => artifact(index + 1)) }
          : { total_count: 102, artifacts: [artifact(101), artifact(102)] };
      },
      downloadArtifact: async () => JSON.stringify(loss),
    });
    expect(result.errors).toEqual(["terminal_inventory_incomplete"]);
  });

  it("deduplicates byte-identical terminal replay and enforces closed fields", async () => {
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const bytes = JSON.stringify(loss);
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    const requestJson = async (endpoint) =>
      endpoint.includes("/artifacts?")
        ? {
            total_count: 2,
            artifacts: [
              {
                id: 1,
                name: "merge-qualification-producer-terminal-4000-1",
                expired: false,
                workflow_run: { id: 9000 },
              },
              {
                id: 2,
                name: "merge-qualification-producer-terminal-4000-1",
                expired: false,
                workflow_run: { id: 9000 },
              },
            ],
          }
        : writer;
    const replay = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson,
      downloadArtifact: async () => bytes,
    });
    expect(replay).toMatchObject({ state: "dispatch_loss", errors: [] });
    const invalid = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?")
          ? {
              total_count: 1,
              artifacts: [
                {
                  id: 1,
                  name: "merge-qualification-producer-terminal-4000-1",
                  expired: false,
                  workflow_run: { id: 9000 },
                },
              ],
            }
          : writer,
      downloadArtifact: async () => JSON.stringify({ ...loss, cleanupLegs: 1 }),
    });
    expect(invalid.errors).toEqual(["terminal_payload_binding_invalid"]);
    const badKey = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?")
          ? {
              total_count: 1,
              artifacts: [
                {
                  id: 1,
                  name: "merge-qualification-producer-terminal-4000-1",
                  expired: false,
                  workflow_run: { id: 9000 },
                },
              ],
            }
          : writer,
      downloadArtifact: async () => JSON.stringify({ ...loss, idempotencyKey: "wrong" }),
    });
    expect(badKey.errors).toEqual(["terminal_payload_binding_invalid"]);
  });

  it("classifies late advisory cleanup ordering from the authenticated marker reader", async () => {
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const bytes = JSON.stringify(loss);
    const requestJson = async (endpoint) =>
      endpoint.includes("/artifacts?")
        ? {
            total_count: 1,
            artifacts: [
              {
                id: 1,
                name: "merge-qualification-producer-terminal-4000-1",
                expired: false,
                workflow_run: { id: 9000 },
              },
            ],
          }
        : {
            id: 9000,
            repository: { full_name: "chase-sets/chase-sets" },
            head_repository: { full_name: "chase-sets/chase-sets" },
            head_branch: "main",
            path: ".github/workflows/platform-merge-qualification-observer.yml",
            event: "schedule",
          };
    const base = {
      repository: "chase-sets/chase-sets",
      producer: producer(),
      advisoryRun: {
        id: 5000,
        run_attempt: 1,
        repository: { full_name: "chase-sets/chase-sets" },
        path: ".github/workflows/platform-merge-qualification.yml",
        event: "workflow_dispatch",
      },
      defaultBranch: "main",
      requestJson,
      downloadArtifact: async () => bytes,
    };
    const awaiting = await readMergeQualificationProducerTerminalRecords({
      ...base,
      readAdvisoryCleanupMarkers: async () => ({ complete: false, errors: [] }),
    });
    expect(awaiting).toMatchObject({ state: "awaiting_advisory_cleanup", errors: [] });
    const complete = await readMergeQualificationProducerTerminalRecords({
      ...base,
      readAdvisoryCleanupMarkers: async () => ({ complete: true, errors: [] }),
    });
    expect(complete).toMatchObject({ state: "advisory_cleanup_complete", advisoryCleanupComplete: true, errors: [] });
  });

  it("reads the cleanup-complete filename and rejects a foreign marker writer", async () => {
    const advisoryRun = {
      id: 5000,
      run_attempt: 1,
      repository: { full_name: "chase-sets/chase-sets" },
      path: ".github/workflows/platform-merge-qualification.yml",
      event: "workflow_dispatch",
    };
    const markerName = "merge-qualification-cleanup-complete-5000-1";
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    const result = await readMergeQualificationAdvisoryCleanupMarkers({
      repository: "chase-sets/chase-sets",
      advisoryRun,
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("name=merge-qualification-cleanup-complete-")
          ? { total_count: 1, artifacts: [{ id: 2, name: markerName, expired: false, workflow_run: { id: 9000 } }] }
          : writer,
      downloadArtifact: async ({ fileName }) => {
        expect(fileName).toBe("cleanup-complete.json");
        return JSON.stringify({ runId: "5000", runAttempt: "1", cleanup: "complete" });
      },
    });
    expect(result).toEqual({ complete: true, errors: [] });
    const foreign = await readMergeQualificationAdvisoryCleanupMarkers({
      repository: "chase-sets/chase-sets",
      advisoryRun,
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("name=merge-qualification-cleanup-complete-")
          ? { total_count: 1, artifacts: [{ id: 2, name: markerName, expired: false, workflow_run: { id: 9000 } }] }
          : { ...writer, path: ".github/workflows/other.yml" },
      downloadArtifact: async () => JSON.stringify({ runId: "5000", runAttempt: "1", cleanup: "complete" }),
    });
    expect(foreign.errors).toEqual(["producer_marker_writer_invalid"]);
  });

  it("rejects a pending cleanup marker and accepts the 8026 terminal fallback", async () => {
    const advisoryRun = {
      id: 5000,
      run_attempt: 1,
      repository: { full_name: "chase-sets/chase-sets" },
      path: ".github/workflows/platform-merge-qualification.yml",
      event: "workflow_dispatch",
    };
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    const terminal = buildMergeQualificationEvent({
      repository: "chase-sets/chase-sets",
      workflowId: "22",
      workflowPath: ".github/workflows/platform-merge-qualification.yml",
      parentWorkflowId: "11",
      parentWorkflowPath: ".github/workflows/platform-pr.yml",
      parentRunId: "4000",
      parentRunAttempt: "1",
      runId: "5000",
      runAttempt: "1",
      terminalState: "cancelled_evicted",
      reasonCodes: ["candidate_evicted"],
      provisioned: false,
      startedAt: "2026-07-21T10:00:00Z",
      completedAt: "2026-07-21T10:01:00Z",
      evidenceLinks: ["https://github.com/chase-sets/chase-sets/actions/runs/5000/attempts/1"],
    }).event;
    const result = await readMergeQualificationAdvisoryCleanupMarkers({
      repository: "chase-sets/chase-sets",
      advisoryRun,
      defaultBranch: "main",
      requestJson: async (endpoint) => {
        if (endpoint.includes("cleanup-complete")) return { total_count: 0, artifacts: [] };
        if (endpoint.includes("terminal-5000-1"))
          return {
            total_count: 1,
            artifacts: [
              { id: 2, name: "merge-qualification-terminal-5000-1", expired: false, workflow_run: { id: 9000 } },
            ],
          };
        return writer;
      },
      downloadArtifact: async ({ fileName }) => {
        expect(fileName).toBe("event.json");
        return JSON.stringify(terminal);
      },
    });
    expect(result).toEqual({ complete: true, errors: [] });
    const pending = await readMergeQualificationAdvisoryCleanupMarkers({
      repository: "chase-sets/chase-sets",
      advisoryRun,
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("cleanup-complete")
          ? {
              total_count: 1,
              artifacts: [
                {
                  id: 3,
                  name: "merge-qualification-cleanup-complete-5000-1",
                  expired: false,
                  workflow_run: { id: 9000 },
                },
              ],
            }
          : writer,
      downloadArtifact: async ({ fileName }) => {
        expect(fileName).toBe("cleanup-complete.json");
        return JSON.stringify({ runId: "5000", runAttempt: "1", cleanup: "pending" });
      },
    });
    expect(pending.errors).toEqual(["producer_marker_payload_invalid"]);
  });

  it("settles loss and conflict records at the terminal reader", async () => {
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const conflict = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      advisoryRun: { id: 5000, run_attempt: 1 },
      existingTerminal: loss,
      advisoryCleanupComplete: true,
      now,
    }).event;
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    let downloadCount = 0;
    const result = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?")
          ? {
              total_count: 2,
              artifacts: [
                {
                  id: 1,
                  name: "merge-qualification-producer-terminal-4000-1",
                  expired: false,
                  workflow_run: { id: 9000 },
                },
                {
                  id: 2,
                  name: "merge-qualification-producer-terminal-4000-1",
                  expired: false,
                  workflow_run: { id: 9000 },
                },
              ],
            }
          : writer,
      downloadArtifact: async () => JSON.stringify(downloadCount++ === 0 ? loss : conflict),
    });
    expect(result).toMatchObject({ state: "conflict_settled", advisoryCleanupComplete: true, errors: [] });
  });

  it("refuses two distinct loss terminals", async () => {
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const second = { ...loss, completedAt: "2026-07-21T12:01:00.000Z" };
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    let index = 0;
    const result = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?")
          ? {
              total_count: 2,
              artifacts: [
                {
                  id: 1,
                  name: "merge-qualification-producer-terminal-4000-1",
                  expired: false,
                  workflow_run: { id: 9000 },
                },
                {
                  id: 2,
                  name: "merge-qualification-producer-terminal-4000-1",
                  expired: false,
                  workflow_run: { id: 9000 },
                },
              ],
            }
          : writer,
      downloadArtifact: async () => JSON.stringify(index++ === 0 ? loss : second),
    });
    expect(result.errors).toEqual(["terminal_payload_conflict"]);
  });

  it("rejects a terminal from another producer identity", () => {
    const terminal = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer({ id: 4001 }),
        candidate: { ...candidate, runId: "4001" },
        policy: { enabled: true },
        existingTerminal: terminal,
        now,
      }),
    ).toMatchObject({ state: "unknown", reason: "terminal_identity_invalid", event: null });
  });

  it("rejects absent or substituted policy revision and malformed producer pages", () => {
    expect(validateMergeQualificationCandidate({ ...candidate, policyRevision: undefined })).not.toEqual([]);
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate: { ...candidate, policyRevision: sha },
        policy: { enabled: true },
        now,
      }),
    ).toMatchObject({ state: "unknown", reason: "candidate_invalid" });
  });
});
