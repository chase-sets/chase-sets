import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createEventStoreError } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createSavedListRuntime } from "./runtime";
import { createSavedListRecoveryRuntime } from "./recovery-runtime";
import { savedListCanonicalProduct, savedListFingerprint } from "./anonymous-owner";
import type { SavedListProductSelection } from "../domain/contracts";

const probeContext: EventStoreContext = {
  tenantId: "tnt_probe" as never,
  audit: { performedByUserId: "usr_probe" as never, forAccountId: "acc_probe" as never },
};
const probeProduct: SavedListProductSelection = {
  catalogItemId: "cat_probe" as never,
  productId: "cat_probe::condition:near-mint" as never,
  selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
};
const probeDraft = { product: probeProduct, trackedQuantity: 1, sourceSurface: "search" as const };

function operationRow(status: string, extra: Record<string, unknown> = {}) {
  const request = {
    ...probeDraft,
    destination: { kind: "existing" as const, listId: "svl_probe" },
    addCommandId: "slc_probe_add",
    lineId: "sll_probe",
  };
  return {
    operation_id: "slo_probe",
    account_id: probeContext.audit.forAccountId,
    revision: 2,
    send_revision: status === "possible-send" ? 2 : null,
    status,
    draft: probeDraft,
    request,
    fingerprint: savedListFingerprint([
      "collections.addition.v1",
      probeContext.audit.forAccountId,
      "slo_probe",
      ["existing", "svl_probe"],
      savedListCanonicalProduct(probeProduct),
      1,
      "search",
      "slc_probe_add",
      "sll_probe",
    ]),
    rejection_code: null,
    add_command_id: "slc_probe_add",
    line_id: "sll_probe",
    intent_id: null,
    intent_revision: null,
    created_at: "2026-09-01T00:00:00.000Z",
    terminal_at: null,
    expires_at: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

// Adapted from the independent review's F1/F1b/F2/F3 probes.
async function expiryHarness(row: ReturnType<typeof operationRow>, foreign = false) {
  const memory = createInMemoryEventStore();
  const owner = foreign
    ? { ...probeContext, audit: { ...probeContext.audit, forAccountId: "acc_other" as never } }
    : probeContext;
  const productCatalog = {
    resolveProduct: vi.fn(async (selection: SavedListProductSelection) => ({
      availability: "active" as const,
      product: selection,
    })),
  };
  await createSavedListRuntime({ eventStore: memory.eventStore, productCatalog }).createSavedList(
    {
      commandId: "slc_probe_create" as never,
      listId: "svl_probe" as never,
      ownerAccountId: owner.audit.forAccountId,
      title: "Probe",
    },
    owner,
  );
  let retained = true;
  const inserts = vi.fn();
  const query = vi.fn<PgTransactionalPool["query"]>(async <Row>(sql: string) => {
    if (sql.includes("FROM collections_anonymous_owner_activation"))
      return {
        rows: [
          { singleton: true, activated_at: "2026-10-12T00:00:00.000Z", gate_packet_sha256: "a", floor_commit: "f" },
        ] as unknown as Row[],
      };
    if (/^\s*INSERT INTO collections_saved_list_operations/.test(sql)) {
      inserts();
      return { rows: [operationRow("prepared", { operation_id: "slo_new" })] as unknown as Row[] };
    }
    if (sql.includes("count(*)")) return { rows: [{ count: "1" }] as unknown as Row[] };
    if (sql.includes("FROM collections_saved_list_operations"))
      return { rows: (retained ? [row] : []) as unknown as Row[] };
    return { rows: [] as Row[], rowCount: 0 };
  });
  const pool: PgTransactionalPool = { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) };
  const append = vi.fn(async (_db: unknown, input: Parameters<typeof memory.eventStore.appendToStream>[0]) =>
    memory.eventStore.appendToStream(input),
  );
  const service = createSavedListRecoveryRuntime({
    pool,
    eventStore: {
      ...createPostgresEventStore({ pool }),
      appendToStreamInTransaction: append,
      readStreamInTransaction: async (_db: unknown, input: Parameters<typeof memory.eventStore.readStream>[0]) =>
        memory.eventStore.readStream(input),
    },
    productCatalog,
    clock: () => new Date("2026-10-13T00:00:00.000Z"),
  });
  return {
    service,
    inserts,
    append,
    query,
    productCatalog,
    purge: () => {
      retained = false;
    },
  };
}

describe("retained-recovery-expiry-fence regression proofs", () => {
  it("recovery factory accepts no enablement option", () => {
    expectTypeOf<Parameters<typeof createSavedListRecoveryRuntime>[0]>().not.toHaveProperty("enabled");
  });
  it.each(["foreign receipt", "intent revision drift", "receipt fingerprint"])(
    "F1 isolates %s without blocking prepare or touching the poisoned row",
    async (poison) => {
      const row = operationRow(
        "possible-send",
        poison === "intent revision drift"
          ? { intent_id: "sli_probe", intent_revision: 3 }
          : poison === "receipt fingerprint"
            ? { fingerprint: "forged" }
            : {},
      );
      const before = structuredClone(row);
      const { service, inserts, append, query } = await expiryHarness(row, poison === "foreign receipt");
      await expect(service.prepare(probeDraft, probeContext)).resolves.toMatchObject({ operationId: "slo_new" });
      expect(inserts).toHaveBeenCalledTimes(1);
      expect(append).not.toHaveBeenCalled();
      expect(row).toEqual(before);
      expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK TO SAVEPOINT expire_operation")).toBe(true);
      expect(query.mock.calls.some(([sql]) => /^\s*(UPDATE|DELETE)/.test(sql))).toBe(false);
    },
  );

  it("F1 rethrows infrastructure failure and does not insert", async () => {
    const { service, inserts, query } = await expiryHarness(operationRow("confirmed"));
    const failure = new Error("synthetic-database-outage");
    const normal = query.getMockImplementation()!;
    query.mockImplementation(async (sql) => {
      if (/^\s*UPDATE collections_saved_list_operations/.test(sql)) throw failure;
      return normal(sql);
    });
    await expect(service.prepare(probeDraft, probeContext)).rejects.toBe(failure);
    expect(inserts).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK TO SAVEPOINT expire_operation")).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
  });

  it.each(["prepared", "confirmed"])(
    "F1 confirmation rejects foreign %s destinations transaction-locally",
    async (status) => {
      const { service, append, query, productCatalog } = await expiryHarness(
        operationRow(
          status,
          status === "prepared" ? { request: null, fingerprint: null, expires_at: "2026-11-01T00:00:00.000Z" } : {},
        ),
        true,
      );
      await expect(
        service.confirm(
          { operationId: "slo_probe", revision: 2, destination: { kind: "existing", listId: "svl_probe" as never } },
          probeContext,
        ),
      ).rejects.toMatchObject({ name: "SavedListAuthorizationError" });
      expect(append).not.toHaveBeenCalled();
      expect(productCatalog.resolveProduct).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => /^\s*UPDATE/.test(sql))).toBe(false);
    },
  );

  it("F2 elapsed possible-send apply without sweep refuses before any append", async () => {
    const { service, append } = await expiryHarness(operationRow("possible-send"));
    await expect(service.apply({ operationId: "slo_probe", revision: 2 }, probeContext)).rejects.toMatchObject({
      code: "expired",
    });
    expect(append).not.toHaveBeenCalled();
  });

  it("F2 purged unelapsed operation is refused by the in-lock re-read alone", async () => {
    const { service, append, productCatalog, purge } = await expiryHarness(
      operationRow("possible-send", { expires_at: "2026-11-01T00:00:00.000Z" }),
    );
    productCatalog.resolveProduct.mockImplementation(async (selection) => {
      purge();
      return { availability: "active", product: selection };
    });
    await expect(service.apply({ operationId: "slo_probe", revision: 2 }, probeContext)).rejects.toMatchObject({
      code: "not-found",
    });
    expect(append).not.toHaveBeenCalled();
  });

  it.each(["prepared", "confirmed"])("F3 elapsed %s reads expire without writes or catalog calls", async (status) => {
    const row = operationRow(status, status === "prepared" ? { request: null, fingerprint: null } : {});
    const { service, query, productCatalog } = await expiryHarness(row);
    expect(await service.get("slo_probe", probeContext)).toMatchObject({ status: "expired", lineResults: [] });
    expect((await service.list({}, probeContext)).items[0]).toMatchObject({ status: "expired", lineResults: [] });
    expect(query.mock.calls.some(([sql]) => /^\s*(UPDATE|INSERT|DELETE)/.test(sql))).toBe(false);
    expect(productCatalog.resolveProduct).not.toHaveBeenCalled();
    expect(row.status).toBe(status);
    if (status === "confirmed")
      await expect(service.beginSend({ operationId: "slo_probe", revision: 2 }, probeContext)).rejects.toMatchObject({
        code: "expired",
      });
  });

  it("F3 elapsed possible-send stays unknown without receipt proof", async () => {
    const { service, append } = await expiryHarness(operationRow("possible-send"));
    expect(await service.get("slo_probe", probeContext)).toMatchObject({
      status: "unknown",
      lineResults: [{ status: "unknown" }],
    });
    expect((await service.list({}, probeContext)).items[0]?.status).toBe("unknown");
    expect(append).not.toHaveBeenCalled();
  });
});

describe("saved-list-per-line-recovery rollback admission", () => {
  it.each([false, true])("retries only after a proven rollback (rollback succeeds=%s)", async (rollbackSucceeds) => {
    const context: EventStoreContext = {
      tenantId: "tnt_rollback" as never,
      audit: { performedByUserId: "usr_rollback" as never, forAccountId: "acc_rollback" as never },
    };
    const product: SavedListProductSelection = {
      catalogItemId: "cat_rollback" as never,
      productId: "cat_rollback::condition:near-mint" as never,
      selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
    };
    const productCatalog = {
      resolveProduct: vi.fn(async (selection: SavedListProductSelection) => ({
        availability: "active" as const,
        product: selection,
      })),
    };
    const memory = createInMemoryEventStore();
    await createSavedListRuntime({ eventStore: memory.eventStore, productCatalog }).createSavedList(
      {
        commandId: "slc_create_rollback" as never,
        listId: "svl_rollback" as never,
        ownerAccountId: context.audit.forAccountId,
        title: "Rollback",
      },
      context,
    );
    const request = {
      destination: { kind: "existing" as const, listId: "svl_rollback" },
      addCommandId: "slc_rollback",
      lineId: "sll_rollback",
      product,
      trackedQuantity: 1,
      sourceSurface: "search",
    };
    const row = {
      operation_id: "slo_rollback",
      account_id: context.audit.forAccountId,
      revision: 2,
      send_revision: 2,
      status: "possible-send",
      draft: { product, trackedQuantity: 1, sourceSurface: "search" },
      request,
      fingerprint: savedListFingerprint([
        "collections.addition.v1",
        context.audit.forAccountId,
        "slo_rollback",
        ["existing", "svl_rollback"],
        savedListCanonicalProduct(product),
        1,
        "search",
        "slc_rollback",
        "sll_rollback",
      ]),
      rejection_code: null,
      add_command_id: "slc_rollback",
      line_id: "sll_rollback",
      intent_id: null,
      intent_revision: null,
      created_at: "2026-10-12T00:00:00.000Z",
      terminal_at: null,
      expires_at: "2026-11-12T00:00:00.000Z",
    };
    const releases = vi.fn();
    const rollback = vi.fn();
    const query = async <Row>(sql: string) => {
      if (sql.includes("FROM collections_anonymous_owner_activation"))
        return {
          rows: [
            { singleton: true, activated_at: "2026-10-12T00:00:00.000Z", gate_packet_sha256: "a", floor_commit: "f" },
          ] as unknown as Row[],
        };
      if (sql === "ROLLBACK") {
        rollback();
        if (!rollbackSucceeds) throw new Error("synthetic-rollback-failed");
      }
      return { rows: (sql.startsWith("SELECT operation_id") ? [row] : []) as unknown as Row[] };
    };
    const pool: PgTransactionalPool = { query, connect: vi.fn(async () => ({ query, release: releases })) };
    const append = vi.fn(async () => {
      throw createEventStoreError("concurrency_conflict", "synthetic-conflict");
    });
    const eventStore = {
      ...createPostgresEventStore({ pool }),
      appendToStreamInTransaction: append,
      readStreamInTransaction: async (_db: unknown, input: Parameters<typeof memory.eventStore.readStream>[0]) =>
        memory.eventStore.readStream(input),
    };
    const service = createSavedListRecoveryRuntime({
      pool,
      eventStore,
      productCatalog,
      clock: () => new Date("2026-10-13T00:00:00.000Z"),
    });
    await expect(
      service.apply({ operationId: row.operation_id, revision: row.send_revision }, context),
    ).rejects.toThrow();
    expect(append).toHaveBeenCalledTimes(rollbackSucceeds ? 2 : 1);
    expect(rollback).toHaveBeenCalledTimes(rollbackSucceeds ? 2 : 1);
    expect(releases).toHaveBeenCalledTimes(rollbackSucceeds ? 2 : 1);
    expect(memory.allEvents).toHaveLength(1);
  });
});
