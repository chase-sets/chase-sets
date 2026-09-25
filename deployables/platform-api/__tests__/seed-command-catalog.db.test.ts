import { module as catalogModule } from "@chase-sets/catalog";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase, createProjectionAwarePool } from "@chase-sets/bounded-context-runtime";
import { describe, expect, it } from "vitest";
import { closePlatformApiPools, createSeedCommandPools } from "../src/database-pools";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("direct seed command Catalog bootstrap", () => {
  it("seeds Catalog scenario items with the actual direct command pool options", async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["catalog"] as const,
      "platform_api_seed_command_catalog",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    const pools = createSeedCommandPools({
      runtimeProfile: "public",
      deploymentEnvironment: "test",
      sharedDatabaseUrl: databaseUrls.catalog,
      contextDatabaseUrls: {},
      port: 6182,
      pool: { max: 6, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 500 },
    });
    try {
      expect((pools.catalog as unknown as { options: { max: number } }).options.max).toBe(1);
      await bootstrapContextDatabase(catalogModule, pools.catalog);
      await catalogModule.seed?.(
        pools.catalog,
        catalogModule.createServices(createProjectionAwarePool(pools.catalog), {}),
        {
          enabledDataProfiles: ["scenario-seed"],
          environmentName: "test",
        },
      );
      const result = await pools.catalog.query<{ count: string }>("SELECT count(*) FROM catalog_items");
      expect(Number(result.rows[0]?.count)).toBeGreaterThan(0);
    } finally {
      await closePlatformApiPools(pools);
    }
  }, 30_000);
});
