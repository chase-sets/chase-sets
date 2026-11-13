import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ConfigurationEpochGrant } from "@chase-sets/event-core/configuration-epoch";
import {
  CONFIGURATION_EPOCH_LOCK_SQL,
  createPostgresConfigurationEpochStore,
  lockConfigurationGrantVectorInTransaction,
  validateConfigurationGrantVectorInTransaction,
} from "./configuration-epoch";
import type { PgQueryable } from "./types";

const grant: ConfigurationEpochGrant = {
  key: "owner/key",
  sourceIncarnation: "source-1",
  keyCreationEpoch: 3,
  epoch: 3,
  consumer: { storeId: "consumer", incarnation: "consumer-1" },
  topologyRevision: 1,
};
const empty = {
  isolation: "read committed",
  held: true,
  identities: [{ store_id: "consumer", incarnation: "consumer-1" }],
  heads: [],
  records: [],
  now: "2026-01-01T00:00:00Z",
};

describe("consumer-local configuration validation read envelope", () => {
  it("validates the maximum 32-key vector in one read per key", async () => {
    const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [empty] });
    const grants = Array.from({ length: 32 }, (_, index) => ({ ...grant, key: `owner/${index}` }));
    await validateConfigurationGrantVectorInTransaction({ query }, grants);
    expect(query).toHaveBeenCalledTimes(32);
    expect(query.mock.calls.every(([, values]) => values?.length === 1)).toBe(true);
  });

  it.each([
    ["missing lock", { held: false }, "held guard lock"],
    ["old snapshot", { isolation: "repeatable read" }, "READ COMMITTED"],
    ["old incarnation", { identities: [{ store_id: "consumer", incarnation: "old" }] }, "incarnation"],
    ["missing identity", { identities: [] }, "incarnation"],
    ["partial history", { heads: [{ sequence: "1", digest: "bad" }] }, "partial journal"],
    ["invalid clock", { now: "invalid" }, "clock"],
  ])("refuses %s in the same consumer-local read", async (_name, state, message) => {
    const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [{ ...empty, ...state }] });
    await expect(validateConfigurationGrantVectorInTransaction({ query }, [grant])).rejects.toThrow(message);
    expect(query).toHaveBeenCalledOnce();
  });

  it("replays the canonical closed-through journal instead of admitting an old epoch", async () => {
    const record = {
      kind: "CLOSED_THROUGH",
      guard: { sourceIncarnation: "source-1", keyCreationEpoch: 3, closedThroughEpoch: 3, topologyRevision: 1 },
    };
    const digest = createHash("sha256").update("0".repeat(64)).update(JSON.stringify(record)).digest("hex");
    const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({
      rows: [{ ...empty, heads: [{ sequence: "1", digest }], records: [{ sequence: "1", digest, record }] }],
    });
    await expect(validateConfigurationGrantVectorInTransaction({ query }, [grant])).rejects.toThrow("closed-through");
    await expect(
      validateConfigurationGrantVectorInTransaction({ query }, [{ ...grant, epoch: 4 }]),
    ).resolves.toBeUndefined();
  });
});

const EXCLUSIVE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('configuration_epoch:' || $1::text, 0))";
const JOURNAL_READ = "FROM event_configuration_journal_heads";

/** One recorded client per pool; a SELECT answers with its table's rows, every other statement with none. */
function fakePool(tables: Readonly<Record<string, readonly Record<string, unknown>[]>>) {
  const query = vi.fn<PgQueryable["query"]>().mockImplementation(async (sql) => ({
    rows: [...(Object.entries(tables).find(([table]) => sql.includes(`FROM ${table}`))?.[1] ?? [])],
  }));
  return { query, connect: async () => ({ query, release: () => undefined }) };
}

describe("configuration-epoch lock order", () => {
  it("closes a consumer under its key's EXCLUSIVE lock before reading the consumer journal", async () => {
    const records = [
      { kind: "CREATED", sourceIncarnation: grant.sourceIncarnation, keyCreationEpoch: grant.keyCreationEpoch },
      { kind: "REGISTERED", consumer: grant.consumer },
    ];
    let digest = "0".repeat(64);
    const history = records.map((record, index) => {
      digest = createHash("sha256").update(digest).update(JSON.stringify(record)).digest("hex");
      return { sequence: String(index + 1), record, digest };
    });
    const owner = fakePool({
      event_configuration_journal_heads: [{ sequence: String(history.length), digest }],
      event_configuration_guard_history: history,
    });
    const consumer = fakePool({ event_configuration_store_identity: empty.identities });
    const store = createPostgresConfigurationEpochStore({
      pool: owner,
      sourceIncarnation: grant.sourceIncarnation,
      consumers: [{ identity: grant.consumer, pool: consumer }],
    });
    await store.retireConsumer(grant.key, grant.consumer);
    expect(
      consumer.query.mock.calls.filter(([sql]) => sql === EXCLUSIVE_LOCK_SQL || sql.includes(JOURNAL_READ)),
    ).toEqual([
      [EXCLUSIVE_LOCK_SQL, [grant.key]],
      [expect.stringContaining(JOURNAL_READ), ["consumer", grant.key]],
    ]);
  });

  it("locks each grant key once, in contract order, before any validation read", async () => {
    const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [empty] });
    const grants = Array.from({ length: 32 }, (_, index) => ({ ...grant, key: `owner/${31 - index}` }));
    await lockConfigurationGrantVectorInTransaction({ query }, grants);
    await validateConfigurationGrantVectorInTransaction({ query }, grants);
    const contractOrder = grants.map(({ key }) => key).sort();
    expect(
      query.mock.calls.filter(([sql]) => sql === CONFIGURATION_EPOCH_LOCK_SQL || sql.includes("FROM pg_locks")),
    ).toEqual([
      ...contractOrder.map((key) => [CONFIGURATION_EPOCH_LOCK_SQL, [key]]),
      ...contractOrder.map((key) => [expect.stringContaining("FROM pg_locks"), [key]]),
    ]);
  });
});
