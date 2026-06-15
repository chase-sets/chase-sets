// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "./primary-workbench-read-model";
import { CatalogIntegrationsSurfacePage } from "./integrations-surface-page";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import { profileReview, sourceObservationScope } from "./primary-workbench-test-fixtures";

function surfaceReadModel(surface: CatalogControlPlaneRouteSurfaceKey) {
  return buildCatalogPrimaryWorkbenchReadModelForSurface(surface, {
    requestUrl:
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
    controlPlaneOverview: null,
    canManageCatalog: true,
  });
}

describe("CatalogWorkbenchShell single per-surface return affordance", () => {
  afterEach(() => {
    cleanup();
  });

  // The supporting surfaces stack multiple workspaces; the back-link is rendered
  // once by the surface header rather than repeated per stacked workspace (#1739
  // left three on the release surface, forcing e2e .first()).
  it.each(["providers", "governance", "release"] as const)(
    "renders exactly one back-link on the %s surface even though it stacks multiple workspaces",
    (surface) => {
      render(<CatalogIntegrationsSurfacePage surface={surface} readModel={surfaceReadModel(surface)} />);

      const backLinks = screen.getAllByRole("link", { name: "Back to import workbench" });
      expect(backLinks).toHaveLength(1);
      const target = new URL(backLinks[0]!.getAttribute("href") ?? "", "https://admin.example");
      expect(target.pathname).toBe("/catalog/integrations");
      expect(target.searchParams.has("section")).toBe(false);
      expect(target.searchParams.get("providerKey")).toBe("tcgdex");
    },
  );

  it("renders no back-link on the daily surface, which is the primary job", () => {
    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={surfaceReadModel("daily")} />);

    expect(screen.queryByRole("link", { name: "Back to import workbench" })).toBeNull();
  });
});

describe("CatalogWorkbenchShell no page-local cross-surface navigation", () => {
  afterEach(() => {
    cleanup();
  });

  // Cross-surface navigation now lives in the admin shell side nav (the nested
  // "Integrations" manifest group), so the integrations surface must not render its
  // own "Catalog control plane workflows" navigation or the mobile workflow combobox.
  it.each(["daily", "providers", "governance", "release"] as const)(
    "does not render the page-local workflow nav on the %s surface",
    (surface) => {
      render(<CatalogIntegrationsSurfacePage surface={surface} readModel={surfaceReadModel(surface)} />);

      expect(screen.queryByRole("navigation", { name: "Catalog control plane workflows" })).toBeNull();
      expect(screen.queryByRole("combobox", { name: "Choose Catalog workflow" })).toBeNull();
    },
  );
});
