import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { commitProviderObservationCapture } from "../read-model/provider-observation-writes";
import { pricingProviderObservationsSchemaSql } from "../read-model/provider-observations-schema";
import { reducedObservationInput } from "./reduced-observation-test-support";
import { expectSourceMutantRed, settled } from "./source-mutant-test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
type WriterModule = typeof import("../read-model/provider-observation-writes");

describeDb("provider observation caller-transaction commit without the capture cursor", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_reduced_commit");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingProviderObservationsSchemaSql);
  });
  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  it.each(["absent", "advanced"] as const)(
    "commits and replays with the cursor %s, preserving all durable rows",
    async (state) => {
      await assertCursorIndependent(commitProviderObservationCapture, state);
    },
  );

  it.each(["absent", "advanced"] as const)("rejects restoring the cursor read/check with cursor %s", async (state) => {
    await expectSourceMutantRed<WriterModule>(
      {
        id: `reduced-commit-cursor-${state}`,
        defect: "restores the old expected-cursor check and commit-time advance",
        mutations: [
          {
            file: "read-model/provider-observation-writes.ts",
            find: "  const headerDisposition = await insertCaptureHeader(db, capture);",
            replace: `  const cursor = await db.query<{ after_external_key: string; generation: string }>(
    "SELECT after_external_key, generation::text FROM pricing_external_market_capture_cursors WHERE provider_key = $1 FOR UPDATE",
    [capture.header.providerKey],
  );
  if ((cursor.rows[0]?.after_external_key ?? "") !== "" || Number(cursor.rows[0]?.generation ?? 0) !== 0) return "stale-worker";
  const headerDisposition = await insertCaptureHeader(db, capture);`,
          },
          {
            file: "read-model/provider-observation-writes.ts",
            find: '  return "committed";',
            replace: `  await db.query(
    \`INSERT INTO pricing_external_market_capture_cursors (provider_key, after_external_key, generation, updated_at)
     VALUES ($1, '', 1, $2)
     ON CONFLICT (provider_key) DO UPDATE SET after_external_key = EXCLUDED.after_external_key,
       generation = EXCLUDED.generation, updated_at = EXCLUDED.updated_at\`,
    [capture.header.providerKey, capture.header.captureCompletedAt],
  );
  return "committed";`,
          },
        ],
      },
      "read-model/provider-observation-writes.ts",
      ["AC3"],
      async (module) => assertCursorIndependent(module.commitProviderObservationCapture, state),
    );
  });

  it("commits without the cursor table and rolls every capture row back with the caller transaction", async () => {
    await pool.query("DROP TABLE pricing_external_market_capture_cursors");
    const capture = mapProviderObservationCapture(reducedObservationInput());
    const before = await durableState(pool);
    await expect(
      withPgTransaction(pool, async (db) => {
        expect(await commitProviderObservationCapture(db, capture)).toBe("committed");
        throw new Error("synthetic-caller-rollback");
      }),
    ).rejects.toThrow("synthetic-caller-rollback");
    expect(await durableState(pool)).toEqual(before);
    await expect(withPgTransaction(pool, (db) => commitProviderObservationCapture(db, capture))).resolves.toBe(
      "committed",
    );
  });

  it("refuses immutable conflicts and keeps newer weekly and snapshot values after an older capture", async () => {
    const latest = mapProviderObservationCapture(
      reducedObservationInput({
        captureStartedAt: "2026-09-01T03:00:00.000Z",
        captureCompletedAt: "2026-09-01T03:00:01.000Z",
      }),
    );
    await withPgTransaction(pool, (db) => commitProviderObservationCapture(db, latest));
    const before = await durableState(pool);
    await expect(
      withPgTransaction(pool, (db) =>
        commitProviderObservationCapture(db, {
          ...latest,
          header: { ...latest.header, recordedSignalCount: 99 },
        }),
      ),
    ).rejects.toThrow("capture-immutable-conflict");
    expect(await durableState(pool)).toEqual(before);

    const input = reducedObservationInput();
    const older = mapProviderObservationCapture({
      ...input,
      observation: {
        ...input.observation,
        listings: {
          ...input.observation.listings,
          rows: input.observation.listings.rows.map((row) => ({ ...row, price: "9.00" })),
        },
        history: {
          ...input.observation.history,
          rows: input.observation.history.rows.map((row) => ({
            ...row,
            buckets: row.buckets.map((bucket) => ({ ...bucket, lowSalePrice: "9.00" })),
          })),
        },
      },
    });
    await withPgTransaction(pool, (db) => commitProviderObservationCapture(db, older));
    const weekly = await pool.query(
      "SELECT low_sale_amount::text, last_capture_id FROM pricing_external_weekly_sale_buckets",
    );
    expect(weekly.rows).toEqual([{ low_sale_amount: "0.10", last_capture_id: latest.header.captureId }]);
    const snapshots = await pool.query(
      "SELECT cheapest_delivered_amount::text, last_capture_id FROM pricing_external_listing_snapshots ORDER BY provider_variant, provider_condition",
    );
    expect(snapshots.rows).toEqual([
      { cheapest_delivered_amount: "0.40", last_capture_id: latest.header.captureId },
      { cheapest_delivered_amount: "0.20", last_capture_id: latest.header.captureId },
      { cheapest_delivered_amount: "0.30", last_capture_id: latest.header.captureId },
    ]);
  });

  async function assertCursorIndependent(
    commit: WriterModule["commitProviderObservationCapture"],
    state: "absent" | "advanced",
  ) {
    if (state === "advanced") {
      await pool.query(`INSERT INTO pricing_external_market_capture_cursors
        (provider_key, after_external_key, generation, updated_at)
        VALUES ('tcgplayer', 'synthetic-pass-owned-cursor', 41, '2026-09-01T00:00:00.000Z')`);
    }
    const cursorBefore = await cursorState(pool);
    const capture = mapProviderObservationCapture(reducedObservationInput());
    expect(await settled(withPgTransaction(pool, (db) => commit(db, capture))), "AC3:cursor-independent-commit").toBe(
      "committed",
    );
    expect(await cursorState(pool), "AC3:cursor-unchanged").toEqual(cursorBefore);
    const before = await durableState(pool);
    expect(await withPgTransaction(pool, (db) => commit(db, capture))).toBe("replayed");
    expect(await durableState(pool), "AC3:immutable-replay-no-child-append").toEqual(before);
    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM pricing_external_market_captures) AS headers,
      (SELECT count(*)::int FROM pricing_external_sale_observations) AS sales,
      (SELECT count(*)::int FROM pricing_external_weekly_sale_buckets) AS weekly,
      (SELECT count(*)::int FROM pricing_external_listing_snapshots) AS snapshots,
      (SELECT count(*)::int FROM pricing_external_listing_ask_depth) AS asks`);
    expect(counts.rows).toEqual([{ headers: 1, sales: 2, weekly: 1, snapshots: 3, asks: 4 }]);
  }
});

async function cursorState(db: PgQueryable) {
  return (
    await db.query(
      "SELECT provider_key, after_external_key, generation::text, updated_at FROM pricing_external_market_capture_cursors",
    )
  ).rows;
}

async function durableState(db: PgQueryable) {
  const result = await db.query(`SELECT jsonb_build_object(
    'headers', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.capture_id) FROM pricing_external_market_captures c),
    'sales', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.capture_id, s.sale_fingerprint) FROM pricing_external_sale_observations s),
    'weekly', (SELECT jsonb_agg(to_jsonb(w) ORDER BY w.external_key, w.week_start) FROM pricing_external_weekly_sale_buckets w),
    'snapshots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.provider_variant, s.provider_language, s.provider_condition) FROM pricing_external_listing_snapshots s),
    'asks', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.capture_id, a.anonymous_capture_seller_ordinal, a.provider_condition) FROM pricing_external_listing_ask_depth a)
  ) AS state`);
  return result.rows[0]?.state;
}
