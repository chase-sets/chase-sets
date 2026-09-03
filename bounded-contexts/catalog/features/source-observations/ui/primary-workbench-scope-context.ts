import type {
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchScopeContext,
} from "../api/primary-workbench-admin-contracts";
import {
  providerImportScopeSecondSegmentIsExpansion,
  providerImportScopeSecondSegmentIsProductLine,
} from "../api/provider-import-scope-shape";
import type { SourceObservationIntegrationJobScope, SourceObservationIntegrationScope } from "./contracts";

export type CatalogPrimaryWorkbenchScopeQueryKey =
  | "productId"
  | "languageCode"
  | "productLineId"
  | "productLineName"
  | "seriesId"
  | "seriesName"
  | "expansionId"
  | "expansionName"
  | "status";

export const catalogPrimaryWorkbenchScopeQueryKeys: readonly CatalogPrimaryWorkbenchScopeQueryKey[] = [
  "productId",
  "languageCode",
  "productLineId",
  "productLineName",
  "seriesId",
  "seriesName",
  "expansionId",
  "expansionName",
  "status",
];

type ScopeFieldInput = Partial<Record<CatalogPrimaryWorkbenchScopeQueryKey | "providerKey", string | null>>;

const emptyScope: CatalogPrimaryWorkbenchScopeContext = {
  providerKey: null,
  productId: null,
  languageCode: null,
  productLineId: null,
  productLineName: null,
  seriesId: null,
  seriesName: null,
  expansionId: null,
  expansionName: null,
  status: null,
};

export function emptyCatalogPrimaryWorkbenchScopeContext(
  providerKey: string | null = null,
): CatalogPrimaryWorkbenchScopeContext {
  return { ...emptyScope, providerKey: clean(providerKey) };
}

export function scopeContextFromRouteContext(
  context: Pick<
    CatalogPrimaryWorkbenchRouteContext,
    "providerKey" | "importScope" | "sourceObservationFilters" | "scope"
  >,
): CatalogPrimaryWorkbenchScopeContext {
  const importScope = importScopeForStructuredMerge(context.importScope, context.scope);
  return mergeScopeContexts(
    scopeContextFromImportScope(importScope, context.providerKey),
    context.scope,
    scopeContextFromFields({
      providerKey: context.providerKey,
      status: context.sourceObservationFilters.status ?? null,
    }),
  );
}

export function scopeContextFromSearchParams(input: {
  searchParams: URLSearchParams;
  providerKey: string | null;
  importScope: string | null;
  sourceObservationFilters: Readonly<Record<string, string>>;
}): CatalogPrimaryWorkbenchScopeContext {
  const explicitLanguageCode = input.searchParams.get("languageCode") ?? input.searchParams.get("language");
  const explicitProductLineId = input.searchParams.get("productLineId");
  const explicitProductLineName = input.searchParams.get("productLineName");
  const explicitSeriesId = input.searchParams.get("seriesId");
  const explicitSeriesName = input.searchParams.get("seriesName");
  const explicitExpansionId = input.searchParams.get("expansionId") ?? input.searchParams.get("setId");
  const explicitExpansionName = input.searchParams.get("expansionName") ?? input.searchParams.get("setName");
  const explicitScope = scopeContextFromFields({
    providerKey: input.providerKey,
    productId: input.searchParams.get("productId"),
    languageCode: explicitLanguageCode,
    productLineId: explicitProductLineId,
    productLineName: explicitProductLineName,
    seriesId: explicitSeriesId,
    seriesName: explicitSeriesName,
    expansionId: explicitExpansionId,
    expansionName: explicitExpansionName,
    status: input.searchParams.get("status") ?? input.sourceObservationFilters.status ?? null,
  });
  const importScope = importScopeForStructuredMerge(input.importScope, explicitScope);

  return mergeScopeContexts(scopeContextFromImportScope(importScope, input.providerKey), explicitScope);
}

export function scopeContextFromFormData(
  formData: FormData,
  fallback: CatalogPrimaryWorkbenchScopeContext,
): CatalogPrimaryWorkbenchScopeContext {
  const merged = mergeScopeContexts(
    fallback,
    scopeContextFromFields({
      providerKey: formString(formData, "providerKey"),
      productId: formString(formData, "productId"),
      languageCode: formString(formData, "languageCode") ?? formString(formData, "language"),
      productLineId: formString(formData, "productLineId"),
      productLineName: formString(formData, "productLineName"),
      seriesId: formString(formData, "seriesId"),
      seriesName: formString(formData, "seriesName"),
      expansionId: formString(formData, "expansionId") ?? formString(formData, "setId"),
      expansionName: formString(formData, "expansionName") ?? formString(formData, "setName"),
      status: formString(formData, "status"),
    }),
  );
  return formData.has("productId") ? { ...merged, productId: formString(formData, "productId") } : merged;
}

export function scopeContextFromFields(fields: ScopeFieldInput): CatalogPrimaryWorkbenchScopeContext {
  return {
    providerKey: clean(fields.providerKey),
    productId: clean(fields.productId),
    languageCode: clean(fields.languageCode),
    productLineId: clean(fields.productLineId),
    productLineName: clean(fields.productLineName),
    seriesId: clean(fields.seriesId),
    seriesName: clean(fields.seriesName),
    expansionId: clean(fields.expansionId),
    expansionName: clean(fields.expansionName),
    status: clean(fields.status),
  };
}

export function scopeContextFromImportScope(
  importScope: string | null,
  providerKey: string | null,
): CatalogPrimaryWorkbenchScopeContext {
  const segments = importScopeSegments(importScope);
  if (segments.length === 0) {
    return emptyCatalogPrimaryWorkbenchScopeContext(providerKey);
  }

  const [languageCode, second, third, fourth] = segments;
  if (segments.length >= 4) {
    return scopeContextFromFields({
      providerKey,
      languageCode,
      productLineId: second,
      seriesId: third,
      expansionId: fourth,
    });
  }

  if (segments.length === 3) {
    return scopeContextFromFields({
      providerKey,
      languageCode,
      seriesId: second,
      expansionId: third,
    });
  }

  if (segments.length === 2) {
    const secondSegmentIsProductLine = providerImportScopeSecondSegmentIsProductLine(providerKey);
    const secondSegmentIsExpansion = providerImportScopeSecondSegmentIsExpansion(providerKey);
    return scopeContextFromFields({
      providerKey,
      languageCode,
      productLineId: secondSegmentIsProductLine ? second : null,
      seriesId: secondSegmentIsProductLine || secondSegmentIsExpansion ? null : second,
      expansionId: secondSegmentIsExpansion ? second : null,
    });
  }

  return scopeContextFromFields({ providerKey, languageCode });
}

export function scopeContextFromProviderScope(
  scope: SourceObservationIntegrationScope,
): CatalogPrimaryWorkbenchScopeContext {
  return scopeContextFromFields({
    providerKey: scope.provider_key,
    languageCode: scope.language_code,
    productLineId: scope.product_line_id,
    productLineName: scope.product_line_name,
    seriesId: scope.series_id,
    seriesName: scope.series_name,
    expansionId: scope.expansion_id,
    expansionName: scope.expansion_name,
  });
}

export function importScopeFromScopeContext(scope: CatalogPrimaryWorkbenchScopeContext | undefined): string | null {
  if (!scope?.languageCode) {
    return null;
  }

  if (scope.productId) {
    // Keep the existing job identity; only the explicit productId route field
    // identifies a product. Parsing a compact en:X alone still means a set.
    return [scope.languageCode, scope.productId].join(":");
  }

  const expansion = scope.expansionId ?? scope.expansionName;
  const segments = [scope.languageCode, scope.productLineId, scope.seriesId, expansion].filter(
    (segment): segment is string => Boolean(segment),
  );

  return segments.length > 0 ? segments.join(":") : null;
}

export function scopeKey(scope: SourceObservationIntegrationScope): string {
  return importScopeFromScopeContext(scopeContextFromProviderScope(scope)) ?? "";
}

export function scopeContextToIntegrationJobScope(
  scope: CatalogPrimaryWorkbenchScopeContext & {
    ingestionUnitKey?: string | null;
    profileKey?: string | null;
  },
): SourceObservationIntegrationJobScope {
  return compactScope({
    provider: scope.providerKey ?? undefined,
    profileKey: scope.profileKey ?? undefined,
    ingestionUnitKey: scope.ingestionUnitKey ?? undefined,
    language: scope.languageCode ?? undefined,
    productLineId: scope.productLineId ?? undefined,
    seriesId: scope.seriesId ?? undefined,
    setId: scope.expansionId ?? undefined,
    setName: scope.expansionName ?? undefined,
    productId: scope.productId ?? undefined,
  });
}

export type CatalogPrimaryWorkbenchObservationFilterScope = Readonly<{
  search?: string;
  status?: string;
  provider?: string;
  language?: string;
  productLineId?: string;
  seriesId?: string;
  expansionId?: string;
  setId?: string;
}>;

export function scopeContextToObservationFilterScope(
  scope: CatalogPrimaryWorkbenchScopeContext,
  filters: Readonly<Record<string, string>> = {},
): CatalogPrimaryWorkbenchObservationFilterScope {
  const expansionId = filterScopeValue(
    scope,
    filters.expansionId ?? filters.setId ?? scope.expansionId ?? scope.expansionName,
  );
  return compactScope({
    provider: scope.providerKey ?? undefined,
    language: filterScopeValue(scope, filters.language ?? scope.languageCode) ?? undefined,
    productLineId: filterScopeValue(scope, filters.productLineId ?? scope.productLineId) ?? undefined,
    seriesId: filterScopeValue(scope, filters.seriesId ?? scope.seriesId) ?? undefined,
    expansionId: expansionId ?? undefined,
    setId: expansionId ?? undefined,
    status: filters.status ?? scope.status ?? undefined,
    search: filters.search ?? undefined,
  });
}

export function importScopeMatchesProviderScope(
  importScope: string | null,
  scope: SourceObservationIntegrationScope,
): boolean {
  return scopeContextMatchesProviderScope(scopeContextFromImportScope(importScope, scope.provider_key), scope);
}

export function scopeContextMatchesProviderScope(
  context: CatalogPrimaryWorkbenchScopeContext,
  scope: SourceObservationIntegrationScope,
): boolean {
  const providerKey = context.providerKey ?? scope.provider_key;
  return (
    !context.productId &&
    optionalFieldMatches(context.providerKey, scope.provider_key, providerKey) &&
    optionalFieldMatches(context.languageCode, scope.language_code, providerKey) &&
    optionalFieldMatches(context.productLineId, scope.product_line_id, providerKey) &&
    optionalFieldMatches(context.productLineName, scope.product_line_name, providerKey) &&
    optionalFieldMatches(context.seriesId, scope.series_id, providerKey) &&
    optionalFieldMatches(context.seriesName, scope.series_name, providerKey) &&
    optionalAnyFieldMatches(context.expansionId, [scope.expansion_id], providerKey) &&
    optionalAnyFieldMatches(context.expansionName, [scope.expansion_name, scope.expansion_id], providerKey)
  );
}

export function compactExpansionRouteScopeMatchesProviderScope(
  context: CatalogPrimaryWorkbenchScopeContext,
  scope: SourceObservationIntegrationScope,
): boolean {
  const providerKey = context.providerKey ?? scope.provider_key;
  if (context.productId || !providerImportScopeSecondSegmentIsExpansion(providerKey)) {
    return false;
  }

  const providerScope = scopeContextFromProviderScope(scope);
  return (
    optionalFieldMatches(context.providerKey, scope.provider_key, providerKey) &&
    optionalFieldMatches(context.languageCode, scope.language_code, providerKey) &&
    optionalScopePairMatches(
      [context.productLineId, context.productLineName],
      [providerScope.productLineId, providerScope.productLineName],
      providerKey,
    ) &&
    optionalScopePairMatches(
      [context.seriesId, context.seriesName],
      [providerScope.seriesId, providerScope.seriesName],
      providerKey,
    ) &&
    optionalScopePairMatches(
      [context.expansionId, context.expansionName],
      [providerScope.expansionId, providerScope.expansionName],
      providerKey,
    )
  );
}

export function comparableImportScopeKey(importScope: string | null, providerKey: string | null): string | null {
  const key = importScopeFromScopeContext(scopeContextFromImportScope(importScope, providerKey));
  return comparableScopeValue(key, providerKey);
}

export function scopeDisplayLabel(scope: CatalogPrimaryWorkbenchScopeContext): string {
  const segments = [
    scope.providerKey,
    scope.languageCode,
    scope.productLineName ?? scope.productLineId,
    scope.seriesName ?? scope.seriesId,
    scope.expansionName ?? scope.expansionId,
    scope.productId,
    scope.status,
  ].filter((segment): segment is string => Boolean(segment));

  return segments.length > 0 ? segments.join(" / ") : "All provider observations";
}

export function scopeContextToQueryParams(scope: CatalogPrimaryWorkbenchScopeContext): URLSearchParams {
  const params = new URLSearchParams();
  setParam(params, "providerKey", scope.providerKey);
  setParam(params, "productId", scope.productId);
  setParam(params, "languageCode", scope.languageCode);
  setParam(params, "productLineId", scope.productLineId);
  setParam(params, "productLineName", scope.productLineName);
  setParam(params, "seriesId", scope.seriesId);
  setParam(params, "seriesName", scope.seriesName);
  setParam(params, "expansionId", scope.expansionId);
  setParam(params, "expansionName", scope.expansionName);
  setParam(params, "status", scope.status);
  return params;
}

export function importScopeSegment(
  importScope: string | null,
  providerKey: string | null,
  index: number,
): string | null {
  const scope = scopeContextFromImportScope(importScope, providerKey);
  const segments = [
    scope.languageCode,
    scope.productLineId,
    scope.seriesId,
    scope.expansionId ?? scope.expansionName,
  ].filter((segment): segment is string => Boolean(segment));

  return segments[index] ?? null;
}

export function providerImportScopeSetId(providerKey: string | null, importScope: string | null): string | null {
  const setId = scopeContextFromImportScope(importScope, providerKey).expansionId;
  return comparableScopeValue(setId, providerKey);
}

function mergeScopeContexts(
  base: CatalogPrimaryWorkbenchScopeContext | undefined,
  ...overrides: readonly (CatalogPrimaryWorkbenchScopeContext | undefined)[]
): CatalogPrimaryWorkbenchScopeContext {
  return overrides.reduce<CatalogPrimaryWorkbenchScopeContext>(
    (merged, override) => ({
      providerKey: override?.providerKey ?? merged.providerKey,
      productId: override?.productId ?? merged.productId,
      languageCode: override?.languageCode ?? merged.languageCode,
      productLineId: override?.productLineId ?? merged.productLineId,
      productLineName: override?.productLineName ?? merged.productLineName,
      seriesId: override?.seriesId ?? merged.seriesId,
      seriesName: override?.seriesName ?? merged.seriesName,
      expansionId: override?.expansionId ?? merged.expansionId,
      expansionName: override?.expansionName ?? merged.expansionName,
      status: override?.status ?? merged.status,
    }),
    base ?? emptyScope,
  );
}

function importScopeSegments(importScope: string | null): readonly string[] {
  return (importScope ?? "")
    .split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function importScopeForStructuredMerge(
  importScope: string | null,
  explicitScope: CatalogPrimaryWorkbenchScopeContext | undefined,
): string | null {
  if (!importScope || !explicitScope) {
    return importScope;
  }
  if (explicitScope.productId) return null;
  const segments = importScopeSegments(importScope);
  const expansionSegment = segments.at(-1) ?? null;
  const explicitExpansion = explicitScope.expansionId ?? explicitScope.expansionName;
  const languageMatches = !explicitScope.languageCode || segments[0] === explicitScope.languageCode;
  if (
    explicitExpansion &&
    expansionSegment &&
    comparableScopeValue(explicitExpansion, explicitScope.providerKey) !==
      comparableScopeValue(expansionSegment, explicitScope.providerKey)
  ) {
    return null;
  }

  if (
    explicitScope.expansionId &&
    !explicitScope.productLineId &&
    !explicitScope.seriesId &&
    expansionSegment &&
    segments.length === 2 &&
    languageMatches &&
    comparableScopeValue(explicitScope.expansionId, explicitScope.providerKey) ===
      comparableScopeValue(expansionSegment, explicitScope.providerKey)
  ) {
    return null;
  }

  if (
    explicitScope.productLineId &&
    !explicitScope.seriesId &&
    explicitExpansion &&
    segments.length === 3 &&
    segments[1] === explicitScope.productLineId &&
    segments[2] === explicitExpansion &&
    languageMatches
  ) {
    return null;
  }

  if (!explicitScope.expansionId && explicitScope.expansionName && expansionSegment === explicitScope.expansionName) {
    const parentScope = segments.slice(0, -1).join(":");
    return parentScope || null;
  }

  return importScope;
}

function optionalFieldMatches(expected: string | null, actual: string, providerKey: string | null): boolean {
  return !expected || comparableScopeValue(expected, providerKey) === comparableScopeValue(actual, providerKey);
}

function optionalAnyFieldMatches(
  expected: string | null,
  actualValues: readonly string[],
  providerKey: string | null,
): boolean {
  return (
    !expected ||
    actualValues.some(
      (actual) => comparableScopeValue(expected, providerKey) === comparableScopeValue(actual, providerKey),
    )
  );
}

function optionalScopePairMatches(
  expectedValues: readonly (string | null)[],
  actualValues: readonly (string | null)[],
  providerKey: string | null,
): boolean {
  const expected = expectedValues.filter((value): value is string => Boolean(value));
  return (
    expected.length === 0 ||
    expected.some((value) =>
      actualValues.some(
        (actual) => comparableScopeValue(value, providerKey) === comparableScopeValue(actual, providerKey),
      ),
    )
  );
}

function comparableScopeValue(value: string | null | undefined, providerKey: string | null): string | null {
  const cleaned = clean(value);
  return providerKey === "tcgdex" ? (cleaned?.toLowerCase() ?? null) : cleaned;
}

function filterScopeValue(scope: CatalogPrimaryWorkbenchScopeContext, value: string | null | undefined): string | null {
  return comparableScopeValue(value, scope.providerKey);
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" ? clean(value) : null;
}

function setParam(params: URLSearchParams, key: string, value: string | null): void {
  if (value) {
    params.set(key, value);
  }
}

function compactScope<T extends Record<string, string | undefined>>(scope: T): T {
  return Object.fromEntries(Object.entries(scope).filter(([, value]) => value)) as T;
}
