import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as collectionsModule } from "../../../index";
import { createSavedListRecoveryRuntime } from "./recovery-runtime";
import { createSavedListRuntime } from "./runtime";
import type { SavedListDestination } from "./discovery-contracts";
import type { SavedListProductSelection } from "../domain/contracts";
import { savedListCanonicalProduct, savedListFingerprint } from "./anonymous-owner";
import { activateAnonymousOwnerCutover } from "../../../support/runtime-support/anonymous-owner-activation";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for recovery DB proof.");
const describeDb = baseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_recovery" as never,
  audit: { performedByUserId: "usr_recovery" as never, forAccountId: "acc_recovery" as never },
};
const product: SavedListProductSelection = {
  catalogItemId: "cat_recovery" as never,
  productId: "cat_recovery::condition:near-mint" as never,
  selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
};
const draft = { product, trackedQuantity: 2, sourceSurface: "search" as const };
const destination = {
  kind: "new" as const,
  listId: "svl_recovery" as never,
  createCommandId: "slc_recovery_create" as never,
  title: "Recovery",
};
let pools: Readonly<Record<"collections", PgTransactionalPool>>;
let clock = new Date("2026-10-12T12:00:00.000Z");
const catalog = {
  resolveProduct: vi.fn(async (selection: SavedListProductSelection) => ({
    availability: "active" as const,
    product: selection,
  })),
};

function runtime(pool = pools.collections) {
  return createSavedListRecoveryRuntime({
    pool,
    eventStore: createPostgresEventStore({ pool }),
    productCatalog: catalog,
    clock: () => clock,
  });
}

async function ready(service = runtime(), target: SavedListDestination = destination) {
  const prepared = await service.prepare(draft, context);
  const confirmed = await service.confirm(
    { operationId: prepared.operationId, revision: prepared.revision, destination: target },
    context,
  );
  const sending = await service.beginSend(
    { operationId: confirmed.operationId, revision: confirmed.revision },
    context,
  );
  return { service, sending };
}

describeDb("durable Saved List recovery", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, ["collections"], "saved_list_recovery");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(collectionsModule, pools.collections);
    await pools.collections.query(
      "UPDATE collections_anonymous_owner_activation SET activated_at = NULL, gate_packet_sha256 = NULL, floor_commit = NULL",
    );
    await activateAnonymousOwnerCutover(pools.collections, {
      gatePacketSha256: "d".repeat(64),
      floorCommit: "54c9898f45e14e616230e584d5a4ec078ceb1a03",
    });
    clock = new Date("2026-10-12T12:00:00.000Z");
    catalog.resolveProduct.mockClear();
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("records recovery events only after the transaction commits", async () => {
    const { service, sending } = await ready();
    const observed = await runWithEventCommitMetadata(async () => {
      const result = await service.apply({ operationId: sending.operationId, revision: sending.revision }, context);
      return { result, metadata: getEventCommitMetadata() };
    });
    const stored = await pools.collections.query<{ event_id: string; global_position: string }>(
      "SELECT event_id, global_position::text FROM event_store_events ORDER BY global_position",
    );
    expect(observed.result).toMatchObject({ status: "applied" });
    expect(observed.metadata.sources).toEqual([
      {
        sourceContextName: "collections",
        eventIds: stored.rows.map((event) => event.event_id),
        maxGlobalPosition: stored.rows.at(-1)!.global_position,
      },
    ]);
  });

  it("records only the retry events when the first recovery attempt rolls back", async () => {
    const prepared = await ready();
    const baseStore = createPostgresEventStore({ pool: pools.collections });
    let appends = 0;
    const retrying = createSavedListRecoveryRuntime({
      pool: pools.collections,
      eventStore: {
        ...baseStore,
        appendToStreamInTransaction: async (client, input) => {
          const stored = await baseStore.appendToStreamInTransaction(client, input);
          appends += 1;
          if (appends === 1) throw Object.assign(new Error("synthetic concurrency"), { code: "concurrency_conflict" });
          return stored;
        },
      },
      productCatalog: catalog,
      clock: () => clock,
    });
    const observed = await runWithEventCommitMetadata(async () => {
      const result = await retrying.apply(
        { operationId: prepared.sending.operationId, revision: prepared.sending.revision },
        context,
      );
      return { result, metadata: getEventCommitMetadata() };
    });
    const stored = await pools.collections.query<{ event_id: string }>(
      "SELECT event_id FROM event_store_events ORDER BY global_position",
    );
    expect(appends).toBe(2);
    expect(observed.result).toMatchObject({ status: "applied" });
    expect(observed.metadata.eventIds).toEqual(stored.rows.map((event) => event.event_id));
  });

  it("does not expose metadata when commit fails after an inner append", async () => {
    const { sending } = await ready();
    const failure = new Error("synthetic commit failure");
    const failingPool: PgTransactionalPool = {
      query: pools.collections.query.bind(pools.collections),
      idleInTransactionSessionTimeoutMillis: pools.collections.idleInTransactionSessionTimeoutMillis,
      connect: async () => {
        const client = await pools.collections.connect();
        return {
          release: client.release.bind(client),
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            if (sql === "COMMIT") throw failure;
            return client.query<Row>(sql, values);
          },
        };
      },
    };
    const failing = createSavedListRecoveryRuntime({
      pool: failingPool,
      eventStore: createPostgresEventStore({ pool: failingPool }),
      productCatalog: catalog,
      clock: () => clock,
    });
    const observed = await runWithEventCommitMetadata(async () => {
      const error = await failing.apply({ operationId: sending.operationId, revision: sending.revision }, context).then(
        () => null,
        (caught: unknown) => caught,
      );
      return { error, metadata: getEventCommitMetadata() };
    });
    expect(observed.error).toBe(failure);
    expect(observed.metadata.eventIds).toEqual([]);
    expect(
      (await pools.collections.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events"))
        .rows[0]?.count,
    ).toBe("0");
  it("recovery activation is read per request", async () => {
    await pools.collections.query(
      "UPDATE collections_anonymous_owner_activation SET activated_at = NULL, gate_packet_sha256 = NULL, floor_commit = NULL",
    );
    const service = runtime();
    await expect(service.list({}, context)).rejects.toMatchObject({ code: "disabled" });
    await activateAnonymousOwnerCutover(pools.collections, {
      gatePacketSha256: "e".repeat(64),
      floorCommit: "54c9898f45e14e616230e584d5a4ec078ceb1a03",
    });
    await expect(service.list({}, context)).resolves.toMatchObject({ items: [] });
  });

  it("direct-recovery-without-browser-state", async () => {
    const { service, sending } = await ready();
    clock = new Date("2026-10-13T12:00:00.000Z");
    const reloaded = runtime();
    const page = await reloaded.list({}, context);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ operationId: sending.operationId, request: { ...draft, destination } });
    catalog.resolveProduct.mockClear();
    const recovered = await reloaded.get(sending.operationId, context);
    expect(recovered?.result).toBeNull();
    expect(recovered?.status).toBe("unknown");
    expect(catalog.resolveProduct).not.toHaveBeenCalled();
    const other = { ...context, audit: { ...context.audit, forAccountId: "acc_other" as never } };
    expect(await service.get(sending.operationId, other)).toBeNull();
    expect((await service.list({}, other)).items).toEqual([]);
    await expect(
      service.confirm(
        {
          operationId: sending.operationId,
          revision: sending.revision,
          destination: { ...destination, title: "Changed" },
        },
        context,
      ),
    ).rejects.toThrow();
    await expect(
      reloaded.apply({ operationId: sending.operationId, revision: sending.revision }, context),
    ).resolves.toMatchObject({ status: "applied", result: { receipt: { replayed: false } } });
  });

  it("recovery-append-expiry-atomicity", async () => {
    const { sending } = await ready();
    let writes = 0;
    const counted: PgTransactionalPool = {
      ...pools.collections,
      query: pools.collections.query.bind(pools.collections),
      connect: async () => {
        const client = await pools.collections.connect();
        return {
          release: client.release.bind(client),
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes += 1;
            return client.query<Row>(sql, values);
          },
        };
      },
    };
    await runtime(counted).apply({ operationId: sending.operationId, revision: sending.revision }, context);
    const writeCount = writes;
    expect(writeCount).toBeGreaterThanOrEqual(4);
    for (let crash = 1; crash <= writeCount; crash += 1) {
      await resetMultiContextTestSchemas(pools);
      await bootstrapContextDatabase(collectionsModule, pools.collections);
      await activateAnonymousOwnerCutover(pools.collections, {
        gatePacketSha256: "d".repeat(64),
        floorCommit: "54c9898f45e14e616230e584d5a4ec078ceb1a03",
      });
      const prepared = await ready();
      let current = 0;
      const injectedFailure = new Error("synthetic-write-crash");
      const crashing: PgTransactionalPool = {
        ...counted,
        connect: async () => {
          const client = await pools.collections.connect();
          return {
            release: client.release.bind(client),
            query: async <Row>(sql: string, values?: readonly unknown[]) => {
              if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && ++current === crash) throw injectedFailure;
              return client.query<Row>(sql, values);
            },
          };
        },
      };
      const failure = await runtime(crashing)
        .apply({ operationId: prepared.sending.operationId, revision: prepared.sending.revision }, context)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(Error);
      if (failure !== injectedFailure) {
        expect(failure).toMatchObject({
          code: "infrastructure_failure",
          details: { cause: injectedFailure.message },
        });
      }
      expect(current).toBe(crash);
      const events = await pools.collections.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM event_store_events",
      );
      expect(Number(events.rows[0]!.count)).toBe(0);
      expect((await runtime().get(prepared.sending.operationId, context))?.status).toBe("unknown");
    }
    const row = (await runtime().list({}, context)).items[0]!;
    const replies = await Promise.all([
      runtime().apply({ operationId: row.operationId, revision: row.sendRevision! }, context),
      runtime().apply({ operationId: row.operationId, revision: row.sendRevision! }, context),
    ]);
    expect(replies.filter((reply) => reply.result?.receipt.replayed === false)).toHaveLength(1);
    const savedLists = createSavedListRuntime({
      eventStore: createPostgresEventStore({ pool: pools.collections }),
      productCatalog: catalog,
    });
    expect(
      (
        await savedLists.getOwnerSnapshot(
          { listId: destination.listId, ownerAccountId: context.audit.forAccountId },
          context,
        )
      )?.lines[0]?.trackedQuantity,
    ).toBe(2);
  });

  it("retained-recovery-expiry-fence", async () => {
    const { service, sending } = await ready();
    clock = new Date("2026-11-12T12:00:00.000Z");
    expect(await service.expire(context)).toBe(1);
    expect(await service.expire(context)).toBe(0);
    await expect(
      service.apply({ operationId: sending.operationId, revision: sending.revision }, context),
    ).rejects.toThrow();
    const events = await pools.collections.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM event_store_events",
    );
    expect(Number(events.rows[0]!.count)).toBe(0);
    expect((await service.get(sending.operationId, context))?.status).toBe("expired");
    clock = new Date("2026-12-13T12:00:00.000Z");
    await service.expire(context);
    expect(await service.get(sending.operationId, context)).toBeNull();
    await expect(
      service.apply({ operationId: sending.operationId, revision: sending.revision }, context),
    ).rejects.toThrow();
    expect(
      (await pools.collections.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events"))
        .rows[0]?.count,
    ).toBe("0");
  });

  it("F1 retained-recovery-expiry-fence poisoned foreign receipt does not block prepare", async () => {
    const other = { ...context, audit: { ...context.audit, forAccountId: "acc_other" as never } };
    const savedLists = createSavedListRuntime({
      eventStore: createPostgresEventStore({ pool: pools.collections }),
      productCatalog: catalog,
    });
    await savedLists.createSavedList(
      {
        commandId: "slc_foreign_create" as never,
        listId: "svl_foreign" as never,
        ownerAccountId: other.audit.forAccountId,
        title: "Foreign",
      },
      other,
    );
    const service = runtime();
    const prepared = await service.prepare(draft, context);
    const target = { kind: "existing" as const, listId: "svl_foreign" as never };
    await expect(
      service.confirm({ operationId: prepared.operationId, revision: prepared.revision, destination: target }, context),
    ).rejects.toThrow();
    const tokens = await pools.collections.query<{ add_command_id: string; line_id: string }>(
      "SELECT add_command_id, line_id FROM collections_saved_list_operations WHERE operation_id = $1",
      [prepared.operationId],
    );
    const { add_command_id: commandId, line_id: lineId } = tokens.rows[0]!;
    const request = { ...draft, destination: target, addCommandId: commandId, lineId };
    const hash = savedListFingerprint([
      "collections.addition.v1",
      context.audit.forAccountId,
      prepared.operationId,
      ["existing", target.listId],
      savedListCanonicalProduct(product),
      draft.trackedQuantity,
      draft.sourceSurface,
      commandId,
      lineId,
    ]);
    // Reproduce a row accepted before destination ownership validation was added.
    await pools.collections.query(
      "UPDATE collections_saved_list_operations SET status = 'confirmed', request = $2::jsonb, fingerprint = $3 WHERE operation_id = $1",
      [prepared.operationId, JSON.stringify(request), hash],
    );
    const before = await pools.collections.query(
      "SELECT * FROM collections_saved_list_operations WHERE operation_id = $1",
      [prepared.operationId],
    );
    clock = new Date("2026-11-12T12:00:00.000Z");
    await expect(service.prepare(draft, context)).resolves.toMatchObject({ status: "prepared" });
    expect(
      (
        await pools.collections.query("SELECT * FROM collections_saved_list_operations WHERE operation_id = $1", [
          prepared.operationId,
        ])
      ).rows,
    ).toEqual(before.rows);
    expect(
      (await pools.collections.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events"))
        .rows[0]?.count,
    ).toBe("1");
    expect(await service.expire(context)).toBe(0);
  });

  it("F1b retained-recovery-expiry-fence intent drift leaves row untouched and continues the batch", async () => {
    const { service, sending } = await ready();
    const healthy = await service.prepare(draft, context);
    await pools.collections.query(
      "UPDATE collections_saved_list_operations SET intent_id = 'sli_missing', intent_revision = 3 WHERE operation_id = $1",
      [sending.operationId],
    );
    const before = await pools.collections.query(
      "SELECT * FROM collections_saved_list_operations WHERE operation_id = $1",
      [sending.operationId],
    );
    clock = new Date("2026-11-12T12:00:00.000Z");
    expect(await service.expire(context)).toBe(1);
    expect(
      (
        await pools.collections.query("SELECT * FROM collections_saved_list_operations WHERE operation_id = $1", [
          sending.operationId,
        ])
      ).rows,
    ).toEqual(before.rows);
    expect((await service.get(healthy.operationId, context))?.status).toBe("expired");
    await expect(service.prepare(draft, context)).resolves.toMatchObject({ status: "prepared" });
    expect(
      (await pools.collections.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events"))
        .rows[0]?.count,
    ).toBe("0");
  });

  it("F2 retained-recovery-expiry-fence late sender without sweep", async () => {
    const { service, sending } = await ready();
    clock = new Date("2026-11-12T12:00:00.000Z");
    await expect(
      service.apply({ operationId: sending.operationId, revision: sending.revision }, context),
    ).rejects.toMatchObject({ code: "expired" });
    expect(
      (await pools.collections.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events"))
        .rows[0]?.count,
    ).toBe("0");
    expect(
      (
        await pools.collections.query<{ status: string }>(
          "SELECT status FROM collections_saved_list_operations WHERE operation_id = $1",
          [sending.operationId],
        )
      ).rows[0]?.status,
    ).toBe("possible-send");
    expect((await service.get(sending.operationId, context))?.status).toBe("unknown");
  });

  it.each([false, true])(
    "F1 savepoint rolls back a partially updated row (infrastructure=%s)",
    async (infrastructure) => {
      const service = runtime();
      const poisoned = await service.prepare(draft, context);
      const healthy = await service.prepare(draft, context);
      const failure = new Error("synthetic-post-update-outage");
      const pool: PgTransactionalPool = {
        query: pools.collections.query.bind(pools.collections),
        connect: async () => {
          const client = await pools.collections.connect();
          return {
            release: client.release.bind(client),
            query: async <Row>(sql: string, values?: readonly unknown[]) => {
              const result = await client.query<Row>(sql, values);
              if (/^\s*UPDATE collections_saved_list_operations/.test(sql) && values?.[0] === poisoned.operationId) {
                if (infrastructure) throw failure;
                return { rows: [] as Row[], rowCount: 0 };
              }
              return result;
            },
          };
        },
      };
      const before = await pools.collections.query(
        "SELECT * FROM collections_saved_list_operations WHERE operation_id = $1",
        [poisoned.operationId],
      );
      clock = new Date("2026-11-12T12:00:00.000Z");
      if (infrastructure) await expect(runtime(pool).expire(context)).rejects.toBe(failure);
      else expect(await runtime(pool).expire(context)).toBe(1);
      expect(
        (
          await pools.collections.query("SELECT * FROM collections_saved_list_operations WHERE operation_id = $1", [
            poisoned.operationId,
          ])
        ).rows,
      ).toEqual(before.rows);
      expect(
        (
          await pools.collections.query<{ status: string }>(
            "SELECT status FROM collections_saved_list_operations WHERE operation_id = $1",
            [healthy.operationId],
          )
        ).rows[0]?.status,
      ).toBe(infrastructure ? "prepared" : "expired");
      expect(
        (await pools.collections.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events"))
          .rows[0]?.count,
      ).toBe("0");
    },
  );

  it.each(["prepared", "confirmed"])(
    "F3 retained-recovery-expiry-fence elapsed %s reads without sweep",
    async (status) => {
      const service = runtime();
      const prepared = await service.prepare(draft, context);
      const operation =
        status === "confirmed"
          ? await service.confirm(
              { operationId: prepared.operationId, revision: prepared.revision, destination },
              context,
            )
          : prepared;
      clock = new Date("2026-11-12T12:00:00.000Z");
      catalog.resolveProduct.mockClear();
      expect(await service.get(operation.operationId, context)).toMatchObject({ status: "expired", lineResults: [] });
      expect((await service.list({}, context)).items[0]).toMatchObject({ status: "expired", lineResults: [] });
      expect(catalog.resolveProduct).not.toHaveBeenCalled();
      expect(
        (
          await pools.collections.query<{ status: string }>(
            "SELECT status FROM collections_saved_list_operations WHERE operation_id = $1",
            [operation.operationId],
          )
        ).rows[0]?.status,
      ).toBe(status);
      if (status === "confirmed")
        await expect(
          service.beginSend({ operationId: operation.operationId, revision: operation.revision }, context),
        ).rejects.toMatchObject({ code: "expired" });
      expect(
        (await pools.collections.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events"))
          .rows[0]?.count,
      ).toBe("0");
    },
  );

  it("F2 retained-recovery-expiry-fence purged unelapsed row isolates locked re-read", async () => {
    const { sending } = await ready();
    const delayed = createSavedListRecoveryRuntime({
      pool: pools.collections,
      eventStore: createPostgresEventStore({ pool: pools.collections }),
      clock: () => clock,
      productCatalog: {
        resolveProduct: async (selection) => {
          await pools.collections.query("DELETE FROM collections_saved_list_operations WHERE operation_id = $1", [
            sending.operationId,
          ]);
          return { availability: "active", product: selection };
        },
      },
    });
    await expect(
      delayed.apply({ operationId: sending.operationId, revision: sending.revision }, context),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(
      (await pools.collections.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events"))
        .rows[0]?.count,
    ).toBe("0");
  });

  it("recovery-append-expiry-atomicity direct-add and anonymous claim quantities sum", async () => {
    const { service, sending } = await ready();
    await service.apply({ operationId: sending.operationId, revision: sending.revision }, context);
    await pools.collections.query(
      "UPDATE collections_anonymous_owner_activation SET activated_at = NULL, gate_packet_sha256 = NULL, floor_commit = NULL",
    );
    await pools.collections.query(
      `INSERT INTO collections_anonymous_saved_list_intents
      (intent_id, anonymous_owner_id, source_path, source_surface, catalog_catalog_item_id, product_id,
       selected_options, add_command_id, line_id, created_at, expires_at)
      VALUES ('sli_sum', 'anon_sum', '/search', 'search', $1, $2, $3::jsonb, 'slc_sum', 'sll_sum', $4, $5)`,
      [
        product.catalogItemId,
        product.productId,
        JSON.stringify(product.selectedOptions),
        clock.toISOString(),
        new Date(clock.getTime() + 30 * 86400000).toISOString(),
      ],
    );
    await activateAnonymousOwnerCutover(pools.collections, {
      gatePacketSha256: "f".repeat(64),
      floorCommit: "54c9898f45e14e616230e584d5a4ec078ceb1a03",
    });
    const target = { kind: "existing" as const, listId: destination.listId };
    const confirmed = await service.reserveAnonymous(
      { anonymousOwnerId: "anon_sum", intentId: "sli_sum", destination: target, trackedQuantity: 3 },
      context,
    );
    const same = await service.reserveAnonymous(
      { anonymousOwnerId: "anon_sum", intentId: "sli_sum", destination: target, trackedQuantity: 3 },
      context,
    );
    expect(same.operationId).toBe(confirmed.operationId);
    await expect(
      service.reserveAnonymous(
        { anonymousOwnerId: "anon_sum", intentId: "sli_sum", destination: target, trackedQuantity: 4 },
        context,
      ),
    ).rejects.toThrow();
    const guestSend = await service.beginSend(
      { operationId: confirmed.operationId, revision: confirmed.revision },
      context,
    );
    const direct = await ready(service, target);
    await Promise.all([
      service.apply({ operationId: guestSend.operationId, revision: guestSend.revision }, context),
      service.apply({ operationId: direct.sending.operationId, revision: direct.sending.revision }, context),
    ]);
    const savedLists = createSavedListRuntime({
      eventStore: createPostgresEventStore({ pool: pools.collections }),
      productCatalog: catalog,
    });
    expect(
      (
        await savedLists.getOwnerSnapshot(
          { listId: destination.listId, ownerAccountId: context.audit.forAccountId },
          context,
        )
      )?.lines[0]?.trackedQuantity,
    ).toBe(7);
    const intent = await pools.collections.query<{ status: string; anonymous_owner_id: string }>(
      "SELECT status, anonymous_owner_id FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_sum'",
    );
    expect(intent.rows[0]).toEqual({ status: "claimed", anonymous_owner_id: "anon_sum" });
  });

  it("retained-recovery-expiry-fence delayed sender and purge-before-append mutant", async () => {
    const { service, sending } = await ready();
    let unblock!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delayed = createSavedListRecoveryRuntime({
      pool: pools.collections,
      eventStore: createPostgresEventStore({ pool: pools.collections }),
      clock: () => clock,
      productCatalog: {
        resolveProduct: async (selection) => {
          entered();
          await held;
          return { availability: "active", product: selection };
        },
      },
    });
    const late = delayed.apply({ operationId: sending.operationId, revision: sending.revision }, context);
    const verdict = expect(late).rejects.toThrow();
    await reached;
    clock = new Date("2026-11-12T12:00:00.000Z");
    await service.expire(context);
    expect((await service.get(sending.operationId, context))?.status).toBe("expired");
    clock = new Date("2026-12-13T12:00:00.000Z");
    await service.expire(context);
    unblock();
    await verdict;
    expect(
      (await pools.collections.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events"))
        .rows[0]?.count,
    ).toBe("0");
    // Bypass control: the former unfenced writer can append after the purge.
    const bypass = createSavedListRuntime({
      eventStore: createPostgresEventStore({ pool: pools.collections }),
      productCatalog: catalog,
    });
    await bypass.createSavedList(
      {
        listId: destination.listId,
        commandId: destination.createCommandId,
        ownerAccountId: context.audit.forAccountId,
        title: destination.title,
      },
      context,
    );
    expect(
      (await pools.collections.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events"))
        .rows[0]?.count,
    ).toBe("1");
  });

  it("retained-recovery-expiry-fence bounded 500-row batches and 20-row keyset pages", async () => {
    const prepared = await runtime().prepare(draft, context);
    await pools.collections.query(
      `INSERT INTO collections_saved_list_operations
      (operation_id, account_id, status, draft, add_command_id, line_id, created_at, expires_at)
      SELECT 'slo_batch_' || n, account_id, status, draft, 'slc_batch_' || n, 'sll_batch_' || n, created_at, expires_at
      FROM collections_saved_list_operations CROSS JOIN generate_series(1, 500) n WHERE operation_id = $1`,
      [prepared.operationId],
    );
    const first = await runtime().list({}, context);
    const second = await runtime().list({ cursor: first.nextCursor! }, context);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(20);
    expect(new Set([...first.items, ...second.items].map((row) => row.operationId)).size).toBe(40);
    await expect(runtime().prepare(draft, context)).rejects.toMatchObject({ code: "limit" });
    clock = new Date("2026-11-12T12:00:00.000Z");
    expect(await runtime().expire(context)).toBe(500);
    expect(await runtime().expire(context)).toBe(1);
    expect(await runtime().expire(context)).toBe(0);
  });
  it("saved-list-per-line-recovery retains terminal rejection without resending", async () => {
    const { service, sending } = await ready();
    await service.apply({ operationId: sending.operationId, revision: sending.revision }, context);
    const savedLists = createSavedListRuntime({
      eventStore: createPostgresEventStore({ pool: pools.collections }),
      productCatalog: catalog,
    });
    await savedLists.archiveSavedList(
      {
        commandId: "slc_archive" as never,
        listId: destination.listId,
        ownerAccountId: context.audit.forAccountId,
        expectedVersion: 2,
      },
      context,
    );
    const refused = await ready(service, { kind: "existing", listId: destination.listId });
    const input = { operationId: refused.sending.operationId, revision: refused.sending.revision };
    expect(await service.apply(input, context)).toMatchObject({
      status: "rejected",
      result: null,
      lineResults: [{ status: "rejected", errorCode: "list-archived" }],
    });
    catalog.resolveProduct.mockClear();
    expect(await service.apply(input, context)).toMatchObject({ status: "rejected" });
    expect(catalog.resolveProduct).not.toHaveBeenCalled();
    expect((await service.get(input.operationId, context))?.lineResults[0]?.errorCode).toBe("list-archived");
  });
});
