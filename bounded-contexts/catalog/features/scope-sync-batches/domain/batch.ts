import { createHash } from "node:crypto";
import type {
  CatalogSyncProviderParticipationPreview,
  CatalogSyncScope,
} from "../../source-observations/api/catalog-sync-scope-planner";

export type ScopeSyncBatchSelection =
  | Readonly<{ mode: "ids"; scopeRecordIds: readonly string[] }>
  | Readonly<{
      mode: "matching-scope";
      query: Readonly<{
        productDomain?: string | null;
        scopeKind?: "product-line" | "series" | "expansion" | "set" | null;
        languageCode?: string | null;
      }>;
    }>;

export type ScopeSyncBatchBudget = Readonly<{
  maxScopesPerTurn: number;
  defaultProviderConcurrency: number;
  providerConcurrency: Readonly<Record<string, number>>;
  providerRequestLimits: Readonly<Record<string, number>>;
  creditedProviderRequestLimits: Readonly<Record<string, number>>;
  providerFailureThreshold: number;
}>;

export const defaultScopeSyncBatchBudget: ScopeSyncBatchBudget = {
  maxScopesPerTurn: 1,
  defaultProviderConcurrency: 1,
  providerConcurrency: {},
  providerRequestLimits: {},
  creditedProviderRequestLimits: { scrydex: 0 },
  providerFailureThreshold: 3,
};

export type ScopeSyncBatchBlocker = Readonly<{
  code:
    | "empty-selection"
    | "scope-inactive"
    | "mapping-missing"
    | "scope-planning-blocked"
    | "provider-request-budget-exceeded"
    | "credited-provider-estimate-unavailable"
    | "credited-provider-budget-exceeded"
    | "provider-circuit-open";
  scopeRecordId: string | null;
  providerKey: string | null;
  message: string;
}>;

export type ScopeSyncBatchPlannedScope = Readonly<{
  scopeRecordId: string;
  scopeRecordVersion: string;
  mappingVersions: readonly Readonly<{ mappingId: string; version: string; reviewStatus: string }>[];
  profileVersions: readonly Readonly<{
    providerKey: string;
    unitKey: string;
    profileKey: string;
    profileVersion: string;
  }>[];
  providerKeys: readonly string[];
  providerUnitCount: number;
  estimatedRequestCount: number | null;
  creditedProviderRequestEstimates: Readonly<Record<string, number | null>>;
  scope: CatalogSyncScope;
  participationPreview: CatalogSyncProviderParticipationPreview;
  blockers: readonly ScopeSyncBatchBlocker[];
}>;

export type ScopeSyncBatchPreview = Readonly<{
  previewVersion: "scope-sync-batch-preview-v1";
  selection: ScopeSyncBatchSelection;
  budget: ScopeSyncBatchBudget;
  planFingerprint: string;
  status: "empty" | "blocked" | "ready";
  confirmAllowed: boolean;
  counts: Readonly<{
    scopes: number;
    readyScopes: number;
    blockedScopes: number;
    providerUnits: number;
  }>;
  providerUnitTotals: Readonly<Record<string, number>>;
  providerRequestEstimates: Readonly<Record<string, number | null>>;
  samples: readonly Readonly<{
    scopeRecordId: string;
    providerUnitCount: number;
    blockerCount: number;
    estimatedRequestCount: number | null;
    providerKeys: readonly string[];
    mappingVersions: ScopeSyncBatchPlannedScope["mappingVersions"];
    profileVersions: ScopeSyncBatchPlannedScope["profileVersions"];
  }>[];
  blockers: readonly ScopeSyncBatchBlocker[];
  resolvedAt: string;
}>;

export type ScopeSyncBatchUnitState = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ScopeSyncBatchStatus = "queued" | "running" | "cancelled" | "completed" | "partial" | "failed";

export function normalizeScopeSyncBatchSelection(selection: ScopeSyncBatchSelection): ScopeSyncBatchSelection {
  if (selection.mode === "ids") {
    return {
      mode: "ids",
      scopeRecordIds: [...new Set(selection.scopeRecordIds.map((id) => id.trim()).filter(Boolean))].sort(),
    };
  }
  return {
    mode: "matching-scope",
    query: {
      productDomain: normalizeOptional(selection.query.productDomain),
      scopeKind: selection.query.scopeKind ?? null,
      languageCode: normalizeOptional(selection.query.languageCode),
    },
  };
}

export function normalizeScopeSyncBatchBudget(budget?: Partial<ScopeSyncBatchBudget> | null): ScopeSyncBatchBudget {
  const normalized: ScopeSyncBatchBudget = {
    maxScopesPerTurn: boundedInteger(budget?.maxScopesPerTurn, 1, 25, defaultScopeSyncBatchBudget.maxScopesPerTurn),
    defaultProviderConcurrency: boundedInteger(
      budget?.defaultProviderConcurrency,
      1,
      20,
      defaultScopeSyncBatchBudget.defaultProviderConcurrency,
    ),
    providerConcurrency: normalizePositiveIntegerRecord(budget?.providerConcurrency, 1, 20),
    providerRequestLimits: normalizePositiveIntegerRecord(budget?.providerRequestLimits, 0, 1_000_000),
    creditedProviderRequestLimits: normalizePositiveIntegerRecord(budget?.creditedProviderRequestLimits, 0, 1_000_000),
    providerFailureThreshold: boundedInteger(
      budget?.providerFailureThreshold,
      1,
      100,
      defaultScopeSyncBatchBudget.providerFailureThreshold,
    ),
  };
  return normalized;
}

export function buildScopeSyncBatchPreview(input: {
  selection: ScopeSyncBatchSelection;
  budget?: Partial<ScopeSyncBatchBudget> | null;
  plans: readonly ScopeSyncBatchPlannedScope[];
  resolvedAt: string;
  sampleLimit?: number;
}): ScopeSyncBatchPreview {
  const selection = normalizeScopeSyncBatchSelection(input.selection);
  const budget = normalizeScopeSyncBatchBudget(input.budget);
  const plans = [...input.plans].sort((left, right) => left.scopeRecordId.localeCompare(right.scopeRecordId));
  const blockers = plans.flatMap((plan) => plan.blockers);
  if (plans.length === 0) {
    blockers.push({
      code: "empty-selection",
      scopeRecordId: null,
      providerKey: null,
      message: "No eligible active Catalog Scope Records matched this selection.",
    });
  }

  const creditedTotals = aggregateNullableEstimates(plans, (plan) => plan.creditedProviderRequestEstimates);
  for (const [providerKey, limit] of Object.entries(budget.creditedProviderRequestLimits)) {
    const estimate = creditedTotals[providerKey];
    if (estimate === null) {
      blockers.push({
        code: "credited-provider-estimate-unavailable",
        scopeRecordId: null,
        providerKey,
        message: `${providerKey} request or credit evidence is unavailable; confirmation is closed.`,
      });
    } else if (estimate !== undefined && estimate > limit) {
      blockers.push({
        code: "credited-provider-budget-exceeded",
        scopeRecordId: null,
        providerKey,
        message: `${providerKey} estimated requests (${estimate}) exceed the configured batch limit (${limit}).`,
      });
    }
  }

  const providerUnitTotals: Record<string, number> = {};
  for (const plan of plans) {
    for (const providerKey of plan.providerKeys) {
      providerUnitTotals[providerKey] =
        (providerUnitTotals[providerKey] ?? 0) +
        plan.profileVersions.filter((profile) => profile.providerKey === providerKey).length;
    }
  }
  const providerRequestEstimates = aggregateNullableEstimates(plans, (plan) => {
    const byProvider: Record<string, number | null> = {};
    for (const unit of plan.participationPreview.units.filter((candidate) => candidate.selected)) {
      const requestCount = unit.estimate.estimatedRequestCount;
      byProvider[unit.providerKey] = addNullable(byProvider[unit.providerKey], requestCount);
    }
    return byProvider;
  });
  for (const [providerKey, limit] of Object.entries(budget.providerRequestLimits)) {
    const estimate = providerRequestEstimates[providerKey];
    if (estimate !== undefined && estimate !== null && estimate > limit) {
      blockers.push({
        code: "provider-request-budget-exceeded",
        scopeRecordId: null,
        providerKey,
        message: `${providerKey} estimated requests (${estimate}) exceed the configured provider request limit (${limit}).`,
      });
    }
  }
  const status = plans.length === 0 ? "empty" : blockers.length > 0 ? "blocked" : "ready";

  return {
    previewVersion: "scope-sync-batch-preview-v1",
    selection,
    budget,
    planFingerprint: scopeSyncBatchPlanFingerprint({ selection, budget, plans }),
    status,
    confirmAllowed: status === "ready",
    counts: {
      scopes: plans.length,
      readyScopes: plans.filter((plan) => plan.blockers.length === 0).length,
      blockedScopes: plans.filter((plan) => plan.blockers.length > 0).length,
      providerUnits: plans.reduce((total, plan) => total + plan.providerUnitCount, 0),
    },
    providerUnitTotals: sortRecord(providerUnitTotals),
    providerRequestEstimates: sortRecord(providerRequestEstimates),
    samples: plans.slice(0, Math.min(50, Math.max(1, input.sampleLimit ?? 20))).map((plan) => ({
      scopeRecordId: plan.scopeRecordId,
      providerUnitCount: plan.providerUnitCount,
      blockerCount: plan.blockers.length,
      estimatedRequestCount: plan.estimatedRequestCount,
      providerKeys: plan.providerKeys,
      mappingVersions: plan.mappingVersions,
      profileVersions: plan.profileVersions,
    })),
    blockers,
    resolvedAt: input.resolvedAt,
  };
}

export function scopeSyncBatchPlanFingerprint(input: {
  selection: ScopeSyncBatchSelection;
  budget: ScopeSyncBatchBudget;
  plans: readonly ScopeSyncBatchPlannedScope[];
}): string {
  return createHash("sha256")
    .update(
      stableJson({
        selection: input.selection,
        budget: input.budget,
        plans: input.plans.map((plan) => ({
          scopeRecordId: plan.scopeRecordId,
          scopeRecordVersion: plan.scopeRecordVersion,
          mappingVersions: plan.mappingVersions,
          profileVersions: plan.profileVersions,
          scope: plan.scope,
          participationPreview: plan.participationPreview,
          blockers: plan.blockers,
        })),
      }),
    )
    .digest("hex");
}

export function assertScopeSyncBatchPreviewCurrent(expectedFingerprint: string, current: ScopeSyncBatchPreview): void {
  if (!expectedFingerprint.trim() || expectedFingerprint !== current.planFingerprint) {
    throw new ScopeSyncBatchStalePreviewError(current);
  }
  if (!current.confirmAllowed) {
    throw new ScopeSyncBatchBlockedPreviewError(current);
  }
}

export class ScopeSyncBatchStalePreviewError extends Error {
  readonly code = "scope_sync_batch_stale_preview";
  constructor(readonly currentPreview: ScopeSyncBatchPreview) {
    super("Scope Sync Batch evidence changed after preview. Preview again before confirming.");
    this.name = "ScopeSyncBatchStalePreviewError";
  }
}

export class ScopeSyncBatchBlockedPreviewError extends Error {
  readonly code = "scope_sync_batch_blocked";
  constructor(readonly currentPreview: ScopeSyncBatchPreview) {
    super("Scope Sync Batch confirmation is blocked by current planning evidence.");
    this.name = "ScopeSyncBatchBlockedPreviewError";
  }
}

export function scopeSyncBatchStatusFromUnits(states: readonly ScopeSyncBatchUnitState[]): ScopeSyncBatchStatus {
  if (states.length === 0) return "completed";
  if (states.some((state) => state === "running")) return "running";
  if (states.some((state) => state === "queued")) return "queued";
  const completed = states.filter((state) => state === "completed").length;
  const failed = states.filter((state) => state === "failed").length;
  const cancelled = states.filter((state) => state === "cancelled").length;
  if (completed === states.length) return "completed";
  if (cancelled === states.length) return "cancelled";
  if (completed > 0 && (failed > 0 || cancelled > 0)) return "partial";
  return failed > 0 ? "failed" : "cancelled";
}

export function providerConcurrencyAvailable(input: {
  providerKeys: readonly string[];
  activeByProvider: Readonly<Record<string, number>>;
  budget: ScopeSyncBatchBudget;
}): boolean {
  return input.providerKeys.every((providerKey) => {
    const limit = input.budget.providerConcurrency[providerKey] ?? input.budget.defaultProviderConcurrency;
    return (input.activeByProvider[providerKey] ?? 0) < limit;
  });
}

function aggregateNullableEstimates(
  plans: readonly ScopeSyncBatchPlannedScope[],
  select: (plan: ScopeSyncBatchPlannedScope) => Readonly<Record<string, number | null>>,
): Record<string, number | null> {
  const totals: Record<string, number | null> = {};
  for (const plan of plans) {
    for (const [providerKey, estimate] of Object.entries(select(plan))) {
      totals[providerKey] = addNullable(totals[providerKey], estimate);
    }
  }
  return totals;
}

function addNullable(current: number | null | undefined, value: number | null): number | null {
  return current === null || value === null ? null : (current ?? 0) + value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizePositiveIntegerRecord(
  value: Readonly<Record<string, number>> | undefined,
  min: number,
  max: number,
): Readonly<Record<string, number>> {
  return sortRecord(
    Object.fromEntries(
      Object.entries(value ?? {}).map(([key, entry]) => [
        key.trim().toLowerCase(),
        boundedInteger(entry, min, max, min),
      ]),
    ),
  );
}

function boundedInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected an integer between ${min} and ${max}.`);
  }
  return value;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}
