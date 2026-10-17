// @vitest-environment node
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createSupportRequestRuntime } from "./runtime";
import { buildSupportApi, type SupportApiEnv } from "./http";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";

const actor = evidenceActor("viewer", ["support.view", "support.manage"], true);
const attemptId = "7163_attempt_0123456789abcdef";
const payload = { orderId: "ord_attempt", flowType: "product-not-received", affectedLineIds: null };
const hash = createHash("sha256")
  .update(JSON.stringify({ version: 1, actionKind: "open-support-request", payload }))
  .digest("hex");

function fixture() {
  const store = createInMemoryEventStore();
  const db = {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM support_order_sources")
        ? [
            {
              order_id: payload.orderId,
              buyer_account_id: actor.accountId,
              seller_account_id: "acc_seller",
              status: "shipped",
              total_amount: "24.00",
              delivered_at: null,
              return_context: [],
              affected_line_amounts: [],
            },
          ]
        : [],
    })),
  };
  const runtime = createSupportRequestRuntime({
    eventStore: store.eventStore,
    db: db as never,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
  });
  const app = new Hono<SupportApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", {
      tenantId: actor.tenantId as never,
      audit: { forAccountId: actor.accountId as never, performedByUserId: actor.userId as never },
    });
    await next();
  });
  app.route("/", buildSupportApi(runtime));
  const send = (key = attemptId, requestHash = hash, body: unknown = payload) =>
    app.request("/support-requests", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key, "X-Support-Request-Hash": requestHash },
      body: JSON.stringify(body),
    });
  return { ...store, app, send };
}

describe("PostgreSQL runtime/version matrix contract (unit control)", () => {
  it("commit-loss exact open retry returns first ids/status and appends zero", async () => {
    const f = fixture();
    const first = await f.send();
    expect(first.status).toBe(201);
    const result = await first.json();
    const count = f.allEvents.length;
    const retry = await f.send();
    expect(await retry.json()).toEqual(result);
    expect(f.allEvents).toHaveLength(count);
  });
  it("requires id/hash before participant append and rejects nested unknowns", async () => {
    const f = fixture();
    expect((await f.send("", "")).status).toBe(400);
    expect((await f.send(attemptId, hash, { ...payload, metadata: { file: "private.jpg" } })).status).toBe(400);
    expect(f.allEvents).toHaveLength(0);
  });
});
