import { describe, expect, it } from "vitest";
import {
  catalogPrimaryWorkbenchContextKeysFromUrl,
  catalogPrimaryWorkbenchHref,
  parseCatalogPrimaryWorkbenchRouteContext,
  serializeCatalogPrimaryWorkbenchRouteContext,
} from "./primary-workbench-route-context";

describe("Catalog primary workbench route context", () => {
  it("parses canonical context keys without preserving legacy aliases", () => {
    const context = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:base&profileVersion=2026.06.04&filter.status=changed&selectedObservationIds=obs_1,obs_2&jobId=job_1&promotionPreviewId=preview_1&returnPath=%2Fcatalog%2Fintegrations&source=legacy",
    );

    expect(context).toMatchObject({
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
      catalogPrimaryWorkbenchContextKeysFromUrl(new URL("https://admin.example/catalog/integrations?source=tcgdex")),
    ).toEqual([]);
  });

  it("serializes context into a clean primary workbench href", () => {
    const searchParams = serializeCatalogPrimaryWorkbenchRouteContext({
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
    expect(searchParams.toString()).toContain("filter.status=changed");
    expect(searchParams.toString()).not.toContain("source=");
    expect(
      catalogPrimaryWorkbenchHref(
        {
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
        "workbench",
      ),
    ).toBe(
      "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Acard%3Aimport&importScope=en%3Abase&profileVersion=2026.06.04&section=workbench",
    );
  });
});
