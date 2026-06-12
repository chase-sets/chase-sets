import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createCartReadinessSnapshot } from "../../cart/domain/readiness";
import type { CheckoutCartLineRow } from "../../cart/read-model/queries";
import type { CheckoutDomainError } from "../../../support/runtime-support/common";
import type { CheckoutSessionRow } from "../read-model/queries";
import { createCheckoutSessionRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_buyer" as never,
    forAccountId: "acc_buyer" as never,
  },
};

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
          traceId: input.context.trace?.traceId,
          spanId: input.context.trace?.spanId,
          parentSpanId: input.context.trace?.parentSpanId,
          traceState: input.context.trace?.traceState,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice((input.fromVersion ?? 1) - 1),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return { allEvents, eventStore };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

const readyCartLine: CheckoutCartLineRow = {
  buyer_account_id: "acc_buyer",
  line_id: "cli_1",
  catalog_catalog_item_id: "cat_1",
  product_id: "cat_1::",
  item_language_code: "en",
  item_title: "Charizard",
  item_subtitle: null,
  item_image_url: null,
  item_image_srcset: null,
  item_image_loading_url: null,
  item_image_loading_alt: null,
  item_image_loading_srcset: null,
  selected_options: [],
  product_summary: null,
  quantity: 1,
  fulfillment_mode: "locked-listing",
  locked_listing_id: "lst_1",
  seller_preference_id: null,
  availability_state: "available",
  seller_options: [
    {
      listing_id: "lst_1",
      seller_account_id: "acc_seller",
      seller_slug: "seller",
      seller_display_name: "Card Vault",
      seller_average_rating: null,
      seller_review_count: 0,
      price_amount: "25.00",
      available_quantity: 1,
      product_summary: null,
    },
  ],
  created_at: "2026-06-09T00:00:00.000Z",
  updated_at: "2026-06-09T00:00:00.000Z",
};

function createCartServices(lines: readonly CheckoutCartLineRow[] = [readyCartLine]) {
  return {
    listCartLines: vi.fn(async () => lines),
    removeLine: vi.fn(async () => ({ lineId: "cli_1" as never, version: 1 })),
    checkout: vi.fn(async () => ({ version: 1 })),
    createReadinessSnapshot: vi.fn(async () => createCartReadinessSnapshot(lines)),
  };
}

function createSessionPageRow(
  cartReadinessSnapshot: CheckoutSessionRow["cart_readiness_snapshot"],
  overrides: Partial<CheckoutSessionRow> = {},
): CheckoutSessionRow {
  return {
    session_id: "chk_1",
    buyer_account_id: "acc_buyer",
    source_type: "cart",
    optimization_goal: "lowest-total",
    fulfillment_preview_revision: null,
    cart_readiness_snapshot: cartReadinessSnapshot,
    split_group_handoff: cartReadinessSnapshot?.fulfillmentGroups.length
      ? {
          status: "ready",
          groups: cartReadinessSnapshot.fulfillmentGroups,
          supportReference: `CS-${cartReadinessSnapshot.snapshotId.toUpperCase()}`,
        }
      : null,
    shipping_option: "standard",
    shipping_address_id: null,
    shipping_address: null,
    lines: [
      {
        listingId: "lst_1",
        cartLineId: "cli_1",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_1",
        sellerPreferenceId: null,
        availabilityState: "available",
      },
    ],
    order_ids: [],
    payment_id: null,
    submitted_offer_id: null,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("checkout session runtime", () => {
  it("keeps the session projection scoped to session streams with per-event checkpoints", () => {
    const { eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: createCartServices() as never,
    });

    expect(services.projectors[0]).toMatchObject({
      projectionName: "checkout.session-projection",
      streamPrefixes: ["checkout.session-"],
      checkpointBatchSize: 1,
    });
  });

  it("can update a just-created session before checkout_session_pages has projected it", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("checkout_session_pages")) {
          throw new Error("checkout_session_pages should not be read by command continuations");
        }
        return { rows: [] };
      }),
    };
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db,
      cart: createCartServices() as never,
    });
    const readiness = createCartReadinessSnapshot([readyCartLine]);

    const created = await services.createFromCart(
      {
        accountId: "acc_buyer" as never,
        shippingOption: "standard",
        readinessSnapshotId: readiness.snapshotId,
        readinessSourceRevision: readiness.sourceRevision,
        sessionIdOverride: "chk_projection_lag" as never,
      },
      context,
    );
    const result = await services.selectShippingOption(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        shippingOption: "priority",
      },
      context,
    );

    expect(result.session.shipping_option).toBe("priority");
    expect(result.session.buyer_account_id).toBe("acc_buyer");
    expect(result.session.cart_readiness_snapshot).toMatchObject({
      snapshotId: readiness.snapshotId,
      status: "ready",
    });
    expect(result.session.split_group_handoff).toMatchObject({
      status: "ready",
      supportReference: `CS-${readiness.snapshotId.toUpperCase()}`,
      groups: [
        expect.objectContaining({
          lineIds: ["cli_1"],
          listingIds: ["lst_1"],
          sellerAccountId: "acc_seller",
          downstreamReferenceStatus: "not-started",
        }),
      ],
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("can update a just-created Buy Now session before checkout_session_pages has projected it", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("checkout_session_pages")) {
          throw new Error("checkout_session_pages should not be read by Buy Now command continuations");
        }

        if (sql.includes("checkout_catalog_items")) {
          return {
            rows: [
              {
                catalog_item_id: "cat_1",
                status: "active",
                product_schema: null,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db,
      cart: createCartServices() as never,
    });

    const created = await services.createBuyNow(
      {
        accountId: "acc_buyer" as never,
        listingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_1",
        shippingOption: "standard",
        sessionIdOverride: "chk_buy_now_projection_lag" as never,
      },
      context,
    );
    const result = await services.selectShippingOption(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        shippingOption: "priority",
      },
      context,
    );

    expect(result.session.session_id).toBe("chk_buy_now_projection_lag");
    expect(result.session.source_type).toBe("buy-now");
    expect(result.session.shipping_option).toBe("priority");
    expect(result.session.payment_id).toBeNull();
    expect(result.session.order_ids).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("checkout_catalog_items");
  });

  it("fails closed when cart readiness is missing, stale, or unresolved", async () => {
    const unresolvedLine: CheckoutCartLineRow = {
      ...readyCartLine,
      line_id: "cli_unresolved",
      fulfillment_mode: "optimize",
      locked_listing_id: null,
      seller_options: [],
    };
    const { eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: createCartServices([unresolvedLine]) as never,
    });
    const staleReadiness = createCartReadinessSnapshot([readyCartLine]);
    const unresolvedReadiness = createCartReadinessSnapshot([unresolvedLine]);

    await expect(
      services.createFromCart(
        {
          accountId: "acc_buyer" as never,
          readinessSnapshotId: "",
          readinessSourceRevision: "",
        },
        context,
      ),
    ).rejects.toThrow("Cart readiness changed. Review your cart before checkout.");

    await expect(
      services.createFromCart(
        {
          accountId: "acc_buyer" as never,
          readinessSnapshotId: staleReadiness.snapshotId,
          readinessSourceRevision: staleReadiness.sourceRevision,
        },
        context,
      ),
    ).rejects.toThrow("Cart readiness changed. Review your cart before checkout.");

    await expect(
      services.createFromCart(
        {
          accountId: "acc_buyer" as never,
          readinessSnapshotId: unresolvedReadiness.snapshotId,
          readinessSourceRevision: unresolvedReadiness.sourceRevision,
        },
        context,
      ),
    ).rejects.toThrow("Resolve item availability before checkout starts.");
  });

  it("returns an active cart session when the stored readiness still matches current cart facts", async () => {
    const { eventStore } = createInMemoryEventStore();
    const readiness = createCartReadinessSnapshot([readyCartLine]);
    const cart = createCartServices([readyCartLine]);
    const db = {
      query: vi.fn(async () => ({ rows: [createSessionPageRow(readiness)] })),
    };
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db,
      cart: cart as never,
    });

    await expect(services.getSession("chk_1", "acc_buyer" as never)).resolves.toMatchObject({
      session_id: "chk_1",
      source_type: "cart",
      cart_readiness_snapshot: expect.objectContaining({
        snapshotId: readiness.snapshotId,
        sourceRevision: readiness.sourceRevision,
      }),
    });
    expect(cart.listCartLines).toHaveBeenCalledWith("acc_buyer");
  });

  it("does not revalidate consumed cart source facts after orders or payment have started", async () => {
    const { eventStore } = createInMemoryEventStore();
    const readiness = createCartReadinessSnapshot([readyCartLine]);
    const cart = createCartServices([]);
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: {
        query: vi.fn(async () => ({
          rows: [createSessionPageRow(readiness, { order_ids: ["ord_1"], payment_id: "pay_1" })],
        })),
      },
      cart: cart as never,
    });

    await expect(services.getSession("chk_1", "acc_buyer" as never)).resolves.toMatchObject({
      order_ids: ["ord_1"],
      payment_id: "pay_1",
    });
    expect(cart.listCartLines).not.toHaveBeenCalled();
  });

  it("rejects an active cart session when the stored readiness snapshot is missing", async () => {
    const { eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [createSessionPageRow(null)] })) },
      cart: createCartServices([readyCartLine]) as never,
    });

    await expect(services.getSession("chk_1", "acc_buyer" as never)).rejects.toMatchObject({
      code: "readiness_snapshot_stale",
      message: "Cart readiness changed. Review your cart before checkout.",
    } satisfies Partial<CheckoutDomainError>);
  });

  it("rejects an active cart session when cart facts changed after checkout started", async () => {
    const { eventStore } = createInMemoryEventStore();
    const readiness = createCartReadinessSnapshot([readyCartLine]);
    const changedLine: CheckoutCartLineRow = {
      ...readyCartLine,
      updated_at: "2026-06-09T00:01:00.000Z",
    };
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [createSessionPageRow(readiness)] })) },
      cart: createCartServices([changedLine]) as never,
    });

    await expect(services.getSession("chk_1", "acc_buyer" as never)).rejects.toMatchObject({
      code: "readiness_snapshot_stale",
      message: "Cart readiness changed. Review your cart before checkout.",
    } satisfies Partial<CheckoutDomainError>);
  });

  it("rejects an active cart session when split-group handoff no longer matches readiness", async () => {
    const { eventStore } = createInMemoryEventStore();
    const readiness = createCartReadinessSnapshot([readyCartLine]);
    const row = createSessionPageRow(readiness, {
      split_group_handoff: {
        status: "ready",
        supportReference: `CS-${readiness.snapshotId.toUpperCase()}`,
        groups: readiness.fulfillmentGroups.map((group) => ({
          ...group,
          lineIds: ["cli_other"],
        })),
      },
    });
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [row] })) },
      cart: createCartServices([readyCartLine]) as never,
    });

    await expect(services.getSession("chk_1", "acc_buyer" as never)).rejects.toMatchObject({
      code: "split_group_handoff_stale",
      message: "Cart readiness changed. Review your cart before checkout.",
    } satisfies Partial<CheckoutDomainError>);
  });

  it("rejects active-session cart readiness that is still unresolved", async () => {
    const unresolvedLine: CheckoutCartLineRow = {
      ...readyCartLine,
      line_id: "cli_unresolved",
      fulfillment_mode: "optimize",
      locked_listing_id: null,
      seller_options: [],
    };
    const { eventStore } = createInMemoryEventStore();
    const readiness = createCartReadinessSnapshot([unresolvedLine]);
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [createSessionPageRow(readiness)] })) },
      cart: createCartServices([unresolvedLine]) as never,
    });

    await expect(services.getSession("chk_1", "acc_buyer" as never)).rejects.toMatchObject({
      code: "unresolved_fulfillment",
      message: "Resolve item availability before checkout starts.",
    } satisfies Partial<CheckoutDomainError>);
  });

  it("revalidates cart split groups before recording orders", async () => {
    const { eventStore } = createInMemoryEventStore();
    const cart = createCartServices([readyCartLine]);
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: cart as never,
    });
    const readiness = createCartReadinessSnapshot([readyCartLine]);
    const created = await services.createFromCart(
      {
        accountId: "acc_buyer" as never,
        readinessSnapshotId: readiness.snapshotId,
        readinessSourceRevision: readiness.sourceRevision,
        sessionIdOverride: "chk_split_revalidate" as never,
      },
      context,
    );
    await services.setShippingAddress(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        shippingAddress: {
          shippingAddressId: "adr_home" as never,
          name: "Jane Smith",
          line1: "100 Market Street",
          line2: null,
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
      },
      context,
    );

    cart.listCartLines.mockResolvedValue([
      {
        ...readyCartLine,
        locked_listing_id: "lst_changed",
        seller_options: [
          {
            ...readyCartLine.seller_options[0]!,
            listing_id: "lst_changed",
          },
        ],
      },
    ]);

    await expect(
      services.assertReadyForOrderCreation({
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
      }),
    ).rejects.toMatchObject({
      code: "readiness_snapshot_stale",
      message: "Cart readiness changed. Review your cart before checkout.",
    } satisfies Partial<CheckoutDomainError>);

    await expect(
      services.recordOrdersCreated(
        {
          sessionId: created.sessionId,
          accountId: "acc_buyer" as never,
          orderIds: ["ord_1"],
          fulfilledLineKeys: ["cli_1"],
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "readiness_snapshot_stale",
      message: "Cart readiness changed. Review your cart before checkout.",
    } satisfies Partial<CheckoutDomainError>);
    expect(cart.removeLine).not.toHaveBeenCalled();
    expect(cart.checkout).not.toHaveBeenCalled();
  });
});
