import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as collectionsModule } from "../../../index";
import { activateAnonymousOwnerCutover } from "../../../support/runtime-support/anonymous-owner-activation";
import { redactLegacyAnonymousOwners } from "./anonymous-owner-redaction";
import { savedListFingerprint } from "./anonymous-owner";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for legacy owner redaction DB proof.");
const describeDb = baseUrl ? describe : describe.skip;
let pool: PgTransactionalPool;
const activation = { gatePacketSha256: "a".repeat(64), floorCommit: "b".repeat(40) };

async function seed(count: number) {
  await pool.query(
    `INSERT INTO collections_anonymous_saved_list_intents
    (intent_id, anonymous_owner_id, source_path, source_surface, catalog_catalog_item_id, product_id,
     selected_options, add_command_id, line_id, expires_at)
    SELECT 'sli_' || lpad(n::text, 5, '0'), 'anon_' || n, '/search', 'search', 'cat_redaction', 'product_redaction',
      '[]'::jsonb, 'slc_' || n, 'sll_' || n, now() + interval '30 days'
    FROM generate_series(1, $1::integer) AS n`,
    [count],
  );
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describeDb("legacy-owner-redaction-bounded-resume", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, ["collections"], "anonymous_owner_redaction");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pool = createMultiContextTestPools(urls).collections;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ collections: pool });
    await bootstrapContextDatabase(collectionsModule, pool);
  });
  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ collections: pool });
  });

  it.each([0, 1, 500, 501, 5000, 5001])("bounded resume of %i rows", async (count) => {
    await seed(count);
    const unchanged = (
      await pool.query(`SELECT intent_id, to_jsonb(i) - 'anonymous_owner_id'
      - 'anonymous_owner_fingerprint' - 'owner_revision' AS value
      FROM collections_anonymous_saved_list_intents i ORDER BY intent_id`)
    ).rows;
    const events = (await pool.query("SELECT count(*)::text AS count FROM event_store_events")).rows;
    await activateAnonymousOwnerCutover(pool, activation);
    const dry = await redactLegacyAnonymousOwners(pool, { dryRun: true });
    expect(dry).toMatchObject({ before: count, processed: 0, after: count, codes: [] });
    let batches = 0;
    let counts = 0;
    const boundedPool: PgTransactionalPool = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        if (sql.includes("count(*)::text AS remaining")) counts++;
        return pool.query<Row>(sql, values);
      },
      connect: async () => {
        batches++;
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(sql, values);
            if (sql.includes("SKIP LOCKED")) expect(result.rows.length).toBeLessThanOrEqual(500);
            return result;
          },
        };
      },
    };
    const first = await redactLegacyAnonymousOwners(boundedPool, { dryRun: false });
    expect(first).toMatchObject({
      before: count,
      processed: Math.min(count, 5000),
      after: Math.max(0, count - 5000),
      mismatches: 0,
      codes: [],
    });
    expect(batches).toBeLessThanOrEqual(10);
    expect(counts).toBe(2);
    const resumed = await redactLegacyAnonymousOwners(pool, { dryRun: false });
    expect(resumed.after).toBe(0);
    expect(first.processed + resumed.processed).toBe(count);
    expect(
      (
        await pool.query(`SELECT intent_id, to_jsonb(i) - 'anonymous_owner_id'
      - 'anonymous_owner_fingerprint' - 'owner_revision' AS value
      FROM collections_anonymous_saved_list_intents i ORDER BY intent_id`)
      ).rows,
    ).toEqual(unchanged);
    expect((await pool.query("SELECT count(*)::text AS count FROM event_store_events")).rows).toEqual(events);
    const rows = (
      await pool.query<{ anonymous_owner_id: null; anonymous_owner_fingerprint: string; owner_revision: number }>(
        "SELECT anonymous_owner_id, anonymous_owner_fingerprint, owner_revision FROM collections_anonymous_saved_list_intents ORDER BY intent_id",
      )
    ).rows;
    rows.forEach((row, i) =>
      expect(row).toEqual({
        anonymous_owner_id: null,
        anonymous_owner_fingerprint: savedListFingerprint(["collections.anonymous-owner.v1", `anon_${i + 1}`]),
        owner_revision: 1,
      }),
    );
  });

  it("inactive and mismatching rows remain untouched", async () => {
    await seed(501);
    expect(await redactLegacyAnonymousOwners(pool, { dryRun: false })).toMatchObject({
      processed: 0,
      after: 501,
      codes: ["activation-required"],
    });
    await pool.query(
      "UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_fingerprint = 'different' WHERE intent_id = 'sli_00001'",
    );
    await activateAnonymousOwnerCutover(pool, activation);
    const before = (
      await pool.query("SELECT * FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_00001'")
    ).rows;
    expect(await redactLegacyAnonymousOwners(pool, { dryRun: false })).toMatchObject({
      processed: 500,
      after: 1,
      mismatches: 1,
      codes: ["fingerprint-mismatch"],
    });
    expect(
      (await pool.query("SELECT * FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_00001'")).rows,
    ).toEqual(before);
  });

  it("runner authorization refuses before opening a mutation transaction", async () => {
    await seed(1);
    await activateAnonymousOwnerCutover(pool, activation);
    let transactions = 0;
    const guardedPool: PgTransactionalPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        transactions++;
        return pool.connect();
      },
    };
    await expect(
      redactLegacyAnonymousOwners(guardedPool, {
        dryRun: false,
        authorize: () => {
          throw new Error("synthetic-gate-refused");
        },
      }),
    ).rejects.toThrow("synthetic-gate-refused");
    expect(transactions).toBe(0);
    expect((await redactLegacyAnonymousOwners(pool, { dryRun: true })).after).toBe(1);
  });

  it("dry run observes through a default_transaction_read_only session", async () => {
    await seed(2);
    await activateAnonymousOwnerCutover(pool, activation);
    const client = await pool.connect();
    try {
      await client.query("SET default_transaction_read_only = on");
      const readOnlySession: PgTransactionalPool = {
        query: client.query.bind(client),
        connect: async () => {
          throw new Error("dry-run-opened-transaction");
        },
      };
      const dry = await redactLegacyAnonymousOwners(readOnlySession, { dryRun: true });
      expect(dry).toMatchObject({ before: 2, processed: 0, after: 2, codes: [] });
      expect(dry.activation.floor_commit).toBe(activation.floorCommit);
    } finally {
      await client.query("RESET default_transaction_read_only");
      client.release();
    }
  });

  it("observation failures expose a closed code rather than a database exception", async () => {
    const failingPool: PgTransactionalPool = {
      query: async () => {
        throw new Error("synthetic-secret-credential");
      },
      connect: pool.connect.bind(pool),
    };
    await expect(redactLegacyAnonymousOwners(failingPool, { dryRun: false })).rejects.toThrow(
      /^redaction-observation-failed$/,
    );
  });

  it.each(["claim", "upgrade", "purge"])("writer-first %s race skips locked rows and resumes", async (operation) => {
    await seed(1);
    await activateAnonymousOwnerCutover(pool, activation);
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "SELECT intent_id FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_00001' FOR UPDATE",
      );
      expect(await redactLegacyAnonymousOwners(pool, { dryRun: false })).toMatchObject({ processed: 0, after: 1 });
      if (operation === "purge")
        await writer.query("DELETE FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_00001'");
      else if (operation === "claim")
        await writer.query(`UPDATE collections_anonymous_saved_list_intents
        SET status = 'claiming', claimed_account_id = 'acc_race', owner_revision = owner_revision + 1 WHERE intent_id = 'sli_00001' AND owner_revision = 0`);
      else
        await writer.query(
          `UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_id = NULL,
        anonymous_owner_fingerprint = $1, owner_revision = owner_revision + 1 WHERE intent_id = 'sli_00001' AND owner_revision = 0`,
          [savedListFingerprint(["collections.anonymous-owner.v1", "anon_1"])],
        );
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
    const result = await redactLegacyAnonymousOwners(pool, { dryRun: false });
    expect(result.after).toBe(0);
    expect(result.processed).toBe(operation === "claim" ? 1 : 0);
    if (operation === "claim")
      expect(
        (await pool.query("SELECT status, claimed_account_id FROM collections_anonymous_saved_list_intents")).rows,
      ).toEqual([{ status: "claiming", claimed_account_id: "acc_race" }]);
  });

  it.each(["claim", "upgrade", "purge"])(
    "redactor-first %s race preserves the revision predicate",
    async (operation) => {
      await seed(1);
      await activateAnonymousOwnerCutover(pool, activation);
      const held = barrier();
      const proceed = barrier();
      const redactorPool: PgTransactionalPool = {
        query: pool.query.bind(pool),
        connect: async () => {
          const client = await pool.connect();
          return {
            release: client.release.bind(client),
            query: async <Row>(sql: string, values?: readonly unknown[]) => {
              const result = await client.query<Row>(sql, values);
              if (sql.includes("SKIP LOCKED")) {
                held.release();
                await proceed.promise;
              }
              return result;
            },
          };
        },
      };
      const redacting = redactLegacyAnonymousOwners(redactorPool, { dryRun: false });
      const writer = await pool.connect();
      let writing: ReturnType<typeof pool.query> | undefined;
      try {
        await held.promise;
        const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const sql =
          operation === "purge"
            ? "DELETE FROM collections_anonymous_saved_list_intents WHERE intent_id = 'sli_00001' AND owner_revision = 0"
            : operation === "claim"
              ? "UPDATE collections_anonymous_saved_list_intents SET status = 'claiming', owner_revision = owner_revision + 1 WHERE intent_id = 'sli_00001' AND owner_revision = 0"
              : "UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_id = NULL, anonymous_owner_fingerprint = 'stale', owner_revision = owner_revision + 1 WHERE intent_id = 'sli_00001' AND owner_revision = 0";
        writing = writer.query(sql);
        await vi.waitFor(async () => {
          const waiting = await pool.query<{ blocked: boolean }>(
            "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
            [pid],
          );
          expect(waiting.rows[0].blocked).toBe(true);
        });
      } finally {
        proceed.release();
      }
      expect((await redacting).processed).toBe(1);
      try {
        expect((await writing)?.rowCount).toBe(0);
      } finally {
        writer.release();
      }
      expect(
        (
          await pool.query(
            "SELECT status, owner_revision, anonymous_owner_id FROM collections_anonymous_saved_list_intents",
          )
        ).rows,
      ).toEqual([{ status: "active", owner_revision: 1, anonymous_owner_id: null }]);
    },
  );

  it.each(["before-transaction", "during-transaction", "commit-acknowledgement"])(
    "secret-bearing %s failure never leaks or blindly replays",
    async (failure) => {
      await seed(1);
      await activateAnonymousOwnerCutover(pool, activation);
      let connects = 0;
      const failingPool: PgTransactionalPool = {
        query: pool.query.bind(pool),
        connect: async () => {
          connects++;
          if (failure === "before-transaction") throw new Error("synthetic-secret-credential");
          const client = await pool.connect();
          return {
            release: client.release.bind(client),
            query: async <Row>(sql: string, values?: readonly unknown[]) => {
              if (failure === "during-transaction" && sql.includes("SKIP LOCKED"))
                throw new Error("synthetic-secret-credential");
              const result = await client.query<Row>(sql, values);
              if (failure === "commit-acknowledgement" && sql === "COMMIT")
                throw new Error("synthetic-secret-credential");
              return result;
            },
          };
        },
      };
      const result = await redactLegacyAnonymousOwners(failingPool, { dryRun: false });
      expect(result.codes).toEqual(["mutation-uncertain"]);
      expect(connects).toBe(1);
      expect(result.after).toBe(failure === "commit-acknowledgement" ? 0 : 1);
      expect(JSON.stringify(result)).not.toContain("synthetic-secret-credential");
      expect(JSON.stringify(result)).not.toContain("anon_1");
      expect((await redactLegacyAnonymousOwners(pool, { dryRun: false })).after).toBe(0);
    },
  );
});
