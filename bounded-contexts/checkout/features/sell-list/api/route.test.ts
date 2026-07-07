import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CheckoutApiEnv } from "../../../api";
import type { SellListConfirmationSummary, SellListSellerConfirmationEvidence } from "../domain/domain";
import type { SellListReadinessSnapshot } from "../domain/readiness";
import type { CheckoutObservabilityTelemetry } from "../../sessions/api/checkout-observability-telemetry";
import type { CheckoutSellListConfirmationRow } from "../read-model/queries";
import { createAccountSellListRoutes, createGuestSellListRoutes } from "./route";
import type { CheckoutSellListServices } from "./runtime";

const readySellerReadiness: SellListReadinessSnapshot["sellerReadiness"] = {
  status: "ready",
  evidenceRevision: "slr_seller_evidence",
  payout: "ready",
  shipFrom: "ready",
  label: "ready",
  conditionReview: "ready",
  risk: "ready",
  provider: "ready",
  freshness: "ready",
  outcomes: [
    { dimension: "ship-from", status: "ready", reason: "ready" },
    { dimension: "payout", status: "ready", reason: "ready" },
    { dimension: "label", status: "ready", reason: "ready" },
    { dimension: "condition-review", status: "ready", reason: "ready" },
    { dimension: "risk", status: "ready", reason: "ready" },
    { dimension: "provider", status: "ready", reason: "ready" },
    { dimension: "freshness", status: "ready", reason: "ready" },
  ],
};

function buildApp(
  options: Readonly<{
    actor: CheckoutApiEnv["Variables"]["actor"];
    services: CheckoutSellListServices;
    checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry;
  }>,
) {
  const app = new Hono<CheckoutApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    c.set(
      "context",
      options.actor
        ? {
            tenantId: "tnt_identity" as never,
            audit: {
              performedByUserId: options.actor.userId as never,
              forAccountId: options.actor.accountId as never,
            },
          }
        : null,
    );
    await next();
  });

  app.route("/account", createAccountSellListRoutes(options.services, options.checkoutObservabilityTelemetry));
  app.route("/guest", createGuestSellListRoutes(options.services));

  return app;
}

function createServices(): CheckoutSellListServices {
  return {
    addLine: vi.fn(async () => ({ lineId: "sll_1" as never, version: 1, status: "added" })),
    removeLine: vi.fn(async () => ({ lineId: "sll_1" as never, version: 2 })),
    confirmSellListCheckout: vi.fn(async () => ({
      sellerAccountId: "acc_seller" as never,
      version: 3,
      status: "confirmed",
      confirmation: confirmationRow(),
      completedLineIds: ["sll_1" as never],
    })),
    getLatestConfirmation: vi.fn(async () => null),
    getConfirmation: vi.fn(async () => null),
    getPayoutReadiness: vi.fn(async () => ({
      account_id: "acc_seller",
      status: "ready",
      missing_requirements: [],
      updated_at: "2026-05-30T00:00:00.000Z",
    })),
    mergeSellListIntoAccount: vi.fn(async () => ({ mergedLineCount: 1 })),
    createReadinessSnapshot: vi.fn(async () => ({
      schemaVersion: "checkout.sell-list-readiness.v1",
      source: "sell-list",
      sourceRevision: "slr_source",
      snapshotId: "slr_ready",
      status: "ready",
      lineCount: 1,
      includedLineIds: ["sll_1"],
      unresolvedLineIds: [],
      lineOutcomes: [{ lineId: "sll_1", outcome: "checkout", reason: "ready", action: "selected-offer" }],
      sellerReadiness: readySellerReadiness,
      customerSafeFacts: ["Ready for seller checkout."],
    })),
    listLines: vi.fn(async () => []),
    projectors: [],
  } as unknown as CheckoutSellListServices;
}

function confirmationRow(): CheckoutSellListConfirmationRow {
  return {
    seller_account_id: "acc_seller",
    confirmation_id: "slc_1",
    confirmed_at: "2026-05-30T00:00:00.000Z",
    readiness_evidence: {
      schemaVersion: "checkout.sell-list-readiness.v1",
      snapshotId: "slr_ready",
      sourceRevision: "slr_source",
      includedLineIds: ["sll_1"],
    },
    seller_evidence: sellerEvidence(),
    handoff_summary: handoffSummary(),
  };
}

function sellerEvidence(): SellListSellerConfirmationEvidence {
  return {
    shipFrom: {
      status: "ready",
      addressId: "adr_seller",
      country: "US",
      region: "KS",
      postalCode: "67202",
    },
    payout: {
      status: "ready",
      method: "saved-payout",
      readinessStatus: "ready",
      lastCheckedAt: "2026-05-30T00:00:00.000Z",
    },
    label: {
      status: "ready",
      preference: "prepaid-label",
    },
    conditionReview: {
      status: "accepted",
      acceptedAt: "2026-05-30T00:00:00.000Z",
    },
    risk: { status: "clear" },
    provider: { status: "ready" },
    freshness: { status: "current" },
  };
}

function handoffSummary(): SellListConfirmationSummary {
  return {
    acceptedOfferCount: 1,
    publishedListingCount: 0,
    skippedLineCount: 0,
    skippedReasons: [],
    lineOutcomes: [
      {
        lineId: "sll_1",
        itemTitle: "Charizard",
        status: "completed",
        action: "accepted-offer",
        quantity: 1,
        remainingQuantity: 0,
        detail: "Accepted reviewed offer.",
        references: { offerIds: ["off_1"] },
      },
    ],
    sideEffects: {
      sale: "handoff-recorded",
      label: "pending-downstream",
      payout: "pending-downstream",
      settlement: "pending-downstream",
      notification: "pending-downstream",
      accountHistory: "pending-downstream",
    },
  };
}

function sellerActor(): CheckoutApiEnv["Variables"]["actor"] {
  return {
    sessionId: "ses_1",
    tenantId: "tnt_identity",
    userId: "usr_seller",
    accountId: "acc_seller",
    membershipId: "mbr_seller",
    roleKey: "owner",
    permissions: ["listings.view", "offers.view"],
  };
}

function guestCheckoutActor(): CheckoutApiEnv["Variables"]["actor"] {
  return {
    sessionId: "guest:tok_1",
    tenantId: "tnt_identity",
    userId: "usr_guest_checkout",
    accountId: "acc_guest",
    membershipId: "guest:tok_1",
    roleKey: "guest-buyer",
    permissions: ["guest-checkout.manage"],
  };
}

describe("checkout sell list routes", () => {
  it("counts sell list item quantities instead of raw lines", async () => {
    const services = createServices();
    vi.mocked(services.listLines).mockResolvedValue([
      { line_id: "sll_1", quantity: 2 },
      { line_id: "sll_2", quantity: 3 },
    ] as never);
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(new Request("http://checkout.test/account/sell-list"));

    await expect(response.json()).resolves.toMatchObject({
      count: 5,
    });
  });

  it("returns the latest Sell List confirmation with the list summary", async () => {
    const services = createServices();
    vi.mocked(services.getLatestConfirmation).mockResolvedValue(confirmationRow());
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(new Request("http://checkout.test/account/sell-list"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      latestConfirmation: {
        confirmation_id: "slc_1",
        handoff_summary: { acceptedOfferCount: 1 },
      },
    });
  });

  it("returns Checkout-owned payout readiness for the signed-in seller", async () => {
    const services = createServices();
    vi.mocked(services.getPayoutReadiness).mockResolvedValue({
      account_id: "acc_seller",
      status: "restricted",
      missing_requirements: ["external_account"],
      updated_at: "2026-05-30T00:00:00.000Z",
    });
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(new Request("http://checkout.test/account/sell-list/payout-readiness"));

    expect(response.status).toBe(200);
    expect(services.getPayoutReadiness).toHaveBeenCalledWith("acc_seller");
    await expect(response.json()).resolves.toEqual({
      account_id: "acc_seller",
      status: "restricted",
      missing_requirements: ["external_account"],
      updated_at: "2026-05-30T00:00:00.000Z",
    });
  });

  it("adds product-level seller intent to the Checkout-owned Sell List", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineType: "product",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          itemSubtitle: "Base Set 4/102 Holo Rare",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Form: Raw",
          quantity: 2,
          fallbackMode: "create-listing",
          minimumListingPriceAmount: "399.00",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "sll_1",
      version: 1,
      status: "added",
    });
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_seller",
        lineType: "product",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form=raw",
        quantity: 2,
        fallbackMode: "create-listing",
        minimumListingPriceAmount: "399.00",
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("adds a selected offer line to the Checkout-owned Sell List", async () => {
    const services = createServices();
    vi.mocked(services.addLine).mockResolvedValue({
      lineId: "sll_offer" as never,
      version: 4,
      status: "merged",
    });
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineType: "selected-offer",
          offerId: "off_charizard",
          buyerAccountId: "acc_buyer",
          buyerDisplayName: "Ash Ketchum",
          offerPriceAmount: "350.00",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "sll_offer",
      version: 4,
      status: "merged",
    });
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_seller",
        lineType: "selected-offer",
        offerId: "off_charizard",
        buyerAccountId: "acc_buyer",
        buyerDisplayName: "Ash Ketchum",
        offerPriceAmount: "350.00",
      }),
      expect.any(Object),
    );
  });

  it("creates a signed-in Sell List readiness snapshot with pre-checkout sale action decisions", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineActions: [{ lineId: "sll_1", action: "smart-match" }],
          lineOutcomes: [{ lineId: "sll_2", outcome: "keep-in-list" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      readiness: { snapshotId: "slr_ready", status: "ready" },
    });
    expect(services.createReadinessSnapshot).toHaveBeenCalledWith({
      sellerAccountId: "acc_seller",
      decisions: {
        lineActions: [{ lineId: "sll_1", action: "smart-match" }],
        lineOutcomes: [{ lineId: "sll_2", outcome: "keep-in-list" }],
      },
      sellerEvidence: null,
    });
  });

  it("removes a Sell List line", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/sll_1/remove", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "sll_1",
      version: 2,
      status: "removed",
    });
    expect(services.removeLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_seller",
        lineId: "sll_1",
      }),
      expect.any(Object),
    );
  });

  it("looks up a Sell List confirmation by confirmation id", async () => {
    const services = createServices();
    vi.mocked(services.getConfirmation).mockResolvedValue(confirmationRow());
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(new Request("http://checkout.test/account/sell-list/confirmations/slc_1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      confirmation_id: "slc_1",
      handoff_summary: { acceptedOfferCount: 1 },
    });
    expect(services.getConfirmation).toHaveBeenCalledWith("acc_seller", "slc_1");
  });

  it("emits support-safe seller confirmation activity without raw identifiers", async () => {
    const services = createServices();
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    vi.mocked(services.getConfirmation).mockResolvedValue(confirmationRow());
    const app = buildApp({ actor: sellerActor(), services, checkoutObservabilityTelemetry });

    const response = await app.fetch(new Request("http://checkout.test/account/sell-list/confirmations/slc_1"));

    expect(response.status).toBe(200);
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.sell.confirmation_activity_recorded",
        telemetryClass: "confirmation",
        alertClass: "support-alert",
        operatorSignalRequired: true,
        entrySource: "sell-list-readiness",
        actorMode: "signed-in",
        scenarioState: "pending-downstream",
        visibleState: "seller-confirmation-visible",
        sideEffectStatus: "pending-downstream",
        readinessContract: "checkout.sell-list-readiness.v1",
        readinessSnapshotState: "recorded",
        sourceRevisionState: "recorded",
        supportReferencePresent: true,
        providerCategory: "marketplace",
        downstreamStatus: "handoff-recorded-pending-downstream",
        capabilityDecision: "enabled",
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("slc_1");
    expect(emitted).not.toContain("acc_seller");
    expect(emitted).not.toContain("sll_1");
    expect(emitted).not.toContain("off_1");
    expect(emitted).not.toContain("adr_seller");
  });

  it("records Sell List confirmation for a seller account", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmationId: "slc_1",
          readinessSnapshotId: "slr_ready",
          readinessSourceRevision: "slr_source",
          readinessDecisions: {
            lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
          },
          completedLineIds: ["sll_1"],
          sellerEvidence: sellerEvidence(),
          handoffSummary: handoffSummary(),
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "acc_seller",
      confirmationId: "slc_1",
      version: 3,
      status: "confirmed",
      completedLineIds: ["sll_1"],
      confirmation: { confirmation_id: "slc_1" },
    });
    expect(services.confirmSellListCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_seller",
        confirmationId: "slc_1",
        readinessSnapshotId: "slr_ready",
        readinessSourceRevision: "slr_source",
        readinessDecisions: {
          lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
          lineOutcomes: [],
        },
        completedLineIds: ["sll_1"],
        sellerEvidence: expect.objectContaining({ shipFrom: expect.objectContaining({ status: "ready" }) }),
        handoffSummary: expect.objectContaining({
          acceptedOfferCount: 1,
          sideEffects: expect.objectContaining({ sale: "handoff-recorded" }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("rejects Sell List confirmation without readiness, seller, and reviewed sale details", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmationId: "slc_1" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
        message: "Sell List confirmation requires current readiness, seller, and reviewed sale details.",
      },
    });
    expect(services.confirmSellListCheckout).not.toHaveBeenCalled();
  });

  it("rejects Sell List confirmation when ready seller evidence is incomplete", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmationId: "slc_1",
          readinessSnapshotId: "slr_ready",
          readinessSourceRevision: "slr_source",
          completedLineIds: ["sll_1"],
          sellerEvidence: {
            ...sellerEvidence(),
            shipFrom: { ...sellerEvidence().shipFrom, postalCode: "" },
          },
          handoffSummary: handoffSummary(),
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
        message: "Sell List confirmation requires current readiness, seller, and reviewed sale details.",
      },
    });
    expect(services.confirmSellListCheckout).not.toHaveBeenCalled();
  });

  it("does not expose removed Sell List old endpoints", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(404);
  });

  it("blocks guest checkout actors from seller Sell List review", async () => {
    const services = createServices();
    const app = buildApp({ actor: guestCheckoutActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineType: "product",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "authorization_forbidden",
        message: "Sell List review requires a seller account.",
      },
    });
    expect(services.addLine).not.toHaveBeenCalled();
  });

  it("adds signed-out seller intent to an anonymous Sell List owner", async () => {
    const services = createServices();
    const app = buildApp({ actor: null, services });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-sell-list-id": "anon_sell_1",
        },
        body: JSON.stringify({
          lineType: "product",
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
        sellerAccountId: "anon_sell_1",
        lineType: "product",
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_anonymous_sell_list",
          performedByUserId: "usr_anonymous_sell_list",
        }),
      }),
    );
  });

  it("adds signed-out selected offer intent to an anonymous Sell List owner", async () => {
    const services = createServices();
    const app = buildApp({ actor: null, services });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-sell-list-id": "anon_sell_1",
        },
        body: JSON.stringify({
          lineType: "selected-offer",
          offerId: "off_1",
          buyerAccountId: null,
          buyerDisplayName: "Collector123",
          offerPriceAmount: "40.00",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Raw",
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "anon_sell_1",
        lineType: "selected-offer",
        offerId: "off_1",
        buyerAccountId: null,
        buyerDisplayName: "Collector123",
      }),
      expect.anything(),
    );
  });

  it("blocks new anonymous Sell List lines after the guest line limit", async () => {
    const services = createServices();
    vi.mocked(services.listLines).mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => ({
        line_id: `sll_${index}`,
        line_type: "selected-offer",
        offer_id: `off_${index}`,
      })) as never,
    );
    const app = buildApp({ actor: null, services });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-sell-list-id": "anon_sell_1",
        },
        body: JSON.stringify({
          lineType: "selected-offer",
          offerId: "off_new",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "anonymous_sell_list_limit_exceeded",
        message: "This device has 50 Sell List lines saved. Remove an item before adding another.",
      },
    });
    expect(services.addLine).not.toHaveBeenCalled();
  });

  it("rate limits repeated anonymous Sell List capture requests", async () => {
    const services = createServices();
    const app = buildApp({ actor: null, services });

    let response = new Response(null, { status: 500 });
    for (let index = 0; index < 31; index += 1) {
      response = await app.fetch(
        new Request("http://checkout.test/guest/sell-list", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-checkout-anonymous-sell-list-id": "anon_sell_rate_limited",
            "x-forwarded-for": "203.0.113.111",
          },
          body: JSON.stringify({
            lineType: "product",
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

  it("creates a guest Sell List readiness snapshot from the anonymous owner", async () => {
    const services = createServices();
    const app = buildApp({ actor: null, services });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/sell-list/readiness", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-sell-list-id": "anon_sell_1",
        },
        body: JSON.stringify({
          lineOutcomes: [{ lineId: "sll_waiting", outcome: "keep-in-list" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(services.createReadinessSnapshot).toHaveBeenCalledWith({
      sellerAccountId: "anon_sell_1",
      decisions: {
        lineActions: [],
        lineOutcomes: [{ lineId: "sll_waiting", outcome: "keep-in-list" }],
      },
      sellerEvidence: null,
    });
  });

  it("merges anonymous Sell List lines into a signed-in account", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/sell-list/merge-to-account", {
        method: "POST",
        headers: {
          "x-checkout-anonymous-sell-list-id": "anon_sell_1",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mergedLineCount: 1 });
    expect(services.mergeSellListIntoAccount).toHaveBeenCalledWith(
      {
        sourceOwnerId: "anon_sell_1",
        targetAccountId: "acc_seller",
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
        }),
      }),
    );
  });

  it("returns a stored merge receipt when anonymous Sell List merge is idempotent", async () => {
    const services = createServices();
    vi.mocked(services.mergeSellListIntoAccount).mockResolvedValue({
      mergedLineCount: 1,
      commandReceipt: {
        mode: "eventual",
        commitPosition: "77",
        commitEventIds: ["evt_checkout_sell_list_merged"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "77",
            eventIds: ["evt_checkout_sell_list_merged"],
          },
        ],
      },
    });
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/sell-list/merge-to-account", {
        method: "POST",
        headers: {
          "x-checkout-anonymous-sell-list-id": "anon_sell_1",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mergedLineCount: 1,
      commandReceipt: {
        mode: "eventual",
        commitPosition: "77",
        commitEventIds: ["evt_checkout_sell_list_merged"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "77",
            eventIds: ["evt_checkout_sell_list_merged"],
          },
        ],
      },
    });
  });
});
