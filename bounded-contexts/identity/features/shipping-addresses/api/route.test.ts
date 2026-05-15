import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { IdentityApiEnv } from "../../../api";
import { shippingAddressRoutes } from "./route";
import type { ShippingAddressServices } from "./runtime";

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["accounts.manage", "accounts.view"],
};

function buildApp(services: ShippingAddressServices) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", {
      audit: {
        performedByUserId: actor.userId as never,
        forAccountId: actor.accountId as never,
      },
      trace: {},
    } as EventStoreContext);
    await next();
  });
  app.route("/accounts/:accountId/shipping-addresses", shippingAddressRoutes(services));
  return app;
}

function buildServices(overrides: Partial<ShippingAddressServices> = {}) {
  return {
    commandHandler: vi.fn(async () => ({
      state: { status: "active" },
      version: 1,
    })),
    listShippingAddresses: vi.fn(async () => []),
    getShippingAddress: vi.fn(async () => null),
    projectors: [],
    ...overrides,
  } as ShippingAddressServices;
}

describe("shipping address API route", () => {
  it("drains the shipping address projection after adding an address", async () => {
    const runOnce = vi.fn()
      .mockResolvedValueOnce({ processed: 1, lastGlobalPosition: "1" })
      .mockResolvedValueOnce({ processed: 0, lastGlobalPosition: "1" });
    const services = buildServices({
      projectors: [{ projectorName: "identity-shipping-address-projection", runOnce }],
    });

    const response = await buildApp(services).request(
      "/accounts/acc_1/shipping-addresses",
      {
        method: "POST",
        body: JSON.stringify({
          label: "Home",
          name: "Alex Collector",
          line1: "100 Main St",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
          makeDefault: true,
        }),
        headers: { "Content-Type": "application/json" },
      },
    );

    expect(response.status).toBe(201);
    expect(services.commandHandler).toHaveBeenCalledOnce();
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});
