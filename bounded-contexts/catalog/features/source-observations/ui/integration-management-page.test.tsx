// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogListQuery } from "../../../support/shell-support/list-query-state";
import { IntegrationManagementPage } from "./integration-management-page";
import type { CatalogProviderProfileVersionReview, SourceObservationIntegrationScope } from "./contracts";

const {
  mockActivateSourceObservationProviderProfile,
  mockBulkPromoteSourceObservationsByScope,
  mockDeprecateSourceObservationProviderProfile,
  mockDryRunSourceObservationProviderProfile,
  mockEnqueueSourceObservationIntegrationJob,
  mockPreviewBulkPromoteSourceObservations,
  mockPreviewReapplySourceObservations,
  mockRevalidate,
  mockUseSourceObservationProviderProfiles,
  mockUseSourceObservationIntegrationOptions,
  mockUseActiveSourceObservationIntegrationJobs,
  mockWatchSourceObservationIntegrationJob,
  mockSetSearchParams,
  mockUseNavigation,
  mockUseSearchParams,
} = vi.hoisted(() => ({
  mockActivateSourceObservationProviderProfile: vi.fn(),
  mockBulkPromoteSourceObservationsByScope: vi.fn(),
  mockDeprecateSourceObservationProviderProfile: vi.fn(),
  mockDryRunSourceObservationProviderProfile: vi.fn(),
  mockEnqueueSourceObservationIntegrationJob: vi.fn(),
  mockPreviewBulkPromoteSourceObservations: vi.fn(),
  mockPreviewReapplySourceObservations: vi.fn(),
  mockRevalidate: vi.fn(),
  mockUseSourceObservationProviderProfiles: vi.fn(),
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
  activateSourceObservationProviderProfile: mockActivateSourceObservationProviderProfile,
  bulkPromoteSourceObservationsByScope: mockBulkPromoteSourceObservationsByScope,
  deprecateSourceObservationProviderProfile: mockDeprecateSourceObservationProviderProfile,
  dryRunSourceObservationProviderProfile: mockDryRunSourceObservationProviderProfile,
  enqueueSourceObservationIntegrationJob: mockEnqueueSourceObservationIntegrationJob,
  previewBulkPromoteSourceObservations: mockPreviewBulkPromoteSourceObservations,
  previewReapplySourceObservations: mockPreviewReapplySourceObservations,
  useActiveSourceObservationIntegrationJobs: mockUseActiveSourceObservationIntegrationJobs,
  useSourceObservationProviderProfiles: mockUseSourceObservationProviderProfiles,
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
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: { items: [profileReview()], total: 1, count: 1 },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockDryRunSourceObservationProviderProfile.mockResolvedValue({
      providerKey: "scrydex",
      profileKey: "scryfall-card-fixture",
      profileVersion: "2026.06.03",
      status: "completed",
      redactedPayload: { prices: "[redacted]", auth: "[redacted]" },
      observation: {
        observationId: "scrydex_en_0000579f-7b35-4ed3-b44c-db2a538066fe",
        providerKey: "scrydex",
        externalKey: "scryfall:0000579f-7b35-4ed3-b44c-db2a538066fe",
        sourceUrl: "https://scryfall.com/card/tsp/157/fury-sliver",
        languageCode: "en",
        sourceRecordHash: "hash_1",
        sourceUpdatedAt: "2006-10-06",
        observedAt: "2026-06-03T00:00:00.000Z",
        sourcePayload: { prices: "[redacted]" },
        normalized: {
          kind: "provider-product",
          languageCode: "en",
          name: "Fury Sliver",
          setName: "Time Spiral",
          expansionName: "Time Spiral",
          cardNumber: "157",
          imageUrls: [],
          providerProductId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
          providerProductName: "Fury Sliver",
          productLineName: "Magic: The Gathering",
          productCategoryName: "Cards",
          skuReferences: [],
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
        },
      },
      diagnostics: [],
      hashMaterial: [],
      externalReferences: {
        catalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
        productReferences: [],
      },
      selectedOptions: [],
      mergeCandidateEvidence: [],
      duplicatePreventionRules: [],
      promotionCommandPlan: { requiresReview: true, commands: [] },
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
    cleanup();
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
    expect(screen.getByText("Provider Profile Review")).toBeTruthy();
    expect(screen.getAllByText("Scrydex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Base Set").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Base").length).toBeGreaterThan(0);
    expect(screen.getAllByText("English").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Review" })[0].getAttribute("href")).toBe(
      "/catalog/source-observations?source=tcgdex&language=en&setId=base1",
    );
  });

  it("runs a provider profile fixture dry-run and displays redacted output", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Dry run$/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Dry run$/i }));

    await waitFor(() =>
      expect(mockDryRunSourceObservationProviderProfile).toHaveBeenCalledWith(
        "scrydex",
        "2026.06.03",
        expect.objectContaining({ tcgplayer_id: 14240 }),
      ),
    );
    expect(await within(dialog).findByDisplayValue(/product:14240/)).toBeTruthy();
    expect(within(dialog).getByDisplayValue(/\[redacted\]/)).toBeTruthy();
  });

  it("enqueues a TCGdex pull for the selected language and optional series", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Pull Provider Data/i })[0]);
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

    fireEvent.click(screen.getAllByRole("button", { name: /Pull Provider Data/i })[0]);
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

    fireEvent.click(screen.getAllByRole("button", { name: /Pull Provider Data/i })[0]);
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

  it("enqueues a TCGplayer product-line import scope from explicit automation identifiers", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Pull Provider Data/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("tab", { name: "TCGplayer" }));
    fireEvent.change(await within(dialog).findByLabelText("TCGplayer Product Line ID"), {
      target: { value: "3" },
    });
    fireEvent.change(within(dialog).getByLabelText("Set Name"), {
      target: { value: "Prismatic Evolutions" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Import$/i }));

    await waitFor(() =>
      expect(mockEnqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
        provider: "tcgplayer",
        language: "en",
        productLineId: "3",
        setName: "Prismatic Evolutions",
      }),
    );
    expect(mockSetSearchParams).toHaveBeenCalled();
    expect(mockRevalidate).toHaveBeenCalled();
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

  it("resyncs a TCGplayer row with product-line and set-name scope", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(
      <IntegrationManagementPage
        data={{ items: [tcgplayerIntegrationScope()], total: 1, count: 1 }}
        query={{ ...query, source: "tcgplayer", language: "en", setId: "Prismatic Evolutions" }}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /^Resync set$/i })[0]);

    await waitFor(() =>
      expect(mockEnqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
        provider: "tcgplayer",
        language: "en",
        productLineId: "3",
        setName: "Prismatic Evolutions",
      }),
    );
  });
});

function integrationOptionsResult(queryKind: string) {
  if (queryKind === "providers") {
    return {
      data: {
        items: [
          {
            providerKey: "tcgdex",
            queryKind: "providers",
            value: "tcgdex",
            label: "TCGdex",
            description: "source-observation-import",
            parentValue: null,
            imageUrl: null,
            metadata: { status: "active" },
          },
          {
            providerKey: "tcgplayer",
            queryKind: "providers",
            value: "tcgplayer",
            label: "TCGplayer",
            description: "source-observation-import",
            parentValue: null,
            imageUrl: null,
            metadata: { status: "planned" },
          },
        ],
        total: 2,
        count: 2,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  }

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

function profileReview(): CatalogProviderProfileVersionReview {
  return {
    providerKey: "scrydex",
    profileKey: "scryfall-card-fixture",
    profileVersion: "2026.06.03",
    displayName: "Scrydex",
    lifecycle: "test",
    active: false,
    status: "planned",
    compatibilityMode: "executable-mapping-contract",
    connectorKind: "scrydex-scryfall-json",
    sourceContract: {
      owner: "chase-sets/catalog",
      repository: "chase-sets/chase-sets",
      commit: null,
      documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
      fixtureSetVersion: "scrydex-scryfall-card-proof-v1",
    },
    fixtures: {
      fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/scrydex",
      coveredFlows: [
        "normal",
        "partial",
        "stale",
        "changed",
        "ambiguous",
        "replay",
        "sealed-product",
        "unknown-option",
      ],
      liveProviderCallsAllowed: false,
    },
    capabilities: ["source-observation-import", "external-reference-extraction"],
    supportedScopes: ["product/card"],
    languageOptions: ["en"],
    mappingOutputKind: "provider-product",
    hasExecutableMappingContract: true,
    validation: {
      status: "valid",
      diagnostics: [],
    },
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
    product_line_id: "",
    product_line_name: "",
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

function tcgplayerIntegrationScope(): SourceObservationIntegrationScope {
  return {
    provider_key: "tcgplayer",
    language_code: "en",
    expansion_id: "Prismatic Evolutions",
    expansion_name: "Prismatic Evolutions",
    series_id: "",
    series_name: "",
    product_line_id: "3",
    product_line_name: "Pokemon",
    total_observations: 2,
    observed_observations: 2,
    changed_observations: 0,
    promoted_observations: 0,
    rejected_observations: 0,
    first_observed_at: "2026-05-16T00:00:00.000Z",
    latest_observed_at: "2026-05-16T00:01:00.000Z",
    latest_source_updated_at: null,
  };
}
