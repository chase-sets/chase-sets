import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DIGITALOCEAN_DRIFT_DIGEST_VERSION,
  parseDigitalOceanDriftDigestArgs,
  runDigitalOceanDriftDigest,
} from "./digitalocean-drift-digest.mjs";
import { parseProductionDbRestorePointCleanupArgs } from "./production-db-restore-point-cleanup.mjs";

const BASE_OPTIONS = {
  doctlPath: "doctl",
  repository: "chase-sets-platform",
  checkedAt: "2026-07-01T12:00:00.000Z",
  restorePointMinAgeHours: 24,
  registryRetentionDays: 7,
};

describe("digitalocean-drift-digest", () => {
  it("matches cleanup hold tokenization for repeated CLI and comma-newline environment values", () => {
    const argv = [
      "--hold-name",
      " cs-prod-rp-cli-a, cs-stg-drill-cli-b ",
      "--hold-name",
      "11111111-1111-4111-8111-111111111111,\ncs-prod-rp-cli-a",
    ];
    const authority = " \ncs-stg-drill-env-c, ,cs-prod-rp-env-d\n11111111-1111-4111-8111-111111111111\n";
    const digest = parseDigitalOceanDriftDigestArgs(argv, {
      DIGITALOCEAN_DRIFT_RESTORE_POINT_HOLD_NAMES: authority,
    });
    const cleanup = parseProductionDbRestorePointCleanupArgs(argv, {
      PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES: authority,
    });

    expect(digest.restorePointHoldNames).toEqual([
      "cs-prod-rp-cli-a",
      "cs-stg-drill-cli-b",
      "11111111-1111-4111-8111-111111111111",
      "cs-stg-drill-env-c",
      "cs-prod-rp-env-d",
    ]);
    expect(digest.restorePointHoldNames).toEqual(cleanup.holdNames);
  });

  it("builds an advisory read-only digest across DigitalOcean resource categories", async () => {
    const result = await runDigitalOceanDriftDigest(BASE_OPTIONS, {
      execFile: async (_command, args) => ({ stdout: JSON.stringify(responseFor(args)) }),
    });

    expect(result.passesDigestGate).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: DIGITALOCEAN_DRIFT_DIGEST_VERSION,
      mode: "advisory-read-only",
      result: "warning",
      policies: {
        restorePointPrefix: "cs-prod-rp-",
        restoreDrillPrefix: "cs-stg-drill-",
        registryRepository: "chase-sets-platform",
        registryRetentionDays: 7,
        retiredComputeProvider: "digitalocean-apps",
        observability: {
          shared: {
            dropletBackupsExpected: false,
            acceptableTelemetryDataLossWindowHours: 24,
            volumeSizeGibMinimum: 50,
            volumeSizeGibMaximum: 100,
          },
        },
      },
      summary: {
        unknownChaseSetsResources: 3,
        cleanupCandidates: 3,
        warningFindings: 7,
        databaseBackups: {
          observedClusters: 1,
          staleClusters: 0,
          missingClusters: 0,
          newestBackupAgeHoursByCluster: {
            "chase-sets-postgres": 12,
          },
        },
      },
    });
    expect(result.record.resources.databaseBackups).toEqual([
      expect.objectContaining({
        clusterId: "db-prod",
        clusterName: "chase-sets-postgres",
        backupCount: 1,
        newestBackupCreatedAt: "2026-07-01T00:00:00.000Z",
        newestBackupAgeHours: 12,
        expectedMaximumAgeHours: 26,
        stale: false,
        missing: false,
      }),
    ]);
    expect(result.record.collections["databaseBackups:chase-sets-postgres"]).toMatchObject({
      status: "success",
      command: ["doctl", "databases", "backups", "db-prod", "--output", "json"],
      count: 1,
    });
    expect(result.record.resources.apps).toEqual([
      expect.objectContaining({
        name: "chase-sets-platform",
        classification: "retired-chase-sets-compute",
        terraformRoot: null,
        components: expect.arrayContaining([
          expect.objectContaining({ name: "admin-support-api" }),
          expect.objectContaining({ name: "platform-api" }),
        ]),
      }),
    ]);
    expect(result.record.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "retired-compute-present",
          resourceType: "app",
          resourceName: "chase-sets-platform",
          severity: "warning",
        }),
        expect.objectContaining({
          category: "restore-point-retention",
          resourceType: "database",
          resourceName: "cs-prod-rp-abcdef12-285000-1",
          severity: "warning",
        }),
        expect.objectContaining({
          category: "restore-drill-retention",
          resourceType: "database",
          resourceName: "cs-stg-drill-20260629-123-1",
          severity: "warning",
        }),
        expect.objectContaining({
          category: "registry-retention",
          resourceType: "registry-tag",
          resourceName: "old-main",
          severity: "advisory",
        }),
        expect.objectContaining({
          category: "remote-dev-retention",
          resourceType: "droplet",
          resourceName: "chase-sets-dev-todd",
          severity: "advisory",
        }),
        expect.objectContaining({
          category: "unknown-chase-sets-resource",
          resourceType: "droplet",
          resourceName: "chase-sets-staging-observability",
          severity: "warning",
        }),
        expect.objectContaining({
          category: "observability-backup-posture",
          resourceType: "droplet",
          resourceName: "chase-sets-observability",
          severity: "warning",
        }),
        expect.objectContaining({
          category: "unknown-chase-sets-resource",
          resourceType: "volume",
          resourceName: "chase-sets-staging-observability-data",
          severity: "warning",
        }),
        expect.objectContaining({
          category: "uptime-alerts",
          resourceType: "uptime-check",
          resourceName: "chase-sets-platform-public-down",
          severity: "advisory",
        }),
      ]),
    );
  });

  it("records absent hold authority without changing stale warning or candidate behavior", async () => {
    const result = await runWithDatabases([
      staleRestorePoint("11111111-1111-4111-8111-111111111111", "cs-prod-rp-unheld"),
    ]);

    expect(result.record.policies.restorePointHolds).toEqual({
      status: "absent",
      tokenCount: 0,
      appliedCount: 0,
      unmatchedCount: 0,
      effectiveTokenSetSha256: null,
    });
    expect(result.record.summary).toMatchObject({ cleanupCandidates: 1, heldRestorePoints: 0 });
    expect(retentionFindings(result.record)).toHaveLength(1);
    expect(invalidAuthorityFindings(result.record)).toHaveLength(0);
  });

  it("holds a stale production restore point by id with the captured effective-authority fingerprint", async () => {
    const result = await runWithDatabases(
      [staleRestorePoint("a60d3813-a535-442a-81a3-97af169c09fa", "cs-prod-rp-held-by-id-with-a-different-name")],
      capturedProductionHoldTokens(),
    );

    expect(result.record.policies.restorePointHolds).toEqual({
      status: "applied",
      tokenCount: 2,
      appliedCount: 1,
      unmatchedCount: 1,
      effectiveTokenSetSha256: CAPTURED_PRODUCTION_HOLD_FINGERPRINT,
    });
    expect(result.record.resources.databases).toEqual([
      expect.objectContaining({
        oldRestorePoint: true,
        heldByAuthority: true,
        classification: "operator-managed",
      }),
    ]);
    expect(result.record.summary).toMatchObject({ cleanupCandidates: 0, heldRestorePoints: 1 });
    expect(retentionFindings(result.record)).toHaveLength(0);
  });

  it("holds a stale production restore point by name with the captured effective-authority fingerprint", async () => {
    const result = await runWithDatabases(
      [staleRestorePoint("22222222-2222-4222-8222-222222222222", "cs-prod-rp-a22f75c115da9564-30396324956-1")],
      capturedProductionHoldTokens(),
    );

    expect(result.record.policies.restorePointHolds).toEqual({
      status: "applied",
      tokenCount: 2,
      appliedCount: 1,
      unmatchedCount: 1,
      effectiveTokenSetSha256: CAPTURED_PRODUCTION_HOLD_FINGERPRINT,
    });
    expect(result.record.resources.databases).toEqual([
      expect.objectContaining({
        oldRestorePoint: true,
        heldByAuthority: true,
        classification: "operator-managed",
      }),
    ]);
    expect(result.record.summary).toMatchObject({ cleanupCandidates: 0, heldRestorePoints: 1 });
    expect(retentionFindings(result.record)).toHaveLength(0);
  });

  it("re-derives closure evidence from the captured runtime authority applied to the production fork", async () => {
    const result = await runWithDatabases(
      [staleRestorePoint("a60d3813-a535-442a-81a3-97af169c09fa", "cs-prod-rp-a22f75c115da9564-30396324956-1")],
      capturedProductionHoldTokens(),
    );

    expect(result.record.policies.restorePointHolds).toEqual({
      status: "applied",
      tokenCount: 2,
      appliedCount: 2,
      unmatchedCount: 0,
      effectiveTokenSetSha256: CAPTURED_PRODUCTION_HOLD_FINGERPRINT,
    });
    expect(result.record.summary).toMatchObject({ cleanupCandidates: 0, heldRestorePoints: 1 });
    expect(result.record.resources.databases[0]).toMatchObject({
      oldRestorePoint: true,
      heldByAuthority: true,
      classification: "operator-managed",
    });
    expect(retentionFindings(result.record)).toHaveLength(0);
  });

  it("fingerprints canonical token order without sorting or joining the accepted authority", async () => {
    const reversedTokens = [...CAPTURED_PRODUCTION_HOLD_TOKENS].reverse();
    const result = await runWithDatabases([], reversedTokens);

    expect(result.record.policies.restorePointHolds).toEqual({
      status: "applied",
      tokenCount: 2,
      appliedCount: 0,
      unmatchedCount: 2,
      effectiveTokenSetSha256: "cd27af26fd61ab7bf4dbee78223d9dff327350ac938343b4e0153f2cbc0ed856",
    });
    expect(result.record.policies.restorePointHolds.effectiveTokenSetSha256).not.toBe(
      CAPTURED_PRODUCTION_HOLD_FINGERPRINT,
    );
    expect(result.record.policies.restorePointHolds.effectiveTokenSetSha256).not.toBe(
      tokenSetFingerprint(reversedTokens.join(",")),
    );
  });

  it("keeps an unheld stale fork warning and candidate when another stale fork is held", async () => {
    const heldName = "cs-stg-drill-held";
    const unheldName = "cs-prod-rp-still-stale";
    const result = await runWithDatabases(
      [
        staleRestorePoint("11111111-1111-4111-8111-111111111111", heldName),
        staleRestorePoint("22222222-2222-4222-8222-222222222222", unheldName),
      ],
      [heldName],
    );

    expect(result.record.summary).toMatchObject({ cleanupCandidates: 1, heldRestorePoints: 1 });
    expect(retentionFindings(result.record)).toEqual([
      expect.objectContaining({ resourceName: unheldName, category: "restore-point-retention" }),
    ]);
    expect(result.record.resources.databases).toEqual([
      expect.objectContaining({ name: heldName, oldRestoreDrill: true, heldByAuthority: true }),
      expect.objectContaining({ name: unheldName, oldRestorePoint: true, heldByAuthority: false }),
    ]);
  });

  it("treats unmatched-only hold authority as the normal applied steady state", async () => {
    const token = "cs-prod-rp-already-deleted";
    const result = await runWithDatabases(
      [staleRestorePoint("11111111-1111-4111-8111-111111111111", "cs-prod-rp-still-stale")],
      [token],
    );

    expect(result.record.policies.restorePointHolds).toEqual({
      status: "applied",
      tokenCount: 1,
      appliedCount: 0,
      unmatchedCount: 1,
      effectiveTokenSetSha256: tokenSetFingerprint([token]),
    });
    expect(result.record.summary).toMatchObject({ cleanupCandidates: 1, heldRestorePoints: 0 });
    expect(retentionFindings(result.record)).toHaveLength(1);
    expect(invalidAuthorityFindings(result.record)).toHaveLength(0);
  });

  it.each([
    ["a malformed token", "malformed hold token"],
    ["an uppercase id token", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
  ])("refuses the whole authority for %s", async (_caseName, offendingToken) => {
    const staleName = "cs-prod-rp-refusal-stays-stale";
    const result = await runWithDatabases(
      [staleRestorePoint("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", staleName)],
      [offendingToken],
    );

    expectRefusedAuthority(result.record, 1);
    expect(retentionFindings(result.record)).toEqual([expect.objectContaining({ resourceName: staleName })]);
    expectSafeInvalidFinding(result.record, [{ index: 1, token: offendingToken }]);
  });

  it("refuses duplicate observed-name ambiguity without redacting truthful resource identity", async () => {
    const duplicateName = "cs-prod-rp-duplicate-observed-name";
    const result = await runWithDatabases(
      [
        staleRestorePoint("11111111-1111-4111-8111-111111111111", duplicateName),
        staleRestorePoint("22222222-2222-4222-8222-222222222222", duplicateName),
      ],
      [duplicateName],
    );

    expectRefusedAuthority(result.record, 1);
    expect(result.record.resources.databases.map((database) => database.name)).toEqual([duplicateName, duplicateName]);
    expect(retentionFindings(result.record).map((finding) => finding.resourceName)).toEqual([
      duplicateName,
      duplicateName,
    ]);
    expectSafeInvalidFinding(result.record, [{ index: 1, token: duplicateName }]);
    expect(JSON.stringify(result.record.policies)).not.toContain(duplicateName);
  });

  it("totally refuses valid matching authority combined with a malformed token", async () => {
    const validToken = "cs-prod-rp-would-have-been-held";
    const offendingToken = "not valid authority";
    const otherStaleName = "cs-prod-rp-also-stays-stale";
    const result = await runWithDatabases(
      [
        staleRestorePoint("11111111-1111-4111-8111-111111111111", validToken),
        staleRestorePoint("22222222-2222-4222-8222-222222222222", otherStaleName),
      ],
      [validToken, offendingToken],
    );

    expectRefusedAuthority(result.record, 2);
    expect(result.record.summary).toMatchObject({ cleanupCandidates: 2, heldRestorePoints: 0 });
    expect(retentionFindings(result.record).map((finding) => finding.resourceName)).toEqual([
      validToken,
      otherStaleName,
    ]);
    expect(result.record.resources.databases.every((database) => database.heldByAuthority === false)).toBe(true);
    expectSafeInvalidFinding(result.record, [{ index: 2, token: offendingToken }]);
  });

  it("totally refuses one token colliding across a cluster id and a different cluster name", async () => {
    const collidingToken = "33333333-3333-4333-8333-333333333333";
    const staleName = "cs-prod-rp-id-name-cross-cluster-collision";
    const result = await runWithDatabases(
      [
        staleRestorePoint(collidingToken, staleName),
        {
          id: "44444444-4444-4444-8444-444444444444",
          name: collidingToken,
          status: "online",
          created_at: "2026-06-29T00:00:00.000Z",
        },
      ],
      [collidingToken],
    );

    expectRefusedAuthority(result.record, 1);
    expect(result.record.summary).toMatchObject({ cleanupCandidates: 1, heldRestorePoints: 0 });
    expect(retentionFindings(result.record)).toEqual([expect.objectContaining({ resourceName: staleName })]);
    expectSafeInvalidFinding(result.record, [{ index: 1, token: collidingToken }]);
  });

  it("warns when a PR preview managed Postgres cluster exists", async () => {
    const result = await runDigitalOceanDriftDigest(BASE_OPTIONS, {
      execFile: async (_command, args) => {
        if (args.join(" ") === "databases list --output json") {
          return {
            stdout: JSON.stringify([
              {
                id: "db-preview",
                name: "chase-sets-pr-123-postgres",
                status: "online",
                created_at: "2026-07-01T00:00:00.000Z",
              },
            ]),
          };
        }
        return { stdout: JSON.stringify(responseFor(args)) };
      },
    });

    expect(result.record.resources.databases).toEqual([
      expect.objectContaining({
        id: "db-preview",
        name: "chase-sets-pr-123-postgres",
        classification: "forbidden-preview-managed-postgres",
        terraformRoot: null,
      }),
    ]);
    expect(result.record.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "preview-managed-postgres-violation",
          resourceType: "database",
          resourceName: "chase-sets-pr-123-postgres",
          severity: "warning",
        }),
      ]),
    );
  });

  it("warns when the newest production database backup is stale", async () => {
    const result = await runDigitalOceanDriftDigest(BASE_OPTIONS, {
      execFile: async (_command, args) => {
        if (args.join(" ") === "databases backups db-prod --output json") {
          return { stdout: JSON.stringify([{ id: "backup-old", created_at: "2026-06-30T00:00:00.000Z" }]) };
        }
        return { stdout: JSON.stringify(responseFor(args)) };
      },
    });

    expect(result.record.summary.databaseBackups).toMatchObject({
      observedClusters: 1,
      staleClusters: 1,
      missingClusters: 0,
      newestBackupAgeHoursByCluster: {
        "chase-sets-postgres": 36,
      },
    });
    expect(result.record.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "database-backup-health",
          resourceType: "database-backup",
          resourceName: "chase-sets-postgres",
          severity: "warning",
          evidence: expect.objectContaining({
            backupCount: 1,
            newestBackupAgeHours: 36,
            expectedMaximumAgeHours: 26,
          }),
        }),
      ]),
    );
  });

  it("warns when a managed database backup list is empty", async () => {
    const result = await runDigitalOceanDriftDigest(BASE_OPTIONS, {
      execFile: async (_command, args) => {
        if (args.join(" ") === "databases backups db-prod --output json") {
          return { stdout: JSON.stringify([]) };
        }
        return { stdout: JSON.stringify(responseFor(args)) };
      },
    });

    expect(result.record.summary.databaseBackups).toMatchObject({
      observedClusters: 1,
      staleClusters: 0,
      missingClusters: 1,
      newestBackupAgeHoursByCluster: {
        "chase-sets-postgres": null,
      },
    });
    expect(result.record.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "database-backup-health",
          resourceType: "database-backup",
          resourceName: "chase-sets-postgres",
          severity: "warning",
          evidence: expect.objectContaining({
            backupCount: 0,
            newestBackupCreatedAt: null,
            newestBackupAgeHours: null,
          }),
        }),
      ]),
    );
  });

  it("records database backup collection failures without adding stale or missing findings", async () => {
    const result = await runDigitalOceanDriftDigest(BASE_OPTIONS, {
      execFile: async (_command, args) => {
        if (args.join(" ") === "databases backups db-prod --output json") {
          const error = new Error("backup collection failed");
          error.stderr = "backup permission denied";
          throw error;
        }
        return { stdout: JSON.stringify(responseFor(args)) };
      },
    });

    expect(result.record.collections["databaseBackups:chase-sets-postgres"]).toMatchObject({
      status: "failed",
      count: 0,
      error: expect.arrayContaining(["stderr: backup permission denied"]),
    });
    expect(result.record.resources.databaseBackups).toEqual([
      expect.objectContaining({
        clusterName: "chase-sets-postgres",
        collectionStatus: "failed",
        missing: false,
        stale: false,
      }),
    ]);
    expect(result.record.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "collection",
          resourceType: "doctl",
          resourceName: "databaseBackups:chase-sets-postgres",
          severity: "warning",
        }),
      ]),
    );
    expect(
      result.record.findings.some(
        (finding) => finding.category === "database-backup-health" && finding.resourceName === "chase-sets-postgres",
      ),
    ).toBe(false);
  });

  it("records doctl collection failures as advisory digest warnings without failing the gate", async () => {
    const result = await runDigitalOceanDriftDigest(BASE_OPTIONS, {
      execFile: async (_command, args) => {
        if (args[0] === "databases") {
          const error = new Error("doctl failed");
          error.stderr = "permission denied";
          throw error;
        }
        return { stdout: JSON.stringify([]) };
      },
    });

    expect(result.passesDigestGate).toBe(true);
    expect(result.record.result).toBe("warning");
    expect(result.record.collections.databases).toMatchObject({
      status: "failed",
      count: 0,
      error: expect.arrayContaining(["stderr: permission denied"]),
    });
    expect(result.record.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "collection",
          resourceType: "doctl",
          resourceName: "databases",
          severity: "warning",
        }),
      ]),
    );
  });
});

const CAPTURED_PRODUCTION_HOLD_TOKENS = [
  "a60d3813-a535-442a-81a3-97af169c09fa",
  "cs-prod-rp-a22f75c115da9564-30396324956-1",
];
const CAPTURED_PRODUCTION_HOLD_FINGERPRINT = "a25f6cffb71c2795d7fbc38b5ef725b690017acf18bc54a5b9799a927ba07db8";

function capturedProductionHoldTokens() {
  return parseDigitalOceanDriftDigestArgs([], {
    DIGITALOCEAN_DRIFT_RESTORE_POINT_HOLD_NAMES: CAPTURED_PRODUCTION_HOLD_TOKENS.join(","),
  }).restorePointHoldNames;
}

async function runWithDatabases(databases, restorePointHoldNames = []) {
  return runDigitalOceanDriftDigest(
    {
      ...BASE_OPTIONS,
      restorePointHoldNames,
    },
    {
      execFile: async (_command, args) => ({
        stdout: JSON.stringify(args.join(" ") === "databases list --output json" ? databases : []),
      }),
    },
  );
}

function staleRestorePoint(id, name) {
  return {
    id,
    name,
    status: "online",
    created_at: "2026-06-29T00:00:00.000Z",
  };
}

function retentionFindings(record) {
  return record.findings.filter((finding) =>
    ["restore-point-retention", "restore-drill-retention"].includes(finding.category),
  );
}

function invalidAuthorityFindings(record) {
  return record.findings.filter((finding) => finding.category === "restore-point-hold-authority-invalid");
}

function expectRefusedAuthority(record, tokenCount) {
  expect(record.policies.restorePointHolds).toEqual({
    status: "refused",
    tokenCount,
    appliedCount: 0,
    unmatchedCount: 0,
    effectiveTokenSetSha256: null,
  });
  expect(record.result).toBe("warning");
  expect(record.resources.databases.every((database) => database.heldByAuthority === false)).toBe(true);
}

function expectSafeInvalidFinding(record, offendingTokens) {
  const findings = invalidAuthorityFindings(record);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toEqual({
    severity: "warning",
    category: "restore-point-hold-authority-invalid",
    resourceType: "hold-authority",
    resourceName: "DIGITALOCEAN_DRIFT_RESTORE_POINT_HOLD_NAMES",
    owner: "ops",
    terraformRoot: null,
    action:
      "Inspect the production restore-point cleanup hold authority and correct every malformed or ambiguous entry; no holds were applied.",
    evidence: {
      offendingTokens: offendingTokens.map(({ index, token }) => ({
        index,
        sha256Prefix: tokenSetFingerprint(token).slice(0, 8),
      })),
    },
  });
  for (const { token } of offendingTokens) {
    expect(findings[0].action).not.toContain(token);
    expect(JSON.stringify(findings[0].evidence)).not.toContain(token);
  }
}

function tokenSetFingerprint(value) {
  const source = Array.isArray(value) ? JSON.stringify(value) : value;
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function responseFor(args) {
  const command = args.join(" ");
  if (command === "apps list --output json") {
    return [
      {
        id: "app-prod",
        spec: { name: "chase-sets-platform" },
      },
    ];
  }
  if (command === "apps get app-prod --output json") {
    return {
      id: "app-prod",
      spec: {
        name: "chase-sets-platform",
        services: [
          { name: "public-web", instance_count: 1, instance_size_slug: "basic-xs" },
          { name: "admin-support-api", instance_count: 1, instance_size_slug: "basic-xs" },
          { name: "platform-api", instance_count: 1, instance_size_slug: "basic-xs" },
        ],
        workers: [{ name: "platform-worker", instance_count: 1, instance_size_slug: "basic-xs" }],
      },
    };
  }
  if (command === "databases list --output json") {
    return [
      {
        id: "db-prod",
        name: "chase-sets-postgres",
        status: "online",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "db-rp",
        name: "cs-prod-rp-abcdef12-285000-1",
        status: "online",
        created_at: "2026-06-29T00:00:00.000Z",
      },
      {
        id: "db-stg-drill-old",
        name: "cs-stg-drill-20260629-123-1",
        status: "online",
        created_at: "2026-06-29T00:00:00.000Z",
      },
      {
        id: "db-stg-drill-fresh",
        name: "cs-stg-drill-20260701-456-1",
        status: "online",
        created_at: "2026-07-01T10:00:00.000Z",
      },
    ];
  }
  if (command === "databases backups db-prod --output json") {
    return [{ id: "backup-recent", created_at: "2026-07-01T00:00:00.000Z", size_gigabytes: 12 }];
  }
  if (command === "registry repository list-tags chase-sets-platform --output json") {
    return [
      { tag: "release-20260701120000-abcdef12", updated_at: "2026-06-01T00:00:00.000Z" },
      { tag: "old-main", digest: "sha256:old", updated_at: "2026-06-01T00:00:00.000Z" },
      { tag: "recent-main", digest: "sha256:recent", updated_at: "2026-07-01T00:00:00.000Z" },
    ];
  }
  if (command === "compute droplet list --output json") {
    return [
      {
        id: 1,
        name: "chase-sets-observability",
        status: "active",
        size_slug: "s-1vcpu-1gb",
        backups: true,
      },
      {
        id: 2,
        name: "chase-sets-staging-observability",
        status: "active",
        size_slug: "s-1vcpu-1gb",
        backups: true,
      },
      {
        id: 3,
        name: "chase-sets-dev-todd",
        status: "active",
        size_slug: "s-1vcpu-1gb",
      },
      {
        id: 4,
        name: "chase-sets-manual-box",
        status: "active",
        size_slug: "s-1vcpu-1gb",
      },
    ];
  }
  if (command === "compute volume list --output json") {
    return [
      { id: "vol-1", name: "chase-sets-observability-data", size_gigabytes: 100 },
      { id: "vol-2", name: "chase-sets-staging-observability-data", size_gigabytes: 250 },
    ];
  }
  if (command === "monitoring uptime list --output json") {
    return [{ id: "uptime-1", name: "chase-sets-platform-public-down", target: "https://chasesets.com" }];
  }
  if (command === "monitoring uptime alert list uptime-1 --output json") {
    return [];
  }
  if (command === "compute cdn list --output json") {
    return [
      {
        id: "cdn-1",
        origin: "chase-sets-production-catalog-assets.nyc3.digitaloceanspaces.com",
        endpoint: "chase-sets-production-catalog-assets.nyc3.cdn.digitaloceanspaces.com",
        custom_domain: "assets.chasesets.com",
      },
    ];
  }
  throw new Error(`Unexpected command: ${command}`);
}
