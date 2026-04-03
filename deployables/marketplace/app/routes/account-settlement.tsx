import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  SettlementApiError,
  SettlementWalletPage,
  type SettlementLedgerEntryRow,
  type SettlementWalletRow,
} from "@chase-sets/settlement/web";
import { createMarketplaceSettlementApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "payouts.view");
  const settlementApi = createMarketplaceSettlementApiClient(request);

  try {
    const [wallet, entries] = await Promise.all([
      settlementApi.getWallet(),
      settlementApi.listWalletEntries(),
    ]);

    return { wallet, entries };
  } catch (error) {
    if (error instanceof SettlementApiError && error.status === 404) {
      throw new Response("Wallet not found.", { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Wallet | Marketplace" });

export default function MarketplaceAccountSettlementRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <SettlementWalletPage
      wallet={data.wallet as SettlementWalletRow}
      entries={(data.entries.items ?? []) as SettlementLedgerEntryRow[]}
    />
  );
}
