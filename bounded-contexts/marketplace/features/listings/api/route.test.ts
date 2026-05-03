import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import { createAccountListingRoutes } from "./route";
import type { MarketplaceListingServices } from "./runtime";

function buildApp(options: Readonly<{
  actor: MarketplaceApiEnv["Variables"]["actor"];
  services: MarketplaceListingServices;
}>) {
  const app = new Hono<MarketplaceApiEnv>();

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

  app.route("/account", createAccountListingRoutes(options.services));

  return app;
}

function createServices(): MarketplaceListingServices {
  return {
    publishListing: vi.fn(async () => ({ listingId: "lst_1", version: 2 })),
    listSellerListingFeeHistory: vi.fn(async () => [
      {
        event_type: "marketplace.listing.published",
        stream_version: 2,
        price_amount: null,
        quantity_cap: null,
        marketplace_sales_fee_unit_amount: "1.00",
        seller_net_unit_amount: "19.00",
        terms_schedule_id: "cts_default",
        terms_agreement_id: null,
        terms_resolved_at: "2026-04-17T00:00:00.000Z",
        fee_quote_fingerprint: "20.00|1.00|19.00|cts_default|",
        recorded_at: "2026-04-17T00:00:00.000Z",
        performed_by_user_id: "usr_seller",
      },
    ]),
    listSellerListings: vi.fn(async () => ({ items: [], total: 0 })),
    listSellerListingFeeLockReport: vi.fn(async () => ({
      items: [
        {
          listing_id: "lst_1",
          inventory_item_id: "inv_1",
          item_title: "Charizard",
          product_summary: "Condition: Near Mint",
          status: "active",
          price_amount: "20.00",
          quantity_cap: 1,
          marketplace_sales_fee_unit_amount: "1.00",
          seller_net_unit_amount: "19.00",
          terms_schedule_id: "cts_default",
          terms_agreement_id: null,
          terms_resolved_at: "2026-04-17T00:00:00.000Z",
          fee_quote_fingerprint: "20.00|1.00|19.00|cts_default|",
          created_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:00:00.000Z",
        },
      ],
      total: 1,
    })),
    listSellerInventoryItemSupply: vi.fn(async () => ({ items: [], total: 0 })),
    projectors: [],
  } as unknown as MarketplaceListingServices;
}

describe("marketplace listing routes", () => {
  it("publishes a seller listing through the documented API action", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view", "listings.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings/lst_1/publish", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "lst_1",
      version: 2,
      status: "published",
    });
    expect(services.publishListing).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        listingId: "lst_1",
        feeQuoteFingerprint: null,
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("returns listing fee history for the seller listing", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings/lst_1/fee-history"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      count: 1,
      items: [
        {
          event_type: "marketplace.listing.published",
          marketplace_sales_fee_unit_amount: "1.00",
          seller_net_unit_amount: "19.00",
          performed_by_user_id: "usr_seller",
        },
      ],
    });
    expect(services.listSellerListingFeeHistory).toHaveBeenCalledWith({
      listingId: "lst_1",
      accountId: "acc_seller",
    });
  });

  it("returns seller fee lock report rows", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings/fee-lock-report"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      count: 1,
      items: [
        {
          listing_id: "lst_1",
          marketplace_sales_fee_unit_amount: "1.00",
          seller_net_unit_amount: "19.00",
          fee_quote_fingerprint: "20.00|1.00|19.00|cts_default|",
        },
      ],
    });
    expect(services.listSellerListingFeeLockReport).toHaveBeenCalledWith({
      accountId: "acc_seller",
      limit: 100,
      offset: 0,
    });
  });
});
