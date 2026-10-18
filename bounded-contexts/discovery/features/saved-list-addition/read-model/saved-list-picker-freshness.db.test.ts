import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { attachWriteConsistencyMiddleware } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createSavedListRuntime } from "../../../../collections/features/saved-lists/api/runtime";
import { createSavedListDiscoveryRuntime } from "../../../../collections/features/saved-lists/api/discovery-runtime";
import { createSavedListRoutes } from "../../../../collections/features/saved-lists/api/route";
import type { SavedListProductSelection } from "../../../../collections/features/saved-lists/domain/contracts";
import { buildDiscoverySavedListPickerProjectionHandlers } from "../integrations/collections/projection";
import type { CollectionsApiEnv } from "../../../../collections/api";
import { module as collectionsModule } from "@chase-sets/collections";
import { module as discoveryModule } from "../../../index";
import { listDiscoveryRecentSavedLists } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("Discovery Saved List picker freshness read model", () => {
  let pools: Readonly<Record<"collections" | "discovery", PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["collections", "discovery"],
      "saved_list_freshness",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(collectionsModule, pools.collections);
    await bootstrapContextDatabase(discoveryModule, pools.discovery);
  }, 120_000);

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("reads the newly projected active List with its title, counts, and version while excluding archived rows", async () => {
    const productCatalog = {
      resolveProduct: async (selection: SavedListProductSelection) => ({
        availability: "active" as const,
        product: selection,
      }),
    };
    const savedLists = createSavedListRuntime({
      eventStore: createPostgresEventStore({ pool: pools.collections }),
      productCatalog,
      clock: () => "2026-10-16T00:00:00.000Z",
    });
    const discovery = createSavedListDiscoveryRuntime({
      db: pools.discovery,
      savedLists,
      productCatalog,
      clock: () => new Date("2026-10-16T00:00:00.000Z"),
    });
    const app = new Hono<CollectionsApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: "acc_picker", permissions: ["accounts.view"] });
      c.set("context", {
        tenantId: "tnt_picker",
        audit: { performedByUserId: "usr_picker", forAccountId: "acc_picker" },
      } as CollectionsApiEnv["Variables"]["context"]);
      await next();
    });
    attachWriteConsistencyMiddleware(app, [{ mountPath: "/account" }], [], { enabled: false });
    app.route("/", createSavedListRoutes(discovery as never));
    const commandResponse = await app.request("/account/list-additions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destination: { kind: "new", listId: "svl_new", createCommandId: "slc_new", title: "New Favorites" },
        addCommandId: "slc_add",
        lineId: "sll_new",
        product: {
          catalogItemId: "cat_new",
          productId: "cat_new::condition:near-mint",
          selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        },
        trackedQuantity: 2,
        sourceSurface: "search",
      }),
    });
    expect(commandResponse.status).toBe(200);
    expect(commandResponse.headers.get("Chase-Sets-Commit-Receipt")).toContain("collections");
    const events = await pools.collections.query<{
      event_id: string;
      stream_id: string;
      stream_version: number;
      event_type: string;
      payload: unknown;
      occurred_at: string;
    }>(
      "SELECT event_id, stream_id, stream_version, event_type, payload, occurred_at FROM event_store_events ORDER BY global_position",
    );
    const handlers = buildDiscoverySavedListPickerProjectionHandlers(pools.discovery);
    for (const event of events.rows) {
      const handler = handlers[event.event_type];
      if (handler) {
        await handler({
          eventId: event.event_id,
          streamId: event.stream_id,
          streamVersion: event.stream_version,
          eventType: event.event_type,
          data: event.payload,
          timing: { recordedAt: event.occurred_at },
        } as never);
      }
    }
    await pools.discovery.query(
      `INSERT INTO discovery_saved_list_picker
         (list_id, owner_account_id, title, lifecycle, line_count, tracked_unit_count, line_quantities, list_version, created_at, changed_at)
       VALUES
         ('svl_archived', 'acc_picker', 'Old Favorites', 'archived', 4, 4, '{}', 4, '2026-10-15T00:00:00Z', '2026-10-15T00:01:00Z')`,
    );

    await expect(listDiscoveryRecentSavedLists(pools.discovery, { ownerAccountId: "acc_picker" })).resolves.toEqual([
      {
        listId: "svl_new",
        title: "New Favorites",
        lineCount: 1,
        trackedUnitCount: 2,
        version: 2,
        changedAt: "2026-10-16T00:00:00.000Z",
      },
    ]);
  });
});
