import { describe, expect, it, vi } from "vitest";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import { representativeCatalogScopeRecordFixtures } from "../domain/contract";
import { buildCatalogScopeRegistryProjectionHandlers } from "./projection";

describe("Catalog scope registry projection", () => {
  it("projects canonical product-line, series, and expansion records with lifecycle and scope attributes", async () => {
    const query = scopeRegistryQuery({
      ref_series_scarlet_violet: {
        scope_record_id: "ref_series_scarlet_violet",
        reference_record_id: "ref_series_scarlet_violet",
        product_domain: "pokemon",
        scope_kind: "series",
        product_line_scope_record_id: "ref_product_line_pokemon",
        series_scope_record_id: null,
      },
    });
    const handlers = buildCatalogScopeRegistryProjectionHandlers({ query });

    await handlers["catalog.reference-record.created"]?.({
      streamId: "catalog.reference-record-ref_expansion_paldean_fates",
      data: {
        referenceRecordId: "ref_expansion_paldean_fates",
        typeKey: "expansion",
        key: "paldean-fates",
        name: localizedTextMapFromEnglish("Paldean Fates"),
        attributes: {
          "release-date": "2024-01-26",
          "official-set-code": "PAF",
          "language-editions": ["ja", "en"],
        },
        relationships: [{ relationshipType: "part-of", referenceId: "ref_series_scarlet_violet" }],
      },
      timing: { recordedAt: "2026-07-03T12:00:00.000Z" },
    } as never);

    const insertCall = findQueryCall(query, "INSERT INTO catalog_scope_records");
    expect(insertCall[1]).toEqual([
      "ref_expansion_paldean_fates",
      "pokemon",
      "expansion",
      "expansion",
      "ref_expansion_paldean_fates",
      "paldean-fates",
      JSON.stringify(localizedTextMapFromEnglish("Paldean Fates")),
      "Paldean Fates",
      "ref_series_scarlet_violet",
      "ref_product_line_pokemon",
      "ref_series_scarlet_violet",
      "2024-01-26",
      "PAF",
      JSON.stringify(["en", "ja"]),
      JSON.stringify({
        "release-date": "2024-01-26",
        "official-set-code": "PAF",
        "language-editions": ["ja", "en"],
      }),
      JSON.stringify([{ relationshipType: "part-of", referenceId: "ref_series_scarlet_violet" }]),
      "draft",
      "2026-07-03T12:00:00.000Z",
    ]);
  });

  it("projects one representative expansion or set scope for every canonical product domain", async () => {
    for (const fixture of representativeCatalogScopeRecordFixtures) {
      const parentReferenceRecordId = `ref_parent_${fixture.productDomain.replace(/-/g, "_")}`;
      const query = scopeRegistryQuery({
        [parentReferenceRecordId]: {
          scope_record_id: parentReferenceRecordId,
          reference_record_id: parentReferenceRecordId,
          product_domain: fixture.productDomain,
          scope_kind: fixture.productDomain === "pokemon" ? "series" : "product-line",
          product_line_scope_record_id: fixture.productDomain === "pokemon" ? "ref_product_line_pokemon" : null,
          series_scope_record_id: null,
        },
      });
      const handlers = buildCatalogScopeRegistryProjectionHandlers({ query });

      await handlers["catalog.reference-record.created"]?.({
        streamId: `catalog.reference-record-ref_${fixture.referenceRecordKey.replace(/-/g, "_")}`,
        data: {
          referenceRecordId: `ref_${fixture.referenceRecordKey.replace(/-/g, "_")}`,
          typeKey: fixture.referenceTypeKey,
          key: fixture.referenceRecordKey,
          name: localizedTextMapFromEnglish(fixture.name),
          attributes: fixture.attributes,
          relationships: [{ relationshipType: "part-of", referenceId: parentReferenceRecordId }],
        },
        timing: { recordedAt: "2026-07-03T12:00:00.000Z" },
      } as never);

      const insertCall = findQueryCall(query, "INSERT INTO catalog_scope_records");
      expect(insertCall[1]?.[1]).toBe(fixture.productDomain);
      expect(insertCall[1]?.[2]).toBe(fixture.scopeKind);
      expect(insertCall[1]?.[12]).toBe(fixture.attributes["official-set-code"]);
    }
  });

  it("updates lifecycle status without rewriting provider scope planner data", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogScopeRegistryProjectionHandlers({ query });

    await handlers["catalog.reference-record.published"]?.({
      streamId: "catalog.reference-record-ref_expansion_paldean_fates",
      data: {},
      timing: { recordedAt: "2026-07-03T12:01:00.000Z" },
    } as never);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE catalog_scope_records"), [
      "ref_expansion_paldean_fates",
      "active",
      "2026-07-03T12:01:00.000Z",
    ]);
  });
});

function scopeRegistryQuery(parentRowsByReferenceRecordId: Record<string, Record<string, unknown>>) {
  return vi.fn(async (sql: string, params?: readonly unknown[]) => {
    if (sql.includes("FROM catalog_scope_records") && sql.includes("reference_record_id = ANY")) {
      const ids = Array.isArray(params?.[0]) ? (params?.[0] as readonly string[]) : [];
      return { rows: ids.map((id) => parentRowsByReferenceRecordId[id]).filter(Boolean) };
    }
    return { rows: [] };
  });
}

function findQueryCall(query: ReturnType<typeof vi.fn>, sqlFragment: string): [string, readonly unknown[] | undefined] {
  const call = query.mock.calls.find(([sql]) => String(sql).includes(sqlFragment));
  expect(call, `Expected a query containing ${sqlFragment}`).toBeDefined();
  return call as [string, readonly unknown[] | undefined];
}
