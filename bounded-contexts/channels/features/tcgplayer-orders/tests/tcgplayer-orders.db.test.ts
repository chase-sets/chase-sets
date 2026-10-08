import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
  createMultiContextTestPools,
  closeMultiContextTestPools,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as inventoryModule } from "@chase-sets/inventory";
import {
  createInventoryExternalChannelSaleRecorderForPool,
  type RecordExternalChannelSale,
} from "@chase-sets/inventory/server";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as channelsModule } from "../../../index";
import { createTcgplayerOrderRuntime } from "../api/runtime";
import {
  composeTcgplayerOrderInbound,
  type TcgplayerOrderObservation,
  type TcgplayerOrderRecord,
} from "../domain/contracts";
import { admitConnectorInbound, createConnectorInboundReader } from "../../connector-feed/read-model/inbound";
import { tcgplayerExternalListingId } from "../../tcgplayer-csv/domain/composition";
import { resolveTcgplayerOrderSaleTarget } from "../../reconciliation/read-model/sale-target";
import { readConnectionAttention } from "../../connection-attention/read-model/query";
import { createChannelProviderRegistry } from "../../publication-port/api/registry";
import { createChannelReconciliationRuntime } from "../../reconciliation/api/runtime";
import { CHANNEL_RECONCILIATION_POLICY_FALLBACK } from "../../reconciliation/domain/policy";
import { channelHealthPolicy } from "../../connection-health/domain/policy";
import type { ChannelSaleLineV1 } from "../../publication-port/domain/contracts";
import { tcgplayerOrdersSchemaMigrations } from "../read-model/schema";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = baseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels" | "inventory", PgTransactionalPool>>;
const context: EventStoreContext = {
  tenantId: "tnt_orders_test" as never,
  audit: { performedByUserId: "usr_orders_test" as never, forAccountId: "account-1" as never },
};
const order: TcgplayerOrderObservation = {
  version: 1,
  kind: "order",
  pullId: "synthetic-pull",
  orderNumber: "synthetic-order",
  soldAt: "2026-09-12T16:56:27.225Z",
  cancelled: false,
  lines: [{ productId: "202", skuId: "101", quantity: 2, unitPriceAmount: "10.00" }],
};

describeDb("TCGplayer connector sale interpretation", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, ["channels", "inventory"], "tcgplayer_orders_7030");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await seed();
  });
  afterAll(async () => closeMultiContextTestPools(pools));
  it("tcgplayer-order-unmapped: bounded attention counts survive an empty later page", async () => {
    await pools.channels.query(`INSERT INTO channel_order_attention
      (account_id,connection_id,order_reference,reason,generation,affected_lines,opened_at)
      SELECT 'account-1','connection-1','synthetic-'||n,'tcgplayer-order-unmapped',1,'[]',now() FROM generate_series(1,101) n`);
    const first = (
      await readConnectionAttention(pools.channels, { accountId: "account-1", connectionId: "connection-1" })
    )[0]!.orders!;
    expect(first).toMatchObject({ count: 100, hasMore: true });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const empty = (
      await readConnectionAttention(pools.channels, {
        accountId: "account-1",
        connectionId: "connection-1",
        orderCursor: Buffer.from(JSON.stringify(["zzzz", "zzzz"])).toString("base64url"),
      })
    )[0]!.orders!;
    expect(empty).toEqual({ count: 100, hasMore: true, nextCursor: null, items: [] });
  });

  it("tcgplayer-order-target-resolution: ledgered index includes Links that predate its creation", async () => {
    await pools.channels.query(`DROP INDEX channel_tcgplayer_sku_idx`);
    const statement = tcgplayerOrdersSchemaMigrations[0]!.statements.find((sql) =>
      sql.includes("INDEX CONCURRENTLY IF NOT EXISTS channel_tcgplayer_sku_idx"),
    );
    expect(statement).toBeDefined();
    await pools.channels.query(statement!);
    await withPgTransaction(pools.channels, async (db) => {
      await db.query(`SET LOCAL enable_seqscan=off`);
      expect(
        await resolveTcgplayerOrderSaleTarget(db, {
          accountId: "account-1",
          connectionId: "connection-1",
          skuId: "101",
        }),
      ).toMatchObject({ kind: "mapped" });
    });
    expect(
      (
        await pools.channels.query(
          `SELECT 1 FROM bounded_context_schema_migrations WHERE migration_id='20261008_channels_tcgplayer_orders'`,
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("tcgplayer-order-target-resolution: Condition-dependent and first-candidate-wins mutants fail the governing assertions", async () => {
    await pools.channels.query(`UPDATE channels_channel_listing_links SET external_listing_id=$1`, [
      tcgplayerExternalListingId("101", "Damaged"),
    ]);
    const assertion = async (db: import("@chase-sets/event-core-postgres").PgQueryable, expected: object) =>
      expect(
        await resolveTcgplayerOrderSaleTarget(db, {
          accountId: "account-1",
          connectionId: "connection-1",
          skuId: "101",
        }),
      ).toMatchObject(expected);
    await assertion(pools.channels, { kind: "mapped" });
    const conditionMutant: import("@chase-sets/event-core-postgres").PgQueryable = {
      query: <Row>(sql: string, values?: readonly unknown[]) =>
        pools.channels.query<Row>(
          sql.includes("channel_tcgplayer_listing_sku")
            ? sql.replace(
                "ORDER BY channel_listing_id",
                "AND external_listing_id LIKE '%Near Mint' ORDER BY channel_listing_id",
              )
            : sql,
          values,
        ),
    };
    await expect(assertion(conditionMutant, { kind: "mapped" })).rejects.toThrow();
    await link("101", "Near Mint", "duplicate");
    await assertion(pools.channels, { kind: "unmappable", reason: "duplicate-link" });
    const firstMutant: import("@chase-sets/event-core-postgres").PgQueryable = {
      query: <Row>(sql: string, values?: readonly unknown[]) =>
        pools.channels.query<Row>(
          sql.includes("channel_tcgplayer_listing_sku") ? sql.replace("LIMIT 2", "LIMIT 1") : sql,
          values,
        ),
    };
    await expect(assertion(firstMutant, { kind: "unmappable", reason: "duplicate-link" })).rejects.toThrow();
  });

  it("tcgplayer-order-target-resolution: wrong-family mutant fails the SKU-only assertion", async () => {
    await pools.channels.query(`UPDATE channels_channel_listing_links SET external_listing_id=$1`, [
      tcgplayerExternalListingId("202", "Near Mint"),
    ]);
    const assertion = async (db: import("@chase-sets/event-core-postgres").PgQueryable) =>
      expect(
        await resolveTcgplayerOrderSaleTarget(db, {
          accountId: "account-1",
          connectionId: "connection-1",
          skuId: "101",
        }),
      ).toEqual({ kind: "unmappable", reason: "link-not-found" });
    await assertion(pools.channels);
    const wrongFamily: import("@chase-sets/event-core-postgres").PgQueryable = {
      query: <Row>(sql: string, values?: readonly unknown[]) =>
        pools.channels.query<Row>(sql, sql.includes("channel_tcgplayer_listing_sku") ? ["connection-1", "202"] : values),
    };
    await expect(assertion(wrongFamily)).rejects.toThrow();
  });

  it.each(["connector", "inline-control", "drift-writer-mutant"])(
    "tcgplayer-order-unmapped: real health authority isolates connector attention, mode=%s",
    async (mode) => {
      const inlineControl = mode === "inline-control";
      const poisoned = mode !== "connector";
      await admit({ ...order, orderNumber: "unmapped", lines: [{ ...order.lines[0]!, skuId: "103" }] });
      await admit(order);
      await runtime().interpretConnection("connection-1");
      expect(await sales()).toHaveLength(1);
      if (mode === "drift-writer-mutant") {
        // Inject the forbidden connector finding effect into the disposable DB, then exercise real health.
        await pools.channels.query(
          `INSERT INTO channel_reconciliation_findings
          (connection_id,finding_id,run_generation,kind,fingerprint,open,safe_reason,updated_at,revision)
          VALUES ('connection-1','synthetic-connector-mutant',1,'unmappable-sale',$1,true,'link-not-found',now(),1)`,
          ["a".repeat(64)],
        );
      }
      // An empty, fully observed listing set isolates the only governing difference: the sale finding sink.
      await pools.channels.query(`DELETE FROM channels_channel_listing_links`);
      const services = channelsModule.createServices(pools.channels, { channelSaleRecorder: recorder() });
      const connection = { accountId: "account-1", connectionId: "connection-1" };
      const inlineSales: readonly ChannelSaleLineV1[] = inlineControl
        ? [
            {
              saleKey: {
                version: "v1",
                providerKey: "tcgplayer",
                sellerEnvironmentLineage: "synthetic-inline",
                orderLineIdentity: "synthetic-inline-line",
              },
              externalListingId: "unmapped",
              externalOfferId: null,
              requestedQuantity: 1,
            },
          ]
        : [];
      const registry = createChannelProviderRegistry([
        {
          identity: { providerKey: "tcgplayer", environment: "sandbox" },
          setup: {
            providerKey: "tcgplayer",
            environment: "sandbox",
            requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
          },
          publication: {
            execution: "inline",
            publishListing: async () => ({ kind: "succeeded", externalListingId: "unused" }),
            updatePriceQuantity: async () => ({ kind: "succeeded", externalListingId: "unused" }),
            delistListing: async () => ({ kind: "succeeded", externalListingId: "unused" }),
            fetchChannelState: async () => ({
              kind: "complete",
              items: [],
              collectedCount: 0,
              authorityTotal: 0,
              pageCount: 1,
            }),
            fetchSales: async () => ({
              kind: "complete",
              lines: inlineSales,
              collectedCount: inlineSales.length,
              authorityTotal: inlineSales.length,
              pageCount: 1,
            }),
          },
        },
      ]);
      const reconcile = createChannelReconciliationRuntime({
        db: pools.channels,
        eventStore: createPostgresEventStore({ pool: pools.channels }),
        outboundSync: {
          enqueueReconciliationRepair: async () => null,
          enqueueRepush: async () => null,
          readOutboundOperationsByIds: async () => [],
        },
        channelSaleRecorder: recorder(),
        resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
        resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
      });
      for (let pass = 0; pass < channelHealthPolicy.defaultValue.consecutiveFailureThreshold; pass++) {
        const healthAuthority = (await services.connectionHealth.readConnectionHealth(connection)).health;
        const result = await reconcile.reconcileConnection(
          { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority },
          context,
        );
        expect(result.clean).toBe(!poisoned);
        if (mode === "drift-writer-mutant") expect(() => expect(result.clean).toBe(true)).toThrow();
        await reconcile.deliverHealthObservations(services.connectionHealth, () => context);
      }
      const health = await services.connectionHealth.readConnectionHealth(connection);
      expect(health.systemPaused).toBe(poisoned);
      expect(health.health.state === "failing").toBe(poisoned);
      const contributions = await readConnectionAttention(pools.channels, connection);
      expect(contributions[0]?.orders?.items.some((item) => item.externalOrderReference === "unmapped")).toBe(true);
    },
  );

  it("tcgplayer-order-dedupe: overlapping reordered pulls and two lines commit once per immutable line", async () => {
    const two = { ...order, lines: [...order.lines, { ...order.lines[0]!, skuId: "102" }] };
    await link("102", "Lightly Played");
    await admit({ ...two, pullId: "second" });
    await admit(two);
    await Promise.all([runtime().interpretConnection("connection-1"), runtime().interpretConnection("connection-1")]);
    expect(await sales()).toHaveLength(2);
    expect((await sales()).map((sale) => sale.payload.requestedQuantity)).toEqual([2, 2]);
  });

  it.each(["before-record", "after-record"] as const)(
    "tcgplayer-order-dedupe: recovers crash %s with the exact sale key",
    async (window) => {
      const record = recorder();
      let crashed = false;
      await admit(order);
      const crashing: RecordExternalChannelSale = async (command) => {
        if (window === "before-record" && !crashed) {
          crashed = true;
          throw new Error("synthetic-crash");
        }
        const result = await record(command);
        if (!crashed) {
          crashed = true;
          throw new Error("synthetic-crash");
        }
        return result;
      };
      await expect(runtime(crashing).interpretConnection("connection-1")).rejects.toThrow("synthetic-crash");
      await runtime().interpretConnection("connection-1");
      expect(await sales()).toHaveLength(1);
      expect((await observations())[0]?.state).toBe("completed");
    },
  );

  it.each(["Near Mint", "Damaged", "Unicode 😀: condition"])(
    "tcgplayer-order-target-resolution: SKU matches without Condition predicate %s",
    async (condition) => {
      await pools.channels.query(`UPDATE channels_channel_listing_links SET external_listing_id=$1`, [
        tcgplayerExternalListingId("101", condition),
      ]);
      await expect(resolve()).resolves.toMatchObject({ kind: "mapped", inventoryItemId: "item-1" });
    },
  );

  it("tcgplayer-order-target-resolution: ambiguity precedes target joins and retired links are excluded", async () => {
    await link("101", "Damaged", "second");
    await pools.channels.query(`DELETE FROM channels_listing_publication_facts WHERE listing_id='listing-second'`);
    expect(await resolve()).toEqual({ kind: "unmappable", reason: "duplicate-link" });
    await pools.channels.query(
      `UPDATE channels_channel_listing_links SET last_desired_intent='delist',publish_state='delisted' WHERE channel_listing_id='link-second'`,
    );
    expect(await resolve()).toMatchObject({ kind: "mapped" });
  });

  it.each([
    "tcgplayer:3:202:9:Near Mint",
    "tcgplayer:2:101:9:Near Mint",
    "tcgplayer:3:101:8:Near Mint",
    "tcgplayer:3:101:9:Near Mintjunk",
  ])("tcgplayer-order-target-resolution: wrong family or malformed encoding refuses %s", async (identity) => {
    await pools.channels.query(`UPDATE channels_channel_listing_links SET external_listing_id=$1`, [identity]);
    expect(await resolve()).toEqual({ kind: "unmappable", reason: "link-not-found" });
  });

  it("tcgplayer-order-unmapped: mapping repair after payload expiry resolves only that order gap", async () => {
    await admit({ ...order, orderNumber: "unmapped", lines: [{ ...order.lines[0]!, skuId: "103" }] });
    await admit({ ...order, orderNumber: "other", lines: [{ ...order.lines[0]!, skuId: "104" }] });
    await admit(order);
    await runtime().interpretConnection("connection-1");
    expect(await sales()).toHaveLength(1);
    expect(
      (await readConnectionAttention(pools.channels, { accountId: "account-1" }))[0]?.orders?.items.map(
        (item) => item.externalOrderReference,
      ),
    ).toContain("unmapped");
    await pools.channels.query(`DELETE FROM channel_connector_inbound_payloads`);
    await link("103", "Near Mint");
    await runtime().interpretConnection("connection-1");
    expect(await sales()).toHaveLength(2);
    const open = await pools.channels.query<{
      order_reference: string;
    }>(`SELECT order_reference FROM channel_order_attention
      WHERE reason='tcgplayer-order-unmapped' AND resolved_at IS NULL`);
    expect(open.rows).toEqual([{ order_reference: "other" }]);
    expect((await pools.channels.query(`SELECT 1 FROM channel_reconciliation_findings`)).rows).toHaveLength(0);
  });

  it.each([1000, 30000])(
    "tcgplayer-sale-backdating records sold-at at age %s without drift or replay churn",
    async (age) => {
      const soldAt = new Date(Date.now() - age).toISOString();
      await admit({ ...order, soldAt });
      await runtime(undefined, 10000).interpretConnection("connection-1");
      const [sale] = await sales();
      expect(sale?.payload.soldAt).toBe(soldAt);
      const attention = await pools.channels.query(
        `SELECT * FROM channel_order_attention WHERE reason='backdated-sale'`,
      );
      expect(attention.rows).toHaveLength(age >= 10000 ? 1 : 0);
      const before = await effects();
      await runtime(undefined, 10000).interpretConnection("connection-1");
      expect(await effects()).toEqual(before);
      expect((await pools.channels.query(`SELECT 1 FROM channel_reconciliation_findings`)).rows).toHaveLength(0);
    },
  );

  it.each([true, false])(
    "tcgplayer-order-completeness: summary-first=%s converges without assuming detail atomicity",
    async (summaryFirst) => {
      const summary = {
        version: 1,
        kind: "summary",
        pullId: order.pullId,
        totalOrders: 1,
        pages: [{ offset: 0, count: 1, totalOrders: 1 }],
        range: { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
        filter: "all",
        completion: "complete",
        unknownReason: null,
      } as const;
      await admit(summaryFirst ? summary : order);
      await runtime().interpretConnection("connection-1");
      expect((await pulls())[0]?.state).toBe("unknown");
      await admit(summaryFirst ? order : summary);
      await runtime().interpretConnection("connection-1");
      expect((await pulls())[0]).toMatchObject({
        state: "complete",
        order_count: 1,
        line_count: 1,
        sale_count: 1,
        gap_count: 0,
      });
      const before = await effects();
      await runtime().interpretConnection("connection-1");
      expect(await effects()).toEqual(before);
    },
  );

  it("tcgplayer-order-steady-state: uninterpreted expired content records no sale; expired claim resumes", async () => {
    await admit(order);
    await pools.channels.query(`DELETE FROM channel_connector_inbound_payloads`);
    await runtime().interpretConnection("connection-1");
    expect(await sales()).toHaveLength(0);
    expect((await observations())[0]?.state).toBe("expired");
    await admit({ ...order, pullId: "new-pull" });
    await pools.channels.query(`UPDATE channel_order_consumer SET owner='dead',lease_until=now()-interval '1 minute'`);
    await runtime().interpretConnection("connection-1");
    expect(await sales()).toHaveLength(1);
  });

  it("tcgplayer-order-steady-state: a stale processor cannot erase the replacement owner's completion", async () => {
    await admit(order);
    let signal!: () => void;
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    let resume!: () => void;
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const record = recorder();
    const first = runtime(async (command) => {
      const result = await record(command);
      signal();
      await released;
      return result;
    }).interpretConnection("connection-1");
    const firstOutcome = first.catch((error: unknown) => error);
    await entered;
    await pools.channels.query(`UPDATE channel_order_consumer SET lease_until=now()-interval '1 second'`);
    await runtime().interpretConnection("connection-1");
    const before = await effects();
    resume();
    expect(await firstOutcome).toMatchObject({ message: "tcgplayer-order-claim-lost" });
    expect(await effects()).toEqual(before);
    expect(await sales()).toHaveLength(1);
  });

  it("tcgplayer-order-unmapped: one repaired line cannot clear another line and repeated gaps do not churn attention", async () => {
    await admit({
      ...order,
      lines: [
        { ...order.lines[0]!, skuId: "103" },
        { ...order.lines[0]!, skuId: "104" },
      ],
    });
    await runtime().interpretConnection("connection-1");
    await link("103", "Near Mint");
    await runtime().interpretConnection("connection-1");
    const before = (
      await pools.channels.query(`SELECT * FROM channel_order_attention WHERE resolved_at IS NULL ORDER BY reason`)
    ).rows;
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "tcgplayer-order-unmapped",
          affected_lines: [{ identity: '["202","104"]', detail: "link-not-found" }],
        }),
      ]),
    );
    await runtime().interpretConnection("connection-1");
    expect(
      (await pools.channels.query(`SELECT * FROM channel_order_attention WHERE resolved_at IS NULL ORDER BY reason`))
        .rows,
    ).toEqual(before);
  });

  it("tcgplayer-order-steady-state: cancellation attention stays open without reversal or replay writes", async () => {
    await admit({ ...order, cancelled: true, lines: [] });
    await runtime().interpretConnection("connection-1");
    const before = await effects();
    expect(
      (
        await pools.channels.query(
          `SELECT 1 FROM channel_order_attention WHERE reason='tcgplayer-order-cancelled' AND resolved_at IS NULL`,
        )
      ).rows,
    ).toHaveLength(1);
    await runtime().interpretConnection("connection-1");
    expect(await effects()).toEqual(before);
    expect(await sales()).toHaveLength(0);
  });

  it("tcgplayer-order-steady-state: conflicting facts keep first committed sale and an independent gap", async () => {
    await admit(order);
    await runtime().interpretConnection("connection-1");
    await admit({ ...order, pullId: "new-pull", lines: [{ ...order.lines[0]!, quantity: 9 }] });
    await runtime().interpretConnection("connection-1");
    expect(await sales()).toHaveLength(1);
    expect((await sales())[0]?.payload.requestedQuantity).toBe(2);
    expect(
      (
        await pools.channels.query(
          `SELECT 1 FROM channel_order_attention WHERE reason='tcgplayer-order-recording-refused' AND resolved_at IS NULL`,
        )
      ).rows,
    ).toHaveLength(1);
  });
});

function recorder() {
  return createInventoryExternalChannelSaleRecorderForPool(pools.inventory, context);
}
function runtime(record: RecordExternalChannelSale = recorder(), threshold = 21600000) {
  return createTcgplayerOrderRuntime({
    db: pools.channels,
    channelSaleRecorder: record,
    readAdmittedConnectorInboundEvents: createConnectorInboundReader(pools.channels),
    backdatingAttentionAfterMs: async () => threshold,
  });
}
async function admit(record: TcgplayerOrderRecord) {
  await withPgTransaction(pools.channels, (db) =>
    admitConnectorInbound(db, "connection-1", composeTcgplayerOrderInbound(record), new Date().toISOString()),
  );
}
function resolve() {
  return resolveTcgplayerOrderSaleTarget(pools.channels, {
    accountId: "account-1",
    connectionId: "connection-1",
    skuId: "101",
  });
}
async function sales() {
  return (
    await pools.inventory.query<{ payload: { requestedQuantity: number; soldAt: string } }>(
      `SELECT payload FROM event_store_events WHERE event_type='inventory.external-channel-sale.recorded' ORDER BY global_position`,
    )
  ).rows;
}
async function observations() {
  return (
    await pools.channels.query<{ state: string }>(`SELECT state FROM channel_order_observations ORDER BY sequence`)
  ).rows;
}
async function pulls() {
  return (await pools.channels.query<{ state: string }>(`SELECT * FROM channel_order_pulls`)).rows;
}
async function effects() {
  return (
    await pools.channels.query(`SELECT
    (SELECT jsonb_agg(row_to_json(t)) FROM channel_order_attention t) AS attention,
    (SELECT jsonb_agg(row_to_json(t)) FROM channel_order_lines t) AS lines,
    (SELECT jsonb_agg(row_to_json(t)) FROM channel_order_pulls t) AS pulls,
    (SELECT jsonb_agg(row_to_json(t)) FROM channel_recorded_sale_receipts t) AS receipts,
    (SELECT jsonb_agg(row_to_json(t)) FROM channel_order_observations t) AS observations`)
  ).rows;
}
async function seed() {
  await createPostgresEventStore({ pool: pools.channels }).appendToStream({
    streamId: "channels.connection-connection-1",
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "channels.connection.connected",
        payload: {
          connectionId: "connection-1",
          accountId: "account-1",
          providerKey: "tcgplayer",
          environment: "sandbox",
          createdAt: "2026-09-12T05:00:00Z",
        },
      },
      {
        eventType: "channels.connection.activated",
        payload: {
          connectionId: "connection-1",
          credentialReference: null,
          bindings: [{ storageLocationId: "location-1", revision: 1 }],
        },
      },
    ],
  });
  await pools.channels.query(`INSERT INTO channel_connections
    (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
    VALUES ('connection-1','account-1','tcgplayer','sandbox','active','2026-09-12T05:00:00Z','2026-09-12T05:00:00Z',
      '[{"storageLocationId":"location-1","revision":1}]',now(),2)`);
  await pools.channels.query(`INSERT INTO channels_connection_facts
    (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
    VALUES ('connection-1','account-1','tcgplayer','sandbox','active',now(),2)`);
  await pools.channels.query(`INSERT INTO channels_inventory_item_facts
    (item_id,account_id,catalog_item_id,storage_location_id,total_quantity,updated_at,item_stream_version)
    VALUES ('item-1','account-1','catalog-1','location-1',10,now(),1)`);
  await createPostgresEventStore({ pool: pools.inventory }).appendToStream({
    streamId: "inventory.item-item-1",
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "inventory.item.created",
        payload: {
          itemId: "item-1",
          accountId: "account-1",
          catalogItemId: "catalog-1",
          productId: "catalog-1::raw",
          selectedOptions: [],
          gradedCard: null,
          storageLocationId: "location-1",
          totalQuantity: 10,
          acquisitionCostAmount: null,
          acquisitionCostCurrencyCode: null,
          acquisitionOccurrence: { kind: "unknown" },
        },
      },
    ],
  });
  await link("101", "Near Mint");
}
async function link(sku: string, condition: string, id = sku) {
  await pools.channels.query(
    `INSERT INTO channels_listing_publication_facts
    (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
      selected_options,selected_option_key,listing_status,updated_at,listing_stream_version)
    VALUES ($1,'account-1','item-1','catalog-1','10.00','USD',10,'[]','key','active',now(),1)`,
    [`listing-${id}`],
  );
  await pools.channels.query(
    `INSERT INTO channels_channel_listing_links
    (connection_id,listing_id,channel_listing_id,external_listing_id,last_desired_state_sequence,last_desired_listing_revision,
      last_desired_state_hash,last_desired_intent,last_desired_payload,publish_state,updated_at,last_stream_version)
    VALUES ('connection-1',$1,$2,$3,1,1,$4,'update','{}','published',now(),1)`,
    [`listing-${id}`, `link-${id}`, tcgplayerExternalListingId(sku, condition), "1".repeat(64)],
  );
}
