import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { DiscoveryApiEnv } from "../../../api";
import { createGuestProductAlertRoutes, createProductAlertRoutes } from "./route";
import type { ProductAlertServices } from "./runtime";

function buildApp(
  options: Readonly<{
    actor: DiscoveryApiEnv["Variables"]["actor"];
    services: ProductAlertServices;
  }>,
) {
  const app = new Hono<DiscoveryApiEnv>();

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

  app.route("/account", createProductAlertRoutes(options.services));
  app.route("/guest", createGuestProductAlertRoutes(options.services));

  return app;
}

function createServices(): ProductAlertServices {
  return {
    commandHandler: vi.fn() as never,
    createProductAlert: vi.fn(async () => ({
      alertId: "pal_1",
      version: 1,
    })),
    pauseProductAlert: vi.fn(async () => ({
      alertId: "pal_1",
      version: 2,
    })),
    resumeProductAlert: vi.fn(async () => ({
      alertId: "pal_1",
      version: 2,
    })),
    deleteProductAlert: vi.fn(async () => ({
      alertId: "pal_1",
      version: 2,
    })),
    listProductAlerts: vi.fn(async () => []),
    getProductAlert: vi.fn(async () => null),
    createAnonymousProductAlertIntent: vi.fn(
      async (params: Parameters<ProductAlertServices["createAnonymousProductAlertIntent"]>[0]) => ({
        intent_id: "pai_1",
        anonymous_owner_id: params.anonymousOwnerId,
        source_path: params.sourcePath,
        market_side: params.marketSide,
        catalog_item_id: params.catalogItemId,
        product_id: params.productId,
        selected_options: params.selectedOptions ?? [],
        product_summary: params.productSummary ?? null,
        threshold_amount: params.thresholdAmount ?? null,
        status: "active" as const,
        claimed_account_id: null,
        claimed_alert_id: null,
        claimed_at: null,
        expires_at: "2026-07-10T12:00:00.000Z",
        created_at: "2026-06-10T12:00:00.000Z",
        updated_at: "2026-06-10T12:00:00.000Z",
      }),
    ),
    getAnonymousProductAlertIntent: vi.fn(async () => null),
    claimAnonymousProductAlertIntent: vi.fn(
      async (params: Parameters<ProductAlertServices["claimAnonymousProductAlertIntent"]>[0]) => ({
        intent_id: params.intentId,
        anonymous_owner_id: params.anonymousOwnerId,
        source_path: "/items/charizard-base-set?market=watch",
        market_side: "listing" as const,
        catalog_item_id: "cat_charizard",
        product_id: "cat_charizard::form:raw",
        selected_options: [{ dimensionId: "form", optionId: "raw" }],
        product_summary: "Form: Raw",
        threshold_amount: "20.00",
        status: "claimed" as const,
        claimed_account_id: params.accountId,
        claimed_alert_id: "pal_1",
        claimed_at: "2026-06-10T12:05:00.000Z",
        expires_at: "2026-07-10T12:00:00.000Z",
        created_at: "2026-06-10T12:00:00.000Z",
        updated_at: "2026-06-10T12:05:00.000Z",
      }),
    ),
    projectors: [],
  };
}

describe("product alert routes", () => {
  it("creates an anonymous Product Alert intent for a guest Watch save", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://discovery.test/guest/product-alert-intents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-discovery-anonymous-product-alert-id": "anon_watch_1",
        },
        body: JSON.stringify({
          sourcePath: "/items/charizard-base-set?market=watch",
          marketSide: "listing",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form:raw",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Form: Raw",
          thresholdAmount: "20.00",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      intent_id: "pai_1",
      anonymous_owner_id: "anon_watch_1",
      catalog_item_id: "cat_charizard",
      threshold_amount: "20.00",
      status: "active",
    });
    expect(services.createAnonymousProductAlertIntent).toHaveBeenCalledWith({
      anonymousOwnerId: "anon_watch_1",
      sourcePath: "/items/charizard-base-set?market=watch",
      marketSide: "listing",
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Form: Raw",
      thresholdAmount: "20.00",
    });
  });

  it("requires the anonymous owner header before saving a Product Alert intent", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://discovery.test/guest/product-alert-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thresholdAmount: "20.00" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(services.createAnonymousProductAlertIntent).not.toHaveBeenCalled();
  });

  it("rate limits repeated anonymous Product Alert intent capture requests", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    let response = new Response(null, { status: 500 });
    for (let index = 0; index < 31; index += 1) {
      response = await app.fetch(
        new Request("http://discovery.test/guest/product-alert-intents", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-discovery-anonymous-product-alert-id": "anon_watch_rate_limited",
            "x-forwarded-for": "203.0.113.131",
          },
          body: JSON.stringify({
            sourcePath: "/items/charizard-base-set?market=watch",
            marketSide: "listing",
            catalogItemId: `cat_rate_${index}`,
            productId: `cat_rate_${index}::form:raw`,
            selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
            productSummary: "Form: Raw",
            thresholdAmount: "20.00",
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
    expect(services.createAnonymousProductAlertIntent).toHaveBeenCalledTimes(30);
  });

  it("claims an anonymous Product Alert intent for a signed-in account", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["accounts.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://discovery.test/account/product-alert-intents/pai_1/claim", {
        method: "POST",
        headers: {
          "x-discovery-anonymous-product-alert-id": "anon_watch_1",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      intent_id: "pai_1",
      status: "claimed",
      claimed_account_id: "acc_buyer",
    });
    expect(services.claimAnonymousProductAlertIntent).toHaveBeenCalledWith(
      {
        anonymousOwnerId: "anon_watch_1",
        intentId: "pai_1",
        accountId: "acc_buyer",
      },
      expect.objectContaining({
        tenantId: "tnt_identity",
      }),
    );
  });

  it("requires the anonymous owner header before claiming a Product Alert intent", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["accounts.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://discovery.test/account/product-alert-intents/pai_1/claim", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    expect(services.claimAnonymousProductAlertIntent).not.toHaveBeenCalled();
  });
});
