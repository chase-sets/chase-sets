import { describe, expect, it, vi } from "vitest";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, GlobalPosition, ReadStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import { createFoundersCohortRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
  trace: {},
} as never;

describe("founders cohort runtime", () => {
  it("retries optimistic conflicts so concurrent claims receive unique numbers", async () => {
    const eventStore = concurrencyCheckingEventStore();
    const assignedNumbers: number[] = [];
    const accounts = {
      getAccountState: vi.fn(async (accountId: string) => ({
        id: accountId,
        foundersWindow: { startedAt: "2026-07-01T00:00:00.000Z", endsAt: "2026-08-30T00:00:00.000Z" },
      })),
      commandHandler: vi.fn(async ({ command }: { command: { founderNumber: number } }) => {
        assignedNumbers.push(command.founderNumber);
        return { state: {}, version: 1, newEvents: [], storedEvents: [] };
      }),
    };
    const runtime = createFoundersCohortRuntime(
      {
        eventStore,
        db: { query: vi.fn() },
        checkpointStore: {} as never,
      } as never,
      accounts as never,
    );

    const claims = await Promise.all([
      runtime.claimFounderNumber(
        {
          accountId: "acc_one",
          qualifyingActType: "listing-created",
          qualifyingActId: "lst_one",
          claimedAt: "2026-07-12T12:00:00.000Z",
        },
        context,
      ),
      runtime.claimFounderNumber(
        {
          accountId: "acc_two",
          qualifyingActType: "offer-submitted",
          qualifyingActId: "ofr_two",
          claimedAt: "2026-07-12T12:00:00.000Z",
        },
        context,
      ),
    ]);

    expect(claims.map((claim) => claim?.founderNumber).sort()).toEqual([1, 2]);
    expect(assignedNumbers.sort()).toEqual([1, 2]);
  });
});

function concurrencyCheckingEventStore(): EventStore {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  return {
    readStream: async (input: ReadStreamInput) => [...(streams.get(input.streamId) ?? [])],
    readAll: async () => [],
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const currentVersion = existing.length;
      if (input.expectedVersion !== "any" && input.expectedVersion !== currentVersion) {
        throw createEventStoreError("concurrency_conflict", "Expected stream version does not match current version.");
      }
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: currentVersion + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: "2026-07-12T12:00:00.000Z" as never,
          recordedAt: "2026-07-12T12:00:00.000Z" as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
        } satisfies StoredEvent;
      });
      streams.set(input.streamId, [...existing, ...stored]);
      return stored;
    },
  };
}
