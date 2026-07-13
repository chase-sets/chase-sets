import { describe, expect, it, vi } from "vitest";
import type { EnqueueNotificationInput } from "@chase-sets/outbound-messaging";
import {
  NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
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
});
