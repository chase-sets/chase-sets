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
import type { MappingExpressionValue } from "./mapping-expression-editor";
import type { JsonValue } from "@chase-sets/primitives/json";

vi.setConfig({ testTimeout: 180000 });

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
  mockUpdateSourceObservationProviderProfileSection,
  mockRevalidate,
  mockUseSourceObservationProviderProfileAuthoringModel,
  mockUseSourceObservationProviderProfiles,
  mockUseCatalogIntegrationControlPlaneOverview,
  mockUseCatalogIntegrationControlPlaneReadiness,
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
  mockUpdateSourceObservationProviderProfileSection: vi.fn(),
  mockRevalidate: vi.fn(),
  mockUseSourceObservationProviderProfileAuthoringModel: vi.fn(),
  mockUseSourceObservationProviderProfiles: vi.fn(),
  mockUseCatalogIntegrationControlPlaneOverview: vi.fn(),
  mockUseCatalogIntegrationControlPlaneReadiness: vi.fn(),
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

vi.mock("motion/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  type MockMotionProps = React.HTMLAttributes<HTMLElement> & {
    children?: React.ReactNode;
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
    transition?: unknown;
    layoutId?: unknown;
  };
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const motionComponent = (tagName: string) =>
    React.forwardRef<HTMLElement, MockMotionProps>(
      ({ children, initial, animate, exit, transition, layoutId, ...props }, ref) =>
        React.createElement(tagName, { ...props, ref }, children),
    );

  return {
    AnimatePresence: passthrough,
    LayoutGroup: passthrough,
    MotionConfig: passthrough,
    motion: new Proxy(
      {},
      {
        get: (_target, tagName) => motionComponent(String(tagName)),
      },
    ),
  };
});

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
  updateSourceObservationProviderProfileSection: mockUpdateSourceObservationProviderProfileSection,
  useActiveSourceObservationIntegrationJobs: mockUseActiveSourceObservationIntegrationJobs,
  useCatalogIntegrationControlPlaneOverview: mockUseCatalogIntegrationControlPlaneOverview,
  useCatalogIntegrationControlPlaneReadiness: mockUseCatalogIntegrationControlPlaneReadiness,
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

const pendingWatchResolutions: Array<() => void> = [];

function fieldControls(container: HTMLElement | Document, label: string | RegExp): HTMLElement[] {
  return Array.from(container.querySelectorAll("label"))
    .filter((labelElement) => {
      const text = (labelElement.textContent ?? "").replace(/\s+\*$/, "").trim();
      return typeof label === "string" ? text === label : label.test(text);
    })
    .map((labelElement) => {
      const htmlFor = labelElement.getAttribute("for");
      return htmlFor
        ? container.querySelector<HTMLElement>(`[id="${htmlFor.replaceAll('"', '\\"')}"]`)
        : labelElement.querySelector<HTMLElement>("input, textarea, select, button, [role='combobox']");
    })
    .filter((element): element is HTMLElement => Boolean(element));
}

function fieldControl(container: HTMLElement | Document, label: string | RegExp, index = 0): HTMLElement {
  const control = fieldControls(container, label)[index];
  expect(control).toBeTruthy();
  return control;
}

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
    mockUseCatalogIntegrationControlPlaneOverview.mockReturnValue({
      data: controlPlaneOverview(),
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseCatalogIntegrationControlPlaneReadiness.mockReturnValue({
      data: controlPlaneReadiness(),
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
    mockUpdateSourceObservationProviderProfileSection.mockResolvedValue(profileReview());
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
      diagnostics: [
        {
          code: "required",
          path: "normalizedObservation.fields.name",
          diagnosticText: "Name was overridden for dry-run review.",
          redaction: "none",
        },
      ],
      diagnosticLinks: [
        {
          code: "required",
          path: "normalizedObservation.fields.name",
          sectionKey: "normalized-observation",
          domainConcept: "Normalized Observation",
          fixtureFlow: "normal",
        },
      ],
      hashMaterial: [
        {
          path: "normalizedObservation.hashMaterial.0",
          owner: "catalog-truth",
          uses: ["hash-material"],
          redaction: "none",
          value: "Fury Sliver",
          diagnostics: [],
        },
      ],
      externalReferences: {
        catalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
        productReferences: [],
      },
      selectedOptions: [],
      mergeCandidateEvidence: [],
      duplicatePreventionPolicy: {
        ambiguousCandidatePolicy: "block-promotion",
        replayPolicy: "same-profile-version",
        exactExternalCatalogItemReferencesFirst: true,
      },
      duplicatePreventionRules: [],
      duplicatePreventionCandidatePreview: {
        status: "blocked",
        ruleKey: "exact-external-catalog-item-reference",
        candidateCount: 2,
        candidateCatalogItemIds: ["cat_existing_1", "cat_existing_2"],
        diagnosticText: "Duplicate-prevention rule produced multiple reusable candidates.",
        evidenceSummary: {
          ruleKey: "exact-external-catalog-item-reference",
          matchKind: "exact-external-catalog-item-reference",
          evidenceText: "1 external Catalog Item reference(s)",
          candidateCatalogItemIds: ["cat_existing_1", "cat_existing_2"],
        },
        evidenceSummaries: [],
      },
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
    for (const resolveWatch of pendingWatchResolutions.splice(0)) {
      resolveWatch();
    }
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

  it("renders the integration module shell and selected profile context", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(
      <IntegrationManagementPage
        data={{ items: [integrationScope()], total: 1, count: 1 }}
        query={{ ...query, source: "tcgdex", language: "en", setId: "base1" }}
      />,
    );

    expect(screen.getByRole("tablist", { name: "Catalog integration module area" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Health" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Validation" }));
    expect(screen.getByRole("tab", { name: "Validation" }).getAttribute("aria-selected")).toBe("true");
    expect(fieldControl(document, "Profile workspace")).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: "Selected profile" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "Module map" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "Operations" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Catalog manage enabled").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "Authoring" }));
    expect(screen.getByText("Authoring Workbench")).toBeTruthy();
    expect(screen.getByText("Editable sections")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit selected profile" })).toBeTruthy();
  });

  it("promotes validation, dry-run, comparison, and activation workflows into the profile workbench", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(
      <IntegrationManagementPage
        data={{ items: [integrationScope()], total: 1, count: 1 }}
        query={{ ...query, source: "tcgdex", language: "en", setId: "base1" }}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Validation" }));

    expect(screen.getByText("Validation workbench")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Fixture validation workflow" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Dry-run evidence workflow" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Semantic comparison workflow" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Activation readiness workflow" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Fixture validation workflow" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Dry-run evidence workflow" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Semantic comparison workflow" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Activation readiness workflow" })).toBeTruthy();
    expect(screen.getAllByText("Normalized Observation").length).toBeGreaterThan(0);
    expect(screen.getByText("Affected references")).toBeTruthy();
    expect(screen.getByText("Replay implication")).toBeTruthy();
    expect(screen.getByText("Replay uses same-profile-version")).toBeTruthy();
    expect(document.body.innerHTML.includes("Profile JSON")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Run selected fixture" }));

    await waitFor(() =>
      expect(mockDryRunSourceObservationProviderProfile).toHaveBeenCalledWith(
        "scrydex",
        "2026.06.03",
        expect.objectContaining({ id: "fixture_1", tcgplayer_id: 14240 }),
      ),
    );
    expect(await screen.findByText("Dry-run output evidence")).toBeTruthy();
    expect(screen.getAllByText("Source Observation facts").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Condition/certification evidence").length).toBeGreaterThan(0);
    expect(screen.getAllByText("normalizedObservation.fields.name").length).toBeGreaterThan(0);
    expect(document.body.innerHTML.includes("Dry-run output JSON")).toBe(false);
  });

  it("shows reference ingestion-unit readiness and dry-run Source Observation facts", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(
      <IntegrationManagementPage
        data={{ items: [integrationScope()], total: 1, count: 1 }}
        query={{ ...query, source: "tcgdex", language: "en", setId: "base1" }}
      />,
    );

    expect(screen.getByRole("heading", { name: "First slice readiness" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Rollout controls" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Adapter readiness" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Audit lifecycle" })).toBeTruthy();
    expect(screen.getAllByText("reference-cards:pokemon:single-card:source-observation-proof").length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("reference-proof-2026.06.05").length).toBeGreaterThan(0);
    expect(screen.getByText("Latest job")).toBeTruthy();
    expect(screen.getByText("import running (1/2)")).toBeTruthy();
    expect(
      screen.getByText(/Provider transport, credentials, option queries, cooldowns, and payload acquisition/),
    ).toBeTruthy();
    expect(screen.getByText("Reference fixture payloads are available.")).toBeTruthy();
    expect(screen.getAllByText("profile-created").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reference profile was created.").length).toBeGreaterThan(0);
    expect(screen.getByText("pokemon:abra-43")).toBeTruthy();
    expect(screen.getByText("sha256:reference-cards-abra-43")).toBeTruthy();
    expect(
      screen.getByText("Reference provider uses fixture-backed payloads and does not require live provider transport."),
    ).toBeTruthy();
  });

  it("surfaces active rollout controls in the health dashboard", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    const overview = controlPlaneOverview();
    const blockedImportControl = {
      controlId: "imports-disabled",
      owner: "catalog-source-observations" as const,
      ownerIssue: 801 as const,
      defaultState: "open" as const,
      status: "blocked" as const,
      severity: "error" as const,
      capabilities: ["import"],
      providerKeys: ["tcgdex"],
      profileKeys: [],
      unitKeys: [],
      message: "Catalog integration imports are disabled for the configured provider scope.",
      auditEventName: "rollout-control-denied" as const,
      metricKey: "catalog.integration.rollout.imports_disabled",
    };
    mockUseCatalogIntegrationControlPlaneOverview.mockReturnValue({
      data: {
        ...overview,
        readiness: {
          ...overview.readiness,
          rolloutControls: {
            generatedAt: overview.generatedAt,
            controls: [blockedImportControl],
          },
        },
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(
      <IntegrationManagementPage
        data={{ items: [integrationScope()], total: 1, count: 1 }}
        query={{ ...query, source: "tcgdex", language: "en", setId: "base1" }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Rollout controls" })).toBeTruthy();
    expect(screen.getByText("imports-disabled")).toBeTruthy();
    expect(screen.getByText(/catalog.integration.rollout.imports_disabled #801/)).toBeTruthy();
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

  it("runs a provider profile fixture dry-run from a fixture flow and displays evidence panels", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Dry run$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(fieldControl(dialog, "Fixture flow")).toBeTruthy();
    expect(dialog.innerHTML.includes("Fixture Payload JSON")).toBe(false);
    expect(within(dialog).getByText("Safe Payload Overrides")).toBeTruthy();
    expect(within(dialog).getByText("Fixture Sample Fields")).toBeTruthy();
    expect(fieldControl(dialog, "Override Id")).toBeTruthy();
    fireEvent.change(fieldControl(dialog, "Override name"), { target: { value: "Fury Sliver Override" } });
    fireEvent.change(fieldControl(dialog, "Override Tcgplayer Id"), { target: { value: "14241" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Dry run$/i }));

    await waitFor(() =>
      expect(mockDryRunSourceObservationProviderProfile).toHaveBeenCalledWith(
        "scrydex",
        "2026.06.03",
        expect.objectContaining({ tcgplayer_id: 14241, name: "Fury Sliver Override" }),
      ),
    );
    expect(await within(dialog).findByText("Dry-Run Summary")).toBeTruthy();
    expect(within(dialog).getByText("Diagnostic Groups")).toBeTruthy();
    expect(within(dialog).getAllByText("Normalized Observation").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Redaction Summary")).toBeTruthy();
    expect(within(dialog).getByText("Payload redacted fields")).toBeTruthy();
    expect(within(dialog).getByText("Evidence redaction categories")).toBeTruthy();
    expect(within(dialog).getByText("External References")).toBeTruthy();
    expect(within(dialog).getByText("Mapping Evidence")).toBeTruthy();
    expect(within(dialog).getByText("Ambiguous candidates")).toBeTruthy();
    expect(within(dialog).getByText("Block promotion")).toBeTruthy();
    expect(within(dialog).getByText("Same profile version")).toBeTruthy();
    expect(within(dialog).getByText("Candidate preview")).toBeTruthy();
    expect(within(dialog).getByText(/cat_existing_1, cat_existing_2/i)).toBeTruthy();
    expect(within(dialog).getAllByText("product:14240").length).toBeGreaterThan(0);
    expect(dialog.innerHTML.includes("Dry-run output JSON")).toBe(false);
  });

  it("keeps view-only operators on read workflows and disables writes", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(
      <IntegrationManagementPage
        data={{ items: [integrationScope()], total: 1, count: 1 }}
        query={query}
        permissions={{ canManageCatalog: false }}
      />,
    );

    expect((screen.getByRole("button", { name: /Pull Provider Data/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Reapply promoted/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: /^Dry run$/i })[0] as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getAllByRole("button", { name: /^Compare$/i })[0] as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getAllByRole("button", { name: /^Clone$/i })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: /^Edit Profile$/i })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: /^Evidence$/i })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: /^Activate$/i })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: /^Deprecate$/i })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: /^Rollback$/i })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: /^Retire$/i })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: /^Promote all$/i })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: /^Resync set$/i })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: /^Sync promoted$/i })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens activation readiness before activating a profile", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfileAuthoringModel.mockReturnValue({
      data: profileAuthoringModel({
        activationReadiness: {
          status: "ready",
          checks: [
            {
              checkKey: "fixture-harness",
              code: "fixture-harness-passed",
              sectionKey: "fixture-contract",
              domainConcept: "Fixture Coverage",
              status: "passed",
              path: "fixtures.coveredFlows",
              diagnosticText: "Fixture harness passed.",
              severity: "warning",
              remediation: "No remediation required.",
              blockingBehavior: "Activation can proceed.",
            },
          ],
          groups: [
            {
              domainConcept: "Fixture Coverage",
              status: "ready",
              checks: [
                {
                  checkKey: "fixture-harness",
                  code: "fixture-harness-passed",
                  sectionKey: "fixture-contract",
                  domainConcept: "Fixture Coverage",
                  status: "passed",
                  path: "fixtures.coveredFlows",
                  diagnosticText: "Fixture harness passed.",
                  severity: "warning",
                  remediation: "No remediation required.",
                  blockingBehavior: "Activation can proceed.",
                },
              ],
            },
          ],
          requiresMigrationEvidence: false,
          referenceCount: 0,
        },
        semanticDiff: {
          ...profileAuthoringModel().semanticDiff,
          mappingFingerprint: {
            candidate: "candidate_fingerprint",
            active: "candidate_fingerprint",
            changed: false,
          },
        },
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockActivateSourceObservationProviderProfile.mockResolvedValue(
      profileReview({ active: true, lifecycle: "active" }),
    );

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Activate$/i })[0]);
    const dialog = screen.getByRole("dialog", { name: "Activate profile" });
    expect(within(dialog).getByText("Ready to activate")).toBeTruthy();
    expect(within(dialog).getByText("Mapping unchanged")).toBeTruthy();
    expect(within(dialog).getByText("Readiness Checks")).toBeTruthy();
    expect(within(dialog).getByText("Duplicate prevention")).toBeTruthy();
    expect(within(dialog).getByText(/Block promotion; replay same profile version/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Confirm activation$/i }));

    await waitFor(() =>
      expect(mockActivateSourceObservationProviderProfile).toHaveBeenCalledWith("scrydex", "2026.06.03"),
    );
  });

  it("blocks activation confirmation when readiness has blocking checks", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Activate$/i })[0]);
    const dialog = screen.getByRole("dialog", { name: "Activate profile" });
    expect(within(dialog).getByText("Activation blocked")).toBeTruthy();
    expect(
      within(dialog).getAllByText("Source Observation mapping fingerprint changes require explicit migration evidence.")
        .length,
    ).toBeGreaterThan(0);
    expect((within(dialog).getByRole("button", { name: /^Confirm activation$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(mockActivateSourceObservationProviderProfile).not.toHaveBeenCalled();
  });

  it("surfaces fixture and import eligibility blockers in activation readiness", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    const longReadinessPath =
      "sourceObservation.normalized.references.externalProductReferences[0].selectedOptions.conditionCertification.evidence.providerPayloadPaths[0]";
    const longReadinessDiagnostic =
      "Activation is blocked because condition and certification evidence points at a deeply nested provider payload path that must stay readable without opening raw profile JSON.";
    mockUseSourceObservationProviderProfileAuthoringModel.mockReturnValue({
      data: profileAuthoringModel({
        activationReadiness: {
          status: "blocked",
          checks: [
            {
              checkKey: "fixture-live-calls",
              code: "fixture-live-calls-blocked",
              sectionKey: "fixture-contract",
              domainConcept: "Fixture Coverage",
              status: "blocked",
              path: "fixtures.liveProviderCallsAllowed",
              diagnosticText: "Fixture validation must not require live provider calls.",
              severity: "error",
              remediation: "Use fixture-backed payloads before activation.",
              blockingBehavior: "Activation is blocked while live provider calls are required.",
            },
            {
              checkKey: "import-eligibility",
              code: "import-eligibility-blocked",
              sectionKey: "profile-identity",
              domainConcept: "Profile Identity",
              status: "blocked",
              path: "profile.capabilities",
              diagnosticText:
                "Activation requires the source-observation-import capability so new provider imports can use this profile.",
              severity: "error",
              remediation: "Add source-observation-import capability before activation.",
              blockingBehavior: "Activation is blocked while imports cannot use the profile.",
            },
            {
              checkKey: "profile-validation",
              code: "profile-validation-blocked",
              sectionKey: "profile-identity",
              domainConcept: "Profile Identity",
              status: "blocked",
              path: longReadinessPath,
              diagnosticText: longReadinessDiagnostic,
              severity: "error",
              remediation: longReadinessDiagnostic,
              blockingBehavior: "Activation is blocked until validation is activation-ready.",
            },
          ],
          groups: [
            {
              domainConcept: "Fixture Coverage",
              status: "blocked",
              checks: [
                {
                  checkKey: "fixture-live-calls",
                  code: "fixture-live-calls-blocked",
                  sectionKey: "fixture-contract",
                  domainConcept: "Fixture Coverage",
                  status: "blocked",
                  path: "fixtures.liveProviderCallsAllowed",
                  diagnosticText: "Fixture validation must not require live provider calls.",
                  severity: "error",
                  remediation: "Use fixture-backed payloads before activation.",
                  blockingBehavior: "Activation is blocked while live provider calls are required.",
                },
              ],
            },
            {
              domainConcept: "Profile Identity",
              status: "blocked",
              checks: [
                {
                  checkKey: "import-eligibility",
                  code: "import-eligibility-blocked",
                  sectionKey: "profile-identity",
                  domainConcept: "Profile Identity",
                  status: "blocked",
                  path: "profile.capabilities",
                  diagnosticText:
                    "Activation requires the source-observation-import capability so new provider imports can use this profile.",
                  severity: "error",
                  remediation: "Add source-observation-import capability before activation.",
                  blockingBehavior: "Activation is blocked while imports cannot use the profile.",
                },
                {
                  checkKey: "profile-validation",
                  code: "profile-validation-blocked",
                  sectionKey: "profile-identity",
                  domainConcept: "Profile Identity",
                  status: "blocked",
                  path: longReadinessPath,
                  diagnosticText: longReadinessDiagnostic,
                  severity: "error",
                  remediation: longReadinessDiagnostic,
                  blockingBehavior: "Activation is blocked until validation is activation-ready.",
                },
              ],
            },
          ],
          requiresMigrationEvidence: false,
          referenceCount: 0,
        },
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getByRole("tab", { name: "Validation" }));
    const readinessRegion = screen.getByRole("region", { name: "Activation readiness workflow" });
    expect(within(readinessRegion).getAllByText(longReadinessPath).length).toBeGreaterThan(0);
    expect(within(readinessRegion).getAllByText(longReadinessDiagnostic).length).toBeGreaterThan(0);
    expect(document.body.innerHTML.includes("Profile JSON")).toBe(false);

    fireEvent.click(screen.getAllByRole("button", { name: /^Activate$/i })[0]);
    const dialog = screen.getByRole("dialog", { name: "Activate profile" });
    expect(within(dialog).getByText("Fixture readiness")).toBeTruthy();
    expect(within(dialog).getByText("Import eligibility")).toBeTruthy();
    expect(within(dialog).getByText("Profile validation")).toBeTruthy();
    expect(
      within(dialog).getAllByText("Fixture validation must not require live provider calls.").length,
    ).toBeGreaterThan(0);
    expect(
      within(dialog).getAllByText(
        "Activation requires the source-observation-import capability so new provider imports can use this profile.",
      ).length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(longReadinessPath).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(longReadinessDiagnostic).length).toBeGreaterThan(0);
    expect(dialog.innerHTML.includes("Profile JSON")).toBe(false);
    expect((within(dialog).getByRole("button", { name: /^Confirm activation$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("confirms deprecation rollback and retirement with lifecycle context", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Deprecate$/i })[0]);
    let dialog = screen.getByRole("dialog", { name: "Deprecate profile" });
    expect(within(dialog).getByText(/Deprecation keeps this profile readable for replay and rollback/i)).toBeTruthy();
    expect(within(dialog).getByText(/Source Observation References/i)).toBeTruthy();
    expect(mockDeprecateSourceObservationProviderProfile).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Confirm deprecation$/i }));

    await waitFor(() =>
      expect(mockDeprecateSourceObservationProviderProfile).toHaveBeenCalledWith("scrydex", "2026.06.03"),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /^Rollback$/i })[0]);
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Rollback reactivates this previously validated profile version/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Roll back$/i }));

    await waitFor(() =>
      expect(mockRollbackSourceObservationProviderProfile).toHaveBeenCalledWith("scrydex", "2026.06.03"),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /^Retire$/i })[0]);
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("No Source Observation references remain.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Retire$/i }));

    await waitFor(() =>
      expect(mockRetireSourceObservationProviderProfile).toHaveBeenCalledWith("scrydex", "2026.06.03"),
    );
  });

  it("blocks retirement from the review table while profile references remain", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: { items: [profileReview({ referenceCount: 3 })], total: 1, count: 1 },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    expect(
      screen.getAllByRole("button", { name: /^Retire$/i }).every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(screen.getAllByText("3 refs").length).toBeGreaterThan(0);
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
    expect(within(dialog).getByText("Activation Readiness")).toBeTruthy();
    expect(within(dialog).getByText("Candidate fingerprint")).toBeTruthy();
    fireEvent.change(fieldControl(dialog, "Fixture run id"), {
      target: { value: "fixture-run-20260604" },
    });
    fireEvent.change(fieldControl(dialog, "Replay scope"), {
      target: { value: "scrydex changed observations" },
    });
    fireEvent.change(fieldControl(dialog, "Observed impact"), {
      target: { value: "Replay changed only expected hash material for Scrydex fixtures." },
    });
    fireEvent.change(fieldControl(dialog, "Operator note"), {
      target: { value: "Fixture harness passed and replay diff was reviewed." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save evidence$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "scrydex",
        "2026.06.03",
        "migration-evidence",
        {
          section: "migration-evidence",
          migrationEvidence: expect.objectContaining({
            evidenceText: expect.stringContaining("Fixture run: fixture-run-20260604"),
            fixtureRunId: "fixture-run-20260604",
            mappingFingerprintBefore: "active_fingerprint",
            mappingFingerprintAfter: "candidate_fingerprint",
          }),
        },
      ),
    );
  });

  it("edits profile basics from the review table", async () => {
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

    expect((screen.getAllByRole("button", { name: /^Edit Profile$/i })[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    let dialog = screen.getByRole("dialog");
    expect(dialog.innerHTML.includes("Profile JSON")).toBe(false);
    expect(within(dialog).getByText("Profile section registry")).toBeTruthy();
    expect(within(dialog).getByText("Catalog field mapping")).toBeTruthy();
    fireEvent.change(fieldControl(dialog, "Display name"), { target: { value: "Scrydex Draft" } });
    fireEvent.change(fieldControl(dialog, /^Contract owner/i), { target: { value: "Catalog Ops" } });
    fireEvent.change(fieldControl(dialog, "Repository"), {
      target: { value: "chase-sets/catalog-contracts" },
    });
    fireEvent.change(fieldControl(dialog, "Commit"), { target: { value: "abc123" } });
    fireEvent.change(fieldControl(dialog, /^Document path/i), {
      target: { value: "bounded-contexts/catalog/docs/scrydex-contract.md" },
    });
    fireEvent.change(fieldControl(dialog, /^Fixture set version/i), {
      target: { value: "scrydex-scryfall-card-proof-v2" },
    });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /^Track planned retirement$/i }));
    fireEvent.change(fieldControl(dialog, "Tracking issue"), { target: { value: "739" } });
    fireEvent.change(fieldControl(dialog, /^Retirement diagnostic/i), {
      target: { value: "Retire once the executable mapping contract is active." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "scrydex",
        "2026.06.03",
        "basics",
        expect.objectContaining({
          section: "basics",
          displayName: "Scrydex Draft",
          lifecycle: "draft",
          status: "planned",
          compatibilityMode: "executable-mapping-contract",
          capabilities: expect.arrayContaining(["source-observation-import"]),
          supportedScopes: expect.arrayContaining(["product/card"]),
          languageOptions: ["en"],
        }),
      ),
    );
    expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
      "scrydex",
      "2026.06.03",
      "source-contract",
      {
        section: "source-contract",
        sourceContract: {
          owner: "Catalog Ops",
          repository: "chase-sets/catalog-contracts",
          commit: "abc123",
          documentPath: "bounded-contexts/catalog/docs/scrydex-contract.md",
          fixtureSetVersion: "scrydex-scryfall-card-proof-v2",
        },
      },
    );
    expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
      "scrydex",
      "2026.06.03",
      "retirement-plan",
      {
        section: "retirement-plan",
        retirementPlan: {
          trackingIssue: 739,
          removeAfter: "executable-mapping-contract-activated",
          diagnosticText: "Retire once the executable mapping contract is active.",
        },
      },
    );
    expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledTimes(3);
    expect(mockUpdateSourceObservationProviderProfileSection).not.toHaveBeenCalledWith(
      "scrydex",
      "2026.06.03",
      "normalized-observation",
      expect.anything(),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel$/i }));
  }, 180000);

  it("saves a single dirty section without writing other profile sections", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(fieldControl(dialog, "Display name"), { target: { value: "Scrydex Scoped" } });
    expect(within(dialog).getByText("Changed sections")).toBeTruthy();
    expect(within(dialog).getAllByText("Basics").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save section$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "scrydex",
        "2026.06.03",
        "basics",
        expect.objectContaining({
          section: "basics",
          displayName: "Scrydex Scoped",
        }),
      ),
    );
    expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledTimes(1);
    expect(mockUpdateSourceObservationProviderProfileSection).not.toHaveBeenCalledWith(
      "scrydex",
      "2026.06.03",
      "source-contract",
      expect.anything(),
    );
  }, 180000);

  it("blocks stale dirty sections when the profile row changes after the editor opens", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    const originalProfile = profileReview({
      lifecycle: "draft",
      authoringAudit: { updatedAt: "2026-06-07T10:00:00Z" },
    });
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: { items: [originalProfile], total: 1, count: 1 },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { rerender } = render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(fieldControl(dialog, "Display name"), { target: { value: "Scrydex Stale" } });
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            lifecycle: "draft",
            authoringAudit: { updatedAt: "2026-06-07T10:05:00Z", updatedByUserId: "other-operator" },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    rerender(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    expect(
      within(dialog).getAllByText("Profile changed after this editor opened. Close and reopen before saving.").length,
    ).toBeGreaterThan(0);
    expect(
      (within(dialog).getByRole("button", { name: /^Save changed sections$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(dialog).queryByRole("button", { name: /^Save section$/i })).toBeNull();
  }, 180000);

  it("shows section-level validation before saving dirty sections", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(fieldControl(dialog, /^Contract owner/i), { target: { value: "" } });

    expect(within(dialog).getAllByText("Contract owner is required.").length).toBeGreaterThan(0);
    expect(
      (within(dialog).getByRole("button", { name: /^Save changed sections$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mockUpdateSourceObservationProviderProfileSection).not.toHaveBeenCalled();
  }, 180000);

  it("keeps partial multi-section save failures scoped to the failed section", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUpdateSourceObservationProviderProfileSection.mockImplementation(
      async (
        _providerKey: string,
        _profileVersion: string,
        section: string,
      ): Promise<CatalogProviderProfileVersionReview> => {
        if (section === "provider-options") {
          throw new Error("Provider options failed.");
        }
        return profileReview();
      },
    );

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(fieldControl(dialog, "Display name"), { target: { value: "Scrydex Partial" } });
    fireEvent.change(fieldControl(dialog, /^Option display name/i, 0), { target: { value: "Set Filter" } });
    expect(within(dialog).getByText(/Basics, Provider Options/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() => expect(within(dialog).getByText("Provider options failed.")).toBeTruthy());
    expect(within(dialog).getByText("1 profile section saved; 1 failed.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
      "scrydex",
      "2026.06.03",
      "basics",
      expect.objectContaining({ displayName: "Scrydex Partial" }),
    );
    expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
      "scrydex",
      "2026.06.03",
      "provider-options",
      expect.objectContaining({ section: "provider-options" }),
    );
  }, 180000);

  it("renders semantic comparison fingerprint and impact metadata without raw JSON", () => {
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

    fireEvent.click(screen.getAllByRole("button", { name: /^Compare$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Semantic Changes")).toBeTruthy();
    expect(within(dialog).getByText("Candidate fingerprint")).toBeTruthy();
    expect(within(dialog).getAllByText("candidate_fingerprint").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Active fingerprint")).toBeTruthy();
    expect(within(dialog).getAllByText("active_fingerprint").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Activation Impact").length).toBeGreaterThan(0);
    expect(
      within(dialog).getAllByText(
        "Summarizes whether replay/hash behavior changed and whether migration evidence is required.",
      ).length,
    ).toBeGreaterThan(0);
    expect(dialog.innerHTML.includes("Candidate profile JSON")).toBe(false);
    expect(dialog.innerHTML.includes("Active profile JSON")).toBe(false);
  });

  it("edits normalized observation expressions through typed controls", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Normalized Observation" })).toBeTruthy();
    expect(within(dialog).getByText("Sample Normalized Output")).toBeTruthy();
    expect(within(dialog).getByText("Fingerprint impact")).toBeTruthy();
    expect(within(dialog).getByText(/active_fingerprint -> candidate_fingerprint/i)).toBeTruthy();
    expect(within(dialog).getAllByText("Fixture Preview").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("fixture_1").length).toBeGreaterThan(0);
    expect(dialog.innerHTML.includes("Profile JSON")).toBe(false);

    fireEvent.change(fieldControl(dialog, /^Path$/i, 1), {
      target: { value: "card.printed_name" },
    });
    fireEvent.change(fieldControl(dialog, /^Path$/i, 3), {
      target: { value: "catalogHashMaterial.printedProductName" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "scrydex",
        "2026.06.03",
        "normalized-observation",
        {
          section: "normalized-observation",
          normalizedObservationMapping: expect.objectContaining({ kind: "provider-product" }),
          normalizedObservationContract: expect.objectContaining({
            outputKind: "provider-product",
            languageCode: expect.objectContaining({
              selector: expect.objectContaining({ path: "lang" }),
            }),
            fields: expect.objectContaining({
              name: expect.objectContaining({
                selector: expect.objectContaining({ path: "card.printed_name" }),
              }),
            }),
            hashMaterial: [
              expect.objectContaining({
                selector: expect.objectContaining({ path: "catalogHashMaterial.printedProductName" }),
              }),
            ],
            mergeIdentity: [
              expect.objectContaining({
                selector: expect.objectContaining({ path: "id" }),
              }),
            ],
          }),
        },
      ),
    );
  });

  it("blocks unsafe normalized hash material before save", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            executableMappingContract: executableMappingContract({
              hashMaterial: [
                mappingExpression("prices.usd", "catalog-truth", ["hash-material"], {
                  redaction: "price",
                }),
              ],
            }),
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/hash material cannot use secret, pricing, inventory/i)).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: /^Save changed sections$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("edits external product references and selected option mappings through typed controls", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgplayer",
            profileKey: "tcgplayer-product",
            displayName: "TCGplayer",
            profile: {
              providerKey: "tcgplayer",
              profileKey: "tcgplayer-product",
              displayName: "TCGplayer",
              status: "planned",
              connector: tcgplayerConnectorFixture(),
              capabilities: ["source-observation-import", "external-reference-extraction"],
              supportedScopes: ["product"],
              languageOptions: ["en"],
              optionQueries: [],
              normalizedObservationMapping: { kind: "provider-product" },
              selectedOptionMapping: selectedOptionMappingFixture(),
              externalReferenceExtractionRules: { referenceTarget: "mixed", rules: [] },
            },
            executableMappingContract: executableMappingContract({
              externalReferences: externalReferenceContractsFixture(),
            }),
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseSourceObservationProviderProfileAuthoringModel.mockReturnValue({
      data: profileAuthoringModel({
        fixtureCases: [
          {
            flow: "normal",
            payloadFile: "normal.json",
            payloadPath: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer/normal.json",
            expectedStatus: "completed",
            expectedDiagnosticPaths: [],
            expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
            expectedMergeEvidencePaths: ["duplicatePrevention.mergeCandidateEvidence.0"],
            expectedPromotionCommands: [],
            expectedObservation: { normalizedKind: "provider-product" },
            samplePayload: {
              externalCatalogItemReferences: 14240,
              externalProductReferences: 610001,
              condition: "Near Mint",
            },
            samplePayloadAvailable: true,
          },
        ],
        dryRunInputTemplate: {
          observedAt: "1970-01-01T00:00:00.000Z",
          defaultFlow: "normal",
          payload: {
            externalCatalogItemReferences: 14240,
            externalProductReferences: 610001,
            condition: "Near Mint",
          },
          fixturePayloads: [],
        },
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("External References and Selected Options")).toBeTruthy();
    expect(within(dialog).getByText("External Reference Preview")).toBeTruthy();
    expect(within(dialog).getByText(/product:14240/i)).toBeTruthy();
    expect(within(dialog).getByText(/sku:610001/i)).toBeTruthy();
    expect(within(dialog).getAllByText(/Near Mint/i).length).toBeGreaterThan(0);
    expect(dialog.innerHTML.includes("Profile JSON")).toBe(false);

    expect(within(dialog).getByText("Product reference")).toBeTruthy();
    fireEvent.change(within(dialog).getAllByDisplayValue("tcgplayer")[1], {
      target: { value: "tcgplayer-marketplace" },
    });
    fireEvent.change(within(dialog).getByDisplayValue("catalog-condition"), {
      target: { value: "catalog-condition-v2" },
    });
    fireEvent.change(fieldControl(dialog, "Option aliases"), {
      target: { value: "near-mint=Near Mint,NM\nlightly-played=Lightly Played,LP" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "tcgplayer",
        "2026.06.03",
        "external-references",
        expect.objectContaining({
          section: "external-references",
          externalReferenceContracts: expect.arrayContaining([
            expect.objectContaining({
              target: "product-reference",
              providerKey: "tcgplayer-marketplace",
              selectedOptions: expect.objectContaining({
                dimensions: [
                  expect.objectContaining({
                    dimensionKey: "condition",
                    optionLookupTableKey: "catalog-condition-v2",
                  }),
                ],
              }),
            }),
          ]),
        }),
      ),
    );
    expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
      "tcgplayer",
      "2026.06.03",
      "selected-options",
      expect.objectContaining({
        section: "selected-options",
        selectedOptionMapping: expect.objectContaining({
          dimensions: [
            expect.objectContaining({
              dimensionKey: "condition",
              providerValue: { source: "record", path: "condition" },
              optionAliases: [
                { optionKey: "near-mint", providerValues: ["Near Mint", "NM"] },
                { optionKey: "lightly-played", providerValues: ["Lightly Played", "LP"] },
              ],
            }),
          ],
        }),
      }),
    );
  });

  it("blocks product reference mappings without selected option dimensions", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            executableMappingContract: executableMappingContract({
              externalReferences: [
                {
                  target: "product-reference",
                  providerKey: "tcgplayer",
                  externalKeyPrefix: "sku:",
                  source: mappingExpression("externalProductReferences", "external-reference", [
                    "external-reference",
                    "selected-option",
                  ]),
                  selectedOptions: {
                    dimensions: [],
                    missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
                  },
                  ambiguityPolicy: "review-evidence",
                },
              ],
            }),
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/product references require selected option dimensions/i)).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: /^Save changed sections$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("blocks selected option dimension keys that are absent from active Catalog schema", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgplayer",
            profileKey: "tcgplayer-product",
            displayName: "TCGplayer",
            profile: {
              providerKey: "tcgplayer",
              profileKey: "tcgplayer-product",
              displayName: "TCGplayer",
              status: "planned",
              connector: tcgplayerConnectorFixture(),
              capabilities: ["source-observation-import", "external-reference-extraction"],
              supportedScopes: ["product"],
              languageOptions: ["en"],
              optionQueries: [],
              normalizedObservationMapping: { kind: "provider-product" },
              selectedOptionMapping: selectedOptionMappingFixture(),
              externalReferenceExtractionRules: { referenceTarget: "mixed", rules: [] },
            },
            executableMappingContract: executableMappingContract({
              externalReferences: externalReferenceContractsFixture(),
            }),
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseSourceObservationProviderProfileAuthoringModel.mockReturnValue({
      data: profileAuthoringModel({
        selectedOptionSchema: {
          dimensions: [
            {
              dimensionId: "dim_printing",
              dimensionKey: "printing",
              dimensionName: "Printing",
              status: "active",
              options: [],
            },
          ],
        },
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getAllByText(/dimension key 'condition' does not match an active Catalog dimension/i).length,
    ).toBeGreaterThan(0);
    expect(
      (within(dialog).getByRole("button", { name: /^Save changed sections$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("edits reference hierarchy chains through typed controls", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Reference Hierarchy" })).toBeTruthy();
    expect(within(dialog).getByText(/expansion > series > product-line/i)).toBeTruthy();

    fireEvent.change(within(dialog).getByDisplayValue("ref_tcgdex"), {
      target: { value: "ref_tcgdex_v2" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "scrydex",
        "2026.06.03",
        "reference-hierarchy",
        expect.objectContaining({
          section: "reference-hierarchy",
          referenceHierarchyMapping: expect.objectContaining({
            providerReferenceIdPrefix: "ref_tcgdex_v2",
            targetRecordRuleKey: "expansion",
            referenceTypes: expect.arrayContaining([
              expect.objectContaining({
                referenceTypeId: "ref_type_expansion",
                typeKey: "expansion",
                attributeKeys: ["tcgdex-set-id"],
              }),
            ]),
            referenceRecords: expect.arrayContaining([
              expect.objectContaining({
                ruleKey: "manufacturer",
                recordId: { kind: "static", referenceRecordId: "ref_manufacturer_pokemon_company" },
              }),
              expect.objectContaining({
                ruleKey: "product-line",
                relationships: [{ relationshipType: "published-by", ruleKey: "manufacturer" }],
              }),
              expect.objectContaining({
                ruleKey: "expansion",
                recordId: { kind: "provider", typeKey: "expansion", providerValuePaths: ["expansionId"] },
                key: { kind: "path", path: "expansionName" },
                attributes: [
                  {
                    attributeKey: "tcgdex-set-id",
                    value: { kind: "path", path: "expansionId" },
                    optional: true,
                  },
                ],
              }),
            ]),
          }),
          referenceHierarchyContracts: [
            expect.objectContaining({
              targetTypeKey: "expansion",
              providerAttributeKey: "tcgdex-set-id",
              parent: expect.objectContaining({
                targetTypeKey: "series",
                parent: expect.objectContaining({ targetTypeKey: "product-line" }),
              }),
            }),
          ],
        }),
      ),
    );
  });

  it("blocks invalid reference hierarchy relationship rule keys", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            profile: {
              referenceHierarchyMapping: {
                ...referenceHierarchyMappingFixture(),
                referenceRecords: [
                  {
                    ruleKey: "expansion",
                    typeKey: "expansion",
                    relationships: [{ relationshipType: "part-of", ruleKey: "missing-series" }],
                  },
                ],
              },
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/relationship rule key 'missing-series' does not match/i)).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: /^Save changed sections$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("saves duplicate-prevention policies and ordered identity rules through typed controls", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Duplicate Prevention" })).toBeTruthy();
    expect(within(dialog).getByText(/Rule 1: exact-external-catalog-item-reference/i)).toBeTruthy();
    expect(within(dialog).getByText(/Rule 2: source-observation-link/i)).toBeTruthy();
    expect(within(dialog).getByText(/Rule 3: pokemon-card-deterministic-fields/i)).toBeTruthy();

    fireEvent.change(within(dialog).getByDisplayValue("card.localId"), {
      target: { value: "card.printedNumber" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "scrydex",
        "2026.06.03",
        "duplicate-prevention",
        expect.objectContaining({
          section: "duplicate-prevention",
          duplicatePreventionContract: expect.objectContaining({
            ambiguousCandidatePolicy: "block-promotion",
            replayPolicy: "same-profile-version",
            exactExternalCatalogItemReferencesFirst: true,
            identityRules: [
              expect.objectContaining({ ruleKey: "exact-external-catalog-item-reference" }),
              expect.objectContaining({ ruleKey: "source-observation-link" }),
              expect.objectContaining({
                ruleKey: "pokemon-card-deterministic-fields",
                evidence: expect.arrayContaining([
                  expect.objectContaining({
                    selector: expect.objectContaining({ path: "card.printedNumber" }),
                  }),
                ]),
              }),
            ],
          }),
        }),
      ),
    );
  });

  it("blocks duplicate duplicate-prevention rule keys before save", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    const duplicatePrevention = duplicatePreventionContractFixture() as Record<string, JsonValue>;
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            executableMappingContract: executableMappingContract({
              duplicatePrevention: {
                ...duplicatePrevention,
                identityRules: [
                  {
                    ruleKey: "same-rule",
                    ruleKind: "exact-external-catalog-item-reference",
                    evidence: [
                      mappingExpression("externalCatalogItemReferences", "external-reference", ["external-reference"]),
                    ],
                    candidatePolicy: "reuse",
                  },
                  {
                    ruleKey: "same-rule",
                    ruleKind: "source-observation-link",
                    evidence: [mappingExpression("externalKey", "external-reference", ["external-reference"])],
                    candidatePolicy: "reuse",
                  },
                ],
              },
            }),
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/same-rule: rule keys must be unique/i)).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: /^Save changed sections$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps immutable profile rows out of the basics editor", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({ profileVersion: "2026.06.01", lifecycle: "active", active: true }),
          profileReview({ profileVersion: "2026.06.02", lifecycle: "deprecated", active: false }),
          profileReview({ profileVersion: "2026.06.03", lifecycle: "retired", active: false }),
        ],
        total: 3,
        count: 3,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    for (const button of screen.getAllByRole("button", { name: /^Edit Profile$/i })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("keeps draft and test profile rows editable in the basics editor", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({ profileVersion: "2026.06.01", lifecycle: "draft", active: false }),
          profileReview({ profileVersion: "2026.06.02", lifecycle: "test", active: false }),
        ],
        total: 2,
        count: 2,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    for (const button of screen.getAllByRole("button", { name: /^Edit Profile$/i })) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("shows section validation messages in the basics editor", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            lifecycle: "draft",
            validation: {
              status: "invalid",
              diagnostics: [
                {
                  code: "source-contract-owner",
                  severity: "error",
                  path: "sourceContract.owner",
                  diagnosticText: "sourceContract.owner must be a non-empty string.",
                },
              ],
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("sourceContract.owner").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("sourceContract.owner must be a non-empty string.").length).toBeGreaterThan(0);
  });

  it("edits provider option queries through guided controls", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgplayer",
            profileKey: "tcgplayer-automation-client",
            displayName: "TCGplayer",
            lifecycle: "draft",
            capabilities: ["provider-option-query", "source-observation-import"],
            supportedScopes: ["product-line/category", "set-name"],
            profile: {
              providerKey: "tcgplayer",
              profileKey: "tcgplayer-automation-client",
              displayName: "TCGplayer",
              status: "planned",
              connector: {
                kind: "tcgplayer-automation-client",
                sourceRepository: {
                  owner: "todd-skelton",
                  name: "tcgplayer-automation-app",
                  commit: "bf42aa8",
                },
                sourceContractDocument: "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
                authentication: {
                  scheme: "tcgplayer-production-cookie",
                  cookieName: "TCGAuthTicket_Production",
                  userAgentRequired: true,
                },
                domains: {
                  search: "mp-search-api.tcgplayer.com",
                  marketplaceApi: "mpapi.tcgplayer.com",
                  infiniteApi: "infinite-api.tcgplayer.com",
                  marketplaceGateway: "mpgateway.tcgplayer.com",
                },
                retryStatusCodes: [403, 429, 502, 503, 504],
              },
              capabilities: ["provider-option-query", "source-observation-import"],
              supportedScopes: ["product-line/category", "set-name"],
              languageOptions: ["en"],
              optionQueries: [
                {
                  queryKind: "product-lines",
                  aliases: ["product-line"],
                  displayName: "Product Line",
                  scope: "product-line/category",
                  parentScope: null,
                  operation: "tcgplayer-list-product-lines",
                  output: {
                    valuePath: "productLineId",
                    labelPath: "productLineName",
                    metadataPaths: { productLineId: "productLineId" },
                  },
                },
                {
                  queryKind: "set-names",
                  aliases: ["set-name"],
                  displayName: "Set Name",
                  scope: "set-name",
                  parentScope: "product-line/category",
                  operation: "tcgplayer-list-set-names",
                  parentValue: {
                    required: true,
                    valueKind: "product-line-id",
                    diagnosticText: "A product line is required.",
                  },
                  output: {
                    valuePath: "cleanSetName",
                    labelPath: "name",
                    description: { kind: "tcgplayer-set-name" },
                    parentValuePath: "$parentValue",
                    metadataPaths: { productLineId: "$parentValueNumber", cleanSetName: "cleanSetName" },
                  },
                },
              ],
              normalizedObservationMapping: { kind: "provider-product" },
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(fieldControl(dialog, /^Option display name/i, 1), {
      target: { value: "Set Filter" },
    });
    fireEvent.change(fieldControl(dialog, "Aliases", 1), { target: { value: "set-name, sets" } });
    fireEvent.change(fieldControl(dialog, "Parent diagnostic", 0), {
      target: { value: "Choose a product line before loading set names." },
    });
    fireEvent.change(fieldControl(dialog, "Metadata paths", 1), {
      target: { value: "productLineId=$parentValueNumber\ncleanSetName=cleanSetName\nurlName=urlName" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "tcgplayer",
        "2026.06.03",
        "provider-options",
        {
          section: "provider-options",
          optionQueries: expect.arrayContaining([
            expect.objectContaining({
              queryKind: "set-names",
              aliases: ["set-name", "sets"],
              displayName: "Set Filter",
              parentScope: "product-line/category",
              parentValue: {
                required: true,
                valueKind: "product-line-id",
                diagnosticText: "Choose a product line before loading set names.",
              },
              output: expect.objectContaining({
                valuePath: "cleanSetName",
                labelPath: "name",
                parentValuePath: "$parentValue",
                metadataPaths: {
                  productLineId: "$parentValueNumber",
                  cleanSetName: "cleanSetName",
                  urlName: "urlName",
                },
              }),
            }),
          ]),
        },
      ),
    );
  });

  it("edits TCGdex option query parent and output mappings", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgdex",
            profileKey: "tcgdex-pokemon-card",
            displayName: "TCGdex",
            lifecycle: "draft",
            capabilities: ["provider-option-query", "source-observation-import"],
            supportedScopes: ["language", "series"],
            profile: {
              providerKey: "tcgdex",
              profileKey: "tcgdex-pokemon-card",
              displayName: "TCGdex",
              status: "planned",
              connector: { kind: "tcgdex-api" },
              capabilities: ["provider-option-query", "source-observation-import"],
              supportedScopes: ["language", "series"],
              languageOptions: ["en", "fr"],
              optionQueries: [
                {
                  queryKind: "series",
                  aliases: ["serie"],
                  displayName: "Series",
                  scope: "series",
                  parentScope: "language",
                  operation: "tcgdex-list-series",
                  parentValue: {
                    required: false,
                    valueKind: "language-code",
                    diagnosticText: "TCGdex series use the selected language.",
                  },
                  output: {
                    valuePath: "seriesId",
                    labelPath: "name",
                    parentValuePath: "$languageCode",
                    imageUrlPath: "logoUrl",
                    metadataPaths: { languageCode: "$languageCode", seriesId: "seriesId" },
                  },
                },
              ],
              normalizedObservationMapping: { kind: "pokemon-card" },
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(fieldControl(dialog, "Parent diagnostic"), {
      target: { value: "Use the selected TCGdex language before loading series." },
    });
    fireEvent.change(fieldControl(dialog, "Image URL path"), { target: { value: "symbolUrl" } });
    fireEvent.change(fieldControl(dialog, "Metadata paths"), {
      target: { value: "languageCode=$languageCode\nseriesId=seriesId\nsymbolUrl=symbolUrl" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "tcgdex",
        "2026.06.03",
        "provider-options",
        {
          section: "provider-options",
          optionQueries: [
            expect.objectContaining({
              queryKind: "series",
              operation: "tcgdex-list-series",
              parentScope: "language",
              parentValue: {
                required: false,
                valueKind: "language-code",
                diagnosticText: "Use the selected TCGdex language before loading series.",
              },
              output: expect.objectContaining({
                valuePath: "seriesId",
                labelPath: "name",
                parentValuePath: "$languageCode",
                imageUrlPath: "symbolUrl",
                metadataPaths: {
                  languageCode: "$languageCode",
                  seriesId: "seriesId",
                  symbolUrl: "symbolUrl",
                },
              }),
            }),
          ],
        },
      ),
    );
  });

  it("blocks duplicate provider option aliases before save", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            lifecycle: "draft",
            capabilities: ["provider-option-query", "source-observation-import"],
            profile: {
              providerKey: "scrydex",
              profileKey: "scryfall-card-fixture",
              displayName: "Scrydex",
              status: "planned",
              connector: { kind: "scrydex-scryfall-json" },
              capabilities: ["provider-option-query", "source-observation-import"],
              supportedScopes: ["set-name"],
              languageOptions: ["en"],
              optionQueries: [
                {
                  queryKind: "sets",
                  aliases: ["set"],
                  displayName: "Set",
                  scope: "set-name",
                  parentScope: null,
                  operation: "scrydex-list-sets",
                  output: { valuePath: "set", labelPath: "set_name", metadataPaths: {} },
                },
                {
                  queryKind: "series",
                  aliases: ["set"],
                  displayName: "Series",
                  scope: "series",
                  parentScope: null,
                  operation: "tcgdex-list-series",
                  output: { valuePath: "", labelPath: "name", metadataPaths: {} },
                },
              ],
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Series: value path and label path are required.")).toBeTruthy();
    expect(within(dialog).getByText("Series: query kind and aliases must be unique.")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: /^Save changed sections$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("edits promotion command plans through structured controls", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgdex",
            profileKey: "tcgdex-pokemon-card",
            displayName: "TCGdex",
            lifecycle: "draft",
            capabilities: ["source-observation-import", "catalog-item-promotion", "external-reference-extraction"],
            mappingOutputKind: "pokemon-card",
            executableMappingContract: executableMappingContract({
              outputKind: "pokemon-card",
              promotionCommandPlan: {
                requiresReview: true,
                commands: [
                  {
                    commandName: "CreateCatalogItem",
                    inputs: {
                      title: mappingExpression("card.name", "catalog-truth", ["promotion-command"]),
                    },
                  },
                ],
              },
            }),
            profile: {
              providerKey: "tcgdex",
              profileKey: "tcgdex-pokemon-card",
              displayName: "TCGdex",
              status: "planned",
              connector: { kind: "tcgdex-json" },
              capabilities: ["source-observation-import", "catalog-item-promotion", "external-reference-extraction"],
              supportedScopes: ["language", "series", "expansion", "product/card"],
              languageOptions: ["en"],
              optionQueries: [],
              normalizedObservationMapping: { kind: "pokemon-card" },
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Promotion Command Plan")).toBeTruthy();
    expect(within(dialog).getByText("Command 1: CreateCatalogItem")).toBeTruthy();
    fireEvent.change(within(dialog).getByDisplayValue("card.name"), { target: { value: "card.printedName" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "tcgdex",
        "2026.06.03",
        "promotion-plan",
        {
          section: "promotion-plan",
          promotionCommandPlan: expect.objectContaining({
            planKind: "catalog-item-promotion",
            requiresReview: true,
            commands: [
              {
                commandName: "CreateCatalogItem",
                inputs: {
                  title: expect.objectContaining({
                    selector: expect.objectContaining({ kind: "path", path: "card.printedName" }),
                    uses: ["promotion-command"],
                  }),
                },
              },
            ],
          }),
        },
      ),
    );
  });

  it("compares promotion command previews with server dry-run output in the editor", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockDryRunSourceObservationProviderProfile.mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.03",
      status: "completed",
      redactedPayload: { card: { name: "Charizard" } },
      observation: null,
      diagnostics: [],
      hashMaterial: [],
      externalReferences: {
        catalogItemReferences: [],
        productReferences: [],
      },
      selectedOptions: [],
      mergeCandidateEvidence: [],
      duplicatePreventionPolicy: {
        ambiguousCandidatePolicy: "block-promotion",
        replayPolicy: "same-profile-version",
        exactExternalCatalogItemReferencesFirst: true,
      },
      duplicatePreventionRules: [],
      duplicatePreventionCandidatePreview: null,
      promotionCommandPlan: {
        requiresReview: true,
        commands: [
          {
            commandName: "CreateCatalogItem",
            inputs: [
              {
                path: "promotionCommandPlan.commands.0.inputs.title",
                owner: "catalog-truth",
                uses: ["promotion-command"],
                redaction: "none",
                value: "Charizard",
                diagnostics: [],
              },
            ],
          },
        ],
      },
    });
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgdex",
            profileKey: "tcgdex-pokemon-card",
            displayName: "TCGdex",
            lifecycle: "draft",
            capabilities: ["source-observation-import", "catalog-item-promotion", "external-reference-extraction"],
            mappingOutputKind: "pokemon-card",
            executableMappingContract: executableMappingContract({
              outputKind: "pokemon-card",
              promotionCommandPlan: {
                requiresReview: true,
                commands: [
                  {
                    commandName: "CreateCatalogItem",
                    inputs: {
                      title: mappingExpression("card.name", "catalog-truth", ["promotion-command"]),
                    },
                  },
                ],
              },
            }),
            profile: {
              providerKey: "tcgdex",
              profileKey: "tcgdex-pokemon-card",
              displayName: "TCGdex",
              status: "planned",
              connector: { kind: "tcgdex-json" },
              capabilities: ["source-observation-import", "catalog-item-promotion", "external-reference-extraction"],
              supportedScopes: ["language", "series", "expansion", "product/card"],
              languageOptions: ["en"],
              optionQueries: [],
              normalizedObservationMapping: { kind: "pokemon-card" },
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseSourceObservationProviderProfileAuthoringModel.mockReturnValue({
      data: profileAuthoringModel({
        fixtureCases: [
          {
            flow: "normal",
            payloadFile: "normal.json",
            payloadPath: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex/normal.json",
            expectedStatus: "completed",
            expectedDiagnosticPaths: [],
            expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
            expectedMergeEvidencePaths: ["duplicatePrevention.mergeCandidateEvidence.0"],
            expectedPromotionCommands: ["CreateCatalogItem"],
            expectedObservation: { normalizedKind: "pokemon-card" },
            samplePayload: { card: { name: "Charizard" } },
            samplePayloadAvailable: true,
          },
        ],
        dryRunInputTemplate: {
          observedAt: "1970-01-01T00:00:00.000Z",
          defaultFlow: "normal",
          payload: { card: { name: "Charizard" } },
          fixturePayloads: [],
        },
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Compare server plan$/i }));

    await waitFor(() =>
      expect(mockDryRunSourceObservationProviderProfile).toHaveBeenCalledWith(
        "tcgdex",
        "2026.06.03",
        expect.objectContaining({ card: { name: "Charizard" } }),
      ),
    );
    await waitFor(() => expect(within(dialog).getAllByText(/completed/i).length).toBeGreaterThan(0));
    expect(within(dialog).getAllByText(/CreateCatalogItem/i).length).toBeGreaterThan(1);
    expect(within(dialog).getAllByText(/Charizard/i).length).toBeGreaterThan(0);
  });

  it("blocks provider-product promotion commands without promotion capability", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgplayer",
            profileKey: "tcgplayer-provider-product",
            displayName: "TCGplayer",
            lifecycle: "draft",
            capabilities: ["source-observation-import", "external-reference-extraction"],
            mappingOutputKind: "provider-product",
            profile: {
              providerKey: "tcgplayer",
              profileKey: "tcgplayer-provider-product",
              displayName: "TCGplayer",
              status: "planned",
              connector: { kind: "tcgplayer-automation-client" },
              capabilities: ["source-observation-import", "external-reference-extraction"],
              supportedScopes: ["product-line/category", "set-name", "product"],
              languageOptions: ["en"],
              optionQueries: [],
              normalizedObservationMapping: { kind: "provider-product" },
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Add command$/i }));
    expect(
      within(dialog).getAllByText(
        "Promotion command plan: provider-product profiles need the catalog-item-promotion capability before commands can be configured.",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (within(dialog).getByRole("button", { name: /^Save changed sections$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("blocks promotion commands that omit command-specific required inputs", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgdex",
            profileKey: "tcgdex-pokemon-card",
            displayName: "TCGdex",
            lifecycle: "draft",
            capabilities: ["source-observation-import", "catalog-item-promotion", "external-reference-extraction"],
            mappingOutputKind: "pokemon-card",
            executableMappingContract: executableMappingContract({
              outputKind: "pokemon-card",
              promotionCommandPlan: {
                requiresReview: true,
                commands: [
                  {
                    commandName: "SetCatalogItemFieldValue",
                    inputs: {
                      fieldKey: mappingExpression("catalog.fields.cardName", "catalog-truth", ["promotion-command"]),
                    },
                  },
                ],
              },
            }),
            profile: {
              providerKey: "tcgdex",
              profileKey: "tcgdex-pokemon-card",
              displayName: "TCGdex",
              status: "planned",
              connector: { kind: "tcgdex-json" },
              capabilities: ["source-observation-import", "catalog-item-promotion", "external-reference-extraction"],
              supportedScopes: ["language", "series", "expansion", "product/card"],
              languageOptions: ["en"],
              optionQueries: [],
              normalizedObservationMapping: { kind: "pokemon-card" },
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Promotion command 1: missing required inputs value.")).toBeTruthy();
    expect(within(dialog).getByText("Required inputs")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: /^Save changed sections$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("edits TCGdex connector metadata and fixture coverage", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgdex",
            profileKey: "tcgdex-pokemon-card",
            displayName: "TCGdex",
            lifecycle: "draft",
            connectorKind: "tcgdex-json",
            profile: {
              providerKey: "tcgdex",
              profileKey: "tcgdex-pokemon-card",
              displayName: "TCGdex",
              status: "planned",
              connector: {
                kind: "tcgdex-json",
                baseUrl: "https://api.tcgdex.net/v2",
                highQualityAssetVariant: "high.webp",
                endpoints: {
                  seriesList: "/{language}/series",
                  seriesDetail: "/{language}/series/{seriesId}",
                  expansionList: "/{language}/sets",
                  expansionDetail: "/{language}/sets/{expansionId}",
                  productDetail: "/{language}/cards/{cardId}",
                },
              },
              capabilities: ["provider-option-query", "source-observation-import"],
              supportedScopes: ["language", "series", "expansion"],
              languageOptions: ["en"],
              optionQueries: [],
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(fieldControls(dialog, /^Cookie name/i)).toHaveLength(0);
    fireEvent.change(fieldControl(dialog, /^Base URL/i), { target: { value: "https://api.tcgdex.dev/v2" } });
    fireEvent.change(fieldControl(dialog, /^Product detail endpoint/i), {
      target: { value: "/{language}/cards/{cardId}/details" },
    });
    fireEvent.change(fieldControl(dialog, /^Fixture root/i), {
      target: { value: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex-dev" },
    });
    expect(within(dialog).getByText("Live provider calls allowed")).toBeTruthy();
    expect(within(dialog).getAllByText("No").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /^unknown-option$/i }));
    expect(within(dialog).getByText("Missing required fixture flows: unknown-option")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "tcgdex",
        "2026.06.03",
        "connector",
        {
          section: "connector",
          connector: expect.objectContaining({
            kind: "tcgdex-json",
            baseUrl: "https://api.tcgdex.dev/v2",
            highQualityAssetVariant: "high.webp",
            endpoints: expect.objectContaining({
              productDetail: "/{language}/cards/{cardId}/details",
            }),
          }),
        },
      ),
    );
    expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith("tcgdex", "2026.06.03", "fixtures", {
      section: "fixtures",
      fixtures: {
        fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex-dev",
        coveredFlows: expect.not.arrayContaining(["unknown-option"]),
        liveProviderCallsAllowed: false,
      },
    });
  });

  it("edits TCGplayer automation connector metadata", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgplayer",
            profileKey: "tcgplayer-automation-client",
            displayName: "TCGplayer",
            lifecycle: "draft",
            connectorKind: "tcgplayer-automation-client",
            profile: {
              providerKey: "tcgplayer",
              profileKey: "tcgplayer-automation-client",
              displayName: "TCGplayer",
              status: "planned",
              connector: {
                kind: "tcgplayer-automation-client",
                sourceRepository: {
                  owner: "todd-skelton",
                  name: "tcgplayer-automation-app",
                  commit: "bf42aa8",
                },
                sourceContractDocument: "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
                authentication: {
                  scheme: "tcgplayer-production-cookie",
                  cookieName: "TCGAuthTicket_Production",
                  userAgentRequired: true,
                },
                domains: {
                  search: "mp-search-api.tcgplayer.com",
                  marketplaceApi: "mpapi.tcgplayer.com",
                  infiniteApi: "infinite-api.tcgplayer.com",
                  marketplaceGateway: "mpgateway.tcgplayer.com",
                },
                retryStatusCodes: [403, 429, 502],
              },
              capabilities: ["provider-option-query", "source-observation-import"],
              supportedScopes: ["product-line/category", "set-name"],
              languageOptions: ["en"],
              optionQueries: [],
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(fieldControls(dialog, /^Base URL/i)).toHaveLength(0);
    fireEvent.change(fieldControl(dialog, /^Repository commit/i), { target: { value: "commit-2026" } });
    fireEvent.change(fieldControl(dialog, /^Retry status codes/i), { target: { value: "403, 429, 503" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "tcgplayer",
        "2026.06.03",
        "connector",
        {
          section: "connector",
          connector: expect.objectContaining({
            kind: "tcgplayer-automation-client",
            sourceRepository: {
              owner: "todd-skelton",
              name: "tcgplayer-automation-app",
              commit: "commit-2026",
            },
            authentication: expect.objectContaining({
              scheme: "tcgplayer-production-cookie",
              cookieName: "TCGAuthTicket_Production",
              userAgentRequired: true,
            }),
            retryStatusCodes: [403, 429, 503],
          }),
        },
      ),
    );
  });

  it("edits Scrydex connector evidence metadata without exposing transport fields", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [profileReview({ lifecycle: "draft" })],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Profile$/i })[0]);
    const dialog = screen.getByRole("dialog");
    expect(fieldControls(dialog, /^Repository commit/i)).toHaveLength(0);
    expect(within(dialog).getByText("Fixture backed only")).toBeTruthy();
    fireEvent.change(fieldControl(dialog, /^Accepted evidence/i), {
      target: { value: "scryfall-id, set-code, collector-number" },
    });
    fireEvent.change(fieldControl(dialog, /^Excluded evidence/i), {
      target: { value: "price\nseller" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save changed sections$/i }));

    await waitFor(() =>
      expect(mockUpdateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
        "scrydex",
        "2026.06.03",
        "connector",
        {
          section: "connector",
          connector: {
            kind: "scrydex-scryfall-json",
            sourceContractDocument: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
            fixtureBackedOnly: true,
            acceptedEvidence: ["scryfall-id", "set-code", "collector-number"],
            excludedEvidence: ["price", "seller"],
          },
        },
      ),
    );
  });

  it("enqueues a TCGdex pull for the selected language and optional series", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgdex",
            profileKey: "tcgdex-pokemon-card",
            profileVersion: "2026.06.02",
            lifecycle: "active",
            active: true,
            mappingOutputKind: "pokemon-card",
            capabilities: ["source-observation-import", "catalog-item-promotion"],
            supportedScopes: ["language", "series", "expansion"],
            sourceContract: {
              owner: "chase-sets/catalog",
              repository: "chase-sets/chase-sets",
              commit: null,
              documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
              fixtureSetVersion: "tcgdex-pokemon-card-proof-v1",
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Pull Provider Data/i })[0]);
    expect(fieldControls(document, "TCGdex Expansion ID")).toHaveLength(0);
    expect(screen.getByText("Active Profile Snapshot")).toBeTruthy();
    expect(screen.getByText("TCGdex Import Scope")).toBeTruthy();
    expect(screen.getByText("TCGdex card catalog")).toBeTruthy();
    expect(screen.getByText("provider: tcgdex, language: en")).toBeTruthy();
    expect(screen.getByText("tcgdex-pokemon-card")).toBeTruthy();
    expect(screen.getAllByText("2026.06.02").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tcgdex-pokemon-card-proof-v1").length).toBeGreaterThan(0);
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
    expect(await screen.findByText("Last Job Result")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review Matching Observations" }).getAttribute("href")).toBe(
      "/catalog/source-observations?source=tcgdex&language=en",
    );
    expect(screen.getAllByText("Scope").length).toBeGreaterThan(0);
    expect(screen.getByText("provider: tcgdex, language: en")).toBeTruthy();
    expect(screen.getByText("Imported")).toBeTruthy();
    expect(screen.getByText("No grouped failures")).toBeTruthy();
    expect(mockSetSearchParams).toHaveBeenCalled();
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it("shows a TCGplayer import scope card and enqueues the selected product-line set scope", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgplayer",
            profileKey: "tcgplayer-automation-client",
            profileVersion: "2026.06.02",
            lifecycle: "active",
            active: true,
            mappingOutputKind: "provider-product",
            capabilities: ["source-observation-import"],
            supportedScopes: ["product-line/category", "set-name", "product"],
            sourceContract: {
              owner: "chase-sets/catalog",
              repository: "chase-sets/chase-sets",
              commit: null,
              documentPath: "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
              fixtureSetVersion: "tcgplayer-product-proof-v1",
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Pull Provider Data/i })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("tab", { name: /TCGplayer/i }));

    expect(await within(dialog).findByText("TCGplayer Import Scope")).toBeTruthy();
    expect(within(dialog).getByText("TCGplayer marketplace catalog")).toBeTruthy();
    expect(within(dialog).getAllByText("Product line").length).toBeGreaterThan(0);
    expect(await within(dialog).findByText("Pokemon (3)")).toBeTruthy();
    expect(within(dialog).getByText("provider: tcgplayer, language: en, productLineId: 3")).toBeTruthy();
    expect(within(dialog).getByText("All sets in product line")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /^Import$/i }));

    await waitFor(() =>
      expect(mockEnqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
        provider: "tcgplayer",
        language: "en",
        productLineId: "3",
        setName: undefined,
      }),
    );
  });

  it("links failed job result groups to filtered source observation review", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockWatchSourceObservationIntegrationJob.mockResolvedValue({
      requested: 1,
      imported: 0,
      observed: 0,
      reapplied: 0,
      skipped: 0,
      failed: 1,
      outcomes: [
        {
          providerKey: "tcgdex",
          languageCode: "en",
          expansionId: "base1",
          status: "failed",
          observed: 0,
          reapplied: 0,
          reason: "Mapping failed",
        },
      ],
    });

    render(<IntegrationManagementPage data={{ items: [integrationScope()], total: 1, count: 1 }} query={query} />);

    fireEvent.click(screen.getAllByRole("button", { name: /^Resync set$/i })[0]);

    await waitFor(() => expect(screen.getAllByText("Mapping failed").length).toBeGreaterThan(0));
    expect(screen.getByRole("link", { name: "Review Matching Observations" }).getAttribute("href")).toBe(
      "/catalog/source-observations?source=tcgdex&language=en&setId=base1",
    );
    for (const link of screen.getAllByRole("link", { name: "tcgdex/en/base1" })) {
      expect(link.getAttribute("href")).toBe("/catalog/source-observations?source=tcgdex&language=en&setId=base1");
    }
  });

  it("shows active integration jobs with profile snapshot scope and progress", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    const refresh = vi.fn();
    mockUseActiveSourceObservationIntegrationJobs.mockReturnValue({
      data: {
        items: [
          {
            jobId: "job_active_import",
            action: "import",
            scope: { provider: "tcgdex", language: "en", setId: "base1" },
            profileSnapshot: {
              providerKey: "tcgdex",
              profileKey: "tcgdex-pokemon-card",
              profileVersion: "2026.06.02",
              lifecycle: "active",
              connectorKind: "tcgdex-json",
              connectorSourceVersion: null,
              sourceMappingFingerprint: "fingerprint_active",
            },
            reapplyProfileMode: null,
            status: "running",
            operatorStatus: "running",
            consistency: {
              duplicateSubmissionPolicy: "reuse-active-job",
              profileSnapshotPolicy: "snapshotted-at-enqueue",
              retryResumePolicy: "skip-completed-outcomes",
              partialFailurePolicy: "mixed-outcomes",
              workUnitClaimPolicy: "leased-job-turns",
            },
            progress: {
              phase: "processing",
              completed: 2,
              total: 5,
              currentName: "Base Set",
              status: "processing",
            },
            result: null,
            errorMessage: null,
            createdAt: "2026-06-04T20:00:00.000Z",
            startedAt: "2026-06-04T20:00:05.000Z",
            completedAt: null,
            updatedAt: "2026-06-04T20:00:10.000Z",
          },
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh,
    });

    render(<IntegrationManagementPage data={{ items: [], total: 0, count: 0 }} query={query} />);

    expect(screen.getByText("Active Integration Jobs")).toBeTruthy();
    expect(screen.getAllByText("job_active_import").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tcgdex 2026.06.02").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tcgdex-pokemon-card - active").length).toBeGreaterThan(0);
    expect(screen.getAllByText("provider: tcgdex, language: en, setId: base1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2 of 5 processed.").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Refresh jobs$/i }));
    expect(refresh).toHaveBeenCalled();
  });

  it("shows first-class operations workflows for import review promote reapply and lifecycle control", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([
      new URLSearchParams("source=tcgdex&language=en&setId=base1"),
      mockSetSearchParams,
    ]);
    mockUseSourceObservationProviderProfiles.mockReturnValue({
      data: {
        items: [
          profileReview({
            providerKey: "tcgdex",
            profileKey: "tcgdex-pokemon-card",
            profileVersion: "2026.06.02",
            displayName: "TCGdex",
            lifecycle: "active",
            active: true,
            referenceCount: 2,
            mappingOutputKind: "pokemon-card",
            capabilities: ["source-observation-import", "catalog-item-promotion"],
            supportedScopes: ["language", "series", "expansion"],
            sourceContract: {
              owner: "chase-sets/catalog",
              repository: "chase-sets/chase-sets",
              commit: null,
              documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
              fixtureSetVersion: "tcgdex-pokemon-card-proof-v1",
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseActiveSourceObservationIntegrationJobs.mockReturnValue({
      data: {
        items: [
          {
            jobId: "job_tcgdex_import",
            action: "import",
            scope: { provider: "tcgdex", language: "en", setId: "base1" },
            profileSnapshot: {
              providerKey: "tcgdex",
              profileKey: "tcgdex-pokemon-card",
              profileVersion: "2026.06.02",
              lifecycle: "active",
              connectorKind: "tcgdex-json",
              connectorSourceVersion: null,
              sourceMappingFingerprint: "fingerprint_tcgdex",
            },
            reapplyProfileMode: null,
            status: "running",
            operatorStatus: "running",
            consistency: {
              duplicateSubmissionPolicy: "reuse-active-job",
              profileSnapshotPolicy: "snapshotted-at-enqueue",
              retryResumePolicy: "skip-completed-outcomes",
              partialFailurePolicy: "mixed-outcomes",
              workUnitClaimPolicy: "leased-job-turns",
            },
            progress: {
              phase: "processing",
              completed: 8,
              total: 10,
              currentName: "Base Set",
              status: "imported",
            },
            result: null,
            errorMessage: null,
            createdAt: "2026-06-04T20:00:00.000Z",
            startedAt: "2026-06-04T20:00:05.000Z",
            completedAt: null,
            updatedAt: "2026-06-04T20:00:10.000Z",
          },
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseCatalogIntegrationControlPlaneOverview.mockReturnValue({
      data: {
        ...controlPlaneOverview(),
        unitActivity: {
          generatedAt: "2026-06-05T00:00:00.000Z",
          units: [
            {
              unitKey: "tcgdex:pokemon:single-card",
              recentJobs: [
                {
                  jobId: "job_tcgdex_import",
                  action: "import",
                  operatorStatus: "running",
                  phase: "processing",
                  completed: 8,
                  total: 10,
                  providerKey: "tcgdex",
                  profileVersion: "2026.06.02",
                  startedAt: "2026-06-04T20:00:05.000Z",
                  createdAt: "2026-06-04T20:00:00.000Z",
                  summary: "import job job_tcgdex_import is running (8/10).",
                },
              ],
            },
          ],
        },
        providerReadiness: {
          generatedAt: "2026-06-05T00:00:00.000Z",
          providers: [
            {
              providerKey: "tcgdex",
              adapterKey: "tcgdex-json",
              readiness: "ready",
              credentialReadiness: "not-required",
              credentialReadinessState: "not-required",
              credentialRequirement: "not-required",
              unitKeys: ["tcgdex:pokemon:single-card"],
              apiReachability: { status: "ready", diagnosticCodes: [], message: "TCGdex API reachable." },
              optionQueryHealth: { status: "ready", diagnosticCodes: [], message: "Options available." },
              rateLimitStatus: { status: "ready", diagnosticCodes: [], message: "No cooldown." },
              payloadAcquisition: { status: "ready", diagnosticCodes: [], message: "Payload acquisition ready." },
              diagnostics: [],
            },
          ],
        },
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(
      <IntegrationManagementPage
        data={{ items: [integrationScope()], total: 1, count: 1 }}
        query={{ ...query, source: "tcgdex", language: "en", setId: "base1" }}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Operations" }));

    expect(screen.getByText("Operations workbench")).toBeTruthy();
    expect(screen.getByText("tcgdex:pokemon:single-card")).toBeTruthy();
    expect(screen.getByText("Import and job operations")).toBeTruthy();
    expect(screen.getAllByText("job_tcgdex_import").length).toBeGreaterThan(0);
    expect(screen.getByText("Source Observation review workflow")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review Matching Observations" }).getAttribute("href")).toBe(
      "/catalog/source-observations?source=tcgdex&language=en&setId=base1",
    );
    expect(screen.getByText("Promote and reapply workflow")).toBeTruthy();
    expect(
      screen.getByText("Engine-generated command plans remain scoped to the selected Catalog ingestion unit."),
    ).toBeTruthy();
    expect(screen.getByText("Rollback and retirement workflow")).toBeTruthy();
    expect(screen.getByText("Blocked until Source Observation references are migrated or archived.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Promote matching$/i }));
    await waitFor(() =>
      expect(mockPreviewBulkPromoteSourceObservations).toHaveBeenCalledWith({
        search: "",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      }),
    );
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Cancel$/i }));

    fireEvent.click(screen.getAllByRole("button", { name: /^Reapply promoted$/i })[0]);
    await waitFor(() =>
      expect(mockPreviewReapplySourceObservations).toHaveBeenCalledWith({
        search: "",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      }),
    );
  });

  it("shows queued progress while an integration job waits for worker processing", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockWatchSourceObservationIntegrationJob.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingWatchResolutions.push(() =>
            resolve({
              requested: 1,
              imported: 0,
              observed: 0,
              reapplied: 0,
              skipped: 0,
              failed: 0,
              outcomes: [],
            }),
          );
        }),
    );

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
        return new Promise((resolve) => {
          pendingWatchResolutions.push(() =>
            resolve({
              requested: 100,
              imported: 64,
              observed: 64,
              reapplied: 0,
              skipped: 0,
              failed: 0,
              outcomes: [],
            }),
          );
        });
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
    fireEvent.change(fieldControl(dialog, "Product Line"), {
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
    expect(await screen.findByText("Last Promotion Result")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review Matching Observations" }).getAttribute("href")).toBe(
      "/catalog/source-observations?source=tcgdex&language=en&setId=base1",
    );
    expect(screen.getAllByText("Promoted").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
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
  const defaultProfile = {
    providerKey: "scrydex",
    profileKey: "scryfall-card-fixture",
    displayName: "Scrydex",
    status: "planned",
    connector: { kind: "scrydex-scryfall-json" },
    capabilities: ["source-observation-import", "external-reference-extraction"],
    supportedScopes: ["product/card"],
    languageOptions: ["en"],
    optionQueries: [
      {
        queryKind: "sets",
        aliases: ["set"],
        displayName: "Set",
        scope: "set-name",
        parentScope: null,
        operation: "scrydex-list-sets",
        output: {
          valuePath: "set",
          labelPath: "set_name",
          description: { kind: "path", path: "released_at" },
          metadataPaths: { set: "set", setName: "set_name" },
        },
      },
    ],
    normalizedObservationMapping: { kind: "provider-product" },
    referenceHierarchyMapping: referenceHierarchyMappingFixture(),
    duplicatePreventionMapping: duplicatePreventionMappingFixture(),
    ambiguityRules: {
      repeatedMarketplaceReference: "skip-reference",
      missingVariantSpecificReference: "leave-unmapped",
    },
  };
  const overrideProfile = isPlainObject(overrides.profile) ? overrides.profile : {};

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
    retirementPlan: null,
    executableMappingContract: executableMappingContract(),
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
    profile: { ...defaultProfile, ...overrideProfile },
  };
}

function executableMappingContract(
  overrides: Partial<{
    outputKind: "pokemon-card" | "provider-product";
    languageCode: ReturnType<typeof mappingExpression>;
    fields: Record<string, ReturnType<typeof mappingExpression>>;
    hashMaterial: ReturnType<typeof mappingExpression>[];
    mergeIdentity: ReturnType<typeof mappingExpression>[];
    externalReferences: JsonValue[];
    referenceHierarchy: JsonValue[];
    duplicatePrevention: JsonValue;
    promotionCommandPlan: JsonValue;
  }> = {},
): JsonValue {
  return {
    normalizedObservation: {
      outputKind: overrides.outputKind ?? "provider-product",
      languageCode: overrides.languageCode ?? mappingExpression("lang", "catalog-truth", ["normalized-observation"]),
      fields: overrides.fields ?? {
        name: mappingExpression("name", "catalog-truth", ["normalized-observation", "hash-material"]),
        setName: mappingExpression("set_name", "catalog-truth", ["normalized-observation", "hash-material"]),
      },
      hashMaterial: overrides.hashMaterial ?? [mappingExpression("name", "catalog-truth", ["hash-material"])],
      mergeIdentity: overrides.mergeIdentity ?? [mappingExpression("id", "catalog-merge-evidence", ["merge-identity"])],
    },
    externalReferences: overrides.externalReferences ?? [],
    referenceHierarchy: overrides.referenceHierarchy ?? referenceHierarchyContractsFixture(),
    duplicatePrevention: overrides.duplicatePrevention ?? duplicatePreventionContractFixture(),
    promotionCommandPlan: overrides.promotionCommandPlan ?? {
      requiresReview: true,
      commands: [],
    },
  };
}

function mappingExpression(
  path: string,
  owner:
    | "catalog-truth"
    | "catalog-merge-evidence"
    | "external-reference"
    | "pricing-signal"
    | "inventory-signal"
    | "operations"
    | "excluded",
  uses: readonly (
    | "source-payload"
    | "normalized-observation"
    | "hash-material"
    | "merge-identity"
    | "external-reference"
    | "selected-option"
    | "reference-hierarchy"
    | "promotion-command"
  )[],
  options: Partial<{ redaction: "none" | "secret" | "seller" | "price" | "operations"; required: boolean }> = {},
) {
  return {
    selector: {
      kind: "path",
      path,
      required: options.required ?? true,
      nullPolicy: "diagnostic",
    },
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function referencePathValueRule(path: string) {
  return {
    kind: "path" as const,
    staticValue: "",
    path,
    template: "",
    templateValuesText: "",
  };
}

function referenceTemplateValueRule(template: string, templateValuesText: string) {
  return {
    kind: "template" as const,
    staticValue: "",
    path: "",
    template,
    templateValuesText,
  };
}

function duplicatePreviewRule(
  ruleKey: string,
  ruleKind:
    | "exact-external-catalog-item-reference"
    | "source-observation-link"
    | "deterministic-field-match"
    | "sealed-product-match"
    | "barcode-gtin-match"
    | "future-provider-bridge-match",
  path: string,
) {
  return {
    id: `duplicate-${ruleKey}`,
    ruleKey,
    ruleKind,
    candidatePolicy: "reuse" as const,
    evidence: [
      {
        id: `${ruleKey}-evidence`,
        expression: mappingExpression(path, "catalog-merge-evidence", ["merge-identity"]) as MappingExpressionValue,
      },
    ],
  };
}

function promotionPreviewCommand(
  commandName:
    | "CreateCatalogItem"
    | "RefreshCatalogItem"
    | "ReviseCatalogItemMetadata"
    | "AssignBlueprintToCatalogItem"
    | "AssignCatalogItemToCategory"
    | "SetCatalogItemFieldValue"
    | "SetCatalogItemTags"
    | "SetCatalogItemImageUrls"
    | "SetCatalogItemProductAssetSets"
    | "LinkExternalCatalogItemReference"
    | "LinkExternalProductReference",
  inputs: Record<string, string>,
) {
  return {
    id: `promotion-${commandName}`,
    unsupportedCommandName: null,
    commandName,
    inputs: Object.entries(inputs).map(([fieldKey, path]) => ({
      id: `promotion-${commandName}-${fieldKey}`,
      fieldKey,
      expression: mappingExpression(path, "catalog-truth", ["promotion-command"]) as MappingExpressionValue,
    })),
  };
}

function externalReferenceContractsFixture(): JsonValue[] {
  return [
    {
      target: "catalog-item-reference",
      providerKey: "tcgplayer",
      externalKeyPrefix: "product:",
      source: mappingExpression("externalCatalogItemReferences", "external-reference", ["external-reference"]),
      ambiguityPolicy: "skip-reference",
    },
    {
      target: "product-reference",
      providerKey: "tcgplayer",
      externalKeyPrefix: "sku:",
      source: mappingExpression("externalProductReferences", "external-reference", [
        "external-reference",
        "selected-option",
      ]),
      selectedOptions: {
        dimensions: [
          {
            dimensionKey: "condition",
            providerValue: mappingExpression("condition", "external-reference", ["selected-option"]),
            optionLookupTableKey: "catalog-condition",
            required: true,
          },
        ],
        missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
      },
      ambiguityPolicy: "review-evidence",
    },
  ];
}

function tcgplayerConnectorFixture() {
  return {
    kind: "tcgplayer-automation-client",
    sourceRepository: {
      owner: "todd-skelton",
      name: "tcgplayer-automation-app",
      commit: "abc123",
    },
    sourceContractDocument: "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
    authentication: {
      scheme: "tcgplayer-production-cookie",
      cookieName: "TCGAuthTicket_Production",
      userAgentRequired: true,
    },
    domains: {
      search: "mp-search-api.tcgplayer.com",
      marketplaceApi: "mpapi.tcgplayer.com",
      infiniteApi: "infinite-api.tcgplayer.com",
      marketplaceGateway: "mpgateway.tcgplayer.com",
    },
    retryStatusCodes: [403, 429, 502, 503, 504],
  };
}

function selectedOptionMappingFixture() {
  return {
    source: "tcgplayer-sku-condition-variant-language",
    dimensions: [
      {
        dimensionKey: "condition",
        providerValue: { source: "record", path: "condition" },
        required: true,
        unknownPolicy: "review-evidence",
        optionAliases: [{ optionKey: "near-mint", providerValues: ["Near Mint", "NM"] }],
      },
    ],
    productReferenceRule: {
      providerKey: "tcgplayer",
      externalKeyPrefix: "sku:",
      requiredSourceKeys: ["sku", "condition"],
      missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
    },
  };
}

function referenceHierarchyMappingFixture() {
  return {
    providerReferenceIdPrefix: "ref_tcgdex",
    providerAttributes: [
      { typeKey: "series", providerAttributeKey: "tcgdex-series-id" },
      { typeKey: "expansion", providerAttributeKey: "tcgdex-set-id" },
    ],
    targetRecordRuleKey: "expansion",
    referenceTypes: [
      {
        referenceTypeId: "ref_type_manufacturer",
        typeKey: "manufacturer",
        name: "Manufacturer",
        descriptionText: "A company responsible for publishing catalog products.",
        attributeKeys: ["homepage-url"],
      },
      {
        referenceTypeId: "ref_type_product_line",
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name"],
      },
      {
        referenceTypeId: "ref_type_series",
        typeKey: "series",
        name: "Series",
        descriptionText: "An official Pokemon TCG series that groups expansions.",
        attributeKeys: ["tcgdex-series-id"],
      },
      {
        referenceTypeId: "ref_type_expansion",
        typeKey: "expansion",
        name: "Expansion",
        descriptionText: "An official Pokemon TCG card expansion.",
        attributeKeys: ["tcgdex-set-id"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "manufacturer",
        typeKey: "manufacturer",
        recordId: { kind: "static", referenceRecordId: "ref_manufacturer_pokemon_company" },
        key: { kind: "static", value: "the-pokemon-company-international" },
        name: { kind: "static", value: "The Pokemon Company International" },
        description: { kind: "static", value: "Publisher of the English Pokemon Trading Card Game." },
        attributes: [{ attributeKey: "homepage-url", value: { kind: "static", value: "https://www.pokemon.com/us" } }],
        requiredPaths: [],
        relationships: [],
      },
      {
        ruleKey: "product-line",
        typeKey: "product-line",
        recordId: { kind: "static", referenceRecordId: "ref_product_line_pokemon_tcg" },
        key: { kind: "static", value: "pokemon-trading-card-game" },
        name: { kind: "static", value: "Pokemon Trading Card Game" },
        description: { kind: "static", value: "The Pokemon Trading Card Game product line." },
        attributes: [{ attributeKey: "official-name", value: { kind: "static", value: "Pokemon Trading Card Game" } }],
        requiredPaths: [],
        relationships: [{ relationshipType: "published-by", ruleKey: "manufacturer" }],
      },
      {
        ruleKey: "series",
        typeKey: "series",
        recordId: { kind: "provider", typeKey: "series", providerValuePaths: ["seriesId", "seriesName"] },
        key: { kind: "path", path: "seriesName" },
        name: { kind: "path", path: "seriesName" },
        description: {
          kind: "template",
          template: "{seriesName} Pokemon TCG series.",
          values: { seriesName: { kind: "path", path: "seriesName" } },
        },
        attributes: [{ attributeKey: "tcgdex-series-id", value: { kind: "path", path: "seriesId" }, optional: true }],
        requiredPaths: ["seriesName"],
        relationships: [{ relationshipType: "part-of", ruleKey: "product-line" }],
      },
      {
        ruleKey: "expansion",
        typeKey: "expansion",
        recordId: { kind: "provider", typeKey: "expansion", providerValuePaths: ["expansionId"] },
        key: { kind: "path", path: "expansionName" },
        name: { kind: "path", path: "expansionName" },
        description: {
          kind: "template",
          template: "{expansionName} Pokemon TCG expansion.",
          values: { expansionName: { kind: "path", path: "expansionName" } },
        },
        attributes: [{ attributeKey: "tcgdex-set-id", value: { kind: "path", path: "expansionId" }, optional: true }],
        requiredPaths: ["expansionName"],
        relationships: [{ relationshipType: "part-of", ruleKey: "series" }],
      },
    ],
  };
}

function referenceHierarchyContractsFixture(): JsonValue[] {
  return [
    {
      targetTypeKey: "expansion",
      providerAttributeKey: "tcgdex-set-id",
      referenceRecordKey: mappingExpression("expansionId", "external-reference", ["reference-hierarchy"]),
      parent: {
        targetTypeKey: "series",
        providerAttributeKey: "tcgdex-series-id",
        referenceRecordKey: mappingExpression("seriesId", "external-reference", ["reference-hierarchy"]),
        parent: {
          targetTypeKey: "product-line",
          providerAttributeKey: "official-name",
          referenceRecordKey: {
            selector: { kind: "constant", value: "Pokemon Trading Card Game" },
            owner: "catalog-truth",
            uses: ["reference-hierarchy"],
            redaction: "none",
          },
        },
      },
    },
  ];
}

function duplicatePreventionMappingFixture() {
  return {
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
    rules: [
      {
        ruleKey: "exact-external-catalog-item-reference",
        matchKind: "exact-external-catalog-item-reference",
        sourcePath: "externalCatalogItemReferences",
      },
      {
        ruleKey: "source-observation-link",
        matchKind: "source-observation-link",
        providerKeySource: "observation-provider",
        externalKey: "language-prefixed-observation-external-key",
      },
      {
        ruleKey: "pokemon-card-deterministic-fields",
        matchKind: "deterministic-pokemon-card-field-match",
        normalizedKind: "pokemon-card",
      },
    ],
  };
}

function duplicatePreventionContractFixture(): JsonValue {
  return {
    exactExternalCatalogItemReferencesFirst: true,
    mergeCandidateEvidence: [
      mappingExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"]),
      mappingExpression("externalCatalogItemReferences", "external-reference", ["external-reference"]),
    ],
    identityRules: [
      {
        ruleKey: "exact-external-catalog-item-reference",
        ruleKind: "exact-external-catalog-item-reference",
        evidence: [mappingExpression("externalCatalogItemReferences", "external-reference", ["external-reference"])],
        candidatePolicy: "reuse",
      },
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [mappingExpression("externalKey", "external-reference", ["external-reference"])],
        candidatePolicy: "reuse",
      },
      {
        ruleKey: "pokemon-card-deterministic-fields",
        ruleKind: "deterministic-field-match",
        evidence: [
          mappingExpression("set.name", "catalog-truth", ["merge-identity"]),
          mappingExpression("card.localId", "catalog-truth", ["merge-identity"]),
        ],
        candidatePolicy: "reuse",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
        samplePayload: { id: "fixture_1", tcgplayer_id: 14240 },
        samplePayloadAvailable: true,
      },
    ],
    dryRunInputTemplate: {
      observedAt: "1970-01-01T00:00:00.000Z",
      defaultFlow: "normal",
      payload: { id: "fixture_1", tcgplayer_id: 14240 },
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
          sectionKey: "normalized-observation",
          domainConcept: "Normalized Observation",
          severity: "error",
          activationImpact:
            "Summarizes whether replay/hash behavior changed and whether migration evidence is required.",
        },
        {
          path: "profile.capabilities",
          label: "Capabilities",
          candidate: ["source-observation-import", "external-reference-extraction"],
          active: ["source-observation-import"],
          changed: true,
          sectionKey: "profile-identity",
          domainConcept: "Profile Identity",
          severity: "warning",
          activationImpact: "Changes available import, reference extraction, and promotion workflows.",
        },
      ],
      sections: [
        {
          sectionKey: "normalized-observation",
          domainConcept: "Normalized Observation",
          status: "error",
          changes: [
            {
              path: "sourceMappingFingerprint",
              label: "Source Mapping Fingerprint",
              candidate: "candidate_fingerprint",
              active: "active_fingerprint",
              changed: true,
              sectionKey: "normalized-observation",
              domainConcept: "Normalized Observation",
              severity: "error",
              activationImpact:
                "Summarizes whether replay/hash behavior changed and whether migration evidence is required.",
            },
          ],
        },
        {
          sectionKey: "profile-identity",
          domainConcept: "Profile Identity",
          status: "warning",
          changes: [
            {
              path: "profile.capabilities",
              label: "Capabilities",
              candidate: ["source-observation-import", "external-reference-extraction"],
              active: ["source-observation-import"],
              changed: true,
              sectionKey: "profile-identity",
              domainConcept: "Profile Identity",
              severity: "warning",
              activationImpact: "Changes available import, reference extraction, and promotion workflows.",
            },
          ],
        },
      ],
    },
    activationReadiness: {
      status: "blocked",
      checks: [
        {
          checkKey: "migration-evidence",
          code: "migration-evidence-required",
          sectionKey: "migration-evidence",
          domainConcept: "Migration Evidence",
          status: "blocked",
          path: "migrationEvidence.evidenceText",
          diagnosticText: "Source Observation mapping fingerprint changes require explicit migration evidence.",
          severity: "error",
          remediation: "Record migration evidence before activation.",
          blockingBehavior: "Activation is blocked until migration evidence is recorded.",
        },
      ],
      groups: [
        {
          domainConcept: "Migration Evidence",
          status: "blocked",
          checks: [
            {
              checkKey: "migration-evidence",
              code: "migration-evidence-required",
              sectionKey: "migration-evidence",
              domainConcept: "Migration Evidence",
              status: "blocked",
              path: "migrationEvidence.evidenceText",
              diagnosticText: "Source Observation mapping fingerprint changes require explicit migration evidence.",
              severity: "error",
              remediation: "Record migration evidence before activation.",
              blockingBehavior: "Activation is blocked until migration evidence is recorded.",
            },
          ],
        },
      ],
      requiresMigrationEvidence: true,
      referenceCount: 0,
    },
    sectionSummaries: [
      {
        sectionKey: "normalized-observation",
        domainConcept: "Normalized Observation",
        editable: true,
        status: "error",
        diagnostics: [],
        semanticChanges: [
          {
            path: "sourceMappingFingerprint",
            label: "Source Mapping Fingerprint",
            candidate: "candidate_fingerprint",
            active: "active_fingerprint",
            changed: true,
            sectionKey: "normalized-observation",
            domainConcept: "Normalized Observation",
            severity: "error",
            activationImpact:
              "Summarizes whether replay/hash behavior changed and whether migration evidence is required.",
          },
        ],
        readinessChecks: [],
      },
      {
        sectionKey: "migration-evidence",
        domainConcept: "Migration Evidence",
        editable: true,
        status: "blocked",
        diagnostics: [],
        semanticChanges: [],
        readinessChecks: [
          {
            checkKey: "migration-evidence",
            code: "migration-evidence-required",
            sectionKey: "migration-evidence",
            domainConcept: "Migration Evidence",
            status: "blocked",
            path: "migrationEvidence.evidenceText",
            diagnosticText: "Source Observation mapping fingerprint changes require explicit migration evidence.",
            severity: "error",
            remediation: "Record migration evidence before activation.",
            blockingBehavior: "Activation is blocked until migration evidence is recorded.",
          },
        ],
      },
    ],
    selectedOptionSchema: null,
    promotionTargetSchema: null,
    ...overrides,
  };
}

function controlPlaneReadiness() {
  return {
    generatedAt: "2026-06-05T00:00:00.000Z",
    rolloutControls: {
      generatedAt: "2026-06-05T00:00:00.000Z",
      controls: [
        {
          controlId: "control-plane-read-only",
          owner: "catalog-source-observations",
          ownerIssue: 801,
          defaultState: "open",
          status: "open",
          severity: "info",
          capabilities: ["import", "promotion", "reapply", "activation"],
          providerKeys: [],
          profileKeys: [],
          unitKeys: [],
          message: "Catalog Integration Control Plane write workflows are open.",
          auditEventName: "rollout-control-evaluated",
          metricKey: "catalog.integration.rollout.control_plane_read_only",
        },
      ],
    },
    units: [
      {
        unitKey: "reference-cards:pokemon:single-card:source-observation-proof",
        providerKey: "reference-cards",
        displayName: "Reference Pokemon single-card Source Observation proof",
        productDomain: "pokemon",
        productForm: "single-card",
        ingestionPurpose: "source-observation-proof",
        profileVersion: "reference-proof-2026.06.05",
        semanticReadiness: "ready",
        credentialReadiness: "not-required",
        credentialReadinessState: "not-required",
        credentialRequirement: "not-required",
        credentialDiagnosticCode: null,
        transportReadiness: "ready",
        fixtureValidationStatus: "ready",
        dryRunStatus: "completed",
        observationFacts: 1,
        diagnosticCounts: { info: 1, warning: 0, error: 0 },
        diagnostics: [
          {
            code: "reference-fixture-transport-ready",
            severity: "info",
            message: "Reference fixture payloads are available.",
            unitKey: "reference-cards:pokemon:single-card:source-observation-proof",
            retryAfterSeconds: null,
            source: "provider-adapter",
          },
        ],
        latestDiagnosticText:
          "Reference provider uses fixture-backed payloads and does not require live provider transport.",
        dryRunEvidence: [
          {
            externalKey: "pokemon:abra-43",
            sourceUrl: "fixture://reference-cards/pokemon/abra-43.json",
            sourceHash: "sha256:reference-cards-abra-43",
            normalizedFacts: {
              name: "Abra",
              cardNumber: "43",
              expansionName: "Reference Proof",
              rarity: "Common",
            },
          },
        ],
      },
    ],
  };
}

function controlPlaneOverview() {
  const readiness = controlPlaneReadiness();

  return {
    generatedAt: readiness.generatedAt,
    readiness,
    unitActivity: {
      generatedAt: readiness.generatedAt,
      units: [
        {
          unitKey: "reference-cards:pokemon:single-card:source-observation-proof",
          recentJobs: [
            {
              jobId: "job_reference_import",
              action: "import",
              operatorStatus: "running",
              phase: "processing",
              completed: 1,
              total: 2,
              providerKey: "reference-cards",
              profileVersion: "reference-proof-2026.06.05",
              startedAt: "2026-06-05T00:01:00.000Z",
              createdAt: "2026-06-05T00:00:30.000Z",
              summary: "import job job_reference_import is running (1/2).",
            },
          ],
        },
      ],
    },
    providerReadiness: {
      generatedAt: readiness.generatedAt,
      providers: [
        {
          providerKey: "reference-cards",
          adapterKey: "reference-cards",
          readiness: "ready",
          credentialReadiness: "not-required",
          credentialReadinessState: "not-required",
          credentialRequirement: "not-required",
          unitKeys: ["reference-cards:pokemon:single-card:source-observation-proof"],
          apiReachability: {
            status: "unknown",
            diagnosticCodes: [],
            message: null,
          },
          optionQueryHealth: {
            status: "unknown",
            diagnosticCodes: [],
            message: null,
          },
          rateLimitStatus: {
            status: "unknown",
            diagnosticCodes: [],
            message: null,
          },
          payloadAcquisition: {
            status: "ready",
            diagnosticCodes: ["reference-fixture-transport-ready"],
            message: "Reference fixture payloads are available.",
          },
          diagnostics: readiness.units[0].diagnostics,
        },
      ],
    },
    auditLifecycle: {
      generatedAt: readiness.generatedAt,
      projectionStatus: "partial",
      statusMessage:
        "Lifecycle audit is assembled from current profile and active job metadata until the append-only audit projection is available.",
      entries: [
        {
          eventId: "profile-created:reference-cards:reference-proof-2026.06.05",
          occurredAt: "2026-06-05T00:00:00.000Z",
          eventName: "profile-created",
          category: "profile",
          providerKey: "reference-cards",
          unitKey: "reference-cards:pokemon:single-card:source-observation-proof",
          profileVersion: "reference-proof-2026.06.05",
          actorUserId: "usr_test",
          relatedJobId: null,
          summary: "Reference profile was created.",
          diagnosticCodes: [],
        },
      ],
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
