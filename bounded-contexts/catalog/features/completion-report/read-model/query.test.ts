import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { classifyProviderProductionClass, queryProductionCatalogReconciliationFacts } from "./query";

// A stub queryable that dispatches canned rows by the first Catalog table each
// query references. Proves the row-to-contract mapping without a database.
function stubQueryable(rowsByTable: Record<string, unknown[]>): PgQueryable {
  const query = (sql: string): Promise<{ rows: unknown[] }> => {
    const isGrouped = /GROUP BY/i.test(sql);
    const table = Object.keys(rowsByTable).find((name) => sql.includes(name));
    if (!table) throw new Error(`unexpected query: ${sql}`);
    const key = isGrouped ? `${table}::grouped` : table;
    return Promise.resolve({ rows: rowsByTable[key] ?? rowsByTable[table] ?? [] });
  };
  return { query } as unknown as PgQueryable;
}

describe("classifyProviderProductionClass", () => {
  it("classifies active production, validation lifecycles, and retired units", () => {
    expect(classifyProviderProductionClass({ lifecycle: "active", active: true })).toBe("production");
    expect(classifyProviderProductionClass({ lifecycle: "active", active: false })).toBe("unapproved");
    expect(classifyProviderProductionClass({ lifecycle: "test", active: false })).toBe("validation-only");
    expect(classifyProviderProductionClass({ lifecycle: "draft", active: false })).toBe("validation-only");
    expect(classifyProviderProductionClass({ lifecycle: "retired", active: false })).toBe("retired");
    expect(classifyProviderProductionClass({ lifecycle: "deprecated", active: false })).toBe("unapproved");
  });
});

describe("queryProductionCatalogReconciliationFacts", () => {
  it("maps read-model rows into reconciliation facts", async () => {
    const db = stubQueryable({
      catalog_scope_records: [{ scope_record_id: "scope-1", lifecycle_status: "active" }],
      catalog_provider_scope_mappings: [{ scope_record_id: "scope-1", provider_key: "scrydex", unit_key: "cards" }],
      catalog_provider_integration_profile_versions: [
        { provider_key: "scrydex", ingestion_unit_key: "cards", lifecycle: "active", active: true },
      ],
      catalog_scope_sync_state: [
        {
          scope_key: "scope-1",
          provider_key: "scrydex",
          unit_key: "cards",
          state: "settled",
          last_sync_run_id: "run-1",
          last_completed_at: "2026-08-02T00:00:00.000Z",
          observed_count: 10,
          changed_count: 1,
          failed_count: 0,
        },
      ],
      catalog_merge_candidates: [
        {
          candidate_id: "cand-1",
          scope_record_id: "scope-1",
          status: "has-conflicts",
          conflicts_json: JSON.stringify([{ severity: "blocking", kind: "duplicate-prevention" }]),
        },
      ],
      "catalog_merge_candidates::grouped": [
        { status: "promoted", promotion_intent: "create-catalog-item", total: 3 },
        { status: "rejected", promotion_intent: "create-catalog-item", total: 1 },
      ],
      catalog_items: [
        { status: "published", total: 3 },
        { status: "draft", total: 2 },
      ],
      catalog_source_observations: [
        { status: "promoted", total: 3 },
        { status: "observed", total: 4 },
      ],
    });

    const facts = await queryProductionCatalogReconciliationFacts(db);

    expect(facts.scopes).toEqual([
      { scopeRecordId: "scope-1", eligible: true, acceptedMappings: [{ providerKey: "scrydex", unitKey: "cards" }] },
    ]);
    expect(facts.providerUnits[0]).toMatchObject({ providerKey: "scrydex", productionClass: "production" });
    expect(facts.observedUnits[0]).toMatchObject({
      scopeRecordId: "scope-1",
      state: "settled",
      lastCompletedAt: "2026-08-02T00:00:00.000Z",
    });
    expect(facts.mergeCandidates[0]).toMatchObject({
      candidateId: "cand-1",
      blockingConflictCount: 1,
      duplicatePreventionBlocked: true,
    });
    expect(facts.promotions).toEqual({ create: 3, update: 0, ignore: 1, defer: 0 });
    expect(facts.catalogItems).toEqual({ draft: 2, published: 3 });
    expect(facts.sourceObservations.total).toBe(7);
    expect(facts.sourceObservations.promoted).toBe(3);
  });
});
