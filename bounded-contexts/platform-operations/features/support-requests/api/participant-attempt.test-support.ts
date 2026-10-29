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
import type { SupportEvidenceAttachmentStorage } from "./attachments";
import type { SupportResponseType } from "../domain/common";

export const buyer = evidenceActor("viewer", ["support.view", "support.manage"], true);
export const responseSeller = evidenceActor("viewer", ["support.view", "support.manage"], false, "acc_seller");
export const responseCases = [
  { responseType: "accept-return", resolutionType: "return-for-refund", flowType: "product-not-as-described" },
  { responseType: "offer-partial-refund", resolutionType: "partial-refund", flowType: "product-not-as-described" },
  { responseType: "offer-replacement", resolutionType: "replacement", flowType: "product-not-as-described" },
  { responseType: "provide-tracking", resolutionType: null, flowType: "product-not-received" },
  { responseType: "issue-refund", resolutionType: null, flowType: "product-not-received" },
  { responseType: "challenge-with-evidence", resolutionType: null, flowType: "product-not-as-described" },
  { responseType: "confirm-cancellation", resolutionType: null, flowType: "buyer-cancel-request" },
  { responseType: "confirm-cannot-fulfill", resolutionType: null, flowType: "seller-cannot-fulfill" },
  { responseType: "request-support-review", resolutionType: null, flowType: "product-not-as-described" },
] as const;
export async function responseFixture(responseType: SupportResponseType, summary: string) {
  const fixture = participantFixture();
  const scenario = responseCases.find((entry) => entry.responseType === responseType)!;
  const opener = scenario.flowType === "seller-cannot-fulfill" ? responseSeller : buyer;
  const opened = await fixture.runtime.openSupportRequest(
    { orderId: openBody.orderId, flowType: scenario.flowType, accountId: opener.accountId },
    actorContext(opener),
  );
  return {
    ...fixture,
    id: opened.supportRequestId,
    body: {
      responseType,
      summary,
      ...(responseType === "offer-partial-refund" ? { refundAmount: "6.00" } : {}),
    },
  };
}
export async function operationsResponseFixture(responseType: SupportResponseType, summary: string) {
  const fixture = await responseFixture(responseType, summary);
  const operator = evidenceActor("owner", ["support.view", "support.manage"], true, "acc_operator");
  fixture.setActor(operator);
  fixture.db.query.mockResolvedValue({ rows: [{ support_request_id: fixture.id, resolution: null }] } as never);
  return { ...fixture, operator };
}
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
  const storage = {
    putPrivate: vi.fn<SupportEvidenceAttachmentStorage["putPrivate"]>(),
    readPrivate: vi.fn<SupportEvidenceAttachmentStorage["readPrivate"]>(),
    verifyPrivate: vi.fn<SupportEvidenceAttachmentStorage["verifyPrivate"]>(),
  } satisfies SupportEvidenceAttachmentStorage;
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
  const executeParticipant = async (
    actionKind: ParticipantAction,
    body: unknown,
    targetId?: string,
    key = attemptId,
    asActor = buyer,
  ) =>
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
    executeParticipant,
    lookup,
    storage,
    db,
    setActor: (value: ResolvedActor | null) => {
      actor = value;
    },
  };
}
