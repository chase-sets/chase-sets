import { describe, expect, it } from "vitest";
import type { StoredEvent } from "./storage";
import { getEventCommitMetadata, recordCommittedEvents, runWithEventCommitMetadata } from "./consistency";

function storedEvent(input: Readonly<{ id: string; streamId: string; globalPosition: string }>): StoredEvent {
  return {
    eventId: input.id as StoredEvent["eventId"],
    streamId: input.streamId,
    streamVersion: 1,
    globalPosition: input.globalPosition as StoredEvent["globalPosition"],
    tenantId: "tnt_test" as StoredEvent["tenantId"],
    eventType: `${input.streamId}.changed`,
    payload: {},
    metadata: {},
    occurredAt: "2026-05-29T00:00:00.000Z" as StoredEvent["occurredAt"],
    recordedAt: "2026-05-29T00:00:00.000Z" as StoredEvent["recordedAt"],
    performedByUserId: "usr_test" as StoredEvent["performedByUserId"],
    forAccountId: "acct_test" as StoredEvent["forAccountId"],
  };
}

describe("event commit metadata", () => {
  it("groups committed events by source context", async () => {
    await runWithEventCommitMetadata(async () => {
      recordCommittedEvents([
        storedEvent({ id: "evt_1", streamId: "marketplace.listing-lst_1", globalPosition: "4" }),
        storedEvent({ id: "evt_2", streamId: "inventory.item-itm_1", globalPosition: "9" }),
        storedEvent({ id: "evt_3", streamId: "marketplace.listing-lst_2", globalPosition: "7" }),
      ]);

      expect(getEventCommitMetadata()).toMatchObject({
        eventIds: ["evt_1", "evt_2", "evt_3"],
        maxGlobalPosition: "9",
        sources: [
          { sourceContextName: "inventory", eventIds: ["evt_2"], maxGlobalPosition: "9" },
          { sourceContextName: "marketplace", eventIds: ["evt_1", "evt_3"], maxGlobalPosition: "7" },
        ],
        committedEvents: [
          expect.objectContaining({ eventId: "evt_1", streamId: "marketplace.listing-lst_1" }),
          expect.objectContaining({ eventId: "evt_2", streamId: "inventory.item-itm_1" }),
          expect.objectContaining({ eventId: "evt_3", streamId: "marketplace.listing-lst_2" }),
        ],
      });
    });
  });

  it("uses an explicit source context for durable stream prefixes that differ from context ownership", async () => {
    await runWithEventCommitMetadata(async () => {
      recordCommittedEvents(
        [storedEvent({ id: "evt_1", streamId: "support.support-request-sup_1", globalPosition: "4" })],
        "platform-operations",
      );

      expect(getEventCommitMetadata().sources).toEqual([
        { sourceContextName: "platform-operations", eventIds: ["evt_1"], maxGlobalPosition: "4" },
      ]);
    });
  });

  it("returns detached arrays while retaining the committed event values in-process", async () => {
    await runWithEventCommitMetadata(async () => {
      const event = storedEvent({ id: "evt_1", streamId: "checkout.session-chk_1", globalPosition: "4" });
      recordCommittedEvents([event]);

      const first = getEventCommitMetadata();
      (first.committedEvents as StoredEvent[]).pop();

      expect(getEventCommitMetadata().committedEvents).toEqual([event]);
    });
  });
});
