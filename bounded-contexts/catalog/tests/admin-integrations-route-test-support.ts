import { action } from "../routes/admin/integrations";
import { action as providerSetupAction } from "../routes/admin/integrations-providers";
import { action as governanceAction } from "../routes/admin/integrations-governance";
import type { CatalogIntegrationsCommandResult } from "../support/route-support/admin-integrations/integrations-command-result";
import { profileReview } from "../features/source-observations/ui/primary-workbench-test-fixtures";
import type {
  CatalogIntegrationControlPlaneUnitReadiness,
  CatalogProviderProfileVersionReview,
  CatalogProviderSourceOptionKind,
} from "../features/source-observations/ui/contracts";

export function tcgplayerReadinessUnit(
  unitKey: string,
  displayNameProduct: string,
  productDomain: string,
): CatalogIntegrationControlPlaneUnitReadiness {
  return {
    unitKey,
    providerKey: "tcgplayer",
    displayName: `TCGplayer ${displayNameProduct} Single Cards`,
    productDomain,
    productForm: "single-card",
    ingestionPurpose: "source-observation-import",
    profileVersion: "2026.06.20",
    semanticReadiness: "ready",
    credentialReadiness: "ready",
    credentialReadinessState: "configured",
    credentialRequirement: "required",
    credentialDiagnosticCode: null,
    transportReadiness: "ready",
    fixtureValidationStatus: "ready",
    dryRunStatus: "completed",
    observationFacts: 0,
    diagnosticCounts: { info: 0, warning: 0, error: 0 },
    diagnostics: [],
    latestDiagnosticText: null,
    dryRunEvidence: [],
  };
}

export function aliasReviewReadModel() {
  return {
    schemaVersion: "catalog-alias-review-v1" as const,
    generatedAt: "2026-06-16T00:00:00.000Z",
    filter: {
      providerKey: "tcgdex",
      sourceProfileVersion: "2026.06.04",
      aliasType: null,
      reviewStatuses: [],
      observationId: null,
    },
    counts: {
      total: 1,
      pending: 1,
      accepted: 0,
      autoAccepted: 0,
      rejected: 0,
      revoked: 0,
      needsReview: 1,
      autoAcceptEligible: 0,
      warned: 0,
    },
    candidates: [],
    groups: [],
    coverage: {
      cardsWithAcceptedEnglishAlias: 0,
      cardsWithOnlySpeciesAliases: 0,
      cardsNeedingReview: 0,
      expansionsAndSeriesNeedingReview: 0,
      cards: [],
      referenceScopes: [],
    },
  };
}

export function tcgplayerYugiohSourceOptionKinds(): CatalogProviderSourceOptionKind[] {
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
      parentScope: "product-line/category",
      parentRequired: true,
      parentValueKind: "product-line-id",
      parentDiagnosticText: "Select Product Line before Set Name.",
    },
  ];
}

export function tcgplayerYugiohProfileReview(
  ingestionUnitKey: string,
  overrides: Partial<CatalogProviderProfileVersionReview> = {},
): CatalogProviderProfileVersionReview {
  return profileReview({
    providerKey: "tcgplayer",
    profileKey: "yugioh-single-card-product-sku",
    profileVersion: "2026.06.20",
    ingestionUnitKey,
    displayName: "TCGplayer Yu-Gi-Oh Single Cards",
    lifecycle: "active",
    active: true,
    status: "active",
    connectorKind: "tcgplayer-automation-client",
    profile: {
      providerKey: "tcgplayer",
      supportedScopes: ["product-line/category", "set-name"],
    },
    supportedScopes: ["product-line/category", "set-name"],
    languageOptions: ["en"],
    sourceOptionKinds: tcgplayerYugiohSourceOptionKinds(),
    ...overrides,
  });
}

export function scrydexOnePieceProfileReview(unitKey: string) {
  return profileReview({
    providerKey: "scrydex",
    profileKey: "scrydex-one-piece-card",
    profileVersion: "2026.06.22",
    ingestionUnitKey: unitKey,
    displayName: "Scrydex One Piece Cards",
    lifecycle: "active",
    active: true,
    status: "active",
    connectorKind: "scrydex-json",
    profile: {
      providerKey: "scrydex",
      supportedScopes: ["set-name", "product/card"],
    },
    supportedScopes: ["set-name", "product/card"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["set"],
        displayName: "Set",
        scope: "set-name",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
    ],
  });
}

export function scrydexLorcanaProfileReview(unitKey: string) {
  return profileReview({
    providerKey: "scrydex",
    profileKey: "lorcana-card-print-source-observation",
    profileVersion: "2026.06.23",
    ingestionUnitKey: unitKey,
    displayName: "Scrydex Lorcana Cards",
    lifecycle: "active",
    active: true,
    status: "active",
    connectorKind: "scrydex-json",
    profile: {
      providerKey: "scrydex",
      supportedScopes: ["set-name", "lorcana/single-card"],
    },
    supportedScopes: ["set-name", "lorcana/single-card"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["set"],
        displayName: "Set",
        scope: "set-name",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
      {
        queryKind: "cards",
        queryKeySynonyms: ["card"],
        displayName: "Card",
        scope: "product/card",
        parentScope: "set-name",
        parentRequired: true,
        parentValueKind: "set-id",
        parentDiagnosticText: "Scrydex Lorcana card option queries require a selected set.",
      },
    ],
  });
}

export function lorcastLorcanaProfileReview(unitKey: string) {
  return profileReview({
    providerKey: "lorcast",
    profileKey: "lorcast-lorcana-card-reference",
    profileVersion: "2026.06.23",
    ingestionUnitKey: unitKey,
    displayName: "Lorcast Lorcana single-card reference data",
    lifecycle: "active",
    active: true,
    status: "active",
    connectorKind: "lorcast-json",
    profile: {
      providerKey: "lorcast",
      supportedScopes: ["set-name", "lorcana/single-card"],
    },
    supportedScopes: ["set-name", "lorcana/single-card"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["set"],
        displayName: "Set",
        scope: "set-name",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
    ],
  });
}

export function scrydexOnePieceImportPreview(unitKey: string) {
  return {
    action: "import" as const,
    providerKey: "scrydex",
    scope: {
      provider: "scrydex",
      ingestionUnitKey: unitKey,
      language: "en",
      setName: "OP16",
    },
    profileSnapshot: null,
    targetCount: 1,
    targets: [
      {
        targetId: "set:OP16",
        name: "OP16",
        languageCode: "en",
        scopeKey: "expansion-cards",
        planKey: "scrydex:one-piece:expansion:op16:cards",
        estimatedPayloads: null,
        transportSteps: ["Fetch Scrydex One Piece expansion cards with max page size"],
        usageEstimate: {
          requestStrategy: "bulk-first" as const,
          estimateState: "estimate-unavailable" as const,
          estimatedRequestCount: null,
          estimateReason: "Card page count is available only after the first Scrydex paged response.",
          pageSize: 250,
          selectedFields: ["id", "name", "number", "expansion"],
          perRecordFallbackReason: null,
          usageCheckState: "not-configured" as const,
          creditDiagnostic: "Scrydex usage endpoint is not configured for this environment.",
          degradedDiagnostic: null,
        },
      },
    ],
  };
}

export function scrydexLorcanaImportPreview(unitKey: string) {
  return {
    action: "import" as const,
    providerKey: "scrydex",
    scope: {
      provider: "scrydex",
      ingestionUnitKey: unitKey,
      language: "en",
      setId: "TFC",
    },
    profileSnapshot: null,
    targetCount: 1,
    targets: [
      {
        targetId: "set:TFC",
        name: "The First Chapter",
        languageCode: "en",
        scopeKey: "expansion-cards",
        planKey: "scrydex:lorcana:expansion:tfc:cards",
        estimatedPayloads: null,
        transportSteps: ["Fetch Scrydex Lorcana expansion cards with max page size"],
        usageEstimate: {
          requestStrategy: "bulk-first" as const,
          estimateState: "estimate-unavailable" as const,
          estimatedRequestCount: null,
          estimateReason: "Card page count is available only after the first Scrydex paged response.",
          pageSize: 250,
          selectedFields: ["id", "name", "number", "expansion"],
          perRecordFallbackReason: null,
          usageCheckState: "not-configured" as const,
          creditDiagnostic: "Scrydex usage endpoint is not configured for this environment.",
          degradedDiagnostic: null,
        },
      },
    ],
  };
}

export function sourceOptionResponse(
  queryKind: string,
  input: Readonly<{
    status: "fresh" | "stale";
    source: "cache" | "live";
    parentValue: string | null;
    degraded: boolean;
    value?: string;
    label?: string;
    metadata?: Record<string, string>;
  }>,
) {
  const value =
    input.value ??
    (queryKind === "languages"
      ? "en"
      : queryKind === "series"
        ? "base"
        : queryKind === "expansions"
          ? "base1"
          : "option");
  const label =
    input.label ??
    (queryKind === "languages"
      ? "English"
      : queryKind === "series"
        ? "Base"
        : queryKind === "expansions"
          ? "Base Set"
          : "Option");

  return {
    items: [
      {
        providerKey: "tcgdex",
        queryKind,
        value,
        label,
        description: null,
        parentValue: input.parentValue,
        imageUrl: null,
        metadata: input.metadata ?? {},
      },
    ],
    total: 1,
    count: 1,
    page: {
      cursor: null,
      nextCursor: null,
      limit: 25,
      hasMore: false,
    },
    cache: {
      status: input.status,
      source: input.source,
      cacheKey: `sha256:${queryKind}`,
      fetchedAt: "2026-06-09T00:00:00.000Z",
      expiresAt: "2026-06-09T00:15:00.000Z",
      staleUntil: "2026-06-10T00:00:00.000Z",
      cacheOnly: true,
      forceRefresh: false,
      degraded: input.degraded,
      diagnostics: input.degraded
        ? [
            {
              code: "provider-option-query-stale-cache-used",
              severity: "warning",
              message: "Provider option query used stale cache.",
              retryAfterSeconds: null,
            },
          ]
        : [],
    },
  };
}

export function lifecycleConfirmationValue(intent: string, providerKey: string, profileVersion: string): string {
  return `confirm:${intent}:${providerKey}:${profileVersion}`;
}

export function actionRequest(body: Record<string, string>, url: string) {
  return {
    request: new Request(url, { method: "POST", body: new URLSearchParams(body) }),
    params: {},
    context: {},
  } as Parameters<typeof action>[0];
}

// The daily surface action stays put and returns its command result as data. The
// daily-command tests assert on that structured result (feedback + context).
export async function runDailyAction(
  body: Record<string, string>,
  url = "https://admin.example/catalog/integrations",
): Promise<CatalogIntegrationsCommandResult> {
  const result = await action(actionRequest(body, url));
  if (result instanceof Response) {
    throw new Error(`Daily command unexpectedly redirected to ${result.headers.get("Location") ?? "(none)"}`);
  }
  return result;
}

export async function runDailyActionRedirect(
  body: Record<string, string>,
  url = "https://admin.example/catalog/integrations",
): Promise<Response> {
  const result = await action(actionRequest(body, url));
  if (!(result instanceof Response)) {
    throw new Error(`Daily command unexpectedly stayed on-page with ${JSON.stringify(result.feedback)}`);
  }
  return result;
}

export function redirectLocation(response: Response): URL {
  const location = response.headers.get("Location");
  if (!location) {
    throw new Error("Expected redirect response to include a Location header.");
  }

  return new URL(location, "https://admin.example");
}

// The provider-setup and governance surfaces own a redirect after their commands;
// those tests assert on the redirect Response the surface decides from the result.
export async function runProviderSetupAction(
  body: Record<string, string>,
  url = "https://admin.example/catalog/integrations/providers",
): Promise<Response> {
  return providerSetupAction(actionRequest(body, url) as Parameters<typeof providerSetupAction>[0]);
}

export async function runGovernanceAction(
  body: Record<string, string>,
  url = "https://admin.example/catalog/integrations/governance",
): Promise<Response> {
  return governanceAction(actionRequest(body, url) as Parameters<typeof governanceAction>[0]);
}
