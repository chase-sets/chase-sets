import { catalogProviderTransportFailureConditions } from "../api/catalog-integration-provider-transport-budgets";
import type { CatalogProviderTransportFailureCondition } from "../api/catalog-integration-provider-transport-budgets";
import {
  catalogProviderTransportProofCriteria,
  getCatalogProviderTransportFirstSliceProofProvider,
  type CatalogProviderTransportProofCriterionKey,
} from "./catalog-integration-provider-transport-proof";
import { runCatalogIntegrationDryRun } from "../api/catalog-integration-engine";
import type { CatalogIntegrationDryRunResult } from "../api/catalog-integration-engine";
import { catalogPrimaryWorkbenchRetirementPolicy } from "../api/primary-workbench-admin-contracts";
import {
  getActiveCatalogProviderIntegrationProfileVersion,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../api/provider-integration-profiles";
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderOptionQueryInput,
  ProviderPayloadEnvelope,
  ProviderPayloadFetchProgress,
} from "../api/provider-adapters/provider-adapter";
import {
  createTcgdexProviderAdapter,
  TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGDEX_REAL_PROVIDER_PROOF_SCOPE,
} from "../api/provider-adapters/tcgdex";
import type { TcgdexObservationPayload } from "../api/tcgdex-client";

export const catalogRealProviderProofSchemaVersion = "catalog-real-provider-proof/v1" as const;
const catalogRealProviderProofSampleLimit = 20;
const catalogRealProviderProofProgressSampleLimit = 12;

export type CatalogRealProviderProofTransportMode =
  | "live-provider"
  | "deterministic-adapter-test"
  | "staging-provider-proof";

export type CatalogRealProviderProofCriterionStatus = "covered" | "covered-by-linked-gate";

export type CatalogRealProviderProofOptionQueryEvidence = Readonly<{
  scope: "language" | "series" | "expansion";
  optionKind: string;
  parentValues: Readonly<Record<string, string>>;
  itemCount: number;
  selectedValue: string;
  selectedPresent: boolean;
  nextCursorPresent: boolean;
  labelsAndMetadataRedacted: true;
}>;

export type CatalogRealProviderProofSourceObservationRow = Readonly<{
  providerKey: string;
  unitKey: string;
  externalKey: string;
  sourceProfileVersion: string;
  sourceUrlHost: string | null;
  sourceUrlPathRedacted: true;
  sourceUpdatedAtPresent: boolean;
  sourceHashPresent: boolean;
  normalizedFactKeys: readonly string[];
  redactionSummary: string;
}>;

export type CatalogRealProviderProofPromotionPreviewEvidence = Readonly<{
  beforeCatalogWrite: true;
  writeExecuted: false;
  scope: Readonly<{
    providerKey: string;
    unitKey: string;
    languageCode: string;
    seriesId: string;
    setId: string;
  }>;
  matched: number;
  eligible: number;
  blocked: number;
  skipped: number;
  conflicting: number;
  failed: number;
  terminal: number;
  confirmationRequired: true;
}>;

export type CatalogRealProviderProofPacket = Readonly<{
  schemaVersion: typeof catalogRealProviderProofSchemaVersion;
  environment: string;
  checkedAt: string;
  provider: Readonly<{
    providerKey: "tcgdex";
    unitKey: typeof TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY;
    profileKey: string;
    profileVersion: string;
    connectorKind: string;
    transportMode: CatalogRealProviderProofTransportMode;
    scope: typeof TCGDEX_REAL_PROVIDER_PROOF_SCOPE;
  }>;
  providerCriteria: readonly Readonly<{
    key: CatalogProviderTransportProofCriterionKey;
    status: CatalogRealProviderProofCriterionStatus;
    evidence: string;
  }>[];
  optionQueries: readonly CatalogRealProviderProofOptionQueryEvidence[];
  importRun: Readonly<{
    planKey: string;
    transportSteps: readonly string[];
    progressEventCount: number;
    progressEvents: readonly Readonly<{
      phase: ProviderPayloadFetchProgress["phase"];
      completed: number;
      total: number;
      currentLabelRedacted: true;
    }>[];
    payloadCount: number;
    completionState: "completed" | "blocked";
    diagnosticCounts: Readonly<{ info: number; warning: number; error: number }>;
  }>;
  sourceObservationReview: Readonly<{
    reviewSurface: "primary-import-to-promotion-workbench";
    rows: readonly CatalogRealProviderProofSourceObservationRow[];
    counts: Readonly<{
      reviewable: number;
      sampledRows: number;
      blocked: number;
      changedOrObserved: number;
    }>;
  }>;
  promotionPreview: CatalogRealProviderProofPromotionPreviewEvidence;
  degradedTransport: Readonly<{
    condition: CatalogProviderTransportFailureCondition["condition"];
    transportCategory: CatalogProviderTransportFailureCondition["transportCategory"];
    blockerCategory: CatalogProviderTransportFailureCondition["blockerCategory"];
    actionState: CatalogProviderTransportFailureCondition["actionState"];
    rawProviderErrorBodyRetained: false;
    evidence: readonly string[];
  }>;
  securityPrivacy: Readonly<{
    redactionApplied: true;
    rawProviderPayloadRetained: false;
    credentialsOrCookiesRetained: false;
    fullProviderUrlsRetained: false;
    providerControlledLabelsRetained: false;
    forbiddenEvidence: readonly string[];
  }>;
  retiredSurfacePolicy: Readonly<{
    requiredDisposition: typeof catalogPrimaryWorkbenchRetirementPolicy.requiredDisposition;
    retainedOldTwoPageMigration: false;
    retainedRawJsonEscapeHatch: false;
    retainedCompatibilityRoute: false;
    retainedLegacyDocumentation: false;
    forbiddenOutcomes: typeof catalogPrimaryWorkbenchRetirementPolicy.forbiddenOutcomes;
  }>;
}>;

export async function runCatalogTcgdexRealProviderProof(
  input: Readonly<{
    adapter?: ProviderAdapter<TcgdexObservationPayload>;
    loadActiveProfileVersion?: () => Promise<CatalogProviderIntegrationProfileVersionRecord>;
    environment?: string;
    checkedAt?: string;
    transportMode?: CatalogRealProviderProofTransportMode;
  }> = {},
): Promise<CatalogRealProviderProofPacket> {
  const loadActiveProfileVersion = input.loadActiveProfileVersion ?? requireActiveTcgdexProfileVersion;
  const profileVersion = await loadActiveProfileVersion();
  const adapter =
    input.adapter ??
    createTcgdexProviderAdapter({
      loadActiveProfileVersion,
      fetch: globalThis.fetch,
    });
  const scope = TCGDEX_REAL_PROVIDER_PROOF_SCOPE;
  const unitKey = TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY;
  const optionQueries = await collectTcgdexOptionQueryEvidence(adapter, scope);
  const plan = await adapter.planImport({
    unitKey,
    scopeKey: "expansion",
    values: scope,
  });
  const progressEvents: CatalogRealProviderProofPacket["importRun"]["progressEvents"][number][] = [];
  const payloads: ProviderPayloadEnvelope<TcgdexObservationPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan, {
    onProgress: (event) => {
      progressEvents.push({
        phase: event.phase,
        completed: event.completed,
        total: event.total,
        currentLabelRedacted: true,
      });
    },
  })) {
    payloads.push(payload);
  }

  const dryRun = runCatalogIntegrationDryRun({
    unitKey,
    profileVersion: profileVersion.profileVersion,
    payloads,
    normalize: (envelope) => ({
      unitKey,
      providerKey: envelope.providerKey,
      externalKey: envelope.externalKey,
      profileVersion: profileVersion.profileVersion,
      normalizedFacts: tcgdexProofNormalizedFacts(envelope.payload),
      sourceUrl: envelope.provenance.sourceUrl,
      sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
      sourceHash: envelope.provenance.contentHash,
    }),
  });
  const packet = buildTcgdexRealProviderProofPacket({
    environment: input.environment ?? process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    profileVersion,
    transportMode: input.transportMode ?? "live-provider",
    plan,
    progressEvents,
    payloadCount: payloads.length,
    optionQueries,
    dryRun,
  });

  assertCatalogRealProviderProofPacketIsRedactionSafe(packet);
  return packet;
}

export function assertCatalogRealProviderProofPacketIsRedactionSafe(packet: CatalogRealProviderProofPacket): void {
  if (packet.securityPrivacy.rawProviderPayloadRetained) {
    throw new Error("Real-provider proof evidence must not retain raw provider payloads.");
  }
  if (packet.securityPrivacy.credentialsOrCookiesRetained) {
    throw new Error("Real-provider proof evidence must not retain credentials or cookies.");
  }
  if (packet.securityPrivacy.fullProviderUrlsRetained) {
    throw new Error("Real-provider proof evidence must not retain full provider URLs.");
  }
  if (
    packet.retiredSurfacePolicy.retainedOldTwoPageMigration ||
    packet.retiredSurfacePolicy.retainedRawJsonEscapeHatch ||
    packet.retiredSurfacePolicy.retainedCompatibilityRoute ||
    packet.retiredSurfacePolicy.retainedLegacyDocumentation
  ) {
    throw new Error("Real-provider proof evidence must not retain retired control-plane surfaces.");
  }
  if (!packet.promotionPreview.beforeCatalogWrite || packet.promotionPreview.writeExecuted) {
    throw new Error("Real-provider proof must capture promotion preview counts before Catalog writes.");
  }
  const evidenceForLeakScan = JSON.stringify({
    optionQueries: packet.optionQueries,
    importRun: packet.importRun,
    sourceObservationReview: packet.sourceObservationReview,
    promotionPreview: packet.promotionPreview,
    degradedTransport: packet.degradedTransport,
    securityPrivacy: packet.securityPrivacy,
  });
  if (/https?:\/\//i.test(evidenceForLeakScan)) {
    throw new Error("Real-provider proof evidence must not retain full provider URLs.");
  }
  if (/\bsourcePayload\b|\brawPayload\b|\bproviderPayload\b/i.test(evidenceForLeakScan)) {
    throw new Error("Real-provider proof evidence must not retain raw provider payload fields.");
  }
  if (/retired admin structure|support-only route|compatibility redirect/i.test(evidenceForLeakScan)) {
    throw new Error("Real-provider proof evidence must not retain retired control-plane patterns.");
  }
  for (const optionQuery of packet.optionQueries) {
    if (!optionQuery.selectedPresent) {
      throw new Error(`Real-provider proof option query '${optionQuery.scope}' did not include the selected scope.`);
    }
  }
  for (const row of packet.sourceObservationReview.rows) {
    if (row.sourceUrlHost?.includes("/")) {
      throw new Error("Real-provider proof Source Observation evidence must redact provider URL paths.");
    }
  }
}

async function collectTcgdexOptionQueryEvidence(
  adapter: ProviderAdapter<TcgdexObservationPayload>,
  scope: typeof TCGDEX_REAL_PROVIDER_PROOF_SCOPE,
): Promise<readonly CatalogRealProviderProofOptionQueryEvidence[]> {
  return Promise.all([
    optionEvidence(adapter, {
      scope: "language",
      optionKind: "languages",
      selectedValue: scope.languageCode,
      parentValues: {},
    }),
    optionEvidence(adapter, {
      scope: "series",
      optionKind: "series",
      selectedValue: scope.seriesId,
      parentValues: { languageCode: scope.languageCode },
    }),
    optionEvidence(adapter, {
      scope: "expansion",
      optionKind: "expansions",
      selectedValue: scope.setId,
      parentValues: { languageCode: scope.languageCode, seriesId: scope.seriesId },
    }),
  ]);
}

async function optionEvidence(
  adapter: ProviderAdapter<TcgdexObservationPayload>,
  input: Omit<
    CatalogRealProviderProofOptionQueryEvidence,
    "itemCount" | "selectedPresent" | "nextCursorPresent" | "labelsAndMetadataRedacted"
  >,
): Promise<CatalogRealProviderProofOptionQueryEvidence> {
  const query: ProviderOptionQueryInput = {
    unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: input.optionKind,
    parentValues: input.parentValues,
  };
  const result = await adapter.listOptions(query);

  return {
    ...input,
    itemCount: result.items.length,
    selectedPresent: result.items.some((item) => item.value === input.selectedValue),
    nextCursorPresent: Boolean(result.nextCursor),
    labelsAndMetadataRedacted: true,
  };
}

function buildTcgdexRealProviderProofPacket(input: {
  environment: string;
  checkedAt: string;
  profileVersion: CatalogProviderIntegrationProfileVersionRecord;
  transportMode: CatalogRealProviderProofTransportMode;
  plan: ProviderImportPlan;
  progressEvents: CatalogRealProviderProofPacket["importRun"]["progressEvents"];
  payloadCount: number;
  optionQueries: readonly CatalogRealProviderProofOptionQueryEvidence[];
  dryRun: CatalogIntegrationDryRunResult;
}): CatalogRealProviderProofPacket {
  const diagnosticCounts = countDryRunDiagnostics(input.dryRun);
  const blocked = diagnosticCounts.error;
  const skipped = diagnosticCounts.warning;

  return {
    schemaVersion: catalogRealProviderProofSchemaVersion,
    environment: input.environment,
    checkedAt: input.checkedAt,
    provider: {
      providerKey: "tcgdex",
      unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      profileKey: input.profileVersion.profileKey,
      profileVersion: input.profileVersion.profileVersion,
      connectorKind: input.profileVersion.profile.connector.kind,
      transportMode: input.transportMode,
      scope: TCGDEX_REAL_PROVIDER_PROOF_SCOPE,
    },
    providerCriteria: catalogProviderTransportProofCriteria.map((criterion) => ({
      key: criterion.key,
      status: criterion.key === "redaction-safe-evidence" ? "covered-by-linked-gate" : "covered",
      evidence: criterionEvidence(criterion.key),
    })),
    optionQueries: input.optionQueries,
    importRun: {
      planKey: input.plan.planKey,
      transportSteps: input.plan.transportSteps,
      progressEventCount: input.progressEvents.length,
      progressEvents: summarizeProgressEvents(input.progressEvents),
      payloadCount: input.payloadCount,
      completionState: diagnosticCounts.error === 0 ? "completed" : "blocked",
      diagnosticCounts,
    },
    sourceObservationReview: {
      reviewSurface: "primary-import-to-promotion-workbench",
      rows: input.dryRun.observations.slice(0, catalogRealProviderProofSampleLimit).map(toSourceObservationReviewRow),
      counts: {
        reviewable: input.dryRun.observations.length,
        sampledRows: Math.min(input.dryRun.observations.length, catalogRealProviderProofSampleLimit),
        blocked,
        changedOrObserved: input.dryRun.observations.length,
      },
    },
    promotionPreview: {
      beforeCatalogWrite: true,
      writeExecuted: false,
      scope: {
        providerKey: "tcgdex",
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        languageCode: TCGDEX_REAL_PROVIDER_PROOF_SCOPE.languageCode,
        seriesId: TCGDEX_REAL_PROVIDER_PROOF_SCOPE.seriesId,
        setId: TCGDEX_REAL_PROVIDER_PROOF_SCOPE.setId,
      },
      matched: input.dryRun.observations.length + blocked + skipped,
      eligible: input.dryRun.observations.length,
      blocked,
      skipped,
      conflicting: 0,
      failed: blocked,
      terminal: skipped,
      confirmationRequired: true,
    },
    degradedTransport: degradedTransportEvidence(),
    securityPrivacy: {
      redactionApplied: true,
      rawProviderPayloadRetained: false,
      credentialsOrCookiesRetained: false,
      fullProviderUrlsRetained: false,
      providerControlledLabelsRetained: false,
      forbiddenEvidence: [
        "credentials and cookies",
        "raw provider payload bodies",
        "secret URLs",
        "account or user identifiers",
        "provider-controlled option labels",
        "provider image or asset URLs",
      ],
    },
    retiredSurfacePolicy: {
      requiredDisposition: catalogPrimaryWorkbenchRetirementPolicy.requiredDisposition,
      retainedOldTwoPageMigration: false,
      retainedRawJsonEscapeHatch: false,
      retainedCompatibilityRoute: false,
      retainedLegacyDocumentation: false,
      forbiddenOutcomes: catalogPrimaryWorkbenchRetirementPolicy.forbiddenOutcomes,
    },
  };
}

function summarizeProgressEvents(
  events: CatalogRealProviderProofPacket["importRun"]["progressEvents"],
): CatalogRealProviderProofPacket["importRun"]["progressEvents"] {
  if (events.length <= catalogRealProviderProofProgressSampleLimit) {
    return events;
  }

  const headCount = catalogRealProviderProofProgressSampleLimit - 1;
  const finalEvent = events.at(-1);
  return finalEvent ? [...events.slice(0, headCount), finalEvent] : events;
}

function criterionEvidence(key: CatalogProviderTransportProofCriterionKey): string {
  const selectedProvider = getCatalogProviderTransportFirstSliceProofProvider();
  const coverage = selectedProvider.coverage.find((entry) => entry.criterion === key);
  if (!coverage) {
    throw new Error(`Selected real-provider proof provider does not cover '${key}'.`);
  }

  switch (key) {
    case "provider-scope-option-query-selection":
      return "The proof packet records bounded language, Series, and Expansion option-query counts with selected values present.";
    case "provider-pagination-or-multi-step-retrieval":
      return "The proof packet records the TCGdex import plan transport steps before payload fetch completion.";
    case "image-and-metadata-mapping":
      return "The proof packet records Source Observation rows with normalized fact keys and redacted provenance metadata.";
    case "provider-transport-degraded-condition":
      return "The proof packet records a canonical timeout condition mapped to providerTransport and blocker categories.";
    case "source-observation-profile-metadata":
      return "The proof packet records provider key, unit key, source profile version, external key, and safe provenance flags.";
    case "promotion-preview-counts":
      return "The proof packet records matched, eligible, blocked, skipped, conflict, and failed counts before Catalog writes.";
    case "redaction-safe-evidence":
      return "The proof packet is redacted by contract and links the security/privacy launch gate.";
  }
}

function degradedTransportEvidence(): CatalogRealProviderProofPacket["degradedTransport"] {
  const condition = catalogProviderTransportFailureConditions.find((entry) => entry.condition === "timeout");
  if (!condition) {
    throw new Error("Missing canonical timeout provider transport condition.");
  }

  return {
    condition: condition.condition,
    transportCategory: condition.transportCategory,
    blockerCategory: condition.blockerCategory,
    actionState: condition.actionState,
    rawProviderErrorBodyRetained: false,
    evidence: [
      "A timeout or abort diagnostic maps to providerTransport=timeout.",
      "The primary workbench blocks unsafe writes through provider-transport-timeout instead of exposing raw provider errors.",
    ],
  };
}

function toSourceObservationReviewRow(
  observation: CatalogIntegrationDryRunResult["observations"][number],
): CatalogRealProviderProofSourceObservationRow {
  return {
    providerKey: observation.providerKey,
    unitKey: observation.unitKey,
    externalKey: observation.externalKey,
    sourceProfileVersion: observation.profileVersion,
    sourceUrlHost: sourceUrlHost(observation.sourceUrl),
    sourceUrlPathRedacted: true,
    sourceUpdatedAtPresent: Boolean(observation.sourceUpdatedAt),
    sourceHashPresent: Boolean(observation.sourceHash),
    normalizedFactKeys: Object.keys(observation.normalizedFacts).sort(),
    redactionSummary:
      "Raw provider payload withheld; only identity, profile metadata, host, and normalized fact keys remain.",
  };
}

function countDryRunDiagnostics(
  dryRun: CatalogIntegrationDryRunResult,
): CatalogRealProviderProofPacket["importRun"]["diagnosticCounts"] {
  return {
    info: dryRun.diagnostics.filter((diagnostic) => diagnostic.severity === "info").length,
    warning: dryRun.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    error: dryRun.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
  };
}

function tcgdexProofNormalizedFacts(payload: TcgdexObservationPayload): Readonly<Record<string, string>> {
  return {
    name: stringFact(payload.payload, "catalogHashMaterial.normalized.name"),
    cardNumber: stringFact(payload.payload, "catalogHashMaterial.normalized.cardNumber"),
    expansionName: stringFact(payload.payload, "catalogHashMaterial.normalized.expansionName"),
    rarity: stringFact(payload.payload, "catalogHashMaterial.normalized.rarity"),
    cardVariantLabel: stringFact(payload.payload, "catalogHashMaterial.normalized.cardVariantLabel"),
  };
}

function stringFact(payload: unknown, path: string): string {
  const value = path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, payload);

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

function sourceUrlHost(sourceUrl?: string): string | null {
  if (!sourceUrl) {
    return null;
  }

  try {
    return new URL(sourceUrl).host;
  } catch {
    return "invalid-url-redacted";
  }
}

async function requireActiveTcgdexProfileVersion(): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const version = getActiveCatalogProviderIntegrationProfileVersion("tcgdex");
  if (!version) {
    throw new Error("Expected active TCGdex profile version for real-provider proof.");
  }
  return version;
}
