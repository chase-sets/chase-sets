import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation } from "react-router";
import {
  defineFormAction,
  defineResourceRoute,
  formActionRedirect,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type OfferMatchDetail,
  type MarketplaceListingTermsPreview,
} from "../support/request-support/api-client";
import {
  MarketplaceOfferDetailRecoveryPage,
  OfferMatchDetailErrorBoundary,
} from "../features/offers/ui/offer-detail-error-boundary";
import { MarketplaceOfferMatchDetailPage } from "../features/offers/ui/offer-match-detail-page";
import contextManifest from "../context.json";
import { marketplaceApiErrorAdapter } from "../support/request-support/route-api-error";

export { OfferMatchDetailErrorBoundary as ErrorBoundary };

const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountOfferMatch.inspect.and.accept.an.offer.match");
const OFFER_MATCH_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-offer-match",
  routeId: "account-offer-match",
  routeTemplate: "/account/offers/matches/:offerId",
} as const satisfies PlatformPostWriteTelemetry;

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-offer-match",
  authorization: async ({ request }) => {
    const actor = await requireActorFromAuthApi({ request, permission: "offers.view" });
    if (!actor.permissions.includes("listings.view")) {
      throw new Response(t("marketplace.routes.accountOfferMatch.forbidden"), { status: 403 });
    }
    return actor;
  },
  errorAdapter: marketplaceApiErrorAdapter,
  load: async ({ request, params }) => {
    const api = createMarketplaceRequestApiClient(request);
    const offerMatch = await api.getOfferMatch(params.offerId!);
    return {
      offerMatch,
      acceptanceTerms:
        offerMatch.status === "submitted"
          ? await api.previewOfferAcceptanceTerms(params.offerId!, offerMatch.listing_id)
          : null,
    };
  },
  map: (result) => result,
  onPending: () => ({
    offerMatch: null,
    acceptanceTerms: null,
    recovery: "fresh-write-preparing" as const,
  }),
  messages: { notFound: t("marketplace.routes.accountOfferMatch.offer.match.not.found") },
  telemetry: OFFER_MATCH_POST_WRITE_TELEMETRY,
});

export const action = defineFormAction({
  authorization: async ({ request }) => {
    const actor = await requireActorFromAuthApi({ request, permission: "offers.manage" });
    if (!actor.permissions.includes("listings.view")) {
      throw new Response(t("marketplace.routes.accountOfferMatch.forbidden.2"), { status: 403 });
    }
    return actor;
  },
  intents: {
    "accept-offer": async ({ request, params, formData }) =>
      formActionRedirect(
        await createMarketplaceRequestApiClient(request).acceptOfferMatch(params.offerId!, {
          listingId: String(formData.get("listingId") ?? ""),
          feeQuoteFingerprint: String(formData.get("feeQuoteFingerprint") ?? ""),
        }),
        `/account/offers/matches/${params.offerId}`,
        {
          telemetry: OFFER_MATCH_POST_WRITE_TELEMETRY,
        },
      ),
    "decline-offer": async ({ request, params }) =>
      formActionRedirect(
        await createMarketplaceRequestApiClient(request).declineOfferMatch(params.offerId!),
        "/account/offers/matches",
        {
          telemetry: OFFER_MATCH_POST_WRITE_TELEMETRY,
        },
      ),
    "mute-offer-buyer": async ({ request, params }) =>
      formActionRedirect(
        await createMarketplaceRequestApiClient(request).muteOfferBuyer(params.offerId!),
        "/account/offers/matches",
        {
          telemetry: OFFER_MATCH_POST_WRITE_TELEMETRY,
        },
      ),
  },
  onUnknownIntent: () => null,
  onError: (error) => {
    if (error instanceof MarketplaceApiError && error.status === 409) {
      const currentQuote =
        typeof error.body === "object" &&
        error.body !== null &&
        "error" in error.body &&
        typeof error.body.error === "object" &&
        error.body.error !== null &&
        "currentQuote" in error.body.error
          ? (error.body.error.currentQuote as MarketplaceListingTermsPreview)
          : null;

      return {
        error: t("marketplace.routes.accountOfferMatch.fee.quote.stale"),
        currentQuote,
      };
    }

    return {
      error: error instanceof Error ? error.message : t("marketplace.routes.accountOfferMatch.request.failed"),
      currentQuote: null,
    };
  },
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountOfferMatch.offer.match.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountOfferMatchRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();

  if (!data.offerMatch) {
    return (
      <MarketplaceOfferDetailRecoveryPage kind="offer-match" currentPath={`${location.pathname}${location.search}`} />
    );
  }

  return (
    <MarketplaceOfferMatchDetailPage
      offer={data.offerMatch as OfferMatchDetail}
      acceptanceTerms={
        (actionData?.currentQuote as MarketplaceListingTermsPreview | null | undefined) ??
        (data.acceptanceTerms as MarketplaceListingTermsPreview | null)
      }
      canAccept
      errorMessage={actionData?.error ?? null}
    />
  );
}
