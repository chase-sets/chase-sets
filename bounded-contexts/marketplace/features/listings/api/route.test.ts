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
    listSellerListings: vi.fn(async () => ({ items: [], total: 0 })),
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
});
