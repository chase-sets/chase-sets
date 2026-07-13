import { describe, expect, it } from "vitest";
import {
  catalogPrimaryWorkbenchContextKeysFromUrl,
  catalogPrimaryWorkbenchHref,
  catalogPrimaryWorkbenchReturnPath,
  catalogPrimaryWorkbenchSupportingHref,
  parseCatalogPrimaryWorkbenchRouteContext,
  serializeCatalogPrimaryWorkbenchRouteContext,
} from "./primary-workbench-route-context";
import { buildCatalogPrimaryWorkbenchSourceObservationReviewQuery } from "./primary-workbench-source-observation-review";

describe("Catalog primary workbench route context", () => {
  it("parses canonical context keys without preserving legacy aliases", () => {
    const context = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?section=triage&providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:base&profileVersion=2026.06.04&filter.status=changed&selectedObservationIds=obs_1,obs_2&jobId=job_1&promotionPreviewId=preview_1&returnPath=%2Fcatalog%2Fintegrations&source=legacy",
    );

    expect(context).toMatchObject({
      section: "health-triage",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      scope: {
        providerKey: "tcgdex",
        languageCode: "en",
        seriesId: "base",
        expansionId: null,
      },
      importScope: "en:base",
      profileVersion: "2026.06.04",
      sourceObservationFilters: { status: "changed" },
      selectedObservationIds: ["obs_1", "obs_2"],
      jobId: "job_1",
      promotionPreviewId: "preview_1",
      returnPath: "/catalog/integrations",
    });
    expect(context.sourceObservationFilters).not.toHaveProperty("source");
    expect(
      catalogPrimaryWorkbenchContextKeysFromUrl(
        new URL("https://admin.example/catalog/integrations?section=legacy&source=tcgdex"),
      ),
    ).toEqual(["section"]);
    expect(
      parseCatalogPrimaryWorkbenchRouteContext("https://admin.example/catalog/integrations?section=legacy").section,
    ).toBe("import-to-promotion");
  });

  it("builds structured scope context from explicit params and legacy importScope URLs", () => {
    const explicit = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgdex&languageCode=ja&seriesId=SV&expansionId=SV8",
    );
    const legacy = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgdex&importScope=ja:SV:SV8",
    );
    const productLine = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgplayer&importScope=en:3",
    );

    expect(explicit.scope).toMatchObject({
      providerKey: "tcgdex",
      languageCode: "ja",
      seriesId: "SV",
      expansionId: "SV8",
    });
    expect(explicit.importScope).toBe("ja:SV:SV8");
    expect(legacy.scope).toMatchObject({
      providerKey: "tcgdex",
      languageCode: "ja",
      seriesId: "SV",
      expansionId: "SV8",
    });
    expect(productLine.scope).toMatchObject({
      providerKey: "tcgplayer",
      languageCode: "en",
      productLineId: "3",
      seriesId: null,
    });
  });

  it("does not reinterpret a TCGplayer product-line set selection as language scope", () => {
    const context = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgplayer&productLineId=1&expansionId=Classic+Sixth+Edition&sourceOptionAction=force-refresh-all",
    );
    const reviewQuery = new URLSearchParams(buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(context) ?? "");

    expect(context.scope).toMatchObject({
      providerKey: "tcgplayer",
      languageCode: null,
      productLineId: "1",
      seriesId: null,
      expansionId: "Classic Sixth Edition",
    });
    expect(context.importScope).toBeNull();
    expect(reviewQuery.get("provider")).toBe("tcgplayer");
    expect(reviewQuery.get("language")).toBeNull();
    expect(reviewQuery.get("productLineId")).toBe("1");
    expect(reviewQuery.get("setId")).toBe("Classic Sixth Edition");
  });

  it("drops unsafe return paths instead of preserving compatibility detours", () => {
    expect(
      parseCatalogPrimaryWorkbenchRouteContext(
        "https://admin.example/catalog/integrations?returnPath=https%3A%2F%2Fexample.com%2Fcatalog%2Fintegrations",
      ).returnPath,
    ).toBeNull();
    expect(
      parseCatalogPrimaryWorkbenchRouteContext(
        "https://admin.example/catalog/integrations?returnPath=%2Fcatalog%2Fsource-observations%3Fsource%3Dlegacy",
      ).returnPath,
    ).toBeNull();
    expect(
      parseCatalogPrimaryWorkbenchRouteContext(
        "https://admin.example/catalog/integrations?returnPath=%2Fcatalog%2Fintegrations%3FproviderKey%3Dtcgdex%26section%3Dworkbench%26source%3Dlegacy",
      ).returnPath,
    ).toBeNull();
  });

  it("serializes context into a clean primary workbench surface route href", () => {
    const searchParams = serializeCatalogPrimaryWorkbenchRouteContext({
      section: "health-triage",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:base",
      profileVersion: "2026.06.04",
      sourceObservationFilters: { status: "changed" },
      selectedObservationIds: ["obs_1"],
      reviewOffset: null,
      reviewLimit: null,
      jobId: null,
      promotionPreviewId: null,
      returnPath: "/catalog/integrations",
    });

    expect(searchParams.toString()).toContain("providerKey=tcgdex");
    expect(searchParams.toString()).toContain("section=triage");
    expect(searchParams.toString()).toContain("filter.status=changed");
    expect(searchParams.toString()).not.toContain("source=");

    // The daily/import-to-promotion workspace is the base route with no ?section=.
    expect(
      catalogPrimaryWorkbenchHref(
        {
          section: "import-to-promotion",
          providerKey: "tcgdex",
          unitKey: "tcgdex:pokemon:card:import",
          importScope: "en:base",
          profileVersion: "2026.06.04",
          sourceObservationFilters: {},
          selectedObservationIds: [],
          reviewOffset: null,
          reviewLimit: null,
          jobId: null,
          promotionPreviewId: null,
          returnPath: null,
        },
        "import-to-promotion",
      ),
    ).toBe(
      "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Acard%3Aimport&importScope=en%3Abase&profileVersion=2026.06.04",
    );

    // A supporting workspace deep-links to its surface route; ?section= names the
    // precise workspace inside a multi-workspace surface.
    const triageHref = new URL(
      catalogPrimaryWorkbenchHref(
        {
          section: "import-to-promotion",
          providerKey: "tcgdex",
          unitKey: null,
          importScope: null,
          profileVersion: null,
          sourceObservationFilters: {},
          selectedObservationIds: [],
          reviewOffset: null,
          reviewLimit: null,
          jobId: null,
          promotionPreviewId: null,
          returnPath: null,
        },
        "health-triage",
      ),
      "https://admin.example",
    );
    expect(triageHref.pathname).toBe("/catalog/integrations/health");
    expect(triageHref.searchParams.get("section")).toBe("triage");

    // The first workspace of a surface is its default and needs no ?section=.
    // profile-authoring/validation-readiness/lifecycle-recovery are retired
    // (#3832 — folded into the v2 Provider detail page), so this now uses
    // conflict-resolution, the first workspace remaining on the governance
    // surface.
    const conflictHref = new URL(
      catalogPrimaryWorkbenchHref(
        {
          section: "import-to-promotion",
          providerKey: "tcgdex",
          unitKey: null,
          importScope: null,
          profileVersion: null,
          sourceObservationFilters: {},
          selectedObservationIds: [],
          reviewOffset: null,
          reviewLimit: null,
          jobId: null,
          promotionPreviewId: null,
          returnPath: null,
        },
        "conflict-resolution",
      ),
      "https://admin.example",
    );
    expect(conflictHref.pathname).toBe("/catalog/integrations/governance");
    expect(conflictHref.searchParams.has("section")).toBe(false);
  });

  it("preserves scope names that cannot be reconstructed from importScope", () => {
    const href = new URL(
      catalogPrimaryWorkbenchHref(
        {
          section: "import-to-promotion",
          providerKey: "tcgplayer",
          unitKey: "tcgplayer:mtg:sealed-product:source-observation-import",
          scope: {
            providerKey: "tcgplayer",
            languageCode: "en",
            productLineId: "1",
            productLineName: "Magic: The Gathering",
            seriesId: null,
            seriesName: null,
            expansionId: "5DN",
            expansionName: "Fifth Dawn",
            status: null,
          },
          importScope: "en:5DN",
          profileVersion: "2026.06.19",
          sourceObservationFilters: {},
          selectedObservationIds: [],
          reviewOffset: null,
          reviewLimit: null,
          jobId: null,
          promotionPreviewId: null,
          returnPath: null,
        },
        "import-to-promotion",
      ),
      "https://admin.example",
    );

    expect(href.searchParams.get("importScope")).toBe("en:5DN");
    expect(href.searchParams.get("productLineId")).toBe("1");
    expect(href.searchParams.get("productLineName")).toBe("Magic: The Gathering");
    expect(href.searchParams.get("expansionId")).toBe("5DN");
    expect(href.searchParams.get("expansionName")).toBe("Fifth Dawn");
    expect(parseCatalogPrimaryWorkbenchRouteContext(href).scope).toMatchObject({
      providerKey: "tcgplayer",
      productLineId: "1",
      productLineName: "Magic: The Gathering",
      seriesId: null,
      expansionId: "5DN",
      expansionName: "Fifth Dawn",
    });
  });

  it("derives the active workspace from the surface route path when no section param is present", () => {
    expect(
      parseCatalogPrimaryWorkbenchRouteContext("https://admin.example/catalog/integrations/governance").section,
    ).toBe("lifecycle-recovery");
    expect(parseCatalogPrimaryWorkbenchRouteContext("https://admin.example/catalog/integrations/health").section).toBe(
      "audit-evidence",
    );
    expect(parseCatalogPrimaryWorkbenchRouteContext("https://admin.example/catalog/integrations").section).toBe(
      "import-to-promotion",
    );
    // The retired /catalog/integrations/providers path (#3832 — profile
    // authoring, validation readiness, and lifecycle recovery moved to the v2
    // Provider detail page) is no longer a known surface path: it safely falls
    // back to the daily default instead of resolving a stale workspace.
    expect(
      parseCatalogPrimaryWorkbenchRouteContext("https://admin.example/catalog/integrations/providers").section,
    ).toBe("import-to-promotion");
    // An unknown ?section= value falls back the same way. "validation-readiness"
    // is the retired workspace key itself (not "readiness", which remains a
    // distinct, still-valid primary daily section unrelated to the retired
    // ?section= workspace router).
    expect(
      parseCatalogPrimaryWorkbenchRouteContext(
        "https://admin.example/catalog/integrations?section=validation-readiness",
      ).section,
    ).toBe("import-to-promotion");
  });

  it("round-trips the durable review pager cursor (reviewOffset/reviewLimit) through the URL", () => {
    const context = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgdex&filter.status=changed&selectedObservationIds=obs_1&reviewOffset=50&reviewLimit=25",
    );
    expect(context.reviewOffset).toBe(50);
    expect(context.reviewLimit).toBe(25);

    // The pager href keeps provider/filters/selection and only moves the offset; the
    // first page drops the offset so the canonical URL stays clean.
    const nextHref = new URL(
      catalogPrimaryWorkbenchHref({ ...context, reviewOffset: 75 }, "source-observation-review"),
      "https://admin.example",
    );
    expect(nextHref.searchParams.get("reviewOffset")).toBe("75");
    expect(nextHref.searchParams.get("providerKey")).toBe("tcgdex");
    expect(nextHref.searchParams.get("filter.status")).toBe("changed");
    expect(nextHref.searchParams.get("selectedObservationIds")).toBe("obs_1");

    const firstPageHref = new URL(
      catalogPrimaryWorkbenchHref({ ...context, reviewOffset: null }, "source-observation-review"),
      "https://admin.example",
    );
    expect(firstPageHref.searchParams.has("reviewOffset")).toBe(false);
    expect(firstPageHref.searchParams.get("selectedObservationIds")).toBe("obs_1");
  });

  it("rejects malformed and zero review pager cursors", () => {
    const negative = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgdex&reviewOffset=-5&reviewLimit=0",
    );
    expect(negative.reviewOffset).toBeNull();
    expect(negative.reviewLimit).toBeNull();

    const garbage = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgdex&reviewOffset=abc&reviewLimit=2.5",
    );
    expect(garbage.reviewOffset).toBeNull();
    expect(garbage.reviewLimit).toBeNull();

    // Offset 0 is the canonical first page and is parsed but never re-serialized.
    const firstPage = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgdex&reviewOffset=0",
    );
    expect(firstPage.reviewOffset).toBe(0);
    expect(serializeCatalogPrimaryWorkbenchRouteContext(firstPage).has("reviewOffset")).toBe(false);
  });

  it("keeps a small selection in the URL but caps a bulk (500-row) selection to a count, not the row ids", () => {
    const context = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:base",
    );

    const smallSelection = { ...context, selectedObservationIds: ["obs_1", "obs_2"] };
    const smallHref = new URL(
      catalogPrimaryWorkbenchHref(smallSelection, "source-observation-review"),
      "https://admin.example",
    );
    expect(smallHref.searchParams.get("selectedObservationIds")).toBe("obs_1,obs_2");
    expect(smallHref.searchParams.has("selectedObservationCount")).toBe(false);

    const bulkIds = Array.from({ length: 500 }, (_, index) => `obs_${index}`);
    const bulkSelection = { ...context, selectedObservationIds: bulkIds };
    const bulkHref = new URL(
      catalogPrimaryWorkbenchHref(bulkSelection, "source-observation-review"),
      "https://admin.example",
    );
    expect(bulkHref.searchParams.has("selectedObservationIds")).toBe(false);
    expect(bulkHref.searchParams.get("selectedObservationCount")).toBe("500");
    // The href itself stays well clear of any practical URL/query-string budget
    // regardless of how large the selection is.
    expect(bulkHref.toString().length).toBeLessThan(500);
  });

  it("builds supporting detours with a safe return path to the primary workbench", () => {
    const context = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:base&filter.status=changed&selectedObservationIds=obs_1",
    );
    const returnPath = new URL(catalogPrimaryWorkbenchReturnPath(context), "https://admin.example");
    const supportHref = new URL(
      catalogPrimaryWorkbenchSupportingHref(context, "audit-evidence"),
      "https://admin.example",
    );
    const supportReturnPath = new URL(supportHref.searchParams.get("returnPath") ?? "", "https://admin.example");

    // The return target is always the daily import-to-promotion surface route.
    expect(returnPath.pathname).toBe("/catalog/integrations");
    expect(returnPath.searchParams.has("section")).toBe(false);
    expect(returnPath.searchParams.get("providerKey")).toBe("tcgdex");
    expect(returnPath.searchParams.get("filter.status")).toBe("changed");
    // The detour deep-links to the audience surface route that hosts the workspace.
    // Audit evidence is the default workspace of the health surface, so the
    // canonical href drops the redundant ?section= param.
    expect(supportHref.pathname).toBe("/catalog/integrations/health");
    expect(supportHref.searchParams.has("section")).toBe(false);
    expect(supportHref.searchParams.get("providerKey")).toBe("tcgdex");
    expect(supportHref.searchParams.get("returnPath")).toBeTruthy();
    // The carried return path round-trips back to the daily surface route.
    expect(supportReturnPath.pathname).toBe("/catalog/integrations");
    expect(supportReturnPath.searchParams.has("section")).toBe(false);
    expect(supportReturnPath.searchParams.get("filter.status")).toBe("changed");
  });
});
