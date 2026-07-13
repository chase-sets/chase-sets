import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation } from "react-router";
import {
  loadAfterWrite,
  navigateAfterWriteWithCompactToken,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceListingDetail,
  type MarketplaceListingFeeHistoryEntry,
  type MarketplaceListingTermsPreview,
} from "../support/request-support/api-client";
import {
  resolveMarketplacePostWriteRequest,
  resolveMarketplacePostWriteTokenStore,
} from "../support/route-support/post-write-tokens";
import {
  ListingDetailErrorBoundary,
  ListingDetailRecoveryPage,
} from "../features/listings/ui/listing-detail-error-boundary";
import { MarketplaceListingDetailPage } from "../features/listings/ui/listing-detail-page";

const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountListing.inspect.listing.inventory.pricing.quantity.caps");
const ACCOUNT_LISTING_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-listing",
  routeId: "account-listing",
  routeTemplate: "/account/listings/:listingId",
} as const satisfies PlatformPostWriteTelemetry;

export { ListingDetailErrorBoundary as ErrorBoundary };

function requestWithoutFreshWrite(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete("afterWrite");
  url.searchParams.delete("postWriteHandoff");
  url.searchParams.delete("postWriteToken");
  return new Request(url.toString(), { headers: request.headers });
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
  for (const entry of formData.getAll("evidence")) {
    if (entry instanceof File && entry.size > 0) {
      apiForm.append("evidence", entry);
    }
  }

  return apiForm;
}

async function navigateToAccountListingAfterWrite(commandResult: unknown, destinationRoute: string) {
  return navigateAfterWriteWithCompactToken(commandResult, destinationRoute, {
    postWriteTokenStore: await resolveMarketplacePostWriteTokenStore(),
    telemetry: ACCOUNT_LISTING_POST_WRITE_TELEMETRY,
  });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "listings.view" });
  const resolvedRequest = await resolveMarketplacePostWriteRequest(request);
  const api = createMarketplaceRequestApiClient(resolvedRequest);
  const nonFreshApi = createMarketplaceRequestApiClient(requestWithoutFreshWrite(resolvedRequest));
  const listingRead = await loadAfterWrite<MarketplaceListingDetail>({
    request: resolvedRequest,
    isNotFound: (error) => error instanceof MarketplaceApiError && error.status === 404,
    load: () => api.getSellerListing(params.listingId!),
    telemetry: ACCOUNT_LISTING_POST_WRITE_TELEMETRY,
  });

  if (listingRead.kind === "pending") {
    return {
      listing: null,
      feeHistory: { items: [], total: 0, count: 0 },
      recovery: "fresh-write-preparing" as const,
    };
  }

  if (listingRead.kind === "permanent-failure") {
    const error = "error" in listingRead ? listingRead.error : null;
    if (error instanceof MarketplaceApiError && error.status === 404) {
      throw new Response(t("marketplace.routes.accountListing.listing.not.found"), { status: 404 });
    }

    if (error) {
      throw error;
    }

    throw new Response(t("marketplace.routes.accountListing.listing.not.found"), { status: 404 });
  }

  return {
    listing: listingRead.data,
    feeHistory: await nonFreshApi.getSellerListingFeeHistory(params.listingId!),
  };
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
          await navigateToAccountListingAfterWrite(
            await api.updateListingPrice(params.listingId!, {
              priceAmount: priceDraftAmount,
              feeQuoteFingerprint: formData.get("feeQuoteFingerprint"),
            }),
            pathname,
          ),
        );
      case "update-quantity-cap":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.updateListingQuantityCap(params.listingId!, {
              quantityCap: Number(formData.get("quantityCap") ?? 0),
              feeQuoteFingerprint: formData.get("feeQuoteFingerprint"),
            }),
            pathname,
          ),
        );
      case "update-purchase-limits":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.updateListingPurchaseLimits(params.listingId!, {
              purchaseLimits: {
                maxUnitsPerOrder: optionalLimit(formData.get("maxUnitsPerOrder")),
                maxUnitsPerDay: optionalLimit(formData.get("maxUnitsPerDay")),
                maxUnitsPerCustomerAccount: optionalLimit(formData.get("maxUnitsPerCustomerAccount")),
              },
            }),
            pathname,
          ),
        );
      case "add-photos":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.addListingPhotos(params.listingId!, listingPhotoFormData(formData)),
            pathname,
          ),
        );
      case "publish":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.publishListing(params.listingId!, {
              feeQuoteFingerprint: formData.get("feeQuoteFingerprint"),
            }),
            pathname,
          ),
        );
      case "pause":
        return redirect(await navigateToAccountListingAfterWrite(await api.pauseListing(params.listingId!), pathname));
      case "withdraw":
        return redirect(
          await navigateToAccountListingAfterWrite(await api.withdrawListing(params.listingId!), pathname),
        );
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
  const location = useLocation();

  if (!data.listing) {
    return <ListingDetailRecoveryPage currentPath={`${location.pathname}${location.search}`} />;
  }

  return (
    <MarketplaceListingDetailPage
      listing={data.listing as MarketplaceListingDetail}
      feeHistory={data.feeHistory.items as MarketplaceListingFeeHistoryEntry[]}
      priceDraftAmount={actionData?.priceDraftAmount ?? null}
      pricePreview={actionData?.pricePreview as MarketplaceListingTermsPreview | null | undefined}
      errorMessage={actionData?.error ?? null}
    />
  );
}
