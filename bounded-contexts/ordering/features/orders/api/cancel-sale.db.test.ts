import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { toTransportEvent, type TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { module as orderingModule } from "../../../index";
import { buildOrderingFulfillmentCancellationProjectionHandlers } from "../integrations/fulfillment/fulfillment-projection";
import { buildOrderingOrderProjectionHandlers } from "../read-model/projection";
import { claimSellerOrderCapacity } from "./order-capacity";
import {
  context,
  createCheckpointStore,
  createOrderingOrderRuntimeForTest,
  shipFromAddress,
  shippingAddress,
  taxSnapshot,
} from "./runtime-test-harness";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["ordering"] as const;
const occurredAt = "2026-08-22T12:00:00.000Z";

type OrderStatusFixture = "pending-reservation" | "pending-payment" | "ready-for-fulfillment";

function fulfillmentEvent(type: string, data: Record<string, unknown>): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${type.replaceAll(".", "_")}`,
    streamId: `fulfillment.shipment-${String(data.shipmentId)}`,
    tenantId: "tnt_test",
    audit: context.audit,
    timing: { occurredAt, recordedAt: occurredAt },
  });
}

describeDb("seller self-service cancellation db", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let eventStore: EventStore;
  let services: ReturnType<typeof createOrderingOrderRuntimeForTest>;
  let orderProjection: ReturnType<typeof buildOrderingOrderProjectionHandlers>;
  let fulfillmentProjection: ReturnType<typeof buildOrderingFulfillmentCancellationProjectionHandlers>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "ordering_cancel_sale");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.ordering.query(orderingModule.schemaSql);
    eventStore = createPostgresEventStore({ pool: pools.ordering });
    services = runtime(eventStore);
    orderProjection = buildOrderingOrderProjectionHandlers(pools.ordering);
    fulfillmentProjection = buildOrderingFulfillmentCancellationProjectionHandlers(pools.ordering);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function runtime(store: EventStore) {
    return createOrderingOrderRuntimeForTest({
      eventStore: store,
      checkpointStore: createCheckpointStore(),
      db: pools.ordering,
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
      },
    });
  }

  async function projectStoredEvents(events: readonly Parameters<typeof toTransportEvent>[0][]) {
    for (const storedEvent of events) {
      const event = toTransportEvent(storedEvent);
      await orderProjection[event.type]?.(event);
    }
  }

  async function createOrder(
    orderId: string,
    status: OrderStatusFixture,
    accounts: Readonly<{ buyer?: string; seller?: string }> = {},
  ) {
    const buyerAccountId = accounts.buyer ?? "acc_buyer";
    const sellerAccountId = accounts.seller ?? "acc_seller";
    const sourceReferenceId = `chk_${orderId}`;
    const listingId = `lst_${orderId}`;
    const inventoryItemId = `inv_${orderId}`;
    const reservationRequestId = `rsv_${orderId}`;
    const streamId = `ordering.order-${orderId}`;
    const storedEvents = [];

    const created = await services.commandHandler({
      streamId,
      command: {
        type: "CreateOrder",
        orderId: orderId as never,
        sourceType: "cart-checkout",
        sourceReferenceId,
        buyerAccountId: buyerAccountId as never,
        sellerAccountId: sellerAccountId as never,
        shippingOption: "standard",
        itemSubtotalAmount: "20.00",
        shippingBaseAmount: "4.99",
        shippingDiscountAmount: "0.00",
        shippingChargeAmount: "4.99",
        shippingPlanSnapshot: {} as never,
        salesTaxAmount: "0.00",
        taxSnapshot,
        totalAmount: "24.99",
        shippingDestinationSnapshot: shippingAddress,
        shippingOriginSnapshot: shipFromAddress,
        commercialTermsSnapshot: {
          marketplaceSalesFeeAmount: "1.00",
          sellerNetAmount: "19.00",
          termsScheduleId: "cts_default",
          termsAgreementId: null,
          termsResolvedAt: occurredAt,
        },
        lines: [
          {
            lineId: `oli_${orderId}` as never,
            listingId,
            inventoryItemId,
            catalogItemId: "cat_1",
            productId: "cat_1::" as never,
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            gradedCard: null,
            unitPriceAmount: "20.00",
            quantity: 1,
            lineTotalAmount: "20.00",
            marketplaceSalesFeeUnitAmount: "1.00",
            marketplaceSalesFeeTotalAmount: "1.00",
            sellerNetUnitAmount: "19.00",
            sellerNetTotalAmount: "19.00",
          },
        ],
        reservationRequests: [
          {
            reservationRequestId,
            inventoryItemId,
            sellerAccountId,
            quantity: 1,
          },
        ],
      },
      context,
    });
    storedEvents.push(...created.storedEvents);

    if (status !== "pending-reservation") {
      const confirmed = await services.commandHandler({
        streamId,
        command: {
          type: "RecordReservationConfirmed",
          reservationRequestId,
          holdId: `hld_${orderId}`,
          confirmedAt: occurredAt,
        },
        context,
      });
      storedEvents.push(...confirmed.storedEvents);
    }

    if (status === "ready-for-fulfillment") {
      const ready = await services.commandHandler({
        streamId,
        command: { type: "MarkReadyForFulfillment", readyForFulfillmentAt: occurredAt },
        context,
      });
      storedEvents.push(...ready.storedEvents);
    }

    await projectStoredEvents(storedEvents);
    return { buyerAccountId, sellerAccountId, sourceReferenceId, listingId, streamId };
  }

  async function applyShipmentCreated(orderId: string) {
    const shipmentId = `shp_${orderId}`;
    await fulfillmentProjection["fulfillment.shipment.created"]?.(
      fulfillmentEvent("fulfillment.shipment.created", { shipmentId, orderId, createdAt: occurredAt }),
    );
    return shipmentId;
  }

  async function applyShipmentState(
    orderId: string,
    eventType:
      | "fulfillment.shipment.packing-started"
      | "fulfillment.shipment.package-prepared"
      | "fulfillment.shipment.label-attached"
      | "fulfillment.shipment.dispatched"
      | "fulfillment.shipment.cancelled",
  ) {
    const shipmentId = await applyShipmentCreated(orderId);
    const dataByType = {
      "fulfillment.shipment.packing-started": { shipmentId, startedAt: occurredAt },
      "fulfillment.shipment.package-prepared": { shipmentId, preparedAt: occurredAt },
      "fulfillment.shipment.label-attached": { shipmentId, attachedAt: occurredAt },
      "fulfillment.shipment.dispatched": { shipmentId, dispatchedAt: occurredAt },
      "fulfillment.shipment.cancelled": { shipmentId, cancelledAt: occurredAt },
    } as const;
    await fulfillmentProjection[eventType]?.(fulfillmentEvent(eventType, dataByType[eventType]));
  }

  async function cancellationEvents(streamId: string) {
    return (await eventStore.readStream({ streamId })).filter(
      (event) => event.eventType === "ordering.order.cancelled",
    );
  }

  async function seedReleaseClaims(order: Awaited<ReturnType<typeof createOrder>>) {
    await pools.ordering.query(
      `INSERT INTO ordering_listing_purchase_limit_claims (
         claim_id, source_type, source_reference_id, buyer_account_id, listing_id,
         quantity, status, claimed_at, released_at
       ) VALUES ($1, 'cart-checkout', $2, $3, $4, 1, 'claimed', $5, NULL)`,
      [`opl_${order.streamId}`, order.sourceReferenceId, order.buyerAccountId, order.listingId, occurredAt],
    );
    await pools.ordering.query(
      `INSERT INTO ordering_listing_purchase_limit_usage (
         buyer_account_id, listing_id, marketplace_day, day_quantity,
         customer_account_quantity, updated_at
       ) VALUES ($1, $2, $3::date, 1, 1, $4)`,
      [order.buyerAccountId, order.listingId, occurredAt.slice(0, 10), occurredAt],
    );
    await claimSellerOrderCapacity(pools.ordering, [
      { sellerAccountId: order.sellerAccountId, orderIds: [order.streamId.replace("ordering.order-", "")] },
    ]);
  }

  async function releaseSnapshot(orderId: string, buyerAccountId: string, listingId: string) {
    const [purchaseLimit, usage, capacity] = await Promise.all([
      pools.ordering.query<{ status: string }>(
        `SELECT status FROM ordering_listing_purchase_limit_claims
         WHERE buyer_account_id = $1 AND listing_id = $2`,
        [buyerAccountId, listingId],
      ),
      pools.ordering.query<{ day_quantity: number | string; customer_account_quantity: number | string }>(
        `SELECT day_quantity, customer_account_quantity
         FROM ordering_listing_purchase_limit_usage
         WHERE buyer_account_id = $1 AND listing_id = $2`,
        [buyerAccountId, listingId],
      ),
      pools.ordering.query<{ status: string }>(
        `SELECT status FROM ordering_seller_open_order_claims WHERE order_id = $1`,
        [orderId],
      ),
    ]);
    return {
      purchaseLimit: purchaseLimit.rows[0]?.status,
      dayQuantity: Number(usage.rows[0]?.day_quantity),
      accountQuantity: Number(usage.rows[0]?.customer_account_quantity),
      capacity: capacity.rows[0]?.status,
    };
  }

  it("cancels a ready-for-fulfillment sale while its shipment is awaiting-package", async () => {
    const order = await createOrder("ord_ready", "ready-for-fulfillment");
    await applyShipmentCreated("ord_ready");

    await services.cancelSale({ orderId: "ord_ready", sellerAccountId: order.sellerAccountId }, context);

    const events = await cancellationEvents(order.streamId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      orderId: "ord_ready",
      reason: "seller-cancelled",
      statusBeforeCancellation: "ready-for-fulfillment",
    });
  });

  it("fails closed with the fulfillment-started direction after packing begins", async () => {
    const order = await createOrder("ord_packing", "ready-for-fulfillment");
    await applyShipmentState("ord_packing", "fulfillment.shipment.packing-started");

    await expect(
      services.cancelSale({ orderId: "ord_packing", sellerAccountId: order.sellerAccountId }, context),
    ).rejects.toThrow("Sale cancellation is now handled through support because fulfillment has started.");
    expect(await cancellationEvents(order.streamId)).toHaveLength(0);
  });

  it("fails closed with the fulfillment-started direction when the eligibility row is absent", async () => {
    const order = await createOrder("ord_absent", "ready-for-fulfillment");

    await expect(
      services.cancelSale({ orderId: "ord_absent", sellerAccountId: order.sellerAccountId }, context),
    ).rejects.toThrow("Sale cancellation is now handled through support because fulfillment has started.");
    expect(await cancellationEvents(order.streamId)).toHaveLength(0);
  });

  it.each([
    ["packing", "fulfillment.shipment.packing-started"],
    ["awaiting-label", "fulfillment.shipment.package-prepared"],
    ["label-attached", "fulfillment.shipment.label-attached"],
    ["dispatched", "fulfillment.shipment.dispatched"],
    ["cancelled", "fulfillment.shipment.cancelled"],
  ] as const)("rejects the production-projected %s shipment state", async (_shipmentStatus, eventType) => {
    const order = await createOrder(`ord_${_shipmentStatus}`, "ready-for-fulfillment");
    await applyShipmentState(`ord_${_shipmentStatus}`, eventType);

    await expect(
      services.cancelSale({ orderId: `ord_${_shipmentStatus}`, sellerAccountId: order.sellerAccountId }, context),
    ).rejects.toThrow("Sale cancellation is now handled through support because fulfillment has started.");
    expect(await cancellationEvents(order.streamId)).toHaveLength(0);
  });

  it("rejects a caller who is not the sale's owning account", async () => {
    const order = await createOrder("ord_owner", "ready-for-fulfillment");
    await applyShipmentCreated("ord_owner");

    await expect(
      services.cancelSale({ orderId: "ord_owner", sellerAccountId: "acc_not_owner" }, context),
    ).rejects.toThrow("Sale not found.");
    expect(await cancellationEvents(order.streamId)).toHaveLength(0);
  });

  it.each(["pending-payment", "pending-reservation"] as const)(
    "continues to cancel a %s sale without a fulfillment row",
    async (status) => {
      const order = await createOrder(`ord_${status}`, status);

      await services.cancelSale({ orderId: `ord_${status}`, sellerAccountId: order.sellerAccountId }, context);

      const events = await cancellationEvents(order.streamId);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        reason: "seller-cancelled",
        statusBeforeCancellation: status,
      });
    },
  );

  it("allows one simultaneous seller cancel, rejects one conflict, and keeps retries and releases idempotent", async () => {
    const order = await createOrder("ord_race", "ready-for-fulfillment");
    await applyShipmentCreated("ord_race");
    await seedReleaseClaims(order);

    let armed = true;
    let readers = 0;
    let releaseReaders!: () => void;
    const bothLoaded = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    const barrierStore: EventStore = {
      ...eventStore,
      readStream: async (input) => {
        const events = await eventStore.readStream(input);
        if (armed && input.streamId === order.streamId) {
          readers += 1;
          if (readers === 2) releaseReaders();
          await bothLoaded;
        }
        return events;
      },
    };
    const racingServices = runtime(barrierStore);
    const outcomes = await Promise.allSettled([
      racingServices.cancelSale({ orderId: "ord_race", sellerAccountId: order.sellerAccountId }, context),
      racingServices.cancelSale({ orderId: "ord_race", sellerAccountId: order.sellerAccountId }, context),
    ]);
    armed = false;

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "concurrency_conflict" } });
    expect(await cancellationEvents(order.streamId)).toHaveLength(1);

    await services.cancelSale({ orderId: "ord_race", sellerAccountId: order.sellerAccountId }, context);
    const cancellation = (await cancellationEvents(order.streamId))[0]!;
    expect(await cancellationEvents(order.streamId)).toHaveLength(1);

    const beforeProjection = await releaseSnapshot("ord_race", order.buyerAccountId, order.listingId);
    expect(beforeProjection).toEqual({
      purchaseLimit: "released",
      dayQuantity: 0,
      accountQuantity: 0,
      capacity: "claimed",
    });

    await orderProjection["ordering.order.cancelled"]?.(toTransportEvent(cancellation));
    const afterProjection = await releaseSnapshot("ord_race", order.buyerAccountId, order.listingId);
    expect(afterProjection).toEqual({
      purchaseLimit: "released",
      dayQuantity: 0,
      accountQuantity: 0,
      capacity: "released",
    });
  });

  it("leaves identical purchase-limit and seller-capacity release rows for buyer and seller cancellation", async () => {
    const buyerOrder = await createOrder("ord_buyer", "ready-for-fulfillment", {
      buyer: "acc_buyer_a",
      seller: "acc_seller_a",
    });
    const sellerOrder = await createOrder("ord_seller", "ready-for-fulfillment", {
      buyer: "acc_buyer_b",
      seller: "acc_seller_b",
    });
    await applyShipmentCreated("ord_buyer");
    await applyShipmentCreated("ord_seller");
    await seedReleaseClaims(buyerOrder);
    await seedReleaseClaims(sellerOrder);

    await services.cancelPurchase({ orderId: "ord_buyer", buyerAccountId: buyerOrder.buyerAccountId }, context);
    await services.cancelSale({ orderId: "ord_seller", sellerAccountId: sellerOrder.sellerAccountId }, context);
    const buyerCancellation = (await cancellationEvents(buyerOrder.streamId))[0]!;
    const sellerCancellation = (await cancellationEvents(sellerOrder.streamId))[0]!;
    await orderProjection["ordering.order.cancelled"]?.(toTransportEvent(buyerCancellation));
    await orderProjection["ordering.order.cancelled"]?.(toTransportEvent(sellerCancellation));

    const buyerRelease = await releaseSnapshot("ord_buyer", buyerOrder.buyerAccountId, buyerOrder.listingId);
    const sellerRelease = await releaseSnapshot("ord_seller", sellerOrder.buyerAccountId, sellerOrder.listingId);
    expect(sellerRelease).toEqual(buyerRelease);
    expect(sellerRelease).toEqual({
      purchaseLimit: "released",
      dayQuantity: 0,
      accountQuantity: 0,
      capacity: "released",
    });
  });
});
