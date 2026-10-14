import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { evolveRestockDecision, initialRestockDecisionState, type RestockDecisionState } from "../domain/domain";

function requireHistory(condition: unknown): asserts condition {
  if (!condition)
    throw new InventoryDomainError("Restock decision history is unavailable; reconciliation is required.");
}
function object(value: unknown, fields: readonly string[]) {
  requireHistory(value !== null && typeof value === "object" && !Array.isArray(value));
  const result = value as Record<string, unknown>;
  requireHistory(Object.keys(result).every((key) => fields.includes(key)));
  return result;
}
function text(value: unknown): string {
  requireHistory(typeof value === "string" && value.trim().length > 0);
  return value;
}
function optionalText(value: unknown): string | null {
  requireHistory(value === null || typeof value === "string");
  return value;
}
function instant(value: unknown): string {
  const result = text(value);
  requireHistory(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(result));
  requireHistory(Number.isFinite(Date.parse(result)));
  return result;
}

async function readOwnerHistory(deps: InventoryRuntimeDeps, streamId: string, context: EventStoreContext) {
  try {
    const events = await readCompleteStream(deps.eventStore, { streamId });
    const ledger = await deps.db.query<{ current_version: string; total: string }>(
      `SELECT stream.current_version, (SELECT COUNT(*)::text FROM event_store_events event WHERE event.stream_id = stream.stream_id) AS total
       FROM event_store_streams stream WHERE stream.stream_id = $1`,
      [streamId],
    );
    if (events.length === 0 && ledger.rows.length === 0) return events;
    requireHistory(
      ledger.rows.length === 1 &&
        events.length === Number(ledger.rows[0].total) &&
        events.length === Number(ledger.rows[0].current_version),
    );
    const ids = new Set<string>();
    for (const [index, event] of events.entries()) {
      requireHistory(
        event.streamId === streamId &&
          event.tenantId === context.tenantId &&
          event.forAccountId === context.audit.forAccountId &&
          event.streamVersion === index + 1 &&
          !ids.has(event.eventId),
      );
      ids.add(event.eventId);
    }
    return events;
  } catch {
    throw new InventoryDomainError("Restock decision history is unavailable; reconciliation is required.");
  }
}

export async function assertNoRetainedRestockStock(
  deps: InventoryRuntimeDeps,
  state: RestockDecisionState,
  context: EventStoreContext,
) {
  try {
    const events = await readOwnerHistory(deps, `inventory.item-${state.itemId}`, context);
    requireHistory(
      events.length > 0 &&
        events[0].eventType === "inventory.item.created" &&
        events[0].payload.itemId === state.itemId &&
        events[0].payload.accountId === state.accountId,
    );
    for (const event of events) {
      if (
        event.eventType !== "inventory.item.adjusted" ||
        (event.payload.reason !== "return-restocked" && event.payload.reasonCode !== "return-restocked")
      )
        continue;
      requireHistory(event.payload.itemId === state.itemId);
      const source = object(event.payload.sourceRef, ["orderId", "reservationRequestId"]);
      text(source.orderId);
      text(source.reservationRequestId);
      requireHistory(source.orderId !== state.orderId);
    }
  } catch {
    throw new InventoryDomainError("Restock decision history is unavailable; reconciliation is required.");
  }
}

export async function loadRestockDecisionHistory(
  deps: InventoryRuntimeDeps,
  decisionId: string,
  context: EventStoreContext,
) {
  try {
    const owner = await deps.db.query(
      `SELECT event_id FROM event_store_events
       WHERE stream_id = $1 AND stream_version = 1 AND tenant_id = $2 AND payload ->> 'accountId' = $3`,
      [`inventory.restock-decision-${decisionId}`, context.tenantId, context.audit.forAccountId],
    );
    if (owner.rows.length === 0) return { state: initialRestockDecisionState, version: 0 };
    const events = await readOwnerHistory(deps, `inventory.restock-decision-${decisionId}`, context);
    let state = initialRestockDecisionState;
    for (const [index, event] of events.entries()) {
      if (index === 0) {
        requireHistory(event.eventType === "inventory.restock-decision.pending");
        const data = object(event.payload, [
          "decisionId",
          "accountId",
          "orderId",
          "itemId",
          "quantity",
          "source",
          "sourceRef",
          "shipmentId",
          "returnReason",
          "pendingAt",
        ]);
        requireHistory(
          data.decisionId === decisionId &&
            Number.isSafeInteger(data.quantity) &&
            typeof data.quantity === "number" &&
            data.quantity > 0,
        );
        requireHistory(data.source === "order-cancelled-after-dispatch" || data.source === "shipment-returned");
        const source = object(data.sourceRef, ["orderId", "reservationRequestId"]);
        requireHistory(source.orderId === data.orderId);
        state = evolveRestockDecision(state, {
          type: "inventory.restock-decision.pending",
          data: {
            decisionId,
            accountId: parseTypedId(text(data.accountId), "acc"),
            orderId: text(data.orderId),
            itemId: text(data.itemId),
            quantity: data.quantity,
            source: data.source,
            sourceRef: { orderId: text(source.orderId), reservationRequestId: text(source.reservationRequestId) },
            shipmentId: optionalText(data.shipmentId),
            returnReason: optionalText(data.returnReason),
            pendingAt: instant(data.pendingAt),
          },
        });
      } else {
        requireHistory(
          index === 1 && state.status === "pending" && event.eventType === "inventory.restock-decision.recorded",
        );
        const data = object(event.payload, [
          "decisionId",
          "accountId",
          "orderId",
          "itemId",
          "quantity",
          "outcome",
          "reason",
          "sourceRef",
          "damageNote",
          "decidedAt",
        ]);
        requireHistory(
          data.decisionId === decisionId &&
            data.accountId === state.accountId &&
            data.orderId === state.orderId &&
            data.itemId === state.itemId &&
            data.quantity === state.quantity,
        );
        requireHistory(data.outcome === "restocked" || data.outcome === "written-off");
        const reason = data.outcome === "restocked" ? "return-restocked" : "written-off";
        requireHistory(data.reason === reason);
        const source = object(data.sourceRef, ["orderId", "reservationRequestId"]);
        requireHistory(
          state.sourceRef !== null &&
            "orderId" in state.sourceRef &&
            source.orderId === state.sourceRef.orderId &&
            source.reservationRequestId === state.sourceRef.reservationRequestId,
        );
        state = evolveRestockDecision(state, {
          type: "inventory.restock-decision.recorded",
          data: {
            decisionId,
            accountId: state.accountId!,
            orderId: state.orderId!,
            itemId: state.itemId!,
            quantity: state.quantity,
            outcome: data.outcome,
            reason,
            sourceRef: state.sourceRef,
            damageNote: optionalText(data.damageNote),
            decidedAt: instant(data.decidedAt),
          },
        });
      }
    }
    return { state, version: events.length };
  } catch {
    throw new InventoryDomainError("Restock decision history is unavailable; reconciliation is required.");
  }
}
