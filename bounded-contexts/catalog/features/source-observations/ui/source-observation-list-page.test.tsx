// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CatalogListQuery } from "../../../support/shell-support/list-query-state";
import { SourceObservationListPage } from "./source-observation-list-page";
import type { SourceObservationListItem } from "./contracts";

const {
  mockBulkPromoteSourceObservations,
  mockImportTcgdexSet,
  mockRevalidate,
  mockUseNavigation,
  mockUseSearchParams,
} = vi.hoisted(() => ({
  mockBulkPromoteSourceObservations: vi.fn(),
  mockImportTcgdexSet: vi.fn(),
  mockRevalidate: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseSearchParams: vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigation: mockUseNavigation,
  useRevalidator: () => ({ revalidate: mockRevalidate }),
  useSearchParams: mockUseSearchParams,
}));

vi.mock("./use-source-observations", () => ({
  bulkPromoteSourceObservations: mockBulkPromoteSourceObservations,
  importTcgdexSet: mockImportTcgdexSet,
}));

const query: CatalogListQuery = {
  search: "",
  status: "",
  language: "",
  page: 0,
  pageSize: 50,
};

const observed = sourceObservation({
  observation_id: "obs_observed",
  status: "observed",
  name: "Bulbasaur",
});
const promoted = sourceObservation({
  observation_id: "obs_promoted",
  status: "promoted",
  name: "Ivysaur",
});

describe("SourceObservationListPage", () => {
  it("bulk promotes only selected observed rows", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockBulkPromoteSourceObservations.mockResolvedValue({
      requested: 1,
      promoted: 1,
      skipped: 0,
      failed: 0,
      outcomes: [
        {
          observationId: "obs_observed",
          status: "promoted",
          catalogItemId: "cat_1",
          reason: null,
        },
      ],
    });

    render(
      <SourceObservationListPage
        data={{ items: [observed, promoted], total: 2, count: 2 }}
        query={query}
      />,
    );

    fireEvent.click(screen.getByLabelText("Select all rows"));
    expect(screen.getByText("1 selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Promote selected/i }));

    await waitFor(() =>
      expect(mockBulkPromoteSourceObservations).toHaveBeenCalledWith([
        "obs_observed",
      ]),
    );
    expect(mockRevalidate).toHaveBeenCalled();
  });
});

function sourceObservation(input: {
  observation_id: string;
  status: string;
  name: string;
}): SourceObservationListItem {
  return {
    observation_id: input.observation_id,
    provider_key: "tcgdex",
    external_key: input.observation_id,
    source_url: `https://api.tcgdex.net/v2/en/cards/${input.observation_id}`,
    language_code: "en",
    source_record_hash: `hash_${input.observation_id}`,
    source_updated_at: null,
    observed_at: "2026-05-16T00:00:00.000Z",
    normalized: {
      kind: "pokemon-card",
      tcg: "pokemon",
      languageCode: "en",
      name: input.name,
      cardNumber: "1",
      setId: "base1",
      setName: "Base Set",
      seriesId: "base",
      seriesName: "Base",
      rarity: "Common",
      illustrator: null,
      releaseDate: "1999-01-09",
      releaseYear: 1999,
      category: "Pokemon",
      imageBaseUrl: null,
      imageUrls: [],
      productAssetSet: null,
      variants: {},
    },
    status: input.status,
    status_reason: null,
    promoted_catalog_item_id: input.status === "promoted" ? "cat_existing" : null,
    promoted_at: input.status === "promoted" ? "2026-05-16T00:01:00.000Z" : null,
    updated_at: "2026-05-16T00:00:00.000Z",
  };
}
