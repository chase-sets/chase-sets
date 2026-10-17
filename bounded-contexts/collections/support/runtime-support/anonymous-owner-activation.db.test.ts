import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as collectionsModule } from "../../index";
import { activateAnonymousOwnerCutover, anonymousOwnerActivationSchemaSql } from "./anonymous-owner-activation";
import { createSavedListDiscoveryRuntime } from "../../features/saved-lists/api/discovery-runtime";
import { createSavedListRuntime } from "../../features/saved-lists/api/runtime";
import { savedListFingerprint } from "../../features/saved-lists/api/anonymous-owner";
import type { SavedListProductSelection } from "../../features/saved-lists/domain/contracts";
import { collectionsRetentionSweeps } from "./retention-policy";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for anonymous-owner activation DB proof.");
const describeDb = baseUrl ? describe : describe.skip;
let pool: PgTransactionalPool;
const activationInput = { gatePacketSha256: "a".repeat(64), floorCommit: "54c9898f45e14e616230e584d5a4ec078ceb1a03" };
const product: SavedListProductSelection = {
  catalogItemId: "cat_fence" as never,
  productId: "cat_fence::condition:near-mint" as never,
  selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
};
const rawInsert = `INSERT INTO collections_anonymous_saved_list_intents
  (intent_id, anonymous_owner_id, source_path, source_surface, catalog_catalog_item_id, product_id,
   selected_options, add_command_id, line_id, expires_at)
  VALUES ($1, $2, '/search', 'search', 'cat_fence', 'cat_fence::condition:near-mint',
   '[{"dimensionId":"condition","optionId":"near-mint"}]'::jsonb,
   'slc_fence', 'sll_fence', now() + interval '30 days')`;
const dualInsert = `INSERT INTO collections_anonymous_saved_list_intents (
  intent_id, anonymous_owner_fingerprint, source_path, source_surface,
  catalog_catalog_item_id, product_id, selected_options, product_summary,
  add_command_id, line_id, expires_at, anonymous_owner_id
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`;

function discovery(transactionPool = pool) {
  const productCatalog = {
    resolveProduct: async (selection: SavedListProductSelection) => ({
      availability: "active" as const,
      product: selection,
    }),
  };
  return createSavedListDiscoveryRuntime({
    db: pool,
    pool: transactionPool,
    productCatalog,
    savedLists: createSavedListRuntime({ eventStore: createInMemoryEventStore().eventStore, productCatalog }),
  });
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describeDb("anonymous owner activation", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, ["collections"], "anonymous_owner_activation");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pool = createMultiContextTestPools(urls).collections;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ collections: pool });
    await bootstrapContextDatabase(collectionsModule, pool);
  });
  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ collections: pool });
  });

  it("anonymous-owner-activation-schema-parity", async () => {
    const shape = async () => ({
      columns: (
        await pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public'
        AND table_name IN ('collections_anonymous_saved_list_intents', 'collections_anonymous_owner_activation')
        ORDER BY table_name, ordinal_position`)
      ).rows,
      activation: (await pool.query("SELECT * FROM collections_anonymous_owner_activation")).rows,
      trigger: (
        await pool.query(`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgname = 'collections_anonymous_owner_raw_fence'`)
      ).rows,
      function: (
        await pool.query(`SELECT pg_get_functiondef(oid) AS definition FROM pg_proc
        WHERE proname = 'collections_anonymous_owner_raw_fence'`)
      ).rows,
    });
    const fresh = await shape();
    expect(fresh.columns).toContainEqual(
      expect.objectContaining({ column_name: "anonymous_owner_id", is_nullable: "YES" }),
    );
    expect(fresh.activation).toEqual([
      { singleton: true, activated_at: null, gate_packet_sha256: null, floor_commit: null },
    ]);
    expect(fresh.trigger).toHaveLength(1);
    expect(fresh.function).toHaveLength(1);
    await bootstrapContextDatabase(collectionsModule, pool);
    await bootstrapContextDatabase(collectionsModule, pool);
    expect(await shape()).toEqual(fresh);
    // Reconstruct the shipped #9471/#9507 shape and its already-applied ledger.
    await pool.query(`DROP TRIGGER collections_anonymous_owner_raw_fence ON collections_anonymous_saved_list_intents;
      DROP FUNCTION collections_anonymous_owner_raw_fence();
      DROP TABLE collections_anonymous_owner_activation;
      ALTER TABLE collections_anonymous_saved_list_intents ALTER COLUMN anonymous_owner_id SET NOT NULL;
      DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20261016_collections_anonymous_owner_activation'`);
    await pool.query(rawInsert, ["sli_upgrade", "anon_upgrade"]);
    await bootstrapContextDatabase(collectionsModule, pool);
    await bootstrapContextDatabase(collectionsModule, pool);
    expect(await shape()).toEqual(fresh);
    expect(
      (
        await pool.query(`SELECT anonymous_owner_id, anonymous_owner_fingerprint, owner_revision
      FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_upgrade'`)
      ).rows,
    ).toEqual([{ anonymous_owner_id: "anon_upgrade", anonymous_owner_fingerprint: null, owner_revision: 0 }]);
  });

  it("anonymous-owner-activation-one-way", async () => {
    const [first, concurrent] = await Promise.all([
      activateAnonymousOwnerCutover(pool, activationInput),
      activateAnonymousOwnerCutover(pool, { gatePacketSha256: "b".repeat(64), floorCommit: "concurrent-floor" }),
    ]);
    const second = await activateAnonymousOwnerCutover(pool, {
      gatePacketSha256: "c".repeat(64),
      floorCommit: "different",
    });
    await bootstrapContextDatabase(collectionsModule, pool);
    expect(first.activated_at).toBeTruthy();
    expect(concurrent).toEqual(first);
    expect(second).toEqual(first);
    expect(
      (
        await pool.query(
          "SELECT activated_at::text AS activated_at, gate_packet_sha256, floor_commit FROM collections_anonymous_owner_activation",
        )
      ).rows,
    ).toEqual([
      {
        activated_at: first.activated_at,
        gate_packet_sha256: first.gate_packet_sha256,
        floor_commit: first.floor_commit,
      },
    ]);
  });

  it.each(["insert", "resolve"])("anonymous-owner-activation-interleaving %s", async (operation) => {
    const held = barrier();
    const proceed = barrier();
    let sharedReads = 0;
    let writerPid = 0;
    const transactionPool: PgTransactionalPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(sql, values);
            if (
              sql.includes("FROM collections_anonymous_owner_activation") &&
              sql.includes("FOR SHARE") &&
              ++sharedReads === (operation === "insert" ? 2 : 1)
            ) {
              writerPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
              held.release();
              await proceed.promise;
            }
            return result;
          },
        };
      },
    };
    await pool.query(rawInsert, ["sli_interleaving", "anon_interleaving"]);
    const service = discovery(transactionPool);
    const writing =
      operation === "insert"
        ? service.createAnonymousIntent({
            anonymousOwnerId: "anon_new",
            sourcePath: "/search",
            sourceSurface: "search",
            product,
          })
        : service.prepareAnonymousClaim({
            anonymousOwnerId: "anon_interleaving",
            intentId: "sli_interleaving",
            accountId: "acc_fence" as never,
          });
    let activating: ReturnType<typeof activateAnonymousOwnerCutover> | undefined;
    try {
      await held.promise;
      activating = activateAnonymousOwnerCutover(pool, activationInput);
      await vi.waitFor(async () => {
        const blocked = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE $1::integer = ANY(pg_blocking_pids(pid)) AND query LIKE '%FOR UPDATE%'`,
          [writerPid],
        );
        expect(Number(blocked.rows[0].count)).toBeGreaterThan(0);
      });
    } finally {
      proceed.release();
      await Promise.all([writing, activating]);
    }
    const inserted = await writing;
    const id = "intentId" in inserted ? inserted.intentId : inserted.intent.intentId;
    const before = (
      await pool.query(`SELECT anonymous_owner_id FROM collections_anonymous_saved_list_intents WHERE intent_id = $1`, [
        id,
      ])
    ).rows[0];
    expect(before.anonymous_owner_id).toBe(operation === "insert" ? "anon_new" : "anon_interleaving");
    const active = discovery();
    const created = await active.createAnonymousIntent({
      anonymousOwnerId: "anon_active",
      sourcePath: "/search",
      sourceSurface: "search",
      product,
    });
    expect(
      (
        await pool.query(
          "SELECT anonymous_owner_id FROM collections_anonymous_saved_list_intents WHERE intent_id = $1",
          [created.intentId],
        )
      ).rows,
    ).toEqual([{ anonymous_owner_id: null }]);
    await active.prepareAnonymousClaim({
      anonymousOwnerId: "anon_interleaving",
      intentId: "sli_interleaving",
      accountId: "acc_fence" as never,
    });
    const legacy = (
      await pool.query(`SELECT anonymous_owner_id, anonymous_owner_fingerprint, owner_revision
      FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_interleaving'`)
    ).rows[0];
    expect(legacy).toEqual({
      anonymous_owner_id: operation === "resolve" ? "anon_interleaving" : null,
      anonymous_owner_fingerprint: savedListFingerprint(["collections.anonymous-owner.v1", "anon_interleaving"]),
      owner_revision: 1,
    });
  });

  it("anonymous-owner-activation-interleaving active upgrade preserves a newer revision", async () => {
    await pool.query(rawInsert, ["sli_revision", "anon_revision"]);
    await activateAnonymousOwnerCutover(pool, activationInput);
    let changed = false;
    const guarded: PgTransactionalPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            if (!changed && sql.includes("SET anonymous_owner_fingerprint")) {
              changed = true;
              await pool.query(`UPDATE collections_anonymous_saved_list_intents
                SET owner_revision = owner_revision + 1, source_path = '/newer' WHERE intent_id = 'sli_revision'`);
            }
            return client.query<Row>(sql, values);
          },
        };
      },
    };
    const input = { anonymousOwnerId: "anon_revision", intentId: "sli_revision", accountId: "acc_fence" as never };
    await expect(discovery(guarded).prepareAnonymousClaim(input)).rejects.toMatchObject({ code: "intent-not-found" });
    expect(changed).toBe(true);
    expect(
      (
        await pool.query(`SELECT anonymous_owner_id, anonymous_owner_fingerprint, owner_revision, source_path
      FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_revision'`)
      ).rows,
    ).toEqual([
      {
        anonymous_owner_id: "anon_revision",
        anonymous_owner_fingerprint: null,
        owner_revision: 1,
        source_path: "/newer",
      },
    ]);
    await discovery().prepareAnonymousClaim(input);
    expect(
      (
        await pool.query(`SELECT anonymous_owner_id, anonymous_owner_fingerprint, owner_revision, source_path
      FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_revision'`)
      ).rows,
    ).toEqual([
      {
        anonymous_owner_id: null,
        anonymous_owner_fingerprint: savedListFingerprint(["collections.anonymous-owner.v1", "anon_revision"]),
        owner_revision: 2,
        source_path: "/newer",
      },
    ]);
  });

  it.each([false, true])("legacy claim, expire and purge remain operable with activation %s", async (active) => {
    const service = discovery();
    const intent = await service.createAnonymousIntent({
      anonymousOwnerId: "anon_legacy",
      sourcePath: "/search",
      sourceSurface: "search",
      product,
    });
    await pool.query(rawInsert, ["sli_expire", "anon_expire"]);
    await pool.query(`UPDATE collections_anonymous_saved_list_intents SET expires_at = now() - interval '61 days'
      WHERE intent_id = 'sli_expire'`);
    if (active) await activateAnonymousOwnerCutover(pool, activationInput);
    const context = {
      tenantId: "tnt_fence" as never,
      audit: { performedByUserId: "usr_fence" as never, forAccountId: "acc_fence" as never },
    };
    await service.claimAnonymousIntent(
      {
        anonymousOwnerId: "anon_legacy",
        intentId: intent.intentId,
        accountId: context.audit.forAccountId,
        destination: {
          kind: "new",
          listId: "svl_fence" as never,
          createCommandId: "slc_fence_create" as never,
          title: "Fence",
        },
        trackedQuantity: 1,
        sourceSurface: "search",
      },
      context,
    );
    expect(
      (
        await pool.query(
          "SELECT status, anonymous_owner_id FROM collections_anonymous_saved_list_intents WHERE intent_id = $1",
          [intent.intentId],
        )
      ).rows,
    ).toEqual([{ status: "claimed", anonymous_owner_id: "anon_legacy" }]);
    await expect(
      service.prepareAnonymousClaim({
        anonymousOwnerId: "anon_expire",
        intentId: "sli_expire",
        accountId: context.audit.forAccountId,
      }),
    ).rejects.toMatchObject({ code: "intent-expired" });
    expect(
      (await pool.query("SELECT status FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_expire'"))
        .rows,
    ).toEqual([{ status: "expired" }]);
    const sweep = collectionsRetentionSweeps.find((entry) => entry.name === "terminal-anonymous-saved-list-intents")!;
    expect(
      (
        await pool.query(`DELETE FROM collections_anonymous_saved_list_intents candidate
      WHERE ${sweep.predicateSql} RETURNING intent_id`)
      ).rows,
    ).toEqual([{ intent_id: "sli_expire" }]);
  });

  it("anonymous-owner-fence-rejects-raw-writes", async () => {
    const dualValues = (id: string) => [
      id,
      savedListFingerprint(["collections.anonymous-owner.v1", "anon_fence"]),
      "/search",
      "search",
      product.catalogItemId,
      product.productId,
      JSON.stringify(product.selectedOptions),
      null,
      "slc_fence",
      "sll_fence",
      new Date(Date.now() + 30 * 86400000).toISOString(),
      "anon_fence",
    ];
    await pool.query(rawInsert, ["sli_fence_inactive", "anon_fence"]);
    await pool.query(dualInsert, dualValues("sli_dual_inactive"));
    await pool.query(
      "UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_id = 'anon_changed' WHERE intent_id = 'sli_dual_inactive'",
    );
    await activateAnonymousOwnerCutover(pool, { gatePacketSha256: "c".repeat(64), floorCommit: "floor" });
    const assertFence = async (suffix: string) => {
      await expect(pool.query(rawInsert, [`sli_raw_${suffix}`, "anon_fence"])).rejects.toThrow("anonymous-owner-fence");
      await expect(pool.query(dualInsert, dualValues(`sli_dual_${suffix}`))).rejects.toThrow("anonymous-owner-fence");
      await expect(
        pool.query(
          "UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_id = 'anon_other' WHERE intent_id = 'sli_fence_inactive'",
        ),
      ).rejects.toThrow("anonymous-owner-fence");
      expect(
        (
          await pool.query(
            "SELECT intent_id FROM collections_anonymous_saved_list_intents WHERE intent_id = ANY($1::text[])",
            [[`sli_raw_${suffix}`, `sli_dual_${suffix}`]],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await pool.query(
            "SELECT anonymous_owner_id FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_fence_inactive'",
          )
        ).rows,
      ).toEqual([{ anonymous_owner_id: "anon_fence" }]);
    };
    await assertFence("active");
    await pool.query(
      "UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_id = anonymous_owner_id, source_path = '/item' WHERE intent_id = 'sli_fence_inactive'",
    );
    await pool.query(
      "UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_id = NULL WHERE intent_id = 'sli_fence_inactive'",
    );
    await expect(
      pool.query(
        "UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_id = 'anon_restored' WHERE intent_id = 'sli_fence_inactive'",
      ),
    ).rejects.toThrow("anonymous-owner-fence");
    for (const mutant of ["dropped-trigger", "wrong-state"]) {
      try {
        if (mutant === "dropped-trigger") {
          await pool.query(
            "DROP TRIGGER collections_anonymous_owner_raw_fence ON collections_anonymous_saved_list_intents",
          );
        } else {
          await pool.query(
            anonymousOwnerActivationSchemaSql.replace("SELECT activated_at IS NOT NULL", "SELECT activated_at IS NULL"),
          );
        }
        await expect(assertFence(mutant)).rejects.toMatchObject({ name: "AssertionError" });
      } finally {
        await pool.query(anonymousOwnerActivationSchemaSql);
        await pool.query("DELETE FROM collections_anonymous_saved_list_intents WHERE intent_id = $1", [
          `sli_raw_${mutant}`,
        ]);
      }
    }
  });
});
