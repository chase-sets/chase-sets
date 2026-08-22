import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
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
import { cartReadinessDecisionsFromSnapshot, createCartReadinessSnapshot } from "../../cart/domain/readiness";
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

const productMeasureSnapshot = {
  catalogItemId: "cat_1",
  productId: "cat_1::",
  selectedOptions: [],
  measureVersion: "pm_test_raw_v1",
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.02,
  unitWeightOunces: 0.08,
  physicalFlags: ["raw-card"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "measured",
};

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
  selected_listing_id: null,
  selected_listing_seller_account_id: null,
  selected_listing_seller_display_name: null,
  selected_listing_seller_slug: null,
  selected_listing_price_amount: null,
  selected_listing_snapshot_source: null,
  selected_listing_snapshot_captured_at: null,
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
      product_measure_snapshot: productMeasureSnapshot,
    },
  ],
  created_at: "2026-06-09T00:00:00.000Z",
  updated_at: "2026-06-09T00:00:00.000Z",
};

const optimizationCartLine: CheckoutCartLineRow = {
  ...readyCartLine,
  line_id: "cli_optimized",
  locked_listing_id: "lst_expensive",
  seller_options: [
    {
      ...readyCartLine.seller_options[0]!,
      listing_id: "lst_expensive",
      seller_account_id: "acc_current",
      seller_slug: "current-seller",
      seller_display_name: "Current Seller",
      price_amount: "30.00",
    },
    {
      ...readyCartLine.seller_options[0]!,
      listing_id: "lst_lower",
      seller_account_id: "acc_lower",
      seller_slug: "lower-seller",
      seller_display_name: "Lower Seller",
      price_amount: "24.00",
    },
  ],
};

const secondSellerCartLine: CheckoutCartLineRow = {
  ...readyCartLine,
  line_id: "cli_second",
  catalog_catalog_item_id: "cat_2",
  product_id: "cat_2::",
  item_title: "Blastoise",
  locked_listing_id: "lst_second",
  seller_options: [
    {
      ...readyCartLine.seller_options[0]!,
      listing_id: "lst_second",
      seller_account_id: "acc_second_seller",
      seller_slug: "second-seller",
      seller_display_name: "Second Seller",
      price_amount: "10.00",
    },
  ],
};

function createCartServices(lines: readonly CheckoutCartLineRow[] = [readyCartLine]) {
  return {
    listCartLines: vi.fn(async () => lines),
    removeLine: vi.fn(async () => ({ lineId: "cli_1" as never, version: 1 })),
    checkout: vi.fn(async () => ({ version: 1 })),
    createReadinessSnapshot: vi.fn(async () => createCartReadinessSnapshot(lines)),
  };
}

function createUnionCartServices(
  accountLines: readonly CheckoutCartLineRow[],
  anonymousLines: readonly CheckoutCartLineRow[],
  anonymousCartId = "anon_cart_a",
) {
  const resolveLines = (presentedAnonymousCartId?: string | null) => {
    const candidates =
      presentedAnonymousCartId === anonymousCartId ? [...accountLines, ...anonymousLines] : [...accountLines];
    const seen = new Set<string>();
    return candidates.filter((line) => {
      if (seen.has(line.line_id)) {
        return false;
      }
      seen.add(line.line_id);
      return true;
    });
  };
  return {
    listCartLines: vi.fn(async (_accountId: string, presentedAnonymousCartId?: string | null) =>
      resolveLines(presentedAnonymousCartId),
    ),
    removeLine: vi.fn(async ({ lineId }: { lineId: string }) => ({ lineId: lineId as never, version: 1 })),
    checkout: vi.fn(async () => ({ version: 1 })),
    createReadinessSnapshot: vi.fn(async (params: { accountId: string; presentedAnonymousCartId?: string | null }) => {
      const lines = resolveLines(params.presentedAnonymousCartId);
      return createCartReadinessSnapshot(
        lines,
        undefined,
        params.presentedAnonymousCartId
          ? { accountId: params.accountId, presentedAnonymousCartId: params.presentedAnonymousCartId }
          : undefined,
      );
    }),
  };
}

function createBuyNowReadinessDb() {
  return {
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

      if (sql.includes("checkout_marketplace_seller_options")) {
        throw new Error("Buy Now session creation should not depend on checkout marketplace seller options");
      }

      return { rows: [] };
    }),
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
    fulfillment_preview_snapshot: null,
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
    checkout_reservations: [],
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
    order_write_commit_positions: [],
    payment_id: null,
    submitted_offer_id: null,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

const serviceableShippingAddress = {
  shippingAddressId: "adr_home" as never,
  name: "Jane Smith",
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
};

describe("checkout session runtime", () => {
  it("turns a duplicate command with a stale expected version into a typed conflict", async () => {
    const { eventStore } = createInMemoryEventStore();
    const input = {
      streamId: "checkout.session-conflict",
      expectedVersion: "no_stream" as const,
      context,
      events: [{ eventType: "checkout.session.started", payload: {} }],
    };

    await eventStore.appendToStream(input);
    await expect(eventStore.appendToStream(input)).rejects.toMatchObject({
      code: "concurrency_conflict",
      details: { currentVersion: 1 },
    });
  });

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

  it("replays duplicate checkout entry overrides without appending another started event", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: createCartServices() as never,
    });
    const readiness = createCartReadinessSnapshot([readyCartLine]);
    const createInput = {
      accountId: "acc_buyer" as never,
      shippingOption: "standard",
      readinessSnapshotId: readiness.snapshotId,
      readinessSourceRevision: readiness.sourceRevision,
      sessionIdOverride: "chk_entry_replay" as never,
    };

    const first = await services.createFromCart(createInput, context);
    const second = await services.createFromCart(createInput, context);

    expect(second).toEqual(first);
    expect(allEvents.filter((event) => event.eventType === "checkout.session.started")).toHaveLength(1);
  });

  it("issue-6299-acceptance-control returns complete replay metadata for a 501-event session", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: createCartServices() as never,
    });
    const readiness = createCartReadinessSnapshot([readyCartLine]);
    const createInput = {
      accountId: "acc_buyer" as never,
      shippingOption: "standard",
      readinessSnapshotId: readiness.snapshotId,
      readinessSourceRevision: readiness.sourceRevision,
      sessionIdOverride: "chk_complete_replay" as never,
    };
    await services.createFromCart(createInput, context);
    await eventStore.appendToStream({
      streamId: "checkout.session-chk_complete_replay",
      expectedVersion: 1,
      context,
      events: Array.from({ length: 500 }, (_, index) => ({
        eventId: `evt_checkout_history_${index + 2}` as never,
        eventType: "checkout.session.shipping-option-selected",
        payload: {
          sessionId: "chk_complete_replay",
          shippingOption: "standard",
          selectedAt: "2026-06-09T01:00:00.000Z",
        },
      })),
    });

    const replayed = await services.createFromCart(createInput, context);

    expect(replayed.commitEventIds).toHaveLength(501);
    expect(replayed.commitEventIds?.at(-1)).toBe("evt_checkout_history_501");
    expect(replayed.commitPosition).toBe("501");
    expect(allEvents.filter((event) => event.eventType === "checkout.session.started")).toHaveLength(1);
  });

  it("replaces half-confirmed Buy Now entry sessions that never reached payment", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createBuyNowReadinessDb(),
      cart: createCartServices() as never,
    });
    const buyNowInput = {
      accountId: "acc_buyer" as never,
      listingId: "lst_1",
      catalogItemId: "cat_1",
      productId: "cat_1::",
      itemTitle: "Charizard",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
      fulfillmentMode: "locked-listing" as const,
      lockedListingId: "lst_1",
      shippingOption: "standard",
      fulfillmentPreviewRevision: "buy_now_supply_ready",
      sessionIdOverride: "chk_buy_now_stuck_preparing" as never,
    };

    const first = await services.createBuyNow(buyNowInput, context);
    await services.setShippingAddress(
      {
        sessionId: first.sessionId,
        accountId: "acc_buyer" as never,
        shippingAddress: serviceableShippingAddress,
      },
      context,
    );
    await services.recordOrdersCreated(
      {
        sessionId: first.sessionId,
        accountId: "acc_buyer" as never,
        orderIds: ["ord_stuck"],
        fulfilledLineKeys: ["lst_1"],
      },
      context,
    );

    const replacement = await services.createBuyNow(buyNowInput, context);

    expect(replacement.sessionId).toMatch(/^chk_/);
    expect(replacement.sessionId).not.toBe(first.sessionId);
    expect(allEvents.filter((event) => event.eventType === "checkout.session.started")).toHaveLength(2);
    expect(
      allEvents.filter(
        (event) =>
          event.streamId === `checkout.session-${replacement.sessionId}` &&
          event.eventType === "checkout.session.started",
      ),
    ).toHaveLength(1);
  });

  it("rejects unavailable shipping options before mutating the session", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: createCartServices() as never,
    });
    const readiness = createCartReadinessSnapshot([readyCartLine]);
    const created = await services.createFromCart(
      {
        accountId: "acc_buyer" as never,
        shippingOption: "standard",
        readinessSnapshotId: readiness.snapshotId,
        readinessSourceRevision: readiness.sourceRevision,
        sessionIdOverride: "chk_shipping_method" as never,
      },
      context,
    );

    await expect(
      services.selectShippingOption(
        {
          sessionId: created.sessionId,
          accountId: "acc_buyer" as never,
          shippingOption: "overnight",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "shipping_option_unavailable",
      message: "Choose an available shipping method before continuing.",
    } satisfies Partial<CheckoutDomainError>);

    expect(allEvents.filter((event) => event.eventType === "checkout.session.shipping-option-selected")).toHaveLength(
      0,
    );
  });

  it("starts multi-seller cart checkout as one session with readiness-produced support groups", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const cartLines = [readyCartLine, secondSellerCartLine];
    const cart = createCartServices(cartLines);
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: cart as never,
    });
    const readiness = createCartReadinessSnapshot(cartLines);

    const created = await services.createFromCart(
      {
        accountId: "acc_buyer" as never,
        shippingOption: "standard",
        readinessSnapshotId: readiness.snapshotId,
        readinessSourceRevision: readiness.sourceRevision,
        sessionIdOverride: "chk_multi_seller" as never,
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

    expect(allEvents.filter((event) => event.eventType === "checkout.session.started")).toHaveLength(1);
    expect(result.session.session_id).toBe("chk_multi_seller");
    expect(result.session.lines.map((line) => line.cartLineId).sort()).toEqual(["cli_1", "cli_second"]);
    expect(result.session.split_group_handoff).toMatchObject({
      status: "ready",
      supportReference: `CS-${readiness.snapshotId.toUpperCase()}`,
    });
    expect(result.session.split_group_handoff?.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lineIds: ["cli_1"],
          listingIds: ["lst_1"],
          sellerAccountId: "acc_seller",
          sellerDisplayName: "Card Vault",
          downstreamReferenceStatus: "not-started",
          supportReference: expect.stringMatching(/^CSG-/),
        }),
        expect.objectContaining({
          lineIds: ["cli_second"],
          listingIds: ["lst_second"],
          sellerAccountId: "acc_second_seller",
          sellerDisplayName: "Second Seller",
          downstreamReferenceStatus: "not-started",
          supportReference: expect.stringMatching(/^CSG-/),
        }),
      ]),
    );
  });

  it.each([
    {
      name: "anonymous-only",
      accountLines: [] as CheckoutCartLineRow[],
      anonymousLines: [{ ...readyCartLine, buyer_account_id: "anon_raw_marker" }],
      expectedLineIds: ["cli_1"],
      expectedError: null,
    },
    {
      name: "distinct Account and anonymous lines",
      accountLines: [readyCartLine],
      anonymousLines: [
        { ...secondSellerCartLine, buyer_account_id: "anon_raw_marker", product_id: readyCartLine.product_id },
      ],
      expectedLineIds: ["cli_1", "cli_second"],
      expectedError: null,
    },
    {
      name: "empty exact union",
      accountLines: [] as CheckoutCartLineRow[],
      anonymousLines: [] as CheckoutCartLineRow[],
      expectedLineIds: [] as string[],
      expectedError: "cart_empty",
    },
  ])("creates the expected buyer-bound cart session for $name", async (testCase) => {
    const anonymousCartId = "anon_raw_marker";
    const cart = createUnionCartServices(testCase.accountLines, testCase.anonymousLines, anonymousCartId);
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: cart as never,
    });
    const unionLines = [...testCase.accountLines, ...testCase.anonymousLines].filter(
      (line, index, lines) => lines.findIndex((candidate) => candidate.line_id === line.line_id) === index,
    );
    const readiness = createCartReadinessSnapshot(unionLines, undefined, {
      accountId: "acc_buyer",
      presentedAnonymousCartId: anonymousCartId,
    });
    const create = () =>
      services.createFromCart(
        {
          accountId: "acc_buyer" as never,
          presentedAnonymousCartId: anonymousCartId,
          readinessSnapshotId: readiness.snapshotId,
          readinessSourceRevision: readiness.sourceRevision,
          sessionIdOverride: `chk_union_${testCase.name.replaceAll(" ", "_")}` as never,
        },
        context,
      );

    if (testCase.expectedError) {
      await expect(create()).rejects.toMatchObject({ code: testCase.expectedError });
      expect(allEvents).toEqual([]);
      return;
    }

    const created = await create();
    const result = await services.selectShippingOption(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        shippingOption: "priority",
      },
      context,
    );
    const publicRowJson = JSON.stringify(result.session);
    const startedEvent = allEvents.find((event) => event.eventType === "checkout.session.started");

    expect(result.session.buyer_account_id).toBe("acc_buyer");
    expect(result.session.lines.map((line) => line.cartLineId).sort()).toEqual([...testCase.expectedLineIds].sort());
    expect(startedEvent?.payload).toMatchObject({ presentedAnonymousCartId: anonymousCartId });
    expect(publicRowJson).not.toContain(anonymousCartId);
    expect(publicRowJson).not.toContain("presentedAnonymousCartId");
  });

  it("rejects missing or different union authority before appending a session-start event", async () => {
    const anonymousCartId = "anon_cart_a";
    const accountLine = readyCartLine;
    const anonymousDuplicate = {
      ...readyCartLine,
      buyer_account_id: anonymousCartId,
      updated_at: "2026-07-01T00:00:00.000Z",
    };
    const cart = createUnionCartServices([accountLine], [anonymousDuplicate], anonymousCartId);
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: cart as never,
    });
    const readiness = createCartReadinessSnapshot([accountLine], undefined, {
      accountId: "acc_buyer",
      presentedAnonymousCartId: anonymousCartId,
    });
    const input = {
      accountId: "acc_buyer" as never,
      readinessSnapshotId: readiness.snapshotId,
      readinessSourceRevision: readiness.sourceRevision,
    };

    await expect(services.createFromCart(input, context)).rejects.toMatchObject({
      code: "readiness_snapshot_stale",
    });
    await expect(
      services.createFromCart({ ...input, presentedAnonymousCartId: "anon_cart_b" }, context),
    ).rejects.toMatchObject({ code: "readiness_snapshot_stale" });
    expect(allEvents).toEqual([]);
  });

  it("uses persisted union provenance for all four active revalidation callers", async () => {
    const anonymousCartId = "anon_raw_marker";
    const anonymousLine = { ...readyCartLine, buyer_account_id: anonymousCartId };
    const cart = createUnionCartServices([], [anonymousLine], anonymousCartId);
    const { eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: cart as never,
    });
    const readiness = createCartReadinessSnapshot([anonymousLine], undefined, {
      accountId: "acc_buyer",
      presentedAnonymousCartId: anonymousCartId,
    });
    const sessionIds = {
      assert: "chk_union_assert",
      reservations: "chk_union_reservations",
      orders: "chk_union_orders",
      get: "chk_union_get",
    } as const;
    for (const sessionId of Object.values(sessionIds)) {
      await services.createFromCart(
        {
          accountId: "acc_buyer" as never,
          presentedAnonymousCartId: anonymousCartId,
          readinessSnapshotId: readiness.snapshotId,
          readinessSourceRevision: readiness.sourceRevision,
          sessionIdOverride: sessionId as never,
        },
        context,
      );
    }
    for (const sessionId of [sessionIds.assert, sessionIds.orders]) {
      await services.setShippingAddress(
        { sessionId, accountId: "acc_buyer" as never, shippingAddress: serviceableShippingAddress },
        context,
      );
    }
    cart.listCartLines.mockClear();

    await services.assertReadyForOrderCreation({
      sessionId: sessionIds.assert,
      accountId: "acc_buyer" as never,
    });
    await services.recordCheckoutReservations(
      { sessionId: sessionIds.reservations, accountId: "acc_buyer" as never, reservations: [] },
      context,
    );
    await services.recordOrdersCreated(
      {
        sessionId: sessionIds.orders,
        accountId: "acc_buyer" as never,
        orderIds: ["ord_union"],
        fulfilledLineKeys: ["cli_1"],
      },
      context,
    );
    await services.getSession(sessionIds.get, "acc_buyer");

    expect(cart.listCartLines).toHaveBeenCalledTimes(4);
    expect(cart.listCartLines.mock.calls).toEqual(Array.from({ length: 4 }, () => ["acc_buyer", anonymousCartId]));
  });

  it("keeps union revalidation valid across copy relocation and stales on a winning-line change", async () => {
    const anonymousCartId = "anon_cart_relocation";
    const anonymousLine = { ...readyCartLine, buyer_account_id: anonymousCartId };
    const cart = createUnionCartServices([], [anonymousLine], anonymousCartId);
    const { eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: cart as never,
    });
    const readiness = createCartReadinessSnapshot([anonymousLine], undefined, {
      accountId: "acc_buyer",
      presentedAnonymousCartId: anonymousCartId,
    });
    await services.createFromCart(
      {
        accountId: "acc_buyer" as never,
        presentedAnonymousCartId: anonymousCartId,
        readinessSnapshotId: readiness.snapshotId,
        readinessSourceRevision: readiness.sourceRevision,
        sessionIdOverride: "chk_union_relocation" as never,
      },
      context,
    );
    const relocatedLine = {
      ...anonymousLine,
      buyer_account_id: "acc_buyer",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    };
    cart.listCartLines.mockResolvedValue([relocatedLine]);

    await expect(services.getSession("chk_union_relocation", "acc_buyer")).resolves.toMatchObject({
      session_id: "chk_union_relocation",
    });

    cart.listCartLines.mockResolvedValue([
      {
        ...relocatedLine,
        quantity: 2,
        seller_options: relocatedLine.seller_options.map((option) => ({ ...option, available_quantity: 2 })),
      },
    ]);
    await expect(services.getSession("chk_union_relocation", "acc_buyer")).rejects.toMatchObject({
      code: "readiness_snapshot_stale",
    });
  });

  it("can update a just-created Buy Now session before checkout_session_pages has projected it", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = createBuyNowReadinessDb();
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
        fulfillmentPreviewRevision: "buy_now_supply_ready",
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
    expect(result.session.fulfillment_preview_revision).toBeNull();
    expect(result.session.fulfillment_preview_snapshot).toBeNull();
    expect(result.session.payment_id).toBeNull();
    expect(result.session.order_ids).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("checkout_catalog_items");
  });

  it("reads a committed Buy Now session from the aggregate when checkout_session_pages has not projected it", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
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
        fulfillmentPreviewRevision: "buy_now_supply_ready",
        sessionIdOverride: "chk_buy_now_projection_missing" as never,
      },
      context,
    );
    await services.setShippingAddress(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        shippingAddress: serviceableShippingAddress,
      },
      context,
    );
    await services.recordOrdersCreated(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1"],
        fulfilledLineKeys: ["lst_1"],
        orderWriteCommitPositions: [
          {
            sourceContextName: "ordering",
            maxGlobalPosition: "42",
            eventIds: ["evt_order_created"],
          },
        ],
      },
      context,
    );

    await expect(services.getSession(created.sessionId, "acc_buyer" as never)).resolves.toMatchObject({
      session_id: "chk_buy_now_projection_missing",
      source_type: "buy-now",
      order_ids: ["ord_1"],
      order_write_commit_positions: [
        {
          sourceContextName: "ordering",
          maxGlobalPosition: "42",
          eventIds: ["evt_order_created"],
        },
      ],
      payment_id: null,
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("checkout_session_pages"), [
      "chk_buy_now_projection_missing",
      "acc_buyer",
    ]);
  });

  it("prefers aggregate committed order state when checkout_session_pages is behind", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
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

        if (sql.includes("checkout_session_pages")) {
          return {
            rows: [
              createSessionPageRow(null, {
                session_id: String(params?.[0] ?? "chk_buy_now_projection_stale"),
                buyer_account_id: String(params?.[1] ?? "acc_buyer"),
                source_type: "buy-now",
                fulfillment_preview_revision: "buy_now_supply_ready",
                shipping_address_id: serviceableShippingAddress.shippingAddressId,
                shipping_address: serviceableShippingAddress,
                order_ids: [],
                order_write_commit_positions: [],
              }),
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
        fulfillmentPreviewRevision: "buy_now_supply_ready",
        sessionIdOverride: "chk_buy_now_projection_stale" as never,
      },
      context,
    );
    await services.setShippingAddress(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        shippingAddress: serviceableShippingAddress,
      },
      context,
    );
    await services.recordOrdersCreated(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1"],
        fulfilledLineKeys: ["lst_1"],
        orderWriteCommitPositions: [
          {
            sourceContextName: "ordering",
            maxGlobalPosition: "42",
            eventIds: ["evt_order_created"],
          },
        ],
      },
      context,
    );

    await expect(services.getSession(created.sessionId, "acc_buyer" as never)).resolves.toMatchObject({
      session_id: "chk_buy_now_projection_stale",
      source_type: "buy-now",
      order_ids: ["ord_1"],
      order_write_commit_positions: [
        {
          sourceContextName: "ordering",
          maxGlobalPosition: "42",
          eventIds: ["evt_order_created"],
        },
      ],
      payment_id: null,
    });
  });

  it("rejects buy-now session creation when fulfillment is not assigned", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db,
      cart: createCartServices() as never,
    });

    await expect(
      services.createBuyNow(
        {
          accountId: "acc_buyer" as never,
          listingId: "",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
          fulfillmentMode: "optimize",
          lockedListingId: null,
          shippingOption: "standard",
          fulfillmentPreviewRevision: "buy_now_supply_ready",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "unresolved_fulfillment",
      message: "Resolve item availability before checkout starts.",
    } satisfies Partial<CheckoutDomainError>);

    expect(db.query).not.toHaveBeenCalled();
    expect(allEvents).toEqual([]);
  });

  it.each([
    {
      name: "stale handoff ids",
      input: { listingId: "lst_stale", lockedListingId: "lst_1", fulfillmentPreviewRevision: "buy_now_supply_ready" },
      expected: {
        code: "readiness_snapshot_stale",
        message: "Selected listing changed. Review item availability before checkout.",
      },
    },
    {
      name: "missing Ordering preview revision",
      input: { fulfillmentPreviewRevision: "" },
      expected: {
        code: "unresolved_fulfillment",
        message: "Resolve item availability before checkout starts.",
      },
    },
  ] as const)("fails closed before starting Buy Now when $name", async (testCase) => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = createBuyNowReadinessDb();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db,
      cart: createCartServices() as never,
    });
    const input = testCase.input as Partial<{
      listingId: string;
      lockedListingId: string;
      quantity: number;
      fulfillmentPreviewRevision: string;
    }>;

    await expect(
      services.createBuyNow(
        {
          accountId: "acc_buyer" as never,
          listingId: input.listingId ?? "lst_1",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: input.quantity ?? 1,
          fulfillmentMode: "locked-listing",
          lockedListingId: input.lockedListingId ?? "lst_1",
          shippingOption: "standard",
          fulfillmentPreviewRevision: input.fulfillmentPreviewRevision ?? "buy_now_supply_ready",
        },
        context,
      ),
    ).rejects.toMatchObject(testCase.expected satisfies Partial<CheckoutDomainError>);

    expect(allEvents).toEqual([]);
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

  it.each([
    {
      decision: "accepted",
      expectedListingId: "lst_lower",
      expectedSellerAccountId: "acc_lower",
    },
    {
      decision: "declined",
      expectedListingId: "lst_expensive",
      expectedSellerAccountId: "acc_current",
    },
  ] as const)(
    "starts cart checkout with a pre-checkout optimization decision: $decision",
    async ({ decision, expectedListingId, expectedSellerAccountId }) => {
      const { eventStore } = createInMemoryEventStore();
      const cart = createCartServices([optimizationCartLine]);
      const services = createCheckoutSessionRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: { query: vi.fn(async () => ({ rows: [] })) },
        cart: cart as never,
      });
      const readiness = createCartReadinessSnapshot([optimizationCartLine], {
        optimization: { decision, lineId: "cli_optimized", listingId: "lst_lower" },
      });

      const created = await services.createFromCart(
        {
          accountId: "acc_buyer" as never,
          readinessSnapshotId: readiness.snapshotId,
          readinessSourceRevision: readiness.sourceRevision,
          readinessDecisions: cartReadinessDecisionsFromSnapshot(readiness),
          sessionIdOverride: `chk_optimization_${decision}` as never,
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

      expect(cart.listCartLines).toHaveBeenCalledWith("acc_buyer");
      expect(result.session.cart_readiness_snapshot).toMatchObject({
        optimization: {
          decision,
          proposedLineId: "cli_optimized",
          proposedListingId: "lst_lower",
          currentListingId: "lst_expensive",
        },
      });
      expect(result.session.lines).toEqual([
        expect.objectContaining({
          cartLineId: "cli_optimized",
          listingId: expectedListingId,
          lockedListingId: expectedListingId,
          fulfillmentMode: "locked-listing",
        }),
      ]);
      expect(result.session.split_group_handoff?.groups).toEqual([
        expect.objectContaining({
          lineIds: ["cli_optimized"],
          listingIds: [expectedListingId],
          sellerAccountId: expectedSellerAccountId,
          downstreamReferenceStatus: "not-started",
        }),
      ]);
    },
  );

  it.each(["accepted", "declined"] as const)(
    "fails closed before checkout starts when cart facts change after a %s optimization decision",
    async (decision) => {
      const staleReadiness = createCartReadinessSnapshot([optimizationCartLine], {
        optimization: { decision, lineId: "cli_optimized", listingId: "lst_lower" },
      });
      const changedCartLine: CheckoutCartLineRow = {
        ...optimizationCartLine,
        seller_options: optimizationCartLine.seller_options.map((sellerOption) =>
          sellerOption.listing_id === "lst_lower"
            ? {
                ...sellerOption,
                price_amount: "23.00",
              }
            : sellerOption,
        ),
      };
      const { allEvents, eventStore } = createInMemoryEventStore();
      const services = createCheckoutSessionRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: { query: vi.fn(async () => ({ rows: [] })) },
        cart: createCartServices([changedCartLine]) as never,
      });

      await expect(
        services.createFromCart(
          {
            accountId: "acc_buyer" as never,
            readinessSnapshotId: staleReadiness.snapshotId,
            readinessSourceRevision: staleReadiness.sourceRevision,
            readinessDecisions: cartReadinessDecisionsFromSnapshot(staleReadiness),
            sessionIdOverride: `chk_optimization_stale_${decision}` as never,
          },
          context,
        ),
      ).rejects.toMatchObject({
        code: "readiness_snapshot_stale",
        message: "Cart readiness changed. Review your cart before checkout.",
      } satisfies Partial<CheckoutDomainError>);
      expect(allEvents).toEqual([]);
    },
  );

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

  it.each([
    { state: "orders", overrides: { order_ids: ["ord_1"] } },
    { state: "payment", overrides: { payment_id: "pay_1" } },
    { state: "cancellation", overrides: { cancelled_at: "2026-06-09T01:00:00.000Z" } },
  ])("does not revalidate cart source facts after $state", async ({ overrides }) => {
    const { eventStore } = createInMemoryEventStore();
    const readiness = createCartReadinessSnapshot([readyCartLine]);
    const cart = createCartServices([]);
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: {
        query: vi.fn(async () => ({
          rows: [createSessionPageRow(readiness, overrides)],
        })),
      },
      cart: cart as never,
    });

    await expect(services.getSession("chk_1", "acc_buyer" as never)).resolves.toMatchObject(overrides);
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

  it("rejects order handoff when session lines have unassigned fulfillment", async () => {
    const { eventStore } = createInMemoryEventStore();
    const cart = createCartServices([readyCartLine]);
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: cart as never,
    });
    await services.commandHandler({
      streamId: "checkout.session-chk_unassigned",
      command: {
        type: "StartCheckoutSession",
        sessionId: "chk_unassigned" as never,
        buyerAccountId: "acc_buyer" as never,
        sourceType: "buy-now",
        shippingOption: "standard",
        lines: [
          {
            listingId: null,
            cartLineId: null,
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            quantity: 1,
            fulfillmentMode: "optimize",
            lockedListingId: null,
            availabilityState: "available",
          },
        ],
        createdAt: "2026-06-09T00:00:00.000Z",
      },
      context,
    });
    await services.setShippingAddress(
      {
        sessionId: "chk_unassigned",
        accountId: "acc_buyer" as never,
        shippingAddress: serviceableShippingAddress,
      },
      context,
    );

    await expect(
      services.assertReadyForOrderCreation({
        sessionId: "chk_unassigned",
        accountId: "acc_buyer" as never,
      }),
    ).rejects.toMatchObject({
      code: "unresolved_fulfillment",
      message: "Resolve item availability before checkout starts.",
    } satisfies Partial<CheckoutDomainError>);

    await expect(
      services.recordOrdersCreated(
        {
          sessionId: "chk_unassigned",
          accountId: "acc_buyer" as never,
          orderIds: ["ord_1"],
          fulfilledLineKeys: [],
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "unresolved_fulfillment",
    } satisfies Partial<CheckoutDomainError>);
    expect(cart.removeLine).not.toHaveBeenCalled();
    expect(cart.checkout).not.toHaveBeenCalled();
  });

  it("blocks unsupported delivery regions before order creation", async () => {
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
        sessionIdOverride: "chk_address_unsupported" as never,
      },
      context,
    );
    await services.setShippingAddress(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        shippingAddress: {
          ...serviceableShippingAddress,
          state: "PR",
          postalCode: "00901",
        },
      },
      context,
    );

    await expect(
      services.assertReadyForOrderCreation({
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
      }),
    ).rejects.toMatchObject({
      code: "shipping_address_unsupported",
      message: "This delivery region is not supported for checkout yet. Use a supported US delivery address.",
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
      code: "shipping_address_unsupported",
    } satisfies Partial<CheckoutDomainError>);
    expect(cart.removeLine).not.toHaveBeenCalled();
    expect(cart.checkout).not.toHaveBeenCalled();
  });

  it("blocks unsupported delivery countries before order creation", async () => {
    const { eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: createCartServices([readyCartLine]) as never,
    });
    const readiness = createCartReadinessSnapshot([readyCartLine]);
    const created = await services.createFromCart(
      {
        accountId: "acc_buyer" as never,
        readinessSnapshotId: readiness.snapshotId,
        readinessSourceRevision: readiness.sourceRevision,
        sessionIdOverride: "chk_address_unsupported_country" as never,
      },
      context,
    );
    await services.setShippingAddress(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        shippingAddress: {
          ...serviceableShippingAddress,
          country: "CA",
        },
      },
      context,
    );

    await expect(
      services.assertReadyForOrderCreation({
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
      }),
    ).rejects.toMatchObject({
      code: "shipping_address_unsupported",
      message: "This delivery region is not supported for checkout yet. Use a supported US delivery address.",
    } satisfies Partial<CheckoutDomainError>);
  });

  it("blocks incomplete delivery addresses before order creation", async () => {
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
        sessionIdOverride: "chk_address_required" as never,
      },
      context,
    );
    await expect(
      services.setShippingAddress(
        {
          sessionId: created.sessionId,
          accountId: "acc_buyer" as never,
          shippingAddress: {
            ...serviceableShippingAddress,
            postalCode: "",
          },
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "shipping_address_required",
      message: "Confirm the shipping address before creating orders.",
    } satisfies Partial<CheckoutDomainError>);

    expect(cart.removeLine).not.toHaveBeenCalled();
    expect(cart.checkout).not.toHaveBeenCalled();
  });

  it("blocks PO box delivery addresses before order creation", async () => {
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
        sessionIdOverride: "chk_address_restricted" as never,
      },
      context,
    );
    await services.setShippingAddress(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        shippingAddress: {
          ...serviceableShippingAddress,
          line1: "PO Box 100",
        },
      },
      context,
    );

    await expect(
      services.assertReadyForOrderCreation({
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
      }),
    ).rejects.toMatchObject({
      code: "shipping_address_restricted",
      message:
        "This delivery address is not supported for the selected shipping service. Use a street address before paying.",
    } satisfies Partial<CheckoutDomainError>);

    expect(cart.removeLine).not.toHaveBeenCalled();
    expect(cart.checkout).not.toHaveBeenCalled();
  });
});
