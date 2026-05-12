import { t } from "@chase-sets/localization";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { PlatformFeedbackPrompt } from "@chase-sets/experience/server";
import type { PlatformFeedbackWorkflow } from "@chase-sets/experience/server";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceListingDetail,
  type MarketplaceListingFeeHistoryEntry,
  type MarketplaceListingTermsPreview,
} from "../support/request-support/api-client";
import { MarketplaceListingDetailPage } from "../features/listings/ui/listing-detail-page";

const MARKETPLACE_DESCRIPTION =
  t("marketplace.routes.accountListing.inspect.listing.inventory.pricing.quantity.caps");

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

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "listings.view" });
  const api = createMarketplaceRequestApiClient(request);

  try {
    return {
      listing: await api.getSellerListing(params.listingId!),
      feeHistory: await api.getSellerListingFeeHistory(params.listingId!),
    };
  } catch (error) {
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
        await api.updateListingPrice(params.listingId!, {
          priceAmount: priceDraftAmount,
          feeQuoteFingerprint: formData.get("feeQuoteFingerprint"),
        });
        return redirect(`${pathname}?feedbackWorkflow=listing-update`);
      case "update-quantity-cap":
        await api.updateListingQuantityCap(params.listingId!, {
          quantityCap: Number(formData.get("quantityCap") ?? 0),
          feeQuoteFingerprint: formData.get("feeQuoteFingerprint"),
        });
        return redirect(`${pathname}?feedbackWorkflow=listing-update`);
      case "update-purchase-limits":
        await api.updateListingPurchaseLimits(params.listingId!, {
          purchaseLimits: {
            maxUnitsPerOrder: optionalLimit(formData.get("maxUnitsPerOrder")),
            maxUnitsPerDay: optionalLimit(formData.get("maxUnitsPerDay")),
            maxUnitsPerCustomerAccount: optionalLimit(formData.get("maxUnitsPerCustomerAccount")),
          },
        });
        return redirect(`${pathname}?feedbackWorkflow=listing-update`);
      case "publish":
        await api.publishListing(params.listingId!, {
          feeQuoteFingerprint: formData.get("feeQuoteFingerprint"),
        });
        return redirect(`${pathname}?feedbackWorkflow=listing-publish`);
      case "pause":
        await api.pauseListing(params.listingId!);
        break;
      case "withdraw":
        await api.withdrawListing(params.listingId!);
        break;
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
        error: currentQuote
          ? t("marketplace.routes.accountListing.fee.quote.stale")
          : error.message,
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
    feedbackWorkflow === "listing-publish" || feedbackWorkflow === "listing-update"
      ? feedbackWorkflow
      : null;

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
