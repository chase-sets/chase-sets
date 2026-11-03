import { describe, expect, it } from "vitest";
import type { CatalogScopeRecordDetail } from "../../../../scope-registry/ui/contracts";
import {
  buildCatalogScopeLandingReadModel,
  scopeDetailHref,
  SCOPE_LANDING_STALE_SYNC_MS,
} from "./scope-landing-read-model";

const GENERATED_AT = "2026-07-13T12:00:00.000Z";

function scope(overrides: Partial<CatalogScopeRecordDetail> = {}): CatalogScopeRecordDetail {
  return {
    scopeRecordId: "scope_expansion_paldean_fates",
    productDomain: "pokemon",
    scopeKind: "expansion",
    referenceTypeKey: "expansion",
    referenceRecordId: "ref_expansion_paldean_fates",
    referenceRecordKey: "paldean-fates",
    name: "Paldean Fates",
    parentScopeRecordId: null,
    productLineScopeRecordId: null,
    seriesScopeRecordId: null,
    releaseDate: "2024-01-26",
    officialSetCode: "PAF",
    languageEditions: ["en", "ja"],
    lifecycleStatus: "active",
    updatedAt: GENERATED_AT,
    ...overrides,
  };
}

function list(
  items: CatalogScopeRecordDetail[],
  total = items.length,
  languageEditions = [...new Set(items.flatMap((item) => item.languageEditions))],
) {
  return { items, total, count: items.length, facets: { languageEditions } };
}

const noFilters = { search: "", productDomain: "", languageEdition: "", lifecycleStatus: "" };

describe("buildCatalogScopeLandingReadModel", () => {
  it("maps a scope record to a landing row with coverage, promotion readiness, and a detail link", () => {
    const readModel = buildCatalogScopeLandingReadModel({
      scopes: list([scope()]),
      filters: noFilters,
      generatedAt: GENERATED_AT,
    });

    expect(readModel.rows).toHaveLength(1);
    const row = readModel.rows[0]!;
    expect(row.languageEditionCount).toBe(2);
    expect(row.promotionReadiness).toBe("live");
    expect(row.syncFreshness).toBe("fresh");
    expect(row.detailHref).toBe(scopeDetailHref("scope_expansion_paldean_fates"));
    expect(row.detailHref).toBe("/scopes/scope_expansion_paldean_fates");
  });

  it("maps lifecycle status to promotion readiness", () => {
    const readModel = buildCatalogScopeLandingReadModel({
      scopes: list([
        scope({ scopeRecordId: "a", lifecycleStatus: "draft" }),
        scope({ scopeRecordId: "b", lifecycleStatus: "active" }),
        scope({ scopeRecordId: "c", lifecycleStatus: "deprecated" }),
        scope({ scopeRecordId: "d", lifecycleStatus: "archived" }),
      ]),
      filters: noFilters,
      generatedAt: GENERATED_AT,
    });

    expect(readModel.rows.map((row) => row.promotionReadiness)).toEqual([
      "unpublished",
      "live",
      "deprecated",
      "archived",
    ]);
  });

  it("flags a scope whose projection has not advanced within the stale window as a stale sync", () => {
    const staleUpdatedAt = new Date(Date.parse(GENERATED_AT) - SCOPE_LANDING_STALE_SYNC_MS - 1).toISOString();
    const freshUpdatedAt = new Date(Date.parse(GENERATED_AT) - SCOPE_LANDING_STALE_SYNC_MS + 1).toISOString();

    const readModel = buildCatalogScopeLandingReadModel({
      scopes: list([
        scope({ scopeRecordId: "stale", updatedAt: staleUpdatedAt }),
        scope({ scopeRecordId: "fresh", updatedAt: freshUpdatedAt }),
      ]),
      filters: noFilters,
      generatedAt: GENERATED_AT,
    });

    expect(readModel.rows.find((row) => row.scopeRecordId === "stale")?.syncFreshness).toBe("stale");
    expect(readModel.rows.find((row) => row.scopeRecordId === "fresh")?.syncFreshness).toBe("fresh");
  });

  it("uses global language-edition facets and preserves the server total", () => {
    const readModel = buildCatalogScopeLandingReadModel({
      scopes: list(
        [
          scope({ scopeRecordId: "a", languageEditions: ["en", "ja"] }),
          scope({ scopeRecordId: "b", languageEditions: ["en", "fr"] }),
        ],
        42,
        ["en", "fr", "ja", "de"],
      ),
      filters: noFilters,
      generatedAt: GENERATED_AT,
    });

    expect(readModel.facets.languageEditions).toEqual(["de", "en", "fr", "ja"]);
    expect(readModel.counts.total).toBe(42);
    expect(readModel.counts.shown).toBe(2);
  });

  it("keeps the returned page intact and preserves an active empty selection", () => {
    const readModel = buildCatalogScopeLandingReadModel({
      scopes: list(
        [
          scope({ scopeRecordId: "a", languageEditions: ["en", "ja"] }),
          scope({ scopeRecordId: "b", languageEditions: ["en"] }),
        ],
        10,
        ["en"],
      ),
      filters: { ...noFilters, languageEdition: "ja" },
      generatedAt: GENERATED_AT,
    });

    expect(readModel.rows.map((row) => row.scopeRecordId)).toEqual(["a", "b"]);
    expect(readModel.counts.shown).toBe(2);
    expect(readModel.counts.total).toBe(10);
    // The active facet stays selectable even though only one edition remains on the page.
    expect(readModel.facets.languageEditions).toContain("ja");
  });

  it("preserves global facets and total when the active page is empty", () => {
    const readModel = buildCatalogScopeLandingReadModel({
      scopes: list([], 1, ["en"]),
      filters: { ...noFilters, languageEdition: "ja" },
      generatedAt: GENERATED_AT,
    });

    expect(readModel.rows).toEqual([]);
    expect(readModel.counts.total).toBe(1);
    expect(readModel.facets.languageEditions).toEqual(["en", "ja"]);
  });
});
