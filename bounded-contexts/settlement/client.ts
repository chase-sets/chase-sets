import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, type ListResponse, type MutationResult } from "@chase-sets/http/responses";
import type { buildSettlementApi } from "./api";
import type { SettlementLedgerEntryRow, SettlementWalletRow } from "./features/wallets/read-model/queries";
import type {
  SettlementWalletAdjustmentAccountDetailRow,
  SettlementWalletAdjustmentRow,
} from "./features/wallets/read-model/wallet-adjustment-queries";
import type { WalletAdjustmentPreview } from "./features/wallets/api/wallet-adjustment-preview";
import type {
  SettlementPayoutRow,
  SettlementProviderIdempotencyKeyRow,
  SettlementReconciliationRunRow,
} from "./features/payouts/read-model/queries";
import type { SettlementPayoutReadinessRow } from "./features/payout-readiness/read-model/queries";
import type { PayoutSetupProgress } from "./features/payout-readiness/domain/setup-progress";

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
    advisory_requirements: readonly string[];
    disabled_reason: string | null;
    requirements_deadline: string | null;
    last_checked_at: string | null;
    steps: PayoutSetupProgress["steps"];
  }>;
  payouts: Readonly<{
    can_request: boolean;
    unavailable_reasons: readonly string[];
    unavailable_reason_details: readonly Readonly<{
      code: string;
      message: string;
    }>[];
  }>;
  restrictions: readonly string[];
  next_actions: readonly string[];
}>;

export type SettlementPayoutPreview = Readonly<{
  account_id: string;
  requested_amount: string;
  currency_code: string;
  available_balance_amount: string;
  platform_available_amount: string;
  estimated_wallet_balance_after: string;
  can_request: boolean;
  unavailable_reasons: readonly string[];
  unavailable_reason_details: readonly Readonly<{
    code: string;
    message: string;
  }>[];
}>;

export type SettlementPayoutEmbeddedSession = Readonly<{
  clientSecret: string;
  providerReference: string;
  expiresAt: string | null;
  components: readonly ("payout-setup" | "payout-account-management" | "notification-banner")[];
  readiness?: SettlementPayoutReadinessRow;
}>;

export type SettlementPayoutSetupRefreshResult = MutationResult<SettlementPayoutReadinessRow>;

export type SettlementWalletAdjustment = SettlementWalletAdjustmentRow;
export type SettlementWalletAdjustmentPreview = WalletAdjustmentPreview;
export type SettlementWalletAdjustmentAccountDetail = SettlementWalletAdjustmentAccountDetailRow;

export type SettlementRequestWalletAdjustmentInput = Readonly<{
  targetAccountId: string;
  direction: "credit" | "debit";
  amount: string;
  currencyCode?: string;
  reasonCode: string;
  explanation?: string | null;
  evidenceReferences?: readonly string[];
  expectedBalanceRevision?: string | null;
}>;

export type SettlementPreviewWalletAdjustmentInput = Readonly<{
  targetAccountId: string;
  direction: "credit" | "debit";
  amount: string;
  currencyCode?: string;
  reasonCode: string;
}>;

export type SettlementReverseWalletAdjustmentResult = Readonly<{
  original: SettlementWalletAdjustment;
  reversal: SettlementWalletAdjustment;
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

  return attachResponseMetadata(await response.json(), response) as T;
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
  const client = honoClientResource(
    hc<SettlementApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return {
    async getAccountStatus(): Promise<SettlementAccountStatus> {
      return parseJsonResponse(await client["account-status"].$get({ header: headers }));
    },
    async getWallet(): Promise<SettlementWalletRow> {
      return parseJsonResponse(await client.wallet.$get({ header: headers }));
    },
    async listWalletEntries(query = ""): Promise<ListResponse<SettlementLedgerEntryRow>> {
      return parseJsonResponse(
        await client.wallet.entries.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    /** Account-facing, self-scoped Wallet Adjustment detail -- redacted to the account-safe shape, never the platform-admin `wallet-adjustments.view` row. */
    async getAccountWalletAdjustment(reference: string): Promise<SettlementWalletAdjustmentAccountDetail> {
      return parseJsonResponse(
        await client.wallet.adjustments[":reference"].$get({
          param: { reference },
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
      return parseJsonResponse(await client["payout-readiness"].$get({ header: headers }));
    },
    async getPayoutSetupProgress(): Promise<PayoutSetupProgress> {
      return parseJsonResponse(await client["payout-setup"].progress.$get({ header: headers }));
    },
    async createPayoutSetupSession(body: Record<string, unknown> = {}): Promise<SettlementPayoutEmbeddedSession> {
      return parseJsonResponse(
        await client["payout-setup"]["embedded-session"].$post({
          json: body,
          header: headers,
        }),
      );
    },
    async createPayoutAccountManagementEmbeddedSession(): Promise<SettlementPayoutEmbeddedSession> {
      return parseJsonResponse(
        await client["payout-setup"]["account-management-embedded-session"].$post({
          json: {},
          header: headers,
        }),
      );
    },
    async createPayoutNotificationBannerSession(): Promise<SettlementPayoutEmbeddedSession> {
      return parseJsonResponse(
        await client["payout-setup"]["notification-banner-session"].$post({
          json: {},
          header: headers,
        }),
      );
    },
    async refreshPayoutSetup(): Promise<SettlementPayoutSetupRefreshResult> {
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
    async getPayoutMoneyTimeline(payoutId: string) {
      return parseJsonResponse(
        await client.payouts[":id"].timeline.$get({
          param: { id: payoutId },
          header: headers,
        }),
      );
    },
    async listPayoutsNeedingReconciliation(query = ""): Promise<ListResponse<SettlementPayoutRow>> {
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
    async listPayoutReconciliationRuns(query = ""): Promise<ListResponse<SettlementReconciliationRunRow>> {
      return parseJsonResponse(
        await client.payouts.reconciliation.runs.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async listPayoutProviderIdempotencyKeys(query = ""): Promise<ListResponse<SettlementProviderIdempotencyKeyRow>> {
      return parseJsonResponse(
        await client.payouts["provider-idempotency"].$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getPlatformBalanceForecast(): Promise<
      Readonly<{
        currency_code: string;
        available_amount: string;
        pending_payout_demand_amount: string;
        forecast_after_pending_demand_amount: string;
      }>
    > {
      return parseJsonResponse(
        await client.payouts["platform-balance-forecast"].$get({
          header: headers,
        }),
      );
    },
    async previewPayout(body: Record<string, unknown>): Promise<SettlementPayoutPreview> {
      return parseJsonResponse(await client.payouts.preview.$post({ json: body, header: headers }));
    },
    async getMoneyHealth() {
      return parseJsonResponse(await client["money-health"].$get({ header: headers }));
    },
    async getProviderHealth() {
      return parseJsonResponse(await client["provider-health"].$get({ header: headers }));
    },
    async createPayout(body: Record<string, unknown>) {
      return parseJsonResponse(await client.payouts.$post({ json: body, header: headers }));
    },
    async previewWalletAdjustment(
      body: SettlementPreviewWalletAdjustmentInput,
    ): Promise<SettlementWalletAdjustmentPreview> {
      return parseJsonResponse(await client["wallet-adjustments"].preview.$post({ json: body, header: headers }));
    },
    async requestWalletAdjustment(
      body: SettlementRequestWalletAdjustmentInput,
      idempotencyKey?: string,
    ): Promise<SettlementWalletAdjustment> {
      return parseJsonResponse(
        await client["wallet-adjustments"].$post({
          json: body,
          header: { ...resolveHeaders(headers), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
        }),
      );
    },
    async approveWalletAdjustment(
      adjustmentId: string,
      body: Record<string, unknown> = {},
    ): Promise<SettlementWalletAdjustment> {
      return parseJsonResponse(
        await client["wallet-adjustments"][":adjustmentId"].approve.$post({
          param: { adjustmentId },
          json: body,
          header: headers,
        }),
      );
    },
    async rejectWalletAdjustment(
      adjustmentId: string,
      body: Record<string, unknown> = {},
    ): Promise<SettlementWalletAdjustment> {
      return parseJsonResponse(
        await client["wallet-adjustments"][":adjustmentId"].reject.$post({
          param: { adjustmentId },
          json: body,
          header: headers,
        }),
      );
    },
    async reverseWalletAdjustment(
      adjustmentId: string,
      body: Record<string, unknown>,
    ): Promise<SettlementReverseWalletAdjustmentResult> {
      return parseJsonResponse(
        await client["wallet-adjustments"][":adjustmentId"].reverse.$post({
          param: { adjustmentId },
          json: body,
          header: headers,
        }),
      );
    },
    async getWalletAdjustment(adjustmentId: string): Promise<SettlementWalletAdjustment> {
      return parseJsonResponse(
        await client["wallet-adjustments"][":adjustmentId"].$get({ param: { adjustmentId }, header: headers }),
      );
    },
    async listWalletAdjustments(query = ""): Promise<ListResponse<SettlementWalletAdjustment>> {
      return parseJsonResponse(
        await client["wallet-adjustments"].$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getWalletAdjustmentAccountSummary(accountId: string): Promise<SettlementWalletRow> {
      return parseJsonResponse(
        await client["wallet-adjustments"].accounts[":accountId"].summary.$get({
          param: { accountId },
          header: headers,
        }),
      );
    },
    async listWalletAdjustmentAccountHistory(
      accountId: string,
      query = "",
    ): Promise<ListResponse<SettlementWalletAdjustment>> {
      return parseJsonResponse(
        await client["wallet-adjustments"].accounts[":accountId"].adjustments.$get({
          param: { accountId },
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async listWalletAdjustmentAccountLedger(
      accountId: string,
      query = "",
    ): Promise<ListResponse<SettlementLedgerEntryRow>> {
      return parseJsonResponse(
        await client["wallet-adjustments"].accounts[":accountId"].ledger.$get({
          param: { accountId },
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
  };
}

export type { SettlementWalletRow, SettlementLedgerEntryRow } from "./features/wallets/read-model/queries";
export type { SettlementWalletAdjustmentRow } from "./features/wallets/read-model/wallet-adjustment-queries";
export type { WalletAdjustmentPreview } from "./features/wallets/api/wallet-adjustment-preview";
export type {
  SettlementPayoutRow,
  SettlementProviderIdempotencyKeyRow,
  SettlementReconciliationRunRow,
} from "./features/payouts/read-model/queries";
export type { SettlementPayoutReadinessRow } from "./features/payout-readiness/read-model/queries";
export type { PayoutSetupProgress } from "./features/payout-readiness/domain/setup-progress";
export const settlementApi = createSettlementApiClient();
