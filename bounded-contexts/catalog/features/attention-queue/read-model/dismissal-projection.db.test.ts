import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildCatalogAttentionDismissalProjectionHandlers } from "./dismissal-projection";
import { listActiveAttentionDismissalKeys, listAttentionDismissals } from "./dismissal-queries";
import { catalogAttentionDismissalSchemaSql } from "./dismissal-schema";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = adminDatabaseUrl ? describe : describe.skip;

function event(type: string, data: Record<string, unknown>, recordedAt: string) {
  return {
    type,
    data,
    streamId: `catalog.attention-dismissal-${String(data.itemKey)}`,
    timing: { recordedAt },
  } as never;
}

describeDb("catalog attention dismissal projection", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["catalog"],
      "catalog_attention_dismissal",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools!);
    await pools!.catalog.query(catalogAttentionDismissalSchemaSql);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("suppresses dismissed items, ages deferred items back in, and clears on restore", async () => {
    const pool = pools!.catalog;
    const handlers = buildCatalogAttentionDismissalProjectionHandlers(pool);
    const now = "2026-07-09T00:00:00.000Z";

    await handlers["catalog.attention-item.dismissed"]!(
      event(
        "catalog.attention-item.dismissed",
        { itemKey: "merge-conflict:c1", kind: "merge-conflict", actor: "op", reason: "later" },
        now,
      ),
    );
    await handlers["catalog.attention-item.deferred"]!(
      event(
        "catalog.attention-item.deferred",
        {
          itemKey: "import-job:j1",
          kind: "import-job",
          actor: "op",
          reason: "retry",
          deferredUntil: "2026-07-10T00:00:00.000Z",
        },
        now,
      ),
    );
    await handlers["catalog.attention-item.deferred"]!(
      event(
        "catalog.attention-item.deferred",
        {
          itemKey: "alias-candidate:h1",
          kind: "alias-candidate",
          actor: "op",
          reason: "hold",
          deferredUntil: "2026-07-08T00:00:00.000Z",
        },
        now,
      ),
    );

    // Dismissed + still-deferred are suppressed; the elapsed deferral ages back in.
    const active = await listActiveAttentionDismissalKeys(pool, { now });
    expect(active.has("merge-conflict:c1")).toBe(true);
    expect(active.has("import-job:j1")).toBe(true);
    expect(active.has("alias-candidate:h1")).toBe(false);
    expect((await listAttentionDismissals(pool)).length).toBe(3);

    // Restoring drops the row so the item returns to the queue.
    await handlers["catalog.attention-item.restored"]!(
      event("catalog.attention-item.restored", { itemKey: "merge-conflict:c1", actor: "op" }, now),
    );
    const afterRestore = await listActiveAttentionDismissalKeys(pool, { now });
    expect(afterRestore.has("merge-conflict:c1")).toBe(false);
    expect((await listAttentionDismissals(pool)).length).toBe(2);
  });
});
