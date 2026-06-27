import { describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import { defaultUserPresentationPreferences } from "../domain/domain";
import { createUserPreferencesRuntime } from "./runtime";

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
          traceId: input.context.trace?.traceId,
          spanId: input.context.trace?.spanId,
          parentSpanId: input.context.trace?.parentSpanId,
          traceState: input.context.trace?.traceState,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async (input: ReadStreamInput) => {
      const events = streams.get(input.streamId) ?? [];
      const fromVersion = input.fromVersion ?? 1;
      return events.filter((event) => event.streamVersion >= fromVersion).slice(0, input.limit);
    },
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return eventStore;
}

function createEmptyPreferencesDb(): PgQueryable {
  return {
    async query<Row>(sql: string) {
      if (sql.includes("FROM identity_user_preferences")) {
        return { rows: [] as Row[], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  return {
    loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
    saveCheckpoint: async () => undefined,
  };
}

const context = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_preferences" as never,
    forAccountId: "acc_preferences" as never,
  },
};

describe("user preferences runtime", () => {
  it("serves committed preference aggregate state while the projection is still empty", async () => {
    const runtime = createUserPreferencesRuntime({
      eventStore: createInMemoryEventStore(),
      checkpointStore: createCheckpointStore(),
      db: createEmptyPreferencesDb(),
    });

    await runtime.commandHandler({
      streamId: "identity.user-preferences-usr_preferences",
      command: {
        type: "SetUserPreferences",
        userId: "usr_preferences" as UserId,
        colorMode: "dark",
        reducedMotion: "always",
      },
      context,
    });

    await expect(runtime.getUserPreferences("usr_preferences")).resolves.toEqual({
      userId: "usr_preferences",
      colorMode: "dark",
      density: "comfortable",
      reducedMotion: "always",
      locale: "en",
      timeZone: "UTC",
    });
  });

  it("keeps defaults for users without committed preferences", async () => {
    const runtime = createUserPreferencesRuntime({
      eventStore: createInMemoryEventStore(),
      checkpointStore: createCheckpointStore(),
      db: createEmptyPreferencesDb(),
    });

    await expect(runtime.getUserPreferences("usr_without_preferences")).resolves.toEqual({
      userId: "usr_without_preferences",
      ...defaultUserPresentationPreferences,
    });
  });
});
