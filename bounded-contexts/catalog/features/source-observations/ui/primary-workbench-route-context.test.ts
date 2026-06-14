import { describe, expect, it } from "vitest";
import {
  catalogPrimaryWorkbenchContextKeysFromUrl,
  catalogPrimaryWorkbenchHref,
  catalogPrimaryWorkbenchReturnPath,
  catalogPrimaryWorkbenchSupportingHref,
  parseCatalogPrimaryWorkbenchRouteContext,
  serializeCatalogPrimaryWorkbenchRouteContext,
} from "./primary-workbench-route-context";

describe("Catalog primary workbench route context", () => {
  it("parses canonical context keys without preserving legacy aliases", () => {
    const context = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?section=triage&providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:base&profileVersion=2026.06.04&filter.status=changed&selectedObservationIds=obs_1,obs_2&jobId=job_1&promotionPreviewId=preview_1&returnPath=%2Fcatalog%2Fintegrations&source=legacy",
    );

    expect(context).toMatchObject({
      section: "health-triage",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
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
          jobId: null,
          promotionPreviewId: null,
          returnPath: null,
        },
        "health-triage",
      ),
      "https://admin.example",
    );
    expect(triageHref.pathname).toBe("/catalog/integrations/release");
    expect(triageHref.searchParams.get("section")).toBe("triage");

    // The first workspace of a surface is its default and needs no ?section=.
    const profileHref = new URL(
      catalogPrimaryWorkbenchHref(
        {
          section: "import-to-promotion",
          providerKey: "tcgdex",
          unitKey: null,
          importScope: null,
          profileVersion: null,
          sourceObservationFilters: {},
          selectedObservationIds: [],
          jobId: null,
          promotionPreviewId: null,
          returnPath: null,
        },
        "profile-authoring",
      ),
      "https://admin.example",
    );
    expect(profileHref.pathname).toBe("/catalog/integrations/providers");
    expect(profileHref.searchParams.has("section")).toBe(false);
  });

  it("derives the active workspace from the surface route path when no section param is present", () => {
    expect(
      parseCatalogPrimaryWorkbenchRouteContext("https://admin.example/catalog/integrations/providers").section,
    ).toBe("profile-authoring");
    expect(
      parseCatalogPrimaryWorkbenchRouteContext("https://admin.example/catalog/integrations/governance").section,
    ).toBe("conflict-resolution");
    expect(parseCatalogPrimaryWorkbenchRouteContext("https://admin.example/catalog/integrations/release").section).toBe(
      "clean-reset-release",
    );
    expect(parseCatalogPrimaryWorkbenchRouteContext("https://admin.example/catalog/integrations").section).toBe(
      "import-to-promotion",
    );
    // ?section= still names the precise workspace within a surface (action redirects).
    expect(
      parseCatalogPrimaryWorkbenchRouteContext("https://admin.example/catalog/integrations/providers?section=readiness")
        .section,
    ).toBe("validation-readiness");
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
    expect(supportHref.pathname).toBe("/catalog/integrations/release");
    expect(supportHref.searchParams.get("section")).toBe("evidence");
    expect(supportHref.searchParams.get("providerKey")).toBe("tcgdex");
    expect(supportHref.searchParams.get("returnPath")).toBeTruthy();
    // The carried return path round-trips back to the daily surface route.
    expect(supportReturnPath.pathname).toBe("/catalog/integrations");
    expect(supportReturnPath.searchParams.has("section")).toBe(false);
    expect(supportReturnPath.searchParams.get("filter.status")).toBe("changed");
  });
});
