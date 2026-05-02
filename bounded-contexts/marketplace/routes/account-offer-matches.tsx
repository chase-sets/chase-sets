import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useRouteLoaderData } from "react-router";
import { useEffect, useState } from "react";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  type OfferMatchListItem,
} from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import { MarketplaceOfferMatchListPage } from "../features/offers/ui/offer-match-list-page";
import { applyMarketplaceListPatch } from "../support/realtime-support/patches";
import { marketplaceRealtimeRouteTopics } from "../support/realtime-support/topics";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION =
  t("marketplace.routes.accountOfferMatches.review.offer.matches.against.your.active");

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "offers.view",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response(t("marketplace.routes.accountOfferMatches.forbidden"), { status: 403 });
  }

  const api = createMarketplaceRequestApiClient(request);

  return {
    offerMatches: await api.listOfferMatches(DEFAULT_OFFER_QUERY),
    sellList: await api.getOfferMatchSellList(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "offers.manage",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response(t("marketplace.routes.accountOfferMatches.forbidden.2"), { status: 403 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceRequestApiClient(request);

  try {
    if (intent === "accept-sell-list") {
      await api.acceptOfferMatchSellList();
      return redirect("/account/sales");
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t("marketplace.routes.accountOfferMatches.request.failed"),
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountOfferMatches.offer.matches.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountOfferMatchesRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const rootData = useRouteLoaderData("root") as
    | { actor?: { accountId?: string } | null }
    | undefined;
  const [offerMatches, setOfferMatches] = useState(
    data.offerMatches as ListResponse<OfferMatchListItem>,
  );

  useEffect(() => {
    setOfferMatches(data.offerMatches as ListResponse<OfferMatchListItem>);
  }, [data.offerMatches]);

  useEffect(() => {
    const accountId = rootData?.actor?.accountId;
    if (!accountId) {
      return;
    }

    const subscription = subscribeRealtimePatches({
      preset: marketplaceRealtimeRouteTopics.accountOffers(accountId),
      onPatch: (patch) => {
        setOfferMatches((current) =>
          applyMarketplaceListPatch(current, patch, {
            entity: "marketplace.offerMatch",
            idField: "offer_id",
          }),
        );
      },
      onSyncRequired: reloadForRealtimeSync,
    });

    return () => subscription.close();
  }, [rootData?.actor?.accountId]);

  return (
    <MarketplaceOfferMatchListPage
      data={offerMatches}
      cartData={data.sellList as ListResponse<OfferMatchListItem>}
      errorMessage={actionData?.error ?? null}
    />
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
