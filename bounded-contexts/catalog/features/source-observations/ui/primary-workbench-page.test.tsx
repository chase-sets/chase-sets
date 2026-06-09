// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalogPrimaryWorkbenchReadModel } from "./primary-workbench-read-model";
import { CatalogPrimaryWorkbenchPage } from "./primary-workbench-page";
import { profileReview, sourceObservationScope } from "./primary-workbench-test-fixtures";

describe("CatalogPrimaryWorkbenchPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts provider import, Source Observation review, and promotion ahead of support workflows", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(
      screen.getByRole("heading", {
        name: "Pull provider data, review Source Observations, promote Catalog facts",
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Pull provider data/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("cell", { name: /Review Source Observations/i })).toBeTruthy();
    expect(screen.getByRole("cell", { name: /Preview Catalog promotion impact/i })).toBeTruthy();
    expect(screen.getByRole("cell", { name: /Promote into Catalog Items/i })).toBeTruthy();

    const navigation = screen.getByRole("navigation", { name: "Catalog control plane workflows" });
    expect(within(navigation).getByText("Primary workflow")).toBeTruthy();
    expect(within(navigation).getByText("Unblock provider data")).toBeTruthy();
    expect(within(navigation).getByText("Govern and recover")).toBeTruthy();
    expect(within(navigation).getByText("Verify release evidence")).toBeTruthy();
    expect(screen.queryByText("Old integrations surface")).toBeNull();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("honors a direct supporting workflow section without changing the default primary route", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=triage",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} initialSection="triage" />);

    expect(screen.getByRole("link", { name: /Health triage/i }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Import to promotion workbench/i }).getAttribute("href")).toContain(
      "/catalog/integrations?",
    );
  });
});
