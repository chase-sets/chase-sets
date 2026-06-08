import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useRouteLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { type OfferMatchListItem } from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import { MarketplaceOfferMatchListPage } from "../features/offers/ui/offer-match-list-page";
import { applyMarketplaceListPatch } from "../support/realtime-support/patches";
import { marketplaceRealtimeRouteTopics } from "../support/realtime-support/topics";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountOfferMatches.review.offer.matches.against.your.active");

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "offers.view",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response(t("marketplace.routes.accountOfferMatches.forbidden"), { status: 403 });
  }

  const api = createMarketplaceRequestApiClient(request);

  const offerMatches = await api.listOfferMatches(DEFAULT_OFFER_QUERY);

  return {
    offerMatches,
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountOfferMatches.offer.matches.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountOfferMatchesRoute() {
  const data = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData("root") as { actor?: { accountId?: string } | null } | undefined;
  const accountId = rootData?.actor?.accountId ?? null;

  return (
    <MarketplaceAccountOfferMatchesRealtimeView
      key={[
        accountId ?? "anonymous",
        data.offerMatches.total,
        data.offerMatches.items.map((item) => item.offer_id).join("|"),
      ].join("\n")}
      data={data}
      accountId={accountId}
    />
  );
}

function MarketplaceAccountOfferMatchesRealtimeView({
  data,
  accountId,
}: {
  data: Awaited<ReturnType<typeof loader>>;
  accountId: string | null;
}) {
  const offerMatches = useRealtimePatchedSnapshot<ListResponse<OfferMatchListItem>>({
    initialSnapshot: data.offerMatches as ListResponse<OfferMatchListItem>,
    snapshotKey: JSON.stringify(data.offerMatches),
    topics: accountId ? marketplaceRealtimeRouteTopics.accountOffers(accountId).topics : [],
    applyPatch: (current, patch) =>
      applyMarketplaceListPatch(current, patch, {
        entity: "marketplace.offerMatch",
        idField: "offer_id",
      }),
    onSyncRequired: reloadForRealtimeSync,
  });

  return <MarketplaceOfferMatchListPage data={offerMatches} />;
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
