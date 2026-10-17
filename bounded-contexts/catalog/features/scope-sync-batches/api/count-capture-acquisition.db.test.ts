import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCountCaptureDbFixture } from "../tests/count-capture-db-fixture";
import { captureSession } from "../tests/count-capture-session-fixture";
import { CountCaptureStopped } from "../../source-observations/api/providers/count-capture-transport";

const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error("TEST_DATABASE_URL is required for capture acquisition DB proof.");
describe("capture acquisition through the ordinary writer on PostgreSQL", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base, ["catalog"], "count_capture_9586");
    await ensureMultiContextTestDatabases(base, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });
  it("retains both conjunctive debits and refuses a second acquisition", async () => {
    const f = await createCountCaptureDbFixture(pools.catalog);
    const quote = await f.prepare();
    await f.lifecycle.acquire(captureSession(), { quoteId: quote.quoteId, fingerprint: quote.fingerprint });
    expect(await f.countStore.history()).toMatchObject([
      { credits: 1, outcome: "complete" },
      { credits: 1, outcome: "complete" },
    ]);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const runs = await pools.catalog.query<{ payload: { sends: unknown[] } }>(
      "SELECT payload FROM catalog_scope_sync_count_capture_history ORDER BY position DESC LIMIT 1",
    );
    expect(runs.rows[0]!.payload.sends).toHaveLength(2);
    await expect(
      f.lifecycle.acquire(captureSession(), { quoteId: quote.quoteId, fingerprint: quote.fingerprint }),
    ).rejects.toThrow(CountCaptureStopped);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["failure", "uncertainty", "result-commit"])(
    "stops %s with its debit retained and no retry",
    async (mode) => {
      const f = await createCountCaptureDbFixture(pools.catalog);
      const quote = await f.prepare();
      const query = pools.catalog.query.bind(pools.catalog);
      const fault =
        mode === "result-commit"
          ? vi.spyOn(pools.catalog, "query").mockImplementation((async (sql: string, values?: readonly unknown[]) => {
              if (sql.includes("INSERT INTO catalog_scope_sync_count_history") && values?.[2] === "result")
                throw new Error("Synthetic result commit failure.");
              return query(sql, values);
            }) as PgTransactionalPool["query"])
          : null;
      if (mode === "failure") f.fetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
      if (mode === "uncertainty") f.fetch.mockRejectedValueOnce(new TypeError("Synthetic uncertain send."));
      try {
        await expect(
          f.lifecycle.acquire(captureSession(), { quoteId: quote.quoteId, fingerprint: quote.fingerprint }),
        ).rejects.toThrow(CountCaptureStopped);
      } finally {
        fault?.mockRestore();
      }
      expect(await f.countStore.history()).toHaveLength(1);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      await expect(
        f.lifecycle.acquire(captureSession(), { quoteId: quote.quoteId, fingerprint: quote.fingerprint }),
      ).rejects.toThrow(CountCaptureStopped);
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );
});
