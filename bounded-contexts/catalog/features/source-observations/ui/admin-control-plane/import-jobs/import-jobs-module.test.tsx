// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../primary-workbench-read-model";
import {
  controlPlaneOverview,
  integrationJobSummary,
  profileReview,
  sourceObservationScope,
} from "../../primary-workbench-test-fixtures";
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

  it("shows observed usage counts, labels unavailable counts honestly, and omits unavailable cache counts", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=scrydex:one-piece:single-card:source-observation-import&importScope=en:one-piece:op-01",
      scopes: { items: [sourceObservationScope({ provider_key: "scrydex" })], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ active: true, lifecycle: "active", providerKey: "scrydex" })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: controlPlaneOverview({
        unitActivity: {
          ...baseOverview.unitActivity,
          units: [
            {
              unitKey: "scrydex:one-piece:single-card:source-observation-import",
              recentJobs: [
                integrationJobSummary({
                  providerKey: "scrydex",
                  result: {
                    requested: 1,
                    imported: 1,
                    observed: 1,
                    reapplied: 0,
                    skipped: 0,
                    failed: 0,
                    outcomeCount: 1,
                    redactedFailureReasons: [],
                    usage: { actualRequestCount: 2, pageCount: 2, cacheHitCount: null, cacheMissCount: null },
                  },
                }),
                integrationJobSummary({
                  jobId: "job_usage_unavailable",
                  providerKey: "scrydex",
                  result: {
                    requested: 1,
                    imported: 0,
                    observed: 0,
                    reapplied: 0,
                    skipped: 0,
                    failed: 1,
                    outcomeCount: 1,
                    redactedFailureReasons: [],
                    usage: {
                      actualRequestCount: null,
                      pageCount: null,
                      cacheHitCount: null,
                      cacheMissCount: null,
                    },
                  },
                }),
              ],
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationImportJobsModule readModel={readModel} />);

    expect(screen.getAllByText("Requests: 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pages: 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Requests: Unavailable").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pages: Unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Cache:/)).toBeNull();
    expect(screen.queryByText(/not selected/)).toBeNull();
  });
});
