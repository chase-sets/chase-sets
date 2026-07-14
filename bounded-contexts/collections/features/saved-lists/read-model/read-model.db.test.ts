import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { module as collectionsModule } from "../../../index";
import { buildSavedListCatalogProjectionHandlers } from "../integrations/catalog/projection";
import { buildSavedListProjectionHandlers } from "./projection";
import { listSavedListSummaries, loadSavedListDetail } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["collections"] as const;
const ownerAccountId = "acc_owner" as AccountId;

let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

describeDb("Saved List read-model SQL boundary", () => {
  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "saved_list_read_models");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.collections.query(collectionsModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("converges to the same enriched summary and line order when Catalog and Saved List replay order reverses", async () => {
    const db = pools.collections;
    const savedListHandlers = buildSavedListProjectionHandlers(db);
    const catalogHandlers = buildSavedListCatalogProjectionHandlers(db);
    const savedListEvents = buildSavedListEvents();
    const catalogEvents = buildCatalogEvents();

    await replay(savedListHandlers, savedListEvents);
    await replay(catalogHandlers, catalogEvents);
    const savedListFirst = await loadSavedListDetail(db, { ownerAccountId, listId: "svl_1" as never });

    await db.query(`TRUNCATE TABLE
      collections_saved_list_lines,
      collections_saved_list_summaries,
      collections_catalog_dimension_options,
      collections_catalog_dimensions,
      collections_catalog_blueprints,
      collections_catalog_items`);

    await replay(catalogHandlers, catalogEvents);
    await replay(savedListHandlers, savedListEvents);
    const catalogFirst = await loadSavedListDetail(db, { ownerAccountId, listId: "svl_1" as never });

    expect(catalogFirst).toEqual(savedListFirst);
    expect(catalogFirst).toMatchObject({
      lineCount: 2,
      trackedUnitCount: 5,
      version: 5,
      lines: [
        { lineId: "sll_2", position: 0, trackedQuantity: 4, catalog: { title: "Black Lotus" } },
        { lineId: "sll_1", position: 1, trackedQuantity: 1, catalog: { title: "Black Lotus" } },
      ],
    });
  });

  it("keeps a many-List keyset traversal duplicate-free with a stable total during a concurrent create", async () => {
    const db = pools.collections;
    await insertSummaries(db, 250);

    const observed: string[] = [];
    let cursor: string | null = null;
    let expectedTotal = 0;
    do {
      const page = await listSavedListSummaries(db, { ownerAccountId, limit: 37, cursor });
      expectedTotal ||= page.total;
      expect(page.total).toBe(expectedTotal);
      observed.push(...page.items.map((item) => item.listId));
      cursor = page.nextCursor;

      if (observed.length === 37) {
        await insertSummary(db, 251);
      }
    } while (cursor);

    expect(expectedTotal).toBe(250);
    expect(observed).toHaveLength(250);
    expect(new Set(observed).size).toBe(250);
    expect(observed).not.toContain("svl_0251");
  });

  it("loads a 10k-line Saved List in deterministic position order", async () => {
    const db = pools.collections;
    await insertSummary(db, 1);
    await db.query(
      `INSERT INTO collections_saved_list_lines (
           line_id,
           list_id,
           catalog_item_id,
           product_id,
           selected_options,
           tracked_quantity,
           private_notes,
           private_tags,
           position,
           added_at,
           changed_at,
           last_stream_version
         )
         SELECT
           'sll_' || LPAD(value::text, 5, '0'),
           'svl_0001',
           'cat_' || value,
           'cat_' || value || '::default',
           '[]'::jsonb,
           1,
           NULL,
           '[]'::jsonb,
           value - 1,
           '2026-07-13T00:00:00.000Z'::timestamptz,
           '2026-07-13T00:00:00.000Z'::timestamptz,
           2
         FROM generate_series(1, 10000) AS value`,
    );
    await db.query(
      `UPDATE collections_saved_list_summaries
         SET line_count = 10000,
             tracked_unit_count = 10000,
             last_stream_version = 2
         WHERE list_id = 'svl_0001'`,
    );

    const detail = await loadSavedListDetail(db, { ownerAccountId, listId: "svl_0001" as never });

    expect(detail?.lines).toHaveLength(10_000);
    expect(detail?.lines[0]).toMatchObject({ lineId: "sll_00001", position: 0 });
    expect(detail?.lines.at(-1)).toMatchObject({ lineId: "sll_10000", position: 9_999 });
  }, 30_000);
});

async function replay(
  handlers: Record<string, ((event: TransportEvent) => Promise<void>) | undefined>,
  events: readonly TransportEvent[],
) {
  for (const event of events) {
    await handlers[event.type]?.(event);
  }
}

function buildSavedListEvents(): TransportEvent[] {
  return [
    savedListEvent(
      "collections.saved-list.created",
      {
        eventSchemaVersion: 1,
        commandId: "slc_1",
        listId: "svl_1",
        ownerAccountId,
        title: "Trade targets",
        description: null,
        visibility: "private",
        createdAt: "2026-07-13T00:00:00.000Z",
      },
      1,
    ),
    savedListEvent(
      "collections.saved-list.line-added",
      {
        eventSchemaVersion: 1,
        commandId: "slc_2",
        listId: "svl_1",
        lineId: "sll_1",
        product: { catalogItemId: "cat_1", productId: "cat_1::finish=regular", selectedOptions: [] },
        trackedQuantity: 1,
        privateNotes: null,
        privateTags: [],
        addedAt: "2026-07-13T00:01:00.000Z",
      },
      2,
    ),
    savedListEvent(
      "collections.saved-list.line-added",
      {
        eventSchemaVersion: 1,
        commandId: "slc_3",
        listId: "svl_1",
        lineId: "sll_2",
        product: { catalogItemId: "cat_1", productId: "cat_1::finish=foil", selectedOptions: [] },
        trackedQuantity: 2,
        privateNotes: null,
        privateTags: [],
        addedAt: "2026-07-13T00:02:00.000Z",
      },
      3,
    ),
    savedListEvent(
      "collections.saved-list.line-reordered",
      {
        eventSchemaVersion: 1,
        commandId: "slc_4",
        listId: "svl_1",
        lineId: "sll_2",
        afterLineId: null,
        changedAt: "2026-07-13T00:03:00.000Z",
      },
      4,
    ),
    savedListEvent(
      "collections.saved-list.line-changed",
      {
        eventSchemaVersion: 1,
        commandId: "slc_5",
        listId: "svl_1",
        lineId: "sll_2",
        trackedQuantity: 4,
        privateNotes: null,
        privateTags: [],
        changedAt: "2026-07-13T00:04:00.000Z",
        changeKind: "changed",
      },
      5,
    ),
  ];
}

function buildCatalogEvents(): TransportEvent[] {
  return [
    catalogEvent(
      "catalog.catalog-item.created",
      { itemId: "cat_1", languageCode: "en", title: "Temporary title", subtitle: null },
      1,
    ),
    catalogEvent("catalog.catalog-item.published", {}, 2),
    catalogEvent(
      "catalog.catalog-item.display-identity-resolved",
      { catalogItemId: "cat_1", languageCode: "en", title: "Black Lotus", subtitle: "Limited Edition Alpha" },
      3,
    ),
  ];
}

function savedListEvent(type: string, data: Record<string, unknown>, streamVersion: number) {
  return buildTransportEvent(type, data, {
    id: `evt_saved_${streamVersion}`,
    streamId: "collections.saved-list-svl_1",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: ownerAccountId },
    timing: { occurredAt: "2026-07-13T00:00:00.000Z", recordedAt: "2026-07-13T00:00:00.000Z" },
  });
}

function catalogEvent(type: string, data: Record<string, unknown>, streamVersion: number) {
  return buildTransportEvent(type, data, {
    id: `evt_catalog_${streamVersion}`,
    streamId: "catalog.item-cat_1",
    streamVersion,
    globalPosition: String(100 + streamVersion),
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: ownerAccountId },
    timing: { occurredAt: "2026-07-13T00:00:00.000Z", recordedAt: "2026-07-13T00:00:00.000Z" },
  });
}

async function insertSummaries(db: PgTransactionalPool, count: number) {
  for (let value = 1; value <= count; value += 1) {
    await insertSummary(db, value);
  }
}

async function insertSummary(db: PgTransactionalPool, value: number) {
  const id = `svl_${String(value).padStart(4, "0")}`;
  await db.query(
    `INSERT INTO collections_saved_list_summaries (
       list_id,
       owner_account_id,
       title,
       description,
       visibility,
       lifecycle,
       line_count,
       tracked_unit_count,
       created_at,
       changed_at,
       created_global_position,
       last_global_position,
       last_stream_version
     ) VALUES (
       $1,
       $2,
       $3,
       NULL,
       'private',
       'active',
       0,
       0,
       '2026-07-13T00:00:00.000Z'::timestamptz + ($4::text || ' seconds')::interval,
       '2026-07-13T00:00:00.000Z'::timestamptz + ($4::text || ' seconds')::interval,
       $4,
       $4,
       1
     )`,
    [id, ownerAccountId, `List ${value}`, value],
  );
}
