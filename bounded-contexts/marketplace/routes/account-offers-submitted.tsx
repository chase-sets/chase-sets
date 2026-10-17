import { t } from "@chase-sets/localization";
import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, useLoaderData, useNavigate, useRevalidator, useRouteLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { type ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  type SubmittedOfferLifecycleOutcome,
  type SubmittedOfferListItem,
  type SubmittedOfferStatusCounts,
} from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient, MarketplaceApiError } from "../support/request-support/api-client";
import { MarketplaceSubmittedOfferListPage } from "../features/offers/ui/submitted-offer-list-page";
import {
  parseSubmittedOfferStatusFilter,
  SUBMITTED_OFFER_LIFECYCLE_INTENT,
  submittedOfferLifecycleActionValues,
  useSubmittedOfferLifecycle,
  type SubmittedOfferLifecycleControls,
} from "../features/offers/ui/submitted-offer-lifecycle";
import { applySubmittedOfferListPatch } from "../support/realtime-support/patches";
import { marketplaceRealtimeRouteTopics } from "../support/realtime-support/topics";
import { submittedOfferPolicyAction } from "../features/offer-policy/api/submitted-offer-route";
import type { BuyerOfferPolicyListSnapshot } from "../features/offer-policy/api/runtime";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountOffersSubmitted.track.offers.you.have.submitted.against");

function marketplaceErrorCode(error: MarketplaceApiError) {
  const body = error.body as { error?: { code?: unknown } } | null;
  return typeof body?.error?.code === "string" ? body.error.code : "request_failed";
}

/** Pause/Resume/Withdraw: one Offer uses its command route, several use the bulk route; replies are per-row. */
async function submittedOfferLifecycleAction(
  form: FormData,
  api: ReturnType<typeof createMarketplaceRequestApiClient>,
): Promise<{ lifecycle: { outcomes: SubmittedOfferLifecycleOutcome[] } }> {
  const lifecycleAction = submittedOfferLifecycleActionValues.find((value) => value === form.get("lifecycleAction"));
  const offerIds = [...new Set(form.getAll("offerId").map(String).filter(Boolean))];
  if (!lifecycleAction || offerIds.length === 0) throw new Response(null, { status: 400 });
  try {
    if (offerIds.length > 1) {
      const result = await api.bulkChangeSubmittedOfferLifecycle(lifecycleAction, offerIds);
      return { lifecycle: { outcomes: [...result.items] } };
    }
    const offerId = offerIds[0]!;
    const result = await api.changeSubmittedOfferLifecycle(offerId, lifecycleAction);
    return {
      lifecycle: { outcomes: [{ offerId, outcome: result.outcome, status: result.status, version: result.version }] },
    };
  } catch (error) {
    // Closed admission refuses the whole request before any write, so every selected Offer reports it.
    const rejectsEveryOffer =
      error instanceof MarketplaceApiError &&
      (error.status === 503
        ? marketplaceErrorCode(error) === "offer_lifecycle_closed"
        : offerIds.length === 1 && (error.status === 404 || error.status === 409));
    if (rejectsEveryOffer)
      return {
        lifecycle: {
          outcomes: offerIds.map((offerId) => ({
            offerId,
            outcome: "rejected" as const,
            code: marketplaceErrorCode(error),
          })),
        },
      };
    throw error;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.manage" });
  const api = createMarketplaceRequestApiClient(request);
  const lifecycleForm = await request.clone().formData();
  if (lifecycleForm.get("intent") === SUBMITTED_OFFER_LIFECYCLE_INTENT)
    return data(await submittedOfferLifecycleAction(lifecycleForm, api));
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
  const statusFilter = parseSubmittedOfferStatusFilter(new URL(request.url).searchParams.get("status"));

  const submittedOffers = await api.listSubmittedOffers(
    statusFilter === "all" ? DEFAULT_OFFER_QUERY : `${DEFAULT_OFFER_QUERY}&status=${statusFilter}`,
  );
  const policies: BuyerOfferPolicyListSnapshot = submittedOffers.items.length
    ? ((await api.listBuyerOfferPolicies(
        submittedOffers.items.map((offer) => offer.offer_id),
      )) as BuyerOfferPolicyListSnapshot)
    : { items: [], offerVersions: {}, nextCursor: null };
  return { submittedOffers, statusFilter, policies: policies.items, offerVersions: policies.offerVersions };
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
  // Lives above the keyed realtime view so per-row outcomes survive the post-action reload.
  const lifecycle = useSubmittedOfferLifecycle();

  return (
    <MarketplaceAccountSubmittedOffersRealtimeView
      key={[
        accountId ?? "anonymous",
        data.statusFilter,
        data.submittedOffers.total,
        data.submittedOffers.items.map((item) => item.offer_id).join("|"),
      ].join("\n")}
      data={data}
      accountId={accountId}
      lifecycle={lifecycle}
    />
  );
}

type SubmittedOffersSnapshot = ListResponse<SubmittedOfferListItem> & {
  statusCounts?: SubmittedOfferStatusCounts;
  countRevision: number;
};

function MarketplaceAccountSubmittedOffersRealtimeView({
  data,
  accountId,
  lifecycle,
}: {
  data: Awaited<ReturnType<typeof loader>>;
  accountId: string | null;
  lifecycle: SubmittedOfferLifecycleControls;
}) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  const submittedOffers = useRealtimePatchedSnapshot<SubmittedOffersSnapshot>({
    initialSnapshot: { ...(data.submittedOffers as ListResponse<SubmittedOfferListItem>), countRevision: 0 },
    snapshotKey: JSON.stringify(data.submittedOffers),
    topics: accountId ? marketplaceRealtimeRouteTopics.accountOffers(accountId).topics : [],
    applyPatch: (current, patch) => applySubmittedOfferListPatch(current, patch, data.statusFilter),
    onSyncRequired: reloadForRealtimeSync,
  });

  // Another tab's Pause can move an Offer between filters; the loader owns the counts.
  useEffect(() => {
    if (submittedOffers.countRevision > 0) void revalidatorRef.current.revalidate();
  }, [submittedOffers.countRevision]);

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
      statusFilter={data.statusFilter}
      onStatusFilterChange={(filter) =>
        navigate(filter === "all" ? "/account/offers/submitted" : `/account/offers/submitted?status=${filter}`)
      }
      lifecycle={lifecycle}
    />
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
