// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogListQuery } from "../../../support/shell-support/list-query-state";
import { SourceObservationListPage } from "./source-observation-list-page";
import type { SourceObservationListItem } from "./contracts";

const {
  mockBulkRejectSourceObservationsByScope,
  mockBulkRejectSourceObservations,
  mockBulkPromoteSourceObservationsByScope,
  mockBulkPromoteSourceObservations,
  mockImportTcgdexSet,
  mockPreviewBulkPromoteSourceObservations,
  mockRevalidate,
  mockUseTcgdexExpansions,
  mockUseTcgdexLanguages,
  mockUseTcgdexSeries,
  mockUseNavigation,
  mockUseSearchParams,
} = vi.hoisted(() => ({
  mockBulkRejectSourceObservationsByScope: vi.fn(),
  mockBulkRejectSourceObservations: vi.fn(),
  mockBulkPromoteSourceObservationsByScope: vi.fn(),
  mockBulkPromoteSourceObservations: vi.fn(),
  mockImportTcgdexSet: vi.fn(),
  mockPreviewBulkPromoteSourceObservations: vi.fn(),
  mockRevalidate: vi.fn(),
  mockUseTcgdexExpansions: vi.fn(),
  mockUseTcgdexLanguages: vi.fn(),
  mockUseTcgdexSeries: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseSearchParams: vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigation: mockUseNavigation,
  useRevalidator: () => ({ revalidate: mockRevalidate }),
  useSearchParams: mockUseSearchParams,
}));

vi.mock("./use-source-observations", () => ({
  bulkRejectSourceObservationsByScope: mockBulkRejectSourceObservationsByScope,
  bulkRejectSourceObservations: mockBulkRejectSourceObservations,
  bulkPromoteSourceObservationsByScope: mockBulkPromoteSourceObservationsByScope,
  bulkPromoteSourceObservations: mockBulkPromoteSourceObservations,
  importTcgdexSet: mockImportTcgdexSet,
  previewBulkPromoteSourceObservations: mockPreviewBulkPromoteSourceObservations,
  useTcgdexExpansions: mockUseTcgdexExpansions,
  useTcgdexLanguages: mockUseTcgdexLanguages,
  useTcgdexSeries: mockUseTcgdexSeries,
}));

const query: CatalogListQuery = {
  search: "",
  status: "",
  language: "",
  source: "",
  blueprintId: "",
  tag: "",
  setId: "",
  typeKey: "",
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
  beforeEach(() => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockUseTcgdexLanguages.mockReturnValue({
      data: {
        items: [{ languageCode: "en" }],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseTcgdexSeries.mockReturnValue({
      data: {
        items: [{ seriesId: "me", name: "Mega Evolution", logoUrl: null }],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseTcgdexExpansions.mockReturnValue({
      data: {
        items: [
          {
            expansionId: "me02.5",
            name: "Ascended Heroes",
            seriesId: "me",
            seriesName: "Mega Evolution",
            logoUrl: null,
            symbolUrl: null,
            cardCount: 295,
            officialCardCount: 217,
          },
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("bulk promotes only selected observed rows", async () => {
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

  it("previews and promotes all matching observations across the current filters", async () => {
    mockPreviewBulkPromoteSourceObservations.mockResolvedValue({
      matched: 125,
      eligible: 123,
      terminal: 2,
      scope: {
        search: "",
        status: "observed",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
    });
    mockBulkPromoteSourceObservationsByScope.mockResolvedValue({
      requested: 123,
      promoted: 123,
      skipped: 0,
      failed: 0,
      outcomes: [],
    });

    const { container } = render(
      <SourceObservationListPage
        data={{ items: [observed], total: 125, count: 1 }}
        query={{ ...query, status: "observed", source: "tcgdex", language: "en", setId: "base1" }}
      />,
    );

    fireEvent.click(
      within(container).getByRole("button", { name: /Promote all matching/i }),
    );

    await waitFor(() =>
      expect(mockPreviewBulkPromoteSourceObservations).toHaveBeenCalledWith({
        search: "",
        status: "observed",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      }),
    );
    expect(screen.getByText(/123 eligible observations will be promoted/i)).toBeTruthy();

    const promoteAllButtons = screen.getAllByRole("button", {
      name: /^Promote all matching$/i,
    });
    fireEvent.click(promoteAllButtons[promoteAllButtons.length - 1]);

    await waitFor(() =>
      expect(mockBulkPromoteSourceObservationsByScope).toHaveBeenCalledWith({
        search: "",
        status: "observed",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      }),
    );
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it("imports a TCGdex expansion selected from preloaded metadata", async () => {
    mockImportTcgdexSet.mockResolvedValue({
      setId: "me02.5",
      expansionId: "me02.5",
      languageCode: "en",
      observed: 217,
      observationIds: [],
    });

    render(
      <SourceObservationListPage
        data={{ items: [observed], total: 1, count: 1 }}
        query={query}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Import TCGdex expansion/i }));

    expect(screen.queryByLabelText("Other TCGdex Expansion ID")).toBeNull();
    const importButton = screen.getByRole("button", { name: /^Import$/i });
    await waitFor(() =>
      expect((importButton as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(importButton);

    await waitFor(() =>
      expect(mockImportTcgdexSet).toHaveBeenCalledWith(
        {
          languageCode: "en",
          setId: "me02.5",
        },
        { onProgress: expect.any(Function) },
      ),
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
      expansionId: "base1",
      expansionName: "Base Set",
      expansionAbbreviation: "BS",
      expansionCardCount: 102,
      expansionParallelSetCardCount: 0,
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
      parallelSet: false,
      variants: {},
    },
    status: input.status,
    status_reason: null,
    promoted_catalog_item_id: input.status === "promoted" ? "cat_existing" : null,
    promoted_at: input.status === "promoted" ? "2026-05-16T00:01:00.000Z" : null,
    updated_at: "2026-05-16T00:00:00.000Z",
  };
}
