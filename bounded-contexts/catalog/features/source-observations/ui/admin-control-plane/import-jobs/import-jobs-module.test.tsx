// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../primary-workbench-read-model";
import { controlPlaneOverview, profileReview, sourceObservationScope } from "../../primary-workbench-test-fixtures";
import { CatalogIntegrationImportJobsModule } from "./import-jobs-module";

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
  };
});

describe("CatalogIntegrationImportJobsModule", () => {
  it("keeps secondary job timestamps out of the mobile card presentation", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationImportJobsModule readModel={readModel} />);

    const createdTimestamps = screen.getAllByText("Created 2026-06-09T00:59:00.000Z");
    const startedTimestamps = screen.getAllByText("Started 2026-06-09T01:00:00.000Z");

    expect(createdTimestamps).toHaveLength(2);
    expect(startedTimestamps).toHaveLength(2);
    for (const timestamp of [...createdTimestamps, ...startedTimestamps]) {
      expect(timestamp.parentElement?.className).toContain("hidden sm:block");
    }
  });
});
