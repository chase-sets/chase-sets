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

const addressBody = {
  label: "Home",
  name: "Alex Collector",
  line1: "100 Main St",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  makeDefault: true,
};

function buildApp(services: ShippingAddressServices, resolvedActor: ResolvedActor = actor) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", resolvedActor);
    c.set("context", {
      tenantId: "tnt_identity" as never,
      audit: {
        performedByUserId: resolvedActor.userId as never,
        forAccountId: resolvedActor.accountId as never,
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
  it("adds an address without synchronously draining projections", async () => {
    const services = buildServices();

    const response = await buildApp(services).request("/accounts/acc_1/shipping-addresses", {
      method: "POST",
      body: JSON.stringify(addressBody),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(services.commandHandler).toHaveBeenCalledOnce();
  });

  it("rejects same-permission owners reading another account's shipping addresses", async () => {
    const services = buildServices();

    const response = await buildApp(services).request("/accounts/acc_other/shipping-addresses");

    expect(response.status).toBe(403);
    expect(services.listShippingAddresses).not.toHaveBeenCalled();
  });

  it.each([
    ["create", "/accounts/acc_other/shipping-addresses", "POST"],
    ["update", "/accounts/acc_other/shipping-addresses/adr_other", "PUT"],
    ["set default", "/accounts/acc_other/shipping-addresses/adr_other/default", "POST"],
    ["archive", "/accounts/acc_other/shipping-addresses/adr_other/archive", "POST"],
  ])(
    "rejects same-permission owners trying to %s another account's shipping address book",
    async (_name, path, method) => {
      const services = buildServices();

      const response = await buildApp(services).request(path, {
        method,
        body: method === "PUT" || path.endsWith("/shipping-addresses") ? JSON.stringify(addressBody) : undefined,
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(403);
      expect(services.commandHandler).not.toHaveBeenCalled();
    },
  );

  it("allows platform-admins to intentionally read and write another account's shipping addresses", async () => {
    const services = buildServices();
    const app = buildApp(services, { ...actor, roleKey: "platform-admin", accountId: "acc_platform" });

    const readResponse = await app.request("/accounts/acc_other/shipping-addresses");
    const writeResponse = await app.request("/accounts/acc_other/shipping-addresses", {
      method: "POST",
      body: JSON.stringify(addressBody),
      headers: { "Content-Type": "application/json" },
    });

    expect(readResponse.status).toBe(200);
    expect(writeResponse.status).toBe(201);
    expect(services.listShippingAddresses).toHaveBeenCalledWith("acc_other", { includeArchived: false });
    expect(services.commandHandler).toHaveBeenCalledOnce();
  });
});
