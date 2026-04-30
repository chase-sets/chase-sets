import { hc } from "hono/client";
import type { ListResponse } from "@chase-sets/http/responses";
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

import type {
  PurchaseDetail,
  PurchaseListItem,
  SaleDetail,
  SaleListItem,
} from "./features/orders/api/contracts";

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
}>;

export type CreateCheckoutOrdersRequest = Readonly<{
  checkoutSessionId: string;
  sourceType: "cart-checkout" | "buy-now";
  shippingOption: "standard" | "expedited" | "priority";
  lines: readonly OrderingCheckoutLineSnapshot[];
}>;

export class OrderingApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body !== null && "error" in body
        ? String((body as Record<string, unknown>).error)
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

  return response.json() as Promise<T>;
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
  const client = hc<OrderingApiApp>(baseUrl, { fetch: configuredFetch }) as any;
  const headers = resolveHeaders(initialHeaders);

  return {
    async createCheckoutOrders(
      body: CreateCheckoutOrdersRequest,
    ): Promise<{ orderIds: string[] }> {
      return parseJsonResponse(
        await client.buyer.purchases.checkout.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async listPurchases(
      query = "",
    ): Promise<ListResponse<PurchaseListItem>> {
      return parseJsonResponse(
        await client.buyer.purchases.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getPurchase(purchaseId: string): Promise<PurchaseDetail> {
      return parseJsonResponse(
        await client.buyer.purchases[":id"].$get({
          param: { id: purchaseId },
          header: headers,
        }),
      );
    },
    async cancelPurchase(purchaseId: string) {
      return parseJsonResponse(
        await client.buyer.purchases[":id"].cancel.$post({
          param: { id: purchaseId },
          json: {},
          header: headers,
        }),
      );
    },
    async listSales(
      query = "",
    ): Promise<ListResponse<SaleListItem>> {
      return parseJsonResponse(
        await client.seller.sales.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getSale(saleId: string): Promise<SaleDetail> {
      return parseJsonResponse(
        await client.seller.sales[":id"].$get({
          param: { id: saleId },
          header: headers,
        }),
      );
    },
    async cancelSale(saleId: string) {
      return parseJsonResponse(
        await client.seller.sales[":id"].cancel.$post({
          param: { id: saleId },
          json: {},
          header: headers,
        }),
      );
    },
  };
}

export const orderingApi = createOrderingApiClient();
