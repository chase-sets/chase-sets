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
import { listCatalogScopeRecords } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("catalog scope registry language filtering", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "scope_registry_language_10565");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await pool.query(catalogModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools({ catalog: pool });
  });

  async function insertRows(
    rows: readonly { id: string; name: string; domain?: string; kind?: string; languages: string[] }[],
  ) {
    for (const row of rows) {
      await pool.query(
        `INSERT INTO catalog_scope_records
          (scope_record_id, product_domain, scope_kind, reference_type_key, reference_record_id, reference_record_key, name, lifecycle_status, language_editions)
         VALUES ($1, $2, $3, $3, $1, $4, $4, 'active', $5::jsonb)`,
        [row.id, row.domain ?? "pokemon", row.kind ?? "expansion", row.name, JSON.stringify(row.languages)],
      );
    }
  }

  it("filters before pagination and reports a total for a language present only on row 21", async () => {
    await insertRows([
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `scope-en-${index + 1}`,
        name: `Set ${String(index + 1).padStart(2, "0")}`,
        languages: ["en"],
      })),
      { id: "scope-ja-21", name: "Set 21", languages: ["ja"] },
    ]);

    const firstPage = await listCatalogScopeRecords(pool, { languageEdition: "ja", limit: 20, offset: 0 });
    const beyond = await listCatalogScopeRecords(pool, { languageEdition: "ja", limit: 20, offset: 20 });
    const unmatched = await listCatalogScopeRecords(pool, { languageEdition: "fr", limit: 20, offset: 0 });

    expect(firstPage.total).toBe(1);
    expect(firstPage.items.map((row) => row.scope_record_id)).toEqual(["scope-ja-21"]);
    expect(beyond.total).toBe(1);
    expect(beyond.items).toEqual([]);
    expect(unmatched.total).toBe(0);
    expect(unmatched.items).toEqual([]);
  });

  it("keeps language facets global across pages and applies non-language cohorts", async () => {
    await insertRows([
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `scope-en-${index + 1}`,
        name: `Set ${String(index + 1).padStart(2, "0")}`,
        languages: ["en"],
      })),
      { id: "scope-ja-21", name: "Set 21", kind: "set", languages: ["ja", "fr"] },
    ]);

    const pageOne = await listCatalogScopeRecords(pool, { limit: 20, offset: 0, languageEdition: "ja" });
    const pageTwo = await listCatalogScopeRecords(pool, { limit: 20, offset: 20, languageEdition: "ja" });
    const setCohort = await listCatalogScopeRecords(pool, { scopeKind: "set", limit: 50, offset: 0 });

    expect(pageOne.facets.languageEditions).toEqual(["en", "fr", "ja"]);
    expect(pageTwo.facets.languageEditions).toEqual(["en", "fr", "ja"]);
    expect(pageOne.items.map((row) => row.scope_record_id)).toEqual(["scope-ja-21"]);
    expect(setCohort.facets.languageEditions).toEqual(["fr", "ja"]);
  });
});
