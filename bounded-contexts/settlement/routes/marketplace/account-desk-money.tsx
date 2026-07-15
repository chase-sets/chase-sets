import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import {
  defineFormAction,
  formActionRedirect,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type {
  SettlementLedgerEntryRow,
  SettlementPayoutPreview,
  SettlementPayoutReadinessRow,
  SettlementPayoutRow,
  SettlementWalletRow,
  SettlementWalletAdjustmentAccountDetail,
} from "../../support/request-support/api-client";
import { createSettlementRequestApiClient, SettlementApiError } from "../../support/request-support/api-client";
import { settlementApiErrorAdapter } from "../../support/request-support/route-api-error";
import { resolvePayoutAmountSelection } from "../../features/payouts/api/payout-form";
import { stripeConnectHeaders } from "../../features/payout-readiness/ui/stripe-connect-csp";
import {
  SettlementMoneyDashboardPage,
  type MoneyDashboardActionState,
} from "../../features/money-dashboard/ui/money-dashboard-page";

type ReconciliationResult = Readonly<{ progress: Readonly<{ message: string | null }> }>;

const MONEY_DASHBOARD_POST_WRITE_TELEMETRY = {
  boundedContextName: "settlement",
  surface: "account-desk-money",
  routeId: "account-desk-money",
  routeTemplate: "/account/desk/money",
} as const satisfies PlatformPostWriteTelemetry;

export function headers() {
  return stripeConnectHeaders();
}

function payoutAmount(formData: FormData) {
  return resolvePayoutAmountSelection({
    amount: String(formData.get("amount") ?? ""),
    shortcut: String(formData.get("quickAmount") ?? ""),
    availableAmount: String(formData.get("availableAmount") ?? "0"),
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({ request, permission: "payouts.view" });
  const settlementApi = createSettlementRequestApiClient(request);
  const requestUrl = new URL(request.url);
  const adjustmentReference =
    requestUrl.searchParams.get("drawer") === "wallet-adjustment"
      ? requestUrl.searchParams.get("entity")?.trim() || null
      : null;
  const walletAdjustment = adjustmentReference
    ? settlementApi.getAccountWalletAdjustment(adjustmentReference).catch((error: unknown) => {
        if (error instanceof SettlementApiError && error.status === 404) return null;
        throw error;
      })
    : Promise.resolve(null);
  const [wallet, entries, payouts, payoutReadiness, selectedWalletAdjustment] = await Promise.all([
    settlementApi.getWallet(),
    settlementApi.listWalletEntries(),
    settlementApi.listPayouts(),
    settlementApi.getPayoutReadiness(),
    walletAdjustment,
  ]);

  return {
    wallet,
    entries,
    payouts,
    payoutReadiness,
    selectedWalletAdjustment,
    evaluatedAt: new Date().toISOString(),
    canRequestPayouts: actor.permissions.includes("payouts.request"),
    canSetupPayouts: actor.permissions.includes("payouts.setup"),
    canReconcilePayouts: actor.permissions.includes("payouts.reconcile"),
  };
}

export const action = defineFormAction({
  authorization: { permission: "payouts.view" },
  errorAdapter: settlementApiErrorAdapter,
  intents: {
    "preview-payout": async ({ request, actor, formData }) => {
      if (!actor!.permissions.includes("payouts.request")) {
        return { error: t("settlement.features.moneyDashboard.ui.requestPermissionRequired") };
      }
      const amount = payoutAmount(formData);
      const note = formData.get("note") ? String(formData.get("note")) : null;
      const preview = await createSettlementRequestApiClient(request).previewPayout({ amount });
      return { confirmation: { amount, note, preview } };
    },
    "edit-payout": ({ actor, formData }) => {
      if (!actor!.permissions.includes("payouts.request")) {
        return { error: t("settlement.features.moneyDashboard.ui.requestPermissionRequired") };
      }
      return {
        draft: {
          amount: String(formData.get("amount") ?? ""),
          note: formData.get("note") ? String(formData.get("note")) : null,
        },
      };
    },
    "confirm-payout": async ({ request, actor, formData }) => {
      if (!actor!.permissions.includes("payouts.request")) {
        return { error: t("settlement.features.moneyDashboard.ui.requestPermissionRequired") };
      }
      const result = (await createSettlementRequestApiClient(request).createPayout({
        amount: formData.get("amount"),
        destinationReference: null,
        note: formData.get("note") || null,
      })) as Readonly<{ id: string }>;
      return formActionRedirect(result, `/account/desk/payouts/${result.id}?requested=1`, {
        telemetry: MONEY_DASHBOARD_POST_WRITE_TELEMETRY,
      });
    },
    retry: async ({ request, actor }) => {
      if (!actor!.permissions.includes("payouts.reconcile")) {
        return { error: t("settlement.features.moneyDashboard.ui.reconcilePermissionRequired") };
      }
      const result = (await createSettlementRequestApiClient(request).runPayoutReconciliation({
        limit: 100,
      })) as ReconciliationResult;
      return {
        reconciliationStatus: result.progress.message ?? t("settlement.features.moneyDashboard.ui.statusCheckQueued"),
      };
    },
    "run-reconciliation": async ({ request, actor }) => {
      if (!actor!.permissions.includes("payouts.reconcile")) {
        return { error: t("settlement.features.moneyDashboard.ui.reconcilePermissionRequired") };
      }
      const result = (await createSettlementRequestApiClient(request).runPayoutReconciliation({
        limit: 100,
      })) as ReconciliationResult;
      return {
        reconciliationStatus: result.progress.message ?? t("settlement.features.moneyDashboard.ui.statusCheckQueued"),
      };
    },
  },
  onUnknownIntent: () => formActionRedirect(null, "/account/desk/money"),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("settlement.features.moneyDashboard.ui.marketplaceTitle") });

export default function MarketplaceAccountDeskMoneyRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as MoneyDashboardActionState | undefined;

  return (
    <SettlementMoneyDashboardPage
      wallet={data.wallet as SettlementWalletRow}
      entries={(data.entries.items ?? []) as SettlementLedgerEntryRow[]}
      payouts={(data.payouts.items ?? []) as SettlementPayoutRow[]}
      payoutReadiness={data.payoutReadiness as SettlementPayoutReadinessRow}
      selectedWalletAdjustment={data.selectedWalletAdjustment as SettlementWalletAdjustmentAccountDetail | null}
      evaluatedAt={data.evaluatedAt}
      canRequestPayouts={data.canRequestPayouts}
      canSetupPayouts={data.canSetupPayouts}
      canReconcilePayouts={data.canReconcilePayouts}
      actionState={
        actionData
          ? {
              ...actionData,
              confirmation: actionData.confirmation
                ? {
                    ...actionData.confirmation,
                    preview: actionData.confirmation.preview as SettlementPayoutPreview,
                  }
                : undefined,
            }
          : undefined
      }
    />
  );
}
