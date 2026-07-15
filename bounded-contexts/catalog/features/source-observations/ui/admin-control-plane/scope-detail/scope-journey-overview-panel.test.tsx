// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogScopeJourneyOverviewPanel } from "./scope-journey-overview-panel";
import type { CatalogScopeJourneyOverviewReadModel } from "./scope-journey-overview";

afterEach(cleanup);

function overview(overrides: Partial<CatalogScopeJourneyOverviewReadModel> = {}): CatalogScopeJourneyOverviewReadModel {
  return {
    scopeRecordId: "scope_expansion_paldean_fates",
    condition: "ready",
    stages: [
      { key: "coverage", status: "complete" },
      { key: "sync", status: "complete" },
      { key: "jobs", status: "complete" },
      { key: "candidates", status: "complete" },
      { key: "promotion", status: "complete" },
    ],
    editionCount: 2,
    linkedEditionCount: 2,
    pendingCandidateCount: 0,
    promotionReadiness: "live",
    syncFreshness: "fresh",
    ...overrides,
  };
}

describe("CatalogScopeJourneyOverviewPanel", () => {
  it("renders the five journey stages and the ready condition", () => {
    render(<CatalogScopeJourneyOverviewPanel readModel={overview()} />);

    expect(screen.getByRole("heading", { name: "Scope journey" })).toBeTruthy();
    for (const label of ["Coverage", "Sync", "Live jobs", "Candidate review", "Promotion"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("Ready to promote")).toBeTruthy();
  });

  it("surfaces the projection-lag state", () => {
    render(
      <CatalogScopeJourneyOverviewPanel
        readModel={overview({
          condition: "projection-lag",
          syncFreshness: "stale",
          stages: [
            { key: "coverage", status: "complete" },
            { key: "sync", status: "current" },
            { key: "jobs", status: "upcoming" },
            { key: "candidates", status: "complete" },
            { key: "promotion", status: "complete" },
          ],
        })}
      />,
    );

    expect(screen.getByText("Sync lagging")).toBeTruthy();
    expect(screen.getByText("Sync is lagging")).toBeTruthy();
    expect(screen.getByText("Projection is lagging — re-sync")).toBeTruthy();
  });

  it("renders only the loading state while loading", () => {
    render(<CatalogScopeJourneyOverviewPanel readModel={overview()} loading />);

    expect(screen.getByText("Loading the scope journey…")).toBeTruthy();
    // The stage stepper and condition banner are hidden behind the loading state
    // (the module's status chip still reflects the resolved condition).
    expect(screen.queryByText("Coverage")).toBeNull();
    expect(screen.queryByText("This scope is ready to promote")).toBeNull();
  });
});
