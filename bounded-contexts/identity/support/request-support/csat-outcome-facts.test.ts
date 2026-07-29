import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { EventId } from "@chase-sets/primitives/typed-ids";
import { describe, expect, it } from "vitest";
import { IDENTITY_CSAT_OUTCOME_FACT_EVENT_TYPE, publishIdentityCsatOutcomeFact } from "./csat-outcome-facts";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
  trace: {},
} as EventStoreContext;

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

  /**
   * Bound contract for bounded-contexts/identity/support/request-support/csat-outcome-facts.ts:readStream#1.
   *
   * The declared bound is load-bearing here, not decorative: the store below
   * refuses any limit other than the declared 1, and the stream carries a
   * later event that never participates in the answer.
   */
  it("recovers a conflicting publish from its declared one-event prefix", async () => {
    const { eventStore } = createInMemoryEventStore();
    const readStreamLimits: (number | undefined)[] = [];
    const boundedEventStore: EventStore = {
      ...eventStore,
      readStream: async (input) => {
        readStreamLimits.push(input.limit);
        if (input.limit !== 1) {
          throw new Error(`Declared bounded prefix is 1 event; this read asked for ${String(input.limit)}.`);
        }
        return eventStore.readStream(input);
      },
    };
    const outcomeOccurredAt = "2026-07-29T00:00:00.000Z";

    const published = await publishIdentityCsatOutcomeFact(boundedEventStore, context, {
      outcomeCode: "registration.completed",
      subjectAccountId: "acc_buyer",
      subjectKind: "account",
      subject: { entityType: "account", entityId: "acc_buyer" },
      idempotencyKey: "identity:registration:acc_buyer",
      outcomeOccurredAt,
    });
    const [factEvent] = await eventStore.readAll();
    await eventStore.appendToStream({
      streamId: factEvent.streamId,
      expectedVersion: "any",
      context,
      events: [
        {
          eventId: "evt_csat_later_event" as EventId,
          eventType: IDENTITY_CSAT_OUTCOME_FACT_EVENT_TYPE,
          payload: { ...published, idempotencyKey: "never-recovered" } as unknown as JsonObject,
        },
      ],
    });
    readStreamLimits.length = 0;

    await expect(
      publishIdentityCsatOutcomeFact(boundedEventStore, context, {
        outcomeCode: "registration.completed",
        subjectAccountId: "acc_other",
        subjectKind: "account",
        subject: { entityType: "account", entityId: "acc_buyer" },
        idempotencyKey: "identity:registration:acc_buyer",
        outcomeOccurredAt,
      }),
    ).resolves.toEqual(published);
    expect(readStreamLimits, "the recovery read must consume exactly the declared bound").toEqual([1]);
  });
});
