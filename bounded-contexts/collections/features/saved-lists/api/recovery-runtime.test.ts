import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createEventStoreError } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createSavedListRuntime } from "./runtime";
import { createSavedListRecoveryRuntime } from "./recovery-runtime";
import { savedListCanonicalProduct, savedListFingerprint } from "./anonymous-owner";
import type { SavedListProductSelection } from "../domain/contracts";

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
      enabled: true,
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
