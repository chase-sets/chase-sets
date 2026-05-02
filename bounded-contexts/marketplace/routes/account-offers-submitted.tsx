import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useRouteLoaderData } from "react-router";
import { useEffect, useState } from "react";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  type SubmittedOfferListItem,
} from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import { MarketplaceSubmittedOfferListPage } from "../features/offers/ui/submitted-offer-list-page";
import { applyMarketplaceListPatch } from "../support/realtime-support/patches";
import { marketplaceRealtimeTopics } from "../support/realtime-support/topics";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION =
  t("marketplace.routes.accountOffersSubmitted.track.offers.you.have.submitted.against");

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.view" });
  const api = createMarketplaceRequestApiClient(request);

  return {
    submittedOffers: await api.listSubmittedOffers(DEFAULT_OFFER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountOffersSubmitted.submitted.offers.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountSubmittedOffersRoute() {
  const data = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData("root") as
    | { actor?: { accountId?: string } | null }
    | undefined;
  const [submittedOffers, setSubmittedOffers] = useState(
    data.submittedOffers as ListResponse<SubmittedOfferListItem>,
  );

  useEffect(() => {
    setSubmittedOffers(data.submittedOffers as ListResponse<SubmittedOfferListItem>);
  }, [data.submittedOffers]);

  useEffect(() => {
    const accountId = rootData?.actor?.accountId;
    if (!accountId) {
      return;
    }

    const subscription = subscribeRealtimePatches({
      topics: [marketplaceRealtimeTopics.accountOffers(accountId)],
      onPatch: (patch) => {
        setSubmittedOffers((current) =>
          applyMarketplaceListPatch(current, patch, {
            entity: "marketplace.offer",
            idField: "offer_id",
          }),
        );
      },
      onSyncRequired: reloadForRealtimeSync,
    });

    return () => subscription.close();
  }, [rootData?.actor?.accountId]);

  return (
    <MarketplaceSubmittedOfferListPage
      data={submittedOffers}
    />
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
