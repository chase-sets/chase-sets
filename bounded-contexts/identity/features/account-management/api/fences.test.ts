import { describe, expect, it, vi } from "vitest";
import { createIdentityMutationPersistence, eligibilityScopeKeys, lockEligibilityScopes } from "./fences";
import type { PgQueryable, PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";

describe("issue-7168-ac11-caller-compatibility", () => {
  it.each(["identity.api-key-key_synthetic9506", "identity.user-preferences-usr_synthetic9506"])(
    "passes through a 10,001-event %s stream without reads or eligibility SQL",
    async (streamId) => {
      const { eventStore } = createInMemoryEventStore();
      const context = {
        tenantId: parseTypedId("tnt_synthetic", "tnt"),
        audit: {
          performedByUserId: parseTypedId("usr_synthetic", "usr"),
          forAccountId: parseTypedId("acc_synthetic", "acc"),
        },
      };
      const eventType = streamId.startsWith("identity.api-key-")
        ? "identity.api-key.used"
        : "identity.user-preferences.updated";
      await eventStore.appendToStream({
        streamId,
        expectedVersion: "no_stream",
        context,
        events: Array.from({ length: 10001 }, () => ({ eventType, payload: {} })),
      });
      const unexpected = vi.fn(async () => {
        throw new Error("unexpected eligibility SQL");
      });
      const read = vi.fn(eventStore.readStream);
      const append = vi.fn(eventStore.appendToStreams!);
      const store: PostgresEventStore = {
        ...eventStore,
        readStream: read,
        appendToStreams: append,
        appendToStreamInTransaction: unexpected,
        appendToStreamsInTransaction: unexpected,
        readStreamInTransaction: unexpected,
      };
      const persistence = createIdentityMutationPersistence({ query: unexpected, connect: unexpected }, store);
      const inputs = [
        {
          streamId,
          expectedVersion: 10001,
          context,
          metadata: { preferenceWriteKeyHash: "synthetic-key-hash" },
          events: [{ eventType, payload: {} }],
        },
      ] as const;
      await persistence.eventStore.appendToStreams!(inputs);
      expect(await eventStore.readStream({ streamId, fromVersion: 10002 })).toHaveLength(1);
      expect(append).toHaveBeenCalledWith(inputs);
      expect(read).not.toHaveBeenCalled();
      expect(unexpected).not.toHaveBeenCalled();
      await expect(persistence.eventStore.appendToStreams!(inputs)).rejects.toMatchObject({
        code: "concurrency_conflict",
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("leaves unrelated capability authority appends on their existing EventStore transaction", async () => {
    const { eventStore } = createInMemoryEventStore();
    const unexpected = vi.fn(async () => {
      throw new Error("unexpected eligibility SQL");
    });
    const pool: PgTransactionalPool = { query: unexpected, connect: unexpected };
    const store: PostgresEventStore = {
      ...eventStore,
      appendToStreamInTransaction: unexpected,
      appendToStreamsInTransaction: unexpected,
      readStreamInTransaction: unexpected,
    };
    const persistence = createIdentityMutationPersistence(pool, store);
    await persistence.eventStore.appendToStream({
      streamId: "identity.account-capability-acc_synthetic",
      expectedVersion: "no_stream",
      context: {
        tenantId: parseTypedId("tnt_synthetic", "tnt"),
        audit: {
          performedByUserId: parseTypedId("usr_synthetic", "usr"),
          forAccountId: parseTypedId("acc_synthetic", "acc"),
        },
      },
      events: [{ eventType: "identity.account-capability.assigned", payload: { capabilityKey: "synthetic" } }],
    });
    expect(await eventStore.readStream({ streamId: "identity.account-capability-acc_synthetic" })).toHaveLength(1);
    expect(unexpected).not.toHaveBeenCalled();
  });
  it("enrolls direct registration, status, membership and Consent writers before stream allocation", () => {
    expect(eligibilityScopeKeys("tnt_test", "identity.account-acc_a", [])).toEqual([
      JSON.stringify(["identity", "tnt_test", "account", "acc_a"]),
    ]);
    expect(
      eligibilityScopeKeys("tnt_test", "identity.membership-mbr_a", [
        { eventType: "identity.membership.granted", payload: { accountId: "acc_a" } },
      ]),
    ).toEqual([JSON.stringify(["identity", "tnt_test", "account", "acc_a"])]);
    const record = {
      eventType: "identity.consent.recorded",
      payload: { subjectType: "user", userId: "usr_a", policyKey: "terms" },
    };
    expect(eligibilityScopeKeys("tnt_test", "identity.consent-cns_a", [record])).toEqual([
      JSON.stringify(["identity", "tnt_test", "consent", "user", "usr_a", "terms"]),
    ]);
    expect(() => eligibilityScopeKeys("tnt_test", "identity.consent-cns_a", [])).toThrow("INDETERMINATE");
  });
  it("sorts and deduplicates scope locks before any stream locks", async () => {
    const calls: string[] = [];
    const db: PgQueryable = {
      query: async (_sql: string, values?: readonly unknown[]) => {
        calls.push(String(values?.[0]));
        return { rows: [] };
      },
    };
    await lockEligibilityScopes(db, ["b", "a", "b"]);
    expect(calls).toEqual(["a", "b"]);
  });
});
