// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogListQuery } from "../../../support/shell-support/list-query-state";
import { IntegrationManagementPage } from "./integration-management-page";
import type {
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
} from "./contracts";

const {
  mockActivateSourceObservationProviderProfile,
  mockBulkPromoteSourceObservationsByScope,
  mockCloneSourceObservationProviderProfile,
  mockDeprecateSourceObservationProviderProfile,
  mockDryRunSourceObservationProviderProfile,
  mockEnqueueSourceObservationIntegrationJob,
  mockPreviewBulkPromoteSourceObservations,
  mockPreviewReapplySourceObservations,
  mockRetireSourceObservationProviderProfile,
  mockRollbackSourceObservationProviderProfile,
  mockUpdateSourceObservationProviderProfile,
  mockRevalidate,
  mockUseSourceObservationProviderProfileAuthoringModel,
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
  mockCloneSourceObservationProviderProfile: vi.fn(),
  mockDeprecateSourceObservationProviderProfile: vi.fn(),
  mockDryRunSourceObservationProviderProfile: vi.fn(),
  mockEnqueueSourceObservationIntegrationJob: vi.fn(),
  mockPreviewBulkPromoteSourceObservations: vi.fn(),
  mockPreviewReapplySourceObservations: vi.fn(),
  mockRetireSourceObservationProviderProfile: vi.fn(),
  mockRollbackSourceObservationProviderProfile: vi.fn(),
  mockUpdateSourceObservationProviderProfile: vi.fn(),
  mockRevalidate: vi.fn(),
  mockUseSourceObservationProviderProfileAuthoringModel: vi.fn(),
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
  cloneSourceObservationProviderProfile: mockCloneSourceObservationProviderProfile,
  deprecateSourceObservationProviderProfile: mockDeprecateSourceObservationProviderProfile,
  dryRunSourceObservationProviderProfile: mockDryRunSourceObservationProviderProfile,
  enqueueSourceObservationIntegrationJob: mockEnqueueSourceObservationIntegrationJob,
  previewBulkPromoteSourceObservations: mockPreviewBulkPromoteSourceObservations,
  previewReapplySourceObservations: mockPreviewReapplySourceObservations,
  retireSourceObservationProviderProfile: mockRetireSourceObservationProviderProfile,
  rollbackSourceObservationProviderProfile: mockRollbackSourceObservationProviderProfile,
  updateSourceObservationProviderProfile: mockUpdateSourceObservationProviderProfile,
  useActiveSourceObservationIntegrationJobs: mockUseActiveSourceObservationIntegrationJobs,
  useSourceObservationProviderProfileAuthoringModel: mockUseSourceObservationProviderProfileAuthoringModel,
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
    mockUseSourceObservationProviderProfileAuthoringModel.mockReturnValue({
      data: profileAuthoringModel(),
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockCloneSourceObservationProviderProfile.mockResolvedValue(profileReview({ profileVersion: "2026.06.03.1" }));
    mockUpdateSourceObservationProviderProfile.mockResolvedValue(profileReview());
    mockRollbackSourceObservationProviderProfile.mockResolvedValue(profileReview());
    mockRetireSourceObservationProviderProfile.mockResolvedValue(profileReview({ lifecycle: "retired" }));
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

  it("searches and selects an integration expansion filter", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("source=tcgdex&language=en"), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [integrationScope()], total: 1, count: 1 }} query={query} />);

    fireEvent.click(screen.getByRole("button", { name: "Expansion" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Expansion" }), {
      target: { value: "fos" },
    });

    expect(await screen.findByRole("option", { name: "Fossil" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Base Set" })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: "Fossil" }));

    await waitFor(() => expect(mockSetSearchParams).toHaveBeenCalled());
    const [updateSearchParams, options] = mockSetSearchParams.mock.calls.at(-1)!;
    const nextParams =
      typeof updateSearchParams === "function"
        ? updateSearchParams(new URLSearchParams("source=tcgdex&language=en"))
        : updateSearchParams;

    expect(nextParams.toString()).toBe("source=tcgdex&language=en&setId=fossil");
    expect(options).toMatchObject({ preventScrollReset: true, replace: false });
  });

  it("keeps a URL-selected expansion fallback visible before options include it", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([
      new URLSearchParams("source=tcgdex&language=en&setId=me04"),
      mockSetSearchParams,
    ]);

    render(
      <IntegrationManagementPage
        data={{ items: [integrationScope()], total: 1, count: 1 }}
        query={{ ...query, source: "tcgdex", language: "en", setId: "me04" }}
      />,
    );

    expect((screen.getByRole("combobox", { name: "Expansion" }) as HTMLInputElement).value).toBe("me04");
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

  it("clones provider profiles and records migration evidence from the review table", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Clone$/i })[0]);
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByDisplayValue("2026.06.03.1")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Clone$/i }));

    await waitFor(() =>
      expect(mockCloneSourceObservationProviderProfile).toHaveBeenCalledWith("scrydex", "2026.06.03", {
        targetProfileVersion: "2026.06.03.1",
      }),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /^Evidence$/i })[0]);
    dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Evidence"), {
      target: { value: "Fixture harness passed and replay diff was reviewed." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save evidence$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfile).toHaveBeenCalledWith("scrydex", "2026.06.03", {
        migrationEvidence: expect.objectContaining({
          evidenceText: "Fixture harness passed and replay diff was reviewed.",
        }),
      }),
    );
  });

  it("edits profile JSON and opens an active comparison from the review table", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    const activeProfile = profileReview({
      providerKey: "scrydex",
      profileVersion: "2026.06.02",
      lifecycle: "active",
      active: true,
    });
    const draftProfile = profileReview({
      providerKey: "scrydex",
      profileVersion: "2026.06.03",
      lifecycle: "draft",
      active: false,
    });
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: { items: [draftProfile, activeProfile], total: 2, count: 2 },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit JSON$/i })[0]);
    let dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Profile JSON"), {
      target: {
        value: JSON.stringify({
          profile: {
            ...(draftProfile.profile as Record<string, unknown>),
            displayName: "Scrydex Draft",
          },
        }),
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save JSON$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfile).toHaveBeenCalledWith("scrydex", "2026.06.03", {
        profile: expect.objectContaining({
          displayName: "Scrydex Draft",
        }),
      }),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /^Compare$/i })[0]);
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("2026.06.02").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Activation blocked")).toBeTruthy();
    expect(within(dialog).getByText("Mapping changed")).toBeTruthy();
    expect(within(dialog).getByText("Semantic Changes")).toBeTruthy();
    expect(within(dialog).getAllByText("Source Mapping Fingerprint").length).toBeGreaterThan(0);
    expect(within(dialog).queryByLabelText("Candidate profile JSON")).toBeNull();
    expect(within(dialog).queryByLabelText("Active profile JSON")).toBeNull();
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

  it("enqueues a TCGplayer product-line import scope from profile-backed options", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Pull Provider Data/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("tab", { name: "TCGplayer" }));
    fireEvent.change(await within(dialog).findByLabelText("Product Line"), {
      target: { value: "3" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Import$/i }));

    await waitFor(() =>
      expect(mockEnqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
        provider: "tcgplayer",
        language: "en",
        productLineId: "3",
        setName: undefined,
      }),
    );
    expect(mockUseSourceObservationIntegrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKey: "tcgplayer",
        queryKind: "product-lines",
      }),
    );
    expect(mockUseSourceObservationIntegrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKey: "tcgplayer",
        queryKind: "set-names",
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

  if (queryKind === "product-lines") {
    return {
      data: {
        items: [
          {
            providerKey: "tcgplayer",
            queryKind: "product-lines",
            value: "3",
            label: "Pokemon",
            description: "TCGplayer category 3",
            parentValue: null,
            imageUrl: null,
            metadata: { productLineId: 3 },
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

  if (queryKind === "set-names") {
    return {
      data: {
        items: [
          {
            providerKey: "tcgplayer",
            queryKind: "set-names",
            value: "Prismatic Evolutions",
            label: "Prismatic Evolutions",
            description: "PRE",
            parentValue: "3",
            imageUrl: null,
            metadata: { cleanSetName: "Prismatic Evolutions" },
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
        {
          providerKey: "tcgdex",
          queryKind: "expansions",
          value: "fossil",
          label: "Fossil",
          description: "62 official cards",
          parentValue: "base",
          imageUrl: null,
          metadata: { expansionId: "fossil" },
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

function profileReview(
  overrides: Partial<CatalogProviderProfileVersionReview> = {},
): CatalogProviderProfileVersionReview {
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
    profile: {
      providerKey: "scrydex",
      profileKey: "scryfall-card-fixture",
      displayName: "Scrydex",
      status: "planned",
      connector: { kind: "scrydex-scryfall-json" },
      capabilities: ["source-observation-import", "external-reference-extraction"],
      supportedScopes: ["product/card"],
      languageOptions: ["en"],
      normalizedObservationMapping: { kind: "provider-product" },
    },
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
    retirementPlan: null,
    executableMappingContract: null,
    referenceCount: 0,
    capabilities: ["source-observation-import", "external-reference-extraction"],
    supportedScopes: ["product/card"],
    languageOptions: ["en"],
    mappingOutputKind: "provider-product",
    hasExecutableMappingContract: true,
    migrationEvidence: null,
    authoringAudit: null,
    validation: {
      status: "valid",
      diagnostics: [],
    },
    ...overrides,
  };
}

function profileAuthoringModel(
  overrides: Partial<CatalogProviderProfileAuthoringModel> = {},
): CatalogProviderProfileAuthoringModel {
  return {
    review: profileReview(),
    editableSections: [
      {
        section: "basics",
        displayName: "Basics",
        requiredPermission: "catalog.manage",
        rawJsonBacked: false,
      },
      {
        section: "provider-options",
        displayName: "Provider Options",
        requiredPermission: "catalog.manage",
        rawJsonBacked: false,
      },
    ],
    fixtureCases: [
      {
        flow: "normal",
        payloadFile: "normal.json",
        payloadPath: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/scrydex/normal.json",
        expectedStatus: "completed",
        expectedDiagnosticPaths: [],
        expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
        expectedMergeEvidencePaths: ["duplicatePrevention.mergeCandidateEvidence.0"],
        expectedPromotionCommands: [],
        expectedObservation: { normalizedKind: "provider-product" },
        samplePayload: { id: "fixture_1" },
        samplePayloadAvailable: true,
      },
    ],
    dryRunInputTemplate: {
      observedAt: "1970-01-01T00:00:00.000Z",
      defaultFlow: "normal",
      payload: { id: "fixture_1" },
      fixturePayloads: [],
    },
    semanticDiff: {
      providerKey: "scrydex",
      candidateProfileVersion: "2026.06.03",
      activeProfileVersion: "2026.06.02",
      mappingFingerprint: {
        candidate: "candidate_fingerprint",
        active: "active_fingerprint",
        changed: true,
      },
      changes: [
        {
          path: "sourceMappingFingerprint",
          label: "Source Mapping Fingerprint",
          candidate: "candidate_fingerprint",
          active: "active_fingerprint",
          changed: true,
        },
        {
          path: "profile.capabilities",
          label: "Capabilities",
          candidate: ["source-observation-import", "external-reference-extraction"],
          active: ["source-observation-import"],
          changed: true,
        },
      ],
    },
    activationReadiness: {
      status: "blocked",
      checks: [
        {
          checkKey: "migration-evidence",
          status: "blocked",
          path: "migrationEvidence.evidenceText",
          diagnosticText: "Source Observation mapping fingerprint changes require explicit migration evidence.",
          severity: "error",
        },
      ],
      requiresMigrationEvidence: true,
      referenceCount: 0,
    },
    ...overrides,
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
