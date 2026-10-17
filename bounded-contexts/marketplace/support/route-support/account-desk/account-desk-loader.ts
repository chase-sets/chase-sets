import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { SELLER_ATTENTION_SOURCES, type SellerAttentionSourceId } from "@chase-sets/seller-desk";
import type { SellerAttentionQueue } from "@chase-sets/seller-attention-queue";
import { createMarketplaceRequestApiClient } from "../../request-support/api-client";
import { createOrderingOpenOrdersRequestApiClient } from "../../request-support/ordering-open-orders-api-client";
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
  const queueResult = await loadBestEffort(async () => {
    const apiBase = resolveRequestApiBaseUrl(request, "/api/marketplace", { requireInternalApiOrigin: true });
    const response = await fetch(`${apiBase}/account/seller-attention-queue`, {
      headers: createForwardedAuthHeaders(request, undefined, { readTargetContextName: "marketplace" }),
    });
    if (!response.ok) throw new Error(`seller attention queue ${response.status}`);
    return (await response.json()) as SellerAttentionQueue;
  });
  const queue = queueResult.ok ? queueResult.value : unavailableQueue();

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

function unavailableQueue(): SellerAttentionQueue {
  const bySource = Object.fromEntries(SELLER_ATTENTION_SOURCES.map((source) => [source.id, 0])) as Record<
    SellerAttentionSourceId,
    number
  >;
  return {
    items: [],
    rollup: { total: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, bySource },
    sources: SELLER_ATTENTION_SOURCES.map((source) => ({
      id: source.id,
      status: "unavailable" as const,
      itemCount: 0,
      reason: "seller attention queue unavailable",
    })),
    degraded: true,
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.features.sellerDesk.title"),
    description: t("marketplace.features.sellerDesk.meta.description"),
  });
