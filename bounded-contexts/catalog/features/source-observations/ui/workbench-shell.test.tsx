// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCatalogPrimaryWorkbenchReadModel,
  buildCatalogPrimaryWorkbenchReadModelForSurface,
} from "./primary-workbench-read-model";
import { CatalogIntegrationsSurfacePage } from "./integrations-surface-page";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import { profileReview, sourceObservationScope } from "./primary-workbench-test-fixtures";

function dailyReadModel() {
  const requestUrl =
    "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed";

  return buildCatalogPrimaryWorkbenchReadModel({
    requestUrl,
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
    controlPlaneOverview: null,
    canManageCatalog: true,
  });
}

describe("CatalogWorkbenchShell mobile workflow combobox", () => {
  const assignSpy = vi.fn();

  beforeEach(() => {
    assignSpy.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("navigates to the selected workspace's surface route from the mobile combobox", () => {
    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModel()} />);

    const combobox = screen.getByRole("combobox", { name: "Choose Catalog workflow" });
    fireEvent.change(combobox, { target: { value: "health-triage" } });

    expect(assignSpy).toHaveBeenCalledTimes(1);
    const target = new URL(assignSpy.mock.calls[0]![0] as string, "https://admin.example");
    // Health triage lives on the release surface route and carries its section + the
    // preserved provider context plus a return path back to the daily workbench.
    expect(target.pathname).toBe("/catalog/integrations/release");
    expect(target.searchParams.get("section")).toBe("triage");
    expect(target.searchParams.get("providerKey")).toBe("tcgdex");
    expect(target.searchParams.has("returnPath")).toBe(true);
  });

  it("navigates back to the daily base route when the primary workspace is chosen", () => {
    render(<CatalogIntegrationsSurfacePage surface="release" readModel={dailyReadModel()} />);

    const combobox = screen.getByRole("combobox", { name: "Choose Catalog workflow" });
    fireEvent.change(combobox, { target: { value: "import-to-promotion" } });

    expect(assignSpy).toHaveBeenCalledTimes(1);
    const target = new URL(assignSpy.mock.calls[0]![0] as string, "https://admin.example");
    expect(target.pathname).toBe("/catalog/integrations");
    expect(target.searchParams.has("section")).toBe(false);
    expect(target.searchParams.get("providerKey")).toBe("tcgdex");
  });
});

describe("CatalogWorkbenchShell single per-surface return affordance", () => {
  afterEach(() => {
    cleanup();
  });

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
