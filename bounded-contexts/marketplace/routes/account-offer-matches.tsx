import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useRouteLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
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

  const offerMatches = await api.listOfferMatches(DEFAULT_OFFER_QUERY);

  return {
    offerMatches,
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
      const feeQuoteFingerprintsByOfferId: Record<string, string> = {};

      for (const [key, value] of formData.entries()) {
        if (!key.startsWith("feeQuoteFingerprint:")) {
          continue;
        }
        const offerId = key.slice("feeQuoteFingerprint:".length);
        feeQuoteFingerprintsByOfferId[offerId] = String(value ?? "");
      }

      await api.acceptOfferMatchSellList({ feeQuoteFingerprintsByOfferId });
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
  const accountId = rootData?.actor?.accountId ?? null;

  return (
    <MarketplaceAccountOfferMatchesRealtimeView
      key={[
        accountId ?? "anonymous",
        data.offerMatches.total,
        data.offerMatches.items.map((item) => item.offer_id).join("|"),
      ].join("\n")}
      data={data}
      actionData={actionData}
      accountId={accountId}
    />
  );
}

function MarketplaceAccountOfferMatchesRealtimeView({
  data,
  actionData,
  accountId,
}: {
  data: Awaited<ReturnType<typeof loader>>;
  actionData: Exclude<Awaited<ReturnType<typeof action>>, Response> | undefined;
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

  return (
    <MarketplaceOfferMatchListPage
      data={offerMatches}
      errorMessage={actionData?.error ?? null}
    />
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
