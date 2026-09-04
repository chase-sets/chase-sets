import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { ShipmentId } from "@chase-sets/primitives/typed-ids";
import type {
  FulfillmentShipmentDispatchedPayload,
  OrderingOrderCancelledPayload,
} from "@chase-sets/event-core/public-event-payloads";
import type { EnqueueNotificationInput } from "@chase-sets/outbound-messaging";
import { createNotificationDeliveryId } from "@chase-sets/outbound-messaging";
import { module as notificationsModule } from "../../../../index";
import {
  NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
  buildNotificationsFulfillmentProjectionHandlers,
  buildNotificationsOrderingProjectionHandlers,
  projectSourceEventToNotification,
} from "./notification-projector";

const baseEvent = {
  id: "evt_1",
  tenantId: "tnt_1",
  streamId: "stream_1",
  streamVersion: 1,
  globalPosition: "10" as never,
  trace: { traceId: "trace_1" },
  audit: {
    performedByUserId: "usr_1",
    forAccountId: "acc_1",
  },
  timing: {
    occurredAt: "2026-05-13T00:00:00.000Z" as never,
    recordedAt: "2026-05-13T00:00:00.000Z" as never,
  },
  metadata: {},
} as const;

describe("notifications source event projector", () => {
  const cancellation: OrderingOrderCancelledPayload = {
    orderId: "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    cancelledAt: "2026-09-02T00:00:00.000Z",
    reservationRequests: [],
  };
  const publicControls: readonly OrderingOrderCancelledPayload[] = [
    cancellation,
    { ...cancellation, buyerAccountId: null, statusBeforeCancellation: null },
    { ...cancellation, buyerAccountId: "acc_buyer", statusBeforeCancellation: "pending-reservation" },
    { ...cancellation, buyerAccountId: "acc_buyer", statusBeforeCancellation: "synthetic-future-status" },
  ];
  const accounts = [undefined, null, "", "  ", 42, {}, true, "acc_buyer", " acc_buyer "];
  const statuses = [
    undefined,
    null,
    42,
    {},
    true,
    "pending-reservation",
    "pending-payment",
    "ready-for-fulfillment",
    "synthetic-future-status",
    "",
    "  ",
    " Pending-Payment ",
  ];
  const reasons = [
    "buyer-cancelled",
    "seller-cancelled",
    "payment-deadline",
    "support-cancel-order",
    "seller-cannot-fulfill",
    "inventory-unavailable",
    "synthetic-future-reason",
    undefined,
    null,
    " Buyer-Cancelled ",
  ];
  const approvedCopy = [
    ["pending-reservation", "You have not been charged."],
    ["pending-payment", "View your order for any payment or refund details."],
    ["ready-for-fulfillment", "View your order for any payment or refund details."],
    ["synthetic-future-status", "View your order for details about this cancellation."],
    ["", "View your order for details about this cancellation."],
    ["  ", "View your order for details about this cancellation."],
    [" Pending-Payment ", "View your order for details about this cancellation."],
  ] as const;

  async function projectCancellation(data: JsonObject, eventOverrides: Partial<TransportEvent> = {}) {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };
    const handler = buildNotificationsOrderingProjectionHandlers(outbox)["ordering.order.cancelled"];
    expect(handler).toBeTypeOf("function");
    await expect(
      handler!({ ...baseEvent, ...eventOverrides, type: "ordering.order.cancelled", data }),
    ).resolves.toBeUndefined();
    return outbox.enqueueNotification.mock.calls.map(([input]) => input.message);
  }

  function expectedBuyer(account: string, moneyLine: string, email?: string, correlationId = "trace_1") {
    const purchaseHref = `/account/purchases/${cancellation.orderId}`;
    return {
      messageType: "ordering.order.cancelled",
      criticality: "commerce",
      category: "order-critical",
      recipientAccountId: account,
      actor: { userId: null, accountId: account },
      title: "Order ORD-Q69G5FAV cancelled",
      body: moneyLine,
      actionHref: purchaseHref,
      templateId: "order_cancelled",
      templateVersion: 1,
      locale: "en",
      templateData: {
        orderReference: "ORD-Q69G5FAV",
        headline: "Order ORD-Q69G5FAV cancelled",
        moneyLine,
        purchaseHref,
      },
      channels: [
        { channel: "web", recipient: { accountId: account }, actionHref: purchaseHref },
        ...(email ? [{ channel: "email", to: [{ email }] }] : []),
      ],
      idempotencyKey: `notifications:ordering:order_cancelled:${cancellation.orderId}`,
      correlationId,
    };
  }

  it("cancellation public payload eligibility matrix", async () => {
    for (const control of publicControls) await projectCancellation(control);
    for (const buyerAccountId of accounts)
      for (const statusBeforeCancellation of statuses) {
        const data = {
          ...cancellation,
          buyerEmail: "buyer@example.test",
          ...(buyerAccountId === undefined ? {} : { buyerAccountId }),
          ...(statusBeforeCancellation === undefined ? {} : { statusBeforeCancellation }),
          futurePublicKey: "ignored",
        };
        const messages = await projectCancellation(data);
        const eligible =
          typeof buyerAccountId === "string" &&
          buyerAccountId.trim().length > 0 &&
          typeof statusBeforeCancellation === "string";
        expect(messages, JSON.stringify(data)).toHaveLength(eligible ? 1 : 0);
        if (eligible) {
          const copy = approvedCopy.find(([status]) => status === statusBeforeCancellation)?.[1];
          expect(copy).toBeDefined();
          expect(messages).toEqual([expectedBuyer(buyerAccountId, copy!, "buyer@example.test")]);
        }
      }
  });

  it("cancellation reason recipient and channel matrix", async () => {
    for (const reason of reasons)
      for (const buyerEmail of [undefined, null, "", "   ", " buyer@example.test "]) {
        for (const [statusBeforeCancellation, moneyLine] of approvedCopy.slice(0, 3)) {
          for (const actingAccount of ["acc_seller", "acc_support", "acc_system"] as const) {
            const data: OrderingOrderCancelledPayload = {
              ...cancellation,
              buyerAccountId: "acc_buyer",
              statusBeforeCancellation,
              ...(reason === undefined ? {} : { reason }),
              ...(buyerEmail === undefined ? {} : { buyerEmail }),
            };
            const messages = await projectCancellation(data, {
              audit: { performedByUserId: "usr_1", forAccountId: actingAccount },
            });
            expect(messages).toEqual([
              expectedBuyer(
                "acc_buyer",
                moneyLine,
                reason !== "buyer-cancelled" && buyerEmail?.trim() ? "buyer@example.test" : undefined,
              ),
            ]);
          }
        }
      }
  });

  it("cancellation copy uses only approved status wording", async () => {
    for (const [statusBeforeCancellation, moneyLine] of approvedCopy)
      for (const reason of reasons) {
        const data: OrderingOrderCancelledPayload = {
          ...cancellation,
          buyerAccountId: "acc_buyer",
          statusBeforeCancellation,
          reason,
        };
        expect(await projectCancellation(data)).toEqual([expectedBuyer("acc_buyer", moneyLine)]);
      }
  });

  it("historical and invalid buyer routing preserve stock returned", async () => {
    const reservationRequests = [
      {
        reservationRequestId: "rsv_1",
        inventoryItemId: "inv_1",
        sellerAccountId: "acc_seller",
        quantity: 2,
        holdId: "hold_1",
      },
      {
        reservationRequestId: "rsv_2",
        inventoryItemId: "inv_2",
        sellerAccountId: "acc_seller",
        quantity: 1,
        status: "released",
      },
      {
        reservationRequestId: "rsv_3",
        inventoryItemId: "inv_3",
        sellerAccountId: "acc_other",
        quantity: 4,
        status: "confirmed",
      },
      {
        reservationRequestId: "rsv_4",
        inventoryItemId: "inv_4",
        sellerAccountId: "acc_pending",
        quantity: 8,
        status: "pending",
      },
    ];
    // Frozen from the pre-cutover seller contract; no mapper or catalog builds this oracle.
    const frozenSellerMessages = [
      {
        seller: "acc_seller",
        item: "inv_1",
        quantity: 3,
        lines: 2,
        body: "3 units across 2 lines returned to available stock after the order was cancelled.",
      },
      {
        seller: "acc_other",
        item: "inv_3",
        quantity: 4,
        lines: 1,
        body: "4 units across 1 lines returned to available stock after the order was cancelled.",
      },
    ].map(({ seller, item, quantity, lines, body }) => ({
      messageType: "inventory.stock-returned",
      criticality: "commerce",
      recipientAccountId: seller,
      title: "Stock returned for order ord_cancelled",
      body,
      actionHref: "/account/sales/ord_cancelled",
      templateId: "seller_stock_returned",
      templateVersion: 1,
      locale: "en",
      templateData: {
        orderId: "ord_cancelled",
        lineCount: lines,
        totalQuantity: quantity,
        releaseReason: "order-cancelled",
        itemId: item,
        itemLedgerHref: `/account/inventory/items/${item}?ledgerKind=hold-released`,
        orderHref: "/account/sales/ord_cancelled",
      },
      channels: [{ channel: "web", recipient: { accountId: seller }, actionHref: "/account/sales/ord_cancelled" }],
      idempotencyKey: `notifications:inventory:stock_returned:ord_cancelled:${seller}`,
      correlationId: "trace_1",
      actor: { userId: null, accountId: seller },
    }));
    for (const buyerAccountId of accounts)
      for (const statusBeforeCancellation of statuses) {
        const messages = await projectCancellation({
          orderId: "ord_cancelled",
          reason: "buyer-requested",
          reservationRequests,
          buyerEmail: "buyer@example.test",
          ...(buyerAccountId === undefined ? {} : { buyerAccountId }),
          ...(statusBeforeCancellation === undefined ? {} : { statusBeforeCancellation }),
        });
        expect(messages.filter((message) => message.messageType === "inventory.stock-returned")).toEqual(
          frozenSellerMessages,
        );
      }
  });

  it("cancellation identity ignores non-governing event fields", async () => {
    for (const buyerEmail of [null, "buyer@example.test"])
      for (const suffix of ["first", "replayed"]) {
        const messages = await projectCancellation(
          {
            ...cancellation,
            buyerAccountId: "acc_buyer",
            statusBeforeCancellation: "pending-payment",
            reason: "payment-deadline",
            buyerEmail,
          },
          {
            id: `evt_synthetic_${suffix}`,
            globalPosition: suffix === "first" ? ("100" as never) : ("999" as never),
            trace: { traceId: `synthetic_trace_${suffix}` },
            audit: { performedByUserId: `usr_synthetic_${suffix}`, forAccountId: `acc_synthetic_${suffix}` },
          },
        );
        expect(messages.map(({ idempotencyKey, channels }) => ({ idempotencyKey, channels }))).toEqual([
          {
            idempotencyKey: `notifications:ordering:order_cancelled:${cancellation.orderId}`,
            channels: expectedBuyer("acc_buyer", "", buyerEmail ?? undefined).channels,
          },
        ]);
      }
    const [fallback] = await projectCancellation(
      { ...cancellation, buyerAccountId: "acc_buyer", statusBeforeCancellation: "pending-payment" },
      { trace: {} },
    );
    expect(fallback?.correlationId).toBe(baseEvent.id);
  });

  it("turns ordering facts into notification-center deliveries", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        type: "ordering.order.created",
        data: {
          orderId: "ord_1",
          buyerAccountId: "acc_buyer" as never,
          totalAmount: "24.00",
          shippingDestinationSnapshot: { email: "buyer@example.test" },
          reservationRequests: [],
        },
      },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "ordering.order.created",
          actionHref: "/account/purchases/ord_1",
          actor: { userId: null, accountId: "acc_buyer" },
        }),
        source: expect.objectContaining({
          projectionName: NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
        }),
      }),
    );
  });

  it("aggregates stock committed notifications by order and seller", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        type: "ordering.order.created",
        data: {
          orderId: "ord_1",
          buyerAccountId: "acc_buyer" as never,
          totalAmount: "44.00",
          shippingDestinationSnapshot: { email: null },
          reservationRequests: [
            {
              reservationRequestId: "rsv_1",
              inventoryItemId: "inv_1",
              sellerAccountId: "acc_seller",
              quantity: 1,
            },
            {
              reservationRequestId: "rsv_2",
              inventoryItemId: "inv_2",
              sellerAccountId: "acc_seller",
              quantity: 2,
            },
          ],
        },
      },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );

    const enqueued = outbox.enqueueNotification.mock.calls.map((call) => call[0]) as Array<{
      message?: { messageType?: string };
    }>;
    const sellerMessages = enqueued
      .map((input) => input.message)
      .filter((message) => message?.messageType === "inventory.stock-committed");

    expect(sellerMessages).toHaveLength(1);
    expect(sellerMessages[0]).toMatchObject({
      actionHref: "/account/sales/ord_1",
      actor: { userId: null, accountId: "acc_seller" },
      body: "3 units across 2 lines are committed to this sale.",
      templateData: {
        orderId: "ord_1",
        lineCount: 2,
        totalQuantity: 3,
        itemLedgerHref: "/account/inventory/items/inv_1?ledgerKind=hold-placed",
      },
    });
  });

  it("uses cancellation-specific stock returned copy", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        type: "ordering.order.cancelled",
        data: {
          orderId: "ord_cancelled",
          reason: "buyer-requested",
          reservationRequests: [
            {
              reservationRequestId: "rsv_1",
              inventoryItemId: "inv_1",
              sellerAccountId: "acc_seller" as never,
              quantity: 1,
              holdId: "hld_1",
              status: "confirmed",
            },
          ],
        },
      },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "inventory.stock-returned",
          body: "1 units across 1 lines returned to available stock after the order was cancelled.",
          templateData: expect.objectContaining({ releaseReason: "order-cancelled" }),
        }),
      }),
    );
  });

  it("uses payment-deadline stock returned copy", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        type: "ordering.order.cancelled",
        data: {
          orderId: "ord_deadline",
          reason: "payment-deadline",
          reservationRequests: [
            {
              reservationRequestId: "rsv_1",
              inventoryItemId: "inv_1",
              sellerAccountId: "acc_seller" as never,
              quantity: 2,
              holdId: "hld_1",
              status: "confirmed",
            },
          ],
        },
      },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "inventory.stock-returned",
          body: "2 units across 1 lines returned to available stock after the payment deadline passed.",
          templateData: expect.objectContaining({ releaseReason: "payment-deadline" }),
        }),
      }),
    );
  });

  it("turns consumed hold facts into sale-recorded seller notifications", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        type: "inventory.hold.consumed",
        data: {
          holdId: "hld_1",
          sellerAccountId: "acc_seller" as never,
          itemId: "inv_1",
          quantity: 2,
          sourceRef: { orderId: "ord_sale", reservationRequestId: "rsv_1" },
          shipmentId: "shp_1",
        },
      },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "inventory.sale-recorded",
          criticality: "operational",
          actionHref: "/account/sales/ord_sale",
          body: "2 units across 1 lines were recorded as sold.",
          templateData: expect.objectContaining({
            itemLedgerHref: "/account/inventory/items/inv_1?ledgerKind=hold-consumed",
          }),
        }),
      }),
    );
  });

  it("turns restock decision pending facts into seller call-to-action notifications", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        type: "inventory.restock-decision.pending",
        data: {
          decisionId: "rsd_1",
          sellerAccountId: "acc_seller" as never,
          orderId: "ord_return",
          itemId: "inv_1",
          quantity: 1,
        },
      },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "inventory.restock-decision-pending",
          actionHref: "/account/inventory/items/inv_1?ledgerKind=hold-consumed",
          title: "Restock decision pending for order ord_return",
          templateData: expect.objectContaining({
            decisionId: "rsd_1",
            orderHref: "/account/sales/ord_return",
          }),
        }),
      }),
    );
  });

  it("turns fulfillment facts into notification-center deliveries", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        type: "fulfillment.shipment.delivered",
        data: {
          shipmentId: "shp_1",
          orderId: "ord_1",
          buyerAccountId: "acc_buyer" as never,
          trackingIdentifier: "1Z999",
          shippingDestinationSnapshot: { email: null },
        },
      },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "fulfillment.shipment.delivered",
          actionHref: "/account/shipments/shp_1",
          actor: { userId: null, accountId: "acc_buyer" },
        }),
        source: expect.objectContaining({
          projectionName: NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
        }),
      }),
    );
  });

  it("notifies once for a ready-to-blocked payout readiness transition with reason and deadline", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        id: "evt_readiness_regression",
        type: "settlement.payout-readiness.recorded",
        data: {
          accountId: "acc_seller" as never,
          previousStatus: "ready",
          status: "restricted",
          missingRequirements: ["individual.verification.document"],
          disabledReason: "requirements.past_due",
          requirementsDeadline: "2026-07-15T00:00:00.000Z",
          contactEmail: "seller@example.test",
        },
      },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          category: "order-critical",
          idempotencyKey: "notifications:settlement:payout_readiness_regression:acc_seller:evt_readiness_regression",
          body: expect.stringContaining("requirements.past_due"),
          channels: expect.arrayContaining([
            expect.objectContaining({ channel: "email", to: [{ email: "seller@example.test" }] }),
          ]),
          templateData: expect.objectContaining({ deadline: "2026-07-15T00:00:00.000Z" }),
        }),
      }),
    );
  });

  it("does not notify for unchanged, improving, or non-blocking readiness states", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };
    const event = {
      ...baseEvent,
      type: "settlement.payout-readiness.recorded" as const,
      data: {
        accountId: "acc_seller" as never,
        previousStatus: "restricted",
        status: "restricted",
        missingRequirements: ["external_account"],
        disabledReason: "requirements.past_due",
      },
    };

    await projectSourceEventToNotification(outbox, event, NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION);
    await projectSourceEventToNotification(
      outbox,
      { ...event, data: { ...event.data, previousStatus: "restricted", status: "ready", missingRequirements: [] } },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );
    await projectSourceEventToNotification(
      outbox,
      {
        ...event,
        data: {
          ...event.data,
          previousStatus: "ready",
          status: "pending",
          missingRequirements: [],
          disabledReason: null,
        },
      },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );

    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });

  it("notifies the seller once when the auto-resume sweep restores their listings", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        type: "marketplace.seller-listing-availability.enabled",
        data: {
          accountId: "acc_seller" as never,
          enabledAt: "2026-07-13T00:00:00.000Z",
          enabledBy: "scheduled",
        },
      },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "marketplace.seller-listing-availability.enabled",
          actionHref: "/account/selling/listings",
          idempotencyKey: "notifications:marketplace:seller_availability_restored:acc_seller:2026-07-13T00:00:00.000Z",
          actor: { userId: null, accountId: "acc_seller" },
          channels: [expect.objectContaining({ channel: "web", recipient: { accountId: "acc_seller" } })],
        }),
      }),
    );
  });

  it("does not notify a seller-initiated enable, only a scheduled auto-resume", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        type: "marketplace.seller-listing-availability.enabled",
        data: {
          accountId: "acc_seller" as never,
          enabledAt: "2026-07-13T00:00:00.000Z",
          enabledBy: "seller",
        },
      },
      NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
    );

    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });
});

describe("notifications shipment dispatch projection", () => {
  const shipmentId = "shp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const orderId = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const shipmentHref = `/account/shipments/${shipmentId}`;
  const dispatchedAt = "2026-09-04T00:00:00.000Z";
  // Neither audit identity is the buyer or the seller: the recipient is read from the
  // event payload, never from whoever performed the dispatch.
  const dispatchAudit = { performedByUserId: "usr_carrier_ops", forAccountId: "acc_operations" };
  const enrichedDispatch = {
    shipmentId,
    orderId,
    buyerAccountId: "acc_buyer",
    sellerAccountId: "acc_seller",
    trackingIdentifier: "1Z999AA10123456784",
    dispatchedAt,
  };
  const routingKeys = ["orderId", "buyerAccountId", "sellerAccountId", "trackingIdentifier"] as const;
  const invalidRoutingValues = [undefined, null, "", "   ", 42, {}, true];
  const invalidTrackingValues = [undefined, 42, {}, true, []];

  function expectedDispatchMessage(
    body: string,
    templateTracking: string | null,
    eventId = "evt_1",
    correlationId = "trace_1",
  ) {
    return {
      messageType: "fulfillment.shipment.dispatched",
      criticality: "commerce",
      category: "order-critical",
      recipientAccountId: "acc_buyer",
      title: "Your shipment is on the way",
      body,
      actionHref: shipmentHref,
      templateId: "shipment_dispatched",
      templateVersion: 1,
      locale: "en",
      templateData: { shipmentId, orderId, trackingIdentifier: templateTracking, shipmentHref },
      channels: [{ channel: "web", recipient: { accountId: "acc_buyer" }, actionHref: shipmentHref }],
      idempotencyKey: `notifications:fulfillment:shipment_dispatched:${eventId}`,
      correlationId,
      actor: { userId: null, accountId: "acc_buyer" },
    };
  }

  async function projectDispatch(data: Record<string, unknown>, eventOverrides: Partial<TransportEvent> = {}) {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };
    const handler = buildNotificationsFulfillmentProjectionHandlers(outbox)["fulfillment.shipment.dispatched"];
    expect(handler).toBeTypeOf("function");
    await expect(
      handler!({
        ...baseEvent,
        ...eventOverrides,
        type: "fulfillment.shipment.dispatched",
        // Deliberately malformed runtime transport payloads: the shipped public union is
        // never weakened so that invalid fixtures typecheck.
        data: data as TransportEvent["data"],
      }),
    ).resolves.toBeUndefined();
    return outbox.enqueueNotification.mock.calls.map(([input]) => input);
  }

  it("dispatch tracked message contract", async () => {
    const enqueued = await projectDispatch(enrichedDispatch, {
      id: "evt_dispatch_tracked" as never,
      globalPosition: "4200" as never,
      trace: { traceId: "trace_dispatch_tracked" as never },
      audit: dispatchAudit as never,
    });

    expect(enqueued.map((input) => input.message)).toEqual([
      expectedDispatchMessage(
        "Tracking identifier: 1Z999AA10123456784.",
        "1Z999AA10123456784",
        "evt_dispatch_tracked",
        "trace_dispatch_tracked",
      ),
    ]);
    expect(enqueued[0]?.message.channels.map((channel) => channel.channel)).toEqual(["web"]);
    // Source metadata is asserted independently: none of it participates in identity.
    expect(enqueued[0]?.source).toEqual({
      sourceEventId: "evt_dispatch_tracked",
      sourceGlobalPosition: "4200",
      projectionName: NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
      occurredAt: baseEvent.timing.occurredAt,
    });
  });

  it("dispatch null tracking contract", async () => {
    const enqueued = await projectDispatch({ ...enrichedDispatch, trackingIdentifier: null });

    expect(enqueued.map((input) => input.message)).toEqual([
      expectedDispatchMessage("Open the shipment for the latest details.", null),
    ]);
    expect(enqueued[0]?.message.channels.map((channel) => channel.channel)).toEqual(["web"]);
  });

  it("dispatch whitespace tracking contract", async () => {
    for (const blankTracking of ["", " ", "   ", "\t\n "]) {
      const enqueued = await projectDispatch({ ...enrichedDispatch, trackingIdentifier: blankTracking });

      expect(
        enqueued.map((input) => input.message),
        JSON.stringify(blankTracking),
      ).toEqual([expectedDispatchMessage("Open the shipment for the latest details.", null)]);
      expect(enqueued[0]?.message.channels.map((channel) => channel.channel)).toEqual(["web"]);
    }
  });

  it("dispatch historical thin payload skips", async () => {
    const historical: FulfillmentShipmentDispatchedPayload = { shipmentId: shipmentId as ShipmentId, dispatchedAt };

    expect(await projectDispatch(historical)).toEqual([]);
  });

  it("dispatch complete presence and value classification", async () => {
    // All 16 presence masks over the four atomically added routing keys. Only the
    // all-absent historical mask and the all-present enriched mask are polarized;
    // every proper subset is rejected without enqueue or error.
    for (let mask = 0; mask < 2 ** routingKeys.length; mask += 1) {
      const data: Record<string, unknown> = { shipmentId, dispatchedAt };
      for (const [index, key] of routingKeys.entries()) {
        if (mask & (1 << index)) data[key] = enrichedDispatch[key];
      }

      const enqueued = await projectDispatch(data);
      expect(enqueued, `mask ${mask.toString(2).padStart(4, "0")}`).toHaveLength(mask === 15 ? 1 : 0);
    }

    // Presence is checked independently of validity: every complete-mask payload with a
    // single invalid routing value is rejected, including a present `undefined`.
    for (const key of ["orderId", "buyerAccountId", "sellerAccountId"] as const) {
      for (const invalid of invalidRoutingValues) {
        const enqueued = await projectDispatch({ ...enrichedDispatch, [key]: invalid });
        expect(enqueued, `${key}=${String(JSON.stringify(invalid))}`).toEqual([]);
      }
    }
    for (const invalid of invalidTrackingValues) {
      const enqueued = await projectDispatch({ ...enrichedDispatch, trackingIdentifier: invalid });
      expect(enqueued, `trackingIdentifier=${String(JSON.stringify(invalid))}`).toEqual([]);
    }

    // Non-object transport data carries no routing at all and is refused outright.
    for (const malformed of [null, "shipment", 42, []]) {
      expect(await projectDispatch(malformed as never)).toEqual([]);
    }

    // Extra unrelated payload keys neither reject the fact nor reach the message.
    const withExtras = await projectDispatch({ ...enrichedDispatch, carrierName: "ACME", labelDocumentUrl: null });
    expect(withExtras.map((input) => input.message)).toEqual([
      expectedDispatchMessage("Tracking identifier: 1Z999AA10123456784.", "1Z999AA10123456784"),
    ]);
  });

  it("dispatch replay keeps event and web identity", async () => {
    const replayed = [
      await projectDispatch(enrichedDispatch, {
        id: "evt_dispatch_replay" as never,
        globalPosition: "10" as never,
        trace: { traceId: "trace_first" as never },
        audit: { performedByUserId: "usr_first", forAccountId: "acc_first" } as never,
      }),
      await projectDispatch(enrichedDispatch, {
        id: "evt_dispatch_replay" as never,
        globalPosition: "99999" as never,
        trace: {},
        audit: { performedByUserId: "usr_rebuild", forAccountId: "acc_rebuild" } as never,
      }),
    ].flat();

    expect(replayed).toHaveLength(2);
    const identities = replayed.map(({ message }) => ({
      idempotencyKey: message.idempotencyKey,
      deliveryId: createNotificationDeliveryId(message, message.channels[0], 0),
    }));
    expect(identities).toEqual([
      {
        idempotencyKey: "notifications:fulfillment:shipment_dispatched:evt_dispatch_replay",
        deliveryId: `notification-delivery:v1:${encodeURIComponent(
          "notifications:fulfillment:shipment_dispatched:evt_dispatch_replay",
        )}:web:1`,
      },
      identities[0]!,
    ]);
    // Correlation still falls back to the event id when the replay carries no trace.
    expect(replayed.map(({ message }) => message.correlationId)).toEqual(["trace_first", "evt_dispatch_replay"]);

    // The same shipment under a different source fact is a different notification.
    const distinct = await projectDispatch(enrichedDispatch, { id: "evt_dispatch_other" as never });
    expect(distinct[0]?.message.idempotencyKey).toBe(
      "notifications:fulfillment:shipment_dispatched:evt_dispatch_other",
    );
    expect(distinct[0]?.message.idempotencyKey).not.toBe(identities[0]?.idempotencyKey);
  });

  it("dispatch and Delivered preserve both source orders", async () => {
    const deliveredData = (email: string | null) => ({
      shipmentId,
      orderId,
      buyerAccountId: "acc_buyer",
      trackingIdentifier: "1Z999AA10123456784",
      deliveredAt: "2026-09-05T00:00:00.000Z",
      shippingDestinationSnapshot: { email },
    });
    // Frozen from the current-main Delivered contract, not from candidate output.
    const frozenDelivered = (email: string | null) => ({
      messageType: "fulfillment.shipment.delivered",
      criticality: "operational",
      recipientAccountId: "acc_buyer",
      title: "Shipment SHP-Q69G5FAV delivered for order ORD-Q69G5FAV",
      body: "Tracking 1Z999AA10123456784 is marked delivered.",
      actionHref: shipmentHref,
      templateId: "shipment_delivered",
      templateVersion: 1,
      locale: "en",
      templateData: {
        orderReference: "ORD-Q69G5FAV",
        shipmentReference: "SHP-Q69G5FAV",
        trackingNumber: "1Z999AA10123456784",
        shipmentId,
      },
      channels: [
        ...(email ? [{ channel: "email", to: [{ email }] }] : []),
        { channel: "web", recipient: { accountId: "acc_buyer" }, actionHref: shipmentHref },
      ],
      idempotencyKey: `notifications:fulfillment:shipment_delivered:${orderId}:1Z999AA10123456784`,
      correlationId: "trace_shared",
      actor: { userId: null, accountId: "acc_buyer" },
    });

    for (const email of [null, "buyer@example.test"]) {
      for (const sourceOrder of ["dispatched-first", "delivered-first"] as const) {
        const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };
        const handlers = buildNotificationsFulfillmentProjectionHandlers(outbox);
        // Both facts deliberately share shipment, order, and trace values.
        const dispatchEvent = {
          ...baseEvent,
          id: "evt_shared_dispatch" as never,
          trace: { traceId: "trace_shared" as never },
          type: "fulfillment.shipment.dispatched" as const,
          data: enrichedDispatch as never,
        };
        const deliveredEvent = {
          ...baseEvent,
          id: "evt_shared_delivered" as never,
          trace: { traceId: "trace_shared" as never },
          type: "fulfillment.shipment.delivered" as const,
          data: deliveredData(email) as never,
        };
        const sequence =
          sourceOrder === "dispatched-first"
            ? [dispatchEvent, deliveredEvent]
            : // Reversed invocation is a synthetic statelessness control, not a claim
              // about production event ordering.
              [deliveredEvent, dispatchEvent];

        for (const event of sequence) await handlers[event.type]!(event);

        const messages = outbox.enqueueNotification.mock.calls.map(([input]) => input.message);
        expect(messages, `${sourceOrder}/${String(email)}`).toHaveLength(2);
        expect(new Set(messages.map((message) => message.idempotencyKey)).size).toBe(2);
        expect(messages.find((message) => message.messageType === "fulfillment.shipment.delivered")).toEqual(
          frozenDelivered(email),
        );
        expect(messages.find((message) => message.messageType === "fulfillment.shipment.dispatched")).toEqual(
          expectedDispatchMessage(
            "Tracking identifier: 1Z999AA10123456784.",
            "1Z999AA10123456784",
            "evt_shared_dispatch",
            "trace_shared",
          ),
        );
      }
    }
  });

  it("dispatch fulfillment manifest and module agree", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: EnqueueNotificationInput) => undefined) };
    const subscriptions = notificationsModule.buildSubscriptions?.({ notificationOutbox: outbox } as never) ?? [];
    const fulfillment = subscriptions.find((subscription) => subscription.sourceContextName === "fulfillment");

    expect(fulfillment).toMatchObject({
      subscriptionName: "notifications.fulfillment-facts-projection",
      handlerKind: "projection",
      projectionName: NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
      subscriptionVersion: 2,
      eventTypes: ["fulfillment.shipment.dispatched", "fulfillment.shipment.delivered"],
      order: 30,
    });
    expect(Object.keys(fulfillment?.handlers ?? {}).sort()).toEqual([
      "fulfillment.shipment.delivered",
      "fulfillment.shipment.dispatched",
    ]);

    // Only the fulfillment subscription moves; every other declaration keeps its
    // name, version, order, and handler-set name.
    expect(
      notificationsModule.eventSubscriptions?.map((declaration) => ({
        sourceContextName: declaration.sourceContextName,
        subscriptionName: declaration.subscriptionName,
        subscriptionVersion: declaration.subscriptionVersion,
        order: declaration.order,
        projectionHandlerSetNames: declaration.projectionHandlerSetNames,
      })),
    ).toEqual([
      {
        sourceContextName: "ordering",
        subscriptionName: "notifications.ordering-facts-projection",
        subscriptionVersion: 1,
        order: 20,
        projectionHandlerSetNames: ["notifications-ordering-facts-projection"],
      },
      {
        sourceContextName: "fulfillment",
        subscriptionName: "notifications.fulfillment-facts-projection",
        subscriptionVersion: 2,
        order: 30,
        projectionHandlerSetNames: ["notifications-fulfillment-facts-projection"],
      },
      {
        sourceContextName: "inventory",
        subscriptionName: "notifications.inventory-facts-projection",
        subscriptionVersion: 1,
        order: 40,
        projectionHandlerSetNames: ["notifications-inventory-facts-projection"],
      },
      {
        sourceContextName: "settlement",
        subscriptionName: "notifications.settlement-facts-projection",
        subscriptionVersion: 1,
        order: 50,
        projectionHandlerSetNames: ["notifications-settlement-facts-projection"],
      },
      {
        sourceContextName: "marketplace",
        subscriptionName: "notifications.marketplace-facts-projection",
        subscriptionVersion: 1,
        order: 60,
        projectionHandlerSetNames: ["notifications-marketplace-facts-projection"],
      },
      {
        sourceContextName: "customer-feedback",
        subscriptionName: "notifications.customer-feedback-facts-projection",
        subscriptionVersion: 1,
        order: 70,
        projectionHandlerSetNames: ["notifications-customer-feedback-facts-projection"],
      },
      {
        sourceContextName: "platform-operations",
        subscriptionName: "notifications.support-dispute-facts-projection",
        subscriptionVersion: 1,
        order: 80,
        projectionHandlerSetNames: ["notifications-support-dispute-facts-projection"],
      },
    ]);
    expect(notificationsModule.projectionGroups).toEqual([
      expect.objectContaining({
        projectionName: NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
        resetStrategy: "append-only-no-reset",
      }),
    ]);

    // The manifest-composed handler is the one that actually enqueues.
    await fulfillment?.handlers["fulfillment.shipment.dispatched"]!({
      ...baseEvent,
      id: "evt_module_dispatch" as never,
      type: "fulfillment.shipment.dispatched",
      data: enrichedDispatch as never,
    });
    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(outbox.enqueueNotification.mock.calls[0]?.[0].message.idempotencyKey).toBe(
      "notifications:fulfillment:shipment_dispatched:evt_module_dispatch",
    );
  });

  it("dispatch links only to the registered first-party account shipment route", async () => {
    const enqueued = await projectDispatch(enrichedDispatch);
    const message = enqueued[0]?.message;

    expect(message?.actionHref).toBe(shipmentHref);
    expect(message?.templateData.shipmentHref).toBe(shipmentHref);
    expect(message?.channels).toEqual([
      { channel: "web", recipient: { accountId: "acc_buyer" }, actionHref: shipmentHref },
    ]);
    expect(JSON.stringify(message)).not.toMatch(/https?:\/\//);
  });
});
