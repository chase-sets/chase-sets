import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresEventStore,
  type PgTransactionalPool,
  type PgQueryResult,
} from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createInventoryMutationRuntime,
  withInventoryMutationAttempt,
  withInventoryMutationChildAttempt,
  withInventoryMutationTargetAccount,
} from "../support/runtime-support/mutation-attempt";
import {
  inventoryMutationFingerprint,
  normalizeInventoryMutationIntent,
} from "../support/runtime-support/mutation-intent";

const context: EventStoreContext = {
  tenantId: "tnt_synthetic",
  audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
};
const location = {
  accountId: "acc_synthetic",
  name: " Synthetic ",
  shipFromCode: " TEST ",
  shipFromAddress: {
    name: "Synthetic",
    line1: "1 Test",
    city: "Test",
    state: "IL",
    postalCode: "60000",
    country: "us",
  },
};

function harness() {
  const rows = new Map<string, Record<string, unknown>>();
  const committedFacts: string[] = [];
  let owner: { rows: Map<string, Record<string, unknown>>; facts: string[] } | null = null;
  const snapshots = new Map<string, { rows: Map<string, Record<string, unknown>>; facts: string[] }>();
  const query = vi.fn(
    async <Row = Record<string, unknown>>(
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<PgQueryResult<Row>> => {
      if (sql === "BEGIN") owner = { rows: structuredClone(rows), facts: [...committedFacts] };
      else if (sql === "COMMIT") {
        rows.clear();
        for (const [key, value] of owner!.rows) rows.set(key, value);
        committedFacts.splice(0, committedFacts.length, ...owner!.facts);
        owner = null;
      } else if (sql === "ROLLBACK") owner = null;
      else if (sql.startsWith("SAVEPOINT ")) snapshots.set(sql.slice(10), structuredClone(owner!));
      else if (sql.startsWith("ROLLBACK TO SAVEPOINT ")) owner = structuredClone(snapshots.get(sql.slice(22))!);
      else if (sql.startsWith("RELEASE SAVEPOINT ")) snapshots.delete(sql.slice(18));
      else if (sql.startsWith("SELECT * FROM inventory_mutation_attempts")) {
        const row = (owner?.rows ?? rows).get(String(values[0]));
        const visible =
          row &&
          (values.length === 1 ||
            (row.tenant_id === values[1] &&
              row.actor_user_id === values[2] &&
              (row.requesting_account_id ?? row.account_id) === values[3]));
        return { rows: visible ? [structuredClone(row) as Row] : [] };
      } else if (sql.includes("INSERT INTO inventory_mutation_attempts")) {
        owner!.rows.set(String(values[0]), {
          tenant_id: values[1],
          actor_user_id: values[2],
          account_id: values[3],
          requesting_account_id: values[7],
          family: values[4],
          target_id: values[5],
          fingerprint_version: 1,
          intent_hash: values[6],
          receipt_version: 1,
          status: "accepted",
          result: null,
          result_hash: null,
        });
      } else if (sql.includes("UPDATE inventory_mutation_attempts")) {
        const row = owner!.rows.get(String(values[0]))!;
        Object.assign(row, {
          status: "succeeded",
          result: JSON.parse(String(values[7])),
          result_hash: values[8],
          completed_at: "2026-10-13T00:00:00Z",
        });
        return { rows: [{ attempt_key: values[0] } as Row] };
      } else if (sql === "SYNTHETIC FACT") owner!.facts.push(String(values[0]));
      return { rows: [] };
    },
  );
  const invoke = async <Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<Row>> => (await query(sql, values)) as PgQueryResult<Row>;
  const pool: PgTransactionalPool = { query: invoke, connect: async () => ({ query: invoke, release: vi.fn() }) };
  const runtime = createInventoryMutationRuntime(pool, createPostgresEventStore({ pool }));
  return { runtime, rows, committedFacts, query };
}

describe("issue-7169-ac2-single-target-replay: owner transaction", () => {
  it("retains the exact JSON result when a trusted PostgreSQL reader supplies a Date", async () => {
    const { runtime } = harness();
    const id = randomUUID();
    const attempted = withInventoryMutationAttempt(context, id);
    const work = vi.fn(async () => ({ expiresAt: new Date("2026-10-13T12:00:00Z") }));
    const first = await runtime.execute("location-create", "draft", "acc_synthetic", location, attempted, work);
    expect(first).toEqual({ expiresAt: "2026-10-13T12:00:00.000Z" });
    expect(await runtime.execute("location-create", "draft", "acc_synthetic", location, attempted, work)).toEqual(
      first,
    );
    expect(await runtime.read(id, context)).toMatchObject({ result: first });
    expect(work).toHaveBeenCalledTimes(1);
  });
  it("replays normalized intent with immutable first result and no second fact", async () => {
    const { runtime, rows, committedFacts } = harness();
    const attempted = withInventoryMutationAttempt(context, randomUUID());
    const work = vi.fn(async () => {
      await runtime.db.query("SYNTHETIC FACT", ["created"]);
      return { storageLocationId: "loc_synthetic", version: 1 };
    });
    const first = await runtime.execute("location-create", "draft", "acc_synthetic", location, attempted, work);
    const replay = await runtime.execute(
      "location-create",
      "draft",
      "acc_synthetic",
      { ...location, name: "Synthetic", description: null },
      attempted,
      work,
    );
    expect(replay).toEqual(first);
    expect(work).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
    expect(committedFacts).toEqual(["created"]);
  });

  it.each(["acceptance", "fact", "receipt"])("atomically rolls back after %s", async (phase) => {
    const { runtime, rows, committedFacts, query } = harness();
    const original = query.getMockImplementation()!;
    let fault = false;
    query.mockImplementation(async (sql, values) => {
      const result = await original(sql, values);
      if (
        !fault &&
        ((phase === "acceptance" && sql.includes("INSERT INTO inventory_mutation_attempts")) ||
          (phase === "fact" && sql === "SYNTHETIC FACT") ||
          (phase === "receipt" && sql.includes("UPDATE inventory_mutation_attempts")))
      ) {
        fault = true;
        throw new Error("Synthetic kill");
      }
      return result;
    });
    await expect(
      runtime.execute(
        "location-create",
        "draft",
        "acc_synthetic",
        location,
        withInventoryMutationAttempt(context, randomUUID()),
        async () => {
          await runtime.db.query("SYNTHETIC FACT", ["created"]);
          return { version: 1 };
        },
      ),
    ).rejects.toThrow("Synthetic kill");
    expect(rows.size).toBe(0);
    expect(committedFacts).toEqual([]);
  });

  it("persists every nested receipt and rejects mismatched reuse without leaking or committing an outer receipt", async () => {
    const { runtime, rows } = harness();
    const attempted = withInventoryMutationAttempt(context, randomUUID());
    const child = withInventoryMutationChildAttempt(attempted, "location");
    const ensure = { accountId: "acc_synthetic", catalogItemId: "cat_synthetic", selectedOptions: [], quantity: 1 };
    await runtime.execute("listing-stock-ensure", "draft", "acc_synthetic", ensure, attempted, () =>
      runtime.execute("location-create", "draft", "acc_synthetic", location, child, async () => ({ version: 1 })),
    );
    expect(rows.size).toBe(2);
    await expect(
      runtime.execute(
        "listing-stock-ensure",
        "other",
        "acc_synthetic",
        ensure,
        withInventoryMutationChildAttempt(attempted, "another"),
        () =>
          runtime.execute(
            "location-create",
            "draft",
            "acc_synthetic",
            { ...location, name: "Changed" },
            child,
            async () => ({ version: 2 }),
          ),
      ),
    ).rejects.toThrow("conflicts");
    expect(rows.size).toBe(2);
  });

  it("requires a distinct nested identity instead of treating ambient transaction presence as acceptance", async () => {
    const { runtime } = harness();
    const attempted = withInventoryMutationAttempt(context, randomUUID());
    await expect(
      runtime.execute("location-create", "draft", "acc_synthetic", location, attempted, () =>
        runtime.execute("location-create", "draft", "acc_synthetic", location, attempted, async () => ({})),
      ),
    ).rejects.toThrow("distinct nested");
  });

  it("keeps exact reads private and detects corrupt receipts", async () => {
    const { runtime, rows } = harness();
    const id = randomUUID();
    await runtime.execute(
      "location-create",
      "draft",
      "acc_synthetic",
      location,
      withInventoryMutationAttempt(context, id),
      async () => ({ version: 1 }),
    );
    expect(
      await runtime.read(id, { ...context, audit: { ...context.audit, performedByUserId: "usr_other" } }),
    ).toBeNull();
    rows.values().next().value!.result = { version: 99 };
    await expect(runtime.read(id, context)).rejects.toThrow("reconciliation");
  });
  it("binds a trusted seller-targeted result privately to the initiating buyer account", async () => {
    const { runtime } = harness();
    const id = randomUUID();
    const buyer: EventStoreContext = { ...context, audit: { ...context.audit, forAccountId: "acc_buyer" } };
    const trusted = withInventoryMutationAttempt(withInventoryMutationTargetAccount(buyer, "acc_synthetic"), id);
    await runtime.execute("location-create", "draft", "acc_synthetic", location, trusted, async () => ({ version: 1 }));
    expect(await runtime.read(id, buyer)).toMatchObject({ result: { version: 1 } });
    expect(await runtime.read(id, context)).toBeNull();
    await expect(
      runtime.execute(
        "location-create",
        "draft",
        "acc_synthetic",
        location,
        withInventoryMutationAttempt(context, id),
        async () => ({ version: 2 }),
      ),
    ).rejects.toThrow("not authorized");
  });

  it("raw-params-hash mutant changes normalized defaults but canonical object order does not", () => {
    const normalized = normalizeInventoryMutationIntent("location-create", location);
    const reordered = {
      shipFromCode: location.shipFromCode,
      name: location.name,
      shipFromAddress: location.shipFromAddress,
      accountId: location.accountId,
    };
    expect(inventoryMutationFingerprint(normalized)).toBe(
      inventoryMutationFingerprint(normalizeInventoryMutationIntent("location-create", reordered)),
    );
    expect(inventoryMutationFingerprint(normalized)).not.toBe(inventoryMutationFingerprint(location));
  });
});
