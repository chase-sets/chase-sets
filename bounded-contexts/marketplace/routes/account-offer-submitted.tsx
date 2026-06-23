import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useLocation, useSearchParams } from "react-router";
import { loadFreshlyWrittenResource, readApiErrorCode, recoverFreshWriteReadError } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { PlatformFeedbackPrompt } from "@chase-sets/platform-operations/server";
import { MarketplaceApiError, type SubmittedOfferDetail } from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import {
  MarketplaceOfferDetailRecoveryPage,
  SubmittedOfferDetailErrorBoundary,
} from "../features/offers/ui/offer-detail-error-boundary";
import { MarketplaceSubmittedOfferDetailPage } from "../features/offers/ui/submitted-offer-detail-page";

export { SubmittedOfferDetailErrorBoundary as ErrorBoundary };

const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountOfferSubmitted.review.pricing.demand.and.status.for");

function marketplaceApiErrorStatus(error: unknown) {
  return error instanceof MarketplaceApiError ? error.status : null;
}

function marketplaceApiErrorBody(error: unknown) {
  return error instanceof MarketplaceApiError ? error.body : null;
}

function marketplaceApiErrorCode(error: unknown) {
  return readApiErrorCode(marketplaceApiErrorBody(error));
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.view" });
  const api = createMarketplaceRequestApiClient(request);

  try {
    return await loadFreshlyWrittenResource({
      request,
      isNotFound: (error) => error instanceof MarketplaceApiError && error.status === 404,
      load: async () => ({
        submittedOffer: await api.getSubmittedOffer(params.offerId!),
      }),
    });
  } catch (error) {
    const freshWriteRecovery = recoverFreshWriteReadError({
      request,
      error,
      getStatus: marketplaceApiErrorStatus,
      getErrorCode: marketplaceApiErrorCode,
      getBody: marketplaceApiErrorBody,
      recoverTransient: () => ({
        submittedOffer: null,
        recovery: "fresh-write-preparing" as const,
      }),
    });
    if (freshWriteRecovery) {
      return freshWriteRecovery;
    }

    if (error instanceof MarketplaceApiError && error.status === 404) {
      throw new Response(t("marketplace.routes.accountOfferSubmitted.submitted.offer.not.found"), { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountOfferSubmitted.submitted.offer.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountSubmittedOfferRoute() {
  const data = useLoaderData<typeof loader>();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  if (!data.submittedOffer) {
    return (
      <MarketplaceOfferDetailRecoveryPage
        kind="submitted-offer"
        currentPath={`${location.pathname}${location.search}`}
      />
    );
  }

  const shouldShowFeedback = searchParams.get("feedbackWorkflow") === "offer-submit";

  return (
    <MarketplaceSubmittedOfferDetailPage
      offer={data.submittedOffer as SubmittedOfferDetail}
      feedbackPrompt={
        shouldShowFeedback ? (
          <PlatformFeedbackPrompt
            workflow="offer-submit"
            sourceRoutePath={`/account/offers/submitted/${data.submittedOffer.offer_id}`}
            relatedEntities={[
              { type: "offer", id: data.submittedOffer.offer_id },
              { type: "catalog-item", id: data.submittedOffer.catalog_catalog_item_id },
            ]}
            title={t("marketplace.routes.accountOfferSubmitted.feedback.title")}
            description={t("marketplace.routes.accountOfferSubmitted.feedback.description")}
          />
        ) : null
      }
    />
  );
}
