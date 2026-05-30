// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogListQuery } from "../../../support/shell-support/list-query-state";
import { IntegrationManagementPage } from "./integration-management-page";
import type { SourceObservationIntegrationScope } from "./contracts";

const {
  mockBulkPromoteSourceObservationsByScope,
  mockEnqueueSourceObservationIntegrationJob,
  mockPreviewBulkPromoteSourceObservations,
  mockPreviewReapplySourceObservations,
  mockRevalidate,
  mockUseSourceObservationIntegrationOptions,
  mockUseActiveSourceObservationIntegrationJobs,
  mockWatchSourceObservationIntegrationJob,
  mockSetSearchParams,
  mockUseNavigation,
  mockUseSearchParams,
} = vi.hoisted(() => ({
  mockBulkPromoteSourceObservationsByScope: vi.fn(),
  mockEnqueueSourceObservationIntegrationJob: vi.fn(),
  mockPreviewBulkPromoteSourceObservations: vi.fn(),
  mockPreviewReapplySourceObservations: vi.fn(),
  mockRevalidate: vi.fn(),
  mockUseSourceObservationIntegrationOptions: vi.fn(),
  mockUseActiveSourceObservationIntegrationJobs: vi.fn(),
  mockWatchSourceObservationIntegrationJob: vi.fn(),
  mockSetSearchParams: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseSearchParams: vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigation: mockUseNavigation,
  useRevalidator: () => ({ revalidate: mockRevalidate }),
  useSearchParams: mockUseSearchParams,
}));

vi.mock("./use-source-observations", () => ({
  bulkPromoteSourceObservationsByScope: mockBulkPromoteSourceObservationsByScope,
  enqueueSourceObservationIntegrationJob: mockEnqueueSourceObservationIntegrationJob,
  previewBulkPromoteSourceObservations: mockPreviewBulkPromoteSourceObservations,
  previewReapplySourceObservations: mockPreviewReapplySourceObservations,
  useActiveSourceObservationIntegrationJobs: mockUseActiveSourceObservationIntegrationJobs,
  useSourceObservationIntegrationOptions: mockUseSourceObservationIntegrationOptions,
  watchSourceObservationIntegrationJob: mockWatchSourceObservationIntegrationJob,
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

describe("IntegrationManagementPage", () => {
  beforeEach(() => {
    mockUseSourceObservationIntegrationOptions.mockImplementation((input: { queryKind: string }) =>
      integrationOptionsResult(input.queryKind),
    );
    mockUseActiveSourceObservationIntegrationJobs.mockReturnValue({
      data: { items: [], total: 0, count: 0 },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockEnqueueSourceObservationIntegrationJob.mockResolvedValue({ jobId: "job_integration" });
    mockWatchSourceObservationIntegrationJob.mockResolvedValue({
      requested: 1,
      imported: 1,
      observed: 102,
      reapplied: 0,
      skipped: 0,
      failed: 0,
      outcomes: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows pulled provider scopes with language expansion series and review counts", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(
      <IntegrationManagementPage
        data={{ items: [integrationScope()], total: 1, count: 1 }}
        query={{ ...query, source: "tcgdex", language: "en", setId: "base1" }}
      />,
    );

    expect(screen.getByText("Catalog Integrations")).toBeTruthy();
    expect(screen.getAllByText("Base Set").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Base").length).toBeGreaterThan(0);
    expect(screen.getAllByText("English").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Review" })[0].getAttribute("href")).toBe(
      "/catalog/source-observations?source=tcgdex&language=en&setId=base1",
    );
  });

  it("enqueues a TCGdex pull for the selected language and optional series", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Pull TCGdex Sets/i })[0]);
    expect(screen.queryByLabelText("TCGdex Expansion ID")).toBeNull();
    const importButton = screen.getByRole("button", { name: /^Import$/i });
    await waitFor(() => expect((importButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(importButton);

    await waitFor(() =>
      expect(mockEnqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
        provider: "tcgdex",
        language: "en",
        seriesId: undefined,
      }),
    );
    expect(mockWatchSourceObservationIntegrationJob).toHaveBeenCalledWith("job_integration", {
      onProgress: expect.any(Function),
    });
    expect(mockSetSearchParams).toHaveBeenCalled();
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it("shows queued progress while an integration job waits for worker processing", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockWatchSourceObservationIntegrationJob.mockImplementation(() => new Promise(() => undefined));

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Pull TCGdex Sets/i })[0]);
    const importButton = screen.getByRole("button", { name: /^Import$/i });
    await waitFor(() => expect((importButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(importButton);

    expect(await screen.findByText("Queued.")).toBeTruthy();
  });

  it("keeps integration job progress from moving backward when stale stream events replay", async () => {
    let pushProgress: (progress: {
      phase: string;
      completed: number;
      total: number;
      currentName: string | null;
      status: string | null;
    }) => void = () => undefined;
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockWatchSourceObservationIntegrationJob.mockImplementation(
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

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Pull TCGdex Sets/i })[0]);
    const importButton = screen.getByRole("button", { name: /^Import$/i });
    await waitFor(() => expect((importButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(importButton);
    await waitFor(() => expect(mockWatchSourceObservationIntegrationJob).toHaveBeenCalled());

    act(() => {
      pushProgress({
        phase: "processing",
        completed: 57,
        total: 100,
        currentName: "Base Set",
        status: "imported",
      });
    });

    expect(await screen.findByText("57 of 100 processed.")).toBeTruthy();

    act(() => {
      pushProgress({
        phase: "processing",
        completed: 9,
        total: 100,
        currentName: "Jungle",
        status: "imported",
      });
    });

    expect(screen.getByText("57 of 100 processed.")).toBeTruthy();
    expect(screen.queryByText("9 of 100 processed.")).toBeNull();

    act(() => {
      pushProgress({
        phase: "processing",
        completed: 64,
        total: 100,
        currentName: "Fossil",
        status: "imported",
      });
    });

    expect(await screen.findByText("64 of 100 processed.")).toBeTruthy();
  });

  it("previews and reapplies promoted observations in the current integration scope", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([
      new URLSearchParams("source=tcgdex&language=en&setId=base1"),
      mockSetSearchParams,
    ]);
    mockPreviewReapplySourceObservations.mockResolvedValue({
      matched: 102,
      eligible: 2,
      ineligible: 100,
      scope: {
        search: "",
        status: "",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
    });
    mockWatchSourceObservationIntegrationJob.mockResolvedValue({
      requested: 2,
      imported: 0,
      observed: 0,
      reapplied: 2,
      skipped: 0,
      failed: 0,
      outcomes: [],
    });

    render(
      <IntegrationManagementPage
        data={{ items: [integrationScope()], total: 1, count: 1 }}
        query={{ ...query, source: "tcgdex", language: "en", setId: "base1" }}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /Reapply promoted/i })[0]);
    await screen.findByText(/2 promoted observations will be reapplied/i);
    fireEvent.click(screen.getByRole("button", { name: /^Reapply mapping$/i }));

    await waitFor(() =>
      expect(mockEnqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("reapply", {
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      }),
    );
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it("previews and promotes all reviewable observations for a row scope", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockPreviewBulkPromoteSourceObservations.mockResolvedValue({
      matched: 100,
      eligible: 100,
      terminal: 0,
      scope: {
        search: "",
        status: "",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
    });
    mockBulkPromoteSourceObservationsByScope.mockResolvedValue({
      requested: 100,
      promoted: 100,
      skipped: 0,
      failed: 0,
      outcomes: [],
    });

    render(<IntegrationManagementPage data={{ items: [integrationScope()], total: 1, count: 1 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Promote all$/i })[0]);
    await screen.findByText(/100 eligible observations will be promoted/i);
    fireEvent.click(screen.getByRole("button", { name: /^Promote all matching$/i }));

    await waitFor(() =>
      expect(mockBulkPromoteSourceObservationsByScope).toHaveBeenCalledWith(
        {
          provider: "tcgdex",
          language: "en",
          setId: "base1",
        },
        { onProgress: expect.any(Function) },
      ),
    );
    expect(mockRevalidate).toHaveBeenCalled();
  });
});

function integrationOptionsResult(queryKind: string) {
  if (queryKind === "languages") {
    return {
      data: {
        items: [
          {
            providerKey: "tcgdex",
            queryKind: "languages",
            value: "en",
            label: "en",
            description: null,
            parentValue: null,
            imageUrl: null,
            metadata: { languageCode: "en" },
          },
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  }

  if (queryKind === "series") {
    return {
      data: {
        items: [
          {
            providerKey: "tcgdex",
            queryKind: "series",
            value: "base",
            label: "Base",
            description: null,
            parentValue: "en",
            imageUrl: null,
            metadata: { seriesId: "base" },
          },
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  }

  return {
    data: {
      items: [
        {
          providerKey: "tcgdex",
          queryKind: "expansions",
          value: "base1",
          label: "Base Set",
          description: "Base - 102 official cards",
          parentValue: "base",
          imageUrl: null,
          metadata: { expansionId: "base1" },
        },
      ],
      total: 1,
      count: 1,
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
}

function integrationScope(): SourceObservationIntegrationScope {
  return {
    provider_key: "tcgdex",
    language_code: "en",
    expansion_id: "base1",
    expansion_name: "Base Set",
    series_id: "base",
    series_name: "Base",
    total_observations: 102,
    observed_observations: 100,
    changed_observations: 0,
    promoted_observations: 2,
    rejected_observations: 0,
    first_observed_at: "2026-05-16T00:00:00.000Z",
    latest_observed_at: "2026-05-16T00:01:00.000Z",
    latest_source_updated_at: null,
  };
}
