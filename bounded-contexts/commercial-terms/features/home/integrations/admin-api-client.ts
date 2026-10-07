import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { attachResponseMetadata, type MutationResult } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";

export class CommercialTermsApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly request: CommercialTermsApiErrorRequest,
  ) {
    super(
      typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: { message?: unknown } }).error?.message === "string"
        ? (body as { error: { message: string } }).error.message
        : `Commercial Terms API request failed with ${status} at ${request.pathname} (${request.contentType ?? "unknown content type"}).`,
    );
  }
}

export type CommercialTermsApiErrorRequest = Readonly<{
  method: string;
  origin: string;
  pathname: string;
  contentType: string | null;
}>;

export type PublishedMarketplaceSalesFeeSchedule = Readonly<{
  value: Readonly<{
    label: string;
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    marketplaceSalesFeeCapAmount: string;
    shippingAllowancePercentageBps: number;
  }>;
  source: "policy" | "fallback";
  documentId: string | null;
  effectiveFrom: string | null;
  resolvedAt: string;
}>;

function isPublishedSchedule(raw: unknown): raw is PublishedMarketplaceSalesFeeSchedule {
  if (typeof raw !== "object" || raw === null) return false;
  const envelope = raw as Record<string, unknown>;
  if (typeof envelope.value !== "object" || envelope.value === null) return false;
  const value = envelope.value as Record<string, unknown>;
  const isText = (input: unknown): input is string => typeof input === "string" && input.trim().length > 0;
  const isDate = (input: unknown) =>
    isText(input) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(input) && Number.isFinite(Date.parse(input));
  const isBps = (input: unknown) =>
    typeof input === "number" && Number.isInteger(input) && input >= 0 && input <= 10000;
  const isMoney = (input: unknown) =>
    typeof input === "string" && /^\d+\.\d{2}$/.test(input) && Number.isFinite(Number(input));
  return (
    isText(value.label) &&
    isBps(value.marketplaceSalesFeePercentageBps) &&
    isMoney(value.marketplaceSalesFeeFixedAmount) &&
    isMoney(value.marketplaceSalesFeeCapAmount) &&
    Number(value.marketplaceSalesFeeCapAmount) > 0 &&
    isBps(value.shippingAllowancePercentageBps) &&
    isDate(envelope.resolvedAt) &&
    ((envelope.source === "policy" && isText(envelope.documentId) && isDate(envelope.effectiveFrom)) ||
      (envelope.source === "fallback" && envelope.documentId === null && envelope.effectiveFrom === null))
  );
}

type CommercialTermsRequest = Omit<CommercialTermsApiErrorRequest, "contentType">;
export type CommercialTermsMutationResult<T extends object> = MutationResult<T>;
type CommercialTermsCommandMutationResult = CommercialTermsMutationResult<Readonly<{ id: string; version: number }>>;
type CommercialTermsScheduleCreateMutationResult = CommercialTermsMutationResult<
  Readonly<{ id: string; version: number; preview: unknown | null }>
>;

function describeRequest(input: string, init?: RequestInit): CommercialTermsRequest {
  const url = new URL(input);
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    origin: url.origin,
    pathname: url.pathname,
  };
}

function logCommercialTermsApiFailure(status: number, request: CommercialTermsApiErrorRequest) {
  console.warn("[commercial-terms-admin-api] request failed", {
    status,
    method: request.method,
    origin: request.origin,
    pathname: request.pathname,
    contentType: request.contentType,
  });
}

async function parseJsonResponse<T>(response: Response, request: CommercialTermsRequest): Promise<T> {
  if (!response.ok) {
    const contentType = response.headers.get("content-type");
    const errorRequest = { ...request, contentType };
    const errorBody = contentType?.includes("application/json") ? await response.json().catch(() => null) : null;
    logCommercialTermsApiFailure(response.status, errorRequest);
    throw new CommercialTermsApiError(response.status, errorBody, errorRequest);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

function queryFromString(query: string) {
  const params = new URLSearchParams(query);
  return params.toString() ? `?${params.toString()}` : "";
}

export type CommercialTermsSchedule = Readonly<{
  schedule_id: string;
  label: string;
  account_type: string;
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  shipping_allowance_percentage_bps: number;
  status: string;
  effective_from: string;
  effective_until: string | null;
  created_at: string;
  updated_at: string;
  history?: readonly CommercialTermsHistoryItem[];
}>;

export type CommercialTermsHistoryItem = Readonly<{
  history_id: string;
  event_id: string;
  event_type: string;
  actor_user_id: string;
  status: string;
  payload: Record<string, unknown>;
  effective_from: string;
  effective_until: string | null;
  recorded_at: string;
}>;

export type CommercialAgreement = Readonly<{
  agreement_id: string;
  account_id: string;
  account_name: string | null;
  account_display_name: string | null;
  account_type: string | null;
  label: string;
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  shipping_allowance_percentage_bps: number;
  status: string;
  effective_from: string;
  effective_until: string | null;
  created_at: string;
  updated_at: string;
  history?: readonly CommercialTermsHistoryItem[];
}>;

export type CommercialTermsAccountOption = Readonly<{
  accountId: string;
  name: string;
  displayName: string;
  accountType: string;
}>;

export function createCommercialTermsRequestApiClient(request: Request) {
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/commercial-terms");
  const fetch = createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "commercial-terms" });

  async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
    return parseJsonResponse<T>(await fetch(input, init), describeRequest(input, init));
  }

  return {
    async listSchedules(query = "") {
      return requestJson<{ items: CommercialTermsSchedule[]; total: number; count: number }>(
        `${baseUrl}/schedules${queryFromString(query)}`,
      );
    },
    async getSchedule(id: string) {
      return requestJson<CommercialTermsSchedule>(`${baseUrl}/schedules/${id}`);
    },
    async createSchedule(body: Record<string, unknown>): Promise<CommercialTermsScheduleCreateMutationResult> {
      return requestJson<CommercialTermsScheduleCreateMutationResult>(`${baseUrl}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async updateSchedule(id: string, body: Record<string, unknown>): Promise<CommercialTermsCommandMutationResult> {
      return requestJson<CommercialTermsCommandMutationResult>(`${baseUrl}/schedules/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async listAgreements(query = "") {
      return requestJson<{ items: CommercialAgreement[]; total: number; count: number }>(
        `${baseUrl}/agreements${queryFromString(query)}`,
      );
    },
    async listAccountOptions() {
      const response = await requestJson<{
        items: Array<{ account_id: string; account_name: string; display_name: string; account_type: string }>;
      }>(`${baseUrl}/agreements/account-options`);
      return response.items.map((item) => ({
        accountId: item.account_id,
        name: item.account_name,
        displayName: item.display_name,
        accountType: item.account_type,
      }));
    },
    async getAgreement(id: string) {
      return requestJson<CommercialAgreement>(`${baseUrl}/agreements/${id}`);
    },
    async createAgreement(body: Record<string, unknown>): Promise<CommercialTermsCommandMutationResult> {
      return requestJson<CommercialTermsCommandMutationResult>(`${baseUrl}/agreements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async updateAgreement(id: string, body: Record<string, unknown>): Promise<CommercialTermsCommandMutationResult> {
      return requestJson<CommercialTermsCommandMutationResult>(`${baseUrl}/agreements/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}

export function createCommercialTermsPublicRequestApiClient(request: Request) {
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/public/commercial-terms");
  const fetch = createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "commercial-terms" });

  return {
    async getMarketplaceSalesFeeSchedule(): Promise<PublishedMarketplaceSalesFeeSchedule> {
      const input = `${baseUrl}/marketplace-sales-fee-schedule`;
      const schedule = await parseJsonResponse<unknown>(await fetch(input), describeRequest(input));
      if (!isPublishedSchedule(schedule)) {
        throw new Error(t("commercialTerms.features.home.unavailable"));
      }
      return schedule;
    },
  };
}
