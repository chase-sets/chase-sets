import { describe, expect, it } from "vitest";
import type { StoredEvent } from "./storage";
import {
  isContextPrivateEventType,
  isPrivacyRedactedTransportEventType,
  redactedTransportAudit,
  redactedTransportTiming,
  toTransportEvent,
} from "./transport";

// Synthetic identities only.
const blockingAccountId = "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const blockedAccountId = "acc_01ARZ3NDEKTSV4RRFFQ69G5FAW";

function storedEvent(eventType: string, payload: StoredEvent["payload"]): StoredEvent {
  return {
    eventId: "evt_transport_contract" as StoredEvent["eventId"],
    streamId: "identity.account-block-pair-synthetic",
    streamVersion: 2,
    globalPosition: "7" as StoredEvent["globalPosition"],
    tenantId: "tnt_synthetic" as StoredEvent["tenantId"],
    eventType,
    payload,
    metadata: { sessionId: "ses_synthetic" },
    occurredAt: "2031-03-04T05:06:07.890Z" as StoredEvent["occurredAt"],
    recordedAt: "2031-03-04T05:06:07.891Z" as StoredEvent["recordedAt"],
    performedByUserId: "usr_synthetic" as StoredEvent["performedByUserId"],
    forAccountId: blockingAccountId as StoredEvent["forAccountId"],
    traceId: "trc_synthetic" as StoredEvent["traceId"],
    spanId: "spn_synthetic" as StoredEvent["spanId"],
  };
}

describe("privacy-redacted transport envelope", () => {
  it("keeps only id, type, position, tenant and the closed payload for Account Block facts", () => {
    for (const type of ["identity.account-blocked", "identity.account-unblocked"]) {
      expect(toTransportEvent(storedEvent(type, { blockingAccountId, blockedAccountId }))).toEqual({
        id: "evt_transport_contract",
        type,
        streamId: "identity.account-block-pair-synthetic",
        streamVersion: 2,
        globalPosition: "7",
        tenantId: "tnt_synthetic",
        data: { blockingAccountId, blockedAccountId },
        metadata: {},
        audit: redactedTransportAudit,
        trace: {},
        timing: redactedTransportTiming,
      });
    }
  });

  it("fails closed instead of transporting a planted Account Block fact field", () => {
    expect(() =>
      toTransportEvent(storedEvent("identity.account-blocked", { blockingAccountId, blockedAccountId, traceId: "x" })),
    ).toThrow("Account Block fact requires exactly");
  });

  it("redacts the private Account Block envelope and refuses it at the context boundary", () => {
    const transport = toTransportEvent(storedEvent("identity.account-block-transition-recorded", { version: 1 }));
    expect([transport.audit, transport.trace, transport.timing, transport.metadata]).toEqual([
      redactedTransportAudit,
      {},
      redactedTransportTiming,
      {},
    ]);
    expect(isContextPrivateEventType("identity.account-block-budget-recorded")).toBe(true);
    expect(isContextPrivateEventType("identity.account-blocked")).toBe(false);
    expect(isPrivacyRedactedTransportEventType("identity.account-unblocked")).toBe(true);
  });

  it("leaves every other event's envelope unchanged", () => {
    const event = storedEvent("identity.account.suspended", {});
    expect(toTransportEvent(event)).toEqual({
      id: event.eventId,
      type: event.eventType,
      streamId: event.streamId,
      streamVersion: event.streamVersion,
      globalPosition: event.globalPosition,
      tenantId: event.tenantId,
      data: {},
      metadata: { sessionId: "ses_synthetic" },
      audit: { performedByUserId: "usr_synthetic", forAccountId: blockingAccountId },
      trace: { traceId: "trc_synthetic", spanId: "spn_synthetic", parentSpanId: undefined, traceState: undefined },
      timing: { occurredAt: event.occurredAt, recordedAt: event.recordedAt },
    });
    expect(isPrivacyRedactedTransportEventType("identity.account.suspended")).toBe(false);
  });
});
