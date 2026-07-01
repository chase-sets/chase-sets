import { describe, expect, it } from "vitest";
import { DIGITALOCEAN_DRIFT_DIGEST_VERSION, runDigitalOceanDriftDigest } from "./digitalocean-drift-digest.mjs";

const BASE_OPTIONS = {
  doctlPath: "doctl",
  repository: "chase-sets-platform",
  checkedAt: "2026-07-01T12:00:00.000Z",
  restorePointMinAgeHours: 24,
  registryRetentionDays: 7,
};

describe("digitalocean-drift-digest", () => {
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
        registryRepository: "chase-sets-platform",
        registryRetentionDays: 7,
        observability: {
          staging: {
            dropletBackupsExpected: false,
            acceptableTelemetryDataLossWindowHours: 24,
            volumeSizeGibMaximum: 100,
          },
          production: {
            dropletBackupsExpected: false,
            acceptableTelemetryDataLossWindowHours: 24,
            volumeSizeGibMinimum: 100,
          },
        },
      },
      summary: {
        unknownChaseSetsResources: 1,
        cleanupCandidates: 2,
        warningFindings: 5,
      },
    });
    expect(result.record.resources.apps).toEqual([
      expect.objectContaining({
        name: "chase-sets-platform",
        classification: "terraform-managed",
        terraformRoot: "infrastructure/digitalocean/platform",
        components: expect.arrayContaining([
          expect.objectContaining({ name: "admin-support-api" }),
          expect.objectContaining({ name: "platform-api" }),
        ]),
      }),
    ]);
    expect(result.record.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "component-topology",
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
          category: "observability-backup-posture",
          resourceType: "droplet",
          resourceName: "chase-sets-staging-observability",
          severity: "warning",
        }),
        expect.objectContaining({
          category: "observability-backup-posture",
          resourceType: "droplet",
          resourceName: "chase-sets-observability",
          severity: "advisory",
        }),
        expect.objectContaining({
          category: "observability-volume-posture",
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
    ];
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
