import { describe, expect, it } from "vitest";
import type { CatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import { buildDailyMergeCandidateQuery, importPreviewMatchesSelectedScope } from "./integrations-loader-support";
import { importPreviewMatchesRouteContext } from "../../../features/source-observations/ui/admin-control-plane/import-jobs/import-jobs-module";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import type { SourceObservationIntegrationImportPreview } from "../../../features/source-observations/ui/contracts";

const baseContext: CatalogPrimaryWorkbenchRouteContext = {
  section: "import-to-promotion",
  providerKey: "tcgplayer",
  unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
  importScope: "en:3:Base Set",
  profileVersion: "2026.06.03",
  sourceObservationFilters: {},
  selectedObservationIds: [],
  reviewOffset: null,
  reviewLimit: null,
  jobId: "job_parent_sync",
  promotionPreviewId: null,
  returnPath: null,
  scope: {
    providerKey: "tcgplayer",
    productId: null,
    languageCode: "en",
    productLineId: "3",
    productLineName: "Pokemon",
    seriesId: null,
    seriesName: null,
    expansionId: "Base Set",
    expansionName: "Base Set",
    status: null,
  },
};

describe("admin integrations loader support", () => {
  it("binds loader and rendered preview identity to the exact selected product, including deselection", () => {
    const context = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=ygojson&unitKey=ygojson:yugioh:sealed-product:reference-data&languageCode=en&productId=synthetic-product-A",
    );
    const scope = {
      provider: "ygojson",
      ingestionUnitKey: "ygojson:yugioh:sealed-product:reference-data",
      language: "en",
      productId: "synthetic-product-A",
    };
    const preview: SourceObservationIntegrationImportPreview = {
      action: "import",
      providerKey: "ygojson",
      scope,
      profileSnapshot: null,
      targetCount: 0,
      targets: [],
    };
    expect(importPreviewMatchesSelectedScope(preview, scope)).toBe(true);
    expect(importPreviewMatchesRouteContext(preview, context)).toBe(true);
    for (const productId of ["synthetic-product-B", "synthetic-product-a", undefined]) {
      const stale = { ...preview, scope: { ...scope, productId } };
      expect(importPreviewMatchesSelectedScope(stale, scope)).toBe(false);
      expect(importPreviewMatchesRouteContext(stale, context)).toBe(false);
    }
    expect(importPreviewMatchesSelectedScope(preview, { ...scope, productId: undefined })).toBe(false);
    expect(
      importPreviewMatchesRouteContext(preview, { ...context, scope: { ...context.scope!, productId: null } }),
    ).toBe(false);
  });
  it("queries merge candidates by selected catalog scope instead of only the current parent sync run", () => {
    const params = new URLSearchParams(buildDailyMergeCandidateQuery(baseContext));

    expect(params.get("provider")).toBe("tcgplayer");
    expect(params.get("language")).toBe("en");
    expect(params.get("productLineId")).toBe("3");
    expect(params.get("productLineName")).toBe("Pokemon");
    expect(params.get("setId")).toBe("Base Set");
    expect(params.has("syncRunId")).toBe(false);
  });

  it("keeps sync-run filtering when no catalog scope is selected", () => {
    const params = new URLSearchParams(
      buildDailyMergeCandidateQuery({
        ...baseContext,
        importScope: null,
        scope: undefined,
      }),
    );

    expect(params.get("syncRunId")).toBe("job_parent_sync");
    expect(params.has("productLineId")).toBe(false);
  });

  it("uses canonical Scope Record identity on the scope-first journey", () => {
    const params = new URLSearchParams(
      buildDailyMergeCandidateQuery({
        ...baseContext,
        providerKey: null,
        unitKey: null,
        scopeRecordId: "scope_expansion_paldean_fates",
      }),
    );

    expect(params.get("scopeRecordId")).toBe("scope_expansion_paldean_fates");
    expect(params.has("setId")).toBe(false);
    expect(params.has("syncRunId")).toBe(false);
  });
});
