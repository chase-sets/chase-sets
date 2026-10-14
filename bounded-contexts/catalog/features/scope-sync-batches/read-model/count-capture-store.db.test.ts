import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import type {
  CountCaptureBinding,
  CountCapturePhase,
  CountCaptureSend,
} from "../../source-observations/api/providers/count-capture-transport";
import {
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY as sealedUnit,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY as setUnit,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY as cardUnit,
} from "../../source-observations/api/providers/scrydex/adapter";
import { countCaptureSchemaMigrations, countCaptureSchemaSql } from "./count-capture-schema";
import { createCountCaptureStore, type CountCaptureStore } from "./count-capture-store";

const base = process.env.TEST_DATABASE_URL;
if (!base && process.env.CI) throw new Error("TEST_DATABASE_URL is required for count-capture DB proof.");
const describeDb = base ? describe : describe.skip;

const fingerprint = "d".repeat(64);
const owner = (seed: string) => seed.repeat(64);
const usage = (purpose: "bootstrap" | "readiness" | "planImport", unitKey?: string): CountCaptureSend => ({
  category: "usage",
  requestFingerprint: fingerprint,
  usage: unitKey === undefined ? { purpose } : { purpose, unitKey },
});
const count = (category: "cards" | "sealed"): CountCaptureSend => ({ category, requestFingerprint: fingerprint });
const legalSends: Readonly<Record<CountCapturePhase, readonly CountCaptureSend[]>> = {
  baseline: [],
  bootstrap: [usage("bootstrap")],
  quote: [],
  acquisition: [count("cards"), count("sealed")],
  preview: [usage("readiness"), usage("planImport", setUnit), usage("planImport", cardUnit), usage("planImport", sealedUnit)],
  "pre-confirm": [
    usage("readiness"),
    usage("planImport", setUnit),
    usage("planImport", cardUnit),
    usage("planImport", sealedUnit),
  ],
};

// The atomic-debit-deleted mutant, applied from outside the store: the advisory lock
// becomes a no-op and every contender reads the run before any of them appends.
function lockStrippedPools(pools: readonly PgTransactionalPool[]): PgTransactionalPool[] {
  let reads = 0;
  let release = () => {};
  const allRead = new Promise<void>((resolve) => (release = resolve));
  return pools.map((pool) => ({
    query: (text: string, values?: readonly unknown[]) => pool.query(text, values),
    connect: async (): Promise<PgPoolClient> => {
      const client = await pool.connect();
      const query = (async (text: string, values?: readonly unknown[]) => {
        if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
        const result = await client.query(text, values);
        if (text.startsWith("SELECT payload FROM catalog_scope_sync_count_capture_history WHERE run_id")) {
          if (++reads === pools.length) release();
          await allRead;
        }
        return result;
      }) as PgPoolClient["query"];
      return { query, release: (error?: unknown) => client.release(error) };
    },
  }));
}

describeDb("count-capture possible-send ledger", () => {
  let primary: Readonly<Record<"catalog", PgTransactionalPool>>;
  let replica: Readonly<Record<"catalog", PgTransactionalPool>>;
  let now: string;
  const clock = () => now;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["catalog"], "count_capture_9582");
    await ensureMultiContextTestDatabases(base!, urls);
    // Two pools on one database stand in for two cold API replicas.
    primary = createMultiContextTestPools(urls);
    replica = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(primary);
    await primary.catalog.query(catalogModule.schemaSql);
    now = new Date().toISOString();
  });
  afterAll(async () => {
    await closeMultiContextTestPools(primary);
    await closeMultiContextTestPools(replica);
  });

  async function openPhase(store: CountCaptureStore, phase: CountCapturePhase) {
    const run = await store.admit({ ownerHash: owner("a") });
    return { run, binding: await store.begin(run.runId, phase) };
  }
  const debitRows = async () =>
    Number(
      (
        await primary.catalog.query<{ sends: string }>(
          `SELECT coalesce(max(jsonb_array_length(payload->'sends')), 0)::text AS sends
           FROM catalog_scope_sync_count_capture_history`,
        )
      ).rows[0]?.sends,
    );

  describe("caps actual sends", () => {
    it("two cold replicas racing one acquisition kind commit exactly one debit", async () => {
      const first = createCountCaptureStore(primary.catalog, clock);
      const second = createCountCaptureStore(replica.catalog, clock);
      const { run, binding } = await openPhase(first, "acquisition");
      const outcomes = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) => (index % 2 ? second : first).ledger.debit(binding, count("cards"))),
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const retained = await second.read(run.runId);
      expect(retained.sends).toHaveLength(1);
      expect(retained.status).toBe("stopped");
      expect(await debitRows()).toBe(1);
    });

    it("the atomic-debit-deleted control over-commits the same race", async () => {
      const [first, second] = lockStrippedPools([primary.catalog, replica.catalog]).map((pool) =>
        createCountCaptureStore(pool, clock),
      );
      const { binding } = await openPhase(createCountCaptureStore(primary.catalog, clock), "acquisition");
      const outcomes = await Promise.allSettled([first!.ledger.debit(binding, count("cards")), second!.ledger.debit(binding, count("cards"))]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    });

    it("concurrent preview sends across replicas never exceed the phase cap or reuse a slot", async () => {
      const first = createCountCaptureStore(primary.catalog, clock);
      const second = createCountCaptureStore(replica.catalog, clock);
      const { run, binding } = await openPhase(first, "preview");
      const attempts = [...legalSends.preview, ...legalSends.preview, usage("bootstrap")];
      const outcomes = await Promise.allSettled(
        attempts.map((send, index) => (index % 2 ? second : first).ledger.debit(binding, send)),
      );
      const accepted = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
      const retained = await first.read(run.runId);
      expect(accepted).toBeLessThanOrEqual(4);
      expect(retained.sends).toHaveLength(accepted);
      expect(new Set(retained.sends.map((send) => JSON.stringify(send.usage))).size).toBe(accepted);
      expect(retained.status).toBe("stopped");
    });

    it("admits at most the eleven phase slots of one run, in order", async () => {
      const store = createCountCaptureStore(primary.catalog, clock);
      const run = await store.admit({ ownerHash: owner("a") });
      for (const phase of ["baseline", "bootstrap", "quote", "acquisition", "preview", "pre-confirm"] as const) {
        const binding = await store.begin(run.runId, phase);
        for (const send of legalSends[phase]) {
          const sequence = await store.ledger.debit(binding, send);
          await store.ledger.result(binding, sequence, 200);
        }
        if (phase !== "pre-confirm") await store.finish(binding);
        else await expect(store.ledger.debit(binding, usage("readiness"))).rejects.toThrow("capture-stopped");
      }
      const retained = await store.read(run.runId);
      expect(retained.sends.map((send) => send.sequence)).toEqual(Array.from({ length: 11 }, (_, index) => index + 1));
      expect(retained.sends.every((send) => send.status === 200)).toBe(true);
      expect(retained.status).toBe("stopped");
    });

    it.each([
      ["baseline", usage("readiness")],
      ["quote", usage("readiness")],
      ["bootstrap", usage("readiness")],
      ["bootstrap", usage("bootstrap", setUnit)],
      ["acquisition", usage("bootstrap")],
      ["preview", count("cards")],
      ["preview", usage("planImport")],
      ["preview", usage("planImport", "scrydex:one-piece:third-set:source-observation-import")],
      ["pre-confirm", usage("bootstrap")],
    ] as const)("a %s phase refuses an unslotted send and stops the run", async (phase, send) => {
      const store = createCountCaptureStore(primary.catalog, clock);
      const { run, binding } = await openPhase(store, phase);
      await expect(store.ledger.debit(binding, send)).rejects.toThrow("capture-stopped");
      expect(await store.read(run.runId)).toMatchObject({ status: "stopped", sends: [] });
    });

    it("never re-sends a slot after an uncertain result and retains the possible-send debit", async () => {
      const store = createCountCaptureStore(primary.catalog, clock);
      const { run, binding } = await openPhase(store, "acquisition");
      const sequence = await store.ledger.debit(binding, count("sealed"));
      await store.ledger.stop(binding);
      await expect(store.ledger.result(binding, sequence, 200)).rejects.toThrow("capture-stopped");
      await expect(store.ledger.debit(binding, count("cards"))).rejects.toThrow("capture-stopped");
      await expect(store.finish(binding)).rejects.toThrow("capture-stopped");
      expect((await store.read(run.runId)).sends).toEqual([
        expect.objectContaining({ sequence: 1, category: "sealed", status: null, respondedAt: null }),
      ]);
    });

    it("binds sends to the one open request of an open, unexpired run", async () => {
      const store = createCountCaptureStore(primary.catalog, clock);
      const { run, binding } = await openPhase(store, "bootstrap");
      await expect(store.admit({ ownerHash: owner("b") })).rejects.toThrow("capture-stopped");
      await expect(store.begin(run.runId, "preview")).rejects.toThrow("capture-stopped");
      expect((await store.read(run.runId)).status).toBe("stopped");
      await expect(store.ledger.debit(binding, usage("bootstrap"))).rejects.toThrow("capture-stopped");

      const next = await store.admit({ ownerHash: owner("b") });
      const bootstrap = await store.begin(next.runId, "bootstrap");
      const pending = await store.ledger.debit(bootstrap, usage("bootstrap"));
      await expect(store.finish(bootstrap)).rejects.toThrow("capture-stopped");
      expect((await store.read(next.runId)).sends[pending - 1]?.status).toBeNull();

      const late = await store.admit({ ownerHash: owner("c") });
      const preview = await store.begin(late.runId, "preview");
      await store.finish(preview);
      await expect(store.begin(late.runId, "bootstrap")).rejects.toThrow("capture-stopped");

      const expiring = await store.admit({ ownerHash: owner("d") });
      const bound = await store.begin(expiring.runId, "bootstrap");
      now = new Date(Date.parse(now) + 900_000).toISOString();
      await expect(store.ledger.debit(bound, usage("bootstrap"))).rejects.toThrow("capture-stopped");
      expect(await store.read(expiring.runId)).toMatchObject({ status: "stopped", sends: [] });
      await store.admit({ ownerHash: owner("e") });
    });

    it("refuses a debit from a finished request", async () => {
      const store = createCountCaptureStore(primary.catalog, clock);
      const { run, binding } = await openPhase(store, "bootstrap");
      await store.finish(binding);
      await expect(store.ledger.debit(binding, usage("bootstrap"))).rejects.toThrow("capture-stopped");
      expect(await store.read(run.runId)).toMatchObject({ status: "stopped", sends: [] });
    });
  });

  describe("capture history schema", () => {
    it("boots a current-main database through the ledgered migration and keeps retained runs on reboot", async () => {
      const pool = primary.catalog;
      await resetMultiContextTestSchemas(primary);
      await bootstrapContextDatabase(catalogModule, pool);
      // Current main has neither the table nor its ledger row.
      await pool.query("DROP TABLE catalog_scope_sync_count_capture_history");
      await pool.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = $1", [
        countCaptureSchemaMigrations[0]!.migrationId,
      ]);
      await bootstrapContextDatabase(catalogModule, pool);
      const ledger = await pool.query<{ migration_id: string }>(
        "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1",
        [countCaptureSchemaMigrations[0]!.migrationId],
      );
      expect(ledger.rows).toHaveLength(1);
      const store = createCountCaptureStore(pool, clock);
      const run = await store.admit({ ownerHash: owner("a") });
      await bootstrapContextDatabase(catalogModule, pool);
      for (const statement of [countCaptureSchemaSql, ...countCaptureSchemaMigrations.flatMap((m) => m.statements)])
        await pool.query(statement);
      expect(await store.read(run.runId)).toEqual(run);
      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = current_schema() AND tablename = 'catalog_scope_sync_count_capture_history'
         ORDER BY indexname`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "catalog_count_capture_owner_idx",
        "catalog_count_capture_run_idx",
        "catalog_scope_sync_count_capture_history_pkey",
      ]);
    });

    it.each([
      ["an unknown schema version", { schemaVersion: 2 }],
      ["an open payload", { unexpected: true }],
      [
        "an out-of-range send",
        {
          phases: ["baseline"],
          sends: [
            {
              sequence: 12,
              requestId: "00000000-0000-4000-8000-000000000012",
              phase: "baseline",
              category: "usage",
              requestFingerprint: fingerprint,
              debitedAt: "2026-10-14T00:00:00.000Z",
              status: null,
              respondedAt: null,
            },
          ],
        },
      ],
      ["a date-only instant", { expiresAt: "2026-10-14" }],
    ])("refuses %s on read and admission", async (_label, change) => {
      const store = createCountCaptureStore(primary.catalog, clock);
      const run = await store.admit({ ownerHash: owner("a") });
      await store.ledger.stop({ runId: run.runId, requestId: run.runId, phase: "baseline" });
      await primary.catalog.query(
        "INSERT INTO catalog_scope_sync_count_capture_history (run_id, owner_hash, payload) VALUES ($1, $2, $3::jsonb)",
        [run.runId, run.ownerHash, JSON.stringify({ ...run, status: "stopped", ...change })],
      );
      await expect(store.read(run.runId)).rejects.toThrow("capture-stopped");
      await expect(store.admit({ ownerHash: owner("b") })).rejects.toThrow("capture-stopped");
      const binding: CountCaptureBinding = { runId: run.runId, requestId: run.runId, phase: "bootstrap" };
      await expect(store.ledger.debit(binding, usage("bootstrap"))).rejects.toThrow("capture-stopped");
    });
  });
});
