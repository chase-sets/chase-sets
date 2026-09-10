import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, createSubscriptionRunner } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as inventoryModule } from "@chase-sets/inventory";
import { contextManifest, module as pricingModule } from "../../../index";
import { buildPricingInventoryInputProjectionHandlers } from "../../recommendations/integrations/source/source-projection";
import { buildPricingOwnSaleObservationProjectionHandlers } from "../integrations/inventory/projection";
import { getOwnSaleLows, listOwnSaleObservations } from "../read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["inventory", "pricing"] as const;

const SELLER_ALPHA = "acc_synthetic_alpha";
const SELLER_BETA = "acc_synthetic_beta";
const SELLER_CONTROL = "acc_synthetic_control";
const USER_ID = "usr_synthetic_projection";
const TENANT_ID = "tnt_synthetic_projection";

type TestPools = Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

describeDb("Pricing Own-Sale Observation projection and reads (#7782)", () => {
  let pools: TestPools;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "pricing_own_sales");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await bootstrapContextDatabase(pricingModule, pools.pricing);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  it("replays five sale facts from position zero and identical redelivery changes no row", async () => {
    await seedFiveSaleHistory(pools);
    const declared = inventorySubscription(pools.pricing);

    expect(declared.subscriptionVersion).toBe(3);
    expect(declared.eventTypes).toEqual(
      expect.arrayContaining(["inventory.external-channel-sale.recorded", "inventory.item.offline-sale-recorded"]),
    );
    const group = contextManifest.projectionGroups.find(
      (entry) => entry.projectionName === "pricing-inventory-input-projection",
    );
    expect(group).toMatchObject({ requiredDuringBootstrap: true, resetStrategy: "replay-only" });
    expect(group?.ownedTables).toContain("pricing_own_sale_observations");

    const runner = createSubscriptionRunner("pricing", pools.pricing, pools.inventory, declared);
    expect(runner.checkpointKey).toBe("pricing-inventory-input-projection:inventory:v3");
    expect(
      await pools.pricing.query(`SELECT checkpoint_key FROM event_subscription_checkpoints WHERE checkpoint_key = $1`, [
        runner.checkpointKey,
      ]),
    ).toMatchObject({ rows: [] });
    await drain(runner);

    const first = await rawObservations(pools.pricing);
    expect(first).toHaveLength(5);
    expect(first.filter((row) => row.product_id !== null)).toHaveLength(4);
    expect(first.filter((row) => row.product_id === null)).toEqual([
      expect.objectContaining({
        sale_event_id: "evt_sale_unresolved",
        catalog_catalog_item_id: null,
        product_id: null,
      }),
    ]);
    expect(first.every((row) => typeof row.seller_account_id === "string" && row.seller_account_id.length > 0)).toBe(
      true,
    );
    expect(first).toContainEqual(
      expect.objectContaining({
        sale_event_id: "evt_sale_money",
        requested_quantity: 2,
        applied_quantity: 1,
        unit_price_amount: "12.00",
        currency_code: "USD",
        shipping_collected_amount: "4.00",
        channel_fee_amount: "2.00",
      }),
    );
    expect(first).toContainEqual(
      expect.objectContaining({
        sale_event_id: "evt_sale_offline",
        seller_account_id: SELLER_CONTROL,
        requested_quantity: null,
        applied_quantity: 1,
        currency_code: null,
        sold_at: null,
      }),
    );
    const controlAccountHistory = await listOwnSaleObservations(pools.pricing, {
      accountId: SELLER_CONTROL,
      since: "2026-09-01T00:00:00.000Z",
    });
    expect(controlAccountHistory).toHaveLength(3);
    expect(controlAccountHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ saleEventId: "evt_sale_zero", appliedQuantity: 0 }),
        expect.objectContaining({ saleEventId: "evt_sale_offline", currencyCode: null, soldAt: null }),
        expect.objectContaining({ saleEventId: "evt_sale_unresolved", productId: null }),
      ]),
    );

    await runner.reset();
    await drain(runner);
    expect(await rawObservations(pools.pricing)).toEqual(first);

    const handlers = buildPricingOwnSaleObservationProjectionHandlers(pools.pricing);
    await expect(
      handlers["inventory.item.offline-sale-recorded"]!(
        projectionEvent({
          id: "evt_missing_account",
          type: "inventory.item.offline-sale-recorded",
          accountId: "",
          data: {
            itemId: "inv_alpha",
            quantity: 1,
            salePriceAmount: "1.00",
            channel: "other",
            storageLocationId: "loc_synthetic",
            acquisitionCostAmount: null,
            recordedAt: "2026-09-10T12:00:00.000Z",
          },
          recordedAt: "2026-09-10T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow("requires a non-empty seller account");
  });

  it("upgrades the populated v2 checkpoint without writing or transiently regressing item and hold inputs", async () => {
    await seedFiveSaleHistory(pools);
    const declared = inventorySubscription(pools.pricing);
    const previousVersion = createSubscriptionRunner("pricing", pools.pricing, pools.inventory, {
      ...declared,
      subscriptionVersion: 2,
      eventTypes: declared.eventTypes?.filter(
        (eventType) =>
          eventType !== "inventory.external-channel-sale.recorded" &&
          eventType !== "inventory.item.offline-sale-recorded",
      ),
    });
    await drain(previousVersion);

    const beforeItems = await jsonRows(pools.pricing, "pricing_inventory_item_inputs", "item_id");
    const beforeHolds = await jsonRows(pools.pricing, "pricing_inventory_hold_inputs", "hold_id");
    expect(beforeItems.find((row) => row.item_id === "inv_alpha")).toMatchObject({
      total_quantity: 3,
      last_stream_version: 2,
    });
    expect(beforeHolds).toHaveLength(1);

    await pools.pricing.query(`
      CREATE TABLE pricing_inventory_replay_write_audit (
        table_name text NOT NULL,
        row_id text NOT NULL,
        old_quantity integer NULL,
        new_quantity integer NULL
      );
      CREATE FUNCTION pricing_audit_inventory_replay_write() RETURNS trigger AS $$
      BEGIN
        INSERT INTO pricing_inventory_replay_write_audit (table_name, row_id, old_quantity, new_quantity)
        VALUES (
          TG_TABLE_NAME,
          COALESCE(
            to_jsonb(NEW)->>'item_id',
            to_jsonb(NEW)->>'hold_id',
            to_jsonb(OLD)->>'item_id',
            to_jsonb(OLD)->>'hold_id'
          ),
          COALESCE(to_jsonb(OLD)->>'total_quantity', to_jsonb(OLD)->>'quantity')::integer,
          COALESCE(to_jsonb(NEW)->>'total_quantity', to_jsonb(NEW)->>'quantity')::integer
        );
        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER pricing_audit_item_replay_write
        AFTER INSERT OR UPDATE OR DELETE ON pricing_inventory_item_inputs
        FOR EACH ROW EXECUTE FUNCTION pricing_audit_inventory_replay_write();
      CREATE TRIGGER pricing_audit_hold_replay_write
        AFTER INSERT OR UPDATE OR DELETE ON pricing_inventory_hold_inputs
        FOR EACH ROW EXECUTE FUNCTION pricing_audit_inventory_replay_write();
    `);

    const bumpedVersion = createSubscriptionRunner("pricing", pools.pricing, pools.inventory, declared);
    await drain(bumpedVersion);

    expect(await jsonRows(pools.pricing, "pricing_inventory_item_inputs", "item_id")).toEqual(beforeItems);
    expect(await jsonRows(pools.pricing, "pricing_inventory_hold_inputs", "hold_id")).toEqual(beforeHolds);
    expect((await pools.pricing.query(`SELECT * FROM pricing_inventory_replay_write_audit`)).rows).toEqual([]);
    expect(await rawObservations(pools.pricing)).toHaveLength(5);
  });

  it("returns one exact-currency low per requested seller pair and null for present but ineligible contents", async () => {
    const inventoryInputs = buildPricingInventoryInputProjectionHandlers(pools.pricing);
    const observations = buildPricingOwnSaleObservationProjectionHandlers(pools.pricing);
    for (const [itemId, accountId] of [
      ["inv_low_alpha", SELLER_ALPHA],
      ["inv_low_beta", SELLER_BETA],
      ["inv_low_control", SELLER_CONTROL],
    ] as const) {
      await inventoryInputs["inventory.item.created"]!(
        projectionEvent({
          id: `evt_${itemId}`,
          type: "inventory.item.created",
          accountId,
          streamId: `inventory.item-${itemId}`,
          data: { itemId, accountId, catalogItemId: "cat_low", productId: "prod_low", totalQuantity: 10 },
          recordedAt: "2026-09-01T00:00:00.000Z",
        }),
      );
    }

    await observations["inventory.external-channel-sale.recorded"]!(
      externalSaleEvent({ id: "evt_alpha_12", itemId: "inv_low_alpha", accountId: SELLER_ALPHA, amount: "12.00" }),
    );
    await observations["inventory.external-channel-sale.recorded"]!(
      externalSaleEvent({ id: "evt_alpha_9", itemId: "inv_low_alpha", accountId: SELLER_ALPHA, amount: "9.00" }),
    );
    await observations["inventory.external-channel-sale.recorded"]!(
      externalSaleEvent({
        id: "evt_beta_8",
        itemId: "inv_low_beta",
        accountId: SELLER_BETA,
        amount: "8.00",
        currencyCode: "EUR",
      }),
    );
    await observations["inventory.external-channel-sale.recorded"]!(
      externalSaleEvent({
        id: "evt_control_zero",
        itemId: "inv_low_control",
        accountId: SELLER_CONTROL,
        amount: "1.00",
        appliedQuantity: 0,
      }),
    );
    await observations["inventory.external-channel-sale.recorded"]!(
      externalSaleEvent({
        id: "evt_control_unresolved",
        itemId: "inv_absent",
        accountId: SELLER_CONTROL,
        amount: "2.00",
      }),
    );
    await observations["inventory.external-channel-sale.recorded"]!(
      externalSaleEvent({
        id: "evt_control_priceless",
        itemId: "inv_low_control",
        accountId: SELLER_CONTROL,
        amount: null,
      }),
    );
    await observations["inventory.external-channel-sale.recorded"]!(
      externalSaleEvent({
        id: "evt_control_other_currency",
        itemId: "inv_low_control",
        accountId: SELLER_CONTROL,
        amount: "3.00",
        currencyCode: "EUR",
      }),
    );
    await observations["inventory.item.offline-sale-recorded"]!(
      offlineSaleEvent({ id: "evt_control_offline", itemId: "inv_low_control", accountId: SELLER_CONTROL }),
    );

    let roundTrips = 0;
    const result = await getOwnSaleLows(
      {
        query: async <Row>(sql: string, values?: readonly unknown[]) => {
          roundTrips += 1;
          return pools.pricing.query<Row>(sql, values);
        },
      },
      {
        catalogItemId: "cat_low",
        productId: "prod_low",
        since: "2026-09-01T00:00:00.000Z",
        sellers: [
          { accountId: SELLER_ALPHA, currencyCode: "USD" },
          { accountId: SELLER_BETA, currencyCode: "EUR" },
          { accountId: SELLER_CONTROL, currencyCode: "USD" },
        ],
      },
    );

    expect(roundTrips).toBe(1);
    expect(result).toEqual([
      { accountId: SELLER_ALPHA, currencyCode: "USD", unitPriceAmount: "9.00" },
      { accountId: SELLER_BETA, currencyCode: "EUR", unitPriceAmount: "8.00" },
      { accountId: SELLER_CONTROL, currencyCode: "USD", unitPriceAmount: null },
    ]);
  });

  it("uses recordedAt for offline since windows and composes source and provider filters without inventing currency", async () => {
    const inventoryInputs = buildPricingInventoryInputProjectionHandlers(pools.pricing);
    const observations = buildPricingOwnSaleObservationProjectionHandlers(pools.pricing);
    await inventoryInputs["inventory.item.created"]!(
      projectionEvent({
        id: "evt_item_filters",
        type: "inventory.item.created",
        accountId: SELLER_ALPHA,
        streamId: "inventory.item-inv_filters",
        data: {
          itemId: "inv_filters",
          accountId: SELLER_ALPHA,
          catalogItemId: "cat_filters",
          productId: "prod_filters",
          totalQuantity: 4,
        },
        recordedAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    await observations["inventory.item.offline-sale-recorded"]!(
      offlineSaleEvent({
        id: "evt_offline_outside",
        itemId: "inv_filters",
        accountId: SELLER_ALPHA,
        recordedAt: "2026-09-04T23:59:59.000Z",
      }),
    );
    await observations["inventory.item.offline-sale-recorded"]!(
      offlineSaleEvent({
        id: "evt_offline_inside",
        itemId: "inv_filters",
        accountId: SELLER_ALPHA,
        recordedAt: "2026-09-05T00:00:00.000Z",
      }),
    );
    await observations["inventory.external-channel-sale.recorded"]!(
      externalSaleEvent({
        id: "evt_provider_selected",
        itemId: "inv_filters",
        accountId: SELLER_ALPHA,
        amount: "11.00",
        providerKey: "synthetic-selected",
        soldAt: "2026-09-06T00:00:00.000Z",
      }),
    );
    await observations["inventory.external-channel-sale.recorded"]!(
      externalSaleEvent({
        id: "evt_provider_other",
        itemId: "inv_filters",
        accountId: SELLER_ALPHA,
        amount: "10.00",
        providerKey: "synthetic-other",
        soldAt: "2026-09-07T00:00:00.000Z",
      }),
    );

    const offline = await listOwnSaleObservations(pools.pricing, {
      accountId: SELLER_ALPHA,
      catalogItemId: "cat_filters",
      productId: "prod_filters",
      since: "2026-09-05T00:00:00.000Z",
      sources: ["offline"],
    });
    expect(offline).toEqual([
      expect.objectContaining({
        saleEventId: "evt_offline_inside",
        source: "offline",
        unitPriceAmount: "7.00",
        currencyCode: null,
        soldAt: null,
        recordedAt: "2026-09-05T00:00:00.000Z",
        saleAt: "2026-09-05T00:00:00.000Z",
      }),
    ]);

    const provider = await listOwnSaleObservations(pools.pricing, {
      accountId: SELLER_ALPHA,
      catalogItemId: "cat_filters",
      productId: "prod_filters",
      since: "2026-09-05T00:00:00.000Z",
      sources: ["external-channel"],
      providerKeys: ["synthetic-selected"],
    });
    expect(provider.map((row) => row.saleEventId)).toEqual(["evt_provider_selected"]);
  });
});

function pricingServices(pool: PgTransactionalPool) {
  return pricingModule.createServices(pool, {
    tcgplayerMarketTransport: { kind: "not-mounted" },
    tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
  });
}

function inventorySubscription(pool: PgTransactionalPool) {
  const declared = pricingModule
    .buildSubscriptions?.(pricingServices(pool))
    .find((entry) => entry.projectionName === "pricing-inventory-input-projection");
  if (!declared) throw new Error("Pricing Inventory input subscription is missing.");
  return declared;
}

async function drain(runner: ReturnType<typeof createSubscriptionRunner>): Promise<void> {
  while ((await runner.runOnce()).processed > 0) {
    // Drain the complete bounded fixture through the production subscription runner.
  }
}

async function appendInventoryEvent(
  pool: PgTransactionalPool,
  input: Readonly<{
    eventId: string;
    eventType: string;
    streamId: string;
    expectedVersion: "no_stream" | number;
    accountId: string;
    recordedAt: string;
    payload: Record<string, unknown>;
  }>,
): Promise<void> {
  const store = createPostgresEventStore({
    pool,
    now: () => input.recordedAt as never,
  });
  await store.appendToStream({
    streamId: input.streamId as never,
    expectedVersion: input.expectedVersion as never,
    context: {
      tenantId: TENANT_ID as never,
      audit: { performedByUserId: USER_ID as never, forAccountId: input.accountId as never },
    },
    events: [
      {
        eventId: input.eventId as never,
        eventType: input.eventType,
        payload: input.payload as never,
        occurredAt: input.recordedAt as never,
      },
    ],
  });
}

async function seedFiveSaleHistory(pools: TestPools): Promise<void> {
  const items = [
    { itemId: "inv_alpha", accountId: SELLER_ALPHA, catalogItemId: "cat_own", productId: "prod_own" },
    { itemId: "inv_beta", accountId: SELLER_BETA, catalogItemId: "cat_own", productId: "prod_own" },
    { itemId: "inv_zero", accountId: SELLER_CONTROL, catalogItemId: "cat_own", productId: "prod_own" },
    { itemId: "inv_offline", accountId: SELLER_CONTROL, catalogItemId: "cat_own", productId: "prod_own" },
  ] as const;
  for (const [index, item] of items.entries()) {
    await appendInventoryEvent(pools.inventory, {
      eventId: `evt_item_${index + 1}`,
      eventType: "inventory.item.created",
      streamId: `inventory.item-${item.itemId}`,
      expectedVersion: "no_stream",
      accountId: item.accountId,
      recordedAt: `2026-09-01T0${index}:00:00.000Z`,
      payload: {
        ...item,
        selectedOptions: [],
        gradedCard: null,
        storageLocationId: "loc_synthetic",
        totalQuantity: 5,
        acquisitionCostAmount: null,
      },
    });
  }
  await appendInventoryEvent(pools.inventory, {
    eventId: "evt_item_alpha_adjusted",
    eventType: "inventory.item.adjusted",
    streamId: "inventory.item-inv_alpha",
    expectedVersion: 1,
    accountId: SELLER_ALPHA,
    recordedAt: "2026-09-02T00:00:00.000Z",
    payload: { itemId: "inv_alpha", quantityDelta: -2, reason: "Synthetic fulfilled adjustment" },
  });
  await appendInventoryEvent(pools.inventory, {
    eventId: "evt_hold_placed",
    eventType: "inventory.hold.placed",
    streamId: "inventory.hold-hold_synthetic",
    expectedVersion: "no_stream",
    accountId: SELLER_ALPHA,
    recordedAt: "2026-09-02T01:00:00.000Z",
    payload: { holdId: "hold_synthetic", accountId: SELLER_ALPHA, itemId: "inv_alpha", quantity: 1 },
  });

  await appendInventoryEvent(pools.inventory, {
    eventId: "evt_sale_money",
    eventType: "inventory.external-channel-sale.recorded",
    streamId: "inventory.external-sale-synthetic-money",
    expectedVersion: "no_stream",
    accountId: SELLER_ALPHA,
    recordedAt: "2026-09-06T01:00:00.000Z",
    payload: externalSalePayload({
      itemId: "inv_alpha",
      accountId: SELLER_ALPHA,
      requestedQuantity: 2,
      appliedQuantity: 1,
      amount: "12.00",
      currencyCode: "USD",
      shippingCollectedAmount: "4.00",
      channelFeeAmount: "2.00",
      providerKey: "synthetic-channel-a",
      soldAt: "2026-09-06T00:00:00.000Z",
    }),
  });
  await appendInventoryEvent(pools.inventory, {
    eventId: "evt_sale_no_money",
    eventType: "inventory.external-channel-sale.recorded",
    streamId: "inventory.external-sale-synthetic-no-money",
    expectedVersion: "no_stream",
    accountId: SELLER_BETA,
    recordedAt: "2026-09-06T02:00:00.000Z",
    payload: externalSalePayload({
      itemId: "inv_beta",
      accountId: SELLER_BETA,
      amount: null,
      providerKey: "synthetic-channel-b",
    }),
  });
  await appendInventoryEvent(pools.inventory, {
    eventId: "evt_sale_zero",
    eventType: "inventory.external-channel-sale.recorded",
    streamId: "inventory.external-sale-synthetic-zero",
    expectedVersion: "no_stream",
    accountId: SELLER_CONTROL,
    recordedAt: "2026-09-06T03:00:00.000Z",
    payload: externalSalePayload({
      itemId: "inv_zero",
      accountId: SELLER_CONTROL,
      requestedQuantity: 2,
      appliedQuantity: 0,
      amount: "1.00",
      currencyCode: "USD",
      providerKey: "synthetic-channel-c",
    }),
  });
  await appendInventoryEvent(pools.inventory, {
    eventId: "evt_sale_offline",
    eventType: "inventory.item.offline-sale-recorded",
    streamId: "inventory.item-inv_offline",
    expectedVersion: 1,
    accountId: SELLER_CONTROL,
    recordedAt: "2026-09-06T04:00:00.000Z",
    payload: {
      itemId: "inv_offline",
      quantity: 1,
      salePriceAmount: "7.00",
      channel: "card-show",
      storageLocationId: "loc_synthetic",
      acquisitionCostAmount: null,
      recordedAt: "2026-09-06T03:59:00.000Z",
    },
  });
  await appendInventoryEvent(pools.inventory, {
    eventId: "evt_sale_unresolved",
    eventType: "inventory.external-channel-sale.recorded",
    streamId: "inventory.external-sale-synthetic-unresolved",
    expectedVersion: "no_stream",
    accountId: SELLER_CONTROL,
    recordedAt: "2026-09-06T05:00:00.000Z",
    payload: externalSalePayload({
      itemId: "inv_absent",
      accountId: SELLER_CONTROL,
      amount: "2.00",
      currencyCode: "USD",
      providerKey: "synthetic-channel-d",
    }),
  });
}

function externalSalePayload(
  input: Readonly<{
    itemId: string;
    accountId: string;
    amount: string | null;
    requestedQuantity?: number;
    appliedQuantity?: number;
    currencyCode?: string;
    providerKey?: string;
    shippingCollectedAmount?: string;
    channelFeeAmount?: string;
    soldAt?: string;
  }>,
) {
  const requestedQuantity = input.requestedQuantity ?? 1;
  const appliedQuantity = input.appliedQuantity ?? 1;
  return {
    eventVersion: 1,
    saleKey: {
      version: "v1",
      providerKey: input.providerKey ?? "synthetic-channel",
      sellerEnvironmentLineage: "synthetic-environment",
      orderLineIdentity: `synthetic-line-${input.itemId}`,
    },
    commandFingerprint: `synthetic-fingerprint-${input.itemId}`,
    accountId: input.accountId,
    inventoryItemId: input.itemId,
    storageLocationId: "loc_synthetic",
    requestedQuantity,
    ...(input.amount === null ? {} : { unitPriceAmount: input.amount }),
    ...(input.amount === null && !input.currencyCode ? {} : { currencyCode: input.currencyCode ?? "USD" }),
    ...(input.soldAt ? { soldAt: input.soldAt } : {}),
    ...(input.shippingCollectedAmount ? { shippingCollectedAmount: input.shippingCollectedAmount } : {}),
    ...(input.channelFeeAmount ? { channelFeeAmount: input.channelFeeAmount } : {}),
    collisionMode: "protect-orders",
    collisionPolicyRef: "synthetic-policy",
    collisionPolicyRevision: 1,
    reasonCode: "sold-external-channel",
    result: {
      saleKey: {
        version: "v1",
        providerKey: input.providerKey ?? "synthetic-channel",
        sellerEnvironmentLineage: "synthetic-environment",
        orderLineIdentity: `synthetic-line-${input.itemId}`,
      },
      saleStreamId: `inventory.external-sale-${input.itemId}`,
      saleEventId: `evt_result_${input.itemId}`,
      accountId: input.accountId,
      inventoryItemId: input.itemId,
      storageLocationId: "loc_synthetic",
      requestedQuantity,
      appliedQuantity,
      refusedQuantity: requestedQuantity - appliedQuantity,
      protectedOrderIds: [],
      collisionPolicyRef: "synthetic-policy",
      collisionPolicyRevision: 1,
      inventoryAdjustmentEventId: appliedQuantity > 0 ? `evt_adjust_${input.itemId}` : null,
      saleShortfallKey: appliedQuantity < requestedQuantity ? `shortfall_${input.itemId}` : null,
      committedAt: "2026-09-06T00:00:00.000Z",
    },
  };
}

function projectionEvent(input: Readonly<Record<string, unknown> & { id: string; type: string; data: unknown }>) {
  return {
    id: input.id,
    type: input.type,
    streamId: input.streamId ?? `stream_${input.id}`,
    streamVersion: input.streamVersion ?? 1,
    globalPosition: input.globalPosition ?? "1",
    tenantId: TENANT_ID,
    data: input.data,
    metadata: {},
    audit: { performedByUserId: USER_ID, forAccountId: input.accountId ?? SELLER_ALPHA },
    trace: {},
    timing: {
      occurredAt: input.recordedAt ?? "2026-09-10T00:00:00.000Z",
      recordedAt: input.recordedAt ?? "2026-09-10T00:00:00.000Z",
    },
  } as never;
}

function externalSaleEvent(
  input: Readonly<{
    id: string;
    itemId: string;
    accountId: string;
    amount: string | null;
    appliedQuantity?: number;
    currencyCode?: string;
    providerKey?: string;
    soldAt?: string;
  }>,
) {
  return projectionEvent({
    id: input.id,
    type: "inventory.external-channel-sale.recorded",
    accountId: input.accountId,
    data: externalSalePayload(input),
    recordedAt: "2026-09-10T00:00:00.000Z",
  });
}

function offlineSaleEvent(input: Readonly<{ id: string; itemId: string; accountId: string; recordedAt?: string }>) {
  const recordedAt = input.recordedAt ?? "2026-09-10T00:00:00.000Z";
  return projectionEvent({
    id: input.id,
    type: "inventory.item.offline-sale-recorded",
    accountId: input.accountId,
    data: {
      itemId: input.itemId,
      quantity: 1,
      salePriceAmount: "7.00",
      channel: "in-store",
      storageLocationId: "loc_synthetic",
      acquisitionCostAmount: null,
      recordedAt,
    },
    recordedAt,
  });
}

type RawObservation = Readonly<{
  sale_event_id: string;
  seller_account_id: string;
  catalog_catalog_item_id: string | null;
  product_id: string | null;
  requested_quantity: number | null;
  applied_quantity: number;
  unit_price_amount: string | null;
  currency_code: string | null;
  shipping_collected_amount: string | null;
  channel_fee_amount: string | null;
  sold_at: string | null;
}>;

async function rawObservations(pool: PgTransactionalPool): Promise<readonly RawObservation[]> {
  const result = await pool.query<RawObservation>(
    `SELECT sale_event_id, seller_account_id, catalog_catalog_item_id, product_id,
            requested_quantity, applied_quantity, unit_price_amount::text, currency_code,
            shipping_collected_amount::text, channel_fee_amount::text, sold_at::text
     FROM pricing_own_sale_observations
     ORDER BY sale_event_id`,
  );
  return result.rows;
}

async function jsonRows(
  pool: PgTransactionalPool,
  tableName: "pricing_inventory_item_inputs" | "pricing_inventory_hold_inputs",
  orderColumn: "item_id" | "hold_id",
): Promise<readonly Record<string, unknown>[]> {
  const result = await pool.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(input_row) AS row FROM ${tableName} AS input_row ORDER BY ${orderColumn}`,
  );
  return result.rows.map((entry) => entry.row);
}
