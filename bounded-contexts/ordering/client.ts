import { hc } from "hono/client";
import type { HonoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, type ListResponse } from "@chase-sets/http/responses";
import type { buildOrderingApi } from "./api";

export type {
  OrderingOrderProjection,
  OrderingOrderProjectionDetail,
  OrderingOrderProjectionHold,
  OrderingOrderProjectionLine,
  PurchaseDetail,
  PurchaseListItem,
  SaleDetail,
  SaleListItem,
} from "./features/orders/api/contracts";

import type { PurchaseDetail, PurchaseListItem, SaleDetail, SaleListItem } from "./features/orders/api/contracts";

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

export type CreateCheckoutOrdersRequest = Readonly<{
  checkoutSessionId: string;
  sourceType: "cart-checkout" | "buy-now";
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
    deliveryEstimate: Readonly<{
      earliestDate: string;
      latestDate: string;
      minimumTransitDays: number;
      maximumTransitDays: number;
    }>;
    lines: readonly Readonly<{
      lineKey: string;
      listingId: string;
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
  const client = hc<OrderingApiApp>(baseUrl, {
    fetch: configuredFetch,
  }) as unknown as HonoClientResource;
  const headers = resolveHeaders(initialHeaders);

  return {
    async createCheckoutOrders(body: CreateCheckoutOrdersRequest): Promise<{ orderIds: string[] }> {
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
    async listPurchases(query = ""): Promise<ListResponse<PurchaseListItem>> {
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
    async listSales(query = ""): Promise<ListResponse<SaleListItem>> {
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
  };
}

export const orderingApi = createOrderingApiClient();
