import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPgPool, type PgPoolClient, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { areCatalogIntegrationSeedProjectionsCurrent } from "../../../support/authoring-support/seed";
import { createCatalogServices } from "../../../support/authoring-support/services";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const lockedProjectionTables = [
  "catalog_dimensions",
  "catalog_fields",
  "catalog_reference_types",
  "catalog_reference_records",
  "catalog_components",
  "catalog_blueprints",
  "catalog_categories",
].join(", ");

describeDb("Catalog bootstrap pool ownership", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["catalog"] as const,
      "catalog_bootstrap_pool",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pool = createPgPool(databaseUrls.catalog, {
      max: 3,
      connectionTimeoutMillis: 500,
    });
    await bootstrapContextDatabase(catalogModule, pool);

    const warmClients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    for (const client of warmClients) {
      client.release();
    }
  });

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("checks retained projections with one pool checkout while bootstrap owns another", async () => {
    const bootstrapOwner = (await pool.connect()) as PgPoolClient;
    await bootstrapOwner.query("BEGIN");
    await bootstrapOwner.query(`LOCK TABLE ${lockedProjectionTables} IN ACCESS EXCLUSIVE MODE`);

    const releaseBootstrapOwner = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void bootstrapOwner.query("COMMIT").then(
          () => {
            bootstrapOwner.release();
            resolve();
          },
          (error: unknown) => {
            bootstrapOwner.release(error);
            reject(error);
          },
        );
      }, 750);
    });

    try {
      const projectionCheck = areCatalogIntegrationSeedProjectionsCurrent(pool);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poolState = pool as PgTransactionalPool &
        Readonly<{ totalCount: number; idleCount: number; waitingCount: number }>;
      expect({
        total: poolState.totalCount,
        idle: poolState.idleCount,
        waiting: poolState.waitingCount,
      }).toEqual({
        total: 3,
        idle: 1,
        waiting: 0,
      });

      const current = await projectionCheck;
      expect(current).toBe(false);
    } finally {
      await releaseBootstrapOwner;
    }
  });

  it("previews concurrent publication candidates within the existing pool ceiling", async () => {
    const services = createCatalogServices(pool);
    const context = {
      tenantId: "tnt_pool" as never,
      audit: { performedByUserId: "usr_pool" as never, forAccountId: "acc_pool" as never },
    };
    const send = (
      handler: typeof services.items.commandHandler,
      streamId: string,
      command: Parameters<typeof handler>[0]["command"],
    ) => handler({ streamId, command, context });
    await services.blueprints.commandHandler({
      streamId: "catalog.blueprint-bpr_pool",
      command: {
        type: "CreateBlueprint",
        blueprintId: "bpr_pool" as never,
        key: "pool",
        name: localizedTextMapFromEnglish("Pool"),
        description: localizedTextMapFromEnglish("Pool pressure"),
      },
      context,
    });
    await services.blueprints.commandHandler({
      streamId: "catalog.blueprint-bpr_pool",
      command: { type: "PublishBlueprint" },
      context,
    });
    await drainLocalProjectionHandlerSets("catalog", pool, services.blueprints.projectors);
    await services.displayTemplates.commandHandler({
      streamId: "catalog.display-template-dtp_pool",
      command: {
        type: "CreateDisplayTemplate",
        displayTemplateId: "dtp_pool" as never,
        key: "pool",
        name: localizedTextMapFromEnglish("Pool"),
        description: localizedTextMapFromEnglish("Pool pressure"),
        target: { kind: "blueprint", id: "bpr_pool" },
        priority: 1,
        titleTemplate: "{item.title}",
        subtitleTemplate: null,
      },
      context,
    });
    await services.displayTemplates.commandHandler({
      streamId: "catalog.display-template-dtp_pool",
      command: { type: "PublishDisplayTemplate" },
      context,
    });
    await drainLocalProjectionHandlerSets("catalog", pool, services.displayTemplates.projectors);
    const itemIds = Array.from({ length: 12 }, (_, index) => `cat_pool_${index}`);
    for (const itemId of itemIds) {
      await send(services.items.commandHandler, `catalog.item-${itemId}`, {
        type: "CreateCatalogItem",
        itemId: itemId as never,
        title: localizedTextMapFromEnglish(`Pool ${itemId}`),
        subtitle: null,
        description: localizedTextMapFromEnglish(""),
      });
      await send(services.items.commandHandler, `catalog.item-${itemId}`, {
        type: "AssignBlueprintToCatalogItem",
        blueprintId: "bpr_pool" as never,
      });
    }
    await drainLocalProjectionHandlerSets("catalog", pool, services.items.projectors);

    const preview = await services.items.previewBulkPublish({ mode: "ids", ids: itemIds });

    expect(preview).toMatchObject({ total: 12, ready_count: 12, blocked_count: 0 });
  });
});
