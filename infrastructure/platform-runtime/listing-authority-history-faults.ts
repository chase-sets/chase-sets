import assert from "node:assert/strict";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { authorityHash } from "./listing-authority-state";
import {
  LISTING_AUTHORITY_HISTORY_RECORDS,
  LISTING_AUTHORITY_HISTORY_COPIES,
} from "./listing-authority-history-conformance";

export const historyFaultModes = ["loss", "truncation", "recreation", "corruption"] as const;
export const historyRecords = LISTING_AUTHORITY_HISTORY_RECORDS.flatMap((kind) =>
  LISTING_AUTHORITY_HISTORY_COPIES.map((copy, index) => ({ kind, copy, index })),
);
export type HistoryRecord = (typeof historyRecords)[number];
export type HistoryFault = HistoryRecord & { mode: (typeof historyFaultModes)[number] };
export function historyFaultSets(records = historyRecords): HistoryFault[][] {
  return records.flatMap((first, index) =>
    historyFaultModes.flatMap((mode) => [
      [{ ...first, mode }],
      ...records.slice(index + 1).flatMap((second) =>
        historyFaultModes.map((other) => [
          { ...first, mode },
          { ...second, mode: other },
        ]),
      ),
    ]),
  );
}
export const faultName = (selected: readonly HistoryFault[]) =>
  selected.map((r) => `${r.kind}.${r.copy}:${r.mode}`).join("+");

/** Every representative changes a consumed schema field, not an ignored extension. */
export function corruptHistoryEvent(event: StoredEvent, record: HistoryRecord): StoredEvent {
  const payload = structuredClone(event.payload);
  if (record.copy !== "canonical") {
    if (record.kind === "resource") payload.stateHash = authorityHash({ grants: [], pending: null });
    else payload.eventHash = "synthetic-corrupt-canonical-commitment";
  } else if (payload.reservation) {
    const reservation = payload.reservation as Record<string, unknown>;
    reservation.operation = { ...(reservation.operation as object), commandFingerprint: "synthetic-other-command" };
  } else if (payload.operation) {
    payload.operation = { ...(payload.operation as object), commandFingerprint: "synthetic-other-command" };
  } else if (payload.invalidation) {
    payload.invalidation = { ...(payload.invalidation as object), mutationId: "synthetic-other-closure" };
  } else if (payload.intent) {
    payload.intent = { ...(payload.intent as object), mutationId: "synthetic-other-intent" };
  } else if (payload.inputs) {
    const inputs = payload.inputs as unknown as { events: { payload: unknown }[] }[];
    inputs[0]!.events[0]!.payload = { syntheticUnauthorized: true };
  } else if ("result" in payload) payload.result = { syntheticUnauthorized: true };
  else if ("status" in payload) payload.status = "synthetic-false-completion";
  else if ("reservationId" in payload) payload.reservationId = "synthetic-other-reservation";
  else if ("mutationId" in payload) payload.mutationId = "synthetic-other-mutation";
  else return { ...event, eventType: "synthetic.false-completion" };
  return { ...event, payload };
}

export function damageHistory(histories: Map<string, StoredEvent[]>, streamId: string, fault: HistoryFault) {
  const events = histories.get(streamId);
  assert.ok(events?.length, `${streamId} exists before ${fault.mode}`);
  if (fault.mode === "loss") histories.delete(streamId);
  else if (fault.mode === "truncation") histories.set(streamId, events.slice(0, -1));
  else if (fault.mode === "recreation")
    histories.set(streamId, [{ ...events[0]!, eventId: "evt_synthetic-recreated-history" }]);
  else
    histories.set(
      streamId,
      events.map((event) => corruptHistoryEvent(event, fault)),
    );
}
