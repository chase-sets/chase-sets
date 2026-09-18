import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { compactListingOutcomeFacts, projectListingOutcomeFacts } from "../read-model/listing-outcomes";
import { pricingRepricingEngineSchemaMigrations } from "../read-model/schema";
import { buildRepricingEvaluationProjectionHandlers } from "../read-model/projection";
import { repricingPolicyEvaluatedEventType, type RepricingPolicyEvaluatedEvent } from "../domain/fact";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const retainFrom = "2026-06-18T00:00:00.000Z";
const at = (day: number) => `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;

function fact(
  id: string,
  day: number,
  binding: boolean,
  listingIds = ["listing-a"],
): RepricingPolicyEvaluatedEvent["data"] {
  return {
    schemaVersion: 1,
    evaluationId: id,
    policyId: "policy-a",
    policyRevision: "1",
    sellerAccountId: "account-a",
    catalogItemId: "catalog-a",
    productId: "product-a",
    evaluatedAt: at(day),
    trigger: { kind: "daily-drift-sweep", eventId: id, signalVersion: "1", occurredAt: at(day) },
    listingsEvaluated: listingIds.length,
    listingsChanged: listingIds.length,
    listingsSkipped: 0,
    signalToEvaluationLatencyMs: 0,
    listings: listingIds.map((listingId) => ({
      listingId,
      currentPriceAmount: "10.00",
      targetPriceAmount: binding ? "5.00" : "7.00",
      ruleIndex: 0,
      anchor: { source: "market-estimate", amount: "5.00", stratum: "market-estimate", contributingListingCount: 2 },
      exhaustedAnchors: [],
      clamps: { floor: binding, ceiling: false, maxMove: false },
      flags: [],
      frozenUntil: day === 3 ? "2026-09-17T00:00:00.000Z" : undefined,
      outcome: "changed",
      skipReason: null,
    })),
  };
}

describeDb("repricing listing outcomes", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  let db: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "listing_outcomes_7912");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    db = pools.pricing;
    await resetMultiContextTestSchemas(pools);
    await db.query(pricingModule.schemaSql);
  });
  beforeEach(async () => {
    await db.query(
      "TRUNCATE pricing_repricing_listing_outcome_facts, pricing_repricing_listing_outcomes, pricing_repricing_policy_evaluations",
    );
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  const project = (data: RepricingPolicyEvaluatedEvent["data"], position = "1") =>
    withPgTransaction(db, (tx) => projectListingOutcomeFacts(tx, data, position));
  const compact = () => compactListingOutcomeFacts(db, { retainFrom, digestedSql: "true" });
  const outcomes = async () =>
    (await db.query("SELECT * FROM pricing_repricing_listing_outcomes ORDER BY listing_id")).rows;
  const visible = async () =>
    (await outcomes()).map(
      ({ compacted_through_at: _at, compacted_through_evaluation_id: _id, compaction_run_since: _run, ...row }) => row,
    );
  const ids = async () =>
    (
      await db.query<{ evaluation_id: string }>(
        "SELECT evaluation_id FROM pricing_repricing_listing_outcome_facts ORDER BY evaluated_at, evaluation_id",
      )
    ).rows.map((row) => row.evaluation_id);

  it.each([
    [true, true, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
    [true, false, true],
    [false, true, true],
  ])("converges for binding=%s/%s, equal-time=%s and stale replay", async (first, second, equalTime) => {
    const older = fact("evaluation-a", 1, first);
    const newer = fact("evaluation-b", equalTime ? 1 : 2, second);
    let expected: unknown;
    for (const sequence of [
      [older, newer, older],
      [newer, older, newer],
      [older, older, newer],
    ]) {
      await db.query("TRUNCATE pricing_repricing_listing_outcome_facts, pricing_repricing_listing_outcomes");
      for (const data of sequence) await project(data, data === older ? "999" : "2");
      const rows = await outcomes();
      expected ??= rows;
      expect(rows).toEqual(expected);
      expect(rows[0]).toMatchObject({
        evaluation_id: "evaluation-b",
        global_position: "2",
        floor_binding_since: second ? new Date(at(first || equalTime ? 1 : 2)) : null,
      });
      expect(await ids()).toHaveLength(2);
    }
  });

  it("inserts and recomputes set-wise independent of listing count through the transactional handler", async () => {
    for (const count of [1, 50]) {
      const data = fact(
        `evaluation-${count}`,
        1,
        true,
        Array.from({ length: count }, (_, i) => `listing-${i}`),
      );
      await withPgTransaction(db, async (tx) => {
        const query = vi.spyOn(tx, "query");
        try {
          await buildRepricingEvaluationProjectionHandlers(db)[repricingPolicyEvaluatedEventType]!(
            {
              type: repricingPolicyEvaluatedEventType,
              data,
              globalPosition: "1",
            } as never,
            { db: tx },
          );
          expect(query).toHaveBeenCalledTimes(3);
          expect(
            query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO pricing_repricing_listing_outcome_facts")),
          ).toHaveLength(1);
          expect(
            query.mock.calls.filter(([sql]) =>
              sql.includes("UPDATE pricing_repricing_listing_outcomes AS outcome SET"),
            ),
          ).toHaveLength(1);
          expect(query.mock.calls.at(-1)![0]).toContain("FOR UPDATE");
        } finally {
          query.mockRestore();
        }
      });
    }
    expect(await outcomes()).toHaveLength(50);
  });

  it("all six three-fact permutations reconstruct the trailing run, not a cached start", async () => {
    const facts = [fact("a", 1, true), fact("b", 2, false), fact("c", 3, true)];
    let expected: unknown;
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      await db.query("TRUNCATE pricing_repricing_listing_outcome_facts, pricing_repricing_listing_outcomes");
      for (const index of order) await project(facts[index]!, String(index + 1));
      const rows = await outcomes();
      expected ??= rows;
      expect(rows).toEqual(expected);
      expect(rows[0]!.floor_binding_since).toEqual(new Date(at(3)));
    }
  });

  it("derives only from the summary and retained facts even if the cached output is wrong", async () => {
    await project(fact("a", 1, true));
    await project(fact("b", 2, true));
    await compact();
    const expected = await outcomes();
    await db.query(`UPDATE pricing_repricing_listing_outcomes SET
      floor_binding_since = '1999-01-01', trace = '{}', frozen_until = '2099-01-01'`);
    await project(fact("b", 2, true));
    expect(await outcomes()).toEqual(expected);
  });

  it("compaction retains a single greatest fact and repeated passes are no-ops", async () => {
    await project(fact("a", 1, true));
    const before = await outcomes();
    expect(await compact()).toBe(0);
    expect(await compact()).toBe(0);
    expect(await outcomes()).toEqual(before);
    expect(await ids()).toEqual(["a"]);
  });

  it("compaction preserves an old binding run, progresses after a newer arrival, and restarts only above the boundary", async () => {
    for (const day of [3, 1, 2]) await project(fact(String(day), day, true));
    const before = await visible();
    expect(await compact()).toBe(2);
    expect(await visible()).toEqual(before);
    expect(await ids()).toEqual(["3"]);
    expect((await outcomes())[0]).toMatchObject({
      compacted_through_evaluation_id: "2",
      compaction_run_since: new Date(at(1)),
    });
    expect(await compact()).toBe(0);
    await project(fact("4", 4, true));
    expect(await compact()).toBe(1);
    expect(await ids()).toEqual(["4"]);
    expect((await outcomes())[0]!.floor_binding_since).toEqual(new Date(at(1)));
    await project(fact("5", 5, false));
    expect((await outcomes())[0]!.floor_binding_since).toBeNull();
    await compact();
    await project(fact("6", 6, true));
    await compact();
    expect((await outcomes())[0]).toMatchObject({ floor_binding_since: new Date(at(6)), compaction_run_since: null });
    const current = await outcomes();
    await project(fact("0", 1, false), "9007199254740993");
    await project(fact("2", 2, true), "100");
    expect(await outcomes()).toEqual(current);
    expect(await ids()).toEqual(["0", "2", "6"]);
    await compact();
    expect(await outcomes()).toEqual(current);
    expect(await ids()).toEqual(["6"]);
  });

  it("compaction stops at each fact's missing digest proof, not its age or global position", async () => {
    for (const day of [1, 2, 3, 4]) await project(fact(String(day), day, day !== 2), day === 2 ? "1" : "999");
    await withPgTransaction(db, async (tx) => {
      await tx.query("CREATE TEMP TABLE emitted (evaluation_id text PRIMARY KEY) ON COMMIT DROP");
      await tx.query("INSERT INTO emitted VALUES ('1'), ('3'), ('4')");
      const query = vi.spyOn(tx, "query");
      try {
        expect(
          await compactListingOutcomeFacts(tx, {
            retainFrom,
            digestedSql: "EXISTS (SELECT 1 FROM emitted WHERE emitted.evaluation_id = fact.evaluation_id)",
          }),
        ).toBe(1);
        expect(query).toHaveBeenCalledTimes(1);
      } finally {
        query.mockRestore();
      }
      const retained = await tx.query(
        "SELECT evaluation_id FROM pricing_repricing_listing_outcome_facts ORDER BY evaluation_id",
      );
      expect(retained.rows).toEqual([{ evaluation_id: "2" }, { evaluation_id: "3" }, { evaluation_id: "4" }]);
      await tx.query("INSERT INTO emitted VALUES ('2')");
      expect(
        await compactListingOutcomeFacts(tx, {
          retainFrom,
          digestedSql: "EXISTS (SELECT 1 FROM emitted WHERE emitted.evaluation_id = fact.evaluation_id)",
        }),
      ).toBe(2);
    });
    expect((await outcomes())[0]!.floor_binding_since).toEqual(new Date(at(3)));
    expect(await ids()).toEqual(["4"]);
  });

  it("compaction respects the strict age boundary even when later old facts are digested", async () => {
    await project(fact("1", 1, true));
    await project(fact("2", 2, true));
    await project(fact("3", 3, true));
    expect(await compactListingOutcomeFacts(db, { retainFrom: at(2), digestedSql: "true" })).toBe(1);
    expect(await ids()).toEqual(["2", "3"]);
  });

  async function waitForLock(observer: PgQueryable, pid: number) {
    for (let i = 0; i < 100; i++) {
      const state = await observer.query<{ waiting: boolean }>(
        "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
        [pid],
      );
      if (state.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Competing projection never reached the expected row lock.");
  }

  it.each([false, true])("serializes concurrent arrivals with a fresh snapshot (existing=%s)", async (existing) => {
    if (existing) await project(fact("0", 1, true));
    const first = await db.connect();
    const second = await db.connect();
    let pending: Promise<void> | undefined;
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const pid = (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await projectListingOutcomeFacts(first, fact("2", 3, true), "2");
      pending = projectListingOutcomeFacts(second, fact("1", 2, false), "3");
      await waitForLock(db, pid);
      await first.query("COMMIT");
      await pending;
      await second.query("COMMIT");
      expect((await outcomes())[0]).toMatchObject({ evaluation_id: "2", floor_binding_since: new Date(at(3)) });
    } finally {
      await first.query("ROLLBACK");
      await pending?.catch(() => undefined);
      await second.query("ROLLBACK");
      first.release();
      second.release();
    }
  });

  it("compaction and an older arrival share the same lock and preserve the new boundary", async () => {
    for (const day of [1, 2, 3]) await project(fact(String(day), day, true));
    const first = await db.connect();
    const second = await db.connect();
    let pending: Promise<void> | undefined;
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const pid = (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await compactListingOutcomeFacts(first, { retainFrom, digestedSql: "true" });
      pending = projectListingOutcomeFacts(second, fact("0", 1, false), "100");
      await waitForLock(db, pid);
      await first.query("COMMIT");
      await pending;
      await second.query("COMMIT");
      expect((await outcomes())[0]).toMatchObject({
        evaluation_id: "3",
        floor_binding_since: new Date(at(1)),
        compacted_through_evaluation_id: "2",
      });
      expect(await ids()).toEqual(["0", "3"]);
    } finally {
      await first.query("ROLLBACK");
      await pending?.catch(() => undefined);
      await second.query("ROLLBACK");
      first.release();
      second.release();
    }
  });

  it("compaction waits for an uncommitted nonbinding projection without crossing its undigested gap", async () => {
    const committed = [
      [fact("a", 1, true), "1"],
      [fact("c", 3, true), "3"],
      [fact("d", 4, true), "4"],
    ] as const;
    for (const [data, position] of committed) await project(data, position);
    const projection = await db.connect();
    const compactor = await db.connect();
    const observer = await db.connect();
    let pending: Promise<number> | undefined;
    try {
      await compactor.query("CREATE TEMP TABLE emitted (evaluation_id text PRIMARY KEY)");
      await compactor.query("INSERT INTO emitted VALUES ('a'), ('c'), ('d')");
      await projection.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await compactor.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const projectionPid = (await projection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const compactorPid = (await compactor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const gap = fact("b", 2, false);
      await projectListingOutcomeFacts(projection, gap, "2");
      const expectedVisible = (
        await projection.query("SELECT * FROM pricing_repricing_listing_outcomes ORDER BY listing_id")
      ).rows.map(
        ({ compacted_through_at: _at, compacted_through_evaluation_id: _id, compaction_run_since: _run, ...row }) => row,
      );
      pending = compactListingOutcomeFacts(compactor, {
        retainFrom,
        digestedSql: "EXISTS (SELECT 1 FROM emitted WHERE emitted.evaluation_id = fact.evaluation_id)",
      });
      void pending.catch(() => undefined);
      const waitError = await waitForLock(observer, compactorPid).catch((error: unknown) => String(error));
      const lockState = (
        await observer.query<{ pid: number; wait_event_type: string | null; blockers: number[] }>(
          `SELECT pid, wait_event_type, pg_blocking_pids(pid) AS blockers
           FROM pg_stat_activity WHERE pid = $1`,
          [compactorPid],
        )
      ).rows;
      const lockDiagnostic = JSON.stringify({ projectionPid, compactorPid, waitError, lockState });
      expect(waitError, lockDiagnostic).toBeUndefined();
      expect(lockState[0]?.wait_event_type, lockDiagnostic).toBe("Lock");
      expect(lockState[0]?.blockers, lockDiagnostic).toContain(projectionPid);
      await projection.query("COMMIT");
      const deleted = await pending;
      await compactor.query("COMMIT");

      const afterCompaction = await outcomes();
      const visibleAfterCompaction = await visible();
      const retained = await ids();
      const digestProof = (
        await compactor.query<{ evaluation_id: string }>("SELECT evaluation_id FROM emitted ORDER BY evaluation_id")
      ).rows.map((row) => row.evaluation_id);
      const newer = fact("e", 5, true);
      await project(newer, "5");
      const afterNewer = await outcomes();
      const visibleAfterNewer = await visible();
      for (const [data, position] of [
        committed[0],
        [gap, "2"],
        committed[1],
        committed[2],
        [newer, "5"],
      ] as const) {
        await project(data, position);
      }
      const afterReplay = await outcomes();
      const visibleAfterReplay = await visible();
      const retainedAfterReplay = await ids();
      const diagnostic = JSON.stringify({
        lockState,
        deleted,
        digestProof,
        retained,
        expectedVisible,
        afterCompaction,
        afterNewer,
        afterReplay,
        retainedAfterReplay,
      });
      expect(deleted, diagnostic).toBeLessThanOrEqual(1);
      expect(digestProof, diagnostic).toEqual(["a", "c", "d"]);
      expect(retained, diagnostic).toContain("b");
      expect(retained, diagnostic).toContain("c");
      expect(retained.at(-1), diagnostic).toBe("d");
      expect(afterCompaction, diagnostic).toHaveLength(1);
      const boundary = afterCompaction[0]!;
      if (boundary.compacted_through_at === null) {
        expect(boundary.compacted_through_evaluation_id, diagnostic).toBeNull();
      } else {
        expect(boundary.compacted_through_at, diagnostic).toEqual(new Date(at(1)));
        expect(boundary.compacted_through_evaluation_id, diagnostic).toBe("a");
      }
      expect(visibleAfterCompaction, diagnostic).toEqual(expectedVisible);
      expect(afterCompaction[0], diagnostic).toMatchObject({
        evaluation_id: "d",
        floor_binding: true,
        floor_binding_since: new Date(at(3)),
      });
      expect(afterNewer[0], diagnostic).toMatchObject({
        evaluation_id: "e",
        evaluated_at: new Date(at(5)),
        global_position: "5",
        floor_binding: true,
        floor_binding_since: new Date(at(3)),
      });
      expect(afterReplay, diagnostic).toEqual(afterNewer);
      expect(visibleAfterReplay, diagnostic).toEqual(visibleAfterNewer);
      expect(retainedAfterReplay, diagnostic).toEqual(["a", "b", "c", "d", "e"]);
    } finally {
      await projection.query("ROLLBACK");
      await pending?.catch(() => undefined);
      await compactor.query("ROLLBACK");
      await compactor.query("DROP TABLE IF EXISTS pg_temp.emitted");
      projection.release();
      compactor.release();
      observer.release();
    }
  });

  it("boot and the ledgered migration both install the same outcome tables and indexes", async () => {
    const migration = pricingRepricingEngineSchemaMigrations.find(
      ({ migrationId }) => migrationId === "20260916_pricing_listing_outcomes",
    )!;
    expect(migration).toBeDefined();
    for (const sql of migration.statements) await db.query(sql);
    const indexes = await db.query(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('pricing_repricing_listing_outcomes', 'pricing_repricing_listing_outcome_facts')",
    );
    expect(indexes.rows).toHaveLength(7);
    await project(fact("a", 1, true));
    for (const sql of migration.statements) await db.query(sql);
    expect(await ids()).toEqual(["a"]);
  });
});
