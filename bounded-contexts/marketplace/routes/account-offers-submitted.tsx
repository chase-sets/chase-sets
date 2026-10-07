import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, useLoaderData, useRouteLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { type ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { type SubmittedOfferListItem } from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient, MarketplaceApiError } from "../support/request-support/api-client";
import { MarketplaceSubmittedOfferListPage } from "../features/offers/ui/submitted-offer-list-page";
import { applyMarketplaceListPatch } from "../support/realtime-support/patches";
import { marketplaceRealtimeRouteTopics } from "../support/realtime-support/topics";
import { submittedOfferPolicyAction } from "../features/offer-policy/api/submitted-offer-route";
import type { BuyerOfferPolicyListSnapshot } from "../features/offer-policy/api/runtime";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountOffersSubmitted.track.offers.you.have.submitted.against");

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.manage" });
  const api = createMarketplaceRequestApiClient(request);
  const headers = new Headers();
  const result = await submittedOfferPolicyAction(request, {
    ...api,
    async commandBuyerOfferPolicy(...args: Parameters<typeof api.commandBuyerOfferPolicy>) {
      try {
        return await api.commandBuyerOfferPolicy(...args);
      } catch (error) {
        if (error instanceof MarketplaceApiError) {
          headers.set("X-Marketplace-Command-Status", String(error.status));
          const body = error.body;
          if (
            typeof body === "object" &&
            body !== null &&
            "error" in body &&
            typeof body.error === "object" &&
            body.error !== null &&
            "code" in body.error &&
            typeof body.error.code === "string" &&
            /^[a-z_]+$/.test(body.error.code)
          ) {
            headers.set("X-Marketplace-Command-Code", body.error.code);
          }
        }
        throw error;
      }
    },
  });
  return data(result, { headers });
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.view" });
  const api = createMarketplaceRequestApiClient(request);

  const submittedOffers = await api.listSubmittedOffers(DEFAULT_OFFER_QUERY);
  const policies: BuyerOfferPolicyListSnapshot = submittedOffers.items.length
    ? ((await api.listBuyerOfferPolicies(
        submittedOffers.items.map((offer) => offer.offer_id),
      )) as BuyerOfferPolicyListSnapshot)
    : { items: [], offerVersions: {}, nextCursor: null };
  return { submittedOffers, policies: policies.items, offerVersions: policies.offerVersions };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountOffersSubmitted.submitted.offers.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountSubmittedOffersRoute() {
  const data = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData("root") as { actor?: { accountId?: string } | null } | undefined;
  const accountId = rootData?.actor?.accountId ?? null;

  return (
    <MarketplaceAccountSubmittedOffersRealtimeView
      key={[
        accountId ?? "anonymous",
        data.submittedOffers.total,
        data.submittedOffers.items.map((item) => item.offer_id).join("|"),
      ].join("\n")}
      data={data}
      accountId={accountId}
    />
  );
}

function MarketplaceAccountSubmittedOffersRealtimeView({
  data,
  accountId,
}: {
  data: Awaited<ReturnType<typeof loader>>;
  accountId: string | null;
}) {
  const submittedOffers = useRealtimePatchedSnapshot<ListResponse<SubmittedOfferListItem>>({
    initialSnapshot: data.submittedOffers as ListResponse<SubmittedOfferListItem>,
    snapshotKey: JSON.stringify(data.submittedOffers),
    topics: accountId ? marketplaceRealtimeRouteTopics.accountOffers(accountId).topics : [],
    applyPatch: (current, patch) =>
      applyMarketplaceListPatch(current, patch, {
        entity: "marketplace.offer",
        idField: "offer_id",
      }),
    onSyncRequired: reloadForRealtimeSync,
  });

  return (
    <MarketplaceSubmittedOfferListPage
      data={{
        ...submittedOffers,
        items: submittedOffers.items.map((offer) => ({
          ...offer,
          authoritativeOfferVersion: data.offerVersions?.[offer.offer_id],
        })),
      }}
      policies={data.policies}
    />
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
