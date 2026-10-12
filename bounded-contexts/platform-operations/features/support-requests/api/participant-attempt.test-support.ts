import { createHash } from "node:crypto";
import { Hono } from "hono";
import { vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { ZERO_GLOBAL_POSITION, type EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { canonicalParticipantRequest, type ParticipantAction } from "../domain/participant-attempt";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";
import { createSupportRequestRuntime } from "./runtime";
import { buildSupportApi, type SupportApiEnv } from "./http";

export const buyer = evidenceActor("viewer", ["support.view", "support.manage"], true);
export const attemptId = "7163_attempt_0123456789abcdef";
export const openBody = { orderId: "ord_attempt", flowType: "product-not-received" };
export function requestHash(action: ParticipantAction, body: unknown) {
  return createHash("sha256").update(canonicalParticipantRequest(action, body)).digest("hex");
}
export function actorContext(actor: ResolvedActor): EventStoreContext {
  return {
    tenantId: actor.tenantId as never,
    audit: { forAccountId: actor.accountId as never, performedByUserId: actor.userId as never },
  };
}
export function participantFixture(store?: EventStore) {
  const memory = createInMemoryEventStore();
  const eventStore = store ?? memory.eventStore;
  let actor: ResolvedActor | null = buyer;
  const storage = { putObject: vi.fn(), getObject: vi.fn(), deleteObjects: vi.fn() };
  const db = {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM support_order_sources")
        ? [
            {
              order_id: openBody.orderId,
              buyer_account_id: buyer.accountId,
              seller_account_id: "acc_seller",
              status: "shipped",
              total_amount: "24.00",
              delivered_at: null,
              return_context: [],
              affected_line_amounts: [
                { lineId: "line_a", amount: "12.00", currencyCode: "usd" },
                { lineId: "line_b", amount: "12.00", currencyCode: "usd" },
              ],
            },
          ]
        : [],
    })),
  };
  const runtime = createSupportRequestRuntime({
    eventStore,
    db: db as never,
    attachmentStorage: storage,
    now: () => "2026-10-12T12:00:00.000Z",
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
  });
  const app = new Hono<SupportApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    if (actor) c.set("context", actorContext(actor));
    await next();
  });
  app.route("/", buildSupportApi(runtime));
  const execute = (actionKind: ParticipantAction, body: unknown, targetId?: string, key = attemptId, asActor = buyer) =>
    runtime.executeParticipantAttempt(
      {
        actionKind,
        body,
        accountId: asActor.accountId,
        actor: asActor,
        targetId,
        attempt: { attemptId: key, requestHash: requestHash(actionKind, body) },
      },
      actorContext(asActor),
    );
  const lookup = (actionKind: ParticipantAction, body: unknown, targetId?: string, key = attemptId, asActor = buyer) =>
    runtime.getParticipantAttempt({
      actionKind,
      accountId: asActor.accountId,
      tenantId: asActor.tenantId,
      targetId,
      attempt: { attemptId: key, requestHash: requestHash(actionKind, body) },
    });
  return {
    ...memory,
    eventStore,
    runtime,
    app,
    execute,
    lookup,
    storage,
    db,
    setActor: (value: ResolvedActor | null) => {
      actor = value;
    },
  };
}
