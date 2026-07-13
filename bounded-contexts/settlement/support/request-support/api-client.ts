import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { createSettlementApiClient, settlementApi, SettlementApiError } from "../../client";
export type {
  SettlementApiClientOptions,
  SettlementPayoutEmbeddedSession,
  SettlementLedgerEntryRow,
  SettlementPayoutRow,
  SettlementPayoutPreview,
  SettlementProviderIdempotencyKeyRow,
  SettlementPayoutSetupRefreshResult,
  SettlementPayoutReadinessRow,
  SettlementReconciliationRunRow,
  SettlementWalletRow,
  SettlementWalletAdjustment,
  SettlementWalletAdjustmentRow,
  SettlementWalletAdjustmentAccountDetail,
  SettlementWalletAdjustmentPreview,
  SettlementRequestWalletAdjustmentInput,
  SettlementPreviewWalletAdjustmentInput,
  SettlementReverseWalletAdjustmentResult,
} from "../../client";
import { createSettlementApiClient } from "../../client";

export function createSettlementRequestApiClient(request: Request) {
  return createSettlementApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/settlement"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "settlement" }),
  });
}
