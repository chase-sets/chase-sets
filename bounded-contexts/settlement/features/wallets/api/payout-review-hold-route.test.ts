import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { SettlementApiEnv } from "../../../api";
import { createPayoutReviewHoldRoutes } from "./payout-review-hold-route";
import { createPayoutReviewHoldRuntime } from "./payout-review-hold-runtime";

const heldAccountId = "acc_synthetic_held_seller";
const context = {
  tenantId: "tnt_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic_operator" as never, forAccountId: "acc_synthetic_operator" as never },
};

function createApp(permissions: readonly string[] | null, actorAccountId = "acc_synthetic_operator") {
  const store = createInMemoryEventStore();
  const runtime = createPayoutReviewHoldRuntime({ eventStore: store.eventStore });
  const services = {
    get: vi.fn(runtime.get),
    place: vi.fn(runtime.place),
    release: vi.fn(runtime.release),
  };
  const app = new Hono<SettlementApiEnv>();
  app.use("*", async (c, next) => {
    c.set(
      "actor",
      permissions
        ? {
            sessionId: "ses_synthetic",
            tenantId: "tnt_synthetic",
            userId: "usr_synthetic_operator",
            accountId: actorAccountId,
            membershipId: "mem_synthetic",
            roleKey: "synthetic",
            permissions,
          }
        : null,
    );
    c.set("context", permissions ? context : null);
    await next();
  });
  app.route("/", createPayoutReviewHoldRoutes(services));
  return { app, services, store };
}

const path = `/accounts/${heldAccountId}/payout-review-hold`;
const json = (method: "POST" | "DELETE", body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("payout review hold routes", () => {
  it("payout review hold routes require permission and reason", async () => {
    // Seller self-scope payouts.view must never read another account's hold.
    for (const permissions of [["payouts.view"], ["payouts.view", "payouts.request"], []]) {
      const seller = createApp(permissions, "acc_synthetic_other_seller");
      const response = await seller.app.request(path);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "authorization_forbidden" } });
      expect(seller.services.get).not.toHaveBeenCalled();
    }
    const anonymous = createApp(null);
    expect((await anonymous.app.request(path)).status).toBe(401);
    expect(anonymous.services.get).not.toHaveBeenCalled();

    for (const permissions of [["payout-review-holds.manage"], ["payouts.platform.view"]]) {
      const operator = createApp(permissions);
      const response = await operator.app.request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ accountId: null, active: false, streamExists: false, version: 0 });
      expect(operator.services.get).toHaveBeenCalledWith(heldAccountId);
    }

    // Commands need the manage grant; a platform reader or seller is refused before any command runs.
    for (const permissions of [["payouts.platform.view"], ["payouts.view"]]) {
      const reader = createApp(permissions);
      for (const method of ["POST", "DELETE"] as const) {
        const response = await reader.app.request(path, json(method, { reason: "Synthetic review" }));
        expect(response.status).toBe(403);
      }
      expect(reader.services.place).not.toHaveBeenCalled();
      expect(reader.services.release).not.toHaveBeenCalled();
      expect(reader.store.readAllEvents()).toEqual([]);
    }

    const manager = createApp(["payout-review-holds.manage"]);
    for (const method of ["POST", "DELETE"] as const) {
      for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: "r".repeat(501) }]) {
        const response = await manager.app.request(path, json(method, body));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
      }
    }
    expect(manager.store.readAllEvents()).toEqual([]);

    const placed = await manager.app.request(path, json("POST", { reason: " Synthetic chargeback review " }));
    expect(placed.status).toBe(201);
    expect(await placed.json()).toEqual({ outcome: "placed", version: 1 });
    // An already-active hold still refuses a reasonless command instead of reporting a no-op.
    expect((await manager.app.request(path, json("POST", { reason: " " }))).status).toBe(400);
    const repeat = await manager.app.request(path, json("POST", { reason: "Second review" }));
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ outcome: "noop", version: 1 });
    const view = await (await manager.app.request(path)).json();
    expect(view).toMatchObject({
      active: true,
      reason: "Synthetic chargeback review",
      source: "operator",
      sourceReference: null,
      actorUserId: "usr_synthetic_operator",
      version: 1,
    });
    expect(typeof view.occurredAt).toBe("string");
    const released = await manager.app.request(path, json("DELETE", { reason: "Review complete" }));
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ outcome: "released", version: 2 });
    expect(manager.store.readAllEvents().map((event) => [event.eventType, event.payload.source])).toEqual([
      ["settlement.payout-review-hold.placed", "operator"],
      ["settlement.payout-review-hold.released", "operator"],
    ]);
  });
});
