import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import type { buildSellerMetricsApi } from "../../features/seller-metrics/api/http";

type SellerMetricsApiApp = ReturnType<typeof buildSellerMetricsApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export type SellerBehavioralMetricsSummary = Readonly<{
  seller_account_id: string;
  window_days: number;
  orders_created_count: number;
  seller_cancelled_count: number;
  cancellation_rate: string | null;
  shipments_dispatched_count: number;
  shipments_on_time_count: number;
  on_time_shipment_rate: string | null;
  disputes_resolved_count: number;
  disputes_against_seller_count: number;
  dispute_rate: string | null;
  missing_responsibility_count: number;
  computed_at: string | null;
  updated_at: string | null;
}>;

/** Whether the own-account read produced a summary the page may present; a failure is never shown as insufficient history. */
export type SellerBehavioralMetricsAvailability =
  | Readonly<{ status: "available"; summary: SellerBehavioralMetricsSummary }>
  | Readonly<{ status: "unavailable" }>;

const SUMMARY_COUNT_FIELDS = [
  "orders_created_count",
  "seller_cancelled_count",
  "shipments_dispatched_count",
  "shipments_on_time_count",
  "disputes_resolved_count",
  "disputes_against_seller_count",
  "missing_responsibility_count",
] as const;
const SUMMARY_RATE_FIELDS = ["cancellation_rate", "on_time_shipment_rate", "dispute_rate"] as const;
const SUMMARY_FIELDS = new Set<string>([
  "seller_account_id",
  "window_days",
  ...SUMMARY_COUNT_FIELDS,
  ...SUMMARY_RATE_FIELDS,
  "computed_at",
  "updated_at",
]);
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
// ISO-8601 (JSON) and Postgres `timestamptz::text` spellings; an offset is required.
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRate(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DECIMAL_PATTERN.test(value) && Number(value) <= 1);
}

function isInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = INSTANT_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return (
    Number(month) >= 1 &&
    Number(month) <= 12 &&
    Number(day) >= 1 &&
    Number(day) <= daysInMonth &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    Number(offsetHour) <= 23 &&
    Number(offsetMinute) <= 59
  );
}

/**
 * Closed runtime contract for the own-account seller-metrics response. Any
 * missing, unknown, or malformed field rejects the whole summary (null) so a
 * partial or fabricated summary never reaches the page. `window_days: 0` is
 * accepted only as the API's canonical zero-history summary.
 */
export function parseSellerBehavioralMetricsSummary(value: unknown): SellerBehavioralMetricsSummary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== SUMMARY_FIELDS.size || !keys.every((key) => SUMMARY_FIELDS.has(key))) return null;

  const { seller_account_id, window_days, computed_at, updated_at } = record;
  if (typeof seller_account_id !== "string" || seller_account_id.trim() === "") return null;
  if (!isCount(window_days)) return null;
  if (!SUMMARY_COUNT_FIELDS.every((field) => isCount(record[field]))) return null;
  if (!SUMMARY_RATE_FIELDS.every((field) => isRate(record[field]))) return null;

  if (window_days === 0) {
    const isCanonicalEmpty =
      SUMMARY_COUNT_FIELDS.every((field) => record[field] === 0) &&
      SUMMARY_RATE_FIELDS.every((field) => record[field] === null) &&
      computed_at === null &&
      updated_at === null;
    if (!isCanonicalEmpty) return null;
  } else if (!isInstant(computed_at) || !isInstant(updated_at)) {
    return null;
  }

  return record as SellerBehavioralMetricsSummary;
}

export type SellerBehavioralMetricsChips = Readonly<{
  sellerAccountId: string;
  shipsOnTime: boolean | null;
  lowCancellationRate: boolean | null;
  lowDisputeRate: boolean | null;
}>;

export class SellerMetricsApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body !== null && "error" in body
        ? String((body as Record<string, unknown>).error)
        : `API error ${status}`,
    );
  }
}

export class SellerMetricsResponseError extends Error {
  public constructor() {
    super("Seller metrics response did not match the summary contract.");
  }
}

export interface SellerMetricsApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new SellerMetricsApiError(response.status, errorBody);
  }

  return (await response.json()) as T;
}

export function createSellerMetricsApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: SellerMetricsApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = honoClientResource(
    hc<SellerMetricsApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return {
    /** Own-account seller dashboard read (authenticated, own account only). */
    async getOwnBehavioralMetrics(): Promise<SellerBehavioralMetricsSummary> {
      const summary = parseSellerBehavioralMetricsSummary(
        await parseJsonResponse<unknown>(
          await client.account["seller-metrics"].$get({
            header: headers,
          }),
        ),
      );
      if (summary === null) {
        throw new SellerMetricsResponseError();
      }
      return summary;
    },
    /** Public buyer-facing chips for a given seller account (flag-gated + threshold-gated server-side). */
    async getBehavioralMetricsChips(accountId: string): Promise<SellerBehavioralMetricsChips> {
      return parseJsonResponse(
        await client.accounts[":accountId"]["behavioral-metrics-chips"].$get({
          param: { accountId },
          header: headers,
        }),
      );
    },
  };
}
