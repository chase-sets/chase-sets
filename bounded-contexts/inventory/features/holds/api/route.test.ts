import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryApiEnv } from "../../../api";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { inventoryHoldRoutes } from "./route";
import type { InventoryHoldServices } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_inventory" as never,
  },
};

function buildApp(holds: InventoryHoldServices) {
  const app = new Hono<InventoryApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      accountId: "acc_inventory",
      permissions: ["inventory.view", "inventory.manage"],
    });
    c.set("context", context);
    await next();
  });
  app.route("/holds", inventoryHoldRoutes(holds));
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
});
