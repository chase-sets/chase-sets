import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import contextManifest from "../context.json";
import { module as orderingModule } from "../index";
import {
  decideOrderingOrder,
  evolveOrderingOrder,
  initialOrderingOrderState,
  type OrderingOrderCommand,
} from "../features/orders/domain/domain";
import type { OrderingServices } from "../support/runtime-support/services";

const commercialTermsSnapshot = {
  marketplaceSalesFeeAmount: "1.00",
  sellerNetAmount: "19.00",
  termsScheduleId: "cts_default",
  termsAgreementId: null,
  termsResolvedAt: "2026-03-31T00:00:00.000Z",
} as const;

const taxSnapshot = {
  taxableAmount: "24.99",
  salesTaxAmount: "0.00",
  jurisdictionCountry: "US",
  jurisdictionState: "IL",
  rateBps: 0,
  providerName: "local-tax-stub",
  providerQuoteReference: null,
  quotedAt: "2026-03-31T00:00:00.000Z",
} as const;

function createServices(commandHandler: OrderingServices["orders"]["commandHandler"]): OrderingServices {
  return {
    db: { query: async () => ({ rows: [], rowCount: 0 }) },
    orders: { commandHandler } as OrderingServices["orders"],
    postagePolicies: {} as OrderingServices["postagePolicies"],
    projectors: [],
    pool: {} as OrderingServices["pool"],
  };
}

function getReservationConfirmedHandler(services: OrderingServices) {
  const subscription = (orderingModule.buildSubscriptions?.(services) ?? []).find(
    (candidate) => candidate.handlers["inventory.reservation.confirmed"],
  );
  const handler = subscription?.handlers["inventory.reservation.confirmed"];

  if (!handler) {
    throw new Error("Ordering inventory reservation subscription handler was not registered.");
  }

  return handler;
}

function pendingReservationOrderState() {
  return decideOrderingOrder(initialOrderingOrderState, {
    type: "CreateOrder",
    orderId: "ord_1" as never,
    sourceType: "buy-now",
    sourceReferenceId: "chk_1",
    buyerAccountId: "acc_buyer" as never,
    sellerAccountId: "acc_seller" as never,
    shippingOption: "standard",
    itemSubtotalAmount: "20.00",
    shippingBaseAmount: "4.99",
    shippingDiscountAmount: "0.00",
    shippingChargeAmount: "4.99",
    shippingPlanSnapshot: {} as never,
    salesTaxAmount: "0.00",
    taxSnapshot,
    totalAmount: "24.99",
    shippingDestinationSnapshot: {
      name: "Jane Smith",
      company: null,
      line1: "100 Market Street",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: "jane@example.com",
    },
    shippingOriginSnapshot: {
      name: "Seller Shipping",
      company: "Chase Sets",
      line1: "1 Warehouse Way",
      line2: null,
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
      phone: "5125550100",
      email: "shipping@example.com",
    },
    commercialTermsSnapshot,
    lines: [
      {
        lineId: "oli_1" as never,
        listingId: "lst_1",
        inventoryItemId: "inv_1",
        catalogItemId: "cat_1",
        productId: "cat_1::" as never,
        itemTitle: "Air Balloon",
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
        reservationRequestId: "rsv_order_1",
        inventoryItemId: "inv_1",
        sellerAccountId: "acc_seller",
        quantity: 1,
      },
    ],
  }).reduce(evolveOrderingOrder, initialOrderingOrderState);
}

function createReservationConfirmedEvent(): TransportEvent {
  const confirmedAt = "2026-06-24T14:00:00.000Z";
  return buildTransportEvent(
    "inventory.reservation.confirmed",
    {
      reservationRequestId: "rsv_order_1",
      orderId: "ord_1",
      sellerAccountId: "acc_seller",
      inventoryItemId: "inv_1",
      quantity: 1,
      holdId: "hld_order_reservation_rsv_order_1",
    },
    {
      id: "evt_reservation_confirmed",
      streamId: "inventory.reservation-rsv_order_1",
      streamVersion: 1,
      globalPosition: "42",
      tenantId: "tnt_1",
      audit: { performedByUserId: "usr_system", forAccountId: "acc_buyer" },
      trace: { traceId: "trace_1" },
      timing: { occurredAt: confirmedAt, recordedAt: confirmedAt },
    },
  );
}

describe("ordering inventory reservation subscription", () => {
  it("models Inventory reservation outcomes as side effects while order projections own order hold pages", () => {
    const groups = contextManifest.projectionGroups ?? [];
    const reservationOutcomes = groups.find(
      (group) => group.projectionName === "ordering-inventory-reservation-outcomes",
    );
    const orderProjection = groups.find((group) => group.projectionName === "ordering-order-projection");

    expect(reservationOutcomes).toMatchObject({
      handlerKind: "reaction",
      sourceContextNames: ["inventory"],
      ownedTables: [],
      resetStrategy: "replay-only",
    });
    expect(orderProjection?.ownedTables).toEqual(
      expect.arrayContaining(["ordering_order_pages", "ordering_order_line_pages", "ordering_order_hold_pages"]),
    );
  });

  it("records pending payment when Inventory confirms the checkout reservation", async () => {
    const commands: OrderingOrderCommand[] = [];
    const commandHandler: OrderingServices["orders"]["commandHandler"] = async (input) => {
      commands.push(input.command);
      const events = decideOrderingOrder(pendingReservationOrderState(), input.command);
      const nextState = events.reduce(evolveOrderingOrder, pendingReservationOrderState());

      expect(input.streamId).toBe("ordering.order-ord_1");
      expect(nextState.status).toBe("pending-payment");
      expect(events.map((event) => event.type)).toEqual([
        "ordering.order.reservation-confirmed",
        "ordering.order.pending-payment-recorded",
      ]);

      return undefined as never;
    };
    const handler = getReservationConfirmedHandler(createServices(commandHandler));
    const subscription = (orderingModule.buildSubscriptions?.(createServices(commandHandler)) ?? []).find(
      (candidate) => candidate.handlers["inventory.reservation.confirmed"],
    );

    await handler(createReservationConfirmedEvent());

    expect(subscription).toMatchObject({
      handlerKind: "reaction",
      idempotencyPolicy: "idempotent-command-dispatch",
      retryPolicy: "retry-from-last-checkpoint",
      failurePolicy: "surface-as-reaction-failure",
    });
    expect(commands).toEqual([
      {
        type: "RecordReservationConfirmed",
        reservationRequestId: "rsv_order_1",
        holdId: "hld_order_reservation_rsv_order_1",
        confirmedAt: "2026-06-24T14:00:00.000Z",
      },
    ]);
  });
});
