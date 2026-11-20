import type { PaymentsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { upsertOutcomeFact } from "../../read-model/outcome-fact-projection";

export function buildPaymentsOutcomeFactProjectionHandlers(): ProjectorHandlerMap {
  return defineProjectorHandlers<Pick<PaymentsEventPayloads, "payments.payment-captured">>({
    "payments.payment-captured": async (event, context) => {
      if (!Object.hasOwn(event.data, "sourceContext")) return;
      const outcomeCode =
        event.data.sourceContext === "checkout-recovery" ? "checkout.recovered" : "checkout.completed";
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: `payment:${event.data.paymentId}:${outcomeCode}`,
        outcomeCode,
        sourceContext: "checkout",
        subjectAccountId: event.data.buyerAccountId,
        subjectKind: "buyer",
        subjectEntityType: "payment",
        subjectEntityId: event.data.paymentId,
        outcomeOccurredAt: event.data.capturedAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: null,
      });
    },
  });
}
