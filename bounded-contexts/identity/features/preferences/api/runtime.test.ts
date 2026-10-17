import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
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
import { preferenceWriteAttemptEventType, preferenceWriteIdentity } from "../domain/write-attempt";
import { createEventStoreError } from "@chase-sets/event-core/event-store";
import { createUserPreferencesRuntime } from "./runtime";

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
  it("preference-write-closed-request-contract canonical supplied-field fingerprint", async () => {
    const eventStore = createInMemoryEventStore().eventStore;
    const runtime = createUserPreferencesRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createEmptyPreferencesDb(),
    });
    const input = {
      userId: "usr_preferences" as UserId,
      key: "canonical",
      changes: { timeZone: " UTC ", locale: " en-us ", colorMode: "dark" },
      context,
    };
    const first = await runtime.writeUserPreferences(input);
    const replay = await runtime.writeUserPreferences({
      ...input,
      changes: { colorMode: "dark", locale: "en-US", timeZone: "UTC" },
    });
    expect(first.receipt.changes).toEqual({ colorMode: "dark", locale: "en-US", timeZone: "UTC" });
    expect(first.receipt.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.replayed).toBe(true);
    expect(await eventStore.readAll()).toHaveLength(2);
  });
  it("preference-write-user-isolation", async () => {
    const eventStore = createInMemoryEventStore().eventStore;
    const runtime = createUserPreferencesRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createEmptyPreferencesDb(),
    });
    const input = {
      userId: "usr_preferences" as UserId,
      key: "secret-opaque-case-A",
      changes: { colorMode: "dark" },
      context,
    };
    const first = await runtime.writeUserPreferences(input);
    const other = await runtime.writeUserPreferences({
      ...input,
      userId: "usr_other" as UserId,
      changes: { density: "compact" },
    });
    expect(first.receipt.userId).toBe(input.userId);
    expect(other.receipt.userId).toBe("usr_other");
    expect(other.preferences).toMatchObject({ colorMode: "system", density: "compact" });
    await expect(runtime.getUserPreferences(input.userId)).resolves.toMatchObject({
      colorMode: "dark",
      density: "comfortable",
    });
    const all = await eventStore.readAll();
    expect(new Set(all.map((event) => event.streamId)).size).toBe(4);
    expect(all.filter((event) => event.eventType.endsWith("write-attempt-recorded"))).toHaveLength(2);
    const serialized = JSON.stringify({
      response: first,
      other,
      events: all.map((event) => ({ stream: event.streamId, payload: event.payload })),
    });
    for (const forbidden of [input.key, "ses_private", "Cookie", "authorization", "acc_preferences"])
      expect(serialized).not.toContain(forbidden);
    const poisonKey = "poison-other";
    const otherIdentity = preferenceWriteIdentity("usr_other" as UserId, poisonKey, { colorMode: "dark" });
    await eventStore.appendToStream({
      streamId: otherIdentity.streamId,
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: preferenceWriteAttemptEventType, payload: first.receipt }],
    });
    await expect(
      runtime.writeUserPreferences({ ...input, userId: "usr_other" as UserId, key: poisonKey }),
    ).rejects.toThrow();
    const ownReplay = await runtime.writeUserPreferences(input);
    expect(ownReplay.receipt).toEqual(first.receipt);
    expect(ownReplay.preferences.colorMode).toBe("dark");
    const caseDistinct = await runtime.writeUserPreferences({ ...input, key: input.key.toLowerCase() });
    expect(caseDistinct.replayed).toBe(false);
    expect(caseDistinct.receipt.keyHash).not.toBe(first.receipt.keyHash);
  });
  it("preference-write-concurrency-barrier second loss has a two-append ceiling", async () => {
    const base = createInMemoryEventStore().eventStore;
    let appends = 0;
    const eventStore: EventStore = {
      ...base,
      appendToStreams: async () => {
        appends += 1;
        throw createEventStoreError("concurrency_conflict", "injected loss");
      },
    };
    const runtime = createUserPreferencesRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createEmptyPreferencesDb(),
    });
    await expect(
      runtime.writeUserPreferences({
        userId: "usr_preferences" as UserId,
        key: "losing",
        changes: { colorMode: "dark" },
        context,
      }),
    ).rejects.toMatchObject({ code: "preference_write_conflict" });
    expect(appends).toBe(2);
    expect(await base.readAll()).toEqual([]);
  });
  it("preference-write-concurrency-barrier same-key commit between evidence reads", async () => {
    const base = createInMemoryEventStore().eventStore;
    const deps = { eventStore: base, checkpointStore: createCheckpointStore(), db: createEmptyPreferencesDb() };
    const input = {
      userId: "usr_preferences" as UserId,
      key: "between-reads",
      changes: { colorMode: "dark" },
      context,
    };
    let interrupted = false;
    let appends = 0;
    const racing: EventStore = {
      ...base,
      readStream: async (read) => {
        const result = await base.readStream(read);
        if (!interrupted && read.streamId.includes("write-attempt")) {
          interrupted = true;
          await createUserPreferencesRuntime(deps).writeUserPreferences(input);
        }
        return result;
      },
      appendToStreams: async (writes) => {
        appends += 1;
        return base.appendToStreams!(writes);
      },
    };
    const result = await createUserPreferencesRuntime({ ...deps, eventStore: racing }).writeUserPreferences(input);
    expect(result.replayed).toBe(true);
    expect(appends).toBe(0);
    expect(await base.readAll()).toHaveLength(2);
  });
  it("preference-write-atomic-receipt-matrix", async () => {
    const eventStore = createInMemoryEventStore().eventStore;
    const runtime = createUserPreferencesRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createEmptyPreferencesDb(),
    });
    const input = { userId: "usr_preferences" as UserId, key: "opaque-1", changes: { colorMode: "system" }, context };
    const first = await runtime.writeUserPreferences(input);
    expect(first.receipt.outcome).toBe("unchanged");
    expect(first.receipt.preferenceVersion).toBe(0);
    expect(await eventStore.readStream({ streamId: "identity.user-preferences-usr_preferences" })).toEqual([]);
    const replay = await runtime.writeUserPreferences(input);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.replayed).toBe(true);
    expect(await eventStore.readAll()).toHaveLength(1);
  });
  it("preference-write-complete-history-replay", async () => {
    const eventStore = createInMemoryEventStore().eventStore;
    const runtime = createUserPreferencesRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createEmptyPreferencesDb(),
    });
    const input = { userId: "usr_preferences" as UserId, key: "opaque-1", changes: { colorMode: "dark" }, context };
    const first = await runtime.writeUserPreferences(input);
    await runtime.writeUserPreferences({ ...input, key: "opaque-2", changes: { colorMode: "light" } });
    const replay = await runtime.writeUserPreferences(input);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.preferences.colorMode).toBe("light");
    await expect(runtime.writeUserPreferences({ ...input, changes: { colorMode: "light" } })).rejects.toMatchObject({
      code: "preference_write_conflict",
    });
    expect(await eventStore.readAll()).toHaveLength(4);
  });
  it("serves committed preference aggregate state while the projection is still empty", async () => {
    const runtime = createUserPreferencesRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      checkpointStore: createCheckpointStore(),
      db: createEmptyPreferencesDb(),
    });

    await runtime.writeUserPreferences({
      userId: "usr_preferences" as UserId,
      key: "first",
      changes: {
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
      eventStore: createInMemoryEventStore().eventStore,
      checkpointStore: createCheckpointStore(),
      db: createEmptyPreferencesDb(),
    });

    await expect(runtime.getUserPreferences("usr_without_preferences")).resolves.toEqual({
      userId: "usr_without_preferences",
      ...defaultUserPresentationPreferences,
    });
  });
});
