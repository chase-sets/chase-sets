import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, type ListResponse, type SourceCommitPosition } from "@chase-sets/http/responses";
import type { CheckoutOrderingSourceType } from "@chase-sets/checkout-order-source";
import type { buildOrderingApi } from "./api";

export type {
  OrderingOrderProjection,
  OrderingOrderProjectionDetail,
  OrderingOrderProjectionHold,
  OrderingOrderProjectionLine,
  OrderListSummary,
  PurchaseDetail,
  PurchaseListItem,
  SaleDetail,
  SaleListItem,
} from "./features/orders/api/contracts";

import type {
  OrderListSummary,
  PurchaseDetail,
  PurchaseListItem,
  SaleDetail,
  SaleListItem,
} from "./features/orders/api/contracts";
import type { PackagePlan, PostagePolicy, ProductPhysicalFlag, ShippingOption } from "@chase-sets/product-measures";

type OrderingApiApp = ReturnType<typeof buildOrderingApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export type OrderingCheckoutLineSnapshot = Readonly<{
  listingId: string | null;
  cartLineId: string | null;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly Readonly<{
    dimensionId: string;
    optionId: string;
  }>[];
  productSummary: string | null;
  quantity: number;
  fulfillmentMode?: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
}>;

export type OrderingCheckoutReservationInput = Readonly<{
  holdId: string;
  sellerAccountId: string;
  inventoryItemId: string;
  quantity: number;
}>;

export type CreateCheckoutOrdersRequest = Readonly<{
  checkoutSessionId: string;
  sourceType: CheckoutOrderingSourceType;
  shippingOption: "standard" | "expedited" | "priority";
  shippingAddress: Readonly<{
    name: string;
    company?: string | null;
    line1: string;
    line2?: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string | null;
    email?: string | null;
  }>;
  lines: readonly OrderingCheckoutLineSnapshot[];
  optimizationGoal?: "lowest-total" | "fewest-shipments";
  fulfillmentPreviewRevision?: string | null;
  acknowledgedMaterialChanges?: boolean;
  checkoutReservations?: readonly OrderingCheckoutReservationInput[];
  /** The buyer's authenticity-check opt-in (m109). */
  authenticityCheckOptIn?: Readonly<{ selected: true; quoteFingerprint: string }>;
}>;

export type CreateCheckoutOrdersResponse = Readonly<{
  orderIds: string[];
  commitPosition?: string;
  commitEventIds?: readonly string[];
  commitPositions?: readonly SourceCommitPosition[];
}>;

export type PreviewCheckoutFulfillmentRequest = Omit<CreateCheckoutOrdersRequest, "shippingAddress"> &
  Readonly<{
    shippingAddress?: CreateCheckoutOrdersRequest["shippingAddress"] | null;
  }>;

export type CheckoutFulfillmentPreview = Readonly<{
  revision: string;
  optimizationGoal: "lowest-total" | "fewest-shipments";
  readyLineKeys: readonly string[];
  unavailableLineKeys: readonly string[];
  sellerGroups: readonly Readonly<{
    sellerAccountId: string;
    sellerDisplayName: string | null;
    itemSubtotalAmount: string;
    shippingChargeAmount: string;
    salesTaxAmount: string;
    totalAmount: string;
    postageRequirements: Readonly<{
      policyVersion: string;
      parcelRequired: boolean;
      parcelReasons: readonly string[];
      signatureRequired: boolean;
      signatureReasons: readonly string[];
      insuranceRequired: boolean;
      insuranceReasons: readonly string[];
      insuredValueAmount: string | null;
      shippingEvidenceTier: string;
    }>;
    deliveryEstimate: Readonly<{
      earliestDate: string;
      latestDate: string;
      minimumTransitDays: number;
      maximumTransitDays: number;
      handlingDays: number;
      packageCount: number;
      shipFromRegion: string;
      serviceLevel: string;
      promiseOwner: "fulfillment";
      promiseSource: "fulfillment-promise-policy";
      promiseConfidence: "estimated";
      cutoffTimeLocal: string;
      packingStartDate: string;
      carrierHandoffDate: string;
      basis: string;
    }>;
    lines: readonly Readonly<{
      lineKey: string;
      listingId: string;
      sellerAccountId: string;
      inventoryItemId: string;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      productSummary: string | null;
      quantity: number;
      estimatedUnitPriceAmount: string;
      estimatedLineTotalAmount: string;
      priceState: "available" | "changed" | "unavailable" | "locked";
      materialChangeReasons: readonly string[];
    }>[];
  }>[];
  totals: Readonly<{
    itemSubtotalAmount: string;
    shippingAmount: string;
    salesTaxAmount: string;
    totalAmount: string;
    packageCount: number;
  }>;
  unavailableLines: readonly Readonly<{
    lineKey: string;
    catalogItemId: string;
    productId: string;
    itemTitle: string;
    productSummary: string | null;
    quantity: number;
    reason: string;
  }>[];
  materialChangeReasons: readonly string[];
  /** The authenticity-check opt-in offer (m109); null when not offered. */
  authenticityCheckOffer?: Readonly<{
    eligible: boolean;
    order_value_amount: string;
    threshold_amount: string;
    category: "raw" | "graded" | "any";
    fee_amount: string;
    policy_version: string;
    quote_fingerprint: string;
    quoted_at: string;
  }> | null;
}>;

export type PostagePolicyAdminRecord = Readonly<{
  policy_id: string;
  label: string;
  status: string;
  policy_version: string;
  payload: PostagePolicy;
  effective_from: string;
  effective_until: string | null;
  activation_reason: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  retired_at: string | null;
  history?: readonly Readonly<{
    history_id: string;
    policy_id: string;
    event_type: string;
    actor_user_id: string;
    reason: string | null;
    status: string;
    policy_version: string;
    payload: PostagePolicy;
    effective_from: string;
    effective_until: string | null;
    recorded_at: string;
  }>[];
  activeComparison?: readonly Readonly<{
    field: string;
    activeValue: string;
    candidateValue: string;
  }>[];
}>;

export type PostagePolicyCommandRequest = Partial<PostagePolicy> &
  Readonly<{
    label: string;
    effectiveFrom: string;
    effectiveUntil?: string | null;
  }>;

export type PostagePolicyPreviewRequest = Readonly<{
  policy: Partial<PostagePolicy>;
  shippingOption: ShippingOption;
  itemSubtotalAmount: string;
  quantity: number;
  unitLengthInches: number;
  unitWidthInches: number;
  unitHeightInches: number;
  unitWeightOunces: number;
  physicalFlags: readonly ProductPhysicalFlag[];
}>;

export class OrderingApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: unknown }).error === "object" &&
        (body as { error?: unknown }).error !== null &&
        "message" in (body as { error: Record<string, unknown> }).error
        ? String((body as { error: { message?: unknown } }).error.message)
        : `API error ${status}`,
    );
  }
}

export interface OrderingApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new OrderingApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

export function createOrderingApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: OrderingApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = honoClientResource(
    hc<OrderingApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return {
    async createCheckoutOrders(body: CreateCheckoutOrdersRequest): Promise<CreateCheckoutOrdersResponse> {
      return parseJsonResponse(
        await client.account.purchases.checkout.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async previewCheckoutFulfillment(body: PreviewCheckoutFulfillmentRequest): Promise<CheckoutFulfillmentPreview> {
      return parseJsonResponse(
        await client.account.purchases.checkout.preview.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async listPurchases(
      query = "",
    ): Promise<ListResponse<PurchaseListItem> & { limit: number; offset: number; summary: OrderListSummary }> {
      return parseJsonResponse(
        await client.account.purchases.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getPurchase(purchaseId: string): Promise<PurchaseDetail> {
      return parseJsonResponse(
        await client.account.purchases[":id"].$get({
          param: { id: purchaseId },
          header: headers,
        }),
      );
    },
    async cancelPurchase(purchaseId: string) {
      return parseJsonResponse(
        await client.account.purchases[":id"].cancel.$post({
          param: { id: purchaseId },
          json: {},
          header: headers,
        }),
      );
    },
    async listSales(
      query = "",
    ): Promise<ListResponse<SaleListItem> & { limit: number; offset: number; summary: OrderListSummary }> {
      return parseJsonResponse(
        await client.account.sales.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getSale(saleId: string): Promise<SaleDetail> {
      return parseJsonResponse(
        await client.account.sales[":id"].$get({
          param: { id: saleId },
          header: headers,
        }),
      );
    },
    async cancelSale(saleId: string) {
      return parseJsonResponse(
        await client.account.sales[":id"].cancel.$post({
          param: { id: saleId },
          json: {},
          header: headers,
        }),
      );
    },
    async listPostagePolicies(query = ""): Promise<ListResponse<PostagePolicyAdminRecord>> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies?${query}`, {
          headers,
        }),
      );
    },
    async getPostagePolicy(policyId: string): Promise<PostagePolicyAdminRecord> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/${encodeURIComponent(policyId)}`, {
          headers,
        }),
      );
    },
    async createPostagePolicy(body: PostagePolicyCommandRequest): Promise<{ id: string; version: number }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async previewPostagePolicy(body: PostagePolicyPreviewRequest): Promise<{ packagePlan: PackagePlan }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/preview`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async revisePostagePolicy(
      policyId: string,
      body: PostagePolicyCommandRequest,
    ): Promise<{ id: string; version: number }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/${encodeURIComponent(policyId)}`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async activatePostagePolicy(policyId: string, activationReason: string): Promise<{ id: string; version: number }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/${encodeURIComponent(policyId)}/activate`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ activationReason }),
        }),
      );
    },
    async clonePostagePolicy(
      policyId: string,
      body: Readonly<{ label: string; effectiveFrom: string; effectiveUntil?: string | null }>,
    ): Promise<{ id: string; version: number }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/${encodeURIComponent(policyId)}/clone`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async retirePostagePolicy(policyId: string, retirementReason: string): Promise<{ id: string; version: number }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/${encodeURIComponent(policyId)}/retire`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ retirementReason }),
        }),
      );
    },
  };
}

export const orderingApi = createOrderingApiClient();
