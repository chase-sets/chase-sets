import type { ListResponse } from "@chase-sets/http/responses";
import type { JsonValue } from "@chase-sets/primitives/json";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchMergeCandidateActionKey,
  CatalogPrimaryWorkbenchMergeCandidateReviewReadModel,
  CatalogPrimaryWorkbenchMergeCandidateReviewRow,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import {
  previewCatalogMergeCandidateReviewCommand,
  type CatalogMergeCandidateReviewCommandBlocker,
} from "../api/catalog-merge-candidate-review-command-payloads";
import type { CatalogMergeCandidateListItem } from "./contracts";
import { actionStateForBlockers } from "./primary-workbench-read-model-support";
import { scopeDisplayLabel } from "./primary-workbench-scope-context";

const mergeCandidateReviewPageSize = 25;

export function mergeCandidateReviewFor(input: {
  canManage: boolean;
  generatedAt: string;
  mergeCandidates: ListResponse<CatalogMergeCandidateListItem> | null;
  mergeCandidateReviewUnavailable?: boolean;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): CatalogPrimaryWorkbenchMergeCandidateReviewReadModel {
  const unfilteredRows = input.mergeCandidates?.items ?? [];
  const rows = unfilteredRows
    .filter((candidate) => candidateMatchesScope(candidate, input.routeContext))
    .map((candidate) => mergeCandidateReviewRowFor(candidate, input.canManage));
  const stale = rows.filter((row) => row.status === "stale").length;
  const terminal = rows.filter((row) => row.status === "promoted" || row.status === "rejected").length;
  const deferred = rows.filter((row) => row.status === "deferred").length;

  return {
    freshness: input.mergeCandidateReviewUnavailable
      ? "unavailable"
      : input.mergeCandidates
        ? "fresh"
        : input.routeContext.providerKey
          ? "partial"
          : "stale",
    counts: {
      total: rows.length,
      ready: rows.filter((row) => row.status === "ready").length,
      conflict: rows.filter((row) => row.status === "has-conflicts").length,
      stale,
      deferred,
      terminal,
      blocked: rows.filter((row) => row.promoteReadiness.state === "blocked").length,
    },
    filters: [
      {
        key: "scope",
        label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.filter.scope"),
        value: input.routeContext.scope ? scopeDisplayLabel(input.routeContext.scope) : null,
        serverApplied: false,
      },
      {
        key: "status",
        label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.filter.status"),
        value: input.routeContext.sourceObservationFilters.status ?? null,
        serverApplied: false,
      },
      {
        key: "search",
        label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.filter.search"),
        value: input.routeContext.sourceObservationFilters.search ?? null,
        serverApplied: false,
      },
      {
        key: "syncRun",
        label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.filter.syncRun"),
        value: input.routeContext.jobId,
        serverApplied: Boolean(input.routeContext.jobId),
      },
    ],
    pagination: {
      mode: "offset",
      limit: mergeCandidateReviewPageSize,
      offset: 0,
      total: rows.length,
    },
    rows,
  };
}

function mergeCandidateReviewRowFor(
  candidate: CatalogMergeCandidateListItem,
  canManage: boolean,
): CatalogPrimaryWorkbenchMergeCandidateReviewRow {
  const blockers = mergeCandidateBlockersFor(candidate, canManage);
  const sourceComparison = candidate.field_provenance_json.slice(0, 8).map((entry) => ({
    fieldPath: entry.fieldPath,
    value: jsonSummary(entry.value),
    providerKey: entry.providerKey,
    observationId: entry.observationId,
    confidence: entry.confidence,
  }));
  const fieldProvenance = candidate.field_provenance_json.slice(0, 12).map((entry) => ({
    fieldPath: entry.fieldPath,
    providerKey: entry.providerKey,
    sourceProfileVersion: entry.sourceProfileVersion,
    confidence: entry.confidence,
    evidenceSummary: jsonSummary(entry.evidence),
  }));
  const sources = sourceRowsFor(candidate);
  const externalCatalogItemReferences = candidate.proposed_external_catalog_item_references_json.map(
    (reference) => `${reference.providerKey}:${reference.externalKey}`,
  );
  const externalProductReferences = candidate.proposed_external_product_references_json.map(
    (reference) =>
      `${reference.providerKey}:${reference.externalKey} -> ${reference.selectedOptions
        .map((option) => `${option.dimensionId}:${option.optionId}`)
        .join(", ")}`,
  );

  return {
    candidateId: candidate.candidate_id,
    identityFingerprint: candidate.identity_fingerprint,
    identityLabel: identityLabel(candidate),
    sourceCount: Math.max(candidate.observation_count, sources.length),
    sources,
    status: candidate.status,
    statusReason: candidate.status_reason,
    conflicts: {
      blocking: candidate.conflicts_json.filter((conflict) => conflict.severity === "blocking").length,
      warnings: candidate.warnings_json.length,
      messages: [
        ...candidate.conflicts_json.map((conflict) => conflict.message),
        ...candidate.warnings_json.map((warning) => warning.message),
      ],
      blockingConflicts: candidate.conflicts_json
        .filter((conflict) => conflict.severity === "blocking")
        .map((conflict) => ({
          code: conflict.code,
          message: conflict.message,
          fieldPath: conflict.fieldPath,
          existingValueDisplay: jsonSummary(conflict.existingValue),
          proposedValueDisplay: jsonSummary(conflict.proposedValue),
          existingValueJson: JSON.stringify(conflict.existingValue ?? null),
          proposedValueJson: JSON.stringify(conflict.proposedValue ?? null),
          observationIds: conflict.observationIds,
        })),
    },
    promoteReadiness: {
      state: promoteReadinessStateFor(candidate, blockers),
      blockers,
    },
    proposedMapping: {
      promotionIntent: candidate.promotion_intent,
      catalogItemId: candidate.matched_catalog_item_id,
      productIds: candidate.matched_product_ids_json,
      externalCatalogItemReferences,
      externalProductReferences,
    },
    sourceComparison,
    fieldProvenance,
    proposedFacts: proposedFactsFor(candidate.proposed_catalog_item_facts_json),
    actions: mergeCandidateActionsFor(candidate, canManage, blockers),
  };
}

function mergeCandidateBlockersFor(
  candidate: CatalogMergeCandidateListItem,
  canManage: boolean,
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!canManage) {
    blockers.add("permission-denied");
  }
  if (candidate.status === "has-conflicts") {
    blockers.add("promotion-conflict");
  }
  if (candidate.status === "stale") {
    blockers.add("source-projection-stale");
  }
  if (candidate.status === "promoted" || candidate.status === "rejected" || candidate.status === "deferred") {
    blockers.add("no-promotion-eligible-observations");
  }

  return [...blockers];
}

function mergeCandidateActionsFor(
  candidate: CatalogMergeCandidateListItem,
  canManage: boolean,
  promotionBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): CatalogPrimaryWorkbenchMergeCandidateReviewRow["actions"] {
  const manageState: CatalogPrimaryWorkbenchActionState = canManage ? "available" : "denied";
  const manageBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] = canManage ? [] : ["permission-denied"];
  const terminalBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] =
    candidate.status === "promoted" || candidate.status === "rejected"
      ? ["no-promotion-eligible-observations"]
      : manageBlockers;
  const splitPreview = previewCatalogMergeCandidateReviewCommand(candidate, "split-merge-candidate");
  const updatePreview = previewCatalogMergeCandidateReviewCommand(candidate, "update-merge-candidate");
  const splitBlockers =
    splitPreview.status === "available"
      ? manageBlockers
      : [...manageBlockers, ...commandPreviewBlockers(splitPreview.blockers)];
  const updateBlockers =
    updatePreview.status === "available"
      ? manageBlockers
      : [...manageBlockers, ...commandPreviewBlockers(updatePreview.blockers)];

  return [
    action(
      "promote-merge-candidate",
      actionStateForBlockers(promotionBlockers, manageState),
      promotionBlockers,
      true,
      null,
    ),
    action(
      "split-merge-candidate",
      actionStateForBlockers(splitBlockers, manageState),
      splitBlockers,
      true,
      splitPreview.preview,
    ),
    action(
      "update-merge-candidate",
      actionStateForBlockers(updateBlockers, manageState),
      updateBlockers,
      true,
      updatePreview.preview,
    ),
    action(
      "ignore-merge-candidate",
      actionStateForBlockers(terminalBlockers, manageState),
      terminalBlockers,
      true,
      null,
    ),
    action(
      "defer-merge-candidate",
      actionStateForBlockers(terminalBlockers, manageState),
      terminalBlockers,
      true,
      null,
    ),
  ];
}

function action(
  key: CatalogPrimaryWorkbenchMergeCandidateActionKey,
  state: CatalogPrimaryWorkbenchActionState,
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
  reasonRequired: boolean,
  commandPreview: CatalogPrimaryWorkbenchMergeCandidateReviewRow["actions"][number]["commandPreview"],
): CatalogPrimaryWorkbenchMergeCandidateReviewRow["actions"][number] {
  return { key, state, blockers, reasonRequired, commandPreview };
}

function commandPreviewBlockers(
  blockers: readonly CatalogMergeCandidateReviewCommandBlocker[],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  if (blockers.includes("candidate-stale")) {
    return ["source-projection-stale"];
  }
  if (blockers.includes("candidate-terminal")) {
    return ["no-promotion-eligible-observations"];
  }
  return ["unsupported-command"];
}

function promoteReadinessStateFor(
  candidate: CatalogMergeCandidateListItem,
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): CatalogPrimaryWorkbenchMergeCandidateReviewRow["promoteReadiness"]["state"] {
  if (candidate.status === "promoted" || candidate.status === "rejected") {
    return "terminal";
  }
  if (candidate.status === "deferred") {
    return "deferred";
  }
  if (candidate.status === "stale") {
    return "stale";
  }
  return blockers.length === 0 ? "ready" : "blocked";
}

function sourceRowsFor(
  candidate: CatalogMergeCandidateListItem,
): CatalogPrimaryWorkbenchMergeCandidateReviewRow["sources"] {
  const sourceMap = new Map<string, CatalogPrimaryWorkbenchMergeCandidateReviewRow["sources"][number]>();
  for (const entry of candidate.field_provenance_json) {
    const key = `${entry.providerKey}:${entry.observationId}`;
    sourceMap.set(key, {
      providerKey: entry.providerKey,
      observationId: entry.observationId,
      externalKey: null,
      sourceProfileVersion: entry.sourceProfileVersion,
    });
  }
  for (const reference of candidate.proposed_external_catalog_item_references_json) {
    const key = `${reference.providerKey}:${reference.externalKey}`;
    if (!sourceMap.has(key)) {
      sourceMap.set(key, {
        providerKey: reference.providerKey,
        observationId: null,
        externalKey: reference.externalKey,
        sourceProfileVersion: null,
      });
    }
  }

  return [...sourceMap.values()].slice(0, 6);
}

function candidateMatchesScope(
  candidate: CatalogMergeCandidateListItem,
  context: CatalogPrimaryWorkbenchRouteContext,
): boolean {
  const scope = context.scope;
  if (!scope) {
    return true;
  }
  if (
    scope.languageCode &&
    normalizedScopeText(candidate.identity_json.languageCode) !== normalizedScopeText(scope.languageCode)
  ) {
    return false;
  }
  if (
    scope.expansionName &&
    candidate.identity_json.setName &&
    normalizedScopeText(candidate.identity_json.setName) !== normalizedScopeText(scope.expansionName)
  ) {
    return false;
  }
  if (scope.productLineName && !productLineNamesMatch(candidate.identity_json.productLineName, scope.productLineName)) {
    return false;
  }

  return true;
}

function productLineNamesMatch(candidateValue: string, scopeValue: string): boolean {
  return canonicalProductLineName(candidateValue) === canonicalProductLineName(scopeValue);
}

function canonicalProductLineName(value: string): string {
  const normalized = normalizedScopeText(value);
  switch (normalized) {
    case "pokemon":
    case "pokemon tcg":
    case "pokemon trading card game":
      return "pokemon";
    case "magic":
    case "magic the gathering":
    case "mtg":
      return "magic";
    case "one piece":
    case "one piece card game":
      return "one piece";
    case "lorcana":
    case "disney lorcana":
      return "lorcana";
    default:
      return normalized;
  }
}

function normalizedScopeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function identityLabel(candidate: CatalogMergeCandidateListItem): string {
  const identity = candidate.identity_json;
  const parts = [
    identity.printedProductName,
    identity.setName,
    identity.collectorNumber ? `#${identity.collectorNumber}` : null,
    identity.languageCode,
    identity.variantKey,
  ].filter((value): value is string => Boolean(value));

  return parts.join(" / ");
}

function proposedFactsFor(value: JsonValue): CatalogPrimaryWorkbenchMergeCandidateReviewRow["proposedFacts"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value)
    .slice(0, 12)
    .map(([key, factValue]) => ({ key, value: jsonSummary(factValue) }));
}

function jsonSummary(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }

  return JSON.stringify(value);
}
