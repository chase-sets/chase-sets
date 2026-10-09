import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { executeRetentionSweepBatch } from "@chase-sets/platform-runtime/retention-sweep";
import { module as channelsModule } from "../../../index";
import { readAcceptedReadyToShipMembership, acceptedReadyToShipReferenceLimit } from "../../../server";
import { admitConnectorInbound, createConnectorInboundReader } from "../../connector-feed/read-model/inbound";
import { hashChannelDesiredState } from "../../listing-composition/domain/canonical";
import { seedManualSyncScenario } from "../../manual-sync/api/seed";
import { tcgplayerSaleKey } from "../../tcgplayer-orders/domain/contracts";
import { tcgplayerExternalListingId } from "../../tcgplayer-csv/domain/composition";
import { createFulfillmentObservationRuntime } from "../api/runtime";
import { composeChannelOrderFulfillmentInbound, type ChannelOrderFulfillmentObservation } from "../domain/contracts";
import { buildFulfillmentObservationReactions } from "../integrations/reactions";
import { fulfillmentObservationSchemaMigrations } from "../read-model/schema";
import { fulfillmentFixture } from "./fixtures";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = baseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;
const reference = "synthetic-order";
const migration = fulfillmentObservationSchemaMigrations[1]!;

describeDb("accepted RTS owner", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, ["channels"], "accepted_rts_9153");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await seedTargets();
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it.each(["list", "detail"] as const)(
    "accepted-rts-acceptance: first full %s RTS is a nonempty accepted source",
    async (surface) => {
      const observation = { ...fulfillmentFixture(), providerOrderStatus: { surface, value: "Ready to Ship" } };
      await seedSale(observation);
      expect(await membership()).toEqual([]); // A committed sale alone is not a fulfillment fact.
      await admit(observation);
      expect(await membership()).toEqual([]); // The ingest/202 inbox boundary is not acceptance.
      expect(await runtime().interpretConnection("connection-1")).toBe(1);
      expect(await membership()).toEqual([reference]);
      expect((await orders())[0]).toMatchObject({
        provider_order_status: observation.providerOrderStatus,
        status: "active",
      });
      expect(await membership([reference], "connection-2")).toEqual([]);
      expect(await membership(["missing"])).toEqual([]);
      expect(await membership([])).toEqual([]);
      const largest = [
        reference,
        ...Array.from({ length: acceptedReadyToShipReferenceLimit - 1 }, (_, i) => `missing-${i}`),
      ];
      expect(await membership(largest)).toEqual([reference]);
      expect(await events()).toHaveLength(1);
    },
  );

  it("accepted-rts-acceptance: full and status-only changes retain qualified status while translated active stays unchanged", async () => {
    await accept();
    await admit({ ...fulfillmentFixture(), providerOrderStatus: { surface: "list", value: "Shipped - In Transit" } });
    await runtime().interpretDueConnections();
    expect(await membership()).toEqual([]);
    for (const [value, surface] of [
      ["Ready to Ship", "detail"],
      ["Shipped - Delivered", "list"],
      ["Completed - Paid", "list"],
    ] as const) {
      await admit(status(value, surface));
      await runtime().interpretConnection("connection-1");
      expect(await membership()).toEqual(value === "Ready to Ship" ? [reference] : []);
      expect((await orders())[0]).toMatchObject({ status: "active", provider_order_status: { surface, value } });
      expect(await events()).toHaveLength(1);
    }
    await admit(status("Canceled"));
    await runtime().interpretConnection("connection-1");
    expect(await membership()).toEqual([]);
    expect((await events()).map((event) => event.event_type)).toEqual([
      "channels.order-fulfillment-observation.accepted",
      "channels.order-fulfillment-observation.status-changed",
    ]);
    expect(JSON.stringify(await events())).not.toContain("providerOrderStatus");
  });

  it("accepted-rts-acceptance: waiting, sale-absent, refused, cancelled-before-acceptance and expired inputs establish no fact", async () => {
    await admit(fulfillmentFixture());
    await runtime().interpretConnection("connection-1");
    expect(await states()).toEqual(["awaiting-sale"]);
    expect(await membership()).toEqual([]);
    const absent = fulfillmentFixture("absent");
    await admit(absent, new Date(Date.now() - 25 * 3600000).toISOString());
    await admit({ ...fulfillmentFixture("cancelled"), providerOrderStatus: { surface: "list", value: "Canceled" } });
    await admit({ ...status("Ready to Ship"), externalOrderReference: "status-without-full" });
    await admit(fulfillmentFixture("expired"), new Date(Date.now() - 91 * 86400000).toISOString());
    await runtime().interpretConnection("connection-1");
    expect(await states()).toEqual(["awaiting-sale", "sale-absent", "refused", "refused"]);
    expect(await membership([reference, "absent", "cancelled", "status-without-full", "expired"])).toEqual([]);
    expect(await events()).toEqual([]);
    expect(await orders()).toEqual([expect.objectContaining({ accepted_at: null, provider_order_status: null })]);
  });

  it("accepted-rts-acceptance: changed content and stale observations cannot overwrite accepted eligibility", async () => {
    await accept();
    await admit({
      ...fulfillmentFixture(),
      shipTo: { ...fulfillmentFixture().shipTo, city: "Other" },
      providerOrderStatus: { surface: "list", value: "Shipped - In Transit" },
    });
    await runtime().interpretConnection("connection-1");
    expect(await membership()).toEqual([reference]);
    const before = await orders();
    const page = await createConnectorInboundReader(pools.channels)({
      connectionId: "connection-1",
      inboundKind: "channel-order-fulfillment-observation/v1",
    });
    // Synthetic replay after candidate deletion: the owner sequence, not candidate presence, excludes it.
    await pools.channels.query("DELETE FROM channel_fulfillment_observations WHERE state='accepted' AND revision=1");
    const stale = runtime(pools.channels, async () => ({ ...page, events: [page.events[0]!], nextCursor: null }));
    await stale.interpretConnection("connection-1");
    expect(await orders()).toEqual(before);
    expect(await membership()).toEqual([reference]);
    expect(await events()).toHaveLength(1);
  });

  it("accepted-rts-acceptance: a newer full acceptance fences an existing unaccepted cancellation", async () => {
    await admit({ ...fulfillmentFixture(), providerOrderStatus: { surface: "list", value: "Canceled" } });
    await runtime().interpretConnection("connection-1");
    expect(await membership()).toEqual([]);
    await accept();
    expect(await membership()).toEqual([reference]);
    expect((await orders())[0]).toMatchObject({ revision: "2", status: "active" });
    expect(await events()).toHaveLength(1);
  });

  it.each(["first", "later"])(
    "accepted-rts-acceptance: %s acceptance rolls back after an event-store crash and recovers",
    async (phase) => {
      if (phase === "later") await accept();
      else await seedSale(fulfillmentFixture());
      await admit(phase === "first" ? fulfillmentFixture() : status("Canceled"));
      const before = await orders();
      const priorEvents = await events();
      const store = createPostgresEventStore({ pool: pools.channels });
      vi.spyOn(store, "appendToStreamInTransaction").mockImplementationOnce(async () => {
        expect(await membership()).toEqual(phase === "first" ? [] : [reference]);
        throw new Error("synthetic-crash");
      });
      const crashed = createFulfillmentObservationRuntime({
        db: pools.channels,
        eventStore: store,
        readAdmittedConnectorInboundEvents: createConnectorInboundReader(pools.channels),
      });
      await expect(crashed.interpretConnection("connection-1")).rejects.toThrow("synthetic-crash");
      expect(await orders()).toEqual(before);
      expect(await events()).toEqual(priorEvents);
      expect(await membership()).toEqual(phase === "first" ? [] : [reference]);
      await runtime().interpretConnection("connection-1");
      expect(await membership()).toEqual(phase === "first" ? [reference] : []);
      expect(await events()).toHaveLength(priorEvents.length + 1);
    },
  );

  it("accepted-rts-acceptance: active-to-active fact and candidate roll back on a late transaction crash", async () => {
    await accept();
    await admit(status("Shipped - In Transit"));
    const before = await snapshot();
    const crashed = runtime(
      intercept(async (sql) => {
        if (sql.includes("INSERT INTO channel_fulfillment_observations")) throw new Error("synthetic-late-crash");
      }),
    );
    await expect(crashed.interpretConnection("connection-1")).rejects.toThrow("synthetic-late-crash");
    expect(await snapshot()).toEqual(before);
    expect(await membership()).toEqual([reference]);
    await runtime().interpretConnection("connection-1");
    expect(await membership()).toEqual([]);
  });

  it("accepted-rts-acceptance: losing revision CAS cannot publish or overwrite a newer write", async () => {
    await accept();
    await admit(status("Canceled"));
    let raced = false;
    const racedPool = intercept(async (sql) => {
      if (!raced && sql.includes("UPDATE channel_fulfillment_orders SET")) {
        raced = true;
        await pools.channels.query(
          `UPDATE channel_fulfillment_orders SET revision=revision+1,
          last_sequence=last_sequence+100,provider_order_status='{"surface":"detail","value":"Ready to Ship"}'
          WHERE connection_id='connection-1' AND order_reference=$1 AND revision=1`,
          [reference],
        );
      }
    });
    await expect(runtime(racedPool).interpretConnection("connection-1")).rejects.toThrow("concurrency conflict");
    expect(raced).toBe(true);
    expect(await membership()).toEqual([reference]);
    expect(await events()).toHaveLength(1);
    expect((await orders())[0]).toMatchObject({
      revision: "2",
      status: "active",
      provider_order_status: { surface: "detail", value: "Ready to Ship" },
    });
    await runtime().interpretConnection("connection-1");
    expect(await states()).toEqual(["accepted", "refused"]);
  });

  it("accepted-rts-acceptance: losing first-insert conflict rolls back without a duplicate event", async () => {
    await seedSale(fulfillmentFixture());
    await admit(fulfillmentFixture());
    let raced = false;
    const racedPool = intercept(async (sql) => {
      if (!raced && sql.includes("INSERT INTO channel_fulfillment_orders")) {
        raced = true;
        await pools.channels.query(
          `INSERT INTO channel_fulfillment_orders
          (connection_id,order_reference,account_id,status,last_sequence,accepted_at)
          VALUES ('connection-1',$1,'account-1','active',100,now())`,
          [reference],
        );
      }
    });
    await expect(runtime(racedPool).interpretConnection("connection-1")).rejects.toThrow("concurrency conflict");
    expect(raced).toBe(true);
    expect(await events()).toEqual([]);
    expect(await membership()).toEqual([]); // The synthetic competing old/unknown row is not RTS.
    expect(await states()).toEqual([]);
  });

  it("accepted-rts-upgrade-retention: concurrent recovery, repeated bootstrap and reset/retry are inert without downstream projection presence", async () => {
    await seedSale(fulfillmentFixture());
    await admit(fulfillmentFixture());
    await Promise.all([runtime().interpretConnection("connection-1"), runtime().interpretConnection("connection-1")]);
    const before = await snapshot();
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await seedManualSyncScenario(pools.channels, services());
    await seedManualSyncScenario(pools.channels, services());
    await admit(fulfillmentFixture());
    const handlers = buildFulfillmentObservationReactions(runtime());
    for (const handler of Object.values(handlers)) {
      // Reset is replay-only. The existing retry handlers consume only these two identity fields.
      await handler!({ data: { connectionId: "connection-1", connectionAuditReference: "connection-1" } } as never);
    }
    await runtime().interpretDueConnections();
    expect(await snapshot()).toEqual(before);
    expect(await membership()).toEqual([reference]);
    expect(await events()).toHaveLength(1);
  });

  it("accepted-rts-membership: each SQL clause and each RTS surface discriminates on frozen controls", async () => {
    await accept();
    const detail = {
      ...fulfillmentFixture("detail"),
      providerOrderStatus: { surface: "detail", value: "Ready to Ship" },
    } as const;
    await seedSale(detail);
    await admit(detail);
    await runtime().interpretConnection("connection-1");
    const shipped = {
      ...fulfillmentFixture("shipped"),
      providerOrderStatus: { surface: "list", value: "Shipped - In Transit" },
    } as const;
    await seedSale(shipped);
    await admit(shipped);
    await runtime().interpretConnection("connection-1");
    // Corrupt/legacy controls isolate individual clauses; positive controls above always use real acceptance.
    await pools.channels.query(`INSERT INTO channel_fulfillment_orders
      (connection_id,order_reference,account_id,status,last_sequence,accepted_at,provider_order_status) VALUES
      ('connection-2','foreign','account-2','active',1,now(),'{"surface":"list","value":"Ready to Ship"}'),
      ('connection-1','unaccepted','account-1','active',1,NULL,'{"surface":"list","value":"Ready to Ship"}'),
      ('connection-1','old-unknown','account-1','active',1,now(),NULL)`);
    const input = {
      connectionId: "connection-1",
      orderReferences: [reference, "detail", "foreign", "shipped", "unaccepted", "old-unknown", "missing"],
    };
    const expected = ["detail", reference];
    expect(await readAcceptedReadyToShipMembership(pools.channels, input)).toEqual(expected);
    const mutations = [
      (sql: string) => sql.replace("connection_id=$1", "$1::text IS NOT NULL"),
      (sql: string) => sql.replace("accepted_at IS NOT NULL", "TRUE"),
      (sql: string) => sql.replace(/provider_order_status IN \([\s\S]*?\)/, "status='active'"),
      (sql: string) =>
        sql.replace('{"surface":"list","value":"Ready to Ship"}', '{"surface":"detail","value":"Ready to Ship"}'),
      (sql: string) =>
        sql.replace('{"surface":"detail","value":"Ready to Ship"}', '{"surface":"list","value":"Ready to Ship"}'),
    ];
    for (const mutate of mutations) {
      const db: PgQueryable = { query: (sql, values) => pools.channels.query(mutate(sql), values) };
      expect(await readAcceptedReadyToShipMembership(db, input)).not.toEqual(expected);
    }
    const onlyOne = { ...input, orderReferences: [reference] };
    const bypassReferences: PgQueryable = {
      query: (sql, values) =>
        pools.channels.query(sql.replace("order_reference=ANY($2::text[])", "$2::text[] IS NOT NULL"), values),
    };
    expect(await readAcceptedReadyToShipMembership(pools.channels, onlyOne)).toEqual([reference]);
    expect(await readAcceptedReadyToShipMembership(bypassReferences, onlyOne)).not.toEqual([reference]);
  });

  it("accepted-rts-upgrade-retention: ledger-only upgrade matches fresh boot and does not infer old RTS from active/history", async () => {
    const fresh = await columnShape();
    await resetMultiContextTestSchemas(pools);
    const predecessor = {
      ...channelsModule,
      schemaSql: channelsModule.schemaSql.replace(`${migration.statements[0]};`, ""),
      schemaMigrations: channelsModule.schemaMigrations!.filter((entry) => entry.migrationId !== migration.migrationId),
    };
    await bootstrapContextDatabase(predecessor, pools.channels);
    await seedTargets();
    await pools.channels.query(
      `INSERT INTO channel_fulfillment_orders
      (connection_id,order_reference,account_id,status,last_sequence,accepted_at)
      VALUES ('connection-1',$1,'account-1','active',0,now())`,
      [reference],
    );
    await admit(fulfillmentFixture()); // Retained raw RTS bytes must not become migration authority.
    await bootstrapContextDatabase({ ...channelsModule, schemaSql: "" }, pools.channels);
    expect(await columnShape()).toEqual(fresh);
    expect(await membership()).toEqual([]);
    expect((await orders())[0]?.provider_order_status).toBeNull();
    expect(
      (
        await pools.channels.query("SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id=$1", [
          migration.migrationId,
        ])
      ).rows,
    ).toEqual([{ migration_id: migration.migrationId }]);
    await admit(status("Ready to Ship", "detail"));
    await runtime().interpretConnection("connection-1");
    expect(await membership()).toEqual([reference]);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(await membership()).toEqual([reference]);
  });

  it("accepted-rts-upgrade-retention: 91-day payload/candidate erasure preserves the PII-free fact and inert replay", async () => {
    await accept();
    const before = await orders();
    const payload = (
      await pools.channels.query<{ provider_event_id: string; received_at: string }>(
        "SELECT provider_event_id,received_at::text FROM channel_connector_inbound_payloads",
      )
    ).rows[0]!;
    await pools.channels.query(
      `UPDATE channel_connector_inbound_payloads SET received_at=now()-interval '91 days'
      WHERE provider_event_id=$1 AND received_at=$2::timestamptz`,
      [payload.provider_event_id, payload.received_at],
    );
    await pools.channels
      .query(`UPDATE channel_fulfillment_observations SET received_at=now()-interval '91 days',revision=revision+1
      WHERE state='accepted' AND revision=1`);
    for (const sweep of channelsModule.retentionSweeps ?? []) await executeRetentionSweepBatch(pools.channels, sweep);
    expect(
      (await pools.channels.query("SELECT provider_event_id FROM channel_connector_inbound_payloads")).rows,
    ).toEqual([]);
    expect(await states()).toEqual([]);
    expect(await orders()).toEqual(before);
    expect(JSON.stringify(before)).not.toMatch(/Synthetic Recipient|Example St|shipTo|postalCode/);
    expect(await membership()).toEqual([reference]);
    await admit(fulfillmentFixture());
    await runtime().interpretConnection("connection-1");
    expect(await membership()).toEqual([reference]);
    expect(await events()).toHaveLength(1);
  });
});

function runtime(db = pools.channels, read = createConnectorInboundReader(pools.channels)) {
  return createFulfillmentObservationRuntime({
    db,
    eventStore: createPostgresEventStore({ pool: pools.channels }),
    readAdmittedConnectorInboundEvents: read,
  });
}
function membership(orderReferences = [reference], connectionId = "connection-1") {
  return services().fulfillmentObservations.readAcceptedReadyToShipMembership({ connectionId, orderReferences });
}
function services() {
  return channelsModule.createServices(pools.channels, {
    channelSaleRecorder: async () => {
      throw new Error("Unexpected sale authoring");
    },
  });
}
function status(value: string, surface: "list" | "detail" = "list"): ChannelOrderFulfillmentObservation {
  return {
    version: 1,
    variant: "status-only",
    providerKey: "tcgplayer",
    externalOrderReference: reference,
    providerOrderStatus: { surface, value },
    revision: `synthetic-${surface}-${value}`,
  };
}
async function admit(observation: ChannelOrderFulfillmentObservation, receivedAt = new Date().toISOString()) {
  const envelope = await composeChannelOrderFulfillmentInbound(observation);
  await withPgTransaction(pools.channels, (db) => admitConnectorInbound(db, "connection-1", envelope, receivedAt));
}
async function accept() {
  await seedSale(fulfillmentFixture());
  await admit(fulfillmentFixture());
  await runtime().interpretConnection("connection-1");
}
async function orders() {
  return (await pools.channels.query("SELECT * FROM channel_fulfillment_orders ORDER BY connection_id,order_reference"))
    .rows;
}
async function events() {
  return (
    await pools.channels.query(
      "SELECT event_type,payload FROM event_store_events WHERE event_type LIKE 'channels.order-fulfillment-observation.%' ORDER BY global_position",
    )
  ).rows;
}
async function states() {
  return (
    await pools.channels.query<{ state: string }>(
      "SELECT state FROM channel_fulfillment_observations ORDER BY sequence",
    )
  ).rows.map((row) => row.state);
}
async function snapshot() {
  return {
    orders: await orders(),
    events: await events(),
    observations: (await pools.channels.query("SELECT * FROM channel_fulfillment_observations ORDER BY sequence")).rows,
  };
}
async function columnShape() {
  return (
    await pools.channels.query(
      "SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='channel_fulfillment_orders' ORDER BY ordinal_position",
    )
  ).rows;
}
function intercept(beforeQuery: (sql: string) => Promise<void>): PgTransactionalPool {
  return {
    query: pools.channels.query.bind(pools.channels),
    connect: async () => {
      const client = await pools.channels.connect();
      return {
        release: client.release.bind(client),
        query: async (sql, values) => {
          await beforeQuery(sql);
          return client.query(sql, values);
        },
      };
    },
  };
}

// Synthetic upstream sale/mapping facts, not provider captures or fabricated fulfillment acceptance.
async function seedSale(observation: Extract<ChannelOrderFulfillmentObservation, { variant: "full" }>) {
  const line = observation.lines[0]!;
  const saleKey = tcgplayerSaleKey("account-1", "connection-1", observation.externalOrderReference, line);
  await pools.channels.query(
    `INSERT INTO channel_order_lines
    (connection_id,sale_key_fingerprint,facts_fingerprint,committed_sale,backdated) VALUES ('connection-1',$1,$2,$3,false)`,
    [
      hashChannelDesiredState(saleKey),
      hashChannelDesiredState({
        productId: line.productId,
        skuId: line.skuId,
        quantity: line.quantity,
        unitPriceAmount: line.unitPriceAmount,
        soldAt: observation.orderedAt,
        currencyCode: "USD",
      }),
      JSON.stringify({
        saleKey,
        accountId: "account-1",
        inventoryItemId: "item-1",
        storageLocationId: "location-1",
        requestedQuantity: line.quantity,
      }),
    ],
  );
}
async function seedTargets() {
  await pools.channels.query(`INSERT INTO channel_connections
    (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
    VALUES ('connection-1','account-1','tcgplayer','sandbox','active',now(),now(),'[{"storageLocationId":"location-1","revision":1}]',now(),1)`);
  await pools.channels.query(`INSERT INTO channels_connection_facts
    (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
    VALUES ('connection-1','account-1','tcgplayer','sandbox','active',now(),1)`);
  await pools.channels.query(`INSERT INTO channels_inventory_item_facts
    (item_id,account_id,catalog_item_id,storage_location_id,total_quantity,updated_at,item_stream_version)
    VALUES ('item-1','account-1','catalog-1','location-1',10,now(),1)`);
  await pools.channels.query(
    `INSERT INTO channel_fulfillment_item_facts VALUES ('item-1','account-1','catalog-1::raw')`,
  );
  await pools.channels.query(`INSERT INTO channels_listing_publication_facts
    (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
      selected_options,selected_option_key,listing_status,updated_at,listing_stream_version,item_title)
    VALUES ('listing-1','account-1','item-1','catalog-1','10.00','USD',10,'[]','key','active',now(),1,'Synthetic item')`);
  await pools.channels.query(
    `INSERT INTO channels_channel_listing_links
    (connection_id,listing_id,channel_listing_id,external_listing_id,last_desired_state_sequence,last_desired_listing_revision,
      last_desired_state_hash,last_desired_intent,last_desired_payload,publish_state,updated_at,last_stream_version)
    VALUES ('connection-1','listing-1','link-1',$1,1,1,$2,'update','{}','published',now(),1)`,
    [tcgplayerExternalListingId("101", "Near Mint"), "1".repeat(64)],
  );
}
