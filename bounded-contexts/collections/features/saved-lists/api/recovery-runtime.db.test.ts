import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
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
    enabled: true,
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
    clock = new Date("2026-10-12T12:00:00.000Z");
    catalog.resolveProduct.mockClear();
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
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
      const prepared = await ready();
      let current = 0;
      const crashing: PgTransactionalPool = {
        ...counted,
        connect: async () => {
          const client = await pools.collections.connect();
          return {
            release: client.release.bind(client),
            query: async <Row>(sql: string, values?: readonly unknown[]) => {
              if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && ++current === crash)
                throw new Error("synthetic-write-crash");
              return client.query<Row>(sql, values);
            },
          };
        },
      };
      await expect(
        runtime(crashing).apply(
          { operationId: prepared.sending.operationId, revision: prepared.sending.revision },
          context,
        ),
      ).rejects.toThrow("synthetic-write-crash");
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

  it("recovery-append-expiry-atomicity direct-add and anonymous claim quantities sum", async () => {
    const { service, sending } = await ready();
    await service.apply({ operationId: sending.operationId, revision: sending.revision }, context);
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
      enabled: true,
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
