import { hc } from "hono/client";
import type { ListResponse } from "@chase-sets/http/responses";
import type { buildSettlementApi } from "./api";
import type {
  SettlementLedgerEntryRow,
  SettlementWalletRow,
} from "./features/wallets/read-model/queries";
import type { SettlementPayoutRow } from "./features/payouts/read-model/queries";
import type { SettlementPayoutReadinessRow } from "./features/payout-readiness/read-model/queries";

type SettlementApiApp = ReturnType<typeof buildSettlementApi>;

const DEFAULT_BASE_URL = "/api/settlement";

export type SettlementAccountStatus = Readonly<{
  account_id: string;
  wallet: Readonly<{
    currency_code: string;
    pending_balance_amount: string;
    available_balance_amount: string;
    can_use_balance_credit: boolean;
  }>;
  payout_setup: Readonly<{
    status: string;
    ready: boolean;
    onboarding_status: string;
    transfer_capability_status: string;
    payout_capability_status: string;
    payout_destination_status: string;
    missing_requirements: readonly string[];
    last_checked_at: string | null;
  }>;
  payouts: Readonly<{
    can_request: boolean;
    unavailable_reasons: readonly string[];
  }>;
  restrictions: readonly string[];
  next_actions: readonly string[];
}>;

export class SettlementApiError extends Error {
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

export interface SettlementApiClientOptions {
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
    throw new SettlementApiError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
}

export function createSettlementApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: SettlementApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = hc<SettlementApiApp>(baseUrl, { fetch: configuredFetch }) as any;
  const headers = resolveHeaders(initialHeaders);

  return {
    async getAccountStatus(): Promise<SettlementAccountStatus> {
      return parseJsonResponse(
        await client["account-status"].$get({ header: headers }),
      );
    },
    async getWallet(): Promise<SettlementWalletRow> {
      return parseJsonResponse(
        await client.wallet.$get({ header: headers }),
      );
    },
    async listWalletEntries(
      query = "",
    ): Promise<ListResponse<SettlementLedgerEntryRow>> {
      return parseJsonResponse(
        await client.wallet.entries.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async listPayouts(query = ""): Promise<ListResponse<SettlementPayoutRow>> {
      return parseJsonResponse(
        await client.payouts.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getPayoutReadiness(): Promise<SettlementPayoutReadinessRow> {
      return parseJsonResponse(
        await client["payout-readiness"].$get({ header: headers }),
      );
    },
    async createPayoutSetupOnboardingSession(
      body: Record<string, unknown> = {},
    ): Promise<Readonly<{ url: string; providerReference: string; expiresAt: string | null }>> {
      return parseJsonResponse(
        await client["payout-setup"]["onboarding-session"].$post({
          json: body,
          header: headers,
        }),
      );
    },
    async createPayoutAccountManagementSession(
      body: Record<string, unknown> = {},
    ): Promise<Readonly<{ url: string; providerReference: string; expiresAt: string | null }>> {
      return parseJsonResponse(
        await client["payout-setup"]["account-management-session"].$post({
          json: body,
          header: headers,
        }),
      );
    },
    async refreshPayoutSetup(): Promise<SettlementPayoutReadinessRow> {
      return parseJsonResponse(
        await client["payout-setup"].refresh.$post({
          json: {},
          header: headers,
        }),
      );
    },
    async getPayout(payoutId: string): Promise<SettlementPayoutRow> {
      return parseJsonResponse(
        await client.payouts[":id"].$get({
          param: { id: payoutId },
          header: headers,
        }),
      );
    },
    async listPayoutsNeedingReconciliation(
      query = "",
    ): Promise<ListResponse<SettlementPayoutRow>> {
      return parseJsonResponse(
        await client.payouts.reconciliation.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async runPayoutReconciliation(body: Record<string, unknown> = {}) {
      return parseJsonResponse(
        await client.payouts.reconciliation.run.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async createPayout(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.payouts.$post({ json: body, header: headers }),
      );
    },
  };
}

export type { SettlementWalletRow, SettlementLedgerEntryRow } from "./features/wallets/read-model/queries";
export type { SettlementPayoutRow } from "./features/payouts/read-model/queries";
export type { SettlementPayoutReadinessRow } from "./features/payout-readiness/read-model/queries";
export const settlementApi = createSettlementApiClient();
