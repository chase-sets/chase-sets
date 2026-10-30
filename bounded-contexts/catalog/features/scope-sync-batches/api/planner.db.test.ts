import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { resolveScopeSyncCountMembership } from "./planner";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("scope-sync batch language edition selection", () => {
  let pools: Readonly<{ catalog: PgTransactionalPool }>;
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "scope_sync_language_10060");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await pool.query(catalogModule.schemaSql);
    await pool.query(
      `INSERT INTO catalog_scope_records
        (scope_record_id, product_domain, scope_kind, reference_type_key, reference_record_id, reference_record_key, name, lifecycle_status, language_editions)
       VALUES
        ('scope-pokemon-en', 'pokemon', 'expansion', 'expansion', 'ref-pokemon-en', 'pokemon-en', 'Pokemon EN', 'active', '["en"]'),
        ('scope-pokemon-ja', 'pokemon', 'expansion', 'expansion', 'ref-pokemon-ja', 'pokemon-ja', 'Pokemon JA', 'active', '["ja"]'),
        ('scope-pokemon-unstamped', 'pokemon', 'expansion', 'expansion', 'ref-pokemon-unstamped', 'pokemon-unstamped', 'Pokemon Unstamped', 'active', '[]'),
        ('scope-one-piece-unstamped', 'one-piece', 'set', 'set', 'ref-one-piece-unstamped', 'one-piece-unstamped', 'One Piece Unstamped', 'active', '[]')`,
    );
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it.each([
    ["en", ["scope-pokemon-en"]],
    ["ja", ["scope-pokemon-ja"]],
    [null, ["scope-pokemon-en", "scope-pokemon-ja", "scope-pokemon-unstamped"]],
  ] as const)("selects Pokemon records for language %s", async (languageCode, expectedIds) => {
    const result = await resolveScopeSyncCountMembership(pool, {
      mode: "matching-scope",
      query: { productDomain: "pokemon", scopeKind: "expansion", languageCode },
    });
    expect(result.records.map((record) => record.scope_record_id)).toEqual(expectedIds);
  });

  it("does not apply language filtering to One Piece", async () => {
    const result = await resolveScopeSyncCountMembership(pool, {
      mode: "matching-scope",
      query: { productDomain: "one-piece", scopeKind: "set", languageCode: "en" },
    });
    expect(result.records.map((record) => record.scope_record_id)).toEqual(["scope-one-piece-unstamped"]);
  });
});
