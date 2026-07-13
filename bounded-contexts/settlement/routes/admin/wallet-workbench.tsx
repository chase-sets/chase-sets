import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useMatches } from "react-router";
import {
  createSettlementRequestApiClient,
  SettlementApiError,
  type SettlementLedgerEntryRow,
  type SettlementWalletAdjustmentRow,
  type SettlementWalletRow,
} from "../../support/request-support/api-client";
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

function parseEvidenceReferences(raw: string): readonly string[] {
  return raw
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export async function action({ request, params }: ActionFunctionArgs): Promise<WalletWorkbenchLastAction | null> {
  const accountId = params.accountId!;
  const settlementApi = createSettlementRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "request-adjustment") {
      const explanation = String(formData.get("explanation") ?? "").trim();
      const evidenceReferences = parseEvidenceReferences(String(formData.get("evidenceReferences") ?? ""));
      const snapshot = await settlementApi.requestWalletAdjustment({
        targetAccountId: accountId,
        direction: String(formData.get("direction") ?? "credit") === "debit" ? "debit" : "credit",
        amount: String(formData.get("amount") ?? ""),
        reasonCode: String(formData.get("reasonCode") ?? ""),
        explanation: explanation || null,
        evidenceReferences,
      });
      return { intent, snapshot };
    }

    if (intent === "approve-adjustment") {
      const adjustmentId = String(formData.get("adjustmentId") ?? "");
      const elevationApprovedByUserId = String(formData.get("elevationApprovedByUserId") ?? "").trim();
      const snapshot = await settlementApi.approveWalletAdjustment(
        adjustmentId,
        elevationApprovedByUserId ? { elevationApprovedByUserId } : {},
      );
      return { intent, snapshot };
    }

    if (intent === "reject-adjustment") {
      const adjustmentId = String(formData.get("adjustmentId") ?? "");
      const rejectionReason = String(formData.get("rejectionReason") ?? "").trim();
      const snapshot = await settlementApi.rejectWalletAdjustment(
        adjustmentId,
        rejectionReason ? { rejectionReason } : {},
      );
      return { intent, snapshot };
    }

    if (intent === "reverse-adjustment") {
      const adjustmentId = String(formData.get("adjustmentId") ?? "");
      const approvedByUserId = String(formData.get("approvedByUserId") ?? "").trim();
      const elevationApprovedByUserId = String(formData.get("elevationApprovedByUserId") ?? "").trim();
      const explanation = String(formData.get("explanation") ?? "").trim();
      const result = await settlementApi.reverseWalletAdjustment(adjustmentId, {
        approvedByUserId,
        elevationApprovedByUserId,
        ...(explanation ? { explanation } : {}),
      });
      return { intent, snapshot: result.original, reversal: result.reversal };
    }

    return null;
  } catch (error) {
    if (error instanceof SettlementApiError) {
      const body = error.body as { error?: string } | undefined;
      return { intent, errorMessage: body?.error ?? error.message };
    }
    return {
      intent,
      errorMessage: t("settlement.routes.admin.walletWorkbench.action.failed"),
    };
  }
}

export const meta: MetaFunction = () => [
  { title: t("settlement.routes.admin.walletWorkbench.wallet.workbench.settlement.admin") },
];

function useAdminActorPermissions(): readonly string[] {
  for (const match of useMatches()) {
    if (match.data && typeof match.data === "object" && "actor" in match.data) {
      const actor = (match.data as { actor?: { permissions?: readonly string[] } }).actor;
      return actor?.permissions ?? [];
    }
  }
  return [];
}

export default function AdminWalletWorkbenchRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as WalletWorkbenchLastAction | null;

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
      actorPermissions={useAdminActorPermissions()}
      lastAction={actionData}
      marketplaceOrigin={data.marketplaceOrigin}
    />
  );
}
