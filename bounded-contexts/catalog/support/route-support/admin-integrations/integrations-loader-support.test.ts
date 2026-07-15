import { describe, expect, it } from "vitest";
import type { CatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import { buildDailyMergeCandidateQuery } from "./integrations-loader-support";

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
