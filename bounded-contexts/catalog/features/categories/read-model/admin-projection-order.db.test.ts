import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapContextDatabase,
  resolveModuleSubscriptions,
  type ContextSubscriptionRunner,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as catalogModule } from "../../../index";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/index";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const context: EventStoreContext = {
  tenantId: "tnt_admin_order" as never,
  audit: { performedByUserId: "usr_admin_order" as never, forAccountId: "acc_admin_order" as never },
};

describeDb("Catalog admin category pages when their subscription runs before the category projection", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  let runners: readonly ContextSubscriptionRunner[];

  const runner = (projectionName: string) => {
    const found = runners.find((candidate) => candidate.projectionName === projectionName);
    if (!found) throw new Error(`No runner for ${projectionName}.`);
    return found;
  };
  const pageCounts = async () => {
    const result = await pool.query<{ base: number; list: number; detail: number }>(
      `SELECT
         (SELECT COUNT(*)::integer FROM catalog_categories WHERE category_id = 'ctg_order') AS base,
         (SELECT COUNT(*)::integer FROM catalog_admin_category_list_pages WHERE category_id = 'ctg_order') AS list,
         (SELECT COUNT(*)::integer FROM catalog_admin_category_detail_pages WHERE category_id = 'ctg_order') AS detail`,
    );
    return result.rows[0];
  };

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["catalog"], "catalog_admin_projection_order");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    services = createCatalogServices(pool);
    runners = resolveModuleSubscriptions([
      {
        contextName: "catalog",
        module: catalogModule,
        services,
        pool,
        projectionHandlerSets: catalogModule.projectionHandlerSets?.(services) ?? [],
      },
    ]);
  });
  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  it("waits for the category projection instead of leaving the new category off its admin pages for good", async () => {
    await services.categories.commandHandler({
      streamId: "catalog.category-ctg_order",
      command: {
        type: "CreateCategory",
        categoryId: "ctg_order",
        key: "order-proof",
        name: { defaultLocale: "en", values: { en: "Order proof" } },
        description: { defaultLocale: "en", values: { en: "Created before its admin page" } },
        parentCategoryId: undefined,
        displayOrder: 0,
      },
      context,
    });

    await expect(runner("catalog-admin-category-projection").runOnce()).rejects.toThrow(
      /catalog-category-projection has not applied catalog\.category\.created/,
    );
    expect(await pageCounts()).toEqual({ base: 0, list: 0, detail: 0 });

    await runner("catalog-category-projection").runOnce();
    await runner("catalog-admin-category-projection").runOnce();

    expect(await pageCounts()).toEqual({ base: 1, list: 1, detail: 1 });
  });
});
