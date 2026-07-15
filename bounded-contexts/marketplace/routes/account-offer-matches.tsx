import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData, useRouteLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  defineFormAction,
  defineResourceRoute,
  formActionRedirect,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { type OfferMatchListItem } from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import { MarketplaceOfferMatchListPage } from "../features/offers/ui/offer-match-list-page";
import { applyMarketplaceListPatch } from "../support/realtime-support/patches";
import { marketplaceRealtimeRouteTopics } from "../support/realtime-support/topics";
import contextManifest from "../context.json";
import { marketplaceApiErrorAdapter } from "../support/request-support/route-api-error";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountOfferMatches.review.offer.matches.against.your.active");
const OFFER_MATCH_LIST_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-offer-matches",
  routeId: "account-offer-matches",
  routeTemplate: "/account/offers/matches",
} as const satisfies PlatformPostWriteTelemetry;

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-offer-matches",
  authorization: async ({ request }) => {
    const actor = await requireActorFromAuthApi({ request, permission: "offers.view" });
    if (!actor.permissions.includes("listings.view")) {
      throw new Response(t("marketplace.routes.accountOfferMatches.forbidden"), { status: 403 });
    }
    return actor;
  },
  errorAdapter: marketplaceApiErrorAdapter,
  load: ({ request }) => createMarketplaceRequestApiClient(request).listOfferMatches(DEFAULT_OFFER_QUERY),
  map: async (offerMatches, { request }) => ({
    offerMatches,
    offerBuyerMutes: await createMarketplaceRequestApiClient(request).listOfferBuyerMutes(),
  }),
  onPending: () => ({
    offerMatches: {
      items: [],
      total: 0,
      count: 0,
    },
    offerBuyerMutes: {
      items: [],
      total: 0,
      count: 0,
    },
  }),
  onPermanentFailure: (result) => {
    if ("error" in result) throw result.error;
    throw new Response(t("marketplace.routes.accountOfferMatches.request.failed"), { status: 503 });
  },
  telemetry: OFFER_MATCH_LIST_POST_WRITE_TELEMETRY,
});

export const action = defineFormAction({
  authorization: async ({ request }) => {
    const actor = await requireActorFromAuthApi({ request, permission: "offers.manage" });
    if (!actor.permissions.includes("listings.view")) {
      throw new Response(t("marketplace.routes.accountOfferMatches.forbidden.2"), { status: 403 });
    }
    return actor;
  },
  intents: {
    "unmute-offer-buyer": async ({ request, formData }) =>
      formActionRedirect(
        await createMarketplaceRequestApiClient(request).unmuteOfferBuyer(
          String(formData.get("listingId") ?? ""),
          String(formData.get("buyerAccountId") ?? ""),
        ),
        "/account/offers/matches",
        {
          telemetry: OFFER_MATCH_LIST_POST_WRITE_TELEMETRY,
        },
      ),
  },
  onUnknownIntent: () => null,
});

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

  return <MarketplaceOfferMatchListPage data={offerMatches} buyerMutes={data.offerBuyerMutes} />;
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
