import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createSettlementRequestApiClient,
  type SettlementPayoutRow,
  type SettlementReconciliationRunRow,
} from "../../support/request-support/api-client";
import { SettlementMoneyHealthPage } from "../../features/payouts/ui/money-health-page";

type MoneyHealthData = Readonly<{
  payouts_needing_attention: readonly SettlementPayoutRow[];
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

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.reconcile",
  });
  const settlementApi = createSettlementRequestApiClient(request);

  return settlementApi.getMoneyHealth();
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Money Health | Marketplace" });

export default function MarketplaceAccountMoneyHealthRoute() {
  const data = useLoaderData<typeof loader>() as MoneyHealthData;

  return (
    <SettlementMoneyHealthPage
      payouts={data.payouts_needing_attention}
      reconciliationRuns={data.reconciliation_runs}
      platformBalanceForecast={data.platform_balance_forecast}
      providerHealth={data.provider_health}
    />
  );
}
