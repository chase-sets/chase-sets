import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { EventId } from "@chase-sets/primitives/typed-ids";
import { describe, expect, it } from "vitest";
import { DISCOVERY_CSAT_OUTCOME_FACT_EVENT_TYPE, publishDiscoveryCsatOutcomeFact } from "./csat-outcome-facts";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
  trace: {},
} as EventStoreContext;

describe("discovery CSAT outcome facts", () => {
  it("publishes a server-owned search completion once per session", async () => {
    const { eventStore } = createInMemoryEventStore();
    const input = {
      outcomeCode: "discovery.search-completed",
      subjectAccountId: "acc_buyer",
      subjectKind: "account" as const,
      subject: { entityType: "session", entityId: "ses_1" },
      idempotencyKey: "discovery:search-session:ses_1",
    };

    await expect(publishDiscoveryCsatOutcomeFact(eventStore, context, input)).resolves.toMatchObject({
      factSchemaVersion: 1,
      outcomeCode: "discovery.search-completed",
      sourceContext: "discovery",
      subjectAccountId: "acc_buyer",
    });
    await publishDiscoveryCsatOutcomeFact(eventStore, context, input);

    await expect(eventStore.readAll()).resolves.toHaveLength(1);
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

  /**
   * Bound contract for bounded-contexts/discovery/support/request-support/csat-outcome-facts.ts:readStream#1.
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

    const published = await publishDiscoveryCsatOutcomeFact(boundedEventStore, context, {
      outcomeCode: "discovery.search-completed",
      subjectAccountId: "acc_buyer",
      subjectKind: "account",
      subject: { entityType: "session", entityId: "ses_1" },
      idempotencyKey: "discovery:search-session:ses_1",
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
          eventType: DISCOVERY_CSAT_OUTCOME_FACT_EVENT_TYPE,
          payload: { ...published, idempotencyKey: "never-recovered" } as unknown as JsonObject,
        },
      ],
    });
    readStreamLimits.length = 0;

    await expect(
      publishDiscoveryCsatOutcomeFact(boundedEventStore, context, {
        outcomeCode: "discovery.search-completed",
        subjectAccountId: "acc_other",
        subjectKind: "account",
        subject: { entityType: "session", entityId: "ses_1" },
        idempotencyKey: "discovery:search-session:ses_1",
        outcomeOccurredAt,
      }),
    ).resolves.toEqual(published);
    expect(readStreamLimits, "the recovery read must consume exactly the declared bound").toEqual([1]);
  });
});
