import { assertBoundedStreamReadContract, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { describe, expect, it, vi } from "vitest";
import { publishIdentityCsatOutcomeFact } from "./csat-outcome-facts";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
  trace: {},
} as EventStoreContext;
const streamReadContractSiteId = "bounded-contexts/identity/support/request-support/csat-outcome-facts.ts#readStream#1";

describe("identity CSAT outcome facts", () => {
  it("publishes registration and onboarding facts with identity provenance", async () => {
    const { eventStore } = createInMemoryEventStore();

    const registration = await publishIdentityCsatOutcomeFact(eventStore, context, {
      outcomeCode: "registration.completed",
      subjectAccountId: "acc_buyer",
      subjectKind: "account",
      subject: { entityType: "account", entityId: "acc_buyer" },
      idempotencyKey: "identity:registration:acc_buyer",
    });
    const onboarding = await publishIdentityCsatOutcomeFact(eventStore, context, {
      outcomeCode: "onboarding.completed",
      subjectAccountId: "acc_buyer",
      subjectKind: "account",
      subject: { entityType: "invitation", entityId: "inv_1" },
      idempotencyKey: "identity:onboarding:invitation:inv_1:usr_buyer",
    });

    expect(registration.sourceContext).toBe("identity");
    expect(onboarding.outcomeCode).toBe("onboarding.completed");
    await expect(eventStore.readAll()).resolves.toHaveLength(2);
  });

  it(`${streamReadContractSiteId} returns the first matching fact unchanged`, async () => {
    const { allEvents, eventStore, streams } = createInMemoryEventStore();
    const input = {
      outcomeCode: "registration.completed" as const,
      subjectAccountId: "acc_buyer",
      subjectKind: "account" as const,
      subject: { entityType: "account", entityId: "acc_buyer" },
      idempotencyKey: "identity:registration:acc_buyer",
      outcomeOccurredAt: "2026-01-01T00:00:00.000Z",
    };
    const firstFact = await publishIdentityCsatOutcomeFact(eventStore, context, input);
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
      publishIdentityCsatOutcomeFact(eventStore, context, {
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
