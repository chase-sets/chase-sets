import { describe, expect, it } from "vitest";
import {
  buildRestorePointName,
  createProductionDbRestorePoint,
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
    const result = await createProductionDbRestorePoint(baseOptions, async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: JSON.stringify([
          {
            id: "db-fork-1",
            name: "cs-prod-rp-aaaaaaaa-12345-2",
            status: "online",
            created_at: "2026-06-28T09:31:00Z",
          },
        ]),
      };
    });

    expect(result.passesRestorePointGate).toBe(true);
    expect(calls).toEqual([
      {
        command: "doctl",
        args: [
          "databases",
          "fork",
          "cs-prod-rp-aaaaaaaa-12345-2",
          "--restore-from-cluster-id",
          "db-prod-1",
          "--wait",
          "--output",
          "json",
        ],
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

  it("parses supported doctl JSON output shapes", () => {
    expect(parseDoctlForkOutput('[{"id":"db_1"}]')).toEqual({ id: "db_1" });
    expect(parseDoctlForkOutput('{"database":{"id":"db_2"}}')).toEqual({ id: "db_2" });
    expect(parseDoctlForkOutput('{"databases":[{"id":"db_3"}]}')).toEqual({ id: "db_3" });
  });

  it("parses CLI and environment options", () => {
    const options = parseProductionDbRestorePointArgs(["--source-cluster-id", "db_cli"], {
      PRODUCTION_DB_RESTORE_POINT_OUT: "artifacts/release-health/restore.json",
      GITHUB_OUTPUT: "github-output.txt",
      RELEASE_COMMIT: "b".repeat(40),
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
    });

    expect(options).toMatchObject({
      outPath: "artifacts/release-health/restore.json",
      githubOutputPath: "github-output.txt",
      sourceClusterId: "db_cli",
      releaseCommit: "b".repeat(40),
      workflowRunId: "456",
      workflowRunAttempt: "1",
    });
  });

  it("keeps fork names bounded and traceable", () => {
    expect(buildRestorePointName(baseOptions)).toBe("cs-prod-rp-aaaaaaaa-12345-2");
  });
});
