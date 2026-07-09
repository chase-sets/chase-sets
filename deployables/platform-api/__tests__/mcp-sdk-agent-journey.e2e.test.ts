import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { module as checkoutModule } from "@chase-sets/checkout";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { module as settlementModule } from "@chase-sets/settlement";
import { createUcpEnvelope } from "@chase-sets/platform-runtime/ucp";
import type { AgentGrantRateLimiter } from "@chase-sets/platform-runtime/agent-guardrails";
import { buildPlatformApiApp } from "../src/app";

function agentActor(permissions: readonly string[]) {
  return {
    sessionId: "ucp:grant_full_journey",
    tenantId: "tenant_1",
    userId: "agent_user_1",
    accountId: "account_1",
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
      account_id: "account_1",
      inventory_item_id: "inventory_1",
      catalog_item_id: "catalog_1",
      product_id: "product_1",
      title: "Charizard ex",
      status: "published",
      price_amount: "25.00",
      quantity_available: 1,
      fee_quote_fingerprint: "fee_quote_1",
    };
    const offer = {
      offer_id: "offer_1",
      buyer_account_id: "account_1",
      seller_account_id: "account_1",
      catalog_item_id: "catalog_1",
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
      buyer_account_id: "account_1",
      seller_account_id: "account_1",
      status: "label_purchased",
      tracking_number: "9400111899223857463029",
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    };
    const payout = {
      payout_id: "payout_1",
      account_id: "account_1",
      amount: "24.00",
      currency_code: "USD",
      status: "requested",
      requested_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    };
    const wallet = {
      account_id: "account_1",
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
      submitOffer: vi.fn(async () => ({ offerId: "offer_1", version: 1 })),
      acceptOffer: vi.fn(async () => ({ offerId: "offer_1", version: 2 })),
      declineOfferMatch: vi.fn(),
      listSubmittedOffers: vi.fn(async () => ({ items: [offer], total: 1 })),
      listSellerOfferMatches: vi.fn(async () => ({ items: [offer], total: 1 })),
      getOffer: vi.fn(async () => offer),
      getSubmittedOffer: vi.fn(async () => offer),
      getSellerOfferMatch: vi.fn(async () => offer),
    };
    const checkoutServices = {
      cart: {
        listCartLines: vi.fn(async () => [
          {
            line_id: "cart_line_1",
            buyer_account_id: "account_1",
            listing_id: "listing_1",
            product_id: "product_1",
            quantity: 1,
            unit_price_amount: "25.00",
          },
        ]),
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
              account_id: "account_1",
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
        arguments: { accountId: "account_1", limit: 10 },
      });
      expect(browse.structuredContent).toMatchObject({ count: 1, items: [expect.objectContaining(listing)] });

      const submitted = await callConfirmedTool(client, {
        name: "marketplace.submit-offer",
        arguments: {
          accountId: "account_1",
          catalogItemId: "catalog_1",
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
        accountId: "account_1",
        offerId: "offer_1",
        status: "submitted",
        resourceUri: "chase-sets://marketplace/account_1/offers/offer_1",
      });

      const accepted = await callConfirmedTool(client, {
        name: "marketplace.accept-offer",
        arguments: {
          accountId: "account_1",
          offerId: "offer_1",
          feeQuoteFingerprint: "fee_quote_1",
          sourceActionKey: "uat-agent:accept-offer-1",
          idempotencyKey: "offer-accept-1",
          confirmationText: "Accept Offer.",
        },
        confirmation: { confirmed: true, text: "Accept Offer." },
      });
      expect(expectStructured(accepted)).toMatchObject({
        accountId: "account_1",
        offerId: "offer_1",
        version: 2,
        status: "accepted",
      });

      await expect(
        client.readResource({ uri: "chase-sets://marketplace/account_1/offers/offer_1" }),
      ).resolves.toMatchObject({
        contents: [
          {
            uri: "chase-sets://marketplace/account_1/offers/offer_1",
            text: expect.stringContaining("offer_1"),
          },
        ],
      });

      expect(
        expectStructured(await client.callTool({ name: "checkout.get-cart", arguments: { accountId: "account_1" } })),
      ).toMatchObject({ accountId: "account_1", total: 1 });
      expect(
        expectStructured(
          await client.callTool({
            name: "fulfillment.list-shipments",
            arguments: { accountId: "account_1", side: "sale" },
          }),
        ),
      ).toMatchObject({ accountId: "account_1", side: "sale", count: 1 });
      await expect(
        client.readResource({ uri: "chase-sets://fulfillment/account_1/shipments/shipment_1" }),
      ).resolves.toMatchObject({
        contents: [{ text: expect.stringContaining("shipment_1") }],
      });
      expect(
        expectStructured(
          await client.callTool({ name: "settlement.get-wallet", arguments: { accountId: "account_1" } }),
        ),
      ).toMatchObject({ accountId: "account_1", wallet });
      expect(
        expectStructured(
          await callConfirmedTool(client, {
            name: "settlement.request-payout",
            arguments: {
              accountId: "account_1",
              amount: "24.00",
              reason: "UAT settlement read after accepted offer",
              idempotencyKey: "payout-request-1",
              confirmationText: "Request Payout.",
            },
            confirmation: { confirmed: true, text: "Request Payout." },
          }),
        ),
      ).toMatchObject({
        accountId: "account_1",
        payoutId: "payout_1",
        status: "requested",
        resourceUri: "chase-sets://settlement/account_1/payouts/payout_1",
      });
      await expect(
        client.readResource({ uri: "chase-sets://settlement/account_1/payouts/payout_1" }),
      ).resolves.toMatchObject({
        contents: [{ text: expect.stringContaining("payout_1") }],
      });
    });

    expect(offerServices.submitOffer).toHaveBeenCalledTimes(1);
    expect(offerServices.acceptOffer).toHaveBeenCalledTimes(1);
    expect(settlementServices.payouts.requestPayout).toHaveBeenCalledTimes(1);
  });

  it("asserts native MCP agent grant rate-limit and checkout spend-cap guardrail rejections", async () => {
    const checkoutSessions = {
      createOfferIntent: vi.fn(),
      createBuyNowSession: vi.fn(),
      getSession: vi.fn(),
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
    const app = buildPlatformApiApp(
      createRuntime(
        {
          checkout: { sessions: checkoutSessions },
          payments: {
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
          },
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
        ],
      ),
      {
        resolveActor: vi.fn(async () => agentActor(["offers.manage", "orders.view", "orders.manage"])),
        mcp: { agentGrantRateLimiter: rateLimiter },
        agentGrantSpendPolicy: {
          authorize: vi.fn(async () => ({
            allowed: false,
            limitKind: "daily-cap" as const,
            reason: "This agent grant exceeded its platform spend cap.",
            remainingCents: 0,
            capCents: 100,
          })),
        },
        ucpAp2MandateVerifier: {
          verify: vi.fn(async () => ({ ok: true as const, evidence: { verifier: "uat" } })),
        },
      },
    );

    await withMcpClient(app, async (client) => {
      expectStructured(
        await callConfirmedTool(client, {
          name: "marketplace.submit-offer",
          arguments: {
            accountId: "account_1",
            catalogItemId: "catalog_1",
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
          accountId: "account_1",
          catalogItemId: "catalog_1",
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

    checkoutSessions.getSession = vi.fn(async () => ({
      session_id: "chk_1",
      source_type: "buy-now",
      shipping_option: null,
      optimization_goal: null,
      shipping_address: null,
      lines: [
        {
          catalogItemId: "catalog_1",
          productId: "product_1",
          listingId: "listing_1",
          title: "Charizard ex",
          quantity: 1,
          unitPriceAmount: "25.00",
          offerPriceAmount: null,
          sellerAccountId: "account_1",
          fulfillmentMode: "seller-managed",
          availabilityState: "available",
        },
      ],
      order_ids: [],
      payment_id: null,
      submitted_offer_id: null,
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
      totals: [{ type: "total", amount: 2500 }],
    }));
    const checkoutBody = JSON.stringify(
      createUcpEnvelope("ok", {
        marketplace_checkout_fee_quote_fingerprint: "quote_1",
        total_amount: "25.00",
        ap2: {
          checkout_mandate: "checkout_mandate",
        },
        payment_data: {
          provider: "stripe",
          token: "spt_123",
        },
      }),
    );
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
  });
});
