import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { InventoryApiEnv } from "../api";
import { inventoryMutationReadRoutes } from "../support/runtime-support/mutation-read-route";
import type { createInventoryMutationRuntime } from "../support/runtime-support/mutation-attempt";

describe("issue-7169-c1-boundary-recovery: AC9/10/13 private exact reads", () => {
  function router(mismatch = false) {
    const read = vi.fn<ReturnType<typeof createInventoryMutationRuntime>["read"]>(async () => ({
      version: 1 as const,
      family: "location-create" as const,
      targetId: "draft",
      result: { storageLocationId: "loc_synthetic", version: 1 },
      completedAt: "2026-10-13T00:00:00Z",
    }));
    const app = new Hono<InventoryApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: "acc_synthetic", permissions: ["inventory.view"] });
      c.set("context", {
        tenantId: "tnt_synthetic",
        audit: { performedByUserId: "usr_synthetic", forAccountId: mismatch ? "acc_foreign" : "acc_synthetic" },
      });
      await next();
    });
    app.route("/mutation-attempts", inventoryMutationReadRoutes({ read }));
    return { app, read };
  }
  it("returns the immutable receipt with no-store, not a mutable projection", async () => {
    const { app, read } = router();
    const response = await app.request("/mutation-attempts/synthetic?accountId=acc_foreign");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ result: { storageLocationId: "loc_synthetic", version: 1 } });
    expect(read).toHaveBeenCalledWith(
      "synthetic",
      expect.objectContaining({ audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" } }),
    );
  });
  it("has identical rejection for missing, malformed, foreign and poisoned authority", async () => {
    const { app, read } = router();
    read.mockResolvedValueOnce(null);
    const missing = await app.request("/mutation-attempts/missing");
    read.mockRejectedValueOnce(new Error("Synthetic secret exception"));
    const poisoned = await app.request("/mutation-attempts/poisoned");
    const foreignRouter = router(true);
    const foreign = await foreignRouter.app.request("/mutation-attempts/foreign");
    expect([missing.status, poisoned.status, foreign.status]).toEqual([404, 404, 404]);
    expect(await missing.text()).toBe(await poisoned.text());
    expect(await foreign.text()).toBe(
      '{"error":{"code":"inventory_attempt_unavailable","message":"Inventory result is unavailable."}}',
    );
    expect(foreignRouter.read).not.toHaveBeenCalled();
  });
});
