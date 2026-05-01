export type ProviderFailureCategory =
  | "configuration"
  | "authentication"
  | "capability_missing"
  | "balance_insufficient"
  | "provider_unavailable"
  | "provider_declined"
  | "unknown";

export class ProviderAdapterError extends Error {
  public constructor(
    public readonly category: ProviderFailureCategory,
    message: string,
    public readonly providerStatus?: number,
  ) {
    super(message);
    this.name = "ProviderAdapterError";
  }
}

export function providerFailureCategoryFromHttpStatus(
  status: number,
): ProviderFailureCategory {
  if (status === 401 || status === 403) {
    return "authentication";
  }
  if (status === 400 || status === 404) {
    return "configuration";
  }
  if (status === 402) {
    return "provider_declined";
  }
  if (status === 409) {
    return "capability_missing";
  }
  if (status === 429 || status >= 500) {
    return "provider_unavailable";
  }
  return "unknown";
}

export function providerFailureCategoryFromText(
  value: string,
  fallback: ProviderFailureCategory = "unknown",
): ProviderFailureCategory {
  const normalized = value.toLowerCase();
  if (normalized.includes("balance") || normalized.includes("insufficient")) {
    return "balance_insufficient";
  }
  if (normalized.includes("capability") || normalized.includes("requirement")) {
    return "capability_missing";
  }
  if (normalized.includes("api key") || normalized.includes("auth")) {
    return "authentication";
  }
  if (normalized.includes("config") || normalized.includes("url")) {
    return "configuration";
  }
  return fallback;
}
