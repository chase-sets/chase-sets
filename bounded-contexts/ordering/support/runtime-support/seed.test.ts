import { describe, expect, it, vi } from "vitest";
import { defaultPostagePolicy } from "@chase-sets/product-measures";
import { marketplaceReservedSeedIds, reputationReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import { OrderingDomainError } from "../../features/orders/domain/common";
import { orderingReservedSeedIds } from "../seed-support/ids";
import { inspectOrderingSeedState, seedOrderingDatabase } from "./seed";

type StoredEvent = Readonly<{
  stream_id: string;
  stream_version: number;
  event_type: string;
  payload: Readonly<Record<string, unknown>>;
}>;

const postagePolicyStreamId = `ordering.postage-policy-${orderingReservedSeedIds.postagePolicies.default}`;

function orderStreamId(orderId: string) {
  return `ordering.order-${orderId}`;
}

function createdOrderEvent(
  orderId: string,
  sourceType: "cart-checkout" | "offer-acceptance",
  sourceReferenceId: string,
): StoredEvent {
  return {
    stream_id: orderStreamId(orderId),
    stream_version: 1,
    event_type: "ordering.order.created",
    payload: {
      orderId,
      sourceType,
      sourceReferenceId,
      reservationRequests: [],
    },
  };
}

function followupOrderEvent(orderId: string, eventType: string): StoredEvent {
  return {
    stream_id: orderStreamId(orderId),
    stream_version: 2,
    event_type: eventType,
    payload: { orderId },
  };
}

function activePostagePolicyEvents(): readonly StoredEvent[] {
  return [
    {
      stream_id: postagePolicyStreamId,
      stream_version: 1,
      event_type: "ordering.postage-policy.created",
      payload: {
        policyId: orderingReservedSeedIds.postagePolicies.default,
        label: "Default postage policy",
        status: "draft",
        payload: defaultPostagePolicy,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
        createdByUserId: "usr_seed_demo",
      },
    },
    {
      stream_id: postagePolicyStreamId,
      stream_version: 2,
      event_type: "ordering.postage-policy.activated",
      payload: {
        policyId: orderingReservedSeedIds.postagePolicies.default,
        activatedByUserId: "usr_seed_demo",
        activationReason: "Seed default postage policy.",
      },
    },
  ];
}

function createEventStoreDb(events: readonly StoredEvent[]) {
  return {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("COUNT(*) AS count") && sql.includes("WHERE stream_id = $1")) {
        const streamId = String(values?.[0]);
        return { rows: [{ count: String(events.filter((event) => event.stream_id === streamId).length) }] };
      }
      if (sql.includes("event_type = 'ordering.order.created'") && sql.includes("payload->>'sourceType' = $1")) {
        const [sourceType, sourceReferenceId] = values ?? [];
        return {
          rows: events
            .filter(
              (event) =>
                event.event_type === "ordering.order.created" &&
                event.payload.sourceType === sourceType &&
                event.payload.sourceReferenceId === sourceReferenceId,
            )
            .map((event) => ({ order_id: event.payload.orderId })),
        };
      }
      if (sql.includes("FROM event_store_events") && sql.includes("WHERE stream_id = $1")) {
        const streamId = String(values?.[0]);
        return {
          rows: events
            .filter((event) => event.stream_id === streamId)
            .sort((left, right) => left.stream_version - right.stream_version),
        };
      }
      throw new Error(`Unexpected event-store query: ${sql}`);
    }),
  };
}

function seededOrderEvents(offerOrderIds: readonly [string, string] | null): readonly StoredEvent[] {
  const checkoutOrderId = orderingReservedSeedIds.orders.checkoutPending;
  const cancelledOrderId = orderingReservedSeedIds.orders.cancelled;
  const events: StoredEvent[] = [
    ...activePostagePolicyEvents(),
    createdOrderEvent(checkoutOrderId, "cart-checkout", "chk_seed_checkout_pending"),
    createdOrderEvent(cancelledOrderId, "cart-checkout", "chk_seed_cancelled"),
    followupOrderEvent(cancelledOrderId, "ordering.order.cancelled"),
  ];
  if (offerOrderIds) {
    events.push(
      createdOrderEvent(
        offerOrderIds[0],
        "offer-acceptance",
        marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
      ),
      followupOrderEvent(offerOrderIds[0], "ordering.order.ready-for-fulfillment-recorded"),
      createdOrderEvent(
        offerOrderIds[1],
        "offer-acceptance",
        marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerEncore,
      ),
      followupOrderEvent(offerOrderIds[1], "ordering.order.ready-for-fulfillment-recorded"),
    );
  }
  return events;
}

function createSeedDb(
  options: Readonly<{
    activeOrderIds?: readonly string[];
    cancelledOrderIds?: readonly string[];
    acceptedOfferInput?: Readonly<Record<string, unknown>> | null;
  }>,
) {
  const events: StoredEvent[] = [...activePostagePolicyEvents()];
  for (const orderId of options.activeOrderIds ?? []) {
    events.push(createdOrderEvent(orderId, "cart-checkout", `source-${orderId}`));
  }
  for (const orderId of options.cancelledOrderIds ?? []) {
    events.push(
      createdOrderEvent(orderId, "cart-checkout", `source-${orderId}`),
      followupOrderEvent(orderId, "ordering.order.cancelled"),
    );
  }
  const eventStore = createEventStoreDb(events);
  return {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM event_store_events")) {
        return eventStore.query(sql, values);
      }
      if (sql.includes("FROM ordering_market_listing_inputs")) {
        return { rows: [] };
      }
      if (sql.includes("FROM ordering_offer_acceptance_inputs")) {
        return { rows: options.acceptedOfferInput ? [options.acceptedOfferInput] : [] };
      }
      throw new Error(`Unexpected seed query: ${sql}`);
    }),
  };
}

describe("ordering seed", () => {
  it("waits for active Marketplace supply instead of failing partial preview bootstrap", async () => {
    const createOrdersFromCheckout = vi.fn();
    const createOrdersFromAcceptedOffer = vi.fn();
    const cancelPurchase = vi.fn();
    const commandHandler = vi.fn();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const db = createSeedDb({
      activeOrderIds: [
        orderingReservedSeedIds.orders.acceptedOfferReady,
        reputationReservedSeedIds.orders.reviewEligibleDelivered,
      ],
    });

    try {
      await seedOrderingDatabase(
        {} as never,
        {
          db,
          orders: {
            createOrdersFromCheckout,
            createOrdersFromAcceptedOffer,
            cancelPurchase,
          },
          postagePolicies: { commandHandler },
        } as never,
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(createOrdersFromCheckout).not.toHaveBeenCalled();
    expect(createOrdersFromAcceptedOffer).not.toHaveBeenCalled();
    expect(cancelPurchase).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Ordering seed is waiting for active Marketplace supply for Pikachu.");
    expect(logs.join("\n")).toContain("Ordering seed complete!");
  });

  it("waits for accepted-offer input projections before creating dependent seed orders", async () => {
    const createOrdersFromCheckout = vi.fn();
    const createOrdersFromAcceptedOffer = vi.fn();
    const cancelPurchase = vi.fn();
    const commandHandler = vi.fn();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const db = createSeedDb({
      activeOrderIds: [orderingReservedSeedIds.orders.checkoutPending],
      cancelledOrderIds: [orderingReservedSeedIds.orders.cancelled],
    });

    try {
      await seedOrderingDatabase(
        {} as never,
        {
          db,
          orders: {
            createOrdersFromCheckout,
            createOrdersFromAcceptedOffer,
            cancelPurchase,
          },
          postagePolicies: { commandHandler },
        } as never,
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(createOrdersFromCheckout).not.toHaveBeenCalled();
    expect(createOrdersFromAcceptedOffer).not.toHaveBeenCalled();
    expect(cancelPurchase).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(
      "Ordering seed is waiting for active Marketplace supply for Twilight Masquerade Elite Trainer Box. Skipping the dependent accepted-offer order for this pass.",
    );
    expect(logs.join("\n")).toContain("Ordering seed complete!");
  });

  it("skips accepted-offer seed orders when active supply is not ready", async () => {
    const createOrdersFromCheckout = vi.fn();
    const createOrdersFromAcceptedOffer = vi.fn(async (params: { itemTitle: string }) => {
      throw new OrderingDomainError(`Not enough active supply is available for ${params.itemTitle}.`);
    });
    const cancelPurchase = vi.fn();
    const commandHandler = vi.fn();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const acceptedOfferInput = {
      product_id: "prd_seed",
      marketplace_sales_fee_unit_amount: "4.00",
      seller_net_unit_amount: "40.00",
      terms_schedule_id: "trs_seed",
      terms_agreement_id: "tag_seed",
      terms_resolved_at: "2026-01-01T00:00:00.000Z",
    };
    const db = createSeedDb({
      activeOrderIds: [orderingReservedSeedIds.orders.checkoutPending],
      cancelledOrderIds: [orderingReservedSeedIds.orders.cancelled],
      acceptedOfferInput,
    });

    try {
      await seedOrderingDatabase(
        {} as never,
        {
          db,
          orders: {
            createOrdersFromCheckout,
            createOrdersFromAcceptedOffer,
            cancelPurchase,
          },
          postagePolicies: { commandHandler },
        } as never,
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(createOrdersFromCheckout).not.toHaveBeenCalled();
    expect(createOrdersFromAcceptedOffer).toHaveBeenCalledTimes(2);
    expect(cancelPurchase).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(
      "Ordering seed is waiting for active Marketplace supply for Twilight Masquerade Elite Trainer Box. Skipping the dependent accepted-offer order for this pass.",
    );
    expect(logs.join("\n")).toContain("Ordering seed complete!");
  });

  it("reports offer-acceptance orders by source identity for generated, reserved, and absent shapes", async () => {
    const generatedOrderIds = ["ord_generated_offer_ready", "ord_generated_review_eligible"] as const;
    const reservedOrderIds = [
      orderingReservedSeedIds.orders.acceptedOfferReady,
      reputationReservedSeedIds.orders.reviewEligibleDelivered,
    ] as const;
    const generatedDb = createEventStoreDb(seededOrderEvents(generatedOrderIds));
    const reservedDb = createEventStoreDb(seededOrderEvents(reservedOrderIds));
    const absentDb = createEventStoreDb(seededOrderEvents(null));

    const generatedReports = await inspectOrderingSeedState(generatedDb as never);
    const reservedReports = await inspectOrderingSeedState(reservedDb as never);
    const absentReports = await inspectOrderingSeedState(absentDb as never);

    const unchangedReports = [
      {
        contextName: "ordering",
        aggregateName: "Postage Policy",
        id: orderingReservedSeedIds.postagePolicies.default,
        key: "Default postage policy",
        streamId: postagePolicyStreamId,
        kind: "active",
        status: "2/2 steps",
        eventCount: 2,
      },
      {
        contextName: "ordering",
        aggregateName: "Order",
        id: orderingReservedSeedIds.orders.checkoutPending,
        key: "chk_seed_checkout_pending",
        streamId: orderStreamId(orderingReservedSeedIds.orders.checkoutPending),
        kind: "active",
        status: "pending-reservation",
        eventCount: 1,
      },
      {
        contextName: "ordering",
        aggregateName: "Order",
        id: orderingReservedSeedIds.orders.cancelled,
        key: "chk_seed_cancelled",
        streamId: orderStreamId(orderingReservedSeedIds.orders.cancelled),
        kind: "active",
        status: "cancelled",
        eventCount: 2,
      },
    ];

    for (const reports of [generatedReports, reservedReports, absentReports]) {
      expect(reports).toHaveLength(5);
      expect(reports.slice(0, 3)).toEqual(unchangedReports);
    }

    const offerKeys = [
      marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
      marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerEncore,
    ] as const;
    for (const [index, key] of offerKeys.entries()) {
      const generated = generatedReports.find((report) => report.key === key)!;
      const reserved = reservedReports.find((report) => report.key === key)!;
      const absent = absentReports.find((report) => report.key === key)!;

      expect(generated).toMatchObject({
        aggregateName: "Order",
        id: generatedOrderIds[index],
        key,
        streamId: orderStreamId(generatedOrderIds[index]!),
        kind: "active",
        status: "ready-for-fulfillment",
      });
      expect(reserved).toMatchObject({
        aggregateName: generated.aggregateName,
        id: reservedOrderIds[index],
        key: generated.key,
        streamId: orderStreamId(reservedOrderIds[index]!),
        kind: generated.kind,
        status: generated.status,
      });

      const generatedCount = (await generatedDb.query(
        "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1",
        [generated.streamId],
      )) as Readonly<{ rows: readonly Readonly<{ count: string }>[] }>;
      const reservedCount = (await reservedDb.query(
        "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1",
        [reserved.streamId],
      )) as Readonly<{ rows: readonly Readonly<{ count: string }>[] }>;
      expect(generated.eventCount).toBe(Number(generatedCount.rows[0]?.count));
      expect(reserved.eventCount).toBe(Number(reservedCount.rows[0]?.count));

      expect(absent).toEqual({
        contextName: "ordering",
        aggregateName: "Order",
        id: reservedOrderIds[index],
        key,
        streamId: orderStreamId(reservedOrderIds[index]!),
        kind: "absent",
        status: null,
        eventCount: 0,
      });
    }
  });

  it("fails closed when an offer source identity names more than one order", async () => {
    const generatedOrderIds = ["ord_generated_offer_ready", "ord_generated_review_eligible"] as const;
    const conflictingOrderId = "ord_conflicting_offer_ready";
    const conflictingEvents = [
      ...seededOrderEvents(generatedOrderIds),
      createdOrderEvent(
        conflictingOrderId,
        "offer-acceptance",
        marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
      ),
    ];

    await expect(inspectOrderingSeedState(createEventStoreDb(conflictingEvents) as never)).rejects.toThrow(
      `expected at most one order for source identity 'offer-acceptance:${marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted}', but found 2`,
    );
  });
});
