import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import type { ListResponse, SourceCommitPosition } from "@chase-sets/http/responses";
import type { CheckoutOrderingSourceType } from "@chase-sets/checkout-order-source";
import type { buildOrderingApi } from "./api";
import { createPostagePolicyClient } from "./features/postage-policies/api/client";
import {
  createOrderingClientTransport,
  parseJsonResponse,
  type OrderingApiClientOptions,
} from "./support/request-support/client";

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
import type { OrderCleanupAuthorityReport } from "./features/orders/api/cleanup-authority";

export type { OrderCleanupAuthorityReport, OrderCleanupAuthorityState } from "./features/orders/api/cleanup-authority";

/**
 * N8 request body. Exactly one field: the durable instant the caller's
 * evidence window opened, captured before its first product mutation. No
 * buyer, Order, or source identity travels in the body.
 */
export type ObserveOrderCleanupAuthorityRequest = Readonly<{ windowOpenedAt: string }>;

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

export type {
  PostagePolicyAdminRecord,
  PostagePolicyCommandRequest,
  PostagePolicyPreviewRequest,
} from "./features/postage-policies/api/contracts";
export { OrderingApiError, type OrderingApiClientOptions } from "./support/request-support/client";

type OrderingApiApp = ReturnType<typeof buildOrderingApi>;

export function createOrderingApiClient(options?: OrderingApiClientOptions) {
  const transport = createOrderingClientTransport(options);
  const { baseUrl, configuredFetch, headers } = transport;
  const client = honoClientResource(hc<OrderingApiApp>(baseUrl, { fetch: configuredFetch }));

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
    /**
     * N8: read-only cleanup-authority observation for one purchase. The route
     * only exists while the host mounts the Inventory cleanup authority.
     */
    async observeCleanupAuthority(
      purchaseId: string,
      body: ObserveOrderCleanupAuthorityRequest,
    ): Promise<OrderCleanupAuthorityReport> {
      return parseJsonResponse(
        await client.account.purchases[":id"]["cleanup-authority"].$post({
          param: { id: purchaseId },
          json: body,
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
    ...createPostagePolicyClient(transport),
  };
}

export const orderingApi = createOrderingApiClient();
