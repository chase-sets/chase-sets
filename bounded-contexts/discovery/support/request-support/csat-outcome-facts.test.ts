import { assertBoundedStreamReadContract, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { describe, expect, it, vi } from "vitest";
import { publishDiscoveryCsatOutcomeFact } from "./csat-outcome-facts";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
  trace: {},
} as EventStoreContext;
const streamReadContractSiteId =
  "bounded-contexts/discovery/support/request-support/csat-outcome-facts.ts#readStream#1";

describe("discovery CSAT outcome facts", () => {
  it(`${streamReadContractSiteId} returns the first matching fact unchanged`, async () => {
    const { allEvents, eventStore, streams } = createInMemoryEventStore();
    const input = {
      outcomeCode: "discovery.search-completed",
      subjectAccountId: "acc_buyer",
      subjectKind: "account" as const,
      subject: { entityType: "session", entityId: "ses_1" },
      idempotencyKey: "discovery:search-session:ses_1",
      outcomeOccurredAt: "2026-01-01T00:00:00.000Z",
    };

    const firstFact = await publishDiscoveryCsatOutcomeFact(eventStore, context, input);
    expect(firstFact).toMatchObject({
      factSchemaVersion: 1,
      outcomeCode: "discovery.search-completed",
      sourceContext: "discovery",
      subjectAccountId: "acc_buyer",
    });
    const firstEvent = allEvents[0]!;
    await eventStore.appendToStream({
      streamId: firstEvent.streamId,
      expectedVersion: 1,
      events: [
        {
          eventType: firstEvent.eventType,
          payload: { ...firstFact, outcomeOccurredAt: "2026-01-02T00:00:00.000Z" },
        },
      ],
      context,
    });

    const readStream = vi.spyOn(eventStore, "readStream");
    await expect(
      publishDiscoveryCsatOutcomeFact(eventStore, context, {
        ...input,
        outcomeOccurredAt: "2026-01-03T00:00:00.000Z",
      }),
    ).resolves.toEqual(firstFact);

    assertBoundedStreamReadContract({
      streamId: firstEvent.streamId,
      bound: 1,
      historyLength: streams.get(firstEvent.streamId)?.length ?? 0,
      requests: readStream.mock.calls.map(([request]) => request),
    });
    await expect(eventStore.readAll()).resolves.toHaveLength(2);
  });

  it("rejects codes owned by another source context", async () => {
    const { eventStore } = createInMemoryEventStore();

    await expect(
      publishDiscoveryCsatOutcomeFact(eventStore, context, {
        outcomeCode: "registration.completed",
        subjectAccountId: "acc_buyer",
        subjectKind: "account",
        subject: { entityType: "account", entityId: "acc_buyer" },
        idempotencyKey: "identity:registration:acc_buyer",
      }),
    ).rejects.toThrow("not owned by discovery");
  });
});
