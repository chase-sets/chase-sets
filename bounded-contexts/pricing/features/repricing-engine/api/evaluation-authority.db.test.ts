import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { createInventoryStockAuthorityForPool } from "@chase-sets/inventory/server";
import type { RequestTerminalBinding } from "@chase-sets/event-core/owner-stream-reservation";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import {
  createPostgresEventStore,
  createPostgresOwnerStreamReservationStore,
  EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
  ownerPredicateKey,
  registerRequestTerminalWitness,
  reserveOwnerPredicateInTransaction,
  assertExactPreparationTime,
  withConfigurationEpochTransaction,
  type PgQueryResult,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { module as pricingModule } from "../../../index";
import { createPricingPlatformPolicyStore } from "../../../support/runtime-support/services";
import { repricingPlatformSelector } from "./evaluation-authority";
import { evaluationDigest, type EvaluationBinding } from "../domain/evaluation-authority";
import { evaluationOwnerIdentity } from "./evaluation-owner-inputs";
import { reserveDailyChangesInTransaction } from "../read-model/daily-change-budget";
import { dryRunBody, dryRunContext } from "../tests/dry-run-fixture";
import { recordProductRoundDirection } from "../read-model/product-round-state";
import { repricingEnginePolicy } from "../domain/policy";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseUrl ? describe : describe.skip;
const names = ["pricing", "marketplace", "inventory", "catalog"] as const;
const accountId = "acc_exact_synthetic";
const catalogItemId = "cat_exact_synthetic";
const productId = `${catalogItemId}::`;
const categoryId = "ctg_synthetic_exact";
const context = { ...dryRunContext, audit: { ...dryRunContext.audit, forAccountId: accountId } } as const;
const previousDay = "2026-01-02";
const previousTime = `${previousDay}T12:00:00.000Z`;
const lost = new Error("synthetic lost commit reply");
const stopped = new Error("synthetic process stop");
type Owner = (typeof names)[number];
type Hook = (run: () => Promise<unknown>, sql: string, values?: readonly unknown[]) => Promise<unknown>;

function handoffSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

function instrument(pool: PgTransactionalPool, hook: () => Hook): PgTransactionalPool {
  const wrap =
    (db: PgQueryable, intercept: Hook): PgQueryable["query"] =>
    async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) =>
      (await intercept(() => db.query<Row>(sql, values), sql, values)) as PgQueryResult<Row>;
  return {
    query: wrap(pool, hook()),
    async connect() {
      const db = await pool.connect();
      return { query: wrap(db, hook()), release: (error) => db.release(error) };
    },
  };
}

function previousClock(pool: PgTransactionalPool, time = previousTime): PgTransactionalPool {
  return instrument(pool, () => async (run, sql, values) => {
    if (sql.startsWith("SELECT clock_timestamp() AS time FROM event_configuration_store_identity")) {
      const result = (await run()) as { rows: { time: Date }[] };
      for (const row of result.rows) row.time = new Date(time);
      return result;
    }
    if (sql.startsWith("SELECT checked.at >=")) {
      const result = (await run()) as { rows: { permitted: boolean }[] };
      for (const row of result.rows) row.permitted = String(values?.[0]) <= time && time < String(values?.[1]);
      return result;
    }
    return run();
  });
}

describeDb("Pricing Evaluated Decision with separate owner stores", () => {
  let pools: Readonly<Record<(typeof names)[number], PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, names, "synthetic_evaluated_decision");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(pricingModule, pools.pricing);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    await pools.inventory.query(inventoryModule.schemaSql);
    await bootstrapContextDatabase({ contextName: "catalog", schemaSql: "" }, pools.catalog);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  async function fixture(ownScope = dryRunBody.scope, maxChangesPerDay = 1) {
    const identity = await evaluationOwnerIdentity(pools.marketplace, "marketplace");
    const ports = {
      commercialTermsResolver: createNoopCommercialTermsResolver(),
      channelConnectionIdentityReader: { resolve: async () => null },
      pricingEvaluationOwners: {
        ...pools,
        captureInventoryStock: createInventoryStockAuthorityForPool(pools.inventory, pools.marketplace).capture,
      },
      pricingEvaluationConsumers: [{ identity, pool: pools.marketplace }],
      pricingPredicateConsumerPool: pools.marketplace,
    };
    const services = pricingModule.createServices(pools.pricing, ports);
    async function install(sellerAccountId: `acc_${string}`, scope = dryRunBody.scope) {
      const sellerContext = { ...context, audit: { ...context.audit, forAccountId: sellerAccountId } };
      const run = await services.repricingEngine.enqueueDryRun(
        {
          sellerAccountId,
          body: { ...dryRunBody, scope, maxChangesPerDay },
        },
        sellerContext,
      );
      expect(
        await services.repricingEngine.processNextDryRunJob({ claimOwnerId: "synthetic-exact", claimTtlMs: 30_000 }),
      ).toBe(1);
      expect(
        await services.repricingPolicies.activateRepricingPolicy(
          {
            accountId: sellerAccountId,
            dryRunId: run!.dryRunId,
            name: "Synthetic exact",
          },
          sellerContext,
        ),
      ).toMatchObject({ status: "applied" });
    }
    await install(accountId, ownScope);
    const market = createPostgresEventStore({ pool: pools.marketplace });
    const inventory = inventoryModule.createServices(pools.inventory, {
      stockReservationConsumerPool: pools.marketplace,
    });
    const storageLocationId = "loc_synthetic_exact";
    await inventory.storageLocations.commandHandler({
      streamId: `inventory.storage-location-${storageLocationId}`,
      context,
      command: {
        type: "CreateStorageLocation",
        storageLocationId,
        accountId,
        name: "Synthetic stock",
        shipFromCode: "60601",
        shipFromAddress: {
          name: "Synthetic",
          company: null,
          line1: "1 Main St",
          line2: null,
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
          phone: null,
          email: null,
        },
      },
    });
    const catalog = createPostgresEventStore({ pool: pools.catalog });
    const createCatalogItem = (item: `cat_${string}`) =>
      catalog.appendToStream({
        streamId: `catalog.item-${item}`,
        expectedVersion: "no_stream",
        context,
        events: [{ eventType: "catalog.catalog-item.created", payload: { catalogItemId: item } }],
      });
    await createCatalogItem(catalogItemId);
    async function request(
      suffix: string,
      consumer = identity,
      item: `cat_${string}` = catalogItemId,
      requestId = evaluationDigest(["request", suffix]),
    ) {
      const product = `${item}::` as const;
      const listingId = `lst_synthetic_${suffix}`;
      const inventoryItemId = `inv_synthetic_${suffix}` as const;
      const listingEvents = await market.appendToStream({
        streamId: `marketplace.listing-${listingId}`,
        expectedVersion: "no_stream",
        context,
        events: [{ eventType: "marketplace.listing.created", payload: { listingId, accountId } }],
      });
      await inventory.items.commandHandler({
        streamId: `inventory.item-${inventoryItemId}`,
        context,
        command: {
          type: "CreateInventoryItem",
          itemId: inventoryItemId,
          accountId,
          catalogItemId: item,
          productId: product,
          selectedOptions: [],
          storageLocationId,
          totalQuantity: 2,
          acquisitionOccurrence: { kind: "unknown" },
          commandOccurredAt: new Date().toISOString(),
        },
      });
      await inventory.channelStockAllocations.set(
        {
          accountId,
          inventoryItemId,
          mode: "shared-pool",
          partitions: [],
          expectedRevision: 0,
        },
        context,
      );
      const binding: EvaluationBinding = {
        requestId,
        commandFingerprint: evaluationDigest(["command", suffix]),
        consumer,
        accountId,
        tenantId: context.tenantId,
        principal: {
          userId: context.audit.performedByUserId,
          membershipId: "mbr_synthetic",
          sessionId: "ses_synthetic",
        },
        catalogItemId: item,
        productId: product,
        listingId,
        listingVersion: 1,
        target: { kind: "channel-connection", connectionId: "synthetic" },
        priceAmount: "15.00",
        priceCurrencyCode: "USD",
        decision: {
          kind: "pricing-evaluation",
          evaluationId: `evd_synthetic_${suffix}`,
          evaluationRevision: "1",
          standingAuthorizationId: `repricing-account/${accountId}`,
          standingAuthorizationRevision: "1",
          basePriceRevision: 1,
        },
      };
      const listing = {
        inventoryItemId,
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        basePriceRevision: 1,
        createdAt: new Date(listingEvents[0]!.recordedAt).toISOString(),
        grading: "raw" as const,
        selectedOptions: [],
      };
      return { binding, listing };
    }
    const authority = services.evaluationAuthority!;
    const charges = async () =>
      (
        await pools.pricing.query<{ changes_reserved: number }>(
          "SELECT changes_reserved FROM pricing_repricing_daily_change_budgets",
        )
      ).rows[0]?.changes_reserved;
    const status = async () =>
      (
        await pools.pricing.query<{ status: string }>(
          "SELECT status FROM pricing_evaluated_decisions ORDER BY request_id",
        )
      ).rows.map(({ status }) => status);
    const restart = (overrides: Partial<typeof pools> = {}) => {
      const routed = { ...pools, ...overrides };
      return pricingModule.createServices(routed.pricing, {
        ...ports,
        pricingEvaluationOwners: { ...ports.pricingEvaluationOwners, ...routed },
        pricingEvaluationConsumers: [{ identity, pool: routed.marketplace }],
        pricingPredicateConsumerPool: routed.marketplace,
      }).evaluationAuthority!;
    };
    return {
      request,
      authority,
      market,
      charges,
      status,
      identity,
      restart,
      install,
      catalog,
      createCatalogItem,
      ports,
    };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  type TestRequest = Awaited<ReturnType<Fixture["request"]>>;
  const unexpected = (id: string, error: unknown) => {
    throw new Error(`Unexpected recovery error for ${id}`, { cause: error });
  };

  async function decision(requestId: string) {
    return (
      await pools.pricing.query<{
        terminal_binding: RequestTerminalBinding;
        status: string;
        terminal_witness_token: string | null;
      }>(
        "SELECT terminal_binding, status, terminal_witness_token FROM pricing_evaluated_decisions WHERE request_id = $1",
        [requestId],
      )
    ).rows[0]!;
  }

  async function preOpenCrash(f: Fixture, request: TestRequest, expired = true, time = previousTime) {
    const pricing = instrument(pools.pricing, () => {
      let retained = false;
      return async (run, sql) => {
        if (sql.includes("INSERT INTO pricing_evaluated_decisions")) retained = true;
        const result = await run();
        if (retained && sql === "COMMIT") throw lost;
        return result;
      };
    });
    await expect(
      f
        .restart({ pricing, ...(expired ? { marketplace: previousClock(pools.marketplace, time) } : {}) })
        .prepare(request.binding, request.listing, context),
    ).rejects.toBe(lost);
    return (await decision(request.binding.requestId)).terminal_binding;
  }

  async function terminalFact(requestId: string) {
    return (
      await pools.marketplace.query<{ status: string; binding: RequestTerminalBinding }>(
        "SELECT status, binding FROM event_request_terminals WHERE request_id = $1",
        [requestId],
      )
    ).rows[0];
  }

  async function witnessFact(requestId: string) {
    return (
      await pools.marketplace.query<{ status: string; token: string | null }>(
        "SELECT status, token FROM event_request_terminal_witnesses WHERE request_id = $1",
        [requestId],
      )
    ).rows[0];
  }

  function oldTerminalStore() {
    return createPostgresOwnerStreamReservationStore({
      ownerPool: pools.pricing,
      consumerPool: pools.marketplace,
      applyInvalidation: async () => {
        throw new Error("not an owner writer");
      },
      applyInboundEvidence: async () => {
        throw new Error("not an evidence writer");
      },
    });
  }

  async function rawOpen(db: PgQueryable, binding: RequestTerminalBinding) {
    return db.query(
      `INSERT INTO event_request_terminals (consumer_store_id, request_id, status, binding, created_at, updated_at)
      VALUES ($1,$2,'OPEN',$3,now(),now())`,
      [binding.consumerStoreId, binding.requestId, binding],
    );
  }

  async function charge(day = previousDay) {
    return (
      await pools.pricing.query<{ changes_reserved: number }>(
        "SELECT changes_reserved FROM pricing_repricing_daily_change_budgets WHERE seller_account_id = $1 AND budget_day = $2",
        [accountId, day],
      )
    ).rows[0]?.changes_reserved;
  }

  async function reserveMembers(terminal: RequestTerminalBinding, owners: readonly Owner[]) {
    for (const owner of owners) {
      const { incarnation } = await evaluationOwnerIdentity(pools[owner], owner);
      for (const member of terminal.reservations.filter(({ seal }) => seal.storeIncarnation === incarnation))
        await withConfigurationEpochTransaction(pools[owner], (db) => reserveOwnerPredicateInTransaction(db, member));
    }
  }

  async function waitForBlockedClient(holder: PgQueryable) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await holder.query<{ waiting: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
      ) AS waiting`);
      if (result.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Expected a client blocked on the transaction fence");
  }

  it("recovers an enrolled prior-day pre-open crash, never a lost OPEN or an unwitnessed decision", async () => {
    const f = await fixture(dryRunBody.scope, 20);
    const eligible = await preOpenCrash(f, await f.request("expired-crash"));
    const make = async (name: string) => {
      const r = await f.request(name);
      return (await f.restart({ marketplace: previousClock(pools.marketplace) }).prepare(r.binding, r.listing, context))
        .terminal;
    };
    const deleted = await make("expired-open-lost");
    const open = await make("expired-open-present");
    await pools.marketplace.query("DELETE FROM event_request_terminals WHERE request_id = $1", [deleted.requestId]);
    expect(await witnessFact(deleted.requestId)).toMatchObject({ status: "SEEN" });
    const legacy = await preOpenCrash(f, await f.request("legacy"));
    const missing = await preOpenCrash(f, await f.request("missing-witness"));
    const mismatch = await preOpenCrash(f, await f.request("wrong-token"));
    const unexpired = await preOpenCrash(f, await f.request("unexpired"), false);
    await pools.pricing.query(
      "UPDATE pricing_evaluated_decisions SET terminal_witness_token = NULL WHERE request_id = $1",
      [legacy.requestId],
    );
    await pools.marketplace.query("DELETE FROM event_request_terminal_witnesses WHERE request_id = $1", [
      missing.requestId,
    ]);
    await pools.marketplace.query(
      "UPDATE event_request_terminal_witnesses SET token = gen_random_uuid() WHERE request_id = $1",
      [mismatch.requestId],
    );
    await bootstrapContextDatabase(pricingModule, pools.pricing);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    expect((await decision(legacy.requestId)).terminal_witness_token).toBeNull();
    expect(await charge()).toBe(6);
    const runner = f.restart();
    expect(await runner.recoverExpiredDecisions(unexpected)).toBe(1);
    expect(await runner.recoverExpiredDecisions(unexpected)).toBe(0);
    expect(await charge()).toBe(5);
    expect(await charge(unexpired.preparationNotBefore!.slice(0, 10))).toBe(1);
    expect(await terminalFact(eligible.requestId)).toEqual({ status: "ABORTED", binding: eligible });
    expect(await terminalFact(open.requestId)).toEqual({ status: "OPEN", binding: open });
    for (const held of [legacy, missing, mismatch, unexpired, deleted, open])
      expect((await decision(held.requestId)).status).toBe("PREPARED");
    expect(await terminalFact(deleted.requestId)).toBeUndefined();
    await oldTerminalStore().abortRequestTerminal(open);
    expect(await witnessFact(open.requestId)).toMatchObject({ status: "SEEN" });
  });

  it("serializes raw first inserts with registration in either lock order and never re-arms after deletion", async () => {
    const f = await fixture(dryRunBody.scope, 3);
    for (const first of ["raw", "register"] as const) {
      const original = await preOpenCrash(f, await f.request(`raw-${first}`));
      await pools.marketplace.query("DELETE FROM event_request_terminal_witnesses WHERE request_id = $1", [
        original.requestId,
      ]);
      const entered = handoffSignal();
      const proceed = handoffSignal();
      let registration: Promise<string | undefined>;
      let raw: Promise<unknown>;
      const holder = await pools.marketplace.connect();
      try {
        if (first === "raw") {
          await holder.query("BEGIN");
          await rawOpen(holder, original);
          registration = registerRequestTerminalWitness(pools.marketplace, original);
          raw = Promise.resolve();
          await waitForBlockedClient(holder);
          await holder.query("COMMIT");
        } else {
          const registrationPool: PgTransactionalPool = {
            query: pools.marketplace.query.bind(pools.marketplace),
            connect: async () => ({
              query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
                if (sql === "COMMIT") entered.resolve();
                if (sql === "COMMIT") await proceed.promise;
                return holder.query<Row>(sql, values);
              },
              release: () => undefined,
            }),
          };
          registration = registerRequestTerminalWitness(registrationPool, original);
          await Promise.race([entered.promise, registration]);
          raw = rawOpen(pools.marketplace, original);
          await waitForBlockedClient(holder);
          proceed.resolve();
        }
        const token = await registration;
        await raw;
        if (first === "raw") expect(token).toBeUndefined();
        else {
          expect(token).toBeDefined();
          await pools.pricing.query(
            "UPDATE pricing_evaluated_decisions SET terminal_witness_token = $2 WHERE request_id = $1",
            [original.requestId, token],
          );
        }
        await pools.marketplace.query("DELETE FROM event_request_terminals WHERE request_id = $1", [
          original.requestId,
        ]);
      } finally {
        proceed.resolve();
        await holder.query("ROLLBACK");
        holder.release();
      }
      expect(await witnessFact(original.requestId)).toMatchObject({ status: "SEEN" });
      expect(await registerRequestTerminalWitness(pools.marketplace, original)).toBeUndefined();
      expect(await f.restart().recoverExpiredDecisions(unexpected)).toBe(0);
      expect((await decision(original.requestId)).status).toBe("PREPARED");
    }
  });

  it("leaves an old-format decision unenrolled on repeated production bootstrap", async () => {
    const migrationId = "20261123_pricing_evaluated_decision_recovery";
    const id = evaluationDigest("legacy-upgrade");
    await withConfigurationEpochTransaction(pools.pricing, async (db) => {
      await db.query(`ALTER TABLE pricing_evaluated_decisions DROP COLUMN terminal_witness_token,
        DROP CONSTRAINT pricing_evaluated_decisions_status_check,
        ADD CONSTRAINT pricing_evaluated_decisions_status_check CHECK (status IN ('PREPARED', 'COMMITTED', 'ABORTED'))`);
      await db.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = $1", [migrationId]);
      await db.query(
        `INSERT INTO pricing_evaluated_decisions
        (request_id,evaluation_id,command_fingerprint,seller_account_id,budget_day,terminal_binding,evidence,evidence_hash,status)
        VALUES ($1,'evd_synthetic_legacy',$1,$2,$3,'{}','{}',$1,'PREPARED')`,
        [id, accountId, previousDay],
      );
    });
    for (let bootstrap = 0; bootstrap < 2; bootstrap++) {
      await bootstrapContextDatabase(pricingModule, pools.pricing);
      await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
      expect(await decision(id)).toMatchObject({ status: "PREPARED", terminal_witness_token: null });
      expect(await witnessFact(id)).toBeUndefined();
    }
  });

  const handoffs = ["claim", "gate", "publish", "catalog", "inventory", "marketplace", "pricing", "finalize"] as const;
  type Handoff = (typeof handoffs)[number];

  function atHandoff(handoff: Handoff, effect: () => void | Promise<void>, mode: "rollback" | "stop" | "lost") {
    const owner =
      handoff === "claim" || handoff === "publish"
        ? "marketplace"
        : handoff === "gate" || handoff === "finalize"
          ? "pricing"
          : handoff;
    let triggered = false;
    let stopNext = false;
    const overrides = Object.fromEntries(
      names.map((name) => [
        name,
        instrument(pools[name], () => {
          let matching = false;
          return async (run, sql, values) => {
            if (stopNext && sql !== "ROLLBACK") throw stopped;
            if (name === owner && !triggered) {
              matching ||=
                handoff === "claim"
                  ? sql.includes("SET status = 'CLAIMED'")
                  : handoff === "publish"
                    ? sql.includes("SET status = 'ISSUING'")
                    : handoff === "gate"
                      ? sql.includes("terminal_witness_token = $8") && values?.[9] === "RECOVERING"
                      : handoff === "finalize"
                        ? sql.includes("changes_reserved = changes_reserved - 1")
                        : sql.includes("SET status = 'RELEASED', release_status = 'ABORTED'");
              if (matching && sql === "COMMIT") {
                triggered = true;
                if (mode === "rollback") {
                  await effect();
                  throw stopped;
                }
                const result = await run();
                await effect();
                if (mode === "lost") throw lost;
                stopNext = true;
                return result;
              }
            }
            return run();
          };
        }),
      ]),
    );
    return { overrides, triggered: () => triggered };
  }

  async function assertDrained(binding: RequestTerminalBinding) {
    for (const name of names) {
      const rows = await pools[name].query(
        `SELECT 1 FROM event_owner_stream_reservations
        WHERE request_id = $1 AND (status <> 'RELEASED' OR release_status IS DISTINCT FROM 'ABORTED')`,
        [binding.requestId],
      );
      expect(rows.rows).toEqual([]);
    }
    expect(await terminalFact(binding.requestId)).toEqual({ status: "ABORTED", binding });
    expect(await witnessFact(binding.requestId)).toMatchObject({ status: "ISSUED" });
    expect((await decision(binding.requestId)).status).toBe("ABORTED");
  }

  it("replays every durable handoff", async () => {
    const f = await fixture({ kind: "catalog-filter", categoryIds: [categoryId] }, 10);
    await f.catalog.appendToStream({
      streamId: `catalog.item-${catalogItemId}`,
      expectedVersion: 1,
      context,
      events: [{ eventType: "catalog.catalog-item.category-assigned", payload: { catalogItemId, categoryId } }],
    });
    const beforeClaim = await preOpenCrash(f, await f.request("old-catch-before-claim"));
    await oldTerminalStore().abortRequestTerminal(beforeClaim);
    await f.restart().settle(beforeClaim.requestId, beforeClaim.commandFingerprint, false);
    expect(await charge()).toBe(0);
    expect(await witnessFact(beforeClaim.requestId)).toMatchObject({ status: "SEEN" });

    for (const [index, handoff] of handoffs.entries()) {
      for (const mode of ["rollback", "stop", "lost"] as const) {
        const request = await f.request(`${handoff}-${mode}`);
        const original = await preOpenCrash(f, request);
        await reserveMembers(original, ["marketplace", "inventory", "catalog"]);
        const committed = mode !== "rollback";
        const prefix = index + Number(committed);
        const after = await (async () => {
          const errors: unknown[] = [];
          const fault = atHandoff(handoff, () => undefined, mode);
          const result = await f.restart(fault.overrides).recoverExpiredDecisions((_id, error) => errors.push(error));
          expect(fault.triggered(), `${handoff}/${mode}`).toBe(true);
          if (handoff === "finalize" && mode === "stop") {
            expect(result).toBe(1);
            expect(errors).toEqual([]);
          } else {
            expect(result).toBe(0);
            expect(errors).toEqual([mode === "lost" ? lost : stopped]);
          }
          return (await decision(original.requestId)).status;
        })();
        expect(after).toBe(prefix < 2 ? "PREPARED" : prefix < 8 ? "RECOVERING" : "ABORTED");
        expect(await witnessFact(original.requestId)).toMatchObject({
          status: prefix === 0 ? "VIRGIN" : prefix < 3 ? "CLAIMED" : "ISSUED",
        });
        expect((await terminalFact(original.requestId))?.status).toBe(prefix < 3 ? undefined : "ABORTED");
        for (const [ownerIndex, owner] of (["catalog", "inventory", "marketplace", "pricing"] as const).entries()) {
          const rows = (
            await pools[owner].query<{ status: string; release_status: string | null }>(
              "SELECT status, release_status FROM event_owner_stream_reservations WHERE request_id = $1",
              [original.requestId],
            )
          ).rows;
          expect(rows.length).toBeGreaterThan(0);
          expect(
            rows.every((row) =>
              prefix >= ownerIndex + 4
                ? row.status === "RELEASED" && row.release_status === "ABORTED"
                : row.status === "OPEN" && row.release_status === null,
            ),
          ).toBe(true);
        }
        expect(await charge()).toBe(prefix < 8 ? 1 : 0);
        if (prefix === 1 || prefix === 2) {
          await expect(oldTerminalStore().abortRequestTerminal(original)).rejects.toThrow("fenced by recovery");
          await expect(rawOpen(pools.marketplace, original)).rejects.toThrow("fenced by recovery");
        }
        if (prefix >= 2 && prefix < 8) {
          await expect(f.restart().prepare(request.binding, request.listing, context)).rejects.toThrow(
            "already terminal",
          );
          if (prefix === 3) {
            await oldTerminalStore().abortRequestTerminal(original);
            await f.restart().settle(original.requestId, original.commandFingerprint, false);
            expect((await decision(original.requestId)).status).toBe("RECOVERING");
            expect(await charge()).toBe(1);
            const oldUpdate = await pools.pricing.query(
              "UPDATE pricing_evaluated_decisions SET status = 'ABORTED' WHERE request_id = $1 AND status = 'PREPARED'",
              [original.requestId],
            );
            expect(oldUpdate.rowCount).toBe(0);
            const scan = await f.request(`matching-day-old-scan-${handoff}-${mode}`);
            const afterScan = instrument(previousClock(pools.marketplace), () => async (run, sql) => {
              if (sql.includes("INSERT INTO event_request_terminal_witnesses")) throw stopped;
              return run();
            });
            await expect(
              f.restart({ marketplace: afterScan }).prepare(scan.binding, scan.listing, context),
            ).rejects.toBe(stopped);
            expect((await decision(original.requestId)).status).toBe("RECOVERING");
            expect(await charge()).toBe(1);
          }
        }
        expect(await f.restart().recoverExpiredDecisions(unexpected)).toBe(prefix < 8 ? 1 : 0);
        await assertDrained(original);
        expect(await charge()).toBe(0);
      }
    }

    const request = await f.request("late-catalog-reserve");
    const original = await preOpenCrash(f, request);
    const member = original.reservations.find(({ ownerStreamId }) =>
      ownerStreamId.includes("repricing-catalog-category"),
    )!;
    const catalog = await pools.catalog.connect();
    const published = handoffSignal();
    const proceed = handoffSignal();
    const fault = atHandoff(
      "publish",
      async () => {
        published.resolve();
        await proceed.promise;
      },
      "lost",
    );
    const errors: unknown[] = [];
    let first: Promise<number> | undefined;
    let overlapping: Promise<number> | undefined;
    let secondTakeover: Promise<number> | undefined;
    try {
      await catalog.query("BEGIN");
      await reserveOwnerPredicateInTransaction(catalog, member);
      await assertExactPreparationTime(previousClock(pools.marketplace), original);
      first = f.restart(fault.overrides).recoverExpiredDecisions((_id, error) => errors.push(error));
      await Promise.race([published.promise, first]);
      expect(await terminalFact(original.requestId)).toEqual({ status: "ABORTED", binding: original });
      await oldTerminalStore().abortRequestTerminal(original);
      await f.restart().settle(original.requestId, original.commandFingerprint, false);
      expect((await decision(original.requestId)).status).toBe("RECOVERING");
      expect(await charge()).toBe(1);

      overlapping = f.restart().recoverExpiredDecisions(unexpected);
      await waitForBlockedClient(catalog);
      secondTakeover = f.restart().recoverExpiredDecisions(unexpected);
      expect(await charge()).toBe(1);
      await catalog.query("COMMIT");
      expect((await Promise.all([overlapping, secondTakeover])).sort()).toEqual([0, 1]);
      await assertDrained(original);
      expect(await charge()).toBe(0);
      await pools.marketplace.query("DELETE FROM event_request_terminals WHERE request_id = $1", [original.requestId]);
      await expect(oldTerminalStore().abortRequestTerminal(original)).rejects.toThrow("fenced by recovery");
      expect(await terminalFact(original.requestId)).toBeUndefined();
    } finally {
      proceed.resolve();
      await catalog.query("ROLLBACK");
      catalog.release();
      await first;
      await overlapping;
      await secondTakeover;
    }
    expect(errors).toEqual([lost]);
  });

  it("requires exact drain and charge", async () => {
    const f = await fixture({ kind: "catalog-filter", categoryIds: [categoryId] }, 10);
    await f.catalog.appendToStream({
      streamId: `catalog.item-${catalogItemId}`,
      expectedVersion: 1,
      context,
      events: [{ eventType: "catalog.catalog-item.category-assigned", payload: { catalogItemId, categoryId } }],
    });
    const damage = [
      "foreign",
      "recreated",
      "missing-identity",
      "pricing-member",
      "input",
      "committed-member",
      "wrong-day",
      "missing-counter",
      "zero-counter",
    ] as const;
    for (const [index, kind] of damage.entries()) {
      const day = `2026-01-${String(index + 2).padStart(2, "0")}`;
      const request = await f.request(`exact-${kind}`);
      const original = await preOpenCrash(f, request, true, `${day}T12:00:00.000Z`);
      const id = original.requestId;
      await reserveMembers(original, ["inventory"]);
      const fault = atHandoff("publish", () => undefined, "lost");
      const errors: unknown[] = [];
      await f.restart(fault.overrides).recoverExpiredDecisions((_id, error) => errors.push(error));
      expect(fault.triggered()).toBe(true);
      expect((await decision(id)).status).toBe("RECOVERING");
      const catalog = await evaluationOwnerIdentity(pools.catalog, "catalog");
      const checkBudget = kind !== "missing-counter" && kind !== "zero-counter";
      switch (kind) {
        case "foreign":
        case "recreated":
        case "missing-identity":
          await pools.catalog.query("DELETE FROM event_configuration_store_identity WHERE singleton");
          if (kind !== "missing-identity")
            await pools.catalog.query(
              "INSERT INTO event_configuration_store_identity VALUES (true,$1,'synthetic-replacement')",
              [kind === "foreign" ? "foreign" : "catalog"],
            );
          break;
        case "pricing-member":
          await pools.pricing.query(
            "DELETE FROM event_owner_stream_reservations WHERE request_id = $1 AND purpose = 'pricing-daily-change-budget'",
            [id],
          );
          break;
        case "input":
          await pools.inventory.query(
            "UPDATE event_owner_stream_reservations SET operation_id = 'foreign' WHERE request_id = $1",
            [id],
          );
          break;
        case "committed-member":
          await pools.inventory.query(
            "UPDATE event_owner_stream_reservations SET status = 'RELEASED', release_status = 'COMMITTED' WHERE request_id = $1",
            [id],
          );
          break;
        case "wrong-day":
          await withConfigurationEpochTransaction(pools.pricing, (db) =>
            reserveDailyChangesInTransaction(db, accountId, "2026-01-31", 10, 2),
          );
          await pools.pricing.query(
            "UPDATE pricing_evaluated_decisions SET budget_day = '2026-01-31' WHERE request_id = $1",
            [id],
          );
          break;
        case "missing-counter":
          await pools.pricing.query(
            "DELETE FROM pricing_repricing_daily_change_budgets WHERE seller_account_id = $1 AND budget_day = $2",
            [accountId, day],
          );
          break;
        case "zero-counter":
          await pools.pricing.query(
            "UPDATE pricing_repricing_daily_change_budgets SET changes_reserved = 0 WHERE seller_account_id = $1 AND budget_day = $2",
            [accountId, day],
          );
          break;
      }
      const during = () => f.restart().recoverExpiredDecisions((_id, error) => errors.push(error));
      await during();
      await during();
      expect((await decision(id)).status, kind).toBe("RECOVERING");
      expect(await charge(day), kind).toBe(checkBudget ? 1 : kind === "zero-counter" ? 0 : undefined);
      if (kind === "wrong-day") expect(await charge("2026-01-31")).toBe(2);
      expect(await terminalFact(id)).toEqual({ status: "ABORTED", binding: original });
      if (index < 3) {
        await pools.catalog.query("DELETE FROM event_configuration_store_identity WHERE singleton");
        await pools.catalog.query("INSERT INTO event_configuration_store_identity VALUES (true,$1,$2)", [
          catalog.storeId,
          catalog.incarnation,
        ]);
      }
      // Isolate the next fault while retaining all decision and counter facts.
      await pools.marketplace.query("DELETE FROM event_request_terminals WHERE request_id = $1", [id]);
    }
    const day = "2026-01-21";
    const neverReserved = await preOpenCrash(f, await f.request("never-reserved"), true, `${day}T12:00:00.000Z`);
    await f.restart().recoverExpiredDecisions(unexpected);
    await f.restart().recoverExpiredDecisions(unexpected);
    await assertDrained(neverReserved);
    expect(await charge(day)).toBe(0);
  });

  it("continues the page after failure", async () => {
    const f = await fixture(dryRunBody.scope, 10);
    const key = (sequence: number) => sequence.toString(16).padStart(64, "0");
    const add = async (sequence: number, expired = true) =>
      preOpenCrash(f, await f.request(`page-${sequence}`, f.identity, catalogItemId, key(sequence)), expired);
    const failing = await add(1);
    const healthy = await add(2);
    const unexpired = await add(3, false);
    const last = await add(70);
    for (let i = 4; i < 70; i++) {
      await pools.pricing.query(
        `INSERT INTO pricing_evaluated_decisions
        (request_id,evaluation_id,command_fingerprint,seller_account_id,budget_day,terminal_binding,evidence,evidence_hash,status)
        SELECT $1,$2,command_fingerprint,$3,$4,terminal_binding,evidence,evidence_hash,$5
        FROM pricing_evaluated_decisions WHERE request_id = $6`,
        [
          key(i),
          `evd_synthetic_page_${i}`,
          `acc_held_${i % 2}`,
          [previousDay, "2026-01-03", unexpired.preparationNotBefore!.slice(0, 10)][i % 3],
          i % 2 ? "PREPARED" : "RECOVERING",
          healthy.requestId,
        ],
      );
    }
    const saved = async () =>
      (
        await pools.pricing.query<{ last_request_id: string }>(
          "SELECT last_request_id FROM pricing_evaluated_decision_recovery_cursor WHERE singleton",
        )
      ).rows[0]?.last_request_id;
    const calls = new Set<unknown>();
    const errors: string[] = [];
    const refused = instrument(pools.pricing, () => async (run, sql, values) => {
      if (sql.startsWith("SELECT evaluation_id, terminal_binding")) {
        calls.add(values?.[0]);
        if (values?.[0] === failing.requestId) throw stopped;
      }
      return run();
    });
    const run = async () => {
      calls.clear();
      const count = await f.restart({ pricing: refused }).recoverExpiredDecisions((id, error) => {
        expect(error).toBe(stopped);
        errors.push(id);
      });
      expect(calls.size).toBeLessThanOrEqual(32);
      return count;
    };
    expect(await run()).toBe(1);
    expect(errors).toEqual([failing.requestId]);
    expect(await saved()).toBe(key(32));
    await assertDrained(healthy);
    expect(await run()).toBe(0);
    expect(await saved()).toBe(key(64));
    expect(await run()).toBe(1);
    expect(await saved()).toBe(key(70));
    await assertDrained(last);
    expect(await run()).toBe(0);
    expect(calls.has(failing.requestId)).toBe(true);
    expect(errors).toEqual([failing.requestId, failing.requestId]);
    expect((await decision(unexpired.requestId)).status).toBe("PREPARED");
  });

  function platformWrite(suffix: string, expectedVersion: AppendToStreamInput["expectedVersion"]): AppendToStreamInput {
    return {
      streamId: `platform-policy.document-pol_synthetic_${suffix}`,
      expectedVersion,
      context,
      events: [
        {
          eventType: "platform-policy.document.created",
          payload: {
            policyKey: repricingEnginePolicy.policyKey,
            documentId: `pol_synthetic_${suffix}`,
            contextName: "pricing",
            schemaSummary: "Synthetic policy",
            status: "active",
            value: repricingEnginePolicy.defaultValue,
            effectiveFrom: previousTime,
            effectiveUntil: null,
            actorUserId: context.audit.performedByUserId,
          },
        },
      ],
    };
  }

  async function selectorEpoch() {
    return (
      await pools.pricing.query<{ epoch: number }>("SELECT epoch FROM pricing_repricing_standing WHERE key = $1", [
        repricingPlatformSelector,
      ])
    ).rows[0]?.epoch;
  }

  async function journalTail() {
    return (
      await pools.pricing.query<{ kind: string }>(
        `SELECT record->>'kind' AS kind
      FROM event_configuration_guard_history WHERE role = 'source' AND key = $1 ORDER BY sequence DESC LIMIT 1`,
        [repricingPlatformSelector],
      )
    ).rows[0]?.kind;
  }

  async function streamVersion(streamId: string) {
    return (
      await pools.pricing.query<{ version: string }>(
        "SELECT current_version::text AS version FROM event_store_streams WHERE stream_id = $1",
        [streamId],
      )
    ).rows[0]?.version;
  }

  it("recovers only a rolled-back append", async () => {
    const f = await fixture(dryRunBody.scope, 10);
    const store = createPricingPlatformPolicyStore(pools.pricing, f.ports).eventStore;
    for (const form of ["single", "atomic"] as const) {
      const old = await f.request(`old-grant-${form}`);
      const stale = await f.authority.prepare(old.binding, old.listing, context);
      const originalEpoch = await selectorEpoch();
      const denied = platformWrite(`denied-${form}`, 99);
      const other: AppendToStreamInput = {
        ...denied,
        streamId: "synthetic.atomic-rolled-back",
        expectedVersion: "no_stream",
        events: [{ eventType: "synthetic.atomic.rolled-back", payload: {} }],
      };
      await expect(
        form === "single" ? store.appendToStream(denied) : store.appendToStreams!([other, denied]),
      ).rejects.toMatchObject({ code: "concurrency_conflict" });
      for (const input of [other, denied]) {
        expect(await store.readStream({ streamId: input.streamId })).toEqual([]);
        expect(await streamVersion(input.streamId)).toBeUndefined();
      }
      expect(await selectorEpoch()).toBe(originalEpoch! + 1);
      expect(await journalTail()).toBe("APPLIED");
      const commit = (name: string, grant: typeof stale) =>
        f.market.appendToStreams!([
          {
            streamId: `synthetic.${name}`,
            expectedVersion: "no_stream",
            context,
            requestTerminal: grant.terminal,
            configurationGrants: grant.grants,
            events: [{ eventType: "synthetic.evaluation.accepted", payload: {} }],
          },
        ]);
      await expect(commit(`stale-${form}`, stale)).rejects.toThrow("closed-through");
      const next = await f.request(`fresh-grant-${form}`);
      const fresh = await f.restart().prepare(next.binding, next.listing, context);
      expect(fresh.grants.find(({ key }) => key === repricingPlatformSelector)?.epoch).toBe(originalEpoch! + 1);
      await commit(`fresh-${form}`, fresh);
      expect(await terminalFact(fresh.terminal.requestId)).toMatchObject({ status: "COMMITTED" });
    }
  });

  it.each(["lost-reply", "failed-lookup", "newer-install", "incomplete-closure", "missing-standing"] as const)(
    "does not repair the selector on %s",
    async (control) => {
      const f = await fixture();
      if (control === "missing-standing") {
        const { standing } = createPricingPlatformPolicyStore(pools.pricing, f.ports);
        const { epochs } = await standing.source();
        await epochs.open(repricingPlatformSelector);
      }
      const request = await f.request(`selector-${control}`);
      await f.authority.prepare(request.binding, request.listing, context);
      expect(await selectorEpoch()).toBe(0);
      const original = platformWrite(control, control === "lost-reply" ? "no_stream" : 99);
      let observed = false;
      let readFailed = false;
      const pricing = instrument(pools.pricing, () => {
        let install = false;
        return async (run, sql, values) => {
          if (
            sql.includes("INSERT INTO event_configuration_guard_history") &&
            values?.[1] === repricingPlatformSelector &&
            String(values[3]).includes('"kind":"APPLIED"')
          )
            install = true;
          if (
            control === "failed-lookup" &&
            sql.startsWith("SELECT epoch FROM pricing_repricing_standing WHERE key = $1 AND incarnation")
          ) {
            readFailed = true;
            throw stopped;
          }
          const result = await run();
          if (!install || observed) return result;
          if (sql === "COMMIT" && control === "lost-reply") {
            observed = true;
            throw lost;
          }
          if (sql !== "ROLLBACK") return result;
          observed = true;
          if (control === "newer-install") {
            const normal = createPricingPlatformPolicyStore(pools.pricing, f.ports).eventStore;
            await normal.appendToStream(platformWrite("newer", "no_stream"));
          } else if (control === "incomplete-closure") {
            await withConfigurationEpochTransaction(pools.pricing, async (db) => {
              await db.query(
                `DELETE FROM event_configuration_guard_history WHERE role = 'source' AND key = $1 AND record->>'kind' = 'RECEIPT'`,
                [repricingPlatformSelector],
              );
              await db.query(
                `UPDATE event_configuration_journal_heads head SET sequence = prior.sequence, digest = prior.digest
                FROM event_configuration_guard_history prior WHERE head.role = 'source' AND head.key = $1
                  AND prior.role = head.role AND prior.key = head.key AND prior.sequence = head.sequence - 1`,
                [repricingPlatformSelector],
              );
            });
          } else if (control === "missing-standing") {
            await pools.pricing.query("DELETE FROM pricing_repricing_standing WHERE key = $1", [
              repricingPlatformSelector,
            ]);
          }
          return result;
        };
      });
      const store = createPricingPlatformPolicyStore(pricing, f.ports).eventStore;
      const result = store.appendToStream(original);
      if (control === "lost-reply") await expect(result).rejects.toBe(lost);
      else await expect(result).rejects.toMatchObject({ code: "concurrency_conflict" });
      expect(observed).toBe(true);
      expect(readFailed).toBe(control === "failed-lookup");
      expect(await streamVersion(original.streamId)).toBe(control === "lost-reply" ? "1" : undefined);
      expect(await selectorEpoch()).toBe(
        control === "missing-standing" ? undefined : control === "newer-install" || control === "lost-reply" ? 1 : 0,
      );
      expect(await journalTail()).toBe(
        control === "newer-install" || control === "lost-reply"
          ? "APPLIED"
          : control === "incomplete-closure"
            ? "CLOSING"
            : "RECEIPT",
      );
    },
  );

  it("prepares both promises atomically, shares the worker cap and refunds only known ABORTED", async () => {
    const f = await fixture();
    const first = await f.request("first");
    const prepared = await f.authority.prepare(first.binding, first.listing, context);
    expect(prepared.terminal.reservations.map(({ purpose }) => purpose)).toEqual(
      expect.arrayContaining(["pricing-evaluated-decision", "pricing-daily-change-budget"]),
    );
    expect(await f.charges()).toBe(1);
    const day = prepared.terminal.preparationNotBefore!.slice(0, 10);
    expect(
      await withConfigurationEpochTransaction(pools.pricing, (db) =>
        reserveDailyChangesInTransaction(db, accountId, day, 1, 1),
      ),
    ).toBe(0);
    const later = await f.request("later");
    await expect(f.authority.prepare(later.binding, later.listing, context)).rejects.toThrow("budget is exhausted");
    expect(await f.status()).toEqual(["PREPARED"]);
    await f.authority.settle(first.binding.requestId, first.binding.commandFingerprint, true);
    expect(await f.status()).toEqual(["ABORTED"]);
    expect(await f.charges()).toBe(0);
    await expect(f.authority.prepare(later.binding, later.listing, context)).resolves.toBeDefined();
  });

  it("uses consumer DB time and refuses a foreign incarnation without durable decision authority", async () => {
    const f = await fixture();
    const bad = await f.request("foreign", { ...f.identity, incarnation: "synthetic-foreign" });
    await expect(f.authority.prepare(bad.binding, bad.listing, context)).rejects.toThrow();
    expect(await f.status()).toEqual([]);
    const good = await f.request("time");
    const result = await f.authority.prepare(good.binding, good.listing, context);
    const now = (
      await pools.marketplace.query<{ stamp: Date }>("SELECT clock_timestamp() AS stamp")
    ).rows[0]!.stamp.getTime();
    expect(Date.parse(result.terminal.preparationNotBefore!)).toBeLessThanOrEqual(now);
    expect(
      Date.parse(result.terminal.preparationDeadline) - Date.parse(result.terminal.preparationNotBefore!),
    ).toBeLessThanOrEqual(60_000);
    await expect(
      f.authority.prepare({ ...good.binding, commandFingerprint: "f".repeat(64) }, good.listing, context),
    ).rejects.toThrow("another command");
  });

  it("keeps a prepared charge when original-terminal lookup is unknown and never creates a cohort guard", async () => {
    const f = await fixture();
    const request = await f.request("unknown");
    const original = (await f.authority.prepare(request.binding, request.listing, context)).terminal;
    await pools.marketplace.query("DELETE FROM event_request_terminals WHERE request_id = $1", [
      request.binding.requestId,
    ]);
    await f.restart().settle(request.binding.requestId, request.binding.commandFingerprint, true);
    expect(await f.status()).toEqual(["PREPARED"]);
    expect(await f.charges()).toBe(1);
    const keys = (
      await pools.pricing.query<{ key: string }>("SELECT key FROM pricing_repricing_standing ORDER BY key")
    ).rows.map(({ key }) => key);
    expect(keys).toEqual([`repricing-account/${accountId}`, "repricing-platform-policy/pricing.repricing-engine"]);
    expect(original.reservations.some(({ resourceKey }) => resourceKey.includes("all-accounts"))).toBe(false);
  });

  it("checks the exclusive deadline after the global append lock, not before waiting", async () => {
    const f = await fixture();
    const request = await f.request("expired");
    const prepared = await f.authority.prepare(request.binding, request.listing, context);
    const lock = await pools.marketplace.connect();
    let append: Promise<unknown> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock($1::bigint)", [EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY]);
      const end = (await lock.query<{ stamp: Date }>("SELECT clock_timestamp() + interval '1 second' AS stamp"))
        .rows[0]!.stamp;
      const expiresDuringWait: RequestTerminalBinding = {
        ...prepared.terminal,
        preparationDeadline: end.toISOString(),
      };
      await pools.marketplace.query("UPDATE event_request_terminals SET binding = $2 WHERE request_id = $1", [
        expiresDuringWait.requestId,
        expiresDuringWait,
      ]);
      append = f.market.appendToStreams!([
        {
          streamId: "synthetic.evaluation-did-not-commit",
          expectedVersion: "no_stream",
          context,
          requestTerminal: expiresDuringWait,
          configurationGrants: prepared.grants,
          events: [{ eventType: "synthetic.evaluation.accepted", payload: {} }],
        },
      ]).catch((error: unknown) => error);
      await lock.query("SELECT pg_sleep_until($1::timestamptz)", [end]);
      const waited = (
        await lock.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks AS locks
          WHERE NOT locks.granted AND locks.locktype = 'advisory'
          AND pg_backend_pid() = ANY(pg_blocking_pids(locks.pid))) AS waiting`,
        )
      ).rows[0]!.waiting;
      expect(waited).toBe(true);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      if (append) expect(await append).toMatchObject({ message: expect.stringContaining("DB-time window") });
    }
    expect(await f.market.readStream({ streamId: "synthetic.evaluation-did-not-commit" })).toEqual([]);
  });

  it("shortens the evaluation deadline to its captured Market Estimate expiry", async () => {
    const f = await fixture();
    const request = await f.request("earlier-expiry");
    const freshness = (
      await pools.pricing.query<{ fresh_until: Date }>(
        `INSERT INTO pricing_market_price_estimates (catalog_catalog_item_id, product_id, estimate_version,
         window_started_at, window_ended_at, amount, currency_code, confidence, estimated_at, fresh_until, disclosure, updated_at)
       VALUES ($1,$2,1,now()-interval '1 day',now(),15,'USD','high',now(),
         date_trunc('milliseconds', clock_timestamp()) + interval '20 seconds','internal',now())
       RETURNING fresh_until`,
        [catalogItemId, productId],
      )
    ).rows[0]!.fresh_until.toISOString();
    const { terminal } = await f.authority.prepare(request.binding, request.listing, context);
    const nextDay = new Date(
      Date.parse(`${terminal.preparationNotBefore!.slice(0, 10)}T00:00:00.000Z`) + 86_400_000,
    ).toISOString();
    expect(terminal.preparationDeadline).toBe(freshness < nextDay ? freshness : nextDay);
  });

  it("classifies competitors from the last committed category while the Catalog write is pending", async () => {
    const f = await fixture();
    const competitor = "acc_competitor_synthetic";
    await f.install(competitor, { kind: "catalog-filter", categoryIds: [categoryId] });
    await pools.pricing.query(
      `INSERT INTO pricing_market_listing_inputs (listing_id, seller_account_id, catalog_catalog_item_id,
         product_id, price_amount, price_currency_code, quantity_cap, status, updated_at, last_stream_version)
       VALUES ('lst_competitor_synthetic',$1,$2,$3,9,'USD',1,'active',now(),1)`,
      [competitor, catalogItemId, productId],
    );
    const capture = async (suffix: string) => {
      const request = await f.request(suffix);
      await f.authority.prepare(request.binding, request.listing, context);
      const { evidence } = (
        await pools.pricing.query<{
          evidence: { competitors: { generation: string; parts: { asks: { pricingMode: string }[] }[] } };
        }>("SELECT evidence FROM pricing_evaluated_decisions WHERE request_id = $1", [request.binding.requestId])
      ).rows[0]!;
      await f.authority.settle(request.binding.requestId, request.binding.commandFingerprint, true);
      return { generation: evidence.competitors.generation, mode: evidence.competitors.parts[0]?.asks[0]?.pricingMode };
    };
    const before = await capture("before-category");
    expect(before.mode).toBe("hard");
    const writer = await pools.catalog.connect();
    try {
      await writer.query("BEGIN");
      await f.catalog.appendToStreamInTransaction(writer, {
        streamId: `catalog.item-${catalogItemId}`,
        expectedVersion: 1,
        context,
        events: [{ eventType: "catalog.catalog-item.category-assigned", payload: { catalogItemId, categoryId } }],
      });
      expect(await capture("pending-category")).toEqual(before);
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
    const after = await capture("committed-category");
    expect(after.mode).toBe("derived");
    expect(after.generation).not.toBe(before.generation);
  });

  it("aborts the changed Catalog key and leaves another Item for the same seller free to commit", async () => {
    const f = await fixture({ kind: "catalog-filter", categoryIds: [categoryId] }, 2);
    const other = "cat_synthetic_unrelated";
    await f.createCatalogItem(other);
    for (const item of [catalogItemId, other]) {
      await f.catalog.appendToStream({
        streamId: `catalog.item-${item}`,
        expectedVersion: 1,
        context,
        events: [{ eventType: "catalog.catalog-item.category-assigned", payload: { catalogItemId: item, categoryId } }],
      });
    }
    const affected = await f.request("affected");
    const independent = await f.request("independent", f.identity, other);
    await f.authority.prepare(affected.binding, affected.listing, context);
    const { terminal, grants } = await f.authority.prepare(independent.binding, independent.listing, context);
    const catalogWriter = createPostgresEventStore({
      pool: pools.catalog,
      ownerPredicates: {
        consumerPool: pools.marketplace,
        keys: () => [ownerPredicateKey("repricing-catalog-category", catalogItemId, categoryId)],
      },
    });
    await catalogWriter.appendToStream({
      streamId: `catalog.item-${catalogItemId}`,
      expectedVersion: 2,
      context,
      events: [{ eventType: "catalog.catalog-item.category-removed", payload: { catalogItemId, categoryId } }],
    });
    await f.market.appendToStreams!([
      {
        streamId: "synthetic.independent-evaluation",
        expectedVersion: "no_stream",
        context,
        requestTerminal: terminal,
        configurationGrants: grants,
        events: [{ eventType: "synthetic.evaluation.accepted", payload: {} }],
      },
    ]);
    await f.authority.settle(affected.binding.requestId, affected.binding.commandFingerprint, false);
    await f.authority.settle(independent.binding.requestId, independent.binding.commandFingerprint, false);
    expect((await f.status()).sort()).toEqual(["ABORTED", "COMMITTED"]);
    expect(await f.charges()).toBe(1);
  });

  it("orders the worker's durable Product freeze against the original Pricing terminal", async () => {
    const f = await fixture();
    const product = { catalogItemId, productId };
    const now = (
      await pools.marketplace.query<{ stamp: Date }>("SELECT clock_timestamp() AS stamp")
    ).rows[0]!.stamp.toISOString();
    const policy = repricingEnginePolicy.defaultValue;
    for (let i = 1; i < policy.spiralBreakerRounds; i++)
      await recordProductRoundDirection(pools.pricing, product, "up", policy, now, pools.marketplace);
    const request = await f.request("freeze");
    await f.authority.prepare(request.binding, request.listing, context);
    expect(
      await recordProductRoundDirection(pools.pricing, product, "up", policy, now, pools.marketplace),
    ).not.toBeNull();
    await expect(f.restart().prepare(request.binding, request.listing, context)).rejects.toThrow();
    await f.restart().settle(request.binding.requestId, request.binding.commandFingerprint, false);
    expect(await f.status()).toEqual(["ABORTED"]);
    expect(await f.charges()).toBe(0);
    const fresh = await f.request("frozen");
    await expect(f.authority.prepare(fresh.binding, fresh.listing, context)).rejects.toThrow("Product is frozen");
  });

  it.each(["pricing-evaluated-decision", "pricing-daily-change-budget"] as const)(
    "restart refuses a partial preparation without its %s member",
    async (purpose) => {
      const f = await fixture();
      const request = await f.request(purpose);
      const prepared = await f.authority.prepare(request.binding, request.listing, context);
      const missing = prepared.terminal.reservations.find((member) => member.purpose === purpose)!;
      await pools.pricing.query("DELETE FROM event_owner_stream_reservations WHERE reservation_id = $1", [
        missing.reservationId,
      ]);
      await expect(f.restart().prepare(request.binding, request.listing, context)).rejects.toThrow("incomplete");
      expect(await f.status()).toEqual(["PREPARED"]);
      expect(await f.charges()).toBe(1);
    },
  );
});
