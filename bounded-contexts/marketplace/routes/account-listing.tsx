import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import {
  appendFreshWriteToken,
  loadFreshlyWrittenResource,
  recoverFreshWriteReadError,
} from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { PlatformFeedbackPrompt } from "@chase-sets/platform-operations/server";
import type { PlatformFeedbackWorkflow } from "@chase-sets/platform-operations/server";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceListingDetail,
  type MarketplaceListingFeeHistoryEntry,
  type MarketplaceListingTermsPreview,
} from "../support/request-support/api-client";
import { ListingDetailErrorBoundary } from "../features/listings/ui/listing-detail-error-boundary";
import { MarketplaceListingDetailPage } from "../features/listings/ui/listing-detail-page";

const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountListing.inspect.listing.inventory.pricing.quantity.caps");

export { ListingDetailErrorBoundary as ErrorBoundary };

function listingPreparingResponse() {
  return new Response(t("marketplace.routes.accountListing.listing.preparing.description"), {
    status: 503,
    statusText: t("marketplace.routes.accountListing.listing.preparing"),
  });
}

function staleQuoteFromError(error: MarketplaceApiError) {
  if (error.status !== 409) {
    return null;
  }

  const body = error.body;
  if (
    !body ||
    typeof body !== "object" ||
    !("error" in body) ||
    !body.error ||
    typeof body.error !== "object" ||
    !("currentQuote" in body.error)
  ) {
    return null;
  }

  return body.error.currentQuote as MarketplaceListingTermsPreview;
}

function optionalLimit(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text === "" ? null : Number(text);
}

function listingPhotoFormData(formData: FormData) {
  const apiForm = new FormData();
  for (const entry of formData.getAll("listingPhotos")) {
    if (entry instanceof File && entry.size > 0) {
      apiForm.append("listingPhotos", entry);
    }
  }

  return apiForm;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "listings.view" });
  const api = createMarketplaceRequestApiClient(request);

  try {
    return await loadFreshlyWrittenResource({
      request,
      isNotFound: (error) => error instanceof MarketplaceApiError && error.status === 404,
      load: async () => ({
        listing: await api.getSellerListing(params.listingId!),
        feeHistory: await api.getSellerListingFeeHistory(params.listingId!),
      }),
    });
  } catch (error) {
    const freshWriteRecovery = recoverFreshWriteReadError({
      request,
      error,
      recoverTransient: listingPreparingResponse,
    });
    if (freshWriteRecovery) {
      throw freshWriteRecovery;
    }

    if (error instanceof MarketplaceApiError && error.status === 404) {
      throw new Response(t("marketplace.routes.accountListing.listing.not.found"), { status: 404 });
    }

    throw error;
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "listings.manage" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceRequestApiClient(request);
  const priceDraftAmount = String(formData.get("priceAmount") ?? "");

  try {
    const pathname = new URL(request.url).pathname;
    switch (intent) {
      case "preview-price":
        return {
          priceDraftAmount,
          pricePreview: await api.previewListingTerms({
            priceAmount: priceDraftAmount,
          }),
        };
      case "update-price":
        return redirect(
          appendFreshWriteToken(
            `${pathname}?feedbackWorkflow=listing-update`,
            await api.updateListingPrice(params.listingId!, {
              priceAmount: priceDraftAmount,
              feeQuoteFingerprint: formData.get("feeQuoteFingerprint"),
            }),
          ),
        );
      case "update-quantity-cap":
        return redirect(
          appendFreshWriteToken(
            `${pathname}?feedbackWorkflow=listing-update`,
            await api.updateListingQuantityCap(params.listingId!, {
              quantityCap: Number(formData.get("quantityCap") ?? 0),
              feeQuoteFingerprint: formData.get("feeQuoteFingerprint"),
            }),
          ),
        );
      case "update-purchase-limits":
        return redirect(
          appendFreshWriteToken(
            `${pathname}?feedbackWorkflow=listing-update`,
            await api.updateListingPurchaseLimits(params.listingId!, {
              purchaseLimits: {
                maxUnitsPerOrder: optionalLimit(formData.get("maxUnitsPerOrder")),
                maxUnitsPerDay: optionalLimit(formData.get("maxUnitsPerDay")),
                maxUnitsPerCustomerAccount: optionalLimit(formData.get("maxUnitsPerCustomerAccount")),
              },
            }),
          ),
        );
      case "add-photos":
        return redirect(
          appendFreshWriteToken(
            `${pathname}?feedbackWorkflow=listing-update`,
            await api.addListingPhotos(params.listingId!, listingPhotoFormData(formData)),
          ),
        );
      case "publish":
        return redirect(
          appendFreshWriteToken(
            `${pathname}?feedbackWorkflow=listing-publish`,
            await api.publishListing(params.listingId!, {
              feeQuoteFingerprint: formData.get("feeQuoteFingerprint"),
            }),
          ),
        );
      case "pause":
        return redirect(appendFreshWriteToken(pathname, await api.pauseListing(params.listingId!)));
      case "withdraw":
        return redirect(appendFreshWriteToken(pathname, await api.withdrawListing(params.listingId!)));
      default:
        break;
    }

    return redirect(pathname);
  } catch (error) {
    if (error instanceof MarketplaceApiError) {
      const currentQuote = staleQuoteFromError(error);
      return {
        priceDraftAmount,
        pricePreview: currentQuote,
        error: currentQuote ? t("marketplace.routes.accountListing.fee.quote.stale") : error.message,
      };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountListing.listing.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountListingRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const feedbackWorkflow = searchParams.get("feedbackWorkflow");
  const listingFeedbackWorkflow: PlatformFeedbackWorkflow | null =
    feedbackWorkflow === "listing-publish" || feedbackWorkflow === "listing-update" ? feedbackWorkflow : null;

  return (
    <MarketplaceListingDetailPage
      listing={data.listing as MarketplaceListingDetail}
      feeHistory={data.feeHistory.items as MarketplaceListingFeeHistoryEntry[]}
      priceDraftAmount={actionData?.priceDraftAmount ?? null}
      pricePreview={actionData?.pricePreview as MarketplaceListingTermsPreview | null | undefined}
      errorMessage={actionData?.error ?? null}
      feedbackPrompt={
        listingFeedbackWorkflow ? (
          <PlatformFeedbackPrompt
            workflow={listingFeedbackWorkflow}
            sourceRoutePath={`/account/listings/${data.listing.listing_id}`}
            relatedEntities={[
              { type: "listing", id: data.listing.listing_id },
              { type: "inventory-item", id: data.listing.inventory_item_id },
            ]}
            title={t("marketplace.routes.accountListing.feedback.title")}
            description={t("marketplace.routes.accountListing.feedback.description")}
          />
        ) : null
      }
    />
  );
}
