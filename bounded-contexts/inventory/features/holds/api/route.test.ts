import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryActor, InventoryApiEnv } from "../../../api";
import type { InventoryHoldRow } from "../read-model/queries";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { inventoryCheckoutReservationRoutes, inventoryHoldRoutes } from "./route";
import type { InventoryHoldServices } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_inventory" as never,
  },
};

function buildApp(holds: InventoryHoldServices, actor?: InventoryActor) {
  const app = new Hono<InventoryApiEnv>();
  app.use("*", async (c, next) => {
    c.set(
      "actor",
      actor ?? {
        accountId: "acc_inventory",
        permissions: ["inventory.view", "inventory.manage", "orders.manage"],
      },
    );
    c.set("context", context);
    await next();
  });
  app.route("/holds", inventoryHoldRoutes(holds));
  app.route("/checkout-reservations", inventoryCheckoutReservationRoutes(holds));
  return app;
}

describe("inventory hold routes", () => {
  it("returns a validation error when a seller releases a system hold", async () => {
    const app = buildApp({
      releaseHold: vi.fn(async () => {
        throw new InventoryDomainError("Only manual inventory holds can be released by sellers.");
      }),
      commandHandler: async () => {
        throw new Error("command handler not expected");
      },
      planCreateHold: async () => {
        throw new Error("plan create hold not expected");
      },
      createHold: async () => {
        throw new Error("create hold not expected");
      },
      getHold: async () => null,
      projectors: [],
    } as unknown as InventoryHoldServices);

    const response = await app.fetch(
      new Request("http://inventory.test/holds/hld_order/release", {
        method: "POST",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "inventory_hold_not_seller_releasable",
        message: "Only manual inventory holds can be released by sellers.",
      },
    });
  });

  it("expires due checkout holds before creating a repeat reservation attempt", async () => {
    const expiredAttempt = {
      hold_id: "hld_checkout_old",
      account_id: "acc_inventory",
      item_id: "inv_1",
      quantity: 1,
      reason: "Checkout reservation",
      notes: null,
      purpose: "checkout",
      source_ref: {
        checkoutSessionId: "chk_1",
        lineKey: "cli_1",
      },
      expires_at: "2026-07-07T00:00:00.000Z",
      status: "expired",
      created_at: "2026-07-07T00:00:00.000Z",
      updated_at: "2026-07-07T00:15:00.000Z",
      released_at: "2026-07-07T00:15:00.000Z",
      release_reason: "checkout-expired",
      expired_at: "2026-07-07T00:15:00.000Z",
      extension_count: 0,
    } as const;
    const createHold = vi.fn(async ({ holdId }: { holdId: string }) => ({ holdId, version: 1 }));
    const expireDueCheckoutHolds = vi.fn(async () => [{ holdId: "hld_checkout_old", version: 2 }]);
    const getHold = vi.fn(async () => (getHold.mock.calls.length === 1 ? expiredAttempt : null));
    const app = buildApp({
      createHold,
      expireDueCheckoutHolds,
      getHold,
      releaseHold: async () => {
        throw new Error("release hold not expected");
      },
      commandHandler: async () => {
        throw new Error("command handler not expected");
      },
      planCreateHold: async () => {
        throw new Error("plan create hold not expected");
      },
      projectors: [],
    } as unknown as InventoryHoldServices);

    const response = await app.fetch(
      new Request("http://inventory.test/checkout-reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSessionId: "chk_1",
          lineKey: "cli_1",
          sellerAccountId: "acc_inventory",
          inventoryItemId: "inv_1",
          quantity: 1,
          reservationAttempt: 1,
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(expireDueCheckoutHolds).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
    expect(getHold).toHaveBeenCalledTimes(2);
    expect(createHold).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_inventory",
        itemId: "inv_1",
        purpose: "checkout",
        sourceRef: {
          checkoutSessionId: "chk_1",
          lineKey: "cli_1",
        },
      }),
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
    expect(body).toMatchObject({
      holdId: expect.stringMatching(/^hld_checkout_/),
      sellerAccountId: "acc_inventory",
      inventoryItemId: "inv_1",
      lineKey: "cli_1",
      quantity: 1,
      extensionCount: 0,
      status: "active",
    });
  });

  it("releases checkout reservations with the checkout-cancelled disposition", async () => {
    const activeHold = {
      hold_id: "hld_checkout_1",
      account_id: "acc_seller",
      item_id: "inv_1",
      quantity: 1,
      reason: "Checkout reservation",
      notes: null,
      purpose: "checkout",
      source_ref: {
        checkoutSessionId: "chk_1",
        lineKey: "line_1",
      },
      expires_at: "2026-07-08T00:15:00.000Z",
      status: "active",
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
      released_at: null,
      release_reason: null,
      consumed_at: null,
      expired_at: null,
      extension_count: 0,
    } as const;
    const releasedHold = {
      ...activeHold,
      status: "released",
      released_at: "2026-07-08T00:01:00.000Z",
      release_reason: "checkout-cancelled",
    } as const;
    const getHold = vi.fn(async () => releasedHold);
    const releaseHold = vi.fn(async () => ({ holdId: "hld_checkout_1", version: 2 }));
    const app = buildApp({
      getHold,
      getCheckoutHold: async () => activeHold,
      releaseHold,
      commandHandler: async () => {
        throw new Error("command handler not expected");
      },
      planCreateHold: async () => {
        throw new Error("plan create hold not expected");
      },
      createHold: async () => {
        throw new Error("create hold not expected");
      },
      expireDueCheckoutHolds: async () => [],
      projectors: [],
    } as unknown as InventoryHoldServices);

    const response = await app.fetch(
      new Request("http://inventory.test/checkout-reservations/hld_checkout_1/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSessionId: "chk_1",
          lineKey: "line_1",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(releaseHold).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        holdId: "hld_checkout_1",
        releaseReason: "checkout-cancelled",
      },
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
    expect(body).toMatchObject({
      holdId: "hld_checkout_1",
      sellerAccountId: "acc_seller",
      inventoryItemId: "inv_1",
      lineKey: "line_1",
      status: "released",
    });
  });
});

const checkoutHold: InventoryHoldRow = {
  hold_id: "hld_checkout_1",
  account_id: "acc_seller",
  item_id: "inv_1",
  quantity: 1,
  reason: "Checkout reservation",
  notes: null,
  purpose: "checkout",
  source_ref: { checkoutSessionId: "chk_own", lineKey: "line_1" },
  expires_at: "2099-01-01T00:00:00.000Z",
  status: "active",
  created_at: "2026-10-04T00:00:00.000Z",
  updated_at: "2026-10-04T00:00:00.000Z",
  released_at: null,
  release_reason: null,
  consumed_at: null,
  expired_at: null,
  extension_count: 0,
};

function checkoutServices(hold: InventoryHoldRow = checkoutHold) {
  const unexpected = async () => {
    throw new Error("unexpected service call");
  };
  const getCheckoutHold = vi.fn(async (holdId: string, sessionId: string) =>
    holdId === hold.hold_id && sessionId === "chk_own" && hold.purpose === "checkout" ? hold : null,
  );
  const extendCheckoutHold = vi.fn<InventoryHoldServices["extendCheckoutHold"]>(async () => ({
    holdId: hold.hold_id,
    version: 2,
  }));
  const releaseHold = vi.fn<InventoryHoldServices["releaseHold"]>(async () => ({ holdId: hold.hold_id, version: 2 }));
  const services: InventoryHoldServices = {
    commandHandler: unexpected,
    planCreateHold: unexpected,
    createHold: unexpected,
    planConvertCheckoutHold: unexpected,
    expireDueCheckoutHolds: unexpected,
    extendCheckoutHold,
    releaseHold,
    getHold: vi.fn(async () => hold),
    getCheckoutHold,
    projectors: [],
  };
  return { services, getCheckoutHold, extendCheckoutHold, releaseHold };
}

describe.each([
  { kind: "signed-in", actor: { accountId: "acc_buyer", permissions: ["orders.manage"] } },
  { kind: "guest", actor: { accountId: "acc_guest", permissions: ["guest-checkout.manage"] } },
])("$kind checkout reservation binding", ({ kind, actor }) => {
  async function request(
    services: InventoryHoldServices,
    action: string,
    body: unknown,
    holdId = checkoutHold.hold_id,
  ) {
    return buildApp(services, actor).request(`/checkout-reservations/${holdId}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  for (const action of ["extend", "release"] as const) {
    it(`${action} rejects a foreign checkout session`, async () => {
      const { services, extendCheckoutHold, releaseHold, getCheckoutHold } = checkoutServices();
      const foreign = await request(services, action, {
        checkoutSessionId: "chk_foreign",
        sellerAccountId: "acc_seller",
      });
      const missing = await request(
        services,
        action,
        { checkoutSessionId: "chk_own", sellerAccountId: "acc_seller" },
        "hld_missing",
      );
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await foreign.json()).toEqual(await missing.json());
      expect(getCheckoutHold).toHaveBeenCalledWith(checkoutHold.hold_id, "chk_foreign");
      expect(extendCheckoutHold).not.toHaveBeenCalled();
      expect(releaseHold).not.toHaveBeenCalled();
      expect((await request(services, action, { checkoutSessionId: "chk_own" })).status).toBe(200);
    });

    it(`${action} resolves the seller from the hold`, async () => {
      const { services, extendCheckoutHold, releaseHold } = checkoutServices();
      const response = await request(services, action, {
        checkoutSessionId: "chk_own",
        sellerAccountId: "acc_attacker",
      });
      expect(response.status).toBe(200);
      expect(action === "extend" ? extendCheckoutHold : releaseHold).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "acc_seller", holdId: checkoutHold.hold_id }),
        expect.anything(),
      );
      expect(await response.json()).toMatchObject({ sellerAccountId: "acc_seller" });
    });

    it.each([{}, { checkoutSessionId: "" }, { checkoutSessionId: "   " }, { checkoutSessionId: 12 }])(
      `${action} rejects missing or invalid session %j`,
      async (body) => {
        const { services, extendCheckoutHold, releaseHold, getCheckoutHold } = checkoutServices();
        expect((await request(services, action, body)).status).toBe(404);
        expect(getCheckoutHold).not.toHaveBeenCalled();
        expect(extendCheckoutHold).not.toHaveBeenCalled();
        expect(releaseHold).not.toHaveBeenCalled();
      },
    );
  }

  it(`${kind} session extends its own hold`, async () => {
    const { services, extendCheckoutHold } = checkoutServices();
    expect((await request(services, "extend", { checkoutSessionId: "chk_own" })).status).toBe(200);
    expect(extendCheckoutHold).toHaveBeenCalledTimes(1);
  });

  it("own-session release retry remains idempotent and foreign retries are refused", async () => {
    const { services, releaseHold } = checkoutServices({
      ...checkoutHold,
      status: "released",
      release_reason: "checkout-cancelled",
    });
    expect((await request(services, "release", { checkoutSessionId: "chk_foreign" })).status).toBe(404);
    expect((await request(services, "release", { checkoutSessionId: "chk_own" })).status).toBe(200);
    expect(releaseHold).not.toHaveBeenCalled();
  });
});
