import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { aggregateSellerAttentionQueue, type SellerAttentionQueue } from "@chase-sets/seller-attention-queue";
import { createMarketplaceRequestApiClient } from "../../request-support/api-client";
import { createOrderingOpenOrdersRequestApiClient } from "../../request-support/ordering-open-orders-api-client";
import { createMarketplaceSellerAttentionSources } from "../../../features/seller-desk/read-model/seller-desk-attention";
import type { SellerDeskKpis } from "../../../features/seller-desk/ui/contracts";

const DEFAULT_QUERY = "limit=100&offset=0";

export type SellerDeskHomeRouteData = Readonly<{
  queue: SellerAttentionQueue;
  kpis: SellerDeskKpis;
}>;

type Loaded<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

async function loadBestEffort<T>(load: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await load() };
  } catch {
    return { ok: false };
  }
}

// The Seller Desk home loader. It fetches the marketplace-owned signals the Desk
// aggregates (offers awaiting a response, listings needing action) and the
// server-computed KPIs, then composes the attention queue through the shared
// read-model aggregation. Reads are best-effort and independent: a source read
// that fails degrades only its own row (the aggregation marks it unavailable),
// and a KPI read that fails degrades only its tile — the Desk home never blanks.
export async function loader({ request }: LoaderFunctionArgs): Promise<SellerDeskHomeRouteData> {
  const actor = await requireActorFromAuthApi({ request });
  const marketplaceApi = createMarketplaceRequestApiClient(request);

  // Fetch once and share between the KPI band and the attention sources, while
  // still letting each source degrade on its own read outcome.
  const offers = await loadBestEffort(() => marketplaceApi.listOfferMatches(DEFAULT_QUERY));
  const listings = await loadBestEffort(() => marketplaceApi.listSellerListings(DEFAULT_QUERY));
  const openOrderCount = await loadBestEffort(() =>
    createOrderingOpenOrdersRequestApiClient(request).getSellerOpenOrderCount(),
  );

  const sources = createMarketplaceSellerAttentionSources({
    loadOfferMatches: async () => {
      if (!offers.ok) {
        throw new Error(t("marketplace.features.sellerDesk.degraded.offerReadFailed"));
      }
      return offers.value.items;
    },
    loadSellerListings: async () => {
      if (!listings.ok) {
        throw new Error(t("marketplace.features.sellerDesk.degraded.listingReadFailed"));
      }
      return listings.value.items;
    },
  });

  const queue = await aggregateSellerAttentionQueue(sources, {
    accountId: actor.accountId,
    now: new Date().toISOString(),
  });

  const kpis: SellerDeskKpis = {
    activeListings: listings.ok ? listings.value.statusCounts.active : null,
    openOrdersToShip: openOrderCount.ok ? openOrderCount.value : null,
    // Wallet and payout KPIs read from the settlement money surface, wired as the
    // Money dashboard lands; until then these tiles degrade rather than mislead.
    nextPayoutAmount: null,
    walletBalanceAmount: null,
  };

  return { queue, kpis };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.features.sellerDesk.title"),
    description: t("marketplace.features.sellerDesk.meta.description"),
  });
