import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  createSettlementRequestApiClient,
  type SettlementPayoutRow,
  type SettlementReconciliationRunRow,
  type SettlementWalletRow,
} from "../../support/request-support/api-client";
import { SettlementMoneyHealthPage } from "../../features/payouts/ui/money-health-page";

type MoneyHealthData = Readonly<{
  payouts_needing_attention: readonly SettlementPayoutRow[];
  negative_balance_accounts: readonly SettlementWalletRow[];
  negative_balance_total: number;
  reconciliation_runs: readonly SettlementReconciliationRunRow[];
  platform_balance_forecast: Readonly<{
    currency_code: string;
    available_amount: string;
    pending_payout_demand_amount: string;
    forecast_after_pending_demand_amount: string;
  }>;
  provider_health: Readonly<{
    provider_name: string;
    adapter_mode: string;
    webhook_signature_required: boolean;
    platform_balance_supported: boolean;
    connected_account_payouts_supported: boolean;
  }>;
}>;

export function resolveSettlementMarketplaceOrigin() {
  const configured = process.env.CHASE_SETS_MARKETPLACE_ORIGIN?.trim();
  return configured || null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const settlementApi = createSettlementRequestApiClient(request);
  const data = (await settlementApi.getMoneyHealth()) as MoneyHealthData;

  return { ...data, marketplaceOrigin: resolveSettlementMarketplaceOrigin() };
}

export const meta: MetaFunction = () => [
  { title: t("settlement.routes.admin.moneyHealth.money.health.settlement.admin") },
];

export default function AdminMoneyHealthRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <SettlementMoneyHealthPage
      payouts={data.payouts_needing_attention}
      negativeBalanceAccounts={data.negative_balance_accounts}
      reconciliationRuns={data.reconciliation_runs}
      platformBalanceForecast={data.platform_balance_forecast}
      providerHealth={data.provider_health}
      marketplaceOrigin={data.marketplaceOrigin}
    />
  );
}
