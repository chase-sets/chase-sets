import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation } from "react-router";
import { classifyPostWriteDestinationResult } from "@chase-sets/http/responses";
import { loadAfterWrite, navigateAfterWrite, type PlatformPostWriteTelemetry } from "@chase-sets/platform-runtime/http";
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

export { OfferMatchDetailErrorBoundary as ErrorBoundary };

const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountOfferMatch.inspect.and.accept.an.offer.match");
const OFFER_MATCH_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-offer-match",
  routeId: "account-offer-match",
  routeTemplate: "/account/offers/matches/:offerId",
} as const satisfies PlatformPostWriteTelemetry;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "offers.view",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response(t("marketplace.routes.accountOfferMatch.forbidden"), { status: 403 });
  }

  const api = createMarketplaceRequestApiClient(request);

  const offerMatchRead = await loadAfterWrite({
    request,
    isNotFound: (error) => error instanceof MarketplaceApiError && error.status === 404,
    load: async () => {
      const offerMatch = await api.getOfferMatch(params.offerId!);
      return {
        offerMatch,
        acceptanceTerms:
          offerMatch.status === "submitted"
            ? await api.previewOfferAcceptanceTerms(params.offerId!, offerMatch.listing_id)
            : null,
      };
    },
    telemetry: OFFER_MATCH_POST_WRITE_TELEMETRY,
  });
  const offerMatchDestination = classifyPostWriteDestinationResult(offerMatchRead);

  if (offerMatchDestination.kind === "recover") {
    return {
      offerMatch: null,
      acceptanceTerms: null,
      recovery: "fresh-write-preparing" as const,
    };
  }

  if (offerMatchDestination.kind === "pass-through") {
    const error = "error" in offerMatchDestination.result ? offerMatchDestination.result.error : null;

    if (error instanceof MarketplaceApiError && error.status === 404) {
      throw new Response(t("marketplace.routes.accountOfferMatch.offer.match.not.found"), { status: 404 });
    }

    if (error) {
      throw error;
    }

    throw new Response(t("marketplace.routes.accountOfferMatch.offer.match.not.found"), { status: 404 });
  }

  return offerMatchDestination.data;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "offers.manage",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response(t("marketplace.routes.accountOfferMatch.forbidden.2"), { status: 403 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceRequestApiClient(request);

  try {
    if (intent === "accept-offer") {
      const result = await api.acceptOfferMatch(params.offerId!, {
        listingId: String(formData.get("listingId") ?? ""),
        feeQuoteFingerprint: String(formData.get("feeQuoteFingerprint") ?? ""),
      });
      return redirect(
        navigateAfterWrite(result, `/account/offers/matches/${params.offerId}`, {
          telemetry: OFFER_MATCH_POST_WRITE_TELEMETRY,
        }),
      );
    }

    if (intent === "decline-offer") {
      const result = await api.declineOfferMatch(params.offerId!);
      return redirect(
        navigateAfterWrite(result, "/account/offers/matches", {
          telemetry: OFFER_MATCH_POST_WRITE_TELEMETRY,
        }),
      );
    }

    if (intent === "mute-offer-buyer") {
      const result = await api.muteOfferBuyer(params.offerId!);
      return redirect(
        navigateAfterWrite(result, "/account/offers/matches", {
          telemetry: OFFER_MATCH_POST_WRITE_TELEMETRY,
        }),
      );
    }

    return null;
  } catch (error) {
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
  }
}

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
