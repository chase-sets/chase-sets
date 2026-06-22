import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchProviderTransportCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "../api/primary-workbench-admin-contracts";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogProviderProfileVersionReview,
  CatalogProviderSourceOptionKind,
} from "./contracts";
import {
  comparableImportScopeKey as comparableStructuredImportScopeKey,
  importScopeSegment as structuredImportScopeSegment,
} from "./primary-workbench-scope-context";

export { importScopeMatchesProviderScope, providerImportScopeSetId, scopeKey } from "./primary-workbench-scope-context";

export function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function firstRecord(values: readonly unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = recordValue(value);
    if (record) {
      return record;
    }
  }

  return null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function stringArrayValue(value: unknown): readonly string[] {
  return arrayValue(value).filter((entry): entry is string => typeof entry === "string");
}

export function recordKeys(value: unknown): readonly string[] {
  return Object.keys(recordValue(value) ?? {});
}

export function numberString(value: unknown): string {
  return typeof value === "number" ? String(value) : "";
}

export function expressionSummary(value: unknown): string {
  const expression = recordValue(value);
  const selector = recordValue(expression?.selector);
  const selectorKind = stringValue(selector?.kind);
  if (selectorKind === "path") {
    return stringValue(selector?.path) ?? "";
  }
  if (selectorKind === "template") {
    return stringValue(selector?.template) ?? "";
  }
  if (selectorKind === "constant") {
    const constantValue = selector?.value;
    return typeof constantValue === "string" ? constantValue : constantValue === undefined ? "" : String(constantValue);
  }
  if (selectorKind === "named-runtime-selector") {
    return stringValue(selector?.functionKey) ?? "";
  }

  return selectorKind ?? stringValue(expression?.owner) ?? "";
}

export function compactMappingSummary(summary: string): string {
  const trimmed = summary.trim() || "Configured mapping expression";
  if (trimmed.length <= 120) {
    return trimmed;
  }

  return `${trimmed.slice(0, 72)}...${trimmed.slice(-36)}`;
}

export function providerTransportFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  providerKey: string | null,
): readonly CatalogPrimaryWorkbenchProviderTransportCategory[] {
  const categories = new Set<CatalogPrimaryWorkbenchProviderTransportCategory>();
  for (const unit of overview?.readiness.units ?? []) {
    if (providerKey && unit.providerKey !== providerKey) {
      continue;
    }
    for (const diagnostic of unit.diagnostics) {
      if (diagnostic.source === "provider-adapter" && diagnostic.severity !== "info") {
        categories.add(providerTransportCategoryFor(diagnostic.code, diagnostic.message, diagnostic.retryAfterSeconds));
      }
    }
  }
  for (const provider of overview?.providerReadiness.providers ?? []) {
    if (providerKey && provider.providerKey !== providerKey) {
      continue;
    }
    for (const capability of [
      provider.apiReachability,
      provider.optionQueryHealth,
      provider.rateLimitStatus,
      provider.payloadAcquisition,
    ]) {
      if (capability.status === "blocked" || capability.status === "degraded") {
        for (const code of capability.diagnosticCodes) {
          categories.add(providerTransportCategoryFor(code, capability.message, null));
        }
      }
    }
    for (const diagnostic of provider.diagnostics) {
      if (diagnostic.severity !== "info") {
        categories.add(providerTransportCategoryFor(diagnostic.code, diagnostic.message, diagnostic.retryAfterSeconds));
      }
    }
  }

  return [...categories];
}

export function credentialBlockerFor(
  state: "not-required" | "configured" | "missing" | "invalid" | "expired" | "revoked" | "unknown",
): CatalogPrimaryWorkbenchBlockerCategory {
  if (state === "invalid" || state === "revoked") {
    return "provider-credential-invalid";
  }
  if (state === "expired") {
    return "provider-credential-expired";
  }

  return "provider-credential-missing";
}

export function providerTransportCategoryFor(
  code: string,
  message: string | null,
  retryAfterSeconds: number | null,
): CatalogPrimaryWorkbenchProviderTransportCategory {
  const text = `${code} ${message ?? ""}`.toLowerCase();
  if (text.includes("quota")) {
    return "quota";
  }
  if (text.includes("timeout")) {
    return "timeout";
  }
  if (text.includes("pagination") || text.includes("cursor")) {
    return "pagination-failure";
  }
  if (text.includes("partial")) {
    return "partial-data";
  }
  if (text.includes("stale") || text.includes("cache")) {
    return "stale-cache";
  }
  if (text.includes("rate")) {
    return "rate-limit";
  }
  if (retryAfterSeconds !== null || text.includes("throttle")) {
    return "throttle";
  }

  return "degraded-provider";
}

export function providerTransportBlockerFor(
  category: CatalogPrimaryWorkbenchProviderTransportCategory,
): CatalogPrimaryWorkbenchBlockerCategory {
  switch (category) {
    case "rate-limit":
      return "provider-transport-rate-limited";
    case "throttle":
      return "provider-transport-throttled";
    case "quota":
      return "provider-transport-quota-exceeded";
    case "timeout":
      return "provider-transport-timeout";
    case "pagination-failure":
      return "provider-transport-pagination-failure";
    case "partial-data":
      return "provider-transport-partial-data";
    case "stale-cache":
      return "provider-transport-stale-cache";
    case "degraded-provider":
      return "provider-transport-degraded";
  }
}

export function actionStateForBlockers(
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
  stateWhenUnblocked: CatalogPrimaryWorkbenchActionReadModel["state"],
): CatalogPrimaryWorkbenchActionReadModel["state"] {
  if (blockers.length === 0) {
    return stateWhenUnblocked;
  }
  if (blockers.includes("permission-denied") || blockers.includes("authorization-denied")) {
    return "denied";
  }
  if (blockers.every((blocker) => blocker === "selection-empty" || blocker === "no-promotion-eligible-observations")) {
    return "disabled";
  }
  if (blockers.includes("security-privacy-blocked")) {
    return "unsafe";
  }

  return "blocked";
}

export function profilePointerForProfile(
  profile: CatalogProviderProfileVersionReview | null,
): CatalogPrimaryWorkbenchReadModel["providerScope"]["providers"][number]["units"][number]["activeProfile"] {
  if (!profile) {
    return null;
  }

  return {
    schemaVersion: "catalog-provider-profile-version-v1",
    compatibilityPolicy: "provider-profile-version",
    providerKey: profile.providerKey,
    profileKey: profile.profileKey,
    profileVersion: profile.profileVersion,
    lifecycle: profile.lifecycle,
    active: profile.active,
    connectorKind: profile.connectorKind,
    connectorSourceVersion: null,
    sourceMappingFingerprint: null,
  };
}

export function sourceOptionKindsForProfile(
  profile: CatalogProviderProfileVersionReview | null | undefined,
): readonly CatalogProviderSourceOptionKind[] {
  return Array.isArray(profile?.sourceOptionKinds) ? profile.sourceOptionKinds : [];
}

export function normalizeUnitSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "catalog"
  );
}

export function sum<T>(items: readonly T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

export function comparableImportScopeKey(importScope: string | null, providerKey: string | null): string | null {
  return comparableStructuredImportScopeKey(importScope, providerKey);
}

export function importScopeSegment(importScope: string | null, index: number): string | null {
  return structuredImportScopeSegment(importScope, null, index);
}

export function setQueryParam(params: URLSearchParams, key: string, value: string | null | undefined): void {
  if (value) {
    params.set(key, value);
  }
}
