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

export type ProviderWebhookEndpoint = "payments" | "settlement";

export type ProviderWebhookFailureClass =
  | "signature-invalid"
  | "unknown-event"
  | "schema-mismatch"
  | "handler-failure"
  | "inbox-conflict";

export type ProviderWebhookTelemetryEvent = Readonly<{
  endpoint: ProviderWebhookEndpoint;
  failureClass: ProviderWebhookFailureClass | null;
  outcome: "processed" | "ignored" | "failed";
  statusCode: number;
  retryable: boolean;
  providerEventId?: string | null;
  eventKind?: string | null;
}>;

export type ProviderWebhookTelemetry = Readonly<{
  record: (event: ProviderWebhookTelemetryEvent) => void;
}>;

export class ProviderWebhookError extends Error {
  public constructor(
    public readonly failureClass: ProviderWebhookFailureClass,
    message: string,
    public readonly providerEventId: string | null = null,
    public readonly eventKind: string | null = null,
    public readonly retryable: boolean = failureClass === "signature-invalid" || failureClass === "handler-failure",
    public readonly causeError?: unknown,
  ) {
    super(message);
    this.name = "ProviderWebhookError";
  }
}

export function providerWebhookErrorFromUnknown(
  error: unknown,
  options: Readonly<{
    providerEventId?: string | null;
    eventKind?: string | null;
  }> = {},
): ProviderWebhookError {
  if (error instanceof ProviderWebhookError) {
    return error;
  }

  const message = error instanceof Error ? error.message : "Provider webhook handler failed.";
  const normalized = message.toLowerCase();
  const failureClass: ProviderWebhookFailureClass =
    normalized.includes("signature") || normalized.includes("webhook secret") ? "signature-invalid" : "handler-failure";

  return new ProviderWebhookError(
    failureClass,
    message,
    options.providerEventId ?? null,
    options.eventKind ?? null,
    failureClass === "signature-invalid" || failureClass === "handler-failure",
    error,
  );
}

export function providerFailureCategoryFromHttpStatus(status: number): ProviderFailureCategory {
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
