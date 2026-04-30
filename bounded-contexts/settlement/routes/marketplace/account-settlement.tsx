import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  type SettlementLedgerEntryRow,
  type SettlementPayoutReadinessRow,
  type SettlementWalletRow,
} from "../../support/request-support/api-client";
import { createSettlementRequestApiClient } from "../../support/request-support/api-client";
import { SettlementWalletPage } from "../../features/wallets/ui/wallet-page";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  const settlementApi = createSettlementRequestApiClient(request);

  const [wallet, entries, payoutReadiness] = await Promise.all([
    settlementApi.getWallet(),
    settlementApi.listWalletEntries(),
    settlementApi.getPayoutReadiness(),
  ]);

  return { wallet, entries, payoutReadiness };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Wallet | Marketplace" });

export default function MarketplaceAccountSettlementRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <SettlementWalletPage
      wallet={data.wallet as SettlementWalletRow}
      entries={(data.entries.items ?? []) as SettlementLedgerEntryRow[]}
      payoutReadiness={data.payoutReadiness as SettlementPayoutReadinessRow}
    />
  );
}
