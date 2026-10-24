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
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createSavedListRuntime } from "../api/runtime";
import { createSavedListDiscoveryRuntime } from "../api/discovery-runtime";
import { savedListFingerprint } from "../api/anonymous-owner";
import type { SavedListProductSelection } from "../domain/contracts";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["collections"] as const;
const ownerAccountId = "acc_owner" as AccountId;
const anonymousProduct: SavedListProductSelection = {
  catalogItemId: "cat_guest" as never,
  productId: "cat_guest::condition:near-mint" as never,
  selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
};
const anonymousContext: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_owner" as never, forAccountId: ownerAccountId },
};

function anonymousDiscovery(db: PgQueryable) {
  const productCatalog = {
    resolveProduct: async (selection: SavedListProductSelection) => ({
      availability: "active" as const,
      product: selection,
    }),
  };
  const savedLists = createSavedListRuntime({ eventStore: createInMemoryEventStore().eventStore, productCatalog });
  return createSavedListDiscoveryRuntime({ db, savedLists, productCatalog });
}

async function insertLegacyIntent(db: PgQueryable, intentId: string, owner: string) {
  await db.query(
    `INSERT INTO collections_anonymous_saved_list_intents
    (intent_id, anonymous_owner_id, source_path, source_surface, catalog_catalog_item_id,
     product_id, selected_options, add_command_id, line_id, expires_at)
    VALUES ($1, $2, '/search', 'search', $3, $4, $5::jsonb, $6, $7, now() + interval '30 days')`,
    [
      intentId,
      owner,
      anonymousProduct.catalogItemId,
      anonymousProduct.productId,
      JSON.stringify(anonymousProduct.selectedOptions),
      `slc_${intentId}`,
      `sll_${intentId}`,
    ],
  );
}

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

  it("anonymous-owner-expand-migration fresh/upgrade/boot-twice preserves legacy identity (early-clear mutant)", async () => {
    const db = pools.collections;
    const shape = async () => {
      const columns = await db.query(`SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_name = 'collections_anonymous_saved_list_intents'
          AND column_name IN ('anonymous_owner_id', 'anonymous_owner_fingerprint', 'owner_revision')
        ORDER BY column_name`);
      const indexes = await db.query(`SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'collections_anonymous_saved_list_intents' ORDER BY indexname`);
      return { columns: columns.rows, indexes: indexes.rows };
    };
    const fresh = await shape();
    await db.query(collectionsModule.schemaSql);
    expect(await shape()).toEqual(fresh);
    await db.query(`ALTER TABLE collections_anonymous_saved_list_intents
      DROP COLUMN anonymous_owner_fingerprint, DROP COLUMN owner_revision`);
    await insertLegacyIntent(db, "sli_upgrade", "anon_upgrade");
    await bootstrapContextDatabase(collectionsModule, db);
    await bootstrapContextDatabase(collectionsModule, db);
    expect(await shape()).toEqual(fresh);
    const rows = await db.query(`SELECT anonymous_owner_id, anonymous_owner_fingerprint, owner_revision,
      intent_id, add_command_id, line_id FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_upgrade'`);
    expect(rows.rows).toEqual([
      {
        anonymous_owner_id: "anon_upgrade",
        anonymous_owner_fingerprint: null,
        owner_revision: 0,
        intent_id: "sli_upgrade",
        add_command_id: "slc_sli_upgrade",
        line_id: "sll_sli_upgrade",
      },
    ]);
    const ledger = await db.query(`SELECT migration_id FROM bounded_context_schema_migrations
      WHERE migration_id = '20261012_collections_anonymous_owner_fingerprint'`);
    expect(ledger.rows).toHaveLength(1);
    await db.query(`UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_id = NULL
      WHERE intent_id = 'sli_upgrade'`);
    expect(
      (
        await db.query(`SELECT anonymous_owner_id FROM collections_anonymous_saved_list_intents
      WHERE intent_id = 'sli_upgrade'`)
      ).rows,
    ).toEqual([{ anonymous_owner_id: null }]);
    await insertLegacyIntent(db, "sli_after_boot", "anon_upgrade");
    expect(
      (
        await db.query(`SELECT anonymous_owner_fingerprint FROM collections_anonymous_saved_list_intents
      WHERE intent_id = 'sli_after_boot'`)
      ).rows,
    ).toEqual([{ anonymous_owner_fingerprint: null }]);
  });

  it("anonymous-owner-mixed-version-compatibility old/new create, prepare and claim preserve raw reads and tokens", async () => {
    const db = pools.collections;
    const discovery = anonymousDiscovery(db);
    await insertLegacyIntent(db, "sli_legacy", "anon_legacy");
    const prepared = await discovery.prepareAnonymousClaim({
      anonymousOwnerId: "anon_legacy",
      intentId: "sli_legacy",
      accountId: ownerAccountId,
    });
    expect(prepared.intent).not.toHaveProperty("anonymousOwnerId");
    expect(prepared.tokens).toMatchObject({ addCommandId: "slc_sli_legacy", lineId: "sll_sli_legacy" });
    expect(JSON.stringify(prepared)).not.toContain("anon_legacy");
    const created = await discovery.createAnonymousIntent({
      anonymousOwnerId: "anon_new",
      sourcePath: "/search",
      sourceSurface: "search",
      product: anonymousProduct,
    });
    const oldRead = await db.query(
      `SELECT anonymous_owner_id, add_command_id, line_id FROM collections_anonymous_saved_list_intents
      WHERE intent_id = $1 AND anonymous_owner_id = $2`,
      [created.intentId, "anon_new"],
    );
    expect(oldRead.rows).toEqual([
      { anonymous_owner_id: "anon_new", add_command_id: created.addCommandId, line_id: created.lineId },
    ]);
    const destination = {
      kind: "new" as const,
      listId: "svl_guest" as never,
      createCommandId: "slc_guest" as never,
      title: " Guest List ",
    };
    // An old writer reserves the new row without knowing about owner_revision.
    await db.query(
      `UPDATE collections_anonymous_saved_list_intents SET status = 'claiming',
      claimed_account_id = $3, claimed_list_id = $4, claimed_create_command_id = $5,
      claimed_list_title = 'Guest List', claimed_tracked_quantity = 1
      WHERE intent_id = $1 AND anonymous_owner_id = $2 AND status = 'active'`,
      [created.intentId, "anon_new", ownerAccountId, destination.listId, destination.createCommandId],
    );
    const input = {
      anonymousOwnerId: "anon_new",
      intentId: created.intentId,
      accountId: ownerAccountId,
      destination,
      trackedQuantity: 1,
      sourceSurface: "search" as const,
    };
    const claimed = await discovery.claimAnonymousIntent(input, anonymousContext);
    expect(claimed.command.receipt.replayed).toBe(false);
    expect((await discovery.claimAnonymousIntent(input, anonymousContext)).command.receipt.replayed).toBe(true);
    expect(
      (
        await db.query(
          `SELECT status, anonymous_owner_id FROM collections_anonymous_saved_list_intents
      WHERE intent_id = $1 AND anonymous_owner_id = $2`,
          [created.intentId, "anon_new"],
        )
      ).rows,
    ).toEqual([{ status: "claimed", anonymous_owner_id: "anon_new" }]);
    await discovery.claimAnonymousIntent(
      {
        ...input,
        anonymousOwnerId: "anon_legacy",
        intentId: "sli_legacy",
        destination: { kind: "existing", listId: destination.listId },
      },
      anonymousContext,
    );
    expect(
      (
        await db.query(
          `SELECT anonymous_owner_id FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_legacy'`,
        )
      ).rows,
    ).toEqual([{ anonymous_owner_id: "anon_legacy" }]);
  });

  it("anonymous-owner-mixed-version-compatibility upgrade races and alternate-raw-reader mutant", async () => {
    const db = pools.collections;
    await insertLegacyIntent(db, "sli_race", "anon_race");
    let interleaved = false;
    const guarded: PgQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        if (!interleaved && sql.includes("SET anonymous_owner_fingerprint")) {
          interleaved = true;
          await db.query(
            `UPDATE collections_anonymous_saved_list_intents SET
          anonymous_owner_fingerprint = $1, owner_revision = owner_revision + 1, source_path = '/newer'
          WHERE intent_id = 'sli_race' AND owner_revision = 0`,
            [savedListFingerprint(["collections.anonymous-owner.v1", "anon_race"])],
          );
        }
        return db.query<Row>(sql, values);
      },
    };
    await anonymousDiscovery(guarded).prepareAnonymousClaim({
      anonymousOwnerId: "anon_race",
      intentId: "sli_race",
      accountId: ownerAccountId,
    });
    expect(
      (
        await db.query(`SELECT owner_revision, source_path, anonymous_owner_id FROM collections_anonymous_saved_list_intents
      WHERE intent_id = 'sli_race'`)
      ).rows,
    ).toEqual([{ owner_revision: 1, source_path: "/newer", anonymous_owner_id: "anon_race" }]);
    await insertLegacyIntent(db, "sli_old_race", "anon_old_race");
    let oldInterleaved = false;
    const oldGuarded: PgQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        if (!oldInterleaved && sql.includes("SET anonymous_owner_fingerprint")) {
          oldInterleaved = true;
          await db.query(
            `UPDATE collections_anonymous_saved_list_intents SET status = 'claiming', claimed_account_id = $1
          WHERE intent_id = 'sli_old_race' AND anonymous_owner_id = 'anon_old_race' AND status = 'active'`,
            [ownerAccountId],
          );
        }
        return db.query<Row>(sql, values);
      },
    };
    await anonymousDiscovery(oldGuarded).prepareAnonymousClaim({
      anonymousOwnerId: "anon_old_race",
      intentId: "sli_old_race",
      accountId: ownerAccountId,
    });
    expect(
      (
        await db.query(`SELECT status, owner_revision, anonymous_owner_id FROM collections_anonymous_saved_list_intents
      WHERE intent_id = 'sli_old_race'`)
      ).rows,
    ).toEqual([{ status: "claiming", owner_revision: 1, anonymous_owner_id: "anon_old_race" }]);
    await db.query(
      `UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_fingerprint = $1
      WHERE intent_id = 'sli_race'`,
      [savedListFingerprint(["collections.anonymous-owner.v1", "anon_other"])],
    );
    await expect(
      anonymousDiscovery(db).prepareAnonymousClaim({
        anonymousOwnerId: "anon_race",
        intentId: "sli_race",
        accountId: ownerAccountId,
      }),
    ).rejects.toMatchObject({ code: "intent-not-found" });
  });

  it("anonymous-owner-mixed-version-compatibility reuses differently ordered legacy Options", async () => {
    const db = pools.collections;
    await insertLegacyIntent(db, "sli_options", "anon_options");
    const options = [
      { dimensionId: "B", optionId: "b" },
      { dimensionId: "a", optionId: "a" },
    ];
    await db.query(
      `UPDATE collections_anonymous_saved_list_intents SET selected_options = $1::jsonb
      WHERE intent_id = 'sli_options'`,
      [JSON.stringify([...options].reverse())],
    );
    const captured = await anonymousDiscovery(db).createAnonymousIntent({
      anonymousOwnerId: "anon_options",
      sourcePath: "/search",
      sourceSurface: "search",
      product: { ...anonymousProduct, selectedOptions: options },
    });
    expect(captured.intentId).toBe("sli_options");
    expect(captured.addCommandId).toBe("slc_sli_options");
    expect(captured.lineId).toBe("sll_sli_options");
  });

  it.each([{ writer: "old" }, { writer: "new" }, { writer: "same-owner refresh" }])(
    "anonymous-owner-mixed-version-compatibility handles a $writer interleaving during refresh",
    async ({ writer }) => {
      const db = pools.collections;
      await insertLegacyIntent(db, "sli_refresh", "anon_refresh");
      let interleaved = false;
      const guarded: PgQueryable = {
        query: async <Row>(sql: string, values?: readonly unknown[]) => {
          if (!interleaved && sql.includes("SET source_path")) {
            interleaved = true;
            if (writer === "same-owner refresh") {
              await db.query(
                `UPDATE collections_anonymous_saved_list_intents
                 SET owner_revision = owner_revision + 1, source_path = '/newer'
                 WHERE intent_id = 'sli_refresh' AND status = 'active'`,
              );
            } else {
              await db.query(
                `UPDATE collections_anonymous_saved_list_intents SET status = 'claiming',
          claimed_account_id = $1, source_path = '/newer',
          owner_revision = owner_revision + $2
          WHERE intent_id = 'sli_refresh' AND status = 'active'`,
                [ownerAccountId, writer === "new" ? 1 : 0],
              );
            }
          }
          return db.query<Row>(sql, values);
        },
      };
      const capture = anonymousDiscovery(guarded).createAnonymousIntent({
        anonymousOwnerId: "anon_refresh",
        sourcePath: "/stale",
        sourceSurface: "search",
        product: anonymousProduct,
      });
      if (writer === "same-owner refresh") {
        await expect(capture).resolves.toMatchObject({
          intentId: "sli_refresh",
          addCommandId: "slc_sli_refresh",
          lineId: "sll_sli_refresh",
        });
      } else {
        await expect(capture).rejects.toMatchObject({ code: "intent-already-claimed" });
      }
      expect(
        (
          await db.query(`SELECT status, source_path, owner_revision, anonymous_owner_id FROM collections_anonymous_saved_list_intents
      WHERE intent_id = 'sli_refresh'`)
        ).rows,
      ).toEqual([
        {
          status: writer === "same-owner refresh" ? "active" : "claiming",
          source_path: "/newer",
          owner_revision: writer === "old" ? 1 : 2,
          anonymous_owner_id: "anon_refresh",
        },
      ]);
    },
  );

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
       $4::bigint,
       $4::bigint,
       1
     )`,
    [id, ownerAccountId, `List ${value}`, value],
  );
}
