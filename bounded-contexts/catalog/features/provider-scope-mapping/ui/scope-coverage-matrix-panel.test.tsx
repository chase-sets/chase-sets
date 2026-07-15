// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogScopeCoverageMatrixPanel } from "./scope-coverage-matrix-panel";
import type { ScopeCoverageMatrix } from "./contracts";

afterEach(cleanup);

function matrix(): ScopeCoverageMatrix {
  return {
    schemaVersion: "catalog-scope-coverage-v1",
    generatedAt: "2026-07-15T00:00:00.000Z",
    scopeRecordId: "scope_expansion_paldean_fates",
    scopeName: "Paldean Fates",
    productDomain: "pokemon",
    scopeKind: "expansion",
    officialSetCode: "PAF",
    releaseDate: "2024-01-26",
    lifecycleStatus: "active",
    providers: [
      {
        providerKey: "tcgdex",
        state: "mapped",
        mapping: null,
        syncedObservations: 0,
        promotedObservations: 0,
      },
      {
        providerKey: "tcgplayer",
        state: "settled",
        mapping: null,
        syncedObservations: 130,
        promotedObservations: 128,
      },
      {
        providerKey: "scrydex",
        state: "available",
        mapping: {
          mappingId: "mapping_scrydex_paf",
          scopeRecordId: "scope_expansion_paldean_fates",
          providerKey: "scrydex",
          unitKey: "cards",
          coordinates: {
            productLineId: null,
            seriesId: null,
            setId: "paf",
            setName: "Paldean Fates",
            language: {
              languageCode: "en",
              providerLanguageCode: null,
              providerLanguageId: null,
              providerLocale: null,
              providerLanguageName: null,
            },
          },
          confidence: "exact",
          reviewStatus: "proposed",
          provenance: {
            source: "scheduled-option-refresh",
            sourceId: null,
            sourceProfileKey: null,
            sourceProfileVersion: null,
            mappingFingerprint: null,
          },
          evidence: {},
          highConfidence: true,
          reviewable: true,
          lastActor: null,
          lastReason: null,
          proposedAt: "2026-07-15T00:00:00.000Z",
          reviewedAt: null,
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
        syncedObservations: 0,
        promotedObservations: 0,
      },
    ],
  };
}

describe("CatalogScopeCoverageMatrixPanel", () => {
  it("renders provider coverage in the design-system responsive table", () => {
    render(<CatalogScopeCoverageMatrixPanel scopeRecordId="scope_expansion_paldean_fates" matrix={matrix()} />);

    expect(screen.getByRole("heading", { name: "Coverage matrix" })).toBeTruthy();
    expect(screen.getAllByText("tcgdex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tcgplayer").length).toBeGreaterThan(0);
    expect(screen.getByText("Mapped 1")).toBeTruthy();
    expect(screen.getByText("Settled 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept all available (1)" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Accept$/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Propose mapping" })).toBeTruthy();
  });

  it("shows loading, empty, and partial-failure states", () => {
    const { rerender } = render(
      <CatalogScopeCoverageMatrixPanel scopeRecordId="scope_expansion_paldean_fates" matrix={null} loading />,
    );
    expect(screen.getByText("Loading coverage")).toBeTruthy();
    expect(screen.getAllByText("No provider coverage yet").length).toBeGreaterThan(0);

    rerender(<CatalogScopeCoverageMatrixPanel scopeRecordId="scope_expansion_paldean_fates" matrix={null} failed />);
    expect(screen.getByText("Coverage unavailable")).toBeTruthy();
  });
});
