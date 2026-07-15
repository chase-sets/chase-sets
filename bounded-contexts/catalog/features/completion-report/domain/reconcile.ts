import {
  providerUnitKey,
  unitKey,
  type CompletionExclusionReason,
  type ManifestExpectedUnit,
  type ManifestObservedUnit,
  type ManifestProviderUnit,
  type ManifestScope,
  type ProductionCatalogCompletionManifest,
  type ProviderProductionClass,
} from "./manifest";

export const productionCatalogCompletionReportVersion = "production-catalog-completion-report-v1" as const;

// A launch blocker. Codes are stable so support tooling and go/no-go gates can
// key off them without parsing prose.
export const completionBlockerCodes = [
  "mapping-missing",
  "never-synced-unit",
  "failed-job",
  "stale-job",
  "non-terminal-unit",
  "pre-cutoff-coverage",
  "incomplete-coverage",
  "unresolved-merge-candidate",
  "duplicate-prevention-block",
  "blocked-promotion",
  "unexplained-exclusion",
  "asset-processing-failure",
  "credited-usage-unavailable",
] as const;
export type CompletionBlockerCode = (typeof completionBlockerCodes)[number];

export type CompletionBlocker = Readonly<{
  code: CompletionBlockerCode;
  scopeRecordId: string | null;
  providerKey: string | null;
  unitKey: string | null;
  message: string;
}>;

export type CompletionExclusionSummary = Readonly<{
  reason: CompletionExclusionReason;
  count: number;
}>;

export type CompletionCoverage = Readonly<{
  eligibleScopeCount: number;
  coveredScopeCount: number;
  scopeCoverageRatio: number;
  requiredProviderUnitCount: number;
  terminalProviderUnitCount: number;
  providerUnitCoverageRatio: number;
}>;

export type ProductionCatalogCompletionReport = Readonly<{
  reportVersion: typeof productionCatalogCompletionReportVersion;
  generatedAt: string;
  launchCutoff: string;
  batch: ProductionCatalogCompletionManifest["batch"];
  result: "complete" | "incomplete";
  coverage: CompletionCoverage;
  providerUnitStates: Readonly<Record<string, number>>;
  exclusions: readonly CompletionExclusionSummary[];
  mergeCandidates: Readonly<{
    total: number;
    disposed: number;
    unresolved: number;
    unresolvedConflicts: number;
    duplicatePreventionBlocks: number;
    byStatus: Readonly<Record<string, number>>;
  }>;
  promotions: ProductionCatalogCompletionManifest["promotions"];
  catalogItems: ProductionCatalogCompletionManifest["catalogItems"];
  sourceObservations: ProductionCatalogCompletionManifest["sourceObservations"];
  assetProcessing: ProductionCatalogCompletionManifest["assetProcessing"];
  providerUsage: ProductionCatalogCompletionManifest["providerUsage"];
  blockers: readonly CompletionBlocker[];
}>;

const terminalGoodStates = new Set(["settled", "completed"]);
const nonTerminalStates = new Set(["pending", "running"]);

// Map a non-production provider class to the exclusion reason that explains why
// its units never count as required production coverage.
const productionClassExclusionReason: Readonly<
  Record<Exclude<ProviderProductionClass, "production">, CompletionExclusionReason>
> = {
  "validation-only": "validation-only",
  "comparison-only": "comparison-only",
  retired: "retired",
  unapproved: "unapproved",
};

type ClassifiedUnit =
  | Readonly<{ kind: "required"; expected: ManifestExpectedUnit }>
  | Readonly<{ kind: "excluded"; expected: ManifestExpectedUnit; reason: CompletionExclusionReason }>;

// Reconcile a frozen completion manifest into a deterministic completion
// report. Pure: identical input always yields identical output. Emits one
// launch blocker per unresolved gap so a repeat run over the same manifest is
// stable.
export function reconcileProductionCatalogCompletion(
  manifest: ProductionCatalogCompletionManifest,
  options: { generatedAt: string },
): ProductionCatalogCompletionReport {
  const cutoffMs = Date.parse(manifest.launchCutoff);
  const providerClassByUnit = indexProviderUnits(manifest.providerUnits);
  const scopeById = indexScopes(manifest.scopes);
  const observedByUnit = indexObserved(manifest.observedUnits);
  const explicitExclusionByUnit = indexExplicitExclusions(manifest.exclusions);

  const blockers: CompletionBlocker[] = [];
  const exclusionCounts = new Map<CompletionExclusionReason, number>();
  const providerUnitStates = new Map<string, number>();

  const requiredByScope = new Map<string, number>();
  const coveredRequiredByScope = new Map<string, number>();
  let requiredCount = 0;
  let terminalCount = 0;

  for (const expected of orderedExpectedUnits(manifest.expectedUnits)) {
    const classified = classifyExpectedUnit(expected, {
      scopeById,
      providerClassByUnit,
      explicitExclusionByUnit,
    });

    if (classified.kind === "excluded") {
      exclusionCounts.set(classified.reason, (exclusionCounts.get(classified.reason) ?? 0) + 1);
      if (classified.reason === "mapping-missing") {
        blockers.push({
          code: "mapping-missing",
          scopeRecordId: expected.scopeRecordId,
          providerKey: expected.providerKey,
          unitKey: expected.unitKey,
          message: "A production provider unit was planned for this scope with no accepted Provider Scope Mapping.",
        });
      }
      continue;
    }

    requiredCount += 1;
    requiredByScope.set(expected.scopeRecordId, (requiredByScope.get(expected.scopeRecordId) ?? 0) + 1);
    const observed = observedByUnit.get(unitKey(expected.scopeRecordId, expected.providerKey, expected.unitKey));
    const state = observed?.state ?? "never-synced";
    providerUnitStates.set(state, (providerUnitStates.get(state) ?? 0) + 1);

    const blocker = evaluateRequiredUnit(expected, observed, cutoffMs);
    if (blocker) {
      blockers.push(blocker);
      continue;
    }
    terminalCount += 1;
    coveredRequiredByScope.set(expected.scopeRecordId, (coveredRequiredByScope.get(expected.scopeRecordId) ?? 0) + 1);
  }

  blockers.push(...evaluateUnexplainedExclusions(manifest.exclusions));
  const mergeCandidates = summarizeMergeCandidates(manifest);
  blockers.push(...mergeCandidates.blockers);
  blockers.push(...evaluateAssetProcessing(manifest));
  blockers.push(...evaluateCreditedUsage(manifest));

  const coverage = computeCoverage({
    manifest,
    requiredCount,
    terminalCount,
    requiredByScope,
    coveredRequiredByScope,
  });
  if (coverage.requiredProviderUnitCount > coverage.terminalProviderUnitCount) {
    blockers.push({
      code: "incomplete-coverage",
      scopeRecordId: null,
      providerKey: null,
      unitKey: null,
      message: `Only ${coverage.terminalProviderUnitCount} of ${coverage.requiredProviderUnitCount} required provider units reached terminal coverage after the cutoff.`,
    });
  }

  return {
    reportVersion: productionCatalogCompletionReportVersion,
    generatedAt: options.generatedAt,
    launchCutoff: manifest.launchCutoff,
    batch: manifest.batch,
    result: blockers.length === 0 ? "complete" : "incomplete",
    coverage,
    providerUnitStates: sortNumberRecord(providerUnitStates),
    exclusions: orderedExclusionSummaries(exclusionCounts),
    mergeCandidates: mergeCandidates.summary,
    promotions: manifest.promotions,
    catalogItems: manifest.catalogItems,
    sourceObservations: manifest.sourceObservations,
    assetProcessing: manifest.assetProcessing,
    providerUsage: manifest.providerUsage,
    blockers: orderedBlockers(blockers),
  };
}

export function completionExitCode(report: ProductionCatalogCompletionReport): 0 | 2 {
  return report.result === "complete" ? 0 : 2;
}

function classifyExpectedUnit(
  expected: ManifestExpectedUnit,
  indexes: {
    scopeById: ReadonlyMap<string, ManifestScope>;
    providerClassByUnit: ReadonlyMap<string, ProviderProductionClass>;
    explicitExclusionByUnit: ReadonlyMap<string, CompletionExclusionReason>;
  },
): ClassifiedUnit {
  const scope = indexes.scopeById.get(expected.scopeRecordId);
  if (!scope || !scope.eligible) {
    return { kind: "excluded", expected, reason: "ineligible" };
  }

  const providerClass = indexes.providerClassByUnit.get(providerUnitKey(expected.providerKey, expected.unitKey));
  if (providerClass && providerClass !== "production") {
    return { kind: "excluded", expected, reason: productionClassExclusionReason[providerClass] };
  }

  const explicit = indexes.explicitExclusionByUnit.get(
    unitKey(expected.scopeRecordId, expected.providerKey, expected.unitKey),
  );
  if (explicit === "operator-deferred" || explicit === "rollout-blocked" || explicit === "provider-unavailable") {
    return { kind: "excluded", expected, reason: explicit };
  }

  const accepted = scope.acceptedMappings.some(
    (mapping) => mapping.providerKey === expected.providerKey && mapping.unitKey === expected.unitKey,
  );
  if (!accepted) {
    return { kind: "excluded", expected, reason: "mapping-missing" };
  }

  return { kind: "required", expected };
}

function evaluateRequiredUnit(
  expected: ManifestExpectedUnit,
  observed: ManifestObservedUnit | undefined,
  cutoffMs: number,
): CompletionBlocker | null {
  const base = {
    scopeRecordId: expected.scopeRecordId,
    providerKey: expected.providerKey,
    unitKey: expected.unitKey,
  } as const;

  if (!observed || observed.state === "never-synced") {
    return { code: "never-synced-unit", ...base, message: "Required provider unit was never synced after the cutoff." };
  }
  if (observed.state === "failed") {
    return { code: "failed-job", ...base, message: "Required provider unit ended in a failed sync state." };
  }
  if (observed.state === "stale") {
    return { code: "stale-job", ...base, message: "Required provider unit is stale and must be resynced." };
  }
  if (nonTerminalStates.has(observed.state)) {
    return { code: "non-terminal-unit", ...base, message: "Required provider unit has not reached a terminal state." };
  }
  if (terminalGoodStates.has(observed.state)) {
    const completedMs = observed.lastCompletedAt ? Date.parse(observed.lastCompletedAt) : Number.NaN;
    if (!Number.isFinite(completedMs) || completedMs < cutoffMs) {
      return {
        code: "pre-cutoff-coverage",
        ...base,
        message:
          "Required provider unit last settled before the launch cutoff and does not count as production coverage.",
      };
    }
  }
  return null;
}

function summarizeMergeCandidates(manifest: ProductionCatalogCompletionManifest): {
  summary: ProductionCatalogCompletionReport["mergeCandidates"];
  blockers: readonly CompletionBlocker[];
} {
  const byStatus = new Map<string, number>();
  const blockers: CompletionBlocker[] = [];
  let disposed = 0;
  let unresolved = 0;
  let unresolvedConflicts = 0;
  let duplicatePreventionBlocks = 0;

  for (const candidate of manifest.mergeCandidates) {
    byStatus.set(candidate.status, (byStatus.get(candidate.status) ?? 0) + 1);
    const isDisposed =
      candidate.status === "promoted" || candidate.status === "rejected" || candidate.status === "deferred";
    if (isDisposed) {
      disposed += 1;
    } else {
      unresolved += 1;
      blockers.push({
        code: "unresolved-merge-candidate",
        scopeRecordId: candidate.scopeRecordId,
        providerKey: null,
        unitKey: candidate.candidateId,
        message: `Merge candidate ${candidate.candidateId} has no explicit launch disposition (status: ${candidate.status}).`,
      });
    }
    if (candidate.blockingConflictCount > 0) {
      unresolvedConflicts += candidate.blockingConflictCount;
      blockers.push({
        code: "blocked-promotion",
        scopeRecordId: candidate.scopeRecordId,
        providerKey: null,
        unitKey: candidate.candidateId,
        message: `Merge candidate ${candidate.candidateId} carries ${candidate.blockingConflictCount} blocking conflict(s).`,
      });
    }
    if (candidate.duplicatePreventionBlocked) {
      duplicatePreventionBlocks += 1;
      blockers.push({
        code: "duplicate-prevention-block",
        scopeRecordId: candidate.scopeRecordId,
        providerKey: null,
        unitKey: candidate.candidateId,
        message: `Merge candidate ${candidate.candidateId} is blocked by duplicate prevention.`,
      });
    }
  }

  return {
    summary: {
      total: manifest.mergeCandidates.length,
      disposed,
      unresolved,
      unresolvedConflicts,
      duplicatePreventionBlocks,
      byStatus: sortNumberRecord(byStatus),
    },
    blockers,
  };
}

function evaluateUnexplainedExclusions(
  exclusions: ProductionCatalogCompletionManifest["exclusions"],
): readonly CompletionBlocker[] {
  // The manifest schema already constrains reasons to the stable set; this
  // guards a note-only exclusion that names no scope, provider, or unit, which
  // cannot be attributed and is therefore unexplained.
  return exclusions
    .filter((exclusion) => !exclusion.scopeRecordId && !exclusion.providerKey && !exclusion.unitKey)
    .map((exclusion) => ({
      code: "unexplained-exclusion" as const,
      scopeRecordId: null,
      providerKey: null,
      unitKey: null,
      message: `Exclusion with reason "${exclusion.reason}" names no scope, provider, or unit and cannot be attributed.`,
    }));
}

function evaluateAssetProcessing(manifest: ProductionCatalogCompletionManifest): readonly CompletionBlocker[] {
  if (manifest.assetProcessing.approvedFailures <= 0) return [];
  return [
    {
      code: "asset-processing-failure",
      scopeRecordId: null,
      providerKey: null,
      unitKey: null,
      message: `${manifest.assetProcessing.approvedFailures} approved-provider asset(s) failed processing.`,
    },
  ];
}

function evaluateCreditedUsage(manifest: ProductionCatalogCompletionManifest): readonly CompletionBlocker[] {
  return manifest.providerUsage
    .filter((usage) => usage.credited && usage.usageCheckState === "unavailable")
    .map((usage) => ({
      code: "credited-usage-unavailable" as const,
      scopeRecordId: null,
      providerKey: usage.providerKey,
      unitKey: null,
      message: `Credited provider ${usage.providerKey} usage evidence is unavailable; convergence cannot be proven.`,
    }));
}

function computeCoverage(input: {
  manifest: ProductionCatalogCompletionManifest;
  requiredCount: number;
  terminalCount: number;
  requiredByScope: ReadonlyMap<string, number>;
  coveredRequiredByScope: ReadonlyMap<string, number>;
}): CompletionCoverage {
  const eligibleScopeCount = input.manifest.scopes.filter((scope) => scope.eligible).length;
  let coveredScopeCount = 0;
  for (const [scopeRecordId, required] of input.requiredByScope) {
    if ((input.coveredRequiredByScope.get(scopeRecordId) ?? 0) >= required) {
      coveredScopeCount += 1;
    }
  }
  const scopesWithRequirements = input.requiredByScope.size;
  return {
    eligibleScopeCount,
    coveredScopeCount,
    scopeCoverageRatio: ratio(coveredScopeCount, scopesWithRequirements),
    requiredProviderUnitCount: input.requiredCount,
    terminalProviderUnitCount: input.terminalCount,
    providerUnitCoverageRatio: ratio(input.terminalCount, input.requiredCount),
  };
}

function indexProviderUnits(units: readonly ManifestProviderUnit[]): ReadonlyMap<string, ProviderProductionClass> {
  const map = new Map<string, ProviderProductionClass>();
  for (const unit of units) map.set(providerUnitKey(unit.providerKey, unit.unitKey), unit.productionClass);
  return map;
}

function indexScopes(scopes: readonly ManifestScope[]): ReadonlyMap<string, ManifestScope> {
  const map = new Map<string, ManifestScope>();
  for (const scope of scopes) map.set(scope.scopeRecordId, scope);
  return map;
}

function indexObserved(units: readonly ManifestObservedUnit[]): ReadonlyMap<string, ManifestObservedUnit> {
  const map = new Map<string, ManifestObservedUnit>();
  for (const unit of units) map.set(unitKey(unit.scopeRecordId, unit.providerKey, unit.unitKey), unit);
  return map;
}

function indexExplicitExclusions(
  exclusions: ProductionCatalogCompletionManifest["exclusions"],
): ReadonlyMap<string, CompletionExclusionReason> {
  const map = new Map<string, CompletionExclusionReason>();
  for (const exclusion of exclusions) {
    if (exclusion.scopeRecordId && exclusion.providerKey && exclusion.unitKey) {
      map.set(unitKey(exclusion.scopeRecordId, exclusion.providerKey, exclusion.unitKey), exclusion.reason);
    }
  }
  return map;
}

function orderedExpectedUnits(units: readonly ManifestExpectedUnit[]): readonly ManifestExpectedUnit[] {
  return [...units].sort((left, right) =>
    unitKey(left.scopeRecordId, left.providerKey, left.unitKey).localeCompare(
      unitKey(right.scopeRecordId, right.providerKey, right.unitKey),
    ),
  );
}

function orderedExclusionSummaries(
  counts: ReadonlyMap<CompletionExclusionReason, number>,
): readonly CompletionExclusionSummary[] {
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => left.reason.localeCompare(right.reason));
}

function orderedBlockers(blockers: readonly CompletionBlocker[]): readonly CompletionBlocker[] {
  return [...blockers].sort((left, right) => {
    const byCode = left.code.localeCompare(right.code);
    if (byCode !== 0) return byCode;
    return `${left.scopeRecordId ?? ""}${left.providerKey ?? ""}${left.unitKey ?? ""}`.localeCompare(
      `${right.scopeRecordId ?? ""}${right.providerKey ?? ""}${right.unitKey ?? ""}`,
    );
  });
}

function sortNumberRecord(map: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
  return numerator / denominator;
}
