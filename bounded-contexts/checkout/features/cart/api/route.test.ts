import {
  createAccountUserTestActor,
  createTestApp,
  type TestActorOverrides,
} from "@chase-sets/bounded-context-runtime/test-support";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutApiEnv } from "../../../api";
import type {
  CheckoutObservabilityTelemetry,
  CheckoutObservabilityTelemetryEvent,
} from "../../sessions/api/checkout-observability-telemetry";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import { createAccountCartRoutes, createGuestCartRoutes } from "./route";
import type { CheckoutCartLineRow } from "../read-model/queries";
import { createCheckoutCartRuntime, type CheckoutCartServices } from "./runtime";

function buildApp(
  options: Readonly<{
    actor: CheckoutApiEnv["Variables"]["actor"];
    services: CheckoutCartServices;
    checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry;
  }>,
) {
  return createTestApp<CheckoutApiEnv>({
    actor: options.actor,
    routes: (app) => {
      app.route("/account", createAccountCartRoutes(options.services, options.checkoutObservabilityTelemetry));
      app.route("/guest", createGuestCartRoutes(options.services, options.checkoutObservabilityTelemetry));
    },
  });
}

function createServices(): CheckoutCartServices {
  return {
    commandHandler: vi.fn() as never,
    addLine: vi.fn<CheckoutCartServices["addLine"]>(async () => ({
      lineId: "cli_1" as never,
      version: 1,
      status: "added",
    })),
    addLines: vi.fn<CheckoutCartServices["addLines"]>(async () => ({
      requestedLineCount: 2,
      addedLineCount: 1,
      mergedLineCount: 1,
      failedLineCount: 0,
      lines: [
        { index: 0, lineId: "cli_1" as never, status: "added", message: null },
        { index: 1, lineId: "cli_2" as never, status: "merged", message: null },
      ],
    })),
    setLineQuantity: vi.fn(async () => ({ lineId: "cli_1" as never, version: 2 })),
    setLineFulfillment: vi.fn(async () => ({ lineId: "cli_1" as never, version: 4 })),
    removeLine: vi.fn(async () => ({ lineId: "cli_1" as never, version: 3 })),
    checkout: vi.fn(async () => ({ version: 5 })),
    claimCart: vi.fn(async () => ({ version: 1 })),
    listCartLines: vi.fn(async () => []),
    resolveCartSourceAuthority: vi.fn<CheckoutCartServices["resolveCartSourceAuthority"]>(async () => ({
      status: "accepted",
      acceptedVia: "possession",
    })),
    listAuthorizedCartLines: vi.fn<CheckoutCartServices["listAuthorizedCartLines"]>(async () => []),
    listClaimedOwnerKeys: vi.fn(async () => []),
    mergeCartIntoAccount: vi.fn<CheckoutCartServices["mergeCartIntoAccount"]>(async () => ({ mergedLineCount: 0 })),
    createReadinessSnapshot: vi.fn<CheckoutCartServices["createReadinessSnapshot"]>(async () => ({
      schemaVersion: "checkout.cart-readiness.v1",
      source: "cart",
      sourceRevision: "cr_source",
      snapshotId: "cr_ready",
      status: "ready",
      lineCount: 1,
      includedLineIds: ["cli_1"],
      unresolvedLineIds: [],
      lineOutcomes: [{ lineId: "cli_1", outcome: "checkout", reason: "ready" }],
      optimization: {
        available: false,
        decision: "none",
        proposedLineId: null,
        proposedListingId: null,
        currentListingId: null,
        savingsAmount: null,
        currency: "USD",
      },
      fulfillmentGroups: [],
      customerSafeFacts: ["Ready for checkout."],
    })),
    projectors: [],
  } satisfies CheckoutCartServices;
}

function accountCartActor(overrides: TestActorOverrides = {}): NonNullable<CheckoutApiEnv["Variables"]["actor"]> {
  return createAccountUserTestActor({
    sessionId: "ses_1",
    userId: "usr_1",
    accountId: "acc_buyer",
    membershipId: "mbr_1",
    permissions: ["orders.view", "orders.manage"],
    ...overrides,
  }) as NonNullable<CheckoutApiEnv["Variables"]["actor"]>;
}

function guestCheckoutActor(): NonNullable<CheckoutApiEnv["Variables"]["actor"]> {
  return createAccountUserTestActor({
    sessionId: "guest:tok_1",
    userId: "usr_guest_checkout",
    accountId: "acc_guest",
    membershipId: "guest:tok_1",
    roleKey: "guest-buyer",
    permissions: ["guest-checkout.manage"],
  }) as NonNullable<CheckoutApiEnv["Variables"]["actor"]>;
}

function cartLine(index: number) {
  return {
    line_id: `cli_${index}`,
    catalog_catalog_item_id: `cat_${index}`,
    product_id: `cat_${index}::form=raw`,
    quantity: 1,
    fulfillment_mode: "optimize",
    locked_listing_id: null,
    seller_preference_id: null,
  };
}

/**
 * A complete internal Cart line row, typed against the real read-model shape.
 *
 * Route reads project rows onto the public contract, so a hand-shrunk stub
 * would exercise a row the projection can never produce. Deriving from the real
 * type keeps these tests honest about what the boundary actually receives.
 */
function internalCartLineRow(overrides: Partial<CheckoutCartLineRow> = {}): CheckoutCartLineRow {
  return {
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
        product_measure_snapshot: { measureVersion: "pm_1" },
      },
    ],
    created_at: "2026-09-05T00:00:00.000Z",
    updated_at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function collectCheckoutObservabilityEvents() {
  const events: CheckoutObservabilityTelemetryEvent[] = [];
  const telemetry: CheckoutObservabilityTelemetry = {
    recordCheckoutEvent: vi.fn((event) => {
      events.push(event);
    }),
  };

  return { events, telemetry };
}

describe("checkout cart routes", () => {
  it("counts cart item quantities instead of raw cart lines", async () => {
    const services = createServices();
    vi.mocked(services.listAuthorizedCartLines).mockResolvedValue([
      internalCartLineRow({ line_id: "cli_1", quantity: 2 }),
      internalCartLineRow({ line_id: "cli_2", quantity: 3 }),
    ]);
    const app = buildApp({
      actor: accountCartActor(),
      services,
    });

    const response = await app.fetch(new Request("http://checkout.test/account/cart"));

    await expect(response.json()).resolves.toMatchObject({
      count: 5,
    });
  });

  it("lets guest checkout actors read their merged account cart", async () => {
    const services = createServices();
    vi.mocked(services.listAuthorizedCartLines).mockResolvedValue([internalCartLineRow({ line_id: "cli_1" })]);
    const app = buildApp({
      actor: guestCheckoutActor(),
      services,
    });

    const response = await app.fetch(new Request("http://checkout.test/account/cart"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      count: 1,
    });
    expect(services.listAuthorizedCartLines).toHaveBeenCalledWith({ accountId: "acc_guest" });
  });

  it("adds a browsed marketplace item to the current account cart", async () => {
    const services = createServices();
    const app = buildApp({
      actor: accountCartActor(),
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          itemSubtitle: "Base Set 4/102 Holo Rare",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Form: Raw",
          quantity: 2,
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "cli_1",
      version: 1,
      status: "added",
    });
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_buyer",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form=raw",
        quantity: 2,
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_buyer",
          performedByUserId: "usr_1",
        }),
      }),
    );
  });

  it("passes selected listing snapshots through account cart adds", async () => {
    const services = createServices();
    const app = buildApp({
      actor: accountCartActor(),
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Form: Raw",
          quantity: 1,
          fulfillmentMode: "locked-listing",
          lockedListingId: "lst_card_vault",
          sellerPreferenceId: "lst_card_vault",
          selectedListingSnapshot: {
            listingId: "lst_card_vault",
            sellerAccountId: "acc_card_vault",
            sellerDisplayName: "Card Vault",
            sellerSlug: "card-vault",
            priceAmount: "389.00",
            source: "discovery.item-detail.add-to-cart",
          },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        lockedListingId: "lst_card_vault",
        sellerPreferenceId: "lst_card_vault",
        selectedListingSnapshot: {
          listingId: "lst_card_vault",
          sellerAccountId: "acc_card_vault",
          sellerDisplayName: "Card Vault",
          sellerSlug: "card-vault",
          priceAmount: "389.00",
          source: "discovery.item-detail.add-to-cart",
        },
      }),
      expect.anything(),
    );
  });

  it("creates a signed-in cart readiness snapshot with customer decisions", async () => {
    const services = createServices();
    const app = buildApp({
      actor: accountCartActor({ permissions: [] }),
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/cart/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      readiness: { snapshotId: "cr_ready", status: "ready" },
    });
    expect(services.createReadinessSnapshot).toHaveBeenCalledWith({
      accountId: "acc_buyer",
      decisions: {
        lineOutcomes: [],
        optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" },
      },
    });
  });

  it("passes a normalized presented anonymous cart key without exposing it in the response or telemetry", async () => {
    const services = createServices();
    const { events, telemetry } = collectCheckoutObservabilityEvents();
    const app = buildApp({
      actor: accountCartActor({ permissions: [] }),
      services,
      checkoutObservabilityTelemetry: telemetry,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/cart/readiness", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-cart-id": "  anon_raw_marker  ",
          "x-account-id": "acc_attacker",
        },
        body: JSON.stringify({ accountId: "acc_attacker" }),
      }),
    );
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(services.createReadinessSnapshot).toHaveBeenCalledWith({
      accountId: "acc_buyer",
      presentedAnonymousCartId: "anon_raw_marker",
      decisions: { lineOutcomes: [], optimization: null },
    });
    expect(responseText).not.toContain("anon_raw_marker");
    expect(JSON.stringify(events)).not.toContain("anon_raw_marker");
  });

  it.each(["   ", "cart_not_anonymous"])(
    "keeps Account readiness account-only for malformed anonymous header %j",
    async (headerValue) => {
      const services = createServices();
      const app = buildApp({ actor: accountCartActor({ permissions: [] }), services });

      const response = await app.fetch(
        new Request("http://checkout.test/account/cart/readiness", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-checkout-anonymous-cart-id": headerValue,
          },
          body: JSON.stringify({}),
        }),
      );

      expect(response.status).toBe(200);
      expect(services.createReadinessSnapshot).toHaveBeenCalledWith({
        accountId: "acc_buyer",
        decisions: { lineOutcomes: [], optimization: null },
      });
    },
  );

  it("does not resolve readiness without an actor or request context", async () => {
    const unauthenticatedServices = createServices();
    const unauthenticated = buildApp({ actor: null, services: unauthenticatedServices });
    const request = () =>
      new Request("http://checkout.test/account/cart/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-checkout-anonymous-cart-id": "anon_raw_marker" },
        body: JSON.stringify({}),
      });

    expect((await unauthenticated.fetch(request())).status).toBe(401);
    expect(unauthenticatedServices.createReadinessSnapshot).not.toHaveBeenCalled();

    const missingContextServices = createServices();
    const missingContext = new Hono<CheckoutApiEnv>();
    missingContext.use("*", async (c, next) => {
      c.set("actor", accountCartActor({ permissions: [] }));
      c.set("context", null);
      await next();
    });
    missingContext.route("/account", createAccountCartRoutes(missingContextServices));

    expect((await missingContext.fetch(request())).status).toBe(401);
    expect(missingContextServices.createReadinessSnapshot).not.toHaveBeenCalled();
  });

  it("creates a guest checkout account cart readiness snapshot after anonymous cart merge", async () => {
    const services = createServices();
    const app = buildApp({
      actor: guestCheckoutActor(),
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/cart/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      readiness: { snapshotId: "cr_ready", status: "ready" },
    });
    expect(services.createReadinessSnapshot).toHaveBeenCalledWith({
      accountId: "acc_guest",
      decisions: {
        lineOutcomes: [],
        optimization: null,
      },
    });
  });

  it("emits redacted readiness telemetry when fulfillment is unresolved before checkout", async () => {
    const services = createServices();
    vi.mocked(services.createReadinessSnapshot).mockResolvedValue({
      schemaVersion: "checkout.cart-readiness.v1",
      source: "cart",
      sourceRevision: "cr_source_sensitive",
      snapshotId: "cr_unassigned_sensitive",
      status: "needs-resolution",
      lineCount: 1,
      includedLineIds: [],
      unresolvedLineIds: ["cli_unassigned_sensitive"],
      lineOutcomes: [
        {
          lineId: "cli_unassigned_sensitive",
          outcome: "checkout",
          reason: "unassigned-fulfillment",
        },
      ],
      optimization: {
        available: false,
        decision: "none",
        proposedLineId: null,
        proposedListingId: null,
        currentListingId: null,
        savingsAmount: null,
        currency: "USD",
      },
      fulfillmentGroups: [],
      customerSafeFacts: ["Some cart items need attention before checkout."],
    });
    const { events, telemetry } = collectCheckoutObservabilityEvents();
    const app = buildApp({
      actor: accountCartActor({
        sessionId: "ses_sensitive",
        accountId: "acc_buyer_sensitive",
        permissions: [],
      }),
      services,
      checkoutObservabilityTelemetry: telemetry,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/cart/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventName: "checkout.readiness.unassigned_fulfillment",
      telemetryClass: "readiness",
      alertClass: "support-alert",
      entrySource: "buy-cart-readiness",
      actorMode: "signed-in",
      scenarioState: "unassigned-fulfillment",
      visibleState: "cart-readiness-recovery-visible",
      sideEffectStatus: "not-attempted",
      readinessContract: "checkout.cart-readiness.v1",
      readinessSnapshotState: "needs-resolution",
      sourceRevisionState: "current",
      performanceBudgetId: "buy-cart-readiness-evaluation",
      providerCategory: "fulfillment",
      downstreamStatus: "not-started",
      capabilityDecision: "blocked",
      operatorSignalRequired: true,
    });
    expect(JSON.stringify(events)).not.toContain("acc_buyer_sensitive");
    expect(JSON.stringify(events)).not.toContain("ses_sensitive");
    expect(JSON.stringify(events)).not.toContain("cr_unassigned_sensitive");
    expect(JSON.stringify(events)).not.toContain("cr_source_sensitive");
    expect(JSON.stringify(events)).not.toContain("cli_unassigned_sensitive");
  });

  it.each(["accepted", "declined"] as const)(
    "emits redacted readiness telemetry for guest optimization %s before checkout",
    async (decision) => {
      const services = createServices();
      vi.mocked(services.createReadinessSnapshot).mockResolvedValue({
        schemaVersion: "checkout.cart-readiness.v1",
        source: "cart",
        sourceRevision: "cr_source_optimization",
        snapshotId: "cr_optimization_sensitive",
        status: "ready",
        lineCount: 1,
        includedLineIds: ["cli_optimized_sensitive"],
        unresolvedLineIds: [],
        lineOutcomes: [
          {
            lineId: "cli_optimized_sensitive",
            outcome: "checkout",
            reason: "ready",
          },
        ],
        optimization: {
          available: true,
          decision,
          proposedLineId: "cli_optimized_sensitive",
          proposedListingId: "lst_lower_sensitive",
          currentListingId: "lst_current_sensitive",
          savingsAmount: "4.00",
          currency: "USD",
        },
        fulfillmentGroups: [
          {
            groupId: "cfg_sensitive",
            lineIds: ["cli_optimized_sensitive"],
            listingIds: ["lst_current_sensitive"],
            sellerAccountId: "acc_seller_sensitive",
            sellerDisplayName: "Card Vault",
            itemCount: 1,
            packageCount: 1,
            deliveryPromise: null,
            shippingAmount: null,
            supportReference: "CSG-SENSITIVE",
            downstreamReferenceStatus: "not-started",
          },
        ],
        customerSafeFacts: ["Ready for checkout.", "Save $4.00 by changing fulfillment before checkout."],
      });
      const { events, telemetry } = collectCheckoutObservabilityEvents();
      const app = buildApp({
        actor: null,
        services,
        checkoutObservabilityTelemetry: telemetry,
      });

      const response = await app.fetch(
        new Request("http://checkout.test/guest/cart/readiness", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-checkout-anonymous-cart-id": "anon_cart_sensitive",
          },
          body: JSON.stringify({
            optimization: {
              decision,
              lineId: "cli_optimized_sensitive",
              listingId: "lst_lower_sensitive",
            },
          }),
        }),
      );

      expect(response.status).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventName: "checkout.readiness.optimization_decision",
        telemetryClass: "readiness",
        alertClass: "event-only",
        entrySource: "buy-cart-readiness",
        actorMode: "guest",
        scenarioState: `optimization-${decision}`,
        visibleState: "cart-readiness-optimization-visible",
        sideEffectStatus: "not-attempted",
        readinessContract: "checkout.cart-readiness.v1",
        readinessSnapshotState: "ready",
        supportReferencePresent: true,
        performanceBudgetId: "buy-cart-readiness-evaluation",
        providerCategory: "fulfillment",
        downstreamStatus: "not-started",
        capabilityDecision: "enabled",
        operatorSignalRequired: false,
      });
      expect(JSON.stringify(events)).not.toContain("anon_cart_sensitive");
      expect(JSON.stringify(events)).not.toContain("cr_optimization_sensitive");
      expect(JSON.stringify(events)).not.toContain("cr_source_optimization");
      expect(JSON.stringify(events)).not.toContain("cli_optimized_sensitive");
      expect(JSON.stringify(events)).not.toContain("lst_lower_sensitive");
      expect(JSON.stringify(events)).not.toContain("lst_current_sensitive");
      expect(JSON.stringify(events)).not.toContain("acc_seller_sensitive");
      expect(JSON.stringify(events)).not.toContain("CSG-SENSITIVE");
    },
  );

  it("allows signed-in buyers without order-management permissions to use their account cart", async () => {
    const services = createServices();
    const app = buildApp({
      actor: accountCartActor({ roleKey: "viewer", permissions: [] }),
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_buyer",
        productId: "cat_charizard::form=raw",
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_buyer",
          performedByUserId: "usr_1",
        }),
      }),
    );
  });

  it("adds signed-out marketplace intent to an anonymous cart owner", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/cart", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-cart-id": "anon_cart_1",
        },
        body: JSON.stringify({
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          itemSubtitle: "Base Set 4/102 Holo Rare",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Form: Raw",
          quantity: 2,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "anon_cart_1",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form=raw",
        quantity: 2,
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_guest_checkout",
          performedByUserId: "usr_guest_checkout",
        }),
      }),
    );
  });

  it("blocks a new anonymous Buy Cart line after the device line limit", async () => {
    const services = createServices();
    vi.mocked(services.listCartLines).mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => cartLine(index)) as never,
    );
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/cart", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-cart-id": "anon_cart_limit",
          "x-forwarded-for": "203.0.113.101",
        },
        body: JSON.stringify({
          catalogItemId: "cat_new",
          productId: "cat_new::form=raw",
          itemTitle: "New card",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "anonymous_cart_limit_exceeded",
      },
    });
    expect(services.addLine).not.toHaveBeenCalled();
  });

  it("allows an anonymous Buy Cart duplicate line at the device line limit", async () => {
    const services = createServices();
    vi.mocked(services.listCartLines).mockResolvedValue([
      {
        ...cartLine(0),
        catalog_catalog_item_id: "cat_charizard",
        product_id: "cat_charizard::form=raw",
      },
      ...Array.from({ length: 49 }, (_, index) => cartLine(index + 1)),
    ] as never);
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/cart", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-cart-id": "anon_cart_duplicate",
          "x-forwarded-for": "203.0.113.102",
        },
        body: JSON.stringify({
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "anon_cart_duplicate",
        productId: "cat_charizard::form=raw",
      }),
      expect.any(Object),
    );
  });

  it("blocks anonymous Buy Cart bulk adds that would exceed the device line limit", async () => {
    const services = createServices();
    vi.mocked(services.listCartLines).mockResolvedValue(
      Array.from({ length: 49 }, (_, index) => cartLine(index)) as never,
    );
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/cart/bulk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-cart-id": "anon_cart_bulk_limit",
          "x-forwarded-for": "203.0.113.103",
        },
        body: JSON.stringify({
          lines: [
            {
              catalogItemId: "cat_new_1",
              productId: "cat_new_1::form=raw",
              itemTitle: "New card 1",
              quantity: 1,
            },
            {
              catalogItemId: "cat_new_2",
              productId: "cat_new_2::form=raw",
              itemTitle: "New card 2",
              quantity: 1,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "anonymous_cart_limit_exceeded",
      },
    });
    expect(services.addLines).not.toHaveBeenCalled();
  });

  it("rate limits repeated anonymous Buy Cart capture requests", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    let response = new Response(null, { status: 500 });
    for (let index = 0; index < 31; index += 1) {
      response = await app.fetch(
        new Request("http://checkout.test/guest/cart", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-checkout-anonymous-cart-id": "anon_cart_rate_limited",
            "x-forwarded-for": "203.0.113.104",
          },
          body: JSON.stringify({
            catalogItemId: `cat_rate_${index}`,
            productId: `cat_rate_${index}::form=raw`,
            itemTitle: "Rate limited card",
            quantity: 1,
          }),
        }),
      );
    }

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "anonymous_request_rate_limited",
      },
    });
    expect(services.addLine).toHaveBeenCalledTimes(30);
  });

  it("creates a guest cart readiness snapshot from the anonymous cart owner", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/cart/readiness", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-cart-id": "anon_cart_1",
        },
        body: JSON.stringify({
          lineOutcomes: [{ lineId: "cli_waiting", outcome: "save-for-later" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(services.createReadinessSnapshot).toHaveBeenCalledWith({
      accountId: "anon_cart_1",
      decisions: {
        lineOutcomes: [{ lineId: "cli_waiting", outcome: "save-for-later" }],
        optimization: null,
      },
    });
  });

  it("adds multiple browsed marketplace products to the current account cart", async () => {
    const services = createServices();
    const app = buildApp({
      actor: accountCartActor(),
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/cart/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: [
            {
              catalogItemId: "cat_charizard",
              productId: "cat_charizard::form=raw",
              itemTitle: "Charizard",
              selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
              quantity: 1,
            },
            {
              catalogItemId: "cat_blastoise",
              productId: "cat_blastoise::form=raw",
              itemTitle: "Blastoise",
              selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
              quantity: 1,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "completed",
      requestedLineCount: 2,
      addedLineCount: 1,
      mergedLineCount: 1,
      failedLineCount: 0,
    });
    expect(services.addLines).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_buyer",
        lines: expect.arrayContaining([
          expect.objectContaining({
            catalogItemId: "cat_charizard",
            quantity: 1,
          }),
        ]),
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_buyer",
          performedByUserId: "usr_1",
        }),
      }),
    );
  });

  it("merges an anonymous cart into a guest checkout account", async () => {
    const services = createServices();
    const app = buildApp({
      actor: guestCheckoutActor(),
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/cart/merge-to-account", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-cart-id": "anon_cart_1",
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    expect(services.mergeCartIntoAccount).toHaveBeenCalledWith(
      {
        sourceOwnerId: "anon_cart_1",
        targetAccountId: "acc_guest",
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_guest",
          performedByUserId: "usr_guest_checkout",
        }),
      }),
    );
  });

  it("emits one fixed redacted event when a best-effort cart merge fails", async () => {
    const services = createServices();
    vi.mocked(services.mergeCartIntoAccount).mockRejectedValue(
      new Error("anon_raw_merge_marker secret_cookie=abc account=acc_private\nstack provider payload"),
    );
    const recordCheckoutEvent = vi.fn<CheckoutObservabilityTelemetry["recordCheckoutEvent"]>();
    const app = buildApp({
      actor: guestCheckoutActor(),
      services,
      checkoutObservabilityTelemetry: { recordCheckoutEvent },
    });
    const request = new Request("http://checkout.test/guest/cart/merge-to-account?secret=url-secret", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: "chase_sets_guest_checkout=secret-token",
        "x-checkout-anonymous-cart-id": "anon_cart_secret",
      },
      body: JSON.stringify({ providerPayload: "secret-body" }),
    });

    const response = await app.fetch(request);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "cart_merge_failed",
        message: "Request failed.",
      },
    });
    expect(recordCheckoutEvent).toHaveBeenCalledOnce();
    expect(recordCheckoutEvent).toHaveBeenCalledWith({
      eventName: "checkout.entry.cart_merge_best_effort_failed",
      telemetryClass: "checkout-entry",
      alertClass: "event-only",
      operatorSignalRequired: false,
      entrySource: "cart",
      actorMode: "guest",
      scenarioState: "reconciliation",
      visibleState: "entry-continues",
      sideEffectStatus: "merge-failed",
      readinessContract: null,
      readinessSnapshotState: null,
      sourceRevisionState: null,
      freshWriteReceiptPresence: null,
      supportReferencePresent: false,
      performanceBudgetId: null,
      providerCategory: null,
      riskCategory: null,
      downstreamStatus: null,
      capabilityDecision: null,
      freshStateScanResult: null,
    });
    expect(JSON.stringify(recordCheckoutEvent.mock.calls)).not.toMatch(
      /anon_raw_merge_marker|secret|cookie|anon_cart|acc_private|url-secret|providerPayload|stack/i,
    );
  });

  it("does not emit merge-failure telemetry when the copy succeeds", async () => {
    const services = createServices();
    const recordCheckoutEvent = vi.fn<CheckoutObservabilityTelemetry["recordCheckoutEvent"]>();
    const app = buildApp({
      actor: accountCartActor(),
      services,
      checkoutObservabilityTelemetry: { recordCheckoutEvent },
    });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/cart/merge-to-account", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-cart-id": "anon_cart_1",
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    expect(recordCheckoutEvent).not.toHaveBeenCalled();
  });

  it("locks an account cart line to a selected seller listing", async () => {
    const services = createServices();
    const app = buildApp({
      actor: accountCartActor(),
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/cart/cli_1/fulfillment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fulfillmentMode: "locked-listing",
          lockedListingId: "lst_card_vault",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(services.setLineFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_buyer",
        lineId: "cli_1",
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_card_vault",
      }),
      expect.anything(),
    );
  });
});

describe("guest cart routes on a claimed anonymous key", () => {
  const CLAIMED_SOURCE = "anon_synthetic_claimed";
  const REFUSAL = "Cart is owned by a different account.";

  function refusingServices() {
    const services = createServices();
    for (const method of ["addLine", "addLines", "setLineQuantity", "setLineFulfillment", "removeLine"] as const) {
      vi.mocked(services[method]).mockRejectedValue(new CheckoutDomainError(REFUSAL));
    }
    return services;
  }

  const mutations = [
    ["quantity", "/guest/cart/cli_claimed/quantity", { quantity: 2 }],
    ["fulfillment", "/guest/cart/cli_claimed/fulfillment", { fulfillmentMode: "optimize" }],
    ["removal", "/guest/cart/cli_claimed/remove", {}],
    ["add", "/guest/cart", { catalogItemId: "cat_1", productId: "cat_1::", quantity: 1 }],
  ] as const;

  it.each(mutations)("returns the existing 400 refusal body for %s", async (_surface, path, body) => {
    const services = refusingServices();
    const app = buildApp({ actor: null, services });

    const response = await app.request(
      new Request(`http://checkout.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-checkout-anonymous-cart-id": CLAIMED_SOURCE },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(400);
    // The existing validation shape: no new error code is introduced.
    expect(await response.json()).toEqual({ error: { code: "validation_failed", message: REFUSAL } });
  });

  it("returns the ownership refusal from the real runtime for a claimed guest bulk add", async () => {
    const source = CLAIMED_SOURCE as AccountId;
    const claimant = "acc_synthetic_claimant";
    const memory = createInMemoryEventStore();
    const runtime = createCheckoutCartRuntime({
      eventStore: memory.eventStore,
      checkpointStore: {} as never,
      db: {
        query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
          if (sql.includes("FROM checkout_catalog_items")) {
            return {
              rows: [{ catalog_item_id: values[0], language_code: "en", status: "active", product_schema: null }],
              rowCount: 1,
            };
          }
          if (sql.includes("WITH requested_owners") || sql.includes("WHERE claim.account_id = $1")) {
            return { rows: [], rowCount: 0 };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        }),
      },
    });
    const context = {
      tenantId: "tnt_synthetic",
      audit: { performedByUserId: "usr_synthetic", forAccountId: claimant },
    } as never;
    const streamId = `checkout.cart-${source}`;

    const seedCommand: Extract<
      Parameters<CheckoutCartServices["commandHandler"]>[0]["command"],
      { type: "AddCartLine" }
    > = {
      type: "AddCartLine",
      buyerAccountId: source,
      lineId: "cli_existing",
      catalogItemId: "cat_1",
      productId: "cat_1::",
      itemTitle: "Existing",
      itemSubtitle: null,
      itemImageUrl: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
    };

    await runtime.commandHandler({
      streamId,
      context,
      command: seedCommand,
    });
    await runtime.commandHandler({
      streamId,
      context,
      command: { type: "ClaimCart", sourceOwnerKey: source, accountId: claimant },
    });
    const app = new Hono();
    app.route("/guest", createGuestCartRoutes(runtime));

    const response = await app.request("/guest/cart/bulk", {
      method: "POST",
      headers: { "content-type": "application/json", "x-checkout-anonymous-cart-id": source },
      body: JSON.stringify({
        lines: [
          {
            catalogItemId: "cat_2",
            productId: "cat_2::",
            itemTitle: "New",
            itemSubtitle: null,
            itemImageUrl: null,
            selectedOptions: [],
            productSummary: null,
            quantity: 1,
          },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "validation_failed", message: REFUSAL } });
    expect((memory.streams.get(streamId) ?? []).map((event) => event.eventType)).toEqual([
      "checkout.cart.line-added",
      "checkout.cart.claimed-by-account",
    ]);
  });

  it("refuses identically however the caller obtained the key", async () => {
    const services = refusingServices();
    const app = buildApp({ actor: null, services });
    // The guest routes have exactly one ingress for the anonymous key: the
    // `x-checkout-anonymous-cart-id` header the marketplace fills from the
    // retained cookie. A key copied straight into that header is the same
    // input, so the refusal cannot depend on how it was obtained.
    const responses = await Promise.all(
      ["retained-cookie-value", "hand-supplied-value"].map(async () =>
        app.request(
          new Request("http://checkout.test/guest/cart/cli_claimed/quantity", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-checkout-anonymous-cart-id": CLAIMED_SOURCE },
            body: JSON.stringify({ quantity: 2 }),
          }),
        ),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([400, 400]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { error: { code: "validation_failed", message: REFUSAL } },
      { error: { code: "validation_failed", message: REFUSAL } },
    ]);
    // The acting owner key the service authorizes against is the presented key.
    expect(vi.mocked(services.setLineQuantity).mock.calls.map(([params]) => params.accountId)).toEqual([
      CLAIMED_SOURCE,
      CLAIMED_SOURCE,
    ]);
  });

  it("keeps unclaimed guest mutations on their existing success responses", async () => {
    const services = createServices();
    const app = buildApp({ actor: null, services });

    const quantity = await app.request(
      new Request("http://checkout.test/guest/cart/cli_1/quantity", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-checkout-anonymous-cart-id": "anon_unclaimed" },
        body: JSON.stringify({ quantity: 3 }),
      }),
    );
    const removal = await app.request(
      new Request("http://checkout.test/guest/cart/cli_1/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-checkout-anonymous-cart-id": "anon_unclaimed" },
      }),
    );

    expect(await quantity.json()).toEqual({ id: "cli_1", version: 2, status: "quantity-updated" });
    expect(await removal.json()).toEqual({ id: "cli_1", version: 3, status: "removed" });
    expect(vi.mocked(services.setLineQuantity).mock.calls[0]?.[0]).toMatchObject({
      accountId: "anon_unclaimed",
      lineId: "cli_1",
      quantity: 3,
    });
  });
});

describe("post-claim cart reads through the real Cart runtime", () => {
  const CLAIMED_SOURCE = "anon_synthetic_claimed";
  const UNCLAIMED_SOURCE = "anon_synthetic_unclaimed";
  const OWNER = "acc_synthetic_owner";
  const OTHER = "acc_synthetic_other";

  const projectedLine = (ownerId: string, lineId: string) =>
    internalCartLineRow({ buyer_account_id: ownerId, line_id: lineId, item_title: `Title ${lineId}` });

  /**
   * A real Cart runtime over a real in-memory event store, with the claimed
   * source stream genuinely claimed by an appended event.
   *
   * The line-page double deliberately does hold lines for the claimed source,
   * so every read below would return them if authority were skipped. A guard
   * that passed here only because the projection happened to be empty would
   * prove nothing.
   */
  function claimedCartHarness() {
    const memory = createInMemoryEventStore();
    const runtime = createCheckoutCartRuntime({
      eventStore: memory.eventStore,
      checkpointStore: {} as never,
      db: {
        query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
          if (sql.includes("WHERE claim.account_id = $1")) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("WITH requested_owners")) {
            const requested = [values[0], values[1]].filter((value): value is string => typeof value === "string");
            const rows = [
              ...(requested.includes(CLAIMED_SOURCE) ? [projectedLine(CLAIMED_SOURCE, "cli_claimed")] : []),
              ...(requested.includes(UNCLAIMED_SOURCE) ? [projectedLine(UNCLAIMED_SOURCE, "cli_unclaimed")] : []),
              ...(requested.includes(OTHER) ? [projectedLine(OTHER, "cli_other_account")] : []),
            ];
            return { rows, rowCount: rows.length };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        }),
      },
    });
    const context = {
      tenantId: "tnt_synthetic",
      audit: { performedByUserId: "usr_synthetic", forAccountId: OWNER },
    } as never;

    return {
      memory,
      runtime,
      seedClaim: async () =>
        runtime.commandHandler({
          streamId: `checkout.cart-${CLAIMED_SOURCE}`,
          context,
          command: { type: "ClaimCart", sourceOwnerKey: CLAIMED_SOURCE, accountId: OWNER as AccountId },
        }),
      guestApp: () => {
        const app = new Hono();
        app.route("/guest", createGuestCartRoutes(runtime));
        return app;
      },
      accountApp: (accountId: string) => buildApp({ actor: accountCartActor({ accountId }), services: runtime }),
    };
  }

  it("returns the existing empty guest cart payload for a claimed key, byte-equal to the no-key control", async () => {
    const harness = claimedCartHarness();
    await harness.seedClaim();
    const app = harness.guestApp();

    const claimed = await app.request("/guest/cart", {
      headers: { "x-checkout-anonymous-cart-id": CLAIMED_SOURCE },
    });
    const noKey = await app.request("/guest/cart");
    const claimedBody = await claimed.text();

    expect([claimed.status, noKey.status]).toEqual([200, 200]);
    expect(claimedBody).toBe(await noKey.text());
    expect(JSON.parse(claimedBody)).toEqual({ items: [], count: 0 });
  });

  it("still reads an unclaimed key by possession, so the claimed refusal is not a vacuous empty read", async () => {
    const harness = claimedCartHarness();
    await harness.seedClaim();
    const app = harness.guestApp();

    const response = await app.request("/guest/cart", {
      headers: { "x-checkout-anonymous-cart-id": UNCLAIMED_SOURCE },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      count: 1,
      items: [{ line_id: "cli_unclaimed" }],
    });
  });

  it("returns guest readiness for a claimed key structurally equal to valid unclaimed-empty readiness", async () => {
    const harness = claimedCartHarness();
    await harness.seedClaim();
    const app = harness.guestApp();

    const readiness = async (ownerKey: string) =>
      app.request("/guest/cart/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-checkout-anonymous-cart-id": ownerKey },
        body: JSON.stringify({}),
      });

    const refused = await readiness(CLAIMED_SOURCE);
    // A key that never existed is the honest valid-unclaimed-and-empty control:
    // it holds no lines and carries no claim.
    const unclaimedEmpty = await readiness("anon_synthetic_absent");
    const refusedBody = await refused.text();

    expect([refused.status, unclaimedEmpty.status]).toEqual([200, 200]);
    expect(refusedBody).toBe(await unclaimedEmpty.text());
    const body = JSON.parse(refusedBody) as { readiness: { status: string; includedLineIds: readonly string[] } };
    expect(body.readiness.status).toBe("blocked");
    expect(body.readiness.includedLineIds).toEqual([]);
  });

  it("keeps the existing HTTP 400 for missing and malformed readiness headers", async () => {
    const harness = claimedCartHarness();
    await harness.seedClaim();
    const app = harness.guestApp();

    for (const headers of [
      {} as Record<string, string>,
      { "x-checkout-anonymous-cart-id": "" },
      { "x-checkout-anonymous-cart-id": "cart_synthetic_claimed" },
      { "x-checkout-anonymous-cart-id": "  " },
    ]) {
      const response = await app.request("/guest/cart/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("anonymous_cart_required");
    }
  });

  it("excludes a foreign claimed key from Account readiness and leaves only the acting Account cart", async () => {
    const harness = claimedCartHarness();
    await harness.seedClaim();
    const app = harness.accountApp(OTHER);

    const readiness = async (headers: Record<string, string>) =>
      app.request(
        new Request("http://checkout.test/account/cart/readiness", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({}),
        }),
      );

    const withForeignKey = await readiness({ "x-checkout-anonymous-cart-id": CLAIMED_SOURCE });
    const accountOnly = await readiness({});
    const accountOnlyBody = await accountOnly.text();

    expect([withForeignKey.status, accountOnly.status]).toEqual([200, 200]);
    // Identical to the Account-only snapshot: same included lines, same
    // snapshot id, and the same source revision -- so the presented key
    // contributed nothing at all, not merely no visible line.
    expect(await withForeignKey.text()).toBe(accountOnlyBody);
    const body = JSON.parse(accountOnlyBody) as { readiness: { includedLineIds: readonly string[] } };
    expect(body.readiness.includedLineIds).toEqual(["cli_other_account"]);
  });

  it("lets the claimant Account read the claimed source it owns", async () => {
    const harness = claimedCartHarness();
    await harness.seedClaim();

    const authority = await harness.runtime.resolveCartSourceAuthority({
      actingOwnerKey: OWNER,
      presentedAnonymousCartId: CLAIMED_SOURCE,
    });
    const lines = await harness.runtime.listAuthorizedCartLines({
      accountId: OWNER,
      presentedAnonymousCartId: CLAIMED_SOURCE,
    });

    expect(authority).toEqual({ status: "accepted", acceptedVia: "account" });
    expect(lines.map((line) => line.line_id)).toEqual(["cli_claimed"]);
  });

  it("publishes no cart owner marker on any account or guest cart payload", async () => {
    const harness = claimedCartHarness();
    await harness.seedClaim();
    const guest = harness.guestApp();
    const account = harness.accountApp(OTHER);

    const guestBody = await (
      await guest.request("/guest/cart", { headers: { "x-checkout-anonymous-cart-id": UNCLAIMED_SOURCE } })
    ).text();
    const accountBody = await (
      await account.request(new Request("http://checkout.test/account/cart", { method: "GET" }))
    ).text();

    for (const body of [guestBody, accountBody]) {
      expect(body).not.toContain("buyer_account_id");
      expect(body).not.toContain("anon_raw_marker");
      expect(body).not.toContain(CLAIMED_SOURCE);
      expect(body).not.toContain(UNCLAIMED_SOURCE);
      // The cookie-clear classification is internal metadata for #5737 alone:
      // it is not a public response field and not an error code.
      expect(body).not.toContain("clearRetainedAnonymousCartCookie");
      expect(body).not.toContain("acceptedVia");
    }
    // Both payloads still carry real line detail, so the absence above is an
    // owner-field omission rather than an empty response.
    expect(JSON.parse(guestBody)).toMatchObject({
      items: [{ line_id: "cli_unclaimed", item_title: "Title cli_unclaimed" }],
    });
    expect(JSON.parse(accountBody)).toMatchObject({ items: [{ line_id: "cli_other_account" }] });
  });

  it("would surface the claimed lines if the read authority guard were bypassed", async () => {
    const harness = claimedCartHarness();
    await harness.seedClaim();

    // The bypass mutant: read the same source through the raw union instead of
    // the authorized read. It returns the claimed line, which is exactly what
    // every guarded read above must never return.
    const bypassed = await harness.runtime.listCartLines(CLAIMED_SOURCE);
    const guarded = await harness.runtime.listAuthorizedCartLines({ accountId: CLAIMED_SOURCE });

    expect(bypassed.map((line) => line.line_id)).toEqual(["cli_claimed"]);
    expect(guarded).toEqual([]);
  });
});
