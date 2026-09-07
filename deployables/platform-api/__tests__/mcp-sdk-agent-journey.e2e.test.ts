import { createHash, generateKeyPairSync } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { module as checkoutModule } from "@chase-sets/checkout";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { module as paymentsModule } from "@chase-sets/payments";
import { module as settlementModule } from "@chase-sets/settlement";
import type { createCheckoutUcpHandlers } from "@chase-sets/checkout/server";
import { createUcpEnvelope } from "@chase-sets/platform-runtime/ucp";
import type { AgentGrantRateLimiter } from "@chase-sets/platform-runtime/agent-guardrails";
import { buildPlatformApiApp } from "../src/app";

/**
 * Derived from the Checkout module's own MCP service contract, so the SDK
 * journey drives the same Cart interface the composed handler calls. The row
 * keeps `buyer_account_id` because the real internal row does -- whether it
 * survives the composed boundary is what this journey observes.
 */
type CheckoutMcpCartService = Parameters<NonNullable<typeof checkoutModule.buildMcpHandlers>>[0]["cart"];
type CheckoutCartRead = CheckoutMcpCartService["listAuthorizedCartLines"];
type CheckoutCartLineRow = Awaited<ReturnType<CheckoutCartRead>>[number];

function checkoutCartLineRow(overrides: Partial<CheckoutCartLineRow> = {}): CheckoutCartLineRow {
  return {
    buyer_account_id: "anon_raw_marker",
    line_id: "cart_line_1",
    catalog_catalog_item_id: "cat_1",
    product_id: "product_1",
    item_language_code: "en",
    item_title: "Charizard ex",
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
    locked_listing_id: "listing_1",
    selected_listing_id: null,
    selected_listing_seller_account_id: null,
    selected_listing_seller_display_name: null,
    selected_listing_seller_slug: null,
    selected_listing_price_amount: null,
    selected_listing_snapshot_source: null,
    selected_listing_snapshot_captured_at: null,
    seller_preference_id: null,
    availability_state: "available",
    seller_options: [],
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function agentActor(permissions: readonly string[]) {
  return {
    sessionId: "ucp:grant_full_journey",
    tenantId: "tenant_1",
    userId: "agent_user_1",
    accountId: "acc_1",
    membershipId: "member_1",
    roleKey: "agent",
    permissions,
  };
}

function createRuntime(services: Record<string, unknown>, modules: readonly { module: unknown; services: unknown }[]) {
  return {
    mountedContexts: [],
    mountedModules: modules,
    services: {
      auth: {},
      identity: {},
      ...services,
    },
    projectionGroups: [],
    subscriptionRunners: [],
  } as never;
}

async function withMcpClient<T>(
  app: ReturnType<typeof buildPlatformApiApp>,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "chase-sets-uat-agent", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://platform-api.test/mcp"), {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return app.fetch(request);
    },
  });

  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close();
  }
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = (result as { content?: readonly unknown[] }).content ?? [];
  return content
    .map((entry) =>
      typeof entry === "object" && entry !== null && "text" in entry && typeof entry.text === "string"
        ? entry.text
        : JSON.stringify(entry),
    )
    .join("\n");
}

function expectStructured(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError, textContent(result)).not.toBe(true);
  return result.structuredContent;
}

function callConfirmedTool(
  client: Client,
  request: Parameters<Client["callTool"]>[0] &
    Readonly<{
      confirmation: {
        confirmed: true;
        text: string;
      };
    }>,
) {
  return client.callTool(request as Parameters<Client["callTool"]>[0]);
}

function signedUcpHeaders(body: string) {
  return {
    "Content-Type": "application/json",
    "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"',
    "Idempotency-Key": "uat_spend_cap_checkout",
    "Signature-Input": 'sig1=("@method" "@path" "content-digest");created=1778940000',
    Signature: "sig1=:placeholder:",
    "Content-Digest": `sha-256=:${createHash("sha256").update(body).digest("base64")}:`,
  };
}

function stubPaymentsCheckoutStatusFetch(
  getCheckoutStatus: (params: Readonly<Record<string, unknown>>) => Promise<unknown>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/marketplace/account/checkout/status") {
      return Response.json(
        await getCheckoutStatus({
          accountId: "acc_1",
          orderIds: url.searchParams.get("orderIds")?.split(",").filter(Boolean) ?? [],
          currencyCode: url.searchParams.get("currencyCode") ?? "usd",
          requestedBalanceCreditAmount: url.searchParams.get("requestedBalanceCreditAmount"),
          paymentMethodCategory: url.searchParams.get("paymentMethodCategory"),
        }),
      );
    }

    return Response.json(
      {
        error: {
          code: "unexpected_fetch",
          message: `Unexpected forwarded fetch in MCP journey test: ${request.method} ${url.pathname}`,
        },
      },
      { status: 500 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const shippingDestination = {
  name: "Ari Buyer",
  line1: "100 Market St",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  email: "ari@example.test",
};

describe("native MCP SDK full commerce journey @mcp-sdk-journey", () => {
  it("drives /mcp with the official SDK through browse, offer, fulfillment, and settlement reads", async () => {
    const listing = {
      listing_id: "listing_1",
      account_id: "acc_1",
      inventory_item_id: "inventory_1",
      catalog_item_id: "cat_1",
      product_id: "product_1",
      title: "Charizard ex",
      status: "published",
      price_amount: "25.00",
      quantity_available: 1,
      fee_quote_fingerprint: "fee_quote_1",
    };
    const offer = {
      offer_id: "off_1",
      buyer_account_id: "acc_1",
      seller_account_id: "acc_1",
      catalog_item_id: "cat_1",
      product_id: "product_1",
      status: "accepted",
      price_amount: "24.00",
      quantity_requested: 1,
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    };
    const shipment = {
      shipment_id: "shipment_1",
      order_id: "order_1",
      buyer_account_id: "acc_1",
      seller_account_id: "acc_1",
      status: "label_purchased",
      tracking_number: "9400111899223857463029",
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    };
    const payout = {
      payout_id: "payout_1",
      account_id: "acc_1",
      amount: "24.00",
      currency_code: "USD",
      status: "requested",
      requested_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    };
    const wallet = {
      account_id: "acc_1",
      currency_code: "USD",
      pending_balance_amount: "0.00",
      available_balance_amount: "24.00",
    };
    const listingServices = {
      listSellerListings: vi.fn(async () => ({ items: [listing], total: 1 })),
      getSellerListing: vi.fn(async () => listing),
      getSellerListingAvailability: vi.fn(async () => ({ canList: true })),
      listSellerListingFeeLockReport: vi.fn(async () => ({ items: [], total: 0 })),
      listSellerInventoryItemSupply: vi.fn(async () => ({ items: [], total: 0 })),
      createListing: vi.fn(async () => ({ listingId: "listing_1", version: 1, feeQuoteFingerprint: "fee_quote_1" })),
      updateListingPrice: vi.fn(),
      publishListing: vi.fn(),
      pauseListing: vi.fn(),
    };
    const offerServices = {
      submitOffer: vi.fn(async () => ({ offerId: "off_1", version: 1 })),
      acceptOffer: vi.fn(async () => ({ offerId: "off_1", version: 2 })),
      declineOfferMatch: vi.fn(),
      listSubmittedOffers: vi.fn(async () => ({ items: [offer], total: 1 })),
      listSellerOfferMatches: vi.fn(async () => ({ items: [offer], total: 1 })),
      getOffer: vi.fn(async () => offer),
      getSubmittedOffer: vi.fn(async () => offer),
      getSellerOfferMatch: vi.fn(async () => offer),
    };
    const checkoutServices = {
      cart: {
        listAuthorizedCartLines: vi.fn<CheckoutCartRead>(async () => [checkoutCartLineRow()]),
      },
    };
    const fulfillmentServices = {
      shipments: {
        listSellerShipments: vi.fn(async () => ({ items: [shipment], total: 1 })),
        listBuyerShipments: vi.fn(async () => ({ items: [shipment], total: 1 })),
        getShipment: vi.fn(async () => shipment),
        getBuyerShipment: vi.fn(async () => shipment),
        getSellerShipment: vi.fn(async () => shipment),
        purchaseLabel: vi.fn(async () => ({ shipmentId: "shipment_1", version: 3, shipment })),
        voidLabel: vi.fn(),
      },
    };
    const settlementServices = {
      wallets: {
        getWallet: vi.fn(async () => wallet),
        listWalletEntries: vi.fn(async () => ({
          items: [
            {
              ledger_entry_id: "ledger_1",
              account_id: "acc_1",
              amount: "24.00",
              currency_code: "USD",
              direction: "credit",
              source_type: "order",
              source_id: "order_1",
              created_at: "2026-07-08T00:00:00.000Z",
            },
          ],
          total: 1,
        })),
      },
      payouts: {
        listPayouts: vi.fn(async () => ({ items: [payout], total: 1 })),
        getPayout: vi.fn(async () => payout),
        requestPayout: vi.fn(async () => ({ payoutId: "payout_1", version: 1, payout })),
      },
      payoutReadiness: {
        refreshReadiness: vi.fn(),
        createOnboardingLink: vi.fn(),
      },
    };
    const app = buildPlatformApiApp(
      createRuntime(
        {
          checkout: checkoutServices,
          fulfillment: fulfillmentServices,
          marketplace: { listings: listingServices, offers: offerServices, reviews: {} },
          settlement: settlementServices,
        },
        [
          { module: marketplaceModule, services: { listings: listingServices, offers: offerServices, reviews: {} } },
          { module: checkoutModule, services: checkoutServices },
          { module: fulfillmentModule, services: fulfillmentServices },
          { module: settlementModule, services: settlementServices },
        ],
      ),
      {
        resolveActor: vi.fn(async () =>
          agentActor([
            "listings.view",
            "listings.manage",
            "offers.view",
            "offers.manage",
            "orders.view",
            "fulfillment.view",
            "payouts.view",
            "payouts.request",
          ]),
        ),
      },
    );

    await withMcpClient(app, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "marketplace.list-listings",
          "marketplace.submit-offer",
          "marketplace.accept-offer",
          "checkout.get-cart",
          "fulfillment.list-shipments",
          "settlement.get-wallet",
          "settlement.request-payout",
        ]),
      );

      const browse = await client.callTool({
        name: "marketplace.list-listings",
        arguments: { accountId: "acc_1", limit: 10 },
      });
      expect(browse.structuredContent).toMatchObject({ count: 1, items: [expect.objectContaining(listing)] });

      const submitted = await callConfirmedTool(client, {
        name: "marketplace.submit-offer",
        arguments: {
          accountId: "acc_1",
          catalogItemId: "cat_1",
          productId: "product_1",
          itemTitle: "Charizard ex",
          priceAmount: "24.00",
          quantityRequested: 1,
          shippingDestinationSnapshot: shippingDestination,
          idempotencyKey: "offer-submit-1",
          confirmationText: "Submit Offer.",
        },
        confirmation: { confirmed: true, text: "Submit Offer." },
      });
      expect(expectStructured(submitted)).toMatchObject({
        accountId: "acc_1",
        offerId: "off_1",
        status: "submitted",
        resourceUri: "chase-sets://marketplace/acc_1/offers/off_1",
      });

      const accepted = await callConfirmedTool(client, {
        name: "marketplace.accept-offer",
        arguments: {
          accountId: "acc_1",
          offerId: "off_1",
          listingId: listing.listing_id,
          feeQuoteFingerprint: "fee_quote_1",
          sourceActionKey: "uat-agent:accept-offer-1",
          idempotencyKey: "offer-accept-1",
          confirmationText: "Accept Offer.",
        },
        confirmation: { confirmed: true, text: "Accept Offer." },
      });
      expect(expectStructured(accepted)).toMatchObject({
        accountId: "acc_1",
        offerId: "off_1",
        version: 2,
        status: "accepted",
      });

      await expect(client.readResource({ uri: "chase-sets://marketplace/acc_1/offers/off_1" })).resolves.toMatchObject({
        contents: [
          {
            uri: "chase-sets://marketplace/acc_1/offers/off_1",
            text: expect.stringContaining("off_1"),
          },
        ],
      });

      const cart = expectStructured(
        await client.callTool({ name: "checkout.get-cart", arguments: { accountId: "acc_1" } }),
      );
      expect(cart).toMatchObject({ accountId: "acc_1", total: 1 });
      // The official SDK validated this payload against the published
      // `checkout.get-cart` output schema it cached from `listTools()`. The
      // owner marker the service returned is absent from the wire, and the
      // schema no longer demands it.
      expect(JSON.stringify(cart)).not.toContain("anon_raw_marker");
      expect(JSON.stringify(cart)).not.toContain("buyer_account_id");
      expect((cart as { items: readonly Record<string, unknown>[] }).items[0]).toMatchObject({
        line_id: "cart_line_1",
        item_title: "Charizard ex",
      });
      const publishedCartLineSchema = (
        tools.tools.find((tool) => tool.name === "checkout.get-cart")?.outputSchema?.properties as
          | Record<string, { items?: { required?: readonly string[]; properties?: Record<string, unknown> } }>
          | undefined
      )?.items?.items;
      expect(publishedCartLineSchema?.required).toEqual(["line_id", "quantity"]);
      expect(Object.keys(publishedCartLineSchema?.properties ?? {})).not.toContain("buyer_account_id");
      expect(
        expectStructured(
          await client.callTool({
            name: "fulfillment.list-shipments",
            arguments: { accountId: "acc_1", side: "sale" },
          }),
        ),
      ).toMatchObject({ accountId: "acc_1", side: "sale", count: 1 });
      await expect(
        client.readResource({ uri: "chase-sets://fulfillment/acc_1/shipments/shipment_1" }),
      ).resolves.toMatchObject({
        contents: [{ text: expect.stringContaining("shipment_1") }],
      });
      expect(
        expectStructured(await client.callTool({ name: "settlement.get-wallet", arguments: { accountId: "acc_1" } })),
      ).toMatchObject({ accountId: "acc_1", wallet });
      expect(
        expectStructured(
          await callConfirmedTool(client, {
            name: "settlement.request-payout",
            arguments: {
              accountId: "acc_1",
              amount: "24.00",
              reason: "UAT settlement read after accepted offer",
              idempotencyKey: "payout-request-1",
              confirmationText: "Request Payout.",
            },
            confirmation: { confirmed: true, text: "Request Payout." },
          }),
        ),
      ).toMatchObject({
        accountId: "acc_1",
        payoutId: "payout_1",
        status: "requested",
        resourceUri: "chase-sets://settlement/acc_1/payouts/payout_1",
      });
      await expect(
        client.readResource({ uri: "chase-sets://settlement/acc_1/payouts/payout_1" }),
      ).resolves.toMatchObject({
        contents: [{ text: expect.stringContaining("payout_1") }],
      });
    });

    expect(offerServices.submitOffer).toHaveBeenCalledTimes(1);
    expect(offerServices.acceptOffer).toHaveBeenCalledTimes(1);
    expect(settlementServices.payouts.requestPayout).toHaveBeenCalledTimes(1);
  });

  it("asserts native MCP agent grant rate-limit and checkout spend-cap guardrail rejections", async () => {
    type CheckoutSession = Awaited<
      ReturnType<Parameters<typeof createCheckoutUcpHandlers>[0]["sessions"]["resumeOrderCartCleanup"]>
    >["session"];

    const buyNowSession: CheckoutSession = {
      session_id: "chk_1",
      buyer_account_id: "acc_1",
      source_type: "buy-now",
      optimization_goal: "lowest-total",
      fulfillment_preview_revision: null,
      fulfillment_preview_snapshot: null,
      cart_readiness_snapshot: null,
      split_group_handoff: null,
      shipping_option: "standard",
      shipping_address_id: null,
      shipping_address: null,
      authenticity_check_opt_in: null,
      lines: [
        {
          listingId: "listing_1",
          cartLineId: null,
          catalogItemId: "cat_1",
          productId: "product_1",
          itemTitle: "Charizard ex",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
          offerPriceAmount: null,
          fulfillmentMode: "locked-listing",
          lockedListingId: "listing_1",
          sellerPreferenceId: null,
          availabilityState: "available",
        },
      ],
      order_ids: ["order_1"],
      order_write_commit_positions: [],
      checkout_reservations: [],
      payment_id: null,
      submitted_offer_id: null,
      cancelled_at: null,
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    };
    const checkoutSessions = {
      createOfferIntent: vi.fn(),
      createBuyNowSession: vi.fn(),
      getSession: vi.fn(),
      resumeOrderCartCleanup: vi.fn<
        Parameters<typeof createCheckoutUcpHandlers>[0]["sessions"]["resumeOrderCartCleanup"]
      >(async () => ({ sessionId: "chk_1", session: buyNowSession })),
      projectionHandlerSets: [],
    };
    const rateLimiter: AgentGrantRateLimiter = {
      check: vi
        .fn()
        .mockReturnValueOnce({ allowed: true, decision: { limited: false } })
        .mockReturnValueOnce({
          allowed: false,
          decision: { limited: true },
          reason: "This agent grant is sending writes too quickly. Retry after the rate-limit window.",
        }),
    };
    const guardedOffers = {
      submitOffer: vi.fn(async () => ({ offerId: "offer_rate_1", version: 1 })),
      acceptOffer: vi.fn(),
      declineOfferMatch: vi.fn(),
      listSubmittedOffers: vi.fn(),
      listSellerOfferMatches: vi.fn(),
      getOffer: vi.fn(),
    };
    const spendPolicy = {
      authorize: vi.fn(async () => ({
        allowed: false,
        limitKind: "daily-cap" as const,
        reason: "This agent grant exceeded its platform spend cap.",
        remainingCents: 0,
        capCents: 100,
      })),
    };
    const paymentServices = {
      publicConfig: {
        processorName: "stripe",
        publishableKey: "pk_test_123",
        confirmationExperience: "processor-managed-form",
        dynamicPaymentMethods: true,
        sensitivePaymentDetailsHandledByProcessor: true,
        agenticPaymentHandlers: [
          {
            id: "stripe-shared-payment-token",
            provider: "stripe",
            type: "shared_payment_token",
            requiresAp2Mandate: true,
            confirmationExperience: "server-confirmed-payment-intent",
          },
        ],
      },
      getCheckoutStatus: vi.fn(async (_params: Readonly<Record<string, unknown>>) => ({
        order_ids: ["order_1"],
        currency_code: "usd",
        amount: "25.00",
        marketplace_checkout_fee: {
          payment_method_category: "card",
          external_basis_amount: "25.00",
          marketplace_checkout_fee_amount: "1.05",
          marketplace_checkout_fee_reduction_amount: "0.00",
          total_amount: "26.05",
          processor_amount: "26.05",
          policy_version: "marketplace-checkout-fee-v1",
          quote_fingerprint: "quote_1",
          quoted_at: "2026-07-09T00:00:00.000Z",
        },
        payment_method_quotes: [],
        wallet_credit: {
          requested_amount: "0.00",
          applied_amount: "0.00",
          external_amount: "25.00",
        },
        can_start_payment: true,
        unavailable_reasons: [],
        unavailable_reason_details: [],
      })),
    };
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const app = buildPlatformApiApp(
      createRuntime(
        {
          checkout: { sessions: checkoutSessions },
          payments: paymentServices,
          marketplace: {
            listings: {},
            offers: guardedOffers,
            reviews: {},
          },
        },
        [
          {
            module: marketplaceModule,
            services: {
              listings: {},
              offers: guardedOffers,
              reviews: {},
            },
          },
          {
            module: paymentsModule,
            services: {
              payments: paymentServices,
              projectors: [],
            },
          },
        ],
      ),
      {
        resolveActor: vi.fn(async () => agentActor(["offers.manage", "orders.view", "orders.manage"])),
        mcp: { agentGrantRateLimiter: rateLimiter },
        agentGrantSpendPolicy: spendPolicy,
        ucpAp2MandateVerifier: {
          verify: vi.fn(async () => ({
            ok: true as const,
            mode: "human-present" as const,
            evidence: { verifier: "uat" },
          })),
        },
        ucp: {
          businessSigningKeys: {
            current: {
              kid: "merchant-uat",
              alg: "ES256",
              privateJwk: privateKey.export({ format: "jwk" }),
            },
          },
          allowInMemoryIdempotencyStoreForTests: true,
        },
      },
    );

    await withMcpClient(app, async (client) => {
      expectStructured(
        await callConfirmedTool(client, {
          name: "marketplace.submit-offer",
          arguments: {
            accountId: "acc_1",
            catalogItemId: "cat_1",
            productId: "product_1",
            itemTitle: "Charizard ex",
            priceAmount: "24.00",
            quantityRequested: 1,
            shippingDestinationSnapshot: shippingDestination,
            idempotencyKey: "rate-limit-first",
            confirmationText: "Submit Offer.",
          },
          confirmation: { confirmed: true, text: "Submit Offer." },
        }),
      );

      const rejected = await callConfirmedTool(client, {
        name: "marketplace.submit-offer",
        arguments: {
          accountId: "acc_1",
          catalogItemId: "cat_1",
          productId: "product_1",
          itemTitle: "Charizard ex",
          priceAmount: "24.00",
          quantityRequested: 1,
          shippingDestinationSnapshot: shippingDestination,
          idempotencyKey: "rate-limit-second",
          confirmationText: "Submit Offer.",
        },
        confirmation: { confirmed: true, text: "Submit Offer." },
      });

      expect(rejected.isError).toBe(true);
      expect(rejected.content).toEqual([
        expect.objectContaining({
          text: "This agent grant is sending writes too quickly. Retry after the rate-limit window.",
        }),
      ]);
    });

    checkoutSessions.getSession = vi.fn(async () => buyNowSession);
    const checkoutBody = JSON.stringify(
      createUcpEnvelope("ok", {
        marketplace_checkout_fee_quote_fingerprint: "quote_1",
        total_amount: "10.00",
        ap2: {
          checkout_mandate: "checkout_mandate",
        },
        payment_data: {
          provider: "stripe",
          token: "spt_123",
        },
      }),
    );
    const paymentsFetch = stubPaymentsCheckoutStatusFetch(paymentServices.getCheckoutStatus);
    try {
      const spendCapResponse = await app.request("/ucp/v1/checkout-sessions/chk_1/complete", {
        method: "POST",
        body: checkoutBody,
        headers: signedUcpHeaders(checkoutBody),
      });

      expect(spendCapResponse.status).toBe(200);
      await expect(spendCapResponse.json()).resolves.toMatchObject({
        ucp: {
          status: "requires_action",
        },
        messages: [
          {
            code: "agent_grant_spending_mandate_blocked",
            message: "This agent grant exceeded its platform spend cap.",
          },
        ],
      });
      expect(paymentsFetch).toHaveBeenCalledTimes(1);
      expect(paymentServices.getCheckoutStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          orderIds: ["order_1"],
        }),
      );
      expect(spendPolicy.authorize).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "complete_checkout",
          amountCents: 2_605,
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
