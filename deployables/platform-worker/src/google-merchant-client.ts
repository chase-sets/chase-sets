import type { GoogleShoppingPayloadInput } from "@chase-sets/discovery/server";
import type { PlatformWorkerGoogleMerchantConfig } from "./config";

type FetchFunction = typeof fetch;

export type GoogleMerchantOperation =
  | "insert-product-input"
  | "patch-product-input"
  | "delete-product-input"
  | "get-processed-product";

export type GoogleMerchantClientRequestSummary = Readonly<{
  method: "DELETE" | "GET" | "PATCH" | "POST";
  operation: GoogleMerchantOperation;
  url: string;
  body?: unknown;
  updateMask?: readonly string[];
}>;

export type GoogleMerchantClientError = Readonly<{
  code: string;
  message: string;
  httpStatus: number | null;
  retryable: boolean;
  providerRequestId: string | null;
  details?: unknown;
}>;

export type GoogleMerchantProductIssue = Readonly<{
  code: string | null;
  severity: string | null;
  resolution: string | null;
  attribute: string | null;
  reportingContext: string | null;
  description: string | null;
  detail: string | null;
  documentation: string | null;
  applicableCountries: readonly string[];
}>;

export type GoogleMerchantProductDiagnostics = Readonly<{
  productName: string;
  destinationStatuses: readonly unknown[];
  issues: readonly GoogleMerchantProductIssue[];
}>;

export type GoogleMerchantClientResult =
  | Readonly<{
      status: "success";
      operation: GoogleMerchantOperation;
      request: GoogleMerchantClientRequestSummary;
      attempts: number;
      productInputName: string | null;
      productName: string | null;
      diagnostics?: GoogleMerchantProductDiagnostics;
    }>
  | Readonly<{
      status: "dry-run";
      operation: GoogleMerchantOperation;
      request: GoogleMerchantClientRequestSummary;
      attempts: 0;
    }>
  | Readonly<{
      status: "permanent-failure" | "transient-failure";
      operation: GoogleMerchantOperation;
      request: GoogleMerchantClientRequestSummary;
      attempts: number;
      error: GoogleMerchantClientError;
    }>;

export type GoogleMerchantAccessTokenProvider = () => Promise<string>;

export type GoogleMerchantClientLogger = Readonly<{
  info?: (message: string, attributes?: Record<string, unknown>) => void;
  warn?: (message: string, attributes?: Record<string, unknown>) => void;
}>;

export type GoogleMerchantClientOptions = Readonly<{
  config: PlatformWorkerGoogleMerchantConfig;
  accessTokenProvider: GoogleMerchantAccessTokenProvider;
  fetch?: FetchFunction;
  baseUrl?: string;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
  logger?: GoogleMerchantClientLogger;
}>;

type GoogleMerchantEnabledConfig = Extract<PlatformWorkerGoogleMerchantConfig, { syncEnabled: true }>;

type GoogleProductInput = Readonly<{
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  productAttributes: GoogleProductAttributes;
  customAttributes?: readonly GoogleCustomAttribute[];
}>;

type GoogleProductAttributes = Readonly<{
  title?: string;
  description?: string;
  link?: string;
  imageLink?: string;
  price?: GooglePrice;
  availability?: "IN_STOCK" | "OUT_OF_STOCK";
  condition?: "NEW" | "USED";
  brand?: string;
  gtins?: readonly string[];
  mpn?: string;
  identifierExists?: boolean;
  productTypes?: readonly string[];
  googleProductCategory?: string;
  productDetails?: readonly GoogleProductDetail[];
  shipping?: readonly GoogleShipping[];
  returnPolicyLabel?: string;
  externalSellerId?: string;
  targetCountry?: string;
}>;

type GoogleProductDetail = Readonly<{
  sectionName: string;
  attributeName: string;
  attributeValue: string;
}>;

type GoogleShipping = Readonly<{
  country: string;
  service?: string;
  price?: GooglePrice;
}>;

type GooglePrice = Readonly<{
  amountMicros: string;
  currencyCode: string;
}>;

type GoogleCustomAttribute = Readonly<{
  name: string;
  value: string;
}>;

type BuiltRequest = Readonly<{
  operation: GoogleMerchantOperation;
  method: GoogleMerchantClientRequestSummary["method"];
  url: string;
  safeUrl: string;
  body?: unknown;
  updateMask?: readonly string[];
}>;

const defaultBaseUrl = "https://merchantapi.googleapis.com";
const defaultMaxAttempts = 3;
const defaultRetryBaseDelayMs = 250;
const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function createGoogleMerchantApiClient(options: GoogleMerchantClientOptions) {
  return new GoogleMerchantApiClient(options);
}

export class GoogleMerchantApiClient {
  private readonly config: PlatformWorkerGoogleMerchantConfig;
  private readonly accessTokenProvider: GoogleMerchantAccessTokenProvider;
  private readonly fetch: FetchFunction;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly logger?: GoogleMerchantClientLogger;

  constructor(options: GoogleMerchantClientOptions) {
    this.config = options.config;
    this.accessTokenProvider = options.accessTokenProvider;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/$/, "");
    this.maxAttempts = Math.max(1, options.maxAttempts ?? defaultMaxAttempts);
    this.retryBaseDelayMs = Math.max(1, options.retryBaseDelayMs ?? defaultRetryBaseDelayMs);
    this.sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
    this.logger = options.logger;
  }

  async insertOrUpdateProductInput(payload: GoogleShoppingPayloadInput): Promise<GoogleMerchantClientResult> {
    if (!this.config.syncEnabled) {
      return this.disabledResult("insert-product-input");
    }
    return this.sendJsonRequest(this.buildInsertRequest(payload));
  }

  async patchPriceAndAvailability(
    offerId: string,
    input: Readonly<{
      priceAmount: string;
      currencyCode: string;
      availability: GoogleShoppingPayloadInput["availability"];
    }>,
  ): Promise<GoogleMerchantClientResult> {
    if (!this.config.syncEnabled) {
      return this.disabledResult("patch-product-input");
    }
    return this.sendJsonRequest(this.buildPatchRequest(offerId, input));
  }

  async deleteProductInput(offerId: string): Promise<GoogleMerchantClientResult> {
    if (!this.config.syncEnabled) {
      return this.disabledResult("delete-product-input");
    }
    return this.sendJsonRequest(this.buildDeleteRequest(offerId));
  }

  async getProcessedProductStatus(offerId: string): Promise<GoogleMerchantClientResult> {
    if (!this.config.syncEnabled) {
      return this.disabledResult("get-processed-product");
    }
    return this.sendJsonRequest(this.buildGetProcessedProductRequest(offerId));
  }

  buildProductInputRequestBody(payload: GoogleShoppingPayloadInput): GoogleProductInput {
    const attributes = compactObject<GoogleProductAttributes>({
      title: payload.title,
      description: payload.description,
      link: payload.link,
      imageLink: payload.imageLink,
      price: toGooglePrice(payload.priceAmount, payload.currencyCode),
      availability: toGoogleAvailability(payload.availability),
      condition: toGoogleCondition(payload.condition),
      brand: payload.brand,
      gtins: payload.gtin ? [payload.gtin] : undefined,
      mpn: payload.mpn,
      identifierExists: payload.identifierExists,
      productTypes: payload.productType ? [payload.productType] : undefined,
      googleProductCategory: payload.googleProductCategory,
      productDetails: payload.productDetails,
      shipping: payload.shipping
        ? [
            compactObject<GoogleShipping>({
              country: payload.shipping.country,
              service: payload.shipping.service,
              price: payload.shipping.price
                ? toGooglePrice(payload.shipping.price.amount, payload.shipping.price.currencyCode)
                : undefined,
            }),
          ]
        : undefined,
      returnPolicyLabel: payload.returnPolicyLabel,
      externalSellerId: payload.externalSellerId,
      targetCountry: payload.targetCountry,
    });

    return {
      offerId: payload.offerId,
      contentLanguage: payload.contentLanguage,
      feedLabel: payload.feedLabel,
      productAttributes: attributes,
    };
  }

  buildProductName(offerId: string) {
    const enabledConfig = requireEnabledConfig(this.config);
    return `${accountName(enabledConfig)}/products/${encodeProductId(
      enabledConfig.contentLanguage,
      enabledConfig.feedLabel,
      offerId,
    )}`;
  }

  buildProductInputName(offerId: string) {
    const enabledConfig = requireEnabledConfig(this.config);
    return `${accountName(enabledConfig)}/productInputs/${encodeProductId(
      enabledConfig.contentLanguage,
      enabledConfig.feedLabel,
      offerId,
    )}`;
  }

  private buildInsertRequest(payload: GoogleShoppingPayloadInput): BuiltRequest {
    const enabledConfig = requireEnabledConfig(this.config);
    const url = new URL(`${this.baseUrl}/products/v1/${accountName(enabledConfig)}/productInputs:insert`);
    url.searchParams.set("dataSource", dataSourceName(enabledConfig));

    return {
      operation: "insert-product-input",
      method: "POST",
      url: url.toString(),
      safeUrl: redactMerchantUrl(url),
      body: this.buildProductInputRequestBody(payload),
    };
  }

  private buildPatchRequest(
    offerId: string,
    input: Readonly<{
      priceAmount: string;
      currencyCode: string;
      availability: GoogleShoppingPayloadInput["availability"];
    }>,
  ): BuiltRequest {
    const enabledConfig = requireEnabledConfig(this.config);
    const updateMask = ["productAttributes.price", "productAttributes.availability"];
    const url = new URL(`${this.baseUrl}/products/v1/${this.buildProductInputName(offerId)}`);
    url.searchParams.set("updateMask", updateMask.join(","));
    url.searchParams.set("dataSource", dataSourceName(enabledConfig));

    return {
      operation: "patch-product-input",
      method: "PATCH",
      url: url.toString(),
      safeUrl: redactMerchantUrl(url),
      updateMask,
      body: {
        offerId,
        contentLanguage: enabledConfig.contentLanguage,
        feedLabel: enabledConfig.feedLabel,
        productAttributes: {
          price: toGooglePrice(input.priceAmount, input.currencyCode),
          availability: toGoogleAvailability(input.availability),
        },
      },
    };
  }

  private buildDeleteRequest(offerId: string): BuiltRequest {
    const enabledConfig = requireEnabledConfig(this.config);
    const url = new URL(`${this.baseUrl}/products/v1/${this.buildProductInputName(offerId)}`);
    url.searchParams.set("dataSource", dataSourceName(enabledConfig));

    return {
      operation: "delete-product-input",
      method: "DELETE",
      url: url.toString(),
      safeUrl: redactMerchantUrl(url),
    };
  }

  private buildGetProcessedProductRequest(offerId: string): BuiltRequest {
    const url = new URL(`${this.baseUrl}/products/v1/${this.buildProductName(offerId)}`);

    return {
      operation: "get-processed-product",
      method: "GET",
      url: url.toString(),
      safeUrl: redactMerchantUrl(url),
    };
  }

  private async sendJsonRequest(request: BuiltRequest): Promise<GoogleMerchantClientResult> {
    if (this.config.syncEnabled && this.config.dryRun) {
      const result: GoogleMerchantClientResult = {
        status: "dry-run",
        operation: request.operation,
        request: requestSummary(request, { includeBody: true }),
        attempts: 0,
      };
      this.logger?.info?.("Google Merchant API dry-run request prepared.", logAttributes(result));
      return result;
    }

    const token = await this.accessTokenProvider();
    let lastTransientError: GoogleMerchantClientError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const response = await this.fetch(request.url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });

      if (response.ok) {
        const responseBody = await parseResponseBody(response);
        const result = successResult(request, attempt, responseBody, this.config);
        this.logger?.info?.("Google Merchant API request completed.", logAttributes(result));
        return result;
      }

      const error = redactError(await parseGoogleMerchantError(response), this.config);
      if (!error.retryable || attempt >= this.maxAttempts) {
        const result: GoogleMerchantClientResult = {
          status: error.retryable ? "transient-failure" : "permanent-failure",
          operation: request.operation,
          request: requestSummary(request),
          attempts: attempt,
          error,
        };
        this.logger?.warn?.("Google Merchant API request failed.", logAttributes(result));
        return result;
      }

      lastTransientError = error;
      await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
    }

    return {
      status: "transient-failure",
      operation: request.operation,
      request: requestSummary(request),
      attempts: this.maxAttempts,
      error:
        lastTransientError ??
        ({
          code: "google_merchant_retry_exhausted",
          message: "Google Merchant API retries were exhausted.",
          httpStatus: null,
          retryable: true,
          providerRequestId: null,
        } satisfies GoogleMerchantClientError),
    };
  }

  private disabledResult(operation: GoogleMerchantOperation): GoogleMerchantClientResult {
    const result: GoogleMerchantClientResult = {
      status: "permanent-failure",
      operation,
      request: {
        operation,
        method: methodForOperation(operation),
        url: "google-merchant-sync-disabled",
      },
      attempts: 0,
      error: {
        code: "google_merchant_sync_disabled",
        message: "Google Merchant sync is disabled.",
        httpStatus: null,
        retryable: false,
        providerRequestId: null,
      },
    };
    this.logger?.warn?.("Google Merchant API request skipped because sync is disabled.", logAttributes(result));
    return result;
  }
}

function successResult(
  request: BuiltRequest,
  attempts: number,
  responseBody: unknown,
  config: PlatformWorkerGoogleMerchantConfig,
): GoogleMerchantClientResult {
  const response = responseBody && typeof responseBody === "object" ? (responseBody as Record<string, unknown>) : {};
  const productInputName = redactMerchantResourceName(stringOrNull(response.name), config);
  const productName =
    redactMerchantResourceName(stringOrNull(response.product), config) ??
    (request.operation === "get-processed-product"
      ? redactMerchantResourceName(stringOrNull(response.name), config)
      : null);

  return {
    status: "success",
    operation: request.operation,
    request: requestSummary(request),
    attempts,
    productInputName,
    productName,
    ...(request.operation === "get-processed-product"
      ? { diagnostics: productDiagnosticsFromResponse(response, productName, config) }
      : {}),
  };
}

function productDiagnosticsFromResponse(
  response: Record<string, unknown>,
  productName: string | null,
  config: PlatformWorkerGoogleMerchantConfig,
): GoogleMerchantProductDiagnostics {
  const status = response.productStatus && typeof response.productStatus === "object" ? response.productStatus : {};
  const statusRecord = status as Record<string, unknown>;
  const issues = Array.isArray(statusRecord.itemLevelIssues) ? statusRecord.itemLevelIssues : [];

  return {
    productName: productName ?? redactMerchantResourceName(stringOrNull(response.name), config) ?? "",
    destinationStatuses: Array.isArray(statusRecord.destinationStatuses) ? statusRecord.destinationStatuses : [],
    issues: issues.map((issue) => productIssueFromResponse(issue)),
  };
}

function productIssueFromResponse(issue: unknown): GoogleMerchantProductIssue {
  const issueRecord = issue && typeof issue === "object" ? (issue as Record<string, unknown>) : {};

  return {
    code: stringOrNull(issueRecord.code),
    severity: stringOrNull(issueRecord.severity),
    resolution: stringOrNull(issueRecord.resolution),
    attribute: stringOrNull(issueRecord.attribute),
    reportingContext: stringOrNull(issueRecord.reportingContext),
    description: stringOrNull(issueRecord.description),
    detail: stringOrNull(issueRecord.detail),
    documentation: stringOrNull(issueRecord.documentation),
    applicableCountries: Array.isArray(issueRecord.applicableCountries)
      ? issueRecord.applicableCountries.flatMap((country) => (typeof country === "string" ? [country] : []))
      : [],
  };
}

async function parseGoogleMerchantError(response: Response): Promise<GoogleMerchantClientError> {
  const body = await parseResponseBody(response);
  const bodyRecord = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const errorRecord =
    bodyRecord.error && typeof bodyRecord.error === "object"
      ? (bodyRecord.error as Record<string, unknown>)
      : bodyRecord;
  const httpStatus = response.status;
  const code = stringOrNull(errorRecord.status) ?? stringOrNull(errorRecord.code) ?? `http_${httpStatus}`;
  const message = stringOrNull(errorRecord.message) ?? response.statusText;
  const details = Array.isArray(errorRecord.details) ? errorRecord.details : undefined;

  return {
    code: normalizeErrorCode(code),
    message,
    httpStatus,
    retryable: retryableStatuses.has(httpStatus),
    providerRequestId: response.headers.get("x-request-id") ?? response.headers.get("x-google-request-id"),
    details,
  };
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function requestSummary(
  request: BuiltRequest,
  options: Readonly<{ includeBody?: boolean }> = {},
): GoogleMerchantClientRequestSummary {
  return {
    method: request.method,
    operation: request.operation,
    url: request.safeUrl,
    ...(options.includeBody && request.body !== undefined ? { body: request.body } : {}),
    ...(request.updateMask ? { updateMask: request.updateMask } : {}),
  };
}

function requireEnabledConfig(config: PlatformWorkerGoogleMerchantConfig): GoogleMerchantEnabledConfig {
  if (!config.syncEnabled) {
    throw new Error("Google Merchant client requires enabled Google Merchant config.");
  }

  return config;
}

function accountName(config: GoogleMerchantEnabledConfig) {
  return `accounts/${encodeURIComponent(config.merchantAccountId)}`;
}

function dataSourceName(config: GoogleMerchantEnabledConfig) {
  return `${accountName(config)}/dataSources/${encodeURIComponent(config.apiDataSourceId)}`;
}

function encodeProductId(contentLanguage: string, feedLabel: string, offerId: string) {
  const value = `${contentLanguage}~${feedLabel}~${offerId}`;
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function redactMerchantUrl(url: URL) {
  const redacted = new URL(url.toString());
  redacted.pathname = redacted.pathname
    .replace(/accounts\/[^/]+/g, "accounts/[account]")
    .replace(/dataSources\/[^/?]+/g, "dataSources/[data-source]");
  const dataSource = redacted.searchParams.get("dataSource");
  if (dataSource) {
    redacted.searchParams.set(
      "dataSource",
      dataSource
        .replace(/accounts\/[^/]+/g, "accounts/[account]")
        .replace(/dataSources\/[^/]+/g, "dataSources/[data-source]"),
    );
  }
  return redacted.toString();
}

function toGooglePrice(amount: string, currencyCode: string): GooglePrice {
  return {
    amountMicros: moneyAmountToMicros(amount),
    currencyCode,
  };
}

function moneyAmountToMicros(amount: string) {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new Error(`Invalid Google Merchant money amount: ${amount}`);
  }

  const [whole, fraction = ""] = trimmed.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))).toString();
}

function toGoogleAvailability(
  value: GoogleShoppingPayloadInput["availability"],
): GoogleProductAttributes["availability"] {
  return value === "out of stock" ? "OUT_OF_STOCK" : "IN_STOCK";
}

function toGoogleCondition(value: string): GoogleProductAttributes["condition"] | undefined {
  if (value === "new") {
    return "NEW";
  }
  if (value === "used") {
    return "USED";
  }
  return undefined;
}

function compactObject<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeErrorCode(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function logAttributes(result: GoogleMerchantClientResult): Record<string, unknown> {
  return {
    ...result,
    request: {
      ...result.request,
      ...(result.request.body === undefined ? {} : { body: "[omitted]" }),
    },
  };
}

function redactError(
  error: GoogleMerchantClientError,
  config: PlatformWorkerGoogleMerchantConfig,
): GoogleMerchantClientError {
  if (!config.syncEnabled) {
    return error;
  }

  const redactions = configRedactions(config);

  return {
    ...error,
    message: redactText(error.message, redactions),
    details: error.details === undefined ? undefined : redactUnknown(error.details, redactions),
  };
}

function redactMerchantResourceName(value: string | null, config: PlatformWorkerGoogleMerchantConfig) {
  if (!value || !config.syncEnabled) {
    return value;
  }

  return redactText(value, configRedactions(config));
}

function configRedactions(config: Extract<PlatformWorkerGoogleMerchantConfig, { syncEnabled: true }>) {
  return [
    [config.merchantAccountId, "[account]"],
    [config.apiDataSourceId, "[data-source]"],
    [config.credentialSecretName, "[credential-secret]"],
  ] as const;
}

function redactUnknown(value: unknown, redactions: readonly (readonly [string, string])[]): unknown {
  if (typeof value === "string") {
    return redactText(value, redactions);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry, redactions));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactUnknown(entry, redactions)]),
    );
  }

  return value;
}

function redactText(value: string, redactions: readonly (readonly [string, string])[]) {
  return redactions.reduce((current, [raw, replacement]) => current.replaceAll(raw, replacement), value);
}

function methodForOperation(operation: GoogleMerchantOperation): GoogleMerchantClientRequestSummary["method"] {
  switch (operation) {
    case "delete-product-input":
      return "DELETE";
    case "get-processed-product":
      return "GET";
    case "patch-product-input":
      return "PATCH";
    case "insert-product-input":
      return "POST";
  }
}
