import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapContextDatabase,
  drainContextProcesses,
  resolveModuleSubscriptions,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../index";
import { createCatalogServices, type CatalogServices } from "../support/authoring-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["catalog"] as const;
const context: EventStoreContext = {
  tenantId: "tnt_read_freshness" as never,
  audit: { performedByUserId: "usr_read_freshness" as never, forAccountId: "acc_read_freshness" as never },
};

describeDb("Catalog item read freshness DB proof", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  let subscriptionRunners: ReturnType<typeof resolveModuleSubscriptions>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "catalog_item_read_freshness");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    services = createCatalogServices(pool);
    subscriptionRunners = resolveModuleSubscriptions([
      {
        contextName: "catalog",
        module: catalogModule,
        services,
        pool,
        projectionHandlerSets: catalogModule.projectionHandlerSets?.(services) ?? [],
      },
    ]);
  });

  afterAll(async () => {
    await closeMultiContextTestPools({ catalog: pool });
  });

  it("catalog image URL read follows committed application", async () => {
    const itemId = "cat_read_freshness";
    const streamId = `catalog.item-${itemId}`;
    const eventStore = createPostgresEventStore({ pool });

    await services.items.commandHandler({
      streamId,
      command: {
        type: "CreateCatalogItem",
        itemId,
        languageCode: "en",
        title: { defaultLocale: "en", values: { en: "Fresh image" } },
        subtitle: null,
        description: { defaultLocale: "en", values: { en: "Fresh image description" } },
      },
      context,
    });
    await drainContextProcesses({ subscriptionRunners });

    await services.items.commandHandler({
      streamId,
      expectedVersion: 1,
      command: { type: "SetCatalogItemImageUrls", imageUrls: ["https://assets.example/fresh-image.webp"] },
      context,
    });
    const stored = await eventStore.readStream({ streamId, fromVersion: 2, limit: 1 });
    const committedEvent = stored[0];
    expect(committedEvent).toBeDefined();

    await drainContextProcesses({ subscriptionRunners });

    const detail = await services.items.getCatalogItemDetail(itemId);
    expect(detail?.image_urls).toEqual(["https://assets.example/fresh-image.webp"]);
    const applications = await pool.query<{ status: string }>(
      `SELECT status
       FROM event_subscription_applications
       WHERE event_id = $1
       ORDER BY updated_at DESC`,
      [committedEvent!.eventId],
    );
    expect(applications.rows.length).toBeGreaterThan(0);
    expect(applications.rows.every((row) => row.status === "applied")).toBe(true);
  });
});
