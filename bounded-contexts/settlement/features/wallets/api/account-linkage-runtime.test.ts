import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createAccountLinkageRuntime } from "./account-linkage-runtime";

const operatorContext: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_operator" as never, forAccountId: "acc_operator" as never },
};

function fakeDb(candidateRows: readonly Record<string, unknown>[]) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("WITH eligible")) return { rows: candidateRows, rowCount: candidateRows.length };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PgQueryable;
  return { db, calls };
}

describe("Account Linkage runtime", () => {
  it("fails safe to compiled policy defaults and publishes no raw cluster material", async () => {
    const sourceClusterKey = "provider-instrument-fingerprint-private";
    const { db } = fakeDb([
      {
        signal_kind: "shared-instrument",
        cluster_key: sourceClusterKey,
        account_ids: ["acc_a", "acc_b"],
      },
    ]);
    const store = createInMemoryEventStore();
    const runtime = createAccountLinkageRuntime({
      eventStore: store.eventStore,
      db,
      policies: { resolvePolicy: async () => Promise.reject(new Error("policy store unavailable")) },
    });

    await expect(runtime.runAccountLinkageCloser()).resolves.toEqual({
      clustersConsidered: 1,
      flagsPublished: 1,
      unchanged: 0,
    });
    const published = store.readAllEvents()[0]!;
    expect(published.eventType).toBe("settlement.account-linkage.flagged");
    expect(Object.keys(published.payload).sort()).toEqual(["accountIds", "clusterHash", "signalKind"]);
    expect(JSON.stringify(published.payload)).not.toContain(sourceClusterKey);
    expect(published.streamId).toMatch(/^settlement\.account-linkage-[a-f0-9]{64}$/);
  });

  it("threads the resolved threshold and per-signal enablement into the closer query", async () => {
    const { db, calls } = fakeDb([]);
    const runtime = createAccountLinkageRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      db,
      policies: {
        resolvePolicy: async () => ({
          value: { minimumClusterSize: 3, sharedInstrumentEnabled: false, sharedAddressEnabled: true },
        }),
      },
    });

    await runtime.runAccountLinkageCloser();
    const candidateQuery = calls.find((call) => call.sql.includes("WITH eligible"))!;
    expect(candidateQuery.params[0]).toBe(3);
    expect(candidateQuery.sql).toContain("settlement_account_address_risk_sources");
    expect(candidateQuery.sql).not.toContain("settlement_account_instrument_risk_sources");
  });

  it("exposes the authoritative clear command and reuses aggregate idempotency", async () => {
    const { db } = fakeDb([
      {
        signal_kind: "shared-address",
        cluster_key: "normalized-address-private",
        account_ids: ["acc_a", "acc_b"],
      },
    ]);
    const store = createInMemoryEventStore();
    const runtime = createAccountLinkageRuntime({
      eventStore: store.eventStore,
      db,
      policies: {
        resolvePolicy: async (definition) => ({ value: definition.defaultValue }),
      },
    });
    await runtime.runAccountLinkageCloser();
    const clusterHash = String(store.readAllEvents()[0]!.payload.clusterHash);

    await expect(runtime.clearAccountLinkage(clusterHash, operatorContext)).resolves.toBe("cleared");
    await expect(runtime.clearAccountLinkage(clusterHash, operatorContext)).resolves.toBe("noop");
    expect(store.readAllEvents().map((event) => event.eventType)).toEqual([
      "settlement.account-linkage.flagged",
      "settlement.account-linkage.cleared",
    ]);
  });
});
