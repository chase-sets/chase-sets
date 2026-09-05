import type {
  CartReadinessDecisionInput,
  createCheckoutRequestApiClient,
  CreateCheckoutSessionRequest,
} from "../../request-support/api-client";
import { parseCheckoutStartCartReadinessDecisions } from "../../../features/cart/api/readiness-decisions";
import type { CheckoutStartSource } from "../../../features/sessions/ui/checkout-start-page-types";

export type CheckoutRequestApi = ReturnType<typeof createCheckoutRequestApiClient>;

function parseSelectedOptions(value: string | null) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((selection): selection is { dimensionId: string; optionId: string } =>
            Boolean(
              selection && typeof selection === "object" && "dimensionId" in selection && "optionId" in selection,
            ),
          )
          .map((selection) => ({
            dimensionId: String(selection.dimensionId ?? ""),
            optionId: String(selection.optionId ?? ""),
          }))
      : [];
  } catch {
    return [];
  }
}

function parseQuantity(value: FormDataEntryValue | string | null) {
  const quantity = Number(value ?? 1);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function parseReadinessDecisions(value: FormDataEntryValue | null): CartReadinessDecisionInput | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parseCheckoutStartCartReadinessDecisions(parsed);
  } catch {
    return null;
  }
}

function entryAttemptKeyFromForm(formData: FormData) {
  const key = String(formData.get("entryAttemptKey") ?? "").trim();
  return key ? key : null;
}

function withEntryAttemptKey(request: CreateCheckoutSessionRequest, formData: FormData): CreateCheckoutSessionRequest {
  const entryAttemptKey = entryAttemptKeyFromForm(formData);
  return entryAttemptKey ? { ...request, entryAttemptKey } : request;
}

export function sourceFromUrl(url: URL): CheckoutStartSource | null {
  const sourceType = url.searchParams.get("source");
  if (sourceType !== "buy-now" && sourceType !== "offer-intent") {
    return null;
  }

  if (sourceType === "offer-intent") {
    return {
      type: "offer-intent" as const,
      catalogItemId: url.searchParams.get("catalogItemId") ?? "",
      productId: url.searchParams.get("productId") ?? "",
      itemTitle: url.searchParams.get("itemTitle") ?? "",
      itemSubtitle: url.searchParams.get("itemSubtitle") || null,
      selectedOptions: parseSelectedOptions(url.searchParams.get("selectedOptions")),
      productSummary: url.searchParams.get("productSummary") || null,
      offerPriceAmount: url.searchParams.get("offerPriceAmount") ?? url.searchParams.get("priceAmount") ?? "",
      quantity: parseQuantity(url.searchParams.get("quantity") ?? url.searchParams.get("quantityRequested")),
    };
  }

  return {
    type: "buy-now" as const,
    listingId: url.searchParams.get("listingId") ?? "",
    fulfillmentMode:
      url.searchParams.get("fulfillmentMode") === "locked-listing"
        ? ("locked-listing" as const)
        : ("optimize" as const),
    lockedListingId: url.searchParams.get("lockedListingId") || null,
    catalogItemId: url.searchParams.get("catalogItemId") ?? "",
    productId: url.searchParams.get("productId") ?? "",
    itemTitle: url.searchParams.get("itemTitle") ?? "",
    itemSubtitle: url.searchParams.get("itemSubtitle") || null,
    selectedOptions: parseSelectedOptions(url.searchParams.get("selectedOptions")),
    productSummary: url.searchParams.get("productSummary") || null,
    quantity: parseQuantity(url.searchParams.get("quantity")),
    priceAmount: url.searchParams.get("priceAmount") || null,
    sellerName: url.searchParams.get("sellerName") || null,
    availability: url.searchParams.get("availability") || null,
    fulfillment: url.searchParams.get("fulfillment") || null,
  };
}

function sourceFromForm(formData: FormData): CheckoutStartSource {
  if (String(formData.get("source") ?? "cart") === "offer-intent") {
    return {
      type: "offer-intent" as const,
      catalogItemId: String(formData.get("catalogItemId") ?? ""),
      productId: String(formData.get("productId") ?? ""),
      itemTitle: String(formData.get("itemTitle") ?? ""),
      itemSubtitle: String(formData.get("itemSubtitle") ?? "") || null,
      selectedOptions: parseSelectedOptions(String(formData.get("selectedOptions") ?? "[]")),
      productSummary: String(formData.get("productSummary") ?? "") || null,
      offerPriceAmount: String(formData.get("offerPriceAmount") ?? formData.get("priceAmount") ?? ""),
      quantity: parseQuantity(formData.get("quantity") ?? formData.get("quantityRequested")),
    };
  }

  return {
    type: "buy-now" as const,
    listingId: String(formData.get("listingId") ?? ""),
    fulfillmentMode:
      formData.get("fulfillmentMode") === "locked-listing" ? ("locked-listing" as const) : ("optimize" as const),
    lockedListingId: String(formData.get("lockedListingId") ?? "") || null,
    catalogItemId: String(formData.get("catalogItemId") ?? ""),
    productId: String(formData.get("productId") ?? ""),
    itemTitle: String(formData.get("itemTitle") ?? ""),
    itemSubtitle: String(formData.get("itemSubtitle") ?? "") || null,
    selectedOptions: parseSelectedOptions(String(formData.get("selectedOptions") ?? "[]")),
    productSummary: String(formData.get("productSummary") ?? "") || null,
    quantity: parseQuantity(formData.get("quantity")),
    priceAmount: String(formData.get("priceAmount") ?? "") || null,
    sellerName: String(formData.get("sellerName") ?? "") || null,
    availability: String(formData.get("availability") ?? "") || null,
    fulfillment: String(formData.get("fulfillment") ?? "") || null,
  };
}

export function checkoutSessionRequestFromForm(
  formData: FormData,
  authoritativeSource: CheckoutStartSource | null = null,
): CreateCheckoutSessionRequest {
  if (authoritativeSource?.type === "buy-now") {
    return withEntryAttemptKey({ source: authoritativeSource }, formData);
  }

  if (authoritativeSource?.type === "offer-intent") {
    return withEntryAttemptKey({ source: authoritativeSource }, formData);
  }

  const sourceType = String(formData.get("source") ?? "cart");
  if (sourceType === "offer-intent") {
    const source = sourceFromForm(formData);
    if (source.type !== "offer-intent") {
      throw new Error("Purchase intent source was not preserved.");
    }
    return withEntryAttemptKey({ source }, formData);
  }

  if (sourceType === "buy-now") {
    const source = sourceFromForm(formData);
    if (source.type !== "buy-now") {
      throw new Error("Buy now source was not preserved.");
    }
    return withEntryAttemptKey({ source }, formData);
  }

  return withEntryAttemptKey(
    {
      source: {
        type: "cart" as const,
        readinessSnapshotId: String(formData.get("readinessSnapshotId") ?? ""),
        readinessSourceRevision: String(formData.get("readinessSourceRevision") ?? ""),
        readinessDecisions: parseReadinessDecisions(formData.get("readinessDecisions")),
      },
    },
    formData,
  );
}

export async function ensureCartReadinessSnapshot(
  api: CheckoutRequestApi,
  request: CreateCheckoutSessionRequest,
  options: Readonly<{ forceRefresh?: boolean }> = {},
): Promise<CreateCheckoutSessionRequest> {
  if (request.source.type !== "cart") {
    return request;
  }

  const hasReadinessToken = Boolean(request.source.readinessSnapshotId && request.source.readinessSourceRevision);
  if (hasReadinessToken && !options.forceRefresh) {
    return request;
  }

  const readiness = await api.createCartReadiness(request.source.readinessDecisions ?? {});
  return {
    source: {
      ...request.source,
      readinessSnapshotId: readiness.readiness.snapshotId,
      readinessSourceRevision: readiness.readiness.sourceRevision,
      readinessDecisions: request.source.readinessDecisions,
    },
  };
}
