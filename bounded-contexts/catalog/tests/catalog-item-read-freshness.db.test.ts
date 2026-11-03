import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  attachReadConsistencyMiddleware,
  bootstrapContextDatabase,
  drainContextProcesses,
  mountApiRouters,
  resolveModuleApiMounts,
  resolveModuleSubscriptions,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../index";
import { type CatalogAuthoringEnv } from "../support/authoring-support/api";
import type { CatalogServices } from "../support/authoring-support";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, encodeFreshWriteReceipt } from "@chase-sets/http/responses";

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
  let projectionGroups: ReturnType<typeof createMountedContextTestRuntime>["projectionGroups"];

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "catalog_item_read_freshness");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    const runtime = createMountedContextTestRuntime([
      { contextName: "catalog", module: catalogModule, pool, ports: {} },
    ]);
    services = runtime.services.catalog as CatalogServices;
    subscriptionRunners = runtime.subscriptionRunners;
    projectionGroups = runtime.projectionGroups;
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
      command: { type: "SetCatalogItemImageUrls", imageUrls: ["https://assets.example/old-image.webp"] },
      context,
    });
    await drainContextProcesses({ subscriptionRunners });

    await services.items.commandHandler({
      streamId,
      expectedVersion: 2,
      command: { type: "SetCatalogItemImageUrls", imageUrls: ["https://assets.example/fresh-image.webp"] },
      context,
    });
    const stored = await eventStore.readStream({ streamId, fromVersion: 3, limit: 1 });
    const committedEvent = stored[0];
    expect(committedEvent).toBeDefined();

    const mounts = resolveModuleApiMounts(catalogModule, services);
    const audits: unknown[] = [];
    const app = new Hono<CatalogAuthoringEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { permissions: ["catalog.view", "catalog.manage"] });
      c.set("context", context);
      await next();
    });
    attachReadConsistencyMiddleware(app, mounts, projectionGroups, {
      timeoutMs: 0,
      pollIntervalMs: 1,
      recordReadConsistencyAudit: (audit) => audits.push(audit),
    });
    mountApiRouters(app, mounts);
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [
        {
          sourceContextName: "catalog",
          maxGlobalPosition: String(committedEvent!.globalPosition),
          eventIds: [committedEvent!.eventId],
        },
      ],
    });
    const read = () =>
      app.request(`http://catalog.test/api/catalog/items/${itemId}`, {
        headers: { [CHASE_SETS_READ_AFTER_WRITE_HEADER]: receipt },
      });

    const beforeDrain = await read();
    expect(beforeDrain.status).toBe(503);
    expect(await beforeDrain.json()).toMatchObject({ error: { code: "projection_freshness_timeout" } });
    expect(await services.items.getCatalogItemDetail(itemId)).toMatchObject({
      image_urls: ["https://assets.example/old-image.webp"],
    });

    const detailRoute = mounts
      .find((mount) => mount.mountPath === "/api/catalog")
      ?.readFreshnessRoutes?.find((route) => route.routePath === "/items/:id");
    expect(detailRoute).toBeDefined();
    const detailProjectionNames = new Set(
      detailRoute!.dependencies.flatMap((dependency) =>
        "projectionName" in dependency
          ? [dependency.projectionName]
          : projectionGroups
              .filter((group) => group.ownedTables?.includes(dependency.readModelTable))
              .map((group) => group.projectionName),
      ),
    );
    await drainContextProcesses({
      subscriptionRunners: projectionGroups
        .filter((group) => detailProjectionNames.has(group.projectionName))
        .flatMap((group) => group.subscriptionRunners),
    });

    const afterDrain = await read();
    expect(afterDrain.status).toBe(200);
    expect(await afterDrain.json()).toMatchObject({ image_urls: ["https://assets.example/fresh-image.webp"] });
    expect(audits.at(-1)).toMatchObject({ outcome: "fresh", waitMode: "exact-dependency" });
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
