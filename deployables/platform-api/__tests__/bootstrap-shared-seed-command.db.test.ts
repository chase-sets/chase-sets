import { describe, expect, it } from "vitest";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import { nonProductionDataProfiles, seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createSeedCommandPools } from "../src/database-pools";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import { createPlatformApiBootstrapTestHarness, listingPhotoStorage } from "./bootstrap-db-test-support";

createPlatformApiBootstrapTestHarness("platform_api_bootstrap_shared_seed_command", () => {});

describe("platform api shared seed command bootstrap", () => {
  it("boots every non-production profile on one shared max-one seed command pool", async () => {
    const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (!adminDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for the shared seed command bootstrap.");
    const sharedUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl,
      ["discovery"] as const,
      "platform_api_bootstrap_shared_seed_command",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl, sharedUrls);
    const seedPools = createSeedCommandPools({
      runtimeProfile: "public",
      deploymentEnvironment: "test",
      sharedDatabaseUrl: sharedUrls.discovery,
      contextDatabaseUrls: {},
      port: 6182,
      pool: { max: 6, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 500 },
    });
    try {
      expect(seedPools.catalog).toBe(seedPools.channels);
      expect((seedPools.channels as unknown as { options: { max: number } }).options.max).toBe(1);
      const runtime = createPlatformApiHost({
        runtimeProfile: "public",
        pools: seedPools,
        hostPorts: {
          processorGateway: createFakePaymentProcessorGateway(),
          listingPhotoStorage,
        },
      });
      await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, {
        enabledDataProfiles: nonProductionDataProfiles,
        schemaBootstrapLockPool: seedPools.schemaBootstrapLockPool,
        environmentName: "test",
        runtimeProfile: "public",
        substepTimeoutMs: 600_000,
      });
      const run = await seedPools.channels.query<{ count: string }>(
        "SELECT count(*) FROM event_store_events WHERE stream_id = $1",
        ["channels.tcgplayer-sync-run-run-seed-tcgplayer-manual-recovery"],
      );
      expect(Number(run.rows[0]?.count)).toBeGreaterThan(0);
    } finally {
      await closePlatformApiPools(seedPools);
    }
  }, 600_000);
});
