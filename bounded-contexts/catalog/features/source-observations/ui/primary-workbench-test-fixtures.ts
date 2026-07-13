import { t } from "@chase-sets/localization";
import type { ListResponse } from "@chase-sets/http/responses";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogMergeCandidateListItem,
  CatalogIntegrationRecentJobSummary,
  CatalogProviderProfileAuthoringModel,
  CatalogProviderSourceOptionKind,
  CatalogProviderProfileVersionReview,
  SourceObservationListItem,
  SourceObservationIntegrationScope,
} from "./contracts";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "./primary-workbench-read-model";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../api/tcgdex-executable-mapping-contract";
import {
  scrydexOnePieceCardPrintProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  type CatalogProviderIntegrationProfile,
} from "../api/provider-integration-profiles";

export function sourceObservationScope(
  overrides: Partial<SourceObservationIntegrationScope> = {},
): SourceObservationIntegrationScope {
  return {
    provider_key: "tcgdex",
    language_code: "en",
    expansion_id: "base1",
    expansion_name: "Base Set",
    series_id: "base",
    series_name: "Base",
    product_line_id: "3",
    product_line_name: "Pokemon",
    total_observations: 142,
    observed_observations: 100,
    changed_observations: 24,
    promoted_observations: 16,
    rejected_observations: 2,
    first_observed_at: "2026-06-09T00:00:00.000Z",
    latest_observed_at: "2026-06-09T01:00:00.000Z",
    latest_source_updated_at: "2026-06-09T00:30:00.000Z",
    ...overrides,
  };
}

type PrimaryWorkbenchLoaderData = Readonly<{
  data: ListResponse<SourceObservationIntegrationScope>;
  query: Readonly<Record<string, unknown>>;
  profileReviews: ListResponse<CatalogProviderProfileVersionReview>;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  requestUrl: string;
  readModel: ReturnType<typeof buildCatalogPrimaryWorkbenchReadModelForSurface>;
  [key: string]: unknown;
}>;

export function loaderData(overrides: Partial<PrimaryWorkbenchLoaderData> = {}): PrimaryWorkbenchLoaderData {
  const data = overrides.data ?? { items: [sourceObservationScope()], total: 1, count: 1 };
  const profileReviews = overrides.profileReviews ?? {
    items: [profileReview({ active: true, lifecycle: "active" })],
    total: 1,
    count: 1,
  };
  const controlPlaneOverview = overrides.controlPlaneOverview ?? null;
  const requestUrl = overrides.requestUrl ?? "https://admin.example/catalog/integrations?providerKey=tcgdex";
  const readModel =
    overrides.readModel ??
    buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl,
      scopes: data,
      profileReviews,
      controlPlaneOverview,
      canManageCatalog: true,
    });

  return {
    data,
    query: {},
    profileReviews,
    controlPlaneOverview,
    requestUrl,
    readModel,
    ...overrides,
  };
}

export function tcgplayerSourceOptionKinds(input: { legacyParentMetadata?: boolean } = {}) {
  const legacy = input.legacyParentMetadata ?? false;

  return [
    {
      queryKind: "product-lines",
      queryKeySynonyms: ["productLineId"],
      displayName: "Product Line",
      scope: "product-line/category",
      parentScope: null,
      parentRequired: false,
      parentValueKind: null,
      parentDiagnosticText: null,
    },
    {
      queryKind: "set-names",
      queryKeySynonyms: ["setName"],
      displayName: "Set Name",
      scope: "set-name",
      parentScope: legacy ? null : "product-line/category",
      parentRequired: true,
      parentValueKind: legacy ? null : "product-line-id",
      parentDiagnosticText: legacy ? null : "Select Product Line before Set Name.",
    },
  ] as const;
}

export function profileReview(
  overrides: Partial<CatalogProviderProfileVersionReview> = {},
): CatalogProviderProfileVersionReview {
  const providerKey = overrides.providerKey ?? "tcgdex";

  return {
    providerKey,
    profileKey: "tcgdex-pokemon-card",
    profileVersion: "2026.06.04",
    ingestionUnitKey: ingestionUnitKeyForProvider(providerKey),
    displayName: "TCGdex Pokemon cards",
    lifecycle: "test",
    active: false,
    status: "planned",
    connectorKind: "tcgdex-json",
    profile: {
      providerKey: "tcgdex",
      supportedScopes: ["pokemon/card"],
    },
    sourceContract: {
      owner: "chase-sets/catalog",
      repository: "chase-sets/chase-sets",
      commit: null,
      documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
      fixtureSetVersion: "tcgdex-proof-v1",
    },
    fixtures: {
      fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex",
      coveredFlows: ["normal", "changed", "replay"],
      liveProviderCallsAllowed: false,
    },
    retirementPlan: null,
    executableMappingContract: {},
    referenceCount: 0,
    capabilities: ["provider-option-query", "source-observation-import", "promotion-command-plan"],
    supportedScopes: ["pokemon/card"],
    languageOptions: ["en"],
    sourceOptionKinds: sourceOptionKindsForProvider(providerKey),
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

function ingestionUnitKeyForProvider(providerKey: string): string {
  if (providerKey === "tcgplayer") {
    return "tcgplayer:pokemon:single-card:source-observation-import";
  }
  if (providerKey === "scrydex") {
    return "scrydex:one-piece:single-card:source-observation-import";
  }

  return "tcgdex:pokemon:card:import";
}

function sourceOptionKindsForProvider(providerKey: string): CatalogProviderSourceOptionKind[] {
  const profile = {
    scrydex: scrydexOnePieceCardPrintProviderProfile,
    tcgdex: tcgdexPokemonTcgProviderProfile,
    tcgplayer: tcgplayerAutomationClientProviderProfile,
  }[providerKey] as CatalogProviderIntegrationProfile | undefined;

  return (profile ?? tcgdexPokemonTcgProviderProfile).optionQueries.map((query) => ({
    queryKind: query.queryKind,
    queryKeySynonyms: [...sourceOptionQueryKeySynonyms(query)],
    displayName: query.displayName,
    scope: query.scope,
    parentScope: query.parentScope,
    parentRequired: sourceOptionQueryParentValue(query)?.required ?? false,
    parentValueKind: sourceOptionQueryParentValue(query)?.valueKind ?? null,
    parentDiagnosticText: sourceOptionQueryParentValue(query)?.diagnosticText ?? null,
  }));
}

function sourceOptionQueryKeySynonyms(
  query: CatalogProviderIntegrationProfile["optionQueries"][number],
): readonly string[] {
  return "queryKeySynonyms" in query ? (query.queryKeySynonyms ?? []) : [];
}

function sourceOptionQueryParentValue(
  query: CatalogProviderIntegrationProfile["optionQueries"][number],
): Readonly<{ required: boolean; valueKind: string; diagnosticText: string }> | null {
  return "parentValue" in query ? (query.parentValue ?? null) : null;
}

export function profileAuthoringModel(
  overrides: Partial<CatalogProviderProfileAuthoringModel> = {},
): CatalogProviderProfileAuthoringModel {
  const review =
    overrides.review ?? profileReview({ executableMappingContract: tcgdexPokemonCardSourceObservationMappingContract });

  return {
    review,
    editableSections: [],
    sectionSummaries: [],
    fixtureCases: [
      {
        flow: "normal",
        payloadFile: "normal.json",
        payloadPath: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex/normal.json",
        expectedStatus: "completed",
        expectedDiagnosticPaths: [],
        expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
        expectedMergeEvidencePaths: ["duplicatePrevention.mergeCandidateEvidence.0"],
        expectedPromotionCommands: [
          "CreateCatalogItem",
          "AssignBlueprintToCatalogItem",
          "SetCatalogItemFieldValue",
          "AssignCatalogItemToCategory",
          "LinkExternalCatalogItemReference",
        ],
        expectedObservation: {
          externalKey: "en:sv01-001",
          normalizedKind: "pokemon-card",
          normalizedFields: {
            name: "Sprigatito",
            cardNumber: "001",
          },
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:493958" }],
        },
        samplePayload: { id: "sv01-001", card: { name: "Sprigatito", localId: "001" } },
        samplePayloadAvailable: true,
      },
      {
        flow: "unknown-option",
        payloadFile: "unknown-option.json",
        payloadPath:
          "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex/unknown-option.json",
        expectedStatus: "completed",
        expectedDiagnosticPaths: ["selectedOptions.dimensions.0.optionKey"],
        expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
        expectedMergeEvidencePaths: ["duplicatePrevention.mergeCandidateEvidence.0"],
        expectedPromotionCommands: ["CreateCatalogItem"],
        expectedObservation: {
          externalKey: "en:sv01-001-unknown-option",
          normalizedKind: "pokemon-card",
          normalizedFields: {
            cardVariantKey: "provider-new-foil",
          },
        },
        samplePayload: { id: "sv01-001-unknown-option", card: { name: "Sprigatito", localId: "001" } },
        samplePayloadAvailable: true,
      },
    ],
    dryRunInputTemplate: {
      observedAt: "2026-06-09T00:00:00.000Z",
      defaultFlow: "normal",
      payload: { id: "sv01-001", card: { name: "Sprigatito", localId: "001" } },
      fixturePayloads: [],
    },
    semanticDiff: {
      providerKey: review.providerKey,
      candidateProfileVersion: review.profileVersion,
      activeProfileVersion: "2026.06.03",
      mappingFingerprint: {
        candidate: "sha256:candidate-mapping",
        active: "sha256:active-mapping",
        changed: true,
      },
      changes: [
        {
          sectionKey: "normalized-observation",
          domainConcept: "Normalized Observation",
          path: "executableMappingContract.normalizedObservation.fields.cardVariantKey",
          label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.cardVariantKey"),
          candidate: "variant.key",
          active: "previous.variant",
          changed: true,
          severity: "warning",
          activationImpact: "Changes the card variant merge identity.",
        },
      ],
      sections: [
        {
          sectionKey: "normalized-observation",
          domainConcept: "Normalized Observation",
          status: "warning",
          changes: [
            {
              sectionKey: "normalized-observation",
              domainConcept: "Normalized Observation",
              path: "executableMappingContract.normalizedObservation.fields.cardVariantKey",
              label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.cardVariantKey"),
              candidate: "variant.key",
              active: "previous.variant",
              changed: true,
              severity: "warning",
              activationImpact: "Changes the card variant merge identity.",
            },
          ],
        },
        {
          sectionKey: "promotion-plan",
          domainConcept: "Promotion Plan",
          status: "valid",
          changes: [],
        },
      ],
    },
    activationReadiness: {
      status: "ready",
      checks: [
        {
          checkKey: "activation-fixture-covered-flow:normal",
          code: "activation-fixture-covered-flow",
          sectionKey: "fixture-contract",
          domainConcept: "Fixture Coverage",
          status: "passed",
          path: "fixtures.coveredFlows.normal",
          diagnosticText: "Profile fixture contract covers normal.",
          severity: "warning",
          remediation: "No remediation required.",
          blockingBehavior: "allow",
          flow: "normal",
        },
      ],
      groups: [
        {
          domainConcept: "Fixture Coverage",
          status: "ready",
          checks: [
            {
              checkKey: "activation-fixture-covered-flow:normal",
              code: "activation-fixture-covered-flow",
              sectionKey: "fixture-contract",
              domainConcept: "Fixture Coverage",
              status: "passed",
              path: "fixtures.coveredFlows.normal",
              diagnosticText: "Profile fixture contract covers normal.",
              severity: "warning",
              remediation: "No remediation required.",
              blockingBehavior: "allow",
              flow: "normal",
            },
          ],
        },
      ],
      requiresMigrationEvidence: true,
      referenceCount: 2,
    },
    selectedOptionSchema: null,
    promotionTargetSchema: null,
    ...overrides,
  };
}

export function controlPlaneOverview(
  overrides: Partial<CatalogIntegrationControlPlaneOverview> = {},
): CatalogIntegrationControlPlaneOverview {
  const generatedAt = "2026-06-09T01:05:00.000Z";
  const unitKey = "tcgdex:pokemon:card:import";

  return {
    generatedAt,
    readiness: {
      generatedAt,
      rolloutControls: {
        generatedAt,
        controls: [],
      },
      units: [
        {
          unitKey,
          providerKey: "tcgdex",
          displayName: "TCGdex Pokemon cards",
          productDomain: "pokemon",
          productForm: "card",
          ingestionPurpose: "import",
          profileVersion: "2026.06.04",
          semanticReadiness: "ready",
          credentialReadiness: "not-required",
          credentialReadinessState: "not-required",
          credentialRequirement: "not-required",
          credentialDiagnosticCode: null,
          transportReadiness: "ready",
          fixtureValidationStatus: "ready",
          dryRunStatus: "completed",
          observationFacts: 24,
          diagnosticCounts: {
            info: 0,
            warning: 0,
            error: 0,
          },
          diagnostics: [],
          latestDiagnosticText: null,
          dryRunEvidence: [],
        },
      ],
    },
    unitActivity: {
      generatedAt,
      units: [
        {
          unitKey,
          recentJobs: [integrationJobSummary()],
        },
      ],
    },
    providerReadiness: {
      generatedAt,
      providers: [
        {
          providerKey: "tcgdex",
          adapterKey: "tcgdex",
          readiness: "ready",
          credentialReadiness: "not-required",
          credentialReadinessState: "not-required",
          credentialRequirement: "not-required",
          unitKeys: [unitKey],
          apiReachability: {
            status: "ready",
            diagnosticCodes: [],
            message: null,
          },
          optionQueryHealth: {
            status: "ready",
            diagnosticCodes: [],
            message: null,
          },
          rateLimitStatus: {
            status: "ready",
            diagnosticCodes: [],
            message: null,
          },
          payloadAcquisition: {
            status: "ready",
            diagnosticCodes: [],
            message: null,
          },
          usageBudget: null,
          diagnostics: [],
        },
      ],
    },
    auditLifecycle: {
      generatedAt,
      projectionStatus: "partial",
      statusMessage: "audit lifecycle projection is partial",
      entries: [],
    },
    ...overrides,
  };
}

export function integrationJobSummary(
  overrides: Partial<CatalogIntegrationRecentJobSummary> = {},
): CatalogIntegrationRecentJobSummary {
  return {
    jobId: "job_001",
    action: "import",
    operatorStatus: "running",
    phase: "processing",
    completed: 7,
    total: 24,
    unitKey: "tcgdex:pokemon:card:import",
    providerKey: "tcgdex",
    importScope: "en:3:base:base1",
    profileVersion: "2026.06.04",
    profileSnapshot: {
      schemaVersion: "catalog-provider-profile-version-v1",
      compatibilityPolicy: "provider-profile-version",
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
      lifecycle: "active",
      active: true,
      connectorKind: "tcgdex-json",
      connectorSourceVersion: null,
      sourceMappingFingerprint: "sha256:mapping",
    },
    reapplyProfileMode: null,
    result: null,
    startedAt: "2026-06-09T01:00:00.000Z",
    createdAt: "2026-06-09T00:59:00.000Z",
    summary: t("catalog.features.sourceObservations.api.adminControlPlaneOverview.job.summary", {
      action: "import",
      jobId: "job_001",
      operatorStatus: "running",
      completed: 7,
      total: 24,
    }),
    ...overrides,
  };
}

export function sourceObservationListItem(
  overrides: Partial<SourceObservationListItem> = {},
): SourceObservationListItem {
  return {
    observation_id: "obs_001",
    provider_key: "tcgdex",
    external_key: "base1-4",
    source_url: "https://api.tcgdex.example/cards/base1-4",
    language_code: "en",
    source_record_hash: "sha256:source-record",
    source_updated_at: "2026-06-09T00:30:00.000Z",
    observed_at: "2026-06-09T01:00:00.000Z",
    source_profile_key: "tcgdex-pokemon-card",
    source_profile_version: "2026.06.04",
    source_mapping_fingerprint: "sha256:mapping",
    normalized: {
      kind: "pokemon-card",
      tcg: "pokemon",
      languageCode: "en",
      name: "Charizard",
      cardNumber: "4",
      setId: "base1",
      setName: "Base Set",
      expansionId: "base1",
      expansionName: "Base Set",
      expansionAbbreviation: "BS",
      expansionCardCount: 102,
      expansionParallelSetCardCount: null,
      seriesId: "base",
      seriesName: "Base",
      rarity: "Rare Holo",
      illustrator: "Mitsuhiro Arita",
      releaseDate: "1999-01-09",
      releaseYear: 1999,
      category: "Pokemon",
      imageBaseUrl: "https://images.tcgdex.example/base1/4",
      imageUrls: ["https://images.tcgdex.example/base1/4/high.png"],
      productAssetSet: null,
      parallelSet: false,
      cardVariantKey: "standard",
      cardVariantLabel: "Standard",
      cardVariantSourceKey: null,
      cardVariantIsPrimaryImage: true,
      imageDisclaimer: "Provider image URL is review evidence.",
      variants: {},
      mergeIdentity: {
        tcg: "pokemon",
        productLineName: "Pokemon",
        setName: "Base Set",
        printedProductName: "Charizard",
        collectorNumber: "4",
        languageCode: "en",
      },
      externalCatalogItemReferences: [{ providerKey: "tcgdex", externalKey: "base1-4" }],
    },
    status: "changed",
    status_reason: null,
    promoted_catalog_item_id: null,
    promoted_reference_record_id: null,
    promoted_at: null,
    promotion_profile_key: null,
    promotion_profile_version: null,
    promotion_plan_fingerprint: null,
    updated_at: "2026-06-09T01:01:00.000Z",
    ...overrides,
  };
}

export function catalogMergeCandidateListItem(
  overrides: Partial<CatalogMergeCandidateListItem> = {},
): CatalogMergeCandidateListItem {
  return {
    candidate_id: "cand_pokemon_base1_004_standard",
    identity_fingerprint: "sha256:candidate-identity",
    sync_run_ids_json: ["sync_001"],
    status: "ready",
    status_reason: null,
    identity_json: {
      scopeRecordId: "scope_pokemon_base_set",
      tcg: "pokemon",
      productLineName: "Pokemon",
      setName: "Base Set",
      printedProductName: "Charizard",
      collectorNumber: "4",
      languageCode: "en",
      productForm: "card",
      variantKey: "standard",
      barcode: null,
    },
    matched_catalog_item_id: null,
    matched_product_ids_json: [],
    proposed_catalog_item_facts_json: {
      name: "Charizard",
      cardNumber: "4",
      rarity: "Rare Holo",
      setName: "Base Set",
    },
    proposed_external_catalog_item_references_json: [{ providerKey: "tcgdex", externalKey: "base1-4" }],
    proposed_external_product_references_json: [
      {
        providerKey: "tcgplayer",
        externalKey: "sku:123",
        selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        reviewEvidence: { source: "tcgplayer-sku" },
      },
    ],
    conflicts_json: [],
    warnings_json: [],
    field_provenance_json: [
      {
        fieldPath: "name",
        value: "Charizard",
        observationId: "obs_001",
        providerKey: "tcgdex",
        sourceProfileKey: "tcgdex-pokemon-card",
        sourceProfileVersion: "2026.06.04",
        confidence: "exact",
        evidence: { path: "card.name" },
      },
      {
        fieldPath: "cardNumber",
        value: "4",
        observationId: "obs_tcgplayer_001",
        providerKey: "tcgplayer",
        sourceProfileKey: "tcgplayer-pokemon-card",
        sourceProfileVersion: "2026.06.04",
        confidence: "high",
        evidence: { path: "product.number" },
      },
    ],
    membership_json: [
      {
        observationId: "obs_001",
        syncRunId: "sync_001",
        providerKey: "tcgdex",
        externalKey: "base1-4",
        sourceRecordHash: "sha256:source-record",
        sourceProfileKey: "tcgdex-pokemon-card",
        sourceProfileVersion: "2026.06.04",
        sourceMappingFingerprint: "sha256:mapping",
        observedAt: "2026-06-09T01:00:00.000Z",
        addedAt: "2026-06-09T01:02:00.000Z",
      },
      {
        observationId: "obs_tcgplayer_001",
        syncRunId: "sync_001",
        providerKey: "tcgplayer",
        externalKey: "sku:123",
        sourceRecordHash: "sha256:tcgplayer-source-record",
        sourceProfileKey: "tcgplayer-pokemon-card",
        sourceProfileVersion: "2026.06.04",
        sourceMappingFingerprint: "sha256:tcgplayer-mapping",
        observedAt: "2026-06-09T01:00:00.000Z",
        addedAt: "2026-06-09T01:02:00.000Z",
      },
    ],
    promotion_intent: "create-catalog-item",
    created_at: "2026-06-09T01:02:00.000Z",
    updated_at: "2026-06-09T01:03:00.000Z",
    stale_at: null,
    observation_count: 2,
    ...overrides,
  };
}
