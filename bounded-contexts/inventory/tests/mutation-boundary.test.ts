import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildInventoryApi, type InventoryApiEnv } from "../api";
import { createInventoryServices } from "../support/runtime-support/services";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";

describe("issue-7169-c1-boundary-recovery: AC9/10/13 full router", () => {
  function router(permissions = ["inventory.manage", "inventory.view"], mismatch = false) {
    const query = vi.fn(async () => {
      throw new Error("No boundary rejection may touch persistence.");
    });
    const pool: PgTransactionalPool = { query, connect: async () => ({ query, release: vi.fn() }) };
    const services = createInventoryServices(pool);
    const read = vi
      .spyOn(services.mutations, "read")
      .mockResolvedValue({
        version: 1,
        family: "hold-create",
        targetId: "draft",
        completedAt: "2026-10-13T00:00:00Z",
        result: { holdId: "hld_synthetic" },
      });
    const app = new Hono<InventoryApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: "acc_synthetic", permissions });
      c.set("context", {
        tenantId: "tnt_synthetic",
        audit: { performedByUserId: "usr_synthetic", forAccountId: mismatch ? "acc_foreign" : "acc_synthetic" },
      });
      await next();
    });
    app.route("/api/inventory", buildInventoryApi(services));
    return { app, query, read };
  }
  const body = {
    catalogItemId: "cat_synthetic",
    selectedOptions: [],
    storageLocationId: "loc_synthetic",
    totalQuantity: 1,
  };
  it.each([
    ["missing caller attempt", body, {}],
    [
      "payload account authority",
      { ...body, accountId: "acc_foreign" },
      { "Inventory-Mutation-Attempt": "053210b9-1a0d-41b7-b95f-f13a4f2053bc" },
    ],
    [
      "recursive unknown",
      { ...body, selectedOptions: [{ dimensionId: "form", optionId: "raw", secret: "synthetic" }] },
      { "Inventory-Mutation-Attempt": "053210b9-1a0d-41b7-b95f-f13a4f2053bc" },
    ],
  ])("refuses %s before querying or accepting", async (_name, input, headers) => {
    const { app, query } = router();
    const response = await app.request("/api/inventory/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "inventory_mutation_refused", message: "Inventory request was not accepted." },
    });
    expect(query).not.toHaveBeenCalled();
  });
  it("refuses an actor/context mismatch without disclosure or mutation", async () => {
    const { app, query } = router(undefined, true);
    const response = await app.request("/api/inventory/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Inventory-Mutation-Attempt": "053210b9-1a0d-41b7-b95f-f13a4f2053bc",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it.each(["orders.manage", "guest-checkout.manage"])(
    "allows %s to read only their privately bound original result",
    async (permission) => {
      const { app, read } = router([permission]);
      const response = await app.request("/api/inventory/mutation-attempts/053210b9-1a0d-41b7-b95f-f13a4f2053bc");
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(read).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" } }),
      );
      expect((await app.request("/api/inventory/items")).status).toBe(403);
    },
  );
});
