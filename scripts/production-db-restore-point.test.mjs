import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS,
  buildRestorePointName,
  createProductionDbRestorePoint,
  parseDoctlDatabaseSummaryOutput,
  parseDoctlForkOutput,
  parseProductionDbRestorePointArgs,
} from "./production-db-restore-point.mjs";

const baseOptions = {
  sourceClusterId: "db-prod-1",
  releaseCommit: "a".repeat(40),
  workflowRunId: "12345",
  workflowRunAttempt: "2",
  releaseMode: "normal",
  bypass: false,
  doctlPath: "doctl",
  checkedAt: "2026-06-28T09:30:00.000Z",
};

describe("production database restore point", () => {
  it("creates a DigitalOcean database fork restore point", async () => {
    const calls = [];
    const result = await createProductionDbRestorePoint(baseOptions, {
      now: () => Date.parse("2026-06-28T09:30:00.000Z"),
      execFile: async (command, args) => {
        calls.push({ command, args });
        if (args[1] === "fork") {
          return { stdout: "" };
        }
        if (args[1] === "list") {
          return {
            stdout: "db-fork-1\tcs-prod-rp-aaaaaaaa-12345-2\tcreating\t2026-06-28T09:30:01Z\n",
          };
        }
        if (args[1] === "get") {
          return {
            stdout: "db-fork-1\tcs-prod-rp-aaaaaaaa-12345-2\tonline\t2026-06-28T09:31:00Z\n",
          };
        }
        throw new Error(`Unexpected doctl call: ${args.join(" ")}`);
      },
    });

    expect(result.passesRestorePointGate).toBe(true);
    expect(calls).toEqual([
      {
        command: "doctl",
        args: ["databases", "fork", "cs-prod-rp-aaaaaaaa-12345-2", "--restore-from-cluster-id", "db-prod-1"],
      },
      {
        command: "doctl",
        args: ["databases", "list", "--format", "ID,Name,Status,Created", "--no-header"],
      },
      {
        command: "doctl",
        args: ["databases", "get", "db-fork-1", "--format", "ID,Name,Status,Created", "--no-header"],
      },
    ]);
    expect(result.record).toMatchObject({
      schemaVersion: "production-db-restore-point/v1",
      sourceClusterId: "db-prod-1",
      restorePoint: {
        type: "digitalocean-database-fork",
        clusterId: "db-fork-1",
        name: "cs-prod-rp-aaaaaaaa-12345-2",
        status: "online",
        createdAt: "2026-06-28T09:31:00Z",
      },
      result: "success",
    });
  });

  it("fails closed when required deployment context is missing", async () => {
    const result = await createProductionDbRestorePoint(
      { ...baseOptions, sourceClusterId: "", releaseCommit: "main" },
      async () => {
        throw new Error("doctl should not be called");
      },
    );

    expect(result.passesRestorePointGate).toBe(false);
    expect(result.record.result).toBe("failure");
    expect(result.record.errors).toEqual([
      "RELEASE_COMMIT must be a 40-character Git commit SHA.",
      "PRODUCTION_DATABASE_CLUSTER_ID is required.",
    ]);
  });

  it("records doctl fork failure diagnostics while keeping the gate closed", async () => {
    const failure = new Error("Command failed: doctl databases fork");
    failure.code = 2;
    failure.stderr = "Error: database fork quota exceeded\n";
    failure.stdout = '{"id":""}';

    const result = await createProductionDbRestorePoint(baseOptions, async () => {
      throw failure;
    });

    expect(result.passesRestorePointGate).toBe(false);
    expect(result.record.restorePoint).toMatchObject({
      name: "cs-prod-rp-aaaaaaaa-12345-2",
      status: "create-failed",
    });
    expect(result.record.errors).toEqual([
      "doctl database fork failed before a restore-point cluster id was returned.",
      "exit code: 2",
      "stderr: Error: database fork quota exceeded",
      'stdout: {"id":""}',
    ]);
  });

  it("fails with a typed timeout record when the fork stays unavailable", async () => {
    const calls = [];
    const sleeps = [];
    let nowMs = 0;

    const result = await createProductionDbRestorePoint(
      {
        ...baseOptions,
        forkTimeoutMs: 65_000,
        forkPollIntervalMs: 30_000,
      },
      {
        now: () => nowMs,
        sleep: async (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
        execFile: async (command, args) => {
          calls.push({ command, args });
          if (args[1] === "fork") {
            return { stdout: "" };
          }
          if (args[1] === "list") {
            return {
              stdout: "db-fork-1\tcs-prod-rp-aaaaaaaa-12345-2\tcreating\t2026-06-28T09:30:01Z\n",
            };
          }
          if (args[1] === "get") {
            return {
              stdout: "db-fork-1\tcs-prod-rp-aaaaaaaa-12345-2\tforking\t2026-06-28T09:30:01Z\n",
            };
          }
          if (args[1] === "delete") {
            return { stdout: "" };
          }
          throw new Error(`Unexpected doctl call: ${args.join(" ")}`);
        },
      },
    );

    expect(result.passesRestorePointGate).toBe(false);
    expect(calls.map((call) => call.args)).toEqual([
      ["databases", "fork", "cs-prod-rp-aaaaaaaa-12345-2", "--restore-from-cluster-id", "db-prod-1"],
      ["databases", "list", "--format", "ID,Name,Status,Created", "--no-header"],
      ["databases", "get", "db-fork-1", "--format", "ID,Name,Status,Created", "--no-header"],
      ["databases", "get", "db-fork-1", "--format", "ID,Name,Status,Created", "--no-header"],
      ["databases", "get", "db-fork-1", "--format", "ID,Name,Status,Created", "--no-header"],
      ["databases", "delete", "db-fork-1", "--force"],
    ]);
    expect(sleeps).toEqual([30_000, 30_000, 5_000]);
    expect(result.record).toMatchObject({
      result: "failure",
      restorePoint: {
        clusterId: "db-fork-1",
        name: "cs-prod-rp-aaaaaaaa-12345-2",
        status: "forking",
      },
      failure: {
        type: "restore-point-fork-timeout",
        restorePointName: "cs-prod-rp-aaaaaaaa-12345-2",
        clusterId: "db-fork-1",
        status: "forking",
        timeoutMs: 65_000,
        pollIntervalMs: 30_000,
        elapsedMs: 65_000,
      },
      restorePointCleanup: {
        attempted: true,
        clusterId: "db-fork-1",
        name: "cs-prod-rp-aaaaaaaa-12345-2",
        status: "deleted",
      },
    });
    expect(result.record.errors).toEqual([
      "Timed out waiting for restore-point fork 'cs-prod-rp-aaaaaaaa-12345-2' to become online.",
      "last observed cluster id: db-fork-1",
      "last observed status: forking",
    ]);
  });

  it("extracts the fork id from doctl timeout output and records safe status", async () => {
    const liveForkId = "7ac42cb3-2815-4203-bed0-09ae7a1732df";
    const calls = [];
    const failure = new Error("Command failed: doctl databases fork");
    failure.code = 1;
    failure.stdout = `database couldn't enter the online state: timeout waiting for database (${liveForkId}) to enter online state\n`;

    const result = await createProductionDbRestorePoint(
      {
        ...baseOptions,
        releaseCommit: "c051382bc4e02e8981b540fb97f8e9738c58dba2",
        workflowRunId: "28617834359",
        workflowRunAttempt: "1",
        forkTimeoutMs: 20 * 60 * 1000,
        forkPollIntervalMs: 30 * 1000,
      },
      {
        execFile: async (command, args) => {
          calls.push({ command, args });
          if (args[1] === "fork") {
            throw failure;
          }
          if (args[1] === "get") {
            return {
              stdout: `${liveForkId}\tcs-prod-rp-c051382b-28617834359-1\tforking\t2026-07-02 20:08:49 +0000 UTC\n`,
            };
          }
          if (args[1] === "delete") {
            return { stdout: "" };
          }
          throw new Error(`Unexpected doctl call: ${args.join(" ")}`);
        },
      },
    );

    expect(result.passesRestorePointGate).toBe(false);
    expect(calls.map((call) => call.args)).toEqual([
      ["databases", "fork", "cs-prod-rp-c051382b-28617834359-1", "--restore-from-cluster-id", "db-prod-1"],
      ["databases", "get", liveForkId, "--format", "ID,Name,Status,Created", "--no-header"],
      ["databases", "delete", liveForkId, "--force"],
    ]);
    expect(result.record).toMatchObject({
      result: "failure",
      restorePoint: {
        clusterId: liveForkId,
        name: "cs-prod-rp-c051382b-28617834359-1",
        status: "forking",
        createdAt: "2026-07-02 20:08:49 +0000 UTC",
      },
      failure: {
        type: "restore-point-fork-timeout",
        restorePointName: "cs-prod-rp-c051382b-28617834359-1",
        clusterId: liveForkId,
        status: "forking",
        timeoutMs: 20 * 60 * 1000,
        pollIntervalMs: 30 * 1000,
        elapsedMs: null,
      },
      restorePointCleanup: {
        attempted: true,
        clusterId: liveForkId,
        name: "cs-prod-rp-c051382b-28617834359-1",
        status: "deleted",
      },
    });
    expect(result.record.errors).toEqual([
      "doctl database fork failed before a restore-point cluster id was returned.",
      "exit code: 1",
      `stdout: database couldn't enter the online state: timeout waiting for database (${liveForkId}) to enter online state`,
      `last observed cluster id: ${liveForkId}`,
      "last observed status: forking",
    ]);
  });

  it("records cleanup failure diagnostics when a failed restore-point fork cannot be deleted", async () => {
    const deleteFailure = new Error("Command failed: doctl databases delete");
    deleteFailure.code = 1;
    deleteFailure.stderr = "Error: access_token=super-secret-token expired\n";
    let nowMs = 0;

    const result = await createProductionDbRestorePoint(
      {
        ...baseOptions,
        forkTimeoutMs: 1_000,
        forkPollIntervalMs: 1_000,
      },
      {
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
        execFile: async (_command, args) => {
          if (args[1] === "fork") {
            return { stdout: "" };
          }
          if (args[1] === "list") {
            return {
              stdout: "db-fork-1\tcs-prod-rp-aaaaaaaa-12345-2\tcreating\t2026-06-28T09:30:01Z\n",
            };
          }
          if (args[1] === "get") {
            return {
              stdout: "db-fork-1\tcs-prod-rp-aaaaaaaa-12345-2\tforking\t2026-06-28T09:30:01Z\n",
            };
          }
          if (args[1] === "delete") {
            throw deleteFailure;
          }
          throw new Error(`Unexpected doctl call: ${args.join(" ")}`);
        },
      },
    );

    expect(result.passesRestorePointGate).toBe(false);
    expect(result.record.restorePointCleanup).toMatchObject({
      attempted: true,
      clusterId: "db-fork-1",
      name: "cs-prod-rp-aaaaaaaa-12345-2",
      status: "delete-failed",
    });
    expect(result.record.errors).toEqual([
      "Timed out waiting for restore-point fork 'cs-prod-rp-aaaaaaaa-12345-2' to become online.",
      "last observed cluster id: db-fork-1",
      "last observed status: forking",
      "doctl database delete failed for the failed restore-point fork.",
      "exit code: 1",
      "stderr: Error: access_token=[redacted] expired",
    ]);
    expect(JSON.stringify(result.record)).not.toContain("super-secret-token");
  });

  it("records redacted diagnostics when status polling fails", async () => {
    const failure = new Error("Command failed: doctl databases get");
    failure.code = 1;
    failure.stderr = "Error: access_token=super-secret-token expired\n";

    const result = await createProductionDbRestorePoint(
      {
        ...baseOptions,
        forkTimeoutMs: 65_000,
        forkPollIntervalMs: 30_000,
      },
      {
        now: () => 0,
        execFile: async (_command, args) => {
          if (args[1] === "fork") {
            return { stdout: "" };
          }
          if (args[1] === "list") {
            return {
              stdout: "db-fork-1\tcs-prod-rp-aaaaaaaa-12345-2\tcreating\t2026-06-28T09:30:01Z\n",
            };
          }
          if (args[1] === "delete") {
            return { stdout: "" };
          }
          throw failure;
        },
      },
    );

    expect(result.passesRestorePointGate).toBe(false);
    expect(result.record.restorePoint).toMatchObject({
      clusterId: "db-fork-1",
      name: "cs-prod-rp-aaaaaaaa-12345-2",
      status: "status-check-failed",
    });
    expect(result.record.restorePointCleanup).toMatchObject({
      attempted: true,
      clusterId: "db-fork-1",
      name: "cs-prod-rp-aaaaaaaa-12345-2",
      status: "deleted",
    });
    expect(result.record.errors).toEqual([
      "doctl database fork status check failed before the restore-point cluster became available.",
      "exit code: 1",
      "stderr: Error: access_token=[redacted] expired",
    ]);
    expect(JSON.stringify(result.record)).not.toContain("super-secret-token");
  });

  it("allows restore-point bypass only for audited emergency releases", async () => {
    const result = await createProductionDbRestorePoint(
      {
        ...baseOptions,
        sourceClusterId: "",
        bypass: true,
        releaseMode: "emergency",
        emergencyReference: "INC-2026-06-28-001",
      },
      async () => {
        throw new Error("doctl should not be called for bypass");
      },
    );

    expect(result.passesRestorePointGate).toBe(true);
    expect(result.record).toMatchObject({
      result: "bypassed",
      sourceClusterId: "",
      bypass: {
        requested: true,
        allowed: true,
        emergencyReference: "INC-2026-06-28-001",
      },
    });
  });

  it("records routine PITR restore-point skips without calling doctl", async () => {
    const result = await createProductionDbRestorePoint(
      {
        ...baseOptions,
        sourceClusterId: "",
        skip: true,
        skipReason: "recovery mode pitr: routine deploy",
      },
      async () => {
        throw new Error("doctl should not be called for PITR skips");
      },
    );

    expect(result.passesRestorePointGate).toBe(true);
    expect(result.record).toMatchObject({
      result: "skipped",
      sourceClusterId: "",
      restorePoint: {
        type: "digitalocean-managed-pitr",
        clusterId: null,
        status: "not-created",
      },
      skip: {
        requested: true,
        reason: "recovery mode pitr: routine deploy",
      },
      bypass: {
        requested: false,
        allowed: false,
      },
    });
  });

  it("rejects restore-point bypass outside emergency mode", async () => {
    const result = await createProductionDbRestorePoint(
      {
        ...baseOptions,
        bypass: true,
        releaseMode: "normal",
        emergencyReference: "INC-2026-06-28-001",
      },
      async () => {
        throw new Error("doctl should not be called");
      },
    );

    expect(result.passesRestorePointGate).toBe(false);
    expect(result.record.errors).toContain("PRODUCTION_DB_RESTORE_POINT_BYPASS requires RELEASE_MODE=emergency.");
  });

  it("rejects ambiguous bypass and skip requests", async () => {
    const result = await createProductionDbRestorePoint(
      {
        ...baseOptions,
        bypass: true,
        skip: true,
        skipReason: "routine deploy",
        releaseMode: "emergency",
        emergencyReference: "INC-2026-06-28-001",
      },
      async () => {
        throw new Error("doctl should not be called");
      },
    );

    expect(result.passesRestorePointGate).toBe(false);
    expect(result.record.errors).toContain(
      "PRODUCTION_DB_RESTORE_POINT_BYPASS and PRODUCTION_DB_RESTORE_POINT_SKIP cannot both be true.",
    );
  });

  it("parses supported doctl JSON output shapes", () => {
    expect(parseDoctlForkOutput('[{"id":"db_1"}]')).toEqual({ id: "db_1" });
    expect(parseDoctlForkOutput('{"database":{"id":"db_2"}}')).toEqual({ id: "db_2" });
    expect(parseDoctlForkOutput('{"databases":[{"id":"db_3"}]}')).toEqual({ id: "db_3" });
  });

  it("parses allowlisted doctl database summary output", () => {
    expect(
      parseDoctlDatabaseSummaryOutput(
        "7ac42cb3-2815-4203-bed0-09ae7a1732df\tcs-prod-rp-c051382b-28617834359-1\tforking\t2026-07-02 20:08:49 +0000 UTC\n",
      ),
    ).toEqual({
      id: "7ac42cb3-2815-4203-bed0-09ae7a1732df",
      name: "cs-prod-rp-c051382b-28617834359-1",
      status: "forking",
      created_at: "2026-07-02 20:08:49 +0000 UTC",
    });
  });

  it("parses CLI and environment options", () => {
    const options = parseProductionDbRestorePointArgs(
      ["--source-cluster-id", "db_cli", "--fork-timeout-seconds", "90", "--fork-poll-seconds", "5"],
      {
        PRODUCTION_DB_RESTORE_POINT_OUT: "artifacts/release-health/restore.json",
        GITHUB_OUTPUT: "github-output.txt",
        RELEASE_COMMIT: "b".repeat(40),
        GITHUB_RUN_ID: "456",
        GITHUB_RUN_ATTEMPT: "1",
        PRODUCTION_DB_RESTORE_POINT_SKIP: "true",
        PRODUCTION_DB_RESTORE_POINT_SKIP_REASON: "pitr",
        PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_SECONDS: "1200",
        PRODUCTION_DB_RESTORE_POINT_FORK_POLL_SECONDS: "30",
      },
    );

    expect(options).toMatchObject({
      outPath: "artifacts/release-health/restore.json",
      githubOutputPath: "github-output.txt",
      sourceClusterId: "db_cli",
      releaseCommit: "b".repeat(40),
      workflowRunId: "456",
      workflowRunAttempt: "1",
      skip: true,
      skipReason: "pitr",
      forkTimeoutMs: 90_000,
      forkPollIntervalMs: 5_000,
    });
  });

  it("defaults to a 75-minute fork availability budget", () => {
    expect(parseProductionDbRestorePointArgs([], {}).forkTimeoutMs).toBe(75 * 60 * 1000);
    expect(DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS).toBe(75 * 60 * 1000);
  });

  it("keeps fork names bounded and traceable", () => {
    expect(buildRestorePointName(baseOptions)).toBe("cs-prod-rp-aaaaaaaa-12345-2");
  });
});
