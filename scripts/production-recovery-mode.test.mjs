import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCTION_RECOVERY_MODE_VERSION,
  classifyProductionRecoveryMode,
  parseProductionRecoveryModeArgs,
} from "./production-recovery-mode.mjs";

const RELEASE_COMMIT = "a".repeat(40);

describe("production-recovery-mode", () => {
  it("defaults routine UI and projection deploys to PITR recovery", () => {
    const result = classifyProductionRecoveryMode({
      releaseCommit: RELEASE_COMMIT,
      changedFilesJson: JSON.stringify([
        "deployables/admin-web/app/routes/index.tsx",
        "bounded-contexts/catalog/features/source-observations/projections/rebuild.ts",
      ]),
      forceRestorePoint: false,
      recoveryReason: "",
      checkedAt: "2026-07-01T12:00:00.000Z",
    });

    expect(result.passesRecoveryModeGate).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: PRODUCTION_RECOVERY_MODE_VERSION,
      mode: "pitr",
      restorePointRequired: false,
      result: "success",
      matchedRules: [],
      fallbackRestoreProcedure:
        "Use DigitalOcean managed Postgres PITR/backups to create a new cluster, then replay projections from the event store.",
    });
  });

  it("requires a precreated fork for live money provider changes", () => {
    const result = classifyProductionRecoveryMode({
      releaseCommit: RELEASE_COMMIT,
      changedFilesJson: JSON.stringify(["bounded-contexts/payments/features/payment-intents/domain.ts"]),
      forceRestorePoint: false,
      recoveryReason: "",
      checkedAt: "2026-07-01T12:00:00.000Z",
    });

    expect(result.passesRecoveryModeGate).toBe(true);
    expect(result.record.mode).toBe("precreated-fork");
    expect(result.record.restorePointRequired).toBe(true);
    expect(result.record.matchedRules).toEqual([
      expect.objectContaining({
        filePath: "bounded-contexts/payments/features/payment-intents/domain.ts",
        ruleId: "live-money-provider",
      }),
    ]);
  });

  it("requires a precreated fork for schema and event-store changes", () => {
    const result = classifyProductionRecoveryMode({
      releaseCommit: RELEASE_COMMIT,
      changedFilesJson: JSON.stringify([
        "bounded-contexts/catalog/migrations/20260701.sql",
        "infrastructure/event-store/postgres-event-store.ts",
      ]),
      forceRestorePoint: false,
      recoveryReason: "",
      checkedAt: "2026-07-01T12:00:00.000Z",
    });

    expect(result.passesRecoveryModeGate).toBe(true);
    expect(result.record.mode).toBe("precreated-fork");
    expect(result.record.restorePointRequired).toBe(true);
    expect(result.record.matchedRules.map((rule) => rule.ruleId)).toEqual([
      "canonical-schema-migration",
      "event-store-contract",
    ]);
  });

  it("supports manual hold only with an operator reason", () => {
    const result = classifyProductionRecoveryMode({
      releaseCommit: RELEASE_COMMIT,
      changedFilesJson: "[]",
      forceRestorePoint: true,
      recoveryReason: "launch desk requested hot restore point",
      checkedAt: "2026-07-01T12:00:00.000Z",
    });

    expect(result.passesRecoveryModeGate).toBe(true);
    expect(result.record.mode).toBe("manual-hold");
    expect(result.record.reason).toBe("launch desk requested hot restore point");
    expect(result.record.restorePointRequired).toBe(true);
  });

  it("rejects invalid changed file input and missing manual hold reason", () => {
    const result = classifyProductionRecoveryMode({
      releaseCommit: RELEASE_COMMIT,
      changedFilesJson: "{}",
      forceRestorePoint: true,
      recoveryReason: "",
      checkedAt: "2026-07-01T12:00:00.000Z",
    });

    expect(result.passesRecoveryModeGate).toBe(false);
    expect(result.record.result).toBe("failure");
    expect(result.record.errors).toEqual([
      "CHANGED_FILES_JSON must be a JSON array of file paths.",
      "RECOVERY_REASON is required when FORCE_RESTORE_POINT is true.",
    ]);
  });

  const tempDirs = [];

  function writeTempFile(name, contents) {
    const dir = mkdtempSync(path.join(tmpdir(), "recovery-mode-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, name);
    writeFileSync(filePath, contents, "utf8");
    return filePath;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("reads the changed-files list from a file so a huge release diff never rides the CLI argument limit", () => {
    // A cold-start production deploy diffs against a stale production branch and
    // can list thousands of files. Inlining that JSON as one CLI argument
    // exceeds the operating-system per-argument length limit; the file transport
    // handles it without truncation.
    const changedFiles = Array.from(
      { length: 6000 },
      (_, index) => `bounded-contexts/catalog/features/slice-${index}/read-model/queries-${index}.ts`,
    );
    changedFiles.push("bounded-contexts/payments/features/payment-intents/domain.ts");
    const changedFilesJson = JSON.stringify(changedFiles);
    expect(changedFilesJson.length).toBeGreaterThan(256 * 1024);

    const filePath = writeTempFile("release-changed-files.json", `${changedFilesJson}\n`);
    const options = parseProductionRecoveryModeArgs([
      "--release-commit",
      RELEASE_COMMIT,
      "--changed-files-file",
      filePath,
      "--checked-at",
      "2026-07-01T12:00:00.000Z",
    ]);

    expect(options.changedFilesJson).toBe(changedFilesJson);

    const result = classifyProductionRecoveryMode(options);
    expect(result.passesRecoveryModeGate).toBe(true);
    expect(result.record.changedFiles).toHaveLength(changedFiles.length);
    expect(result.record.mode).toBe("precreated-fork");
    expect(result.record.matchedRules[0]).toMatchObject({ ruleId: "live-money-provider" });
  });

  it("treats an empty changed-files file as no changed files", () => {
    const filePath = writeTempFile("release-changed-files.json", "\n");
    const options = parseProductionRecoveryModeArgs([
      "--release-commit",
      RELEASE_COMMIT,
      "--changed-files-file",
      filePath,
      "--checked-at",
      "2026-07-01T12:00:00.000Z",
    ]);

    expect(options.changedFilesJson).toBe("[]");
    const result = classifyProductionRecoveryMode(options);
    expect(result.passesRecoveryModeGate).toBe(true);
    expect(result.record.mode).toBe("pitr");
  });

  it("prefers an explicit inline changed-files argument over the file", () => {
    const filePath = writeTempFile("release-changed-files.json", '["docs/ignored.md"]\n');
    const options = parseProductionRecoveryModeArgs([
      "--changed-files-json",
      '["docs/runbook.md"]',
      "--changed-files-file",
      filePath,
    ]);

    expect(options.changedFilesJson).toBe('["docs/runbook.md"]');
  });

  it("fails loudly when the changed-files file cannot be read", () => {
    expect(() =>
      parseProductionRecoveryModeArgs(["--changed-files-file", path.join(tmpdir(), "does-not-exist-recovery.json")]),
    ).toThrow(/Unable to read --changed-files-file/);
  });

  it("parses workflow inputs and environment fallbacks", () => {
    expect(
      parseProductionRecoveryModeArgs(["--force-restore-point", "true", "--recovery-reason", "operator hold"], {
        RELEASE_COMMIT,
        CHANGED_FILES_JSON: '["docs/runbook.md"]',
        GITHUB_OUTPUT: "out.txt",
      }),
    ).toMatchObject({
      releaseCommit: RELEASE_COMMIT,
      changedFilesJson: '["docs/runbook.md"]',
      forceRestorePoint: true,
      recoveryReason: "operator hold",
      githubOutputPath: "out.txt",
    });
  });
});
