import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { IdentityApiEnv } from "../../../api";
import { shippingAddressRoutes } from "./route";
import type { ShippingAddressServices } from "./runtime";
import {
  decideShippingAddressBook,
  initialShippingAddressBookState,
  normalizeShippingAddressSnapshot,
} from "../domain/domain";
import { ShippingAddressUndeliverableError } from "../domain/errors";

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
    verifyShippingAddress: vi.fn(async (address) => ({ status: "accepted", address }) as const),
    projectors: [],
    ...overrides,
  } as ShippingAddressServices;
}

describe("shipping address API route", () => {
  it("preserves rejection parity and no write", async () => {
    const written = vi.fn();
    const services = buildServices({
      commandHandler: vi.fn<ShippingAddressServices["commandHandler"]>(async (input) => {
        const events = decideShippingAddressBook(initialShippingAddressBookState, input.command);
        written(events);
        return { state: initialShippingAddressBookState, version: 1, newEvents: events, storedEvents: [] };
      }),
    });
    for (const field of ["name", "line1", "city", "state", "postalCode", "country"] as const) {
      for (const value of ["", "   "]) {
        const snapshot = { ...addressBody, company: null, line2: null, phone: null, email: null, [field]: value };
        expect(() => normalizeShippingAddressSnapshot(snapshot)).toThrow();
        // Empty country is already defaulted by the API; whitespace is not.
        if (field === "country" && value === "") continue;
        const response = await buildApp(services).request("/accounts/acc_1/shipping-addresses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snapshot),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: "validation_failed", details: [{ field, code: "required", message: expect.any(String) }] },
        });
      }
    }
    expect(written).not.toHaveBeenCalled();
    expect(
      normalizeShippingAddressSnapshot({
        ...addressBody,
        company: " ",
        line2: null,
        phone: null,
        email: null,
        name: " Alex ",
        state: " il ",
        country: " us ",
      }),
    ).toMatchObject({ name: "Alex", state: "IL", country: "US", company: null });
  });

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

  it("saves the verified address snapshot returned by verification", async () => {
    const verifiedAddress = {
      name: "Alex Collector",
      company: null,
      line1: "100 Main St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
      verification: {
        status: "verified" as const,
        source: "easypost:test",
        checkedAt: "2026-07-07T00:00:00.000Z",
      },
    };
    const services = buildServices({
      verifyShippingAddress: vi.fn(async () => ({ status: "accepted", address: verifiedAddress }) as const),
    });

    const response = await buildApp(services).request("/accounts/acc_1/shipping-addresses", {
      method: "POST",
      body: JSON.stringify(addressBody),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(services.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ address: verifiedAddress }),
      }),
    );
  });

  it("returns a standardized address choice before saving", async () => {
    const suggestedAddress = {
      name: "Alex Collector",
      company: null,
      line1: "100 W Main St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601-1000",
      country: "US",
      phone: null,
      email: null,
    };
    const services = buildServices({
      verifyShippingAddress: vi.fn(
        async () =>
          ({
            status: "choice-required",
            suggestedAddress,
            verification: {
              status: "corrected",
              source: "easypost:test",
              checkedAt: "2026-07-07T00:00:00.000Z",
              suggestedAddress,
            },
            messages: ["USPS standardized this address."],
          }) as const,
      ),
    });

    const response = await buildApp(services).request("/accounts/acc_1/shipping-addresses", {
      method: "POST",
      body: JSON.stringify(addressBody),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "address_standardization_suggested" },
      suggestedAddress,
    });
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("blocks undeliverable saved addresses", async () => {
    const services = buildServices({
      verifyShippingAddress: vi.fn(async () => {
        throw new ShippingAddressUndeliverableError();
      }),
    });

    const response = await buildApp(services).request("/accounts/acc_1/shipping-addresses", {
      method: "POST",
      body: JSON.stringify(addressBody),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "shipping_address_undeliverable" },
    });
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("saves buyer-confirmed unverified addresses when verification is unavailable", async () => {
    const unverifiedAddress = {
      name: "Alex Collector",
      company: null,
      line1: "100 Main St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
      verification: {
        status: "unverified" as const,
        source: "easypost:test",
        checkedAt: "2026-07-07T00:00:00.000Z",
        buyerDecision: "provider-unavailable" as const,
      },
    };
    const services = buildServices({
      verifyShippingAddress: vi.fn(async () => ({ status: "accepted", address: unverifiedAddress }) as const),
    });

    const response = await buildApp(services).request("/accounts/acc_1/shipping-addresses", {
      method: "POST",
      body: JSON.stringify(addressBody),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(services.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ address: unverifiedAddress }),
      }),
    );
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
