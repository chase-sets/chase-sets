import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPostgresEventStore,
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import {
  createCheckpointKey,
  eventSubscriptionSchemaSql,
  resolveModuleSubscriptions,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { encodePolicyValue } from "@chase-sets/platform-policy/define-policy";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { module as pricingModule } from "../../../index";
import { createRepricingActivityDigestRunner, digestedFactSql } from "../api/activity-digest";
import { buildRepricingEvaluationProjectionHandlers } from "../read-model/projection";
import { compactListingOutcomeFacts } from "../read-model/listing-outcomes";
import { pricingRepricingEngineSchemaMigrations } from "../read-model/schema";
import { decodeRepricingManagementPolicyValue } from "../domain/management-policy";
import {
  repricingPolicyEvaluatedEventType,
  type RepricingPolicyEvaluatedEvent,
  type RepricingPolicyListingTrace,
} from "../domain/fact";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const D = "2026-09-20";
const context: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_a" as never },
};
const key = createCheckpointKey({
  projectionName: "pricing-repricing-evaluation-projection",
  sourceContextName: "pricing",
  subscriptionVersion: 1,
});
const policies: Pick<PolicyRuntime, "resolvePolicy"> = {
  resolvePolicy: async (definition) => ({
    policyKey: definition.policyKey,
    value: definition.decodeValue(encodePolicyValue({ ...definition.defaultValue, digestSettleMinutes: 1 })),
    source: "fallback",
    documentId: null,
    effectiveFrom: null,
    effectiveUntil: null,
    resolvedAt: `${D}T12:00:00.000Z`,
  }),
};
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
type QueryHook = (
  stage: "before" | "after",
  sql: string,
  values: readonly unknown[],
  rows?: readonly unknown[],
) => Promise<void>;
function observedPool(pool: PgTransactionalPool, hook: QueryHook): PgTransactionalPool {
  const queryable = (db: PgQueryable): PgQueryable => ({
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      await hook("before", sql, values);
      const result = await db.query<Row>(sql, values);
      await hook("after", sql, values, result.rows);
      return result;
    },
  });
  return {
    ...queryable(pool),
    connect: async () => {
      const client = await pool.connect();
      return { ...queryable(client), release: (error) => client.release(error) };
    },
  };
}
const isClaim = (sql: string) => sql.includes("INSERT INTO pricing_repricing_digest_windows");
const isFence = (sql: string) => sql.includes("WITH append_fence");
const isNewest = (sql: string) => sql.includes("ORDER BY window_day DESC LIMIT 1");

describeDb("repricing activity digest PostgreSQL timelines", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  let db: PgTransactionalPool;
  let store: EventStore;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "repricing_digest_7913");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    db = pools.pricing;
    await resetMultiContextTestSchemas(pools);
    await db.query(pricingModule.schemaSql);
    await db.query(eventSubscriptionSchemaSql);
    store = createPostgresEventStore({ pool: db });
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.query(`TRUNCATE pricing_repricing_digest_window_members, pricing_repricing_digest_windows,
      pricing_repricing_listing_outcome_facts, pricing_repricing_listing_outcomes,
      pricing_repricing_policy_evaluations, event_subscription_checkpoints, event_store_events, event_store_streams CASCADE`);
    await db.query("SELECT setval('event_store_events_global_position_seq', 100, true)");
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  const run = (now: string, pool = db, eventStore = store) =>
    createRepricingActivityDigestRunner({ pool, eventStore, policies })({ now });
  const activate = () => run(`${D}T12:00:00.000Z`);
  const windows = async () =>
    (
      await db.query(
        `SELECT window_day::text, kind, assigned_floor::text, captured_at, emitted_at, updated_at
     FROM pricing_repricing_digest_windows ORDER BY window_day`,
      )
    ).rows;
  const members = async () =>
    (
      await db.query<{ window_day: string; global_position: string }>(
        `SELECT window_day::text, global_position::text FROM pricing_repricing_digest_window_members
     ORDER BY window_day, global_position`,
      )
    ).rows;
  const positions = async (day: string) =>
    (await members()).filter((row) => row.window_day === day).map((row) => row.global_position);
  const digests = async () =>
    (
      await db.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM event_store_events WHERE event_type = 'pricing.repricing-activity.digest-requested'
     ORDER BY payload->>'day', payload->>'sellerAccountId'`,
      )
    ).rows.map((row) => row.payload);
  async function checkpoint(position: string, version = 1) {
    await db.query(
      `INSERT INTO event_subscription_checkpoints
      (checkpoint_key, projection_name, source_context_name, subscription_version, last_global_position, updated_at)
      VALUES ($1, 'pricing-repricing-evaluation-projection', 'pricing', $2, $3, now())
      ON CONFLICT (checkpoint_key) DO UPDATE SET last_global_position = EXCLUDED.last_global_position`,
      [version === 1 ? key : key.replace(":v1", `:v${version}`), version, position],
    );
  }
  async function projectThrough(position: string) {
    const events = await store.readAll({ eventTypes: [repricingPolicyEvaluatedEventType] });
    expect(events.length).toBeLessThan(500);
    for (const event of events.filter((event) => BigInt(event.globalPosition) <= BigInt(position))) {
      await buildRepricingEvaluationProjectionHandlers(db)[repricingPolicyEvaluatedEventType]!(toTransportEvent(event));
    }
    await checkpoint(position);
  }
  async function append(
    id: string,
    recordedAt: string,
    options: {
      seller?: string;
      listing?: string;
      evaluatedAt?: string;
      traces?: readonly RepricingPolicyListingTrace[];
    } = {},
  ) {
    const evaluatedAt = options.evaluatedAt ?? recordedAt;
    const trace: RepricingPolicyListingTrace = {
      listingId: options.listing ?? `listing-${id}`,
      currentPriceAmount: "10.00",
      targetPriceAmount: "5.00",
      ruleIndex: 0,
      anchor: null,
      exhaustedAnchors: [],
      clamps: { floor: false, ceiling: false, maxMove: false },
      flags: [],
      outcome: "changed",
      skipReason: null,
    };
    const data: RepricingPolicyEvaluatedEvent["data"] = {
      schemaVersion: 1,
      evaluationId: id,
      policyId: `policy-${options.seller ?? "a"}`,
      policyRevision: "1",
      sellerAccountId: options.seller ?? "acc_a",
      catalogItemId: "catalog-a",
      productId: "product-a",
      trigger: { kind: "daily-drift-sweep", eventId: id, signalVersion: "1", occurredAt: evaluatedAt },
      listingsEvaluated: options.traces?.length ?? 1,
      listingsChanged: 1,
      listingsSkipped: 0,
      listings: options.traces ?? [trace],
      signalToEvaluationLatencyMs: 0,
      evaluatedAt,
    };
    const producer = createPostgresEventStore({ pool: db, now: () => recordedAt as never });
    return (
      await producer.appendToStream({
        streamId: `pricing.repricing-evaluation-${id}`,
        expectedVersion: "no_stream",
        context,
        events: [{ eventType: repricingPolicyEvaluatedEventType, payload: data, occurredAt: evaluatedAt as never }],
      })
    )[0]!;
  }
  async function waitForBlockedClaim() {
    await vi.waitFor(async () => {
      const blocked = await db.query<{ count: number }>(`SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND query LIKE '%INSERT INTO pricing_repricing_digest_windows%'
          AND cardinality(pg_blocking_pids(pid)) > 0 AND wait_event_type = 'Lock'`);
      expect(blocked.rows[0]!.count).toBeGreaterThan(0);
    });
  }
  async function compact() {
    const emitted = (
      await db.query<{ day: string }>(`SELECT max(window_day)::text AS day
      FROM pricing_repricing_digest_windows WHERE emitted_at IS NOT NULL`)
    ).rows[0]!.day;
    await withPgTransaction(db, (tx) =>
      compactListingOutcomeFacts(tx, {
        retainFrom: "2026-06-22T00:00:00.000Z",
        digestedSql: digestedFactSql(emitted),
      }),
    );
  }
  const factIds = async () =>
    (
      await db.query<{ evaluation_id: string }>(
        "SELECT evaluation_id FROM pricing_repricing_listing_outcome_facts ORDER BY evaluation_id",
      )
    ).rows.map((row) => row.evaluation_id);

  it("activation baseline, ledgered schema and actual producer subscription v1 despite revision 2", async () => {
    const services = pricingModule.createServices(db, {
      tcgplayerMarketTransport: { kind: "not-mounted" },
      tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
      commercialTermsResolver: createNoopCommercialTermsResolver(),
      channelConnectionIdentityReader: { resolve: async () => null },
    });
    const sourceNames = [
      ...new Set(pricingModule.buildSubscriptions!(services).map((entry) => entry.sourceContextName)),
    ].filter((name) => name !== "pricing");
    const subscription = resolveModuleSubscriptions([
      {
        contextName: "pricing",
        module: pricingModule,
        services,
        pool: db,
        projectionHandlerSets: pricingModule.projectionHandlerSets!(services),
      },
      ...sourceNames.map((contextName) => ({
        contextName,
        mountRole: "source-only" as const,
        module: pricingModule,
        services: undefined,
        pool: db,
        projectionHandlerSets: [],
      })),
    ]).find((entry) => entry.projectionName === "pricing-repricing-evaluation-projection");
    expect(subscription?.checkpointKey).toBe(key);
    expect(subscription?.subscriptionVersion).toBe(1);
    const old = await append("before", `${D}T01:00:00Z`);
    await activate();
    expect(await windows()).toMatchObject([
      { window_day: "2026-09-19", kind: "baseline", assigned_floor: old.globalPosition },
    ]);
    expect(await members()).toEqual([]);
    expect(await digests()).toEqual([]);
    const event = await append("after", `${D}T13:00:00Z`);
    await projectThrough(event.globalPosition);
    await run("2026-09-21T00:01:00Z");
    expect(await positions(D)).toEqual([event.globalPosition]);
    expect(await digests()).toMatchObject([{ day: D, listingsChanged: 1 }]);
    const migration = pricingRepricingEngineSchemaMigrations.find(
      (entry) => entry.migrationId === "20260922_pricing_repricing_digest",
    )!;
    await db.query("DROP TABLE pricing_repricing_digest_window_members, pricing_repricing_digest_windows");
    for (const statement of migration.statements) await db.query(statement);
    await db.query(pricingModule.schemaSql);
    expect(await windows()).toEqual([]);
    expect(await members()).toEqual([]);
  });

  it("launch dials default independently, reject invalid revisions, and use ten-minute settle and six-hour warning", async () => {
    expect(decodeRepricingManagementPolicyValue({ floorBindingAlertDays: 9 })).toEqual({
      floorBindingAlertDays: 9,
      digestSettleMinutes: 10,
      digestLagWarnHours: 6,
    });
    expect(
      decodeRepricingManagementPolicyValue({ digestSettleMinutes: undefined, digestLagWarnHours: undefined }),
    ).toEqual({ floorBindingAlertDays: 7, digestSettleMinutes: 10, digestLagWarnHours: 6 });
    for (const [name, maximum] of [
      ["digestSettleMinutes", 120],
      ["digestLagWarnHours", 48],
    ] as const) {
      for (const value of [1, maximum])
        expect(decodeRepricingManagementPolicyValue({ [name]: value })[name]).toBe(value);
      for (const value of [null, 0, -1, maximum + 1, 1.5, "1", true, [], {}]) {
        expect(() => decodeRepricingManagementPolicyValue({ [name]: value })).toThrow(name);
      }
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const launch = createRepricingActivityDigestRunner({
      pool: db,
      eventStore: store,
      policies: createPolicyRuntime({ eventStore: store, db }),
    });
    await launch({ now: `${D}T12:00:00Z` });
    await append("launch", `${D}T13:00:00Z`);
    await launch({ now: "2026-09-21T00:09:59Z" });
    expect(await windows()).toHaveLength(1);
    await launch({ now: "2026-09-21T00:10:00Z" });
    expect(await positions(D)).toEqual(["101"]);
    await launch({ now: "2026-09-21T05:59:59Z" });
    expect(warn).not.toHaveBeenCalled();
    await launch({ now: "2026-09-21T06:00:00Z" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("membership interleaving through two real stores, inverse=%s", async (inverse) => {
    await activate();
    await append("101", inverse ? `${D}T23:59:59.9Z` : "2026-09-21T00:00:00.5Z");
    await append("102", inverse ? "2026-09-21T00:00:00.5Z" : `${D}T23:59:59.9Z`);
    await projectThrough("102");
    await run("2026-09-21T00:01:00Z");
    expect(await positions(D)).toEqual([inverse ? "101" : "102"]);
    expect((await windows())[1]).toMatchObject({ assigned_floor: inverse ? "101" : "100" });
    await run("2026-09-22T00:01:00Z");
    expect(await positions("2026-09-21")).toEqual([inverse ? "102" : "101"]);
    expect(await digests()).toMatchObject([
      { day: D, listingsChanged: 1 },
      { day: "2026-09-21", listingsChanged: 1 },
    ]);
    const stable = await windows();
    await run("2026-09-22T00:01:00Z");
    expect(await windows()).toEqual(stable);
  });

  it("ordered catch-up returns to steady, then holds and recovers on the next routine day", async () => {
    await activate();
    for (const day of [20, 21, 22]) await append(`day-${day}`, `2026-09-${day}T12:00:00Z`);
    await run("2026-09-23T00:01:00Z");
    expect((await windows()).filter((row) => row.emitted_at === null)).toHaveLength(3);
    expect(await digests()).toEqual([]);
    await projectThrough("103");
    await run("2026-09-23T00:02:00Z");
    expect(await members()).toEqual([
      { window_day: D, global_position: "101" },
      { window_day: "2026-09-21", global_position: "102" },
      { window_day: "2026-09-22", global_position: "103" },
    ]);
    expect(await digests()).toMatchObject([20, 21, 22].map((day) => ({ day: `2026-09-${day}`, listingsChanged: 1 })));
    const next = await append("routine", "2026-09-23T12:00:00Z");
    await run("2026-09-24T00:01:00Z");
    expect((await windows()).filter((row) => row.emitted_at === null)).toHaveLength(1);
    await projectThrough(next.globalPosition);
    await run("2026-09-24T00:02:00Z");
    expect((await windows()).every((row) => row.emitted_at !== null)).toBe(true);
    expect(await digests()).toHaveLength(4);
    await append("second-stop-24", "2026-09-24T12:00:00Z");
    const secondStop = await append("second-stop-25", "2026-09-25T12:00:00Z");
    await run("2026-09-26T00:01:00Z");
    expect((await windows()).filter((row) => row.emitted_at === null)).toHaveLength(2);
    await projectThrough(secondStop.globalPosition);
    await run("2026-09-26T00:02:00Z");
    expect((await windows()).every((row) => row.emitted_at !== null)).toBe(true);
    expect(await digests()).toHaveLength(6);
  });

  it("held-projection timeline: settle, missing/wrong/below checkpoints, oldest-first, delay once per pass and racing emitters", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await activate();
    await append("101", "2026-09-21T00:00:00.5Z");
    await append("102", `${D}T23:59:59.9Z`);
    await run("2026-09-21T00:00:59Z");
    expect(await windows()).toHaveLength(1);
    await run("2026-09-21T00:01:00Z");
    expect(await digests()).toEqual([]);
    await projectThrough("102");
    await checkpoint("0");
    await checkpoint("999", 2);
    await run("2026-09-21T00:02:00Z");
    expect(await digests()).toEqual([]);
    await checkpoint("101");
    await run("2026-09-22T06:00:00Z");
    expect(await digests()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    await run("2026-09-22T06:01:00Z");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith("pricing.repricing-digest.delayed", { day: D, checkpointPosition: "101" });
    await checkpoint("102");
    await Promise.all([run("2026-09-22T06:02:00Z"), run("2026-09-22T06:02:00Z")]);
    expect(await digests()).toMatchObject([
      { day: D, listingsChanged: 1 },
      { day: "2026-09-21", listingsChanged: 1 },
    ]);
    await run("2026-09-22T06:03:00Z");
    expect(await digests()).toHaveLength(2);
  });

  it("resumes a mid-window append crash using authoritative streams despite notification projection lag", async () => {
    await activate();
    await append("a", `${D}T12:00:00Z`);
    await append("b", `${D}T12:00:00Z`, { seller: "acc_b" });
    await projectThrough("102");
    let crashed = false;
    const crashStore: EventStore = {
      ...store,
      appendToStream: async (input) => {
        const result = await store.appendToStream(input);
        if (!crashed) {
          crashed = true;
          throw new Error("synthetic crash after committed append");
        }
        return result;
      },
    };
    await expect(run("2026-09-21T00:01:00Z", db, crashStore)).rejects.toThrow("synthetic crash");
    expect(await digests()).toHaveLength(1);
    expect((await windows())[1]!.emitted_at).toBeNull();
    await run("2026-09-21T00:02:00Z");
    await run("2026-09-21T00:03:00Z");
    expect(await digests()).toMatchObject([{ sellerAccountId: "acc_a" }, { sellerAccountId: "acc_b" }]);
    expect((await windows())[1]!.emitted_at).not.toBeNull();
  });

  it("capture race: A102 wins, blocked B103 cannot alter D; late 103 stays D+1 through emission and pruning", async () => {
    await activate();
    await append("101", "2026-09-21T00:00:00.5Z", { evaluatedAt: "2026-01-01T00:00:00Z", listing: "late" });
    await append("102", `${D}T23:59:59.9Z`, { evaluatedAt: "2026-01-01T00:00:00Z", listing: "early" });
    const claimed = barrier();
    const release = barrier();
    const bRead = barrier();
    const bContinue = barrier();
    const aPool = observedPool(db, async (stage, sql) => {
      if (stage === "after" && isClaim(sql)) {
        claimed.resolve();
        await release.promise;
      }
    });
    let firstRead = true;
    const bWrites: string[] = [];
    const bPool = observedPool(db, async (stage, sql, _values, rows) => {
      if (stage === "after" && isNewest(sql) && firstRead) {
        firstRead = false;
        bRead.resolve();
        await bContinue.promise;
      }
      if (stage === "after" && isClaim(sql)) expect(rows).toEqual([]);
      if (
        stage === "before" &&
        (sql.includes("INSERT INTO pricing_repricing_digest_window_members") || sql.includes("SET assigned_floor"))
      )
        bWrites.push(sql);
    });
    const b = run("2026-09-21T00:01:00Z", bPool);
    await bRead.promise;
    const a = run("2026-09-21T00:01:00Z", aPool);
    await claimed.promise;
    await append("103", `${D}T23:59:59.95Z`, { evaluatedAt: "2026-01-02T00:00:00Z", listing: "late" });
    bContinue.resolve();
    try {
      await waitForBlockedClaim();
    } finally {
      release.resolve();
    }
    await Promise.all([a, b]);
    expect(bWrites).toEqual([]);
    expect(await positions(D)).toEqual(["102"]);
    const winner = (await windows())[1];
    expect(winner).toMatchObject({ assigned_floor: "100" });
    await run("2026-09-21T00:02:00Z");
    expect((await windows())[1]).toEqual(winner);
    await append("104", "2026-09-23T00:00:00Z", { evaluatedAt: "2026-01-03T00:00:00Z", listing: "late" });
    await projectThrough("104");
    await checkpoint("102");
    await run("2026-09-22T00:01:00Z");
    expect(await positions("2026-09-21")).toEqual(["101", "103"]);
    expect(await digests()).toMatchObject([{ day: D, listingsChanged: 1 }]);
    await compact();
    expect(await factIds()).toContain("103");
    await checkpoint("103");
    await run("2026-09-22T00:02:00Z");
    expect(await digests()).toMatchObject([
      { day: D, listingsChanged: 1 },
      { day: "2026-09-21", listingsChanged: 2 },
    ]);
    expect(await positions(D)).toEqual(["102"]);
    expect(await factIds()).not.toContain("103");
  });

  it.each([false, true])(
    "baseline race, later-clock winner=%s: actual partial-index wait, refence, closed-day predicate and inert replay",
    async (laterWins) => {
      const p1 = `${D}T23:59:00Z`;
      const p2 = "2026-09-21T00:01:00Z";
      const claim = barrier();
      const release = barrier();
      const read = barrier();
      const resume = barrier();
      let firstRead = true;
      const trace: string[] = [];
      const loserPool = observedPool(db, async (stage, sql, values, rows) => {
        if (stage !== "after") return;
        if (isNewest(sql)) {
          trace.push("read");
          if (firstRead) {
            firstRead = false;
            expect(rows).toEqual([]);
            read.resolve();
            await resume.promise;
          }
        }
        if (isFence(sql)) trace.push(`fence:${(rows![0] as { head: string }).head}`);
        if (isClaim(sql)) trace.push(`claim:${values[0]}:${rows!.length}`);
      });
      const winnerPool = observedPool(db, async (stage, sql) => {
        if (stage === "after" && isClaim(sql)) {
          claim.resolve();
          await release.promise;
        }
      });
      const loser = run(laterWins ? p1 : p2, loserPool);
      await read.promise;
      const winner = run(laterWins ? p2 : p1, winnerPool);
      await claim.promise;
      resume.resolve();
      let settled = false;
      void loser.finally(() => {
        settled = true;
      });
      try {
        await waitForBlockedClaim();
        expect(settled).toBe(false);
      } finally {
        release.resolve();
      }
      await Promise.all([winner, loser]);
      expect(trace).toEqual([
        "read",
        "fence:100",
        `claim:${laterWins ? "2026-09-19" : D}:0`,
        "read",
        "fence:100",
        ...(laterWins ? [] : [`claim:${D}:1`]),
      ]);
      const retained = await windows();
      expect(retained.filter((row) => row.kind === "baseline")).toHaveLength(1);
      expect(retained[0]).toMatchObject({
        window_day: laterWins ? D : "2026-09-19",
        assigned_floor: "100",
        kind: "baseline",
      });
      expect(retained).toHaveLength(laterWins ? 1 : 2);
      await run(p1);
      await run(p2);
      expect(await windows()).toEqual(retained);
      await run("2026-09-22T00:01:00Z");
      expect((await windows()).filter((row) => row.window_day === "2026-09-21")).toHaveLength(1);
      const steady = await windows();
      await run("2026-09-22T00:02:00Z");
      expect(await windows()).toEqual(steady);
      expect(await members()).toEqual([]);
      expect(await digests()).toEqual([]);
    },
  );

  it.each(["dropped", "non-unique", "excludes-earlier", "excludes-later"])(
    "baseline index negative control %s permits two conflicting baselines",
    async (mutant) => {
      await db.query("DROP INDEX pricing_repricing_digest_baseline_idx");
      if (mutant !== "dropped") {
        const predicate =
          mutant === "excludes-earlier"
            ? ` AND window_day <> '2026-09-19'::date`
            : mutant === "excludes-later"
              ? ` AND window_day <> '${D}'::date`
              : "";
        await db.query(`CREATE ${mutant === "non-unique" ? "" : "UNIQUE "}INDEX pricing_repricing_digest_baseline_idx
        ON pricing_repricing_digest_windows(kind) WHERE kind = 'baseline'${predicate}`);
      }
      const winner = await db.connect();
      const loser = await db.connect();
      try {
        await winner.query("BEGIN");
        await loser.query("BEGIN");
        const sql = `INSERT INTO pricing_repricing_digest_windows
        (window_day, kind, assigned_floor, captured_at, emitted_at, updated_at)
        VALUES ($1, 'baseline', 100, now(), now(), now()) ON CONFLICT DO NOTHING RETURNING window_day`;
        expect((await winner.query(sql, ["2026-09-19"])).rows).toHaveLength(1);
        const result = await loser.query(sql, [D]);
        expect(result.rows).toHaveLength(1);
        await loser.query("COMMIT");
        await winner.query("COMMIT");
        expect((await windows()).filter((row) => row.kind === "baseline")).toHaveLength(2);
      } finally {
        await winner.query("ROLLBACK");
        await loser.query("ROLLBACK");
        winner.release();
        loser.release();
        await db.query("TRUNCATE pricing_repricing_digest_window_members, pricing_repricing_digest_windows");
        await db.query("DROP INDEX IF EXISTS pricing_repricing_digest_baseline_idx");
        await db.query(`CREATE UNIQUE INDEX pricing_repricing_digest_baseline_idx
        ON pricing_repricing_digest_windows(kind) WHERE kind = 'baseline'`);
      }
    },
  );

  it("prune horizon: older-than-90-day 101 and its later facts survive D, then fold only after D+1 emits", async () => {
    await activate();
    await append("101", "2026-09-21T00:00:00.5Z", { listing: "late", evaluatedAt: "2026-01-01T00:00:00Z" });
    await append("102", `${D}T23:59:59.9Z`, { listing: "early", evaluatedAt: "2026-01-01T00:00:00Z" });
    await append("103", `${D}T23:59:59.95Z`, { listing: "late", evaluatedAt: "2026-01-02T00:00:00Z" });
    await append("104", `${D}T23:59:59.96Z`, { listing: "late", evaluatedAt: "2026-01-03T00:00:00Z" });
    await append("105", `${D}T23:59:59.97Z`, { listing: "early", evaluatedAt: "2026-01-02T00:00:00Z" });
    await projectThrough("105");
    await run("2026-09-21T00:01:00Z");
    expect(await positions(D)).toEqual(["102", "103", "104", "105"]);
    expect(await factIds()).toEqual(["101", "103", "104", "105"]);
    await checkpoint("0");
    await run("2026-09-22T00:01:00Z");
    expect(await positions("2026-09-21")).toEqual(["101"]);
    expect((await windows())[2]!.emitted_at).toBeNull();
    expect(await factIds()).toEqual(["101", "103", "104", "105"]);
    await checkpoint("105");
    await run("2026-09-22T00:02:00Z");
    expect(await digests()).toMatchObject([
      { day: D, listingsChanged: 4 },
      { day: "2026-09-21", listingsChanged: 1 },
    ]);
    expect(await factIds()).toEqual(["104", "105"]);
    expect(
      await db.query(`SELECT compacted_through_evaluation_id FROM pricing_repricing_listing_outcomes
      WHERE listing_id = 'late'`),
    ).toMatchObject({ rows: [{ compacted_through_evaluation_id: "103" }] });
  });

  it("aggregates exact member identity and complete counts per seller, excluding same-time nonmembers and empty evaluations", async () => {
    await activate();
    const base: RepricingPolicyListingTrace = {
      listingId: "changed",
      currentPriceAmount: "10.00",
      targetPriceAmount: "5.00",
      ruleIndex: 0,
      anchor: null,
      exhaustedAnchors: [],
      clamps: { floor: true, ceiling: true, maxMove: true },
      flags: ["spiral-breaker"],
      frozenUntil: "2026-09-21T01:00:00Z",
      outcome: "changed",
      skipReason: null,
    };
    await append("not-member", "2026-09-21T00:00:00.5Z", { traces: [{ ...base, listingId: "nonmember" }] });
    await append("member", `${D}T23:59:59Z`, {
      evaluatedAt: "2026-09-21T00:00:00.5Z",
      traces: [
        base,
        { ...base, listingId: "changed2" },
        { ...base, listingId: "budget", flags: [], outcome: "skipped", skipReason: "budget-exhausted" },
        { ...base, listingId: "pause", flags: [], outcome: "pause-requested", skipReason: "terminal-pause" },
        { ...base, listingId: "tolerance", flags: [], outcome: "skipped", skipReason: "within-tolerance" },
      ],
    });
    await append("other-seller", `${D}T23:59:59Z`, { seller: "acc_b" });
    await append("empty", `${D}T23:59:59Z`, { seller: "acc_empty", traces: [] });
    await projectThrough("104");
    await run("2026-09-21T00:01:00Z");
    expect(await digests()).toEqual([
      {
        schemaVersion: 1,
        digestId: `acc_a-${D}`,
        sellerAccountId: "acc_a",
        day: D,
        policiesEvaluated: 1,
        listingsChanged: 2,
        floorClamped: 5,
        ceilingClamped: 5,
        maxMoveClamped: 5,
        budgetExhausted: 1,
        pausedForMissingInput: 1,
        withinTolerance: 1,
        spiralBreakerTrips: 1,
      },
      {
        schemaVersion: 1,
        digestId: `acc_b-${D}`,
        sellerAccountId: "acc_b",
        day: D,
        policiesEvaluated: 1,
        listingsChanged: 1,
        floorClamped: 0,
        ceilingClamped: 0,
        maxMoveClamped: 0,
        budgetExhausted: 0,
        pausedForMissingInput: 0,
        withinTolerance: 0,
        spiralBreakerTrips: 0,
      },
    ]);
  });

  it.each(["100", "103"])(
    "stale head %s: loser rereads before refencing and claims 104 in D+1, never D+2",
    async (staleFence) => {
      await activate();
      const addFirst = async () => {
        for (const id of ["101", "102", "103"]) await append(id, `${D}T12:00:00Z`);
      };
      if (staleFence === "103") await addFirst();
      const fenced = barrier();
      const release = barrier();
      let firstFence = true;
      const trace: string[] = [];
      const stalePool = observedPool(db, async (stage, sql, values, rows) => {
        if (stage !== "after") return;
        if (isNewest(sql)) trace.push("read");
        if (isFence(sql)) {
          const head = (rows![0] as { head: string }).head;
          trace.push(`fence:${head}`);
          if (firstFence) {
            firstFence = false;
            expect(head).toBe(staleFence);
            fenced.resolve();
            await release.promise;
          }
        }
        if (isClaim(sql)) trace.push(`claim:${values[0]}:${rows!.length}`);
      });
      const stale = run("2026-09-22T00:01:00Z", stalePool);
      await fenced.promise;
      if (staleFence === "100") await addFirst();
      await run("2026-09-21T00:01:00Z");
      const winner = (await windows())[1];
      expect(winner).toMatchObject({ assigned_floor: "103" });
      await append("104", `${D}T23:59:59Z`, { listing: "late", evaluatedAt: "2026-01-01T00:00:00Z" });
      release.resolve();
      await stale;
      expect(trace).toEqual(["read", `fence:${staleFence}`, `claim:${D}:0`, "read", "fence:104", "claim:2026-09-21:1"]);
      expect((await windows())[1]).toEqual(winner);
      expect(await positions(D)).toEqual(["101", "102", "103"]);
      expect(await positions("2026-09-21")).toEqual(["104"]);
      await append("105", "2026-09-23T00:00:00Z", { listing: "late", evaluatedAt: "2026-01-02T00:00:00Z" });
      await projectThrough("105");
      await checkpoint("103");
      await run("2026-09-22T00:02:00Z");
      await compact();
      expect(await factIds()).toContain("104");
      expect(await digests()).toMatchObject([{ day: D, listingsChanged: 3 }]);
      await checkpoint("104");
      await run("2026-09-23T00:01:00Z");
      expect(await positions("2026-09-22")).toEqual([]);
      expect(await digests()).toMatchObject([
        { day: D, listingsChanged: 3 },
        { day: "2026-09-21", listingsChanged: 1 },
      ]);
      expect(await factIds()).not.toContain("104");
    },
  );
});
