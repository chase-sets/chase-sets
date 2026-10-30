import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapContextDatabase,
  createProjectionAwarePool,
  drainLocalProjectionHandlerSets,
} from "@chase-sets/bounded-context-runtime";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPgPool,
  type PgPoolClient,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { areCatalogIntegrationSeedProjectionsCurrent } from "../../../support/authoring-support/seed";
import { createCatalogServices } from "../../../support/authoring-support/services";
import { resolveCatalogProductSelection } from "../../../support/request-support/product-selection";
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

const catalogItemProjectorNames = ["catalog-admin-catalog-item-projection", "catalog-item-projection"];

function exceptionClassAndCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    class: error instanceof Error ? error.constructor.name : typeof error,
    code: typeof code === "string" || typeof code === "number" ? String(code).slice(0, 32) : null,
  };
}

async function readCatalogResolverTuple(db: PgQueryable, itemId: string, itemStreamId: string) {
  const admin = await db.query(
    `SELECT catalog_item_id, status, blueprint_id, updated_at
       FROM catalog_admin_catalog_item_detail_pages
      WHERE catalog_item_id = $1`,
    [itemId],
  );
  const base = await db.query(
    `SELECT catalog_item_id, status, blueprint_id, updated_at FROM catalog_items WHERE catalog_item_id = $1`,
    [itemId],
  );
  const sourcePrefix = await db.query(
    `SELECT stream_version, event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version LIMIT 12`,
    [itemStreamId],
  );
  const checkpoints = await db.query(
    `SELECT checkpoint_key, last_global_position::text
       FROM event_subscription_checkpoints
      WHERE projection_name = ANY($1::text[])
      ORDER BY checkpoint_key`,
    [catalogItemProjectorNames],
  );
  return {
    admin: admin.rows[0] ?? null,
    base: base.rows[0] ?? null,
    sourcePrefix: sourcePrefix.rows,
    checkpoints: checkpoints.rows,
  };
}

// Prints one bounded [catalog-resolver-tuple] line for the seeded item: the resolver branch, its admin detail and base
// rows, the ordered source prefix and the item projection checkpoints. It prints ids, statuses, timestamps, event types
// and positions only. The assertions stay the verdict: a resolver failure is rethrown after printing, and a failed
// diagnostic read prints its exception class and code instead of failing the test.
async function printCatalogResolverTuple(
  db: PgQueryable,
  itemId: string,
  itemStreamId: string,
  resolution: Promise<Readonly<{ availability: string }>>,
): Promise<void> {
  const settled = await resolution.then(
    (resolved) => ({ resolver: { branch: resolved.availability } }),
    (error: unknown) => ({ resolver: { exception: exceptionClassAndCode(error) }, error }),
  );
  const tuple = await readCatalogResolverTuple(db, itemId, itemStreamId).catch((error: unknown) => ({
    diagnostic: { exception: exceptionClassAndCode(error) },
  }));
  console.info("[catalog-resolver-tuple]", JSON.stringify({ resolver: settled.resolver, ...tuple }));
  if ("error" in settled) throw settled.error;
}

describeDb("Catalog bootstrap pool ownership", () => {
  let pool: PgTransactionalPool;
  let catalogDatabaseUrl: string;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["catalog"] as const,
      "catalog_bootstrap_pool",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    catalogDatabaseUrl = databaseUrls.catalog;
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

  it("publishes a seeded Catalog Item through admin pages drained on a one-connection seed pool", async () => {
    // Seed commands own exactly one connection (createSeedCommandPools) and drain Catalog Item projections
    // locally; an admin page rebuild that needs a second checkout would poison the item stream.
    const seedPool = createPgPool(catalogDatabaseUrl, { max: 1, connectionTimeoutMillis: 500 });
    try {
      const services = createCatalogServices(createProjectionAwarePool(seedPool));
      const context = {
        tenantId: "tnt_seed_pool" as never,
        audit: { performedByUserId: "usr_seed_pool" as never, forAccountId: "acc_seed_pool" as never },
      };
      const blueprintStreamId = "catalog.blueprint-bpr_seed_pool";
      const templateStreamId = "catalog.display-template-dtp_seed_pool";
      const itemId = "cat_seed_pool";
      const itemStreamId = `catalog.item-${itemId}`;
      await services.blueprints.commandHandler({
        streamId: blueprintStreamId,
        command: {
          type: "CreateBlueprint",
          blueprintId: "bpr_seed_pool" as never,
          key: "seed-pool",
          name: localizedTextMapFromEnglish("Seed Pool"),
          description: localizedTextMapFromEnglish("One-connection seed pool"),
        },
        context,
      });
      await services.blueprints.commandHandler({
        streamId: blueprintStreamId,
        command: { type: "PublishBlueprint" },
        context,
      });
      await drainLocalProjectionHandlerSets("catalog", seedPool, services.blueprints.projectors);
      await services.displayTemplates.commandHandler({
        streamId: templateStreamId,
        command: {
          type: "CreateDisplayTemplate",
          displayTemplateId: "dtp_seed_pool" as never,
          key: "seed-pool",
          name: localizedTextMapFromEnglish("Seed Pool"),
          description: localizedTextMapFromEnglish("One-connection seed pool"),
          target: { kind: "blueprint", id: "bpr_seed_pool" },
          priority: 1,
          titleTemplate: "{item.title}",
          subtitleTemplate: null,
        },
        context,
      });
      await services.displayTemplates.commandHandler({
        streamId: templateStreamId,
        command: { type: "PublishDisplayTemplate" },
        context,
      });
      await drainLocalProjectionHandlerSets("catalog", seedPool, services.displayTemplates.projectors);
      await services.items.commandHandler({
        streamId: itemStreamId,
        command: {
          type: "CreateCatalogItem",
          itemId: itemId as never,
          title: localizedTextMapFromEnglish("Seed Pool Item"),
          subtitle: null,
          description: localizedTextMapFromEnglish(""),
        },
        context,
      });
      await services.items.commandHandler({
        streamId: itemStreamId,
        command: { type: "AssignBlueprintToCatalogItem", blueprintId: "bpr_seed_pool" as never },
        context,
      });
      await drainLocalProjectionHandlerSets("catalog", seedPool, services.items.projectors);
      await services.items.commandHandler({ streamId: itemStreamId, command: { type: "PublishCatalogItem" }, context });
      await drainLocalProjectionHandlerSets("catalog", seedPool, services.items.projectors);

      const resolution = resolveCatalogProductSelection(services.db, {
        catalogItemId: itemId as never,
        productId: `${itemId}::` as never,
        selectedOptions: [],
      });
      await printCatalogResolverTuple(services.db, itemId, itemStreamId, resolution);
      await expect(resolution).resolves.toMatchObject({ availability: "active", product: { catalogItemId: itemId } });
      const blockedStreams = await services.db.query<{ projection_key: string }>(
        `SELECT projection_key FROM event_projection_blocked_streams WHERE stream_id = $1`,
        [itemStreamId],
      );
      expect(blockedStreams.rows).toEqual([]);
    } finally {
      await (seedPool as unknown as { end: () => Promise<void> }).end();
    }
  });
});
