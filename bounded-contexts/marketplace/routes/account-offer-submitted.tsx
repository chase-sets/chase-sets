import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useLocation } from "react-router";
import { classifyPostWriteDestinationResult } from "@chase-sets/http/responses";
import { loadAfterWrite, type PlatformPostWriteTelemetry } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { MarketplaceApiError, type SubmittedOfferDetail } from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import {
  MarketplaceOfferDetailRecoveryPage,
  SubmittedOfferDetailErrorBoundary,
} from "../features/offers/ui/offer-detail-error-boundary";
import { MarketplaceSubmittedOfferDetailPage } from "../features/offers/ui/submitted-offer-detail-page";

export { SubmittedOfferDetailErrorBoundary as ErrorBoundary };

const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountOfferSubmitted.review.pricing.demand.and.status.for");
const SUBMITTED_OFFER_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-offer-submitted",
  routeId: "account-offer-submitted",
  routeTemplate: "/account/offers/submitted/:offerId",
} as const satisfies PlatformPostWriteTelemetry;

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.view" });
  const api = createMarketplaceRequestApiClient(request);
  const submittedOfferRead = await loadAfterWrite<SubmittedOfferDetail>({
    request,
    isNotFound: (error) => error instanceof MarketplaceApiError && error.status === 404,
    load: () => api.getSubmittedOffer(params.offerId!),
    telemetry: SUBMITTED_OFFER_POST_WRITE_TELEMETRY,
  });
  const submittedOfferDestination = classifyPostWriteDestinationResult(submittedOfferRead);

  if (submittedOfferDestination.kind === "recover") {
    return {
      submittedOffer: null,
      recovery: "fresh-write-preparing" as const,
    };
  }

  if (submittedOfferDestination.kind === "pass-through") {
    const error = "error" in submittedOfferDestination.result ? submittedOfferDestination.result.error : null;
    if (error instanceof MarketplaceApiError && error.status === 404) {
      throw new Response(t("marketplace.routes.accountOfferSubmitted.submitted.offer.not.found"), { status: 404 });
    }

    if (error) {
      throw error;
    }

    throw new Response(t("marketplace.routes.accountOfferSubmitted.submitted.offer.not.found"), { status: 404 });
  }

  return {
    submittedOffer: submittedOfferDestination.data,
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountOfferSubmitted.submitted.offer.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountSubmittedOfferRoute() {
  const data = useLoaderData<typeof loader>();
  const location = useLocation();

  if (!data.submittedOffer) {
    return (
      <MarketplaceOfferDetailRecoveryPage
        kind="submitted-offer"
        currentPath={`${location.pathname}${location.search}`}
      />
    );
  }

  return <MarketplaceSubmittedOfferDetailPage offer={data.submittedOffer as SubmittedOfferDetail} />;
}
