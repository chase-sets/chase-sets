import { describe, expect, it } from "vitest";
import { parseCatalogPrimaryWorkbenchRouteContext } from "./primary-workbench-route-context";
import {
  catalogPrimaryWorkbenchSourceOptionForcesRefresh,
  catalogPrimaryWorkbenchSourceOptionHref,
  parseCatalogPrimaryWorkbenchSourceOptionIntent,
} from "./primary-workbench-source-option-refresh";

const routeContext = parseCatalogPrimaryWorkbenchRouteContext(
  "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&languageCode=en&seriesId=base&expansionId=base1&profileVersion=2026.06.04",
);

describe("Catalog primary workbench source-option refresh hrefs", () => {
  it("builds reload hrefs that stay on the workbench and preserve route context", () => {
    const target = new URL(
      catalogPrimaryWorkbenchSourceOptionHref(routeContext, { action: "reload", queryKind: "expansions" }),
      "https://admin.example",
    );

    // Operator stays in the Catalog Integrations workbench, never the raw API route.
    expect(target.pathname).toBe("/catalog/integrations");
    expect(target.pathname.startsWith("/api/catalog")).toBe(false);
    expect(target.searchParams.get("sourceOptionAction")).toBe("reload");
    expect(target.searchParams.get("sourceOptionQueryKind")).toBe("expansions");
    // Structured scope is carried via the canonical importScope serialization.
    expect(target.searchParams.get("providerKey")).toBe("tcgdex");
    expect(target.searchParams.get("unitKey")).toBe("tcgdex:pokemon:card:import");
    expect(target.searchParams.get("profileVersion")).toBe("2026.06.04");
    expect(target.searchParams.get("importScope")).toBe("en:base:base1");
    // No raw API force-refresh flag leaks into the operator-facing href.
    expect(target.searchParams.has("forceRefresh")).toBe(false);
    expect(target.searchParams.has("cacheOnly")).toBe(false);
  });

  it("builds per-group force-refresh hrefs with the targeted query kind", () => {
    const target = new URL(
      catalogPrimaryWorkbenchSourceOptionHref(routeContext, { action: "force-refresh", queryKind: "series" }),
      "https://admin.example",
    );

    expect(target.pathname).toBe("/catalog/integrations");
    expect(target.searchParams.get("sourceOptionAction")).toBe("force-refresh");
    expect(target.searchParams.get("sourceOptionQueryKind")).toBe("series");
  });

  it("builds refresh-all hrefs without a single query kind", () => {
    const target = new URL(
      catalogPrimaryWorkbenchSourceOptionHref(routeContext, { action: "force-refresh-all", queryKind: null }),
      "https://admin.example",
    );

    expect(target.pathname).toBe("/catalog/integrations");
    expect(target.searchParams.get("sourceOptionAction")).toBe("force-refresh-all");
    expect(target.searchParams.has("sourceOptionQueryKind")).toBe(false);
  });

  it("parses workbench source-option intents and ignores unknown actions", () => {
    expect(
      parseCatalogPrimaryWorkbenchSourceOptionIntent(
        "https://admin.example/catalog/integrations?sourceOptionAction=force-refresh&sourceOptionQueryKind=expansions",
      ),
    ).toEqual({ action: "force-refresh", queryKind: "expansions" });
    expect(
      parseCatalogPrimaryWorkbenchSourceOptionIntent("https://admin.example/catalog/integrations?providerKey=tcgdex"),
    ).toBeNull();
    expect(
      parseCatalogPrimaryWorkbenchSourceOptionIntent(
        "https://admin.example/catalog/integrations?sourceOptionAction=legacy-json",
      ),
    ).toBeNull();
  });

  it("decides force-refresh per group from the parsed intent", () => {
    const all = { action: "force-refresh-all", queryKind: null } as const;
    const group = { action: "force-refresh", queryKind: "expansions" } as const;
    const reload = { action: "reload", queryKind: "expansions" } as const;

    expect(catalogPrimaryWorkbenchSourceOptionForcesRefresh(all, "languages")).toBe(true);
    expect(catalogPrimaryWorkbenchSourceOptionForcesRefresh(group, "expansions")).toBe(true);
    expect(catalogPrimaryWorkbenchSourceOptionForcesRefresh(group, "languages")).toBe(false);
    expect(catalogPrimaryWorkbenchSourceOptionForcesRefresh(reload, "expansions")).toBe(false);
    expect(catalogPrimaryWorkbenchSourceOptionForcesRefresh(null, "expansions")).toBe(false);
  });
});
