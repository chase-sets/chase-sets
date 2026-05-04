import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";

export class CommercialTermsApiError extends Error {
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

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new CommercialTermsApiError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
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
}>;

export type CommercialAgreement = Readonly<{
  agreement_id: string;
  account_id: string;
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
}>;

export function createCommercialTermsRequestApiClient(request: Request) {
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/commercial-terms");
  const fetch = createForwardedAuthFetch(request);

  return {
    async listSchedules(query = "") {
      return parseJsonResponse<{ items: CommercialTermsSchedule[] }>(
        await fetch(`${baseUrl}/schedules${queryFromString(query)}`),
      );
    },
    async getSchedule(id: string) {
      return parseJsonResponse<CommercialTermsSchedule>(await fetch(`${baseUrl}/schedules/${id}`));
    },
    async createSchedule(body: Record<string, unknown>) {
      return parseJsonResponse<{ id: string; version: number }>(
        await fetch(`${baseUrl}/schedules`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async listAgreements(query = "") {
      return parseJsonResponse<{ items: CommercialAgreement[] }>(
        await fetch(`${baseUrl}/agreements${queryFromString(query)}`),
      );
    },
    async getAgreement(id: string) {
      return parseJsonResponse<CommercialAgreement>(await fetch(`${baseUrl}/agreements/${id}`));
    },
    async createAgreement(body: Record<string, unknown>) {
      return parseJsonResponse<{ id: string; version: number }>(
        await fetch(`${baseUrl}/agreements`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
  };
}
