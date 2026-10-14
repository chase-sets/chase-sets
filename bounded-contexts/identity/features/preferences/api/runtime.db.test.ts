import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createEventStoreError } from "@chase-sets/event-core/event-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import { defaultUserPresentationPreferences } from "../domain/domain";
import { preferenceWriteAttemptEventType, preferenceWriteIdentity } from "../domain/write-attempt";
import { createUserPreferencesRuntime } from "./runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for preference database tests.");
const userId = "usr_preferences" as UserId;
const context = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: userId, forAccountId: "acc_preferences" as never },
};
const preferenceStream = `identity.user-preferences-${userId}`;
const checkpointStore = { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined };

describe("preference writes on real PostgreSQL", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let store: EventStore;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "identity_preference_writes");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.identity;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(eventCorePostgresSchemaSql);
    store = createPostgresEventStore({ pool });
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  const runtime = (eventStore = store) => createUserPreferencesRuntime({ eventStore, db: pool, checkpointStore });
  const input = (key = "private-opaque-key", changes: unknown = { colorMode: "dark" }) => ({
    userId,
    key,
    changes,
    context,
  });
  const attemptStream = (key = "private-opaque-key") =>
    preferenceWriteIdentity(userId, key, { colorMode: "dark" }).streamId;
  const table = async (...streams: string[]) =>
    Promise.all(
      streams.map(async (streamId) => ({
        streamId,
        events: (await readCompleteStream(store, { streamId })).map(({ streamVersion, eventType }) => ({
          streamVersion,
          eventType,
        })),
      })),
    );

  it("preference-write-atomic-receipt-matrix", async () => {
    const service = runtime();
    const first = await service.writeUserPreferences(input());
    expect(first.receipt).toMatchObject({ outcome: "updated", preferenceVersion: 1 });
    const unchanged = await service.writeUserPreferences(input("no-change"));
    expect(unchanged.receipt).toMatchObject({ outcome: "unchanged", preferenceVersion: 1 });
    const before = await table(preferenceStream, attemptStream(), attemptStream("no-change"));
    expect(before.map((row) => row.events.length)).toEqual([1, 1, 1]);
    // Drop the returned result after the real transaction committed, then retry.
    await expect(
      service.writeUserPreferences(input()).then(() => {
        throw new Error("response lost");
      }),
    ).rejects.toThrow("response lost");
    const replay = await service.writeUserPreferences(input());
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.replayed).toBe(true);
    expect(await table(preferenceStream, attemptStream(), attemptStream("no-change"))).toEqual(before);

    const fresh = await service.writeUserPreferences({
      ...input("default", { colorMode: "system" }),
      userId: "usr_default" as UserId,
    });
    expect(fresh.receipt).toMatchObject({ outcome: "unchanged", preferenceVersion: 0 });
    expect(await readCompleteStream(store, { streamId: "identity.user-preferences-usr_default" })).toEqual([]);

    const dropped: EventStore = {
      ...store,
      appendToStreams: async (inputs) => {
        await store.appendToStreams!(inputs);
        throw new Error("transaction committed; response lost");
      },
    };
    const lostInput = { ...input("response-loss"), userId: "usr_lost" as UserId };
    await expect(runtime(dropped).writeUserPreferences(lostInput)).rejects.toThrow("response lost");
    const lostReplay = await service.writeUserPreferences(lostInput);
    expect(lostReplay).toMatchObject({ replayed: true, receipt: { outcome: "updated", preferenceVersion: 1 } });
    expect(
      (
        await table(
          "identity.user-preferences-usr_lost",
          preferenceWriteIdentity(lostInput.userId, lostInput.key, { colorMode: "dark" }).streamId,
        )
      ).map((row) => row.events.length),
    ).toEqual([1, 1]);

    // Reject the receipt's INSERT inside PostgreSQL, after the business participant.
    await pool.query(`CREATE FUNCTION reject_preference_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type = 'identity.user-preferences.write-attempt-recorded' THEN
        RAISE EXCEPTION 'injected receipt insert failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_preference_receipt BEFORE INSERT ON event_store_events
      FOR EACH ROW EXECUTE FUNCTION reject_preference_receipt();`);
    await expect(service.writeUserPreferences(input("rollback", { density: "compact" }))).rejects.toThrow();
    expect((await table(preferenceStream, attemptStream("rollback"))).map((row) => row.events.length)).toEqual([1, 0]);

    const nonAtomic: EventStore = {
      ...store,
      appendToStreams: async (inputs) => {
        const results = [];
        for (const participant of inputs)
          results.push({ streamId: participant.streamId, storedEvents: await store.appendToStream(participant) });
        return results;
      },
    };
    await expect(
      runtime(nonAtomic).writeUserPreferences(input("non-atomic-mutant", { density: "compact" })),
    ).rejects.toThrow();
    const mutant = await table(preferenceStream, attemptStream("non-atomic-mutant"));
    expect(mutant.map((row) => row.events.length)).toEqual([2, 0]);
    expect(() => expect(mutant.map((row) => row.events.length)).toEqual([1, 0])).toThrow();
  });

  it("preference-write-complete-history-replay", async () => {
    const service = runtime();
    const first = await service.writeUserPreferences(input());
    await store.appendToStream({
      streamId: preferenceStream,
      expectedVersion: 1,
      context,
      events: Array.from({ length: 499 }, () => ({
        eventType: "identity.user-preferences.updated",
        payload: { userId, ...defaultUserPresentationPreferences, colorMode: "dark" },
      })),
    });
    const atBound = await service.writeUserPreferences(input());
    expect(atBound.version).toBe(500);
    expect(atBound.preferences.colorMode).toBe("dark");
    await store.appendToStream({
      streamId: preferenceStream,
      expectedVersion: 500,
      context,
      events: [
        {
          eventType: "identity.user-preferences.updated",
          payload: { userId, ...defaultUserPresentationPreferences, colorMode: "light" },
        },
      ],
    });
    const replay = await service.writeUserPreferences(input());
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.version).toBe(501);
    expect(replay.preferences.colorMode).toBe("light");
    expect((await table(preferenceStream, attemptStream())).map((row) => row.events.length)).toEqual([501, 1]);
    await expect(
      service.writeUserPreferences(input("private-opaque-key", { colorMode: "light" })),
    ).rejects.toMatchObject({ code: "preference_write_conflict" });
    await store.appendToStream({
      streamId: attemptStream(),
      expectedVersion: 1,
      context,
      events: [{ eventType: preferenceWriteAttemptEventType, payload: first.receipt }],
    });
    await expect(service.writeUserPreferences(input())).rejects.toThrow();
  });

  it.each([
    "empty",
    "empty-payload",
    "receipt-only",
    "business-only",
    "user",
    "hash",
    "fingerprint",
    "changes",
    "outcome",
    "version",
    "negative-version",
    "schema",
    "result",
    "unknown",
    "unexpected",
    "unexpected-business",
    "duplicate-business",
  ] as const)("preference-write-complete-history-replay poison %s", async (poison) => {
    const service = runtime();
    const identity = preferenceWriteIdentity(userId, "private-opaque-key", { colorMode: "dark" });
    const preferences = { userId, ...defaultUserPresentationPreferences, colorMode: "dark" };
    const receipt: Record<string, unknown> = {
      schemaVersion: 1,
      userId,
      keyHash: identity.keyHash,
      requestFingerprint: identity.requestFingerprint,
      changes: identity.changes,
      outcome: "updated",
      preferenceVersion: 1,
      preferences,
    };
    if (poison !== "receipt-only" && poison !== "empty")
      await store.appendToStream({
        streamId: preferenceStream,
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "identity.user-preferences.updated",
            payload: preferences,
            metadata: { preferenceWriteKeyHash: identity.keyHash },
          },
        ],
      });
    if (poison === "user") receipt.userId = "usr_other";
    if (poison === "hash") receipt.keyHash = "0".repeat(64);
    if (poison === "fingerprint") receipt.requestFingerprint = `sha256:${"0".repeat(64)}`;
    if (poison === "changes") receipt.changes = { colorMode: { nested: "dark" } };
    if (poison === "outcome") receipt.outcome = "unchanged";
    if (poison === "version") receipt.preferenceVersion = 2;
    if (poison === "negative-version") receipt.preferenceVersion = -1;
    if (poison === "schema") receipt.schemaVersion = 2;
    if (poison === "result") receipt.preferences = { ...preferences, density: "compact" };
    if (poison === "unknown") receipt.cookie = "sensitive";
    if (poison === "unexpected-business" || poison === "duplicate-business")
      await store.appendToStream({
        streamId: preferenceStream,
        expectedVersion: 1,
        context,
        events: [
          {
            eventType: poison === "unexpected-business" ? "unexpected" : "identity.user-preferences.updated",
            payload: preferences,
            metadata: { preferenceWriteKeyHash: identity.keyHash },
          },
        ],
      });
    if (poison !== "business-only")
      await store.appendToStream({
        streamId: attemptStream(),
        expectedVersion: "no_stream",
        context,
        events:
          poison === "empty"
            ? []
            : [
                {
                  eventType: poison === "unexpected" ? "unexpected" : preferenceWriteAttemptEventType,
                  payload: poison === "empty-payload" ? {} : (receipt as never),
                },
              ],
      });
    if (poison === "empty") {
      const result = await service.writeUserPreferences(input());
      expect(result.replayed).toBe(false);
      expect(result.receipt.outcome).toBe("updated");
    } else {
      const before = await table(preferenceStream, attemptStream());
      await expect(service.writeUserPreferences(input())).rejects.toThrow();
      expect(await table(preferenceStream, attemptStream())).toEqual(before);
    }
  });

  it("preference-write-concurrency-barrier", async () => {
    for (const [label, keys, changes, counts] of [
      ["same-exact", ["one", "one"], [{ colorMode: "dark" }, { colorMode: "dark" }], [1, 1, 1]],
      ["same-conflict", ["one", "one"], [{ colorMode: "dark" }, { colorMode: "light" }], [1, 1, 1]],
      ["identical", ["one", "two"], [{ colorMode: "dark" }, { colorMode: "dark" }], [1, 1, 1]],
      ["disjoint", ["one", "two"], [{ colorMode: "dark" }, { density: "compact" }], [2, 1, 1]],
      ["conflicting", ["one", "two"], [{ colorMode: "dark" }, { colorMode: "light" }], [2, 1, 1]],
    ] as const) {
      const scopedUser = `usr_${label}` as UserId;
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const racing: EventStore = {
        ...store,
        appendToStreams: async (inputs) => {
          arrived += 1;
          if (arrived <= 2) {
            if (arrived === 2) release();
            await barrier;
          }
          return store.appendToStreams!(inputs);
        },
      };
      const service = runtime(racing);
      const results = await Promise.allSettled(
        keys.map((key, index) => service.writeUserPreferences({ ...input(key, changes[index]), userId: scopedUser })),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(label === "same-conflict" ? 1 : 2);
      const streams = [
        `identity.user-preferences-${scopedUser}`,
        ...keys.map((key) => preferenceWriteIdentity(scopedUser, key, { colorMode: "dark" }).streamId),
      ];
      expect(
        (await table(...streams)).map((row) => row.events.length),
        label,
      ).toEqual(counts);
      if (label === "disjoint")
        expect(await service.getUserPreferences(scopedUser)).toMatchObject({ colorMode: "dark", density: "compact" });
      if (label === "same-exact")
        expect(results.filter((result) => result.status === "fulfilled" && result.value.replayed)).toHaveLength(1);
    }
    let appends = 0;
    const losing: EventStore = {
      ...store,
      appendToStreams: async (_inputs: readonly AppendToStreamInput[]) => {
        appends += 1;
        if (appends > 2) throw new Error("recursive-retry mutant exceeded the ceiling");
        throw createEventStoreError("concurrency_conflict", "injected version loss");
      },
    };
    await expect(runtime(losing).writeUserPreferences(input("second-loss"))).rejects.toMatchObject({
      code: "preference_write_conflict",
      preferences: { colorMode: "system" },
    });
    expect(appends).toBe(2);
    expect((await table(preferenceStream, attemptStream("second-loss"))).map((row) => row.events.length)).toEqual([
      0, 0,
    ]);
  });
});
