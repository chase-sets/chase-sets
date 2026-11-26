import { listingRecoveryUrl, loadListingRecovery, prepareListingAction } from "../features/listings/ui/listing-batch";
import {
  ListingRecoveryErrorBoundary,
  ListingRecoveryNotice,
  ListingRecoveryScope,
} from "../features/listings/ui/listing-batch-recovery";
import { t } from "@chase-sets/localization";
import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation, useSearchParams } from "react-router";
import {
  defineFormAction,
  loadAfterWrite,
  navigateAfterWriteWithCompactToken,
  type FormActionContext,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceListingDetail,
  type MarketplaceListingEvidenceReadiness,
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
import {
  listingEvidenceAnalyticsEventNames,
  trackListingEvidenceEvent,
  type ListingEvidenceAnalyticsEventName,
} from "../features/listings/ui/listing-evidence-analytics";
import { authoredTextRecoveryFromApiError } from "../features/reviews/ui/authored-text-recovery";

const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountListing.inspect.listing.inventory.pricing.quantity.caps");
const ACCOUNT_LISTING_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-listing",
  routeId: "account-listing",
  routeTemplate: "/account/listings/:listingId",
} as const satisfies PlatformPostWriteTelemetry;

export function ErrorBoundary() {
  return <ListingRecoveryErrorBoundary fallback={<ListingDetailErrorBoundary />} />;
}

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

function evidenceReadinessFromError(error: MarketplaceApiError): MarketplaceListingEvidenceReadiness | null {
  if (error.status !== 409 || !error.body || typeof error.body !== "object" || !("error" in error.body)) return null;
  const apiError = error.body.error;
  if (!apiError || typeof apiError !== "object" || !("currentEvidenceReadiness" in apiError)) return null;
  return apiError.currentEvidenceReadiness as MarketplaceListingEvidenceReadiness;
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

function replacementPhotoFormData(formData: FormData) {
  const apiForm = new FormData();
  const file = formData.get("listingPhoto");
  if (file instanceof File && file.size > 0) apiForm.set("listingPhoto", file);
  for (const key of ["slotId", "viewKind", "capturedAt"] as const) {
    const value = String(formData.get(key) ?? "").trim();
    if (value) apiForm.set(key, value);
  }
  const altText = String(formData.get("altText") ?? "").trim();
  if (altText) apiForm.set("listingPhotoAltText", altText);
  return apiForm;
}

function parseOrderedPhotoIds(value: FormDataEntryValue | null) {
  try {
    const parsed = JSON.parse(String(value ?? "")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function navigateToAccountListingWithReceipt(commandResult: unknown, destinationRoute: string) {
  return navigateAfterWriteWithCompactToken(commandResult, destinationRoute, {
    postWriteTokenStore: await resolveMarketplacePostWriteTokenStore(),
    telemetry: ACCOUNT_LISTING_POST_WRITE_TELEMETRY,
  });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({ request, permission: "listings.view" });
  const resolvedRequest = await resolveMarketplacePostWriteRequest(request);
  const api = createMarketplaceRequestApiClient(resolvedRequest);
  const nonFreshApi = createMarketplaceRequestApiClient(requestWithoutFreshWrite(resolvedRequest));
  const listingRecovery = await loadListingRecovery(nonFreshApi, request);
  const recoveryData = {
    listing: null,
    feeHistory: { items: [], total: 0, count: 0 },
    recovery: "fresh-write-preparing" as const,
    accountId: actor.accountId,
    listingRecovery,
  };
  const listingRead = await loadAfterWrite<MarketplaceListingDetail>({
    request: resolvedRequest,
    isNotFound: (error) => error instanceof MarketplaceApiError && error.status === 404,
    load: () => api.getSellerListing(params.listingId!),
    telemetry: ACCOUNT_LISTING_POST_WRITE_TELEMETRY,
  });

  if (listingRecovery && listingRead.kind !== "data") return { ...recoveryData, recoveryOnly: true as const };
  if (listingRead.kind === "pending") return recoveryData;

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

  const feeHistory = await nonFreshApi.getSellerListingFeeHistory(params.listingId!).catch((error: unknown) => {
    if (!listingRecovery) throw error;
    return null;
  });
  if (!feeHistory) return { ...recoveryData, recoveryOnly: true as const };
  return {
    accountId: actor.accountId,
    listingRecovery,
    listing: listingRead.data,
    feeHistory,
  };
}

async function handleAction(intent: string, { request, params, formData }: FormActionContext, recoverable = false) {
  const api = createMarketplaceRequestApiClient(request);
  const settingCertification = intent === "set-certification-number";
  const preparation = await prepareListingAction(api, request, formData, params.listingId ?? null, recoverable);
  const certificationNumber = String(formData.get("certificationNumber") ?? "");
  if ("recovery" in preparation) return { listingRecovery: preparation.recovery };
  const identity = preparation.reference;
  const attempt = { idempotencyKey: identity?.batchId ?? "" };
  const navigateToAccountListingAfterWrite = (commandResult: unknown, destinationRoute: string) =>
    navigateToAccountListingWithReceipt(
      commandResult,
      identity ? listingRecoveryUrl(destinationRoute, identity) : destinationRoute,
    );
  const priceDraftAmount = String(formData.get("priceAmount") ?? "");
  const priceDraftCurrencyCode = String(formData.get("priceCurrencyCode") ?? "");

  try {
    const pathname = new URL(request.url).pathname;
    switch (intent) {
      case "preview-price":
        return {
          priceDraftAmount,
          priceDraftCurrencyCode,
          pricePreview: await api.previewListingTerms({
            priceAmount: priceDraftAmount,
          }),
        };
      case "update-price":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.updateListingPrice(params.listingId!, {
              ...attempt,
              priceAmount: priceDraftAmount,
              priceCurrencyCode: priceDraftCurrencyCode,
              feeQuoteFingerprint:
                typeof formData.get("feeQuoteFingerprint") === "string"
                  ? String(formData.get("feeQuoteFingerprint"))
                  : null,
            }),
            pathname,
          ),
        );
      case "update-quantity-cap":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.updateListingQuantityCap(params.listingId!, {
              ...attempt,
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
              ...attempt,
              purchaseLimits: {
                maxUnitsPerOrder: optionalLimit(formData.get("maxUnitsPerOrder")),
                maxUnitsPerDay: optionalLimit(formData.get("maxUnitsPerDay")),
                maxUnitsPerCustomerAccount: optionalLimit(formData.get("maxUnitsPerCustomerAccount")),
              },
            }),
            pathname,
          ),
        );
      case "set-certification-number":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.setListingCertificationNumber(params.listingId!, {
              idempotencyKey: String(formData.get("idempotencyKey") ?? ""),
              certificationNumber,
            }),
            pathname,
          ),
        );
      case "add-photos":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.addListingPhotos(params.listingId!, listingPhotoFormData(formData)),
            `${pathname}?evidenceEvent=upload_completed`,
          ),
        );
      case "classify-photo": {
        const listing = await api.getSellerListing(params.listingId!);
        const slotId = String(formData.get("slotId") ?? "").trim();
        const slot = listing.evidence_readiness.requirements.requiredSlots.find(
          (requirement) => requirement.slotId === slotId,
        );
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.updateListingPhotoClassification(params.listingId!, String(formData.get("photoId") ?? ""), {
              slotId: slot?.slotId ?? null,
              viewKind: slot?.viewKind ?? null,
              altText: String(formData.get("altText") ?? "").trim() || null,
            }),
            `${pathname}?evidenceEvent=remediation_completed`,
          ),
        );
      }
      case "replace-photo":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.replaceListingPhoto(
              params.listingId!,
              String(formData.get("photoId") ?? ""),
              replacementPhotoFormData(formData),
            ),
            `${pathname}?evidenceEvent=upload_completed`,
          ),
        );
      case "remove-photo":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.removeListingPhoto(params.listingId!, String(formData.get("photoId") ?? "")),
            `${pathname}?evidenceEvent=remediation_completed`,
          ),
        );
      case "reorder-photos":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.reorderListingPhotos(params.listingId!, parseOrderedPhotoIds(formData.get("orderedPhotoIds"))),
            `${pathname}?evidenceEvent=remediation_completed`,
          ),
        );
      case "publish":
        return redirect(
          await navigateToAccountListingAfterWrite(
            await api.publishListing(params.listingId!, {
              ...attempt,
              feeQuoteFingerprint: formData.get("feeQuoteFingerprint"),
            }),
            `${pathname}?evidenceEvent=publication_succeeded`,
          ),
        );
      case "pause":
        return redirect(
          await navigateToAccountListingAfterWrite(await api.pauseListing(params.listingId!, attempt), pathname),
        );
      case "withdraw":
        return redirect(
          await navigateToAccountListingAfterWrite(await api.withdrawListing(params.listingId!, attempt), pathname),
        );
      default:
        break;
    }

    return redirect(pathname);
  } catch (error) {
    const listingRecovery = await api.recoverInterruptedListingSend(identity, error);
    if (listingRecovery) return { listingRecovery };
    if (error instanceof MarketplaceApiError) {
      const currentQuote = staleQuoteFromError(error);
      const currentEvidenceReadiness = evidenceReadinessFromError(error);
      const altTextRecovery = intent === "classify-photo" ? authoredTextRecoveryFromApiError(error.body) : null;
      return {
        listingRecovery: identity
          ? {
              identity,
              phase: error.status === 409 ? ("conflict" as const) : ("failed-safe" as const),
              items: [
                {
                  targetId: params.listingId!,
                  outcome: error.status === 409 ? ("conflict" as const) : ("error" as const),
                },
              ],
              retryTargetIds: [],
            }
          : null,
        evidenceAltTextRecovery: altTextRecovery
          ? {
              photoId: String(formData.get("photoId") ?? ""),
              altText: String(formData.get("altText") ?? ""),
              recovery: altTextRecovery,
            }
          : null,
        priceDraftAmount,
        priceDraftCurrencyCode,
        pricePreview: currentQuote,
        evidenceReadiness: currentEvidenceReadiness,
        evidenceAnalyticsEvent:
          currentEvidenceReadiness && intent === "publish"
            ? ("publication_blocked" as const)
            : intent === "add-photos" || intent === "replace-photo"
              ? ("upload_failed" as const)
              : null,
        certificationNumber: settingCertification ? certificationNumber : undefined,
        certificationNumberError: settingCertification ? error.message : undefined,
        error: settingCertification
          ? null
          : currentQuote
            ? t("marketplace.routes.accountListing.fee.quote.stale")
            : error.message,
      };
    }

    throw error;
  }
}

export const action = defineFormAction({
  authorization: { permission: "listings.manage" },
  intents: {
    "preview-price": (context) => handleAction("preview-price", context),
    "update-price": (context) => handleAction("update-price", context, true),
    "update-quantity-cap": (context) => handleAction("update-quantity-cap", context, true),
    "update-purchase-limits": (context) => handleAction("update-purchase-limits", context, true),
    "set-certification-number": (context) => handleAction("set-certification-number", context),
    "add-photos": (context) => handleAction("add-photos", context),
    "classify-photo": (context) => handleAction("classify-photo", context),
    "replace-photo": (context) => handleAction("replace-photo", context),
    "remove-photo": (context) => handleAction("remove-photo", context),
    "reorder-photos": (context) => handleAction("reorder-photos", context),
    publish: (context) => handleAction("publish", context, true),
    pause: (context) => handleAction("pause", context, true),
    withdraw: (context) => handleAction("withdraw", context, true),
  },
  onUnknownIntent: (context) => handleAction("", context),
});

export function shouldRevalidate({
  actionResult,
  defaultShouldRevalidate,
}: {
  actionResult?: unknown;
  defaultShouldRevalidate: boolean;
}) {
  return actionResult &&
    typeof actionResult === "object" &&
    "listingRecovery" in actionResult &&
    actionResult.listingRecovery
    ? false
    : defaultShouldRevalidate;
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
  const [searchParams] = useSearchParams();
  const lastEvidenceAnalyticsKey = useRef<string | null>(null);
  const readiness = actionData?.evidenceReadiness ?? data.listing?.evidence_readiness ?? null;
  const requestedEvidenceEvent = actionData?.evidenceAnalyticsEvent ?? searchParams.get("evidenceEvent");

  useEffect(() => {
    if (
      !requestedEvidenceEvent ||
      !listingEvidenceAnalyticsEventNames.includes(requestedEvidenceEvent as ListingEvidenceAnalyticsEventName)
    ) {
      return;
    }
    if (requestedEvidenceEvent === "remediation_completed" && !readiness?.coverage.complete) return;

    const key = `${requestedEvidenceEvent}:${data.listing?.listing_id ?? "pending"}:${readiness?.policy.policyHash ?? "none"}`;
    if (lastEvidenceAnalyticsKey.current === key) return;
    lastEvidenceAnalyticsKey.current = key;
    const properties = {
      surface: "listing-detail" as const,
      complete: readiness?.coverage.complete,
      unmetCount: readiness?.coverage.unmetCodes.length,
      slotCount: readiness?.coverage.slots.length,
    };
    trackListingEvidenceEvent(requestedEvidenceEvent as ListingEvidenceAnalyticsEventName, properties);
    if (requestedEvidenceEvent === "upload_completed" && readiness?.coverage.complete) {
      trackListingEvidenceEvent("remediation_completed", properties);
    }
  }, [data.listing?.listing_id, readiness, requestedEvidenceEvent]);

  if (!data.listing) {
    return (
      <ListingRecoveryScope recovery={actionData?.listingRecovery ?? data.listingRecovery}>
        <ListingRecoveryNotice />
        {!("recoveryOnly" in data && data.recoveryOnly) ? (
          <ListingDetailRecoveryPage currentPath={`${location.pathname}${location.search}`} />
        ) : null}
      </ListingRecoveryScope>
    );
  }

  const currentListing = actionData?.evidenceReadiness
    ? { ...data.listing, evidence_readiness: actionData.evidenceReadiness }
    : data.listing;
  return (
    <ListingRecoveryScope
      recovery={actionData?.listingRecovery ?? data.listingRecovery}
      listingId={currentListing.listing_id}
    >
      <ListingRecoveryNotice />
      <MarketplaceListingDetailPage
        key={currentListing.listing_id}
        listing={currentListing as MarketplaceListingDetail}
        feeHistory={data.feeHistory.items as MarketplaceListingFeeHistoryEntry[]}
        priceDraftAmount={actionData?.priceDraftAmount ?? null}
        priceDraftCurrencyCode={actionData?.priceDraftCurrencyCode ?? null}
        pricePreview={actionData?.pricePreview as MarketplaceListingTermsPreview | null | undefined}
        errorMessage={actionData?.error ?? null}
        certificationNumberDraft={actionData?.certificationNumber}
        certificationNumberError={actionData?.certificationNumberError}
        evidenceAltTextRecovery={actionData?.evidenceAltTextRecovery ?? null}
      />
    </ListingRecoveryScope>
  );
}
