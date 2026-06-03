// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogListQuery } from "../../../support/shell-support/list-query-state";
import { CatalogRealtimeReloadActionBar } from "../../../support/shell-support/ui/realtime-reload-action-bar";
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
  mockUseActiveSourceObservationBulkJobs,
  mockUseTcgdexExpansions,
  mockUseTcgdexLanguages,
  mockUseTcgdexSeries,
  mockUseNavigation,
  mockUseSearchParams,
  mockWatchSourceObservationBulkJob,
} = vi.hoisted(() => ({
  mockBulkRejectSourceObservationsByScope: vi.fn(),
  mockBulkRejectSourceObservations: vi.fn(),
  mockBulkPromoteSourceObservationsByScope: vi.fn(),
  mockBulkPromoteSourceObservations: vi.fn(),
  mockImportTcgdexSet: vi.fn(),
  mockPreviewBulkPromoteSourceObservations: vi.fn(),
  mockRevalidate: vi.fn(),
  mockUseActiveSourceObservationBulkJobs: vi.fn(),
  mockUseTcgdexExpansions: vi.fn(),
  mockUseTcgdexLanguages: vi.fn(),
  mockUseTcgdexSeries: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseSearchParams: vi.fn(),
  mockWatchSourceObservationBulkJob: vi.fn(),
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
  useActiveSourceObservationBulkJobs: mockUseActiveSourceObservationBulkJobs,
  useTcgdexExpansions: mockUseTcgdexExpansions,
  useTcgdexLanguages: mockUseTcgdexLanguages,
  useTcgdexSeries: mockUseTcgdexSeries,
  watchSourceObservationBulkJob: mockWatchSourceObservationBulkJob,
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
  valueKind: "",
  valueType: "",
  filterable: "",
  searchable: "",
  sortable: "",
  hasFieldRules: "",
  hasDimensionRules: "",
  hasComponents: "",
  parentCategoryId: "",
  hierarchy: "",
  blueprintState: "",
  hasImages: "",
  hasSourceReferences: "",
  missingRequiredFields: "",
  attributeKey: "",
  attributeValue: "",
  relationshipType: "",
  relatedReferenceId: "",
  targetKind: "",
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
    mockUseActiveSourceObservationBulkJobs.mockReturnValue({
      data: { items: [], total: 0, count: 0 },
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

    render(<SourceObservationListPage data={{ items: [observed, promoted], total: 2, count: 2 }} query={query} />);

    fireEvent.click(screen.getByLabelText("Select all rows"));
    expect(screen.getByText("1 selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Promote selected/i }));

    await waitFor(() =>
      expect(mockBulkPromoteSourceObservations).toHaveBeenCalledWith(["obs_observed"], {
        onProgress: expect.any(Function),
      }),
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

    fireEvent.click(within(container).getByRole("button", { name: /Promote all matching/i }));

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
      expect(mockBulkPromoteSourceObservationsByScope).toHaveBeenCalledWith(
        {
          search: "",
          status: "observed",
          provider: "tcgdex",
          language: "en",
          setId: "base1",
        },
        { onProgress: expect.any(Function) },
      ),
    );
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it("prioritizes the realtime reload action bar over matching bulk actions", () => {
    const reload = vi.fn();

    render(
      <SourceObservationListPage
        data={{ items: [observed], total: 125, count: 1 }}
        query={{ ...query, status: "observed", source: "tcgdex", language: "en", setId: "base1" }}
        realtimeReloadActionBar={
          <CatalogRealtimeReloadActionBar
            pendingChangeCount={7}
            syncRequired={false}
            reload={reload}
            entityName="Source Observations"
          />
        }
      />,
    );

    expect(screen.getByText("7 Source Observations changed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByText("125 matching Source Observations")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(reload).toHaveBeenCalledOnce();
  });

  it("shows determinate progress while promoting all matching observations", async () => {
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
    let resolveBulkPromotion: (value: {
      requested: number;
      promoted: number;
      skipped: number;
      failed: number;
      outcomes: never[];
    }) => void = () => undefined;
    mockBulkPromoteSourceObservationsByScope.mockImplementation(
      async (_scope, options?: { onProgress?: (progress: unknown) => void }) => {
        options?.onProgress?.({
          phase: "processing",
          completed: 57,
          total: 123,
          currentName: "Pikachu",
          status: "promoted",
        });

        return new Promise((resolve) => {
          resolveBulkPromotion = resolve;
        });
      },
    );

    const { container } = render(
      <SourceObservationListPage
        data={{ items: [observed], total: 125, count: 1 }}
        query={{ ...query, status: "observed", source: "tcgdex", language: "en", setId: "base1" }}
      />,
    );

    fireEvent.click(within(container).getByRole("button", { name: /Promote all matching/i }));

    await screen.findByText(/123 eligible observations will be promoted/i);
    const promoteAllButtons = screen.getAllByRole("button", {
      name: /^Promote all matching$/i,
    });
    fireEvent.click(promoteAllButtons[promoteAllButtons.length - 1]);

    expect(await screen.findByText("57 of 123 processed.")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("46.34146341463415");

    resolveBulkPromotion?.({
      requested: 123,
      promoted: 123,
      skipped: 0,
      failed: 0,
      outcomes: [],
    });
    await waitFor(() => expect(mockRevalidate).toHaveBeenCalled());
  });

  it("imports a TCGdex expansion selected from preloaded metadata", async () => {
    mockImportTcgdexSet.mockResolvedValue({
      setId: "me02.5",
      expansionId: "me02.5",
      languageCode: "en",
      observed: 217,
      observationIds: [],
    });

    render(<SourceObservationListPage data={{ items: [observed], total: 1, count: 1 }} query={query} />);

    fireEvent.click(screen.getByRole("button", { name: /Import TCGdex expansion/i }));

    expect(screen.queryByLabelText("Other TCGdex Expansion ID")).toBeNull();
    const importButton = screen.getByRole("button", { name: /^Import$/i });
    await waitFor(() => expect((importButton as HTMLButtonElement).disabled).toBe(false));
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

  it("shows TCGplayer product and merge evidence in review rows", () => {
    render(
      <SourceObservationListPage
        data={{ items: [providerProductObservation()], total: 1, count: 1 }}
        query={{ ...query, source: "tcgplayer" }}
      />,
    );

    expect(screen.getAllByText("610001").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pokemon").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 external reference(s)").length).toBeGreaterThan(0);
  });

  it("resumes progress for an active bulk review job after page refresh", async () => {
    const refreshActiveJobs = vi.fn();
    let resolveWatch: (value: {
      requested: number;
      promoted: number;
      skipped: number;
      failed: number;
      outcomes: never[];
    }) => void = () => undefined;
    mockUseActiveSourceObservationBulkJobs.mockReturnValue({
      data: {
        items: [
          {
            jobId: "job_active",
            action: "promote",
            selectionMode: "filter",
            observationIds: [],
            scope: { status: "observed" },
            reason: null,
            status: "running",
            progress: {
              phase: "processing",
              completed: 10,
              total: 100,
              currentName: "Charmander",
              status: "promoted",
            },
            result: null,
            errorMessage: null,
            createdAt: "2026-05-21T00:00:00.000Z",
            startedAt: "2026-05-21T00:00:01.000Z",
            completedAt: null,
            updatedAt: "2026-05-21T00:00:02.000Z",
          },
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: refreshActiveJobs,
    });
    mockWatchSourceObservationBulkJob.mockImplementation(
      async (
        _jobId,
        options?: {
          onProgress?: (progress: unknown) => void;
        },
      ) => {
        options?.onProgress?.({
          phase: "processing",
          completed: 41,
          total: 100,
          currentName: "Charizard",
          status: "promoted",
        });

        return new Promise((resolve) => {
          resolveWatch = resolve;
        });
      },
    );

    render(
      <SourceObservationListPage
        data={{ items: [observed], total: 100, count: 1 }}
        query={{ ...query, status: "observed" }}
      />,
    );

    expect(await screen.findByText("41 of 100 processed.")).toBeTruthy();
    expect(screen.getByText("Promoting Source Observations")).toBeTruthy();
    expect(mockWatchSourceObservationBulkJob).toHaveBeenCalledWith(
      "job_active",
      expect.objectContaining({
        onProgress: expect.any(Function),
        signal: expect.any(Object),
      }),
    );

    resolveWatch?.({
      requested: 100,
      promoted: 100,
      skipped: 0,
      failed: 0,
      outcomes: [],
    });
    await waitFor(() => expect(mockRevalidate).toHaveBeenCalled());
    expect(refreshActiveJobs).toHaveBeenCalled();
  });

  it("keeps resumed bulk review progress from moving backward when stale stream events replay", async () => {
    let pushProgress: (progress: {
      phase: string;
      completed: number;
      total: number;
      currentName: string | null;
      status: string | null;
    }) => void = () => undefined;
    mockUseActiveSourceObservationBulkJobs.mockReturnValue({
      data: {
        items: [
          {
            jobId: "job_active",
            action: "promote",
            selectionMode: "filter",
            observationIds: [],
            scope: { status: "observed" },
            reason: null,
            status: "running",
            progress: {
              phase: "processing",
              completed: 82,
              total: 100,
              currentName: "Raichu",
              status: "promoted",
            },
            result: null,
            errorMessage: null,
            createdAt: "2026-05-21T00:00:00.000Z",
            startedAt: "2026-05-21T00:00:01.000Z",
            completedAt: null,
            updatedAt: "2026-05-21T00:00:02.000Z",
          },
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockWatchSourceObservationBulkJob.mockImplementation(
      async (
        _jobId,
        options?: {
          onProgress?: (progress: {
            phase: string;
            completed: number;
            total: number;
            currentName: string | null;
            status: string | null;
          }) => void;
        },
      ) => {
        pushProgress = options?.onProgress ?? pushProgress;
        return new Promise(() => undefined);
      },
    );

    render(
      <SourceObservationListPage
        data={{ items: [observed], total: 100, count: 1 }}
        query={{ ...query, status: "observed" }}
      />,
    );

    expect(await screen.findByText("82 of 100 processed.")).toBeTruthy();

    act(() => {
      pushProgress({
        phase: "processing",
        completed: 8,
        total: 100,
        currentName: "Pikachu",
        status: "promoted",
      });
    });

    expect(screen.getByText("82 of 100 processed.")).toBeTruthy();
    expect(screen.queryByText("8 of 100 processed.")).toBeNull();

    act(() => {
      pushProgress({
        phase: "processing",
        completed: 91,
        total: 100,
        currentName: "Mewtwo",
        status: "promoted",
      });
    });

    expect(await screen.findByText("91 of 100 processed.")).toBeTruthy();
  });
});

function sourceObservation(input: { observation_id: string; status: string; name: string }): SourceObservationListItem {
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
      cardVariantKey: "standard",
      cardVariantLabel: "Standard Set",
      cardVariantSourceKey: null,
      cardVariantIsPrimaryImage: true,
      imageDisclaimer: null,
      variants: {},
    },
    status: input.status,
    status_reason: null,
    promoted_catalog_item_id: input.status === "promoted" ? "cat_existing" : null,
    promoted_at: input.status === "promoted" ? "2026-05-16T00:01:00.000Z" : null,
    updated_at: "2026-05-16T00:00:00.000Z",
  };
}

function providerProductObservation(): SourceObservationListItem {
  return {
    observation_id: "tcgplayer_en_product_610001",
    provider_key: "tcgplayer",
    external_key: "product:610001",
    source_url: "https://mp-search-api.tcgplayer.com/v2/product/610001/details",
    language_code: "en",
    source_record_hash: "hash_tcgplayer_610001",
    source_updated_at: null,
    observed_at: "2026-05-16T00:00:00.000Z",
    normalized: {
      kind: "provider-product",
      languageCode: "en",
      name: "Eevee ex",
      setName: "Prismatic Evolutions",
      expansionName: "Prismatic Evolutions",
      cardNumber: "131",
      imageUrls: [],
      mergeIdentity: {
        tcg: "pokemon",
        productLineName: "Pokemon",
        setName: "Prismatic Evolutions",
        printedProductName: "Eevee ex",
        collectorNumber: "131",
        languageCode: "en",
      },
      externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
      externalProductReferences: [],
      providerProductId: "610001",
      providerProductName: "Eevee ex",
      productLineName: "Pokemon",
      productCategoryName: "Cards",
      skuReferences: [
        {
          providerKey: "tcgplayer",
          externalKey: "sku:987654",
          reviewEvidence: {
            condition: "Near Mint",
            printing: "Normal",
            language: "English",
            productForm: "single",
          },
        },
        {
          providerKey: "tcgplayer",
          externalKey: "sku:987655",
          reviewEvidence: {
            condition: "Near Mint",
            printing: "Holofoil",
            language: "English",
            productForm: "single",
          },
        },
      ],
    },
    status: "observed",
    status_reason: null,
    promoted_catalog_item_id: null,
    promoted_at: null,
    updated_at: "2026-05-16T00:00:00.000Z",
  };
}
