import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  SettlementWalletPage,
  type SettlementLedgerEntryRow,
  type SettlementWalletRow,
} from "../../web";
import { createSettlementRequestApiClient } from "../../client";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  const settlementApi = createSettlementRequestApiClient(request);

  const [wallet, entries] = await Promise.all([
    settlementApi.getWallet(),
    settlementApi.listWalletEntries(),
  ]);

  return { wallet, entries };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Wallet | Marketplace" });

export default function MarketplaceAccountSettlementRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <SettlementWalletPage
      wallet={data.wallet as SettlementWalletRow}
      entries={(data.entries.items ?? []) as SettlementLedgerEntryRow[]}
    />
  );
}
