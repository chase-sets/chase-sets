import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CheckoutApiEnv } from "../../../api";
import { createCheckoutSupportLookupRoutes } from "./route";
import type { CheckoutSupportLookupResult, CheckoutSupportLookupServices } from "./runtime";

function supportActor(
  permissions: readonly string[] = ["support.manage"],
  roleKey = "platform-admin",
): NonNullable<CheckoutApiEnv["Variables"]["actor"]> {
  return {
    sessionId: "ses_support",
    tenantId: "tnt_chase_sets",
    userId: "usr_support",
    accountId: "acc_support",
    membershipId: "mem_support",
    roleKey,
    permissions: [...permissions],
  };
}

function buildApp(options: { actor: CheckoutApiEnv["Variables"]["actor"]; services: CheckoutSupportLookupServices }) {
  const app = new Hono<CheckoutApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    await next();
  });
  app.route("/support", createCheckoutSupportLookupRoutes(options.services));

  return app;
}

function createServices(result: CheckoutSupportLookupResult | null): CheckoutSupportLookupServices {
  return {
    lookupBySupportReference: vi.fn(async () => result),
  };
}

describe("checkout support lookup routes", () => {
  it("returns support-safe checkout facts for support managers", async () => {
    const services = createServices({
      type: "buy-checkout-session",
      supportReference: "CS-READY",
      matchedReference: "checkout-session",
      state: "pending",
      sourceType: "cart",
      optimizationGoal: "lowest-total",
      lineCount: 1,
      groupCount: 1,
      matchedGroup: null,
      ownerFacts: {
        orderCount: 0,
        paymentStarted: false,
        offerSubmitted: false,
      },
      sideEffects: {
        order: "not-attempted",
        payment: "not-attempted",
        offer: "not-applicable",
        sale: "not-applicable",
        label: "not-applicable",
        payout: "not-applicable",
        settlement: "not-applicable",
        notification: "not-attempted",
        accountHistory: "not-attempted",
      },
      createdAt: "2026-06-13T00:00:00.000Z",
      updatedAt: "2026-06-13T00:00:00.000Z",
    });

    const response = await buildApp({ actor: supportActor(), services }).request(
      "/support/checkout-references/CS-READY",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        type: "buy-checkout-session",
        supportReference: "CS-READY",
        state: "pending",
      },
    });
    expect(services.lookupBySupportReference).toHaveBeenCalledWith("CS-READY");
  });

  it("requires support manage permission", async () => {
    const services = createServices(null);
    const response = await buildApp({ actor: supportActor(["support.view"]), services }).request(
      "/support/checkout-references/CS-READY",
    );

    expect(response.status).toBe(403);
    expect(services.lookupBySupportReference).not.toHaveBeenCalled();
  });

  it("rejects account support managers because lookup is an internal helper", async () => {
    const services = createServices(null);
    const response = await buildApp({ actor: supportActor(["support.manage"], "owner"), services }).request(
      "/support/checkout-references/CS-READY",
    );

    expect(response.status).toBe(403);
    expect(services.lookupBySupportReference).not.toHaveBeenCalled();
  });

  it("requires an authenticated support actor", async () => {
    const services = createServices(null);
    const response = await buildApp({ actor: null, services }).request("/support/checkout-references/CS-READY");

    expect(response.status).toBe(401);
    expect(services.lookupBySupportReference).not.toHaveBeenCalled();
  });

  it("returns not found for unknown support references", async () => {
    const services = createServices(null);
    const response = await buildApp({ actor: supportActor(), services }).request(
      "/support/checkout-references/CS-MISSING",
    );

    expect(response.status).toBe(404);
  });
});
