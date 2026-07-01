import { describe, expect, it } from "vitest";
import {
  cleanupProductionDbRestorePoints,
  parseDoctlDatabaseListOutput,
  parseProductionDbRestorePointCleanupArgs,
  selectHeldRestorePoints,
  selectRestorePointCleanupCandidates,
} from "./production-db-restore-point-cleanup.mjs";

const baseOptions = {
  doctlPath: "doctl",
  prefix: "cs-prod-rp-",
  minAgeHours: 24,
  apply: false,
  checkedAt: "2026-06-29T12:00:00.000Z",
};

const clusters = [
  {
    id: "db-old-restore",
    name: "cs-prod-rp-abcdef12-28349079203-1",
    status: "online",
    createdAt: "2026-06-28T10:00:00Z",
  },
  {
    id: "db-new-restore",
    name: "cs-prod-rp-fedcba98-28352098587-1",
    status: "online",
    createdAt: "2026-06-29T06:30:00Z",
  },
  {
    id: "db-prod",
    name: "chase-sets-production-postgres",
    status: "online",
    createdAt: "2026-01-01T00:00:00Z",
  },
];

describe("production restore-point cleanup", () => {
  it("parses supported doctl database list output shapes", () => {
    expect(parseDoctlDatabaseListOutput(JSON.stringify(clusters))).toEqual(clusters);
    expect(parseDoctlDatabaseListOutput(JSON.stringify({ databases: clusters }))).toEqual(clusters);
    expect(
      parseDoctlDatabaseListOutput(JSON.stringify([{ ID: "db-1", Name: "cs-prod-rp-a", Status: "online" }])),
    ).toEqual([{ id: "db-1", name: "cs-prod-rp-a", status: "online", createdAt: null }]);
  });

  it("selects only old restore-point forks with the configured prefix", () => {
    const candidates = selectRestorePointCleanupCandidates(clusters, {
      prefix: "cs-prod-rp-",
      cutoff: new Date("2026-06-28T12:00:00.000Z"),
      holdNames: [],
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["db-old-restore"]);
  });

  it("excludes held restore-point forks from cleanup candidates", () => {
    expect(selectHeldRestorePoints(clusters, ["cs-prod-rp-abcdef12-28349079203-1"])).toEqual([clusters[0]]);

    const candidates = selectRestorePointCleanupCandidates(clusters, {
      prefix: "cs-prod-rp-",
      cutoff: new Date("2026-06-28T12:00:00.000Z"),
      holdNames: ["db-old-restore"],
    });

    expect(candidates).toEqual([]);
  });

  it("dry-runs by default and records candidates without deleting them", async () => {
    const calls = [];
    const result = await cleanupProductionDbRestorePoints(baseOptions, async (command, args) => {
      calls.push({ command, args });
      return { stdout: JSON.stringify(clusters) };
    });

    expect(result.passesCleanupGate).toBe(true);
    expect(result.record).toMatchObject({
      mode: "dry-run",
      result: "success",
      cutoff: "2026-06-28T12:00:00.000Z",
      restorePoints: {
        held: [],
        candidates: [{ id: "db-old-restore", name: "cs-prod-rp-abcdef12-28349079203-1" }],
        deleted: [],
        failed: [],
      },
    });
    expect(calls).toEqual([{ command: "doctl", args: ["databases", "list", "--output", "json"] }]);
  });

  it("deletes only selected candidates when apply is explicit", async () => {
    const calls = [];
    const result = await cleanupProductionDbRestorePoints({ ...baseOptions, apply: true }, async (command, args) => {
      calls.push({ command, args });
      if (args[1] === "list") {
        return { stdout: JSON.stringify(clusters) };
      }
      return { stdout: "" };
    });

    expect(result.passesCleanupGate).toBe(true);
    expect(result.record.mode).toBe("apply");
    expect(result.record.restorePoints.deleted).toEqual([
      {
        id: "db-old-restore",
        name: "cs-prod-rp-abcdef12-28349079203-1",
        status: "online",
        createdAt: "2026-06-28T10:00:00Z",
      },
    ]);
    expect(calls).toEqual([
      { command: "doctl", args: ["databases", "list", "--output", "json"] },
      { command: "doctl", args: ["databases", "delete", "db-old-restore", "--force"] },
    ]);
  });

  it("fails closed when a selected delete fails", async () => {
    const failure = new Error("Command failed: doctl databases delete");
    failure.code = 1;
    failure.stderr = "Error: cluster is protected";

    const result = await cleanupProductionDbRestorePoints({ ...baseOptions, apply: true }, async (command, args) => {
      if (args[1] === "list") {
        return { stdout: JSON.stringify(clusters) };
      }
      throw failure;
    });

    expect(result.passesCleanupGate).toBe(false);
    expect(result.record.result).toBe("failure");
    expect(result.record.restorePoints.failed).toEqual([
      {
        id: "db-old-restore",
        name: "cs-prod-rp-abcdef12-28349079203-1",
        status: "online",
        createdAt: "2026-06-28T10:00:00Z",
        errors: [
          "doctl database delete failed for a restore-point fork.",
          "exit code: 1",
          "stderr: Error: cluster is protected",
        ],
      },
    ]);
  });

  it("parses CLI and environment options", () => {
    const options = parseProductionDbRestorePointCleanupArgs(
      ["--min-age-hours", "2", "--hold-name", "db-cli-hold", "--apply"],
      {
        DOCTL_PATH: "custom-doctl",
        PRODUCTION_DB_RESTORE_POINT_CLEANUP_OUT: "artifacts/cleanup.json",
        PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES: "db-env-hold,cs-prod-rp-held\ncs-prod-rp-held",
      },
    );

    expect(options).toMatchObject({
      doctlPath: "custom-doctl",
      outPath: "artifacts/cleanup.json",
      prefix: "cs-prod-rp-",
      minAgeHours: 2,
      apply: true,
      holdNames: ["db-cli-hold", "db-env-hold", "cs-prod-rp-held"],
    });
  });
});
