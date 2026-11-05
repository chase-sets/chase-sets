import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceApiError } from "@chase-sets/marketplace/server";
import {
  createCheckoutOrdersThroughOrdering,
  createCheckoutPaymentThroughPayments,
  previewBuyNowCheckoutSupplyThroughOrdering,
  submitPurchaseIntentThroughMarketplace,
} from "../support/request-support/checkout-confirmation";
import type { CheckoutApiEnv } from "../api";
import { createAccountCheckoutSessionRoutes } from "../features/sessions/api/route";
import type { CheckoutSessionServices } from "../features/sessions/api/runtime";
import type { CheckoutSessionRow } from "../features/sessions/read-model/queries";

const mockPreviewCheckoutFulfillment = vi.fn();
const mockCreateCheckoutOrders = vi.fn();
const mockCreateSubmittedOffer = vi.fn();
const mockGetCheckoutStatus = vi.fn();
const mockCreateAccountPayment = vi.fn();
const mockCreateCheckoutReservation = vi.fn();
const mockGetMutationAttempt = vi.fn();
const inventoryAttemptIds: string[] = [];

vi.mock("@chase-sets/ordering/server", () => ({
  createOrderingRequestApiClient: () => ({
    previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    createCheckoutOrders: mockCreateCheckoutOrders,
  }),
}));

vi.mock("@chase-sets/payments/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/payments/server")>("@chase-sets/payments/server");

  return {
    ...actual,
    createPaymentsRequestApiClient: () => ({
      getCheckoutStatus: mockGetCheckoutStatus,
      createAccountPayment: mockCreateAccountPayment,
    }),
  };
});

vi.mock("@chase-sets/inventory/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/inventory/server")>("@chase-sets/inventory/server");

  return {
    ...actual,
    createInventoryRequestApiClient: (_request: Request, options: { mutationAttemptId: string }) => ({
      createCheckoutReservation: (input: unknown) => {
        inventoryAttemptIds.push(options.mutationAttemptId);
        return mockCreateCheckoutReservation(options.mutationAttemptId, input);
      },
      getMutationAttempt: mockGetMutationAttempt,
    }),
  };
});

vi.mock("@chase-sets/marketplace/server", () => ({
  MarketplaceApiError: class MarketplaceApiError extends Error {
    status: number;
    body: unknown;

    constructor(status: number, body: unknown) {
      super("Marketplace API request failed.");
      this.status = status;
      this.body = body;
    }
  },
  createMarketplaceRequestApiClient: () => ({
    createSubmittedOffer: mockCreateSubmittedOffer,
  }),
}));

describe("checkout confirmation support", () => {
  beforeEach(() => {
    mockPreviewCheckoutFulfillment.mockReset();
    mockCreateCheckoutOrders.mockReset();
    mockCreateSubmittedOffer.mockReset();
  });

  const cartSession = {
    session_id: "chk_1",
    source_type: "cart",
    shipping_option: "standard",
    shipping_address: {
      name: "Jane Smith",
      line1: "100 Market Street",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    optimization_goal: "lowest-total",
    lines: [
      {
        cartLineId: "cli_1",
        listingId: null,
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
      },
    ],
  } as const;

  const offerIntentSession = {
    ...cartSession,
    session_id: "chk_offer_1",
    source_type: "offer-intent",
    lines: [
      {
        cartLineId: null,
        listingId: null,
        catalogItemId: "cat_offer",
        productId: "cat_offer::form:raw",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Raw",
        offerPriceAmount: "350.00",
        offerPriceCurrencyCode: "USD",
        quantity: 2,
      },
    ],
  } as const;

  it("forwards the fresh fulfillment preview revision when the client does not submit one", async () => {
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "preview_policy_v2",
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutOrders.mockResolvedValue({
      orderIds: ["ord_1"],
    });

    await createCheckoutOrdersThroughOrdering(
      new Request("https://checkout.test/checkout/buy/session/chk_1"),
      cartSession as never,
    );

    expect(mockCreateCheckoutOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "chk_1",
        fulfillmentPreviewRevision: "preview_policy_v2",
      }),
    );
  });

  it("maps Checkout cart source to the Ordering cart-checkout source", async () => {
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "preview_policy_v2",
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutOrders.mockResolvedValue({
      orderIds: ["ord_1"],
    });

    await createCheckoutOrdersThroughOrdering(
      new Request("https://checkout.test/checkout/buy/session/chk_1"),
      cartSession as never,
    );

    expect(mockPreviewCheckoutFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: "cart-checkout" }),
    );
    expect(mockCreateCheckoutOrders).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "cart-checkout" }));
  });

  it("keeps Buy Now source stable when creating Ordering orders", async () => {
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "preview_policy_v2",
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutOrders.mockResolvedValue({
      orderIds: ["ord_1"],
    });

    await createCheckoutOrdersThroughOrdering(new Request("https://checkout.test/checkout/buy/session/chk_1"), {
      ...cartSession,
      source_type: "buy-now",
    } as never);

    expect(mockPreviewCheckoutFulfillment).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "buy-now" }));
    expect(mockCreateCheckoutOrders).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "buy-now" }));
  });

  it("preflights Buy Now locked listing supply through Ordering", async () => {
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "preview_buy_now_ready",
      readyLineKeys: ["lst_1:0"],
      unavailableLineKeys: [],
      unavailableLines: [],
    });

    await previewBuyNowCheckoutSupplyThroughOrdering(new Request("https://checkout.test/account/checkout-sessions"), {
      checkoutSessionId: "chk_buy_now_preflight",
      shippingOption: "standard",
      optimizationGoal: "lowest-total",
      line: {
        cartLineId: null,
        listingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "cat_1::form:raw",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Raw",
        quantity: 1,
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_1",
        sellerPreferenceId: "lst_1",
      },
    });

    expect(mockPreviewCheckoutFulfillment).toHaveBeenCalledWith({
      checkoutSessionId: "chk_buy_now_preflight",
      sourceType: "buy-now",
      shippingOption: "standard",
      optimizationGoal: "lowest-total",
      lines: [
        expect.objectContaining({
          listingId: "lst_1",
          lockedListingId: "lst_1",
          fulfillmentMode: "locked-listing",
          productId: "cat_1::form:raw",
        }),
      ],
    });
  });

  it("does not map offer intent directly to Ordering", async () => {
    await expect(
      createCheckoutOrdersThroughOrdering(new Request("https://checkout.test/checkout/buy/session/chk_1"), {
        ...cartSession,
        source_type: "offer-intent",
      } as never),
    ).rejects.toThrow("Offer intent submits a Marketplace offer and does not create orders during checkout.");

    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrders).not.toHaveBeenCalled();
  });

  it("submits offer-intent sessions through Marketplace with the checkout source facts", async () => {
    mockCreateSubmittedOffer.mockResolvedValue({
      id: "off_marketplace_1",
      commandReceipt: { commitPosition: "42" },
    });

    const result = await submitPurchaseIntentThroughMarketplace(
      new Request("https://checkout.test/checkout/buy/session/chk_offer_1"),
      offerIntentSession as never,
    );

    expect(result).toEqual({
      offerId: "off_marketplace_1",
      writeResult: {
        id: "off_marketplace_1",
        commandReceipt: { commitPosition: "42" },
      },
    });
    expect(mockCreateSubmittedOffer).toHaveBeenCalledWith({
      offerId: "off_offer_1",
      attemptId: "off_offer_1___________",
      catalogItemId: "cat_offer",
      productId: "cat_offer::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      shippingDestinationSnapshot: offerIntentSession.shipping_address,
      priceAmount: "350.00",
      priceCurrencyCode: "USD",
      quantityRequested: 2,
    });
    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrders).not.toHaveBeenCalled();
  });

  it("requires shipping destination before submitting purchase intent", async () => {
    await expect(
      submitPurchaseIntentThroughMarketplace(new Request("https://checkout.test/checkout/buy/session/chk_offer_1"), {
        ...offerIntentSession,
        shipping_address: null,
      } as never),
    ).rejects.toThrow("Shipping destination is required before checkout can place purchase intent.");

    expect(mockCreateSubmittedOffer).not.toHaveBeenCalled();
    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrders).not.toHaveBeenCalled();
  });

  it("requires an offer price before submitting purchase intent", async () => {
    await expect(
      submitPurchaseIntentThroughMarketplace(new Request("https://checkout.test/checkout/buy/session/chk_offer_1"), {
        ...offerIntentSession,
        lines: [{ ...offerIntentSession.lines[0], offerPriceAmount: "   " }],
      } as never),
    ).rejects.toThrow("Purchase intent requires a complete Offer amount and currency.");

    expect(mockCreateSubmittedOffer).not.toHaveBeenCalled();
    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrders).not.toHaveBeenCalled();
  });

  it("treats already-submitted Marketplace offers as idempotent", async () => {
    mockCreateSubmittedOffer.mockRejectedValue(
      new MarketplaceApiError(400, { error: { message: "Offer has already been submitted." } }),
    );

    await expect(
      submitPurchaseIntentThroughMarketplace(
        new Request("https://checkout.test/checkout/buy/session/chk_offer_1"),
        offerIntentSession as never,
      ),
    ).resolves.toEqual({
      offerId: "off_offer_1",
      writeResult: null,
    });

    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrders).not.toHaveBeenCalled();
  });
});

/** An owner answer the caller never saw: the owner committed, then the response was lost. */
class ResponseLost extends Error {
  public readonly status = 503;
  public readonly body = { error: { code: "upstream_unavailable" } };
}

class PaymentsAnswer extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super("Payments API request failed.");
  }
}

type ConfirmBoundary = "inventory-hold" | "ordering" | "payments" | "purchase-intent-offer" | "session-record";

const buyerActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_buyer",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["orders.view", "orders.manage"],
} as unknown as NonNullable<CheckoutApiEnv["Variables"]["actor"]>;

const boundaryShippingAddress = {
  name: "Jane Smith",
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
} as const;

function boundarySession(sourceType: "cart" | "offer-intent"): CheckoutSessionRow {
  return {
    session_id: "chk_1",
    buyer_account_id: "acc_buyer",
    source_type: sourceType,
    optimization_goal: "lowest-total",
    fulfillment_preview_revision: null,
    fulfillment_preview_snapshot:
      sourceType === "cart"
        ? ({
            revision: "preview_1",
            sellerGroups: [
              {
                lines: [
                  {
                    lineKey: "cli_1",
                    sellerAccountId: "acc_seller",
                    inventoryItemId: "inv_1",
                    catalogItemId: "cat_1",
                    productId: "cat_1::",
                    itemTitle: "Charizard",
                    productSummary: null,
                    quantity: 1,
                  },
                ],
              },
            ],
          } as never)
        : null,
    shipping_option: "standard",
    shipping_address_id: null,
    lines: [
      {
        listingId: null,
        cartLineId: sourceType === "cart" ? "cli_1" : null,
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
        ...(sourceType === "offer-intent" ? { offerPriceAmount: "350.00", offerPriceCurrencyCode: "USD" } : {}),
      },
    ],
    shipping_address: boundaryShippingAddress,
    checkout_reservations: [],
    order_ids: [],
    order_write_commit_positions: [],
    payment_id: null,
    submitted_offer_id: null,
    handoff_expires_at: null,
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
  } as CheckoutSessionRow;
}

/**
 * The Checkout Session and every downstream owner, each deduping by the
 * identity it already keys on: Inventory by mutation attempt id, Ordering by
 * Checkout Session id, Payments by `checkout` source reference, Marketplace by
 * the Session-derived Offer id. The failing boundary commits, then loses its
 * answer once.
 */
function boundaryOwners(sourceType: "cart" | "offer-intent", failing: ConfirmBoundary) {
  let row = boundarySession(sourceType);
  let bound: { orderHash: string | null; paymentHash: string | null } = { orderHash: null, paymentHash: null };
  const lost = new Set<ConfirmBoundary>();
  const loseAnswerOnce = (boundary: ConfirmBoundary) => {
    if (boundary === failing && !lost.has(boundary)) {
      lost.add(boundary);
      throw new ResponseLost("The owner committed, then the answer was lost.");
    }
  };
  const holds = new Map<string, unknown>();
  const orders = new Map<string, readonly string[]>();
  const payments = new Map<string, string>();
  const offers = new Set<string>();
  const identities = {
    inventory: inventoryAttemptIds,
    ordering: [] as string[],
    payments: [] as string[],
    offers: [] as string[],
  };

  mockCreateCheckoutReservation.mockImplementation(
    async (attemptId: string, input: { lineKey: string; quantity: number }) => {
      if (!holds.has(attemptId)) {
        holds.set(attemptId, {
          holdId: `hld_${holds.size + 1}`,
          lineKey: input.lineKey,
          sellerAccountId: "acc_seller",
          inventoryItemId: "inv_1",
          quantity: input.quantity,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          extensionCount: 0,
          status: "active",
        });
        loseAnswerOnce("inventory-hold");
      }
      return holds.get(attemptId);
    },
  );
  // The receipt lookup is lost with the answer, so the caller cannot recover inside the request.
  mockGetMutationAttempt.mockRejectedValue(new TypeError("fetch failed"));
  mockPreviewCheckoutFulfillment.mockResolvedValue({ revision: "preview_1", readyLineKeys: ["cli_1"] });
  mockCreateCheckoutOrders.mockImplementation(async (input: { checkoutSessionId: string }) => {
    identities.ordering.push(input.checkoutSessionId);
    if (!orders.has(input.checkoutSessionId)) {
      orders.set(input.checkoutSessionId, [`ord_${orders.size + 1}`]);
      loseAnswerOnce("ordering");
    }
    return { orderIds: orders.get(input.checkoutSessionId) };
  });
  mockGetCheckoutStatus.mockResolvedValue({});
  mockCreateAccountPayment.mockImplementation(async (input: { sourceContext: string; sourceReferenceId: string }) => {
    const identity = `${input.sourceContext}:${input.sourceReferenceId}`;
    identities.payments.push(identity);
    if (!payments.has(identity)) {
      payments.set(identity, `pay_${payments.size + 1}`);
      loseAnswerOnce("payments");
    }
    return { payment_id: payments.get(identity) };
  });
  mockCreateSubmittedOffer.mockImplementation(async (input: { offerId: string; attemptId: string }) => {
    identities.offers.push(`${input.offerId}:${input.attemptId}`);
    if (offers.has(input.offerId)) {
      throw new MarketplaceApiError(400, { error: { message: "Offer has already been submitted." } });
    }
    offers.add(input.offerId);
    loseAnswerOnce("purchase-intent-offer");
    return { id: input.offerId };
  });

  const mutation = () => ({ sessionId: row.session_id as never, session: row });
  // Typed against the real interface: confirm consumes exactly these members.
  const services: Pick<
    CheckoutSessionServices,
    | "getSession"
    | "getConfirmationBinding"
    | "resumeOrderCartCleanup"
    | "verifyShippingAddress"
    | "setShippingAddress"
    | "assertReadyForOrderCreation"
    | "recordCheckoutReservations"
    | "recordOrdersCreated"
    | "recordPaymentStarted"
    | "recordOfferSubmitted"
  > = {
    getSession: vi.fn(async () => row),
    getConfirmationBinding: vi.fn(async () => bound),
    resumeOrderCartCleanup: vi.fn(async () => mutation()),
    verifyShippingAddress: vi.fn(async (address) => ({ status: "accepted" as const, shippingAddress: address })),
    setShippingAddress: vi.fn(async () => mutation()),
    assertReadyForOrderCreation: vi.fn(async () => row),
    recordCheckoutReservations: vi.fn(async ({ reservations }) => {
      row = { ...row, checkout_reservations: [...reservations] };
      return mutation();
    }),
    recordOrdersCreated: vi.fn(async ({ orderIds, orderHash }) => {
      if (row.order_ids.length === 0) {
        row = { ...row, order_ids: [...orderIds] };
        bound = { ...bound, orderHash: orderHash ?? null };
      }
      return mutation();
    }),
    recordPaymentStarted: vi.fn(async ({ paymentId, paymentHash }) => {
      if (!row.payment_id) {
        row = { ...row, payment_id: paymentId };
        bound = { ...bound, paymentHash: paymentHash ?? null };
        loseAnswerOnce("session-record");
      }
      return mutation();
    }),
    recordOfferSubmitted: vi.fn(async ({ offerId }) => {
      if (!row.submitted_offer_id) {
        row = { ...row, submitted_offer_id: offerId };
        loseAnswerOnce("session-record");
      }
      return mutation();
    }),
  };
  const app = new Hono<CheckoutApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", buyerActor);
    c.set("context", {
      tenantId: buyerActor.tenantId,
      audit: { performedByUserId: buyerActor.userId, forAccountId: buyerActor.accountId },
    } as never);
    await next();
  });
  app.route("/account", createAccountCheckoutSessionRoutes(services as unknown as CheckoutSessionServices));
  const confirm = () =>
    app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress: boundaryShippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
          paymentMethodCategory: "card",
        }),
      }),
    );
  return { confirm, holds, orders, payments, offers, identities, lost };
}

describe("checkout confirmation boundary matrix", () => {
  beforeEach(() => {
    inventoryAttemptIds.length = 0;
    for (const mock of [
      mockPreviewCheckoutFulfillment,
      mockCreateCheckoutOrders,
      mockCreateSubmittedOffer,
      mockGetCheckoutStatus,
      mockCreateAccountPayment,
      mockCreateCheckoutReservation,
      mockGetMutationAttempt,
    ]) {
      mock.mockReset();
    }
  });

  it.each(["inventory-hold", "ordering", "payments", "session-record"] as const)(
    "commit-then-throw after %s, then an exact retry: one Session-derived identity per owner and the first result",
    async (boundary) => {
      const owners = boundaryOwners("cart", boundary);

      const interrupted = await owners.confirm();
      const retried = await owners.confirm();

      expect(owners.lost).toEqual(new Set([boundary]));
      expect(interrupted.status).not.toBe(200);
      expect(retried.status).toBe(200);
      await expect(retried.json()).resolves.toMatchObject({ payment_id: "pay_1", order_ids: ["ord_1"] });
      expect(new Set(owners.identities.inventory).size).toBe(1);
      expect(new Set(owners.identities.ordering)).toEqual(new Set(["chk_1"]));
      expect(new Set(owners.identities.payments)).toEqual(new Set(["checkout:chk_1"]));
      expect(owners.holds.size).toBe(1);
      expect(owners.orders.size).toBe(1);
      expect(owners.payments.size).toBe(1);
    },
  );

  it.each(["purchase-intent-offer", "session-record"] as const)(
    "commit-then-throw after %s on purchase intent, then an exact retry: one Offer identity and the first Offer",
    async (boundary) => {
      const owners = boundaryOwners("offer-intent", boundary);

      const interrupted = await owners.confirm();
      const retried = await owners.confirm();

      expect(owners.lost).toEqual(new Set([boundary]));
      expect(interrupted.status).not.toBe(200);
      expect(retried.status).toBe(200);
      await expect(retried.json()).resolves.toMatchObject({
        offer_id: "off_1",
        status: "purchase-intent-submitted",
      });
      expect(new Set(owners.identities.offers)).toEqual(new Set([`off_1:${"off_1".padEnd(22, "_")}`]));
      expect(owners.offers).toEqual(new Set(["off_1"]));
      expect(owners.orders.size).toBe(0);
      expect(owners.payments.size).toBe(0);
    },
  );
});

describe("checkout payment start readiness call counts", () => {
  const request = () => new Request("https://checkout.test/account/checkout-sessions/chk_1/confirm");
  const start = () =>
    createCheckoutPaymentThroughPayments(
      request(),
      "chk_1",
      ["ord_1"],
      null,
      "card",
      "quote_1",
      null,
      false,
      "/account/payments/:paymentId",
      null,
      undefined,
      { maxAttempts: 5, delayMs: 0 },
    );

  beforeEach(() => {
    mockGetCheckoutStatus.mockReset();
    mockCreateAccountPayment.mockReset();
  });

  it.each([
    ["order_input_not_ready", 400],
    ["order_not_payment_ready", 400],
    ["projection_freshness_timeout", 503],
  ] as const)("repeats payment creation on readiness code %s without a second payment", async (code, status) => {
    const created = new Map<string, string>();
    let refusals = 0;
    mockCreateAccountPayment.mockImplementation(async (input: { sourceReferenceId: string }) => {
      if (refusals < 2) {
        refusals += 1;
        throw new PaymentsAnswer(status, { error: { code } });
      }
      if (!created.has(input.sourceReferenceId)) created.set(input.sourceReferenceId, `pay_${created.size + 1}`);
      return { payment_id: created.get(input.sourceReferenceId) };
    });

    await expect(start()).resolves.toEqual({ payment_id: "pay_1" });

    expect(mockCreateAccountPayment).toHaveBeenCalledTimes(3);
    expect(new Set(mockCreateAccountPayment.mock.calls.map(([input]) => input.sourceReferenceId))).toEqual(
      new Set(["chk_1"]),
    );
    expect(created.size).toBe(1);
  });

  it.each([
    ["a validation refusal", new PaymentsAnswer(400, { error: { code: "payment_method_unavailable" } })],
    ["a conflict", new PaymentsAnswer(409, { error: { code: "fee_quote_stale" } })],
    ["a server failure", new PaymentsAnswer(500, { error: { code: "internal_error" } })],
    ["a lost answer", new TypeError("fetch failed")],
  ])("stops owner calls after %s", async (_label, error) => {
    mockCreateAccountPayment.mockRejectedValue(error);

    await expect(start()).rejects.toBe(error);

    expect(mockCreateAccountPayment).toHaveBeenCalledTimes(1);
  });
});
