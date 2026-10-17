import { assertBoundedStreamReadContract, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { describe, expect, it, vi } from "vitest";
import { publishAuthenticationCsatOutcomeFact } from "./csat-outcome-facts";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
  trace: {},
} as EventStoreContext;
const streamReadContractSiteId = "bounded-contexts/auth/support/request-support/csat-outcome-facts.ts#readStream#1";

describe("auth CSAT outcome facts", () => {
  it(`${streamReadContractSiteId} returns the first matching fact unchanged`, async () => {
    const { allEvents, eventStore, streams } = createInMemoryEventStore();
    const input = {
      subjectAccountId: "acc_buyer",
      sessionId: "ses_1",
      outcomeOccurredAt: "2026-01-01T00:00:00.000Z",
    };

    const firstFact = await publishAuthenticationCsatOutcomeFact(eventStore, context, input);
    expect(firstFact).toMatchObject({
      factSchemaVersion: 1,
      outcomeCode: "authentication.completed",
      sourceContext: "auth",
      subject: { entityType: "session", entityId: "ses_1" },
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
      publishAuthenticationCsatOutcomeFact(eventStore, context, {
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
});
