import type {
  SourceObservationIntegrationImportPreview,
  SourceObservationIntegrationImportPreviewTarget,
  SourceObservationIntegrationJobScope,
  SourceObservationProviderUsageEstimate,
} from "../../ui/contracts";
import type { CatalogPrimaryWorkbenchRouteContext } from "./primary-workbench-admin-contracts";

export type CatalogDailyImportPreview =
  | Readonly<{
      status: "ready";
      preview: SourceObservationIntegrationImportPreview;
      usageSummary: CatalogImportPreviewUsageSummary;
    }>
  | Readonly<{ status: "unavailable" }>
  | null;

export type CatalogImportPreviewUsageSummary = Readonly<{
  requestStrategy: SourceObservationProviderUsageEstimate["requestStrategy"] | null;
  estimateState: SourceObservationProviderUsageEstimate["estimateState"] | null;
  estimatedRequestCount: number | null;
  estimateReason: string | null;
  usageCheckState: SourceObservationProviderUsageEstimate["usageCheckState"] | null;
  pageSize: number | null;
  selectedFields: readonly string[];
  perRecordFallbackReason: string | null;
  creditDiagnostic: string | null;
  degradedDiagnostic: string | null;
}>;

// Both the planned scope and the selected route must accept the echoed evidence.
export function catalogImportPreviewMatchesSelection(
  preview: SourceObservationIntegrationImportPreview,
  expected: SourceObservationIntegrationJobScope,
  context: CatalogPrimaryWorkbenchRouteContext,
): boolean {
  return (
    matchesScope(preview, expected) &&
    matchesScope(preview, {
      provider: context.providerKey ?? undefined,
      ingestionUnitKey: context.unitKey ?? undefined,
      productId: context.scope?.productId ?? undefined,
      language: context.scope?.languageCode ?? undefined,
      productLineId: context.scope?.productLineId ?? undefined,
      seriesId: context.scope?.seriesId ?? undefined,
      setId: context.scope?.expansionId ?? undefined,
      setName: context.scope?.expansionName ?? undefined,
    })
  );
}

function matchesScope(
  preview: SourceObservationIntegrationImportPreview,
  expected: SourceObservationIntegrationJobScope,
): boolean {
  const normalize = (value: string | null | undefined) => value?.trim().toLowerCase() || null;
  const matches = (actual: string | null | undefined, value: string | null | undefined) =>
    !normalize(value) || normalize(actual) === normalize(value);
  const sets = [expected.setId, expected.setName].map(normalize).filter(Boolean);
  const actualSets = [preview.scope.setId, preview.scope.setName].map(normalize);
  return (
    matches(preview.providerKey, expected.provider) &&
    matches(preview.scope.provider, expected.provider) &&
    matches(preview.scope.ingestionUnitKey, expected.ingestionUnitKey) &&
    matches(preview.scope.language, expected.language) &&
    matches(preview.scope.productLineId, expected.productLineId) &&
    matches(preview.scope.seriesId, expected.seriesId) &&
    (sets.length === 0 || sets.some((value) => actualSets.includes(value))) &&
    (preview.scope.productId ?? null) === (expected.productId ?? null)
  );
}

export function summarizeCatalogImportPreviewUsage(
  targets: readonly SourceObservationIntegrationImportPreviewTarget[],
): CatalogImportPreviewUsageSummary {
  const estimates = targets
    .map((target) => target.usageEstimate)
    .filter((value): value is SourceObservationProviderUsageEstimate => value !== null);
  if (estimates.length === 0)
    return {
      requestStrategy: null,
      estimateState: null,
      estimatedRequestCount: null,
      estimateReason: null,
      usageCheckState: null,
      pageSize: null,
      selectedFields: [],
      perRecordFallbackReason: null,
      creditDiagnostic: null,
      degradedDiagnostic: null,
    };
  return {
    requestStrategy: commonValue(estimates.map((estimate) => estimate.requestStrategy)),
    estimateState: estimates.some((estimate) => estimate.estimateState === "estimate-unavailable")
      ? "estimate-unavailable"
      : "estimated",
    estimatedRequestCount: estimates.every((estimate) => estimate.estimatedRequestCount !== null)
      ? estimates.reduce((total, estimate) => total + (estimate.estimatedRequestCount ?? 0), 0)
      : null,
    estimateReason:
      (
        estimates.find((estimate) => estimate.estimateState === "estimate-unavailable" && estimate.estimateReason) ??
        estimates.find((estimate) => estimate.estimateReason)
      )?.estimateReason ?? null,
    usageCheckState: commonValue(estimates.map((estimate) => estimate.usageCheckState)),
    pageSize: commonValue(estimates.map((estimate) => estimate.pageSize)),
    selectedFields: [...new Set(estimates.flatMap((estimate) => estimate.selectedFields).filter(Boolean))],
    perRecordFallbackReason:
      estimates.find((estimate) => estimate.perRecordFallbackReason)?.perRecordFallbackReason ?? null,
    creditDiagnostic: estimates.find((estimate) => estimate.creditDiagnostic)?.creditDiagnostic ?? null,
    degradedDiagnostic: estimates.find((estimate) => estimate.degradedDiagnostic)?.degradedDiagnostic ?? null,
  };
}

function commonValue<T>(values: readonly T[]): T | null {
  const [first, ...rest] = values;
  return first !== undefined && rest.every((value) => value === first) ? first : null;
}

export class CatalogImportPreviewTimeoutError extends Error {}

export function boundCatalogImportPreview<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new CatalogImportPreviewTimeoutError()), 2_500);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
