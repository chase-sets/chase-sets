import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useMatches } from "react-router";
import { defineFormAction } from "@chase-sets/platform-runtime/http";
import {
  createSettlementRequestApiClient,
  SettlementApiError,
  type SettlementLedgerEntryRow,
  type SettlementWalletAdjustmentPreview,
  type SettlementWalletAdjustmentRow,
  type SettlementWalletRow,
} from "../../support/request-support/api-client";
import { describeWalletAdjustmentFlowError } from "../../support/request-support/wallet-adjustment-flow-error";
import { readWalletAdjustmentGuidedFlowValues } from "../../support/request-support/wallet-adjustment-guided-flow-form-data";
import {
  SettlementWalletWorkbenchPage,
  type WalletWorkbenchLastAction,
  type WalletWorkbenchStatus,
} from "../../features/wallets/ui/wallet-workbench-page";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseLimit(value: string | null): number {
  if (!value) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

function parseOffset(value: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

export function resolveSettlementMarketplaceOrigin() {
  const configured = process.env.CHASE_SETS_MARKETPLACE_ORIGIN?.trim();
  return configured || null;
}

type LoaderData = Readonly<{
  accountId: string;
  accountLabel: string | null;
  status: WalletWorkbenchStatus;
  wallet: SettlementWalletRow | null;
  adjustments: { items: readonly SettlementWalletAdjustmentRow[]; total: number };
  adjustmentsFilters: Readonly<{ status?: SettlementWalletAdjustmentRow["status"]; limit: number; offset: number }>;
  ledger: { items: readonly SettlementLedgerEntryRow[]; total: number };
  ledgerFilters: Readonly<{ limit: number; offset: number }>;
  marketplaceOrigin: string | null;
}>;

export async function loader({ request, params }: LoaderFunctionArgs): Promise<LoaderData> {
  const accountId = params.accountId!;
  const url = new URL(request.url);
  const accountLabel = url.searchParams.get("accountName");
  const rawStatusFilter = url.searchParams.get("status");
  const statusFilter =
    rawStatusFilter && rawStatusFilter !== "all"
      ? (rawStatusFilter as SettlementWalletAdjustmentRow["status"])
      : undefined;
  const adjustmentsLimit = parseLimit(url.searchParams.get("adjustmentsLimit"));
  const adjustmentsOffset = parseOffset(url.searchParams.get("adjustmentsOffset"));
  const ledgerLimit = parseLimit(url.searchParams.get("ledgerLimit"));
  const ledgerOffset = parseOffset(url.searchParams.get("ledgerOffset"));
  const marketplaceOrigin = resolveSettlementMarketplaceOrigin();
  const settlementApi = createSettlementRequestApiClient(request);

  const emptyAdjustments = { items: [] as readonly SettlementWalletAdjustmentRow[], total: 0 };
  const emptyLedger = { items: [] as readonly SettlementLedgerEntryRow[], total: 0 };
  const adjustmentsFilters = {
    limit: adjustmentsLimit,
    offset: adjustmentsOffset,
    ...(statusFilter ? { status: statusFilter } : {}),
  };
  const ledgerFilters = { limit: ledgerLimit, offset: ledgerOffset };

  let wallet: SettlementWalletRow;
  try {
    wallet = await settlementApi.getWalletAdjustmentAccountSummary(accountId);
  } catch (error) {
    const status: WalletWorkbenchStatus =
      error instanceof SettlementApiError && error.status === 404
        ? "not-found"
        : error instanceof SettlementApiError && (error.status === 401 || error.status === 403)
          ? "permission-denied"
          : "unavailable";

    return {
      accountId,
      accountLabel,
      status,
      wallet: null,
      adjustments: emptyAdjustments,
      adjustmentsFilters,
      ledger: emptyLedger,
      ledgerFilters,
      marketplaceOrigin,
    };
  }

  const adjustmentsQuery = new URLSearchParams({
    limit: String(adjustmentsLimit),
    offset: String(adjustmentsOffset),
    ...(statusFilter ? { status: statusFilter } : {}),
  }).toString();
  const ledgerQuery = new URLSearchParams({
    limit: String(ledgerLimit),
    offset: String(ledgerOffset),
  }).toString();

  try {
    const [adjustments, ledger] = await Promise.all([
      settlementApi.listWalletAdjustmentAccountHistory(accountId, adjustmentsQuery),
      settlementApi.listWalletAdjustmentAccountLedger(accountId, ledgerQuery),
    ]);

    return {
      accountId,
      accountLabel,
      status: "ok",
      wallet,
      adjustments: { items: adjustments.items ?? [], total: adjustments.total ?? (adjustments.items ?? []).length },
      adjustmentsFilters,
      ledger: { items: ledger.items ?? [], total: ledger.total ?? (ledger.items ?? []).length },
      ledgerFilters,
      marketplaceOrigin,
    };
  } catch {
    return {
      accountId,
      accountLabel,
      status: "unavailable",
      wallet: null,
      adjustments: emptyAdjustments,
      adjustmentsFilters,
      ledger: emptyLedger,
      ledgerFilters,
      marketplaceOrigin,
    };
  }
}

function optionalText(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export const action = defineFormAction({
  intents: {
    "preview-adjustment": async ({ request, params, formData, intent }) => {
      const values = readWalletAdjustmentGuidedFlowValues(formData);
      try {
        const preview: SettlementWalletAdjustmentPreview = await createSettlementRequestApiClient(
          request,
        ).previewWalletAdjustment({
          targetAccountId: params.accountId!,
          direction: values.direction,
          amount: values.amount,
          reasonCode: values.reasonCode,
        });
        return { intent, values, preview };
      } catch (error) {
        return {
          intent,
          values,
          error: describeWalletAdjustmentFlowError(
            error,
            t("settlement.features.wallets.ui.walletWorkbenchPage.preview.could.not.be.generated"),
          ),
        };
      }
    },
    "request-adjustment": async ({ request, params, formData, intent }) => {
      const values = readWalletAdjustmentGuidedFlowValues(formData);
      const expectedBalanceRevision = optionalText(formData.get("expectedBalanceRevision"));
      try {
        const snapshot = await createSettlementRequestApiClient(request).requestWalletAdjustment({
          targetAccountId: params.accountId!,
          direction: values.direction,
          amount: values.amount,
          reasonCode: values.reasonCode,
          explanation: optionalText(formData.get("explanation")),
          evidenceReferences: values.evidenceReferences,
          ...(expectedBalanceRevision ? { expectedBalanceRevision } : {}),
        });
        return { intent, snapshot };
      } catch (error) {
        return {
          intent,
          values,
          error: describeWalletAdjustmentFlowError(
            error,
            t("settlement.features.wallets.ui.walletWorkbenchPage.adjustment.could.not.be.submitted"),
          ),
        };
      }
    },
    "approve-adjustment": async ({ request, formData, intent }) => {
      const adjustmentId = String(formData.get("adjustmentId") ?? "");
      const elevationApprovedByUserId = optionalText(formData.get("elevationApprovedByUserId"));
      try {
        const snapshot = await createSettlementRequestApiClient(request).approveWalletAdjustment(
          adjustmentId,
          elevationApprovedByUserId ? { elevationApprovedByUserId } : {},
        );
        return { intent, adjustmentId, snapshot };
      } catch (error) {
        return {
          intent,
          adjustmentId,
          error: describeWalletAdjustmentFlowError(
            error,
            t("settlement.features.wallets.ui.walletWorkbenchPage.approval.could.not.be.completed"),
          ),
        };
      }
    },
    "reject-adjustment": async ({ request, formData, intent }) => {
      const adjustmentId = String(formData.get("adjustmentId") ?? "");
      try {
        const snapshot = await createSettlementRequestApiClient(request).rejectWalletAdjustment(adjustmentId, {
          rejectionReason: optionalText(formData.get("rejectionReason")),
        });
        return { intent, adjustmentId, snapshot };
      } catch (error) {
        return {
          intent,
          adjustmentId,
          error: describeWalletAdjustmentFlowError(
            error,
            t("settlement.features.wallets.ui.walletWorkbenchPage.rejection.could.not.be.completed"),
          ),
        };
      }
    },
    "reverse-adjustment": async ({ request, formData, intent }) => {
      const adjustmentId = String(formData.get("adjustmentId") ?? "");
      try {
        const result = await createSettlementRequestApiClient(request).reverseWalletAdjustment(adjustmentId, {
          approvedByUserId: String(formData.get("approvedByUserId") ?? ""),
          elevationApprovedByUserId: String(formData.get("elevationApprovedByUserId") ?? ""),
          explanation: optionalText(formData.get("explanation")),
        });
        return { intent, adjustmentId, snapshot: result.original, reversal: result.reversal };
      } catch (error) {
        return {
          intent,
          adjustmentId,
          error: describeWalletAdjustmentFlowError(
            error,
            t("settlement.features.wallets.ui.walletWorkbenchPage.reversal.could.not.be.completed"),
          ),
        };
      }
    },
  },
  onUnknownIntent: () => null,
});

export const meta: MetaFunction = () => [
  { title: t("settlement.routes.admin.walletWorkbench.wallet.workbench.settlement.admin") },
];

function useAdminActor(): Readonly<{ permissions: readonly string[]; userId: string }> {
  for (const match of useMatches()) {
    if (match.data && typeof match.data === "object" && "actor" in match.data) {
      const actor = (match.data as { actor?: { permissions?: readonly string[]; userId?: string } }).actor;
      return { permissions: actor?.permissions ?? [], userId: actor?.userId ?? "" };
    }
  }
  return { permissions: [], userId: "" };
}

export default function AdminWalletWorkbenchRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as WalletWorkbenchLastAction | null;
  const actor = useAdminActor();

  return (
    <SettlementWalletWorkbenchPage
      accountId={data.accountId}
      accountLabel={data.accountLabel}
      status={data.status}
      wallet={data.wallet}
      adjustments={data.adjustments}
      adjustmentsFilters={data.adjustmentsFilters}
      ledger={data.ledger}
      ledgerFilters={data.ledgerFilters}
      actorPermissions={actor.permissions}
      currentActorUserId={actor.userId}
      lastAction={actionData}
      marketplaceOrigin={data.marketplaceOrigin}
    />
  );
}
