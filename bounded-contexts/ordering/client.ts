export { default as contextManifest } from "./context.json";
import { hc } from "hono/client";
import type { ListResponse } from "@chase-sets/http/responses";
import type { buildOrderingApi } from "./api";

export type { OrderingCartLine } from "./cart/ui/contracts";
export type {
  OrderingOrderDetail,
  OrderingOrderHold,
  OrderingOrderLine,
  OrderingOrderListItem,
} from "./orders/ui/contracts";

import type { OrderingCartLine } from "./cart/ui/contracts";
import type {
  OrderingOrderDetail,
  OrderingOrderListItem,
} from "./orders/ui/contracts";

type OrderingApiApp = ReturnType<typeof buildOrderingApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

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
    async getCart(): Promise<{ items: readonly OrderingCartLine[]; count: number }> {
      return parseJsonResponse(
        await client.buyer.cart.$get({ header: headers }),
      );
    },
    async addCartLine(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.buyer.cart.$post({ json: body, header: headers }),
      );
    },
    async updateCartLineQuantity(lineId: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.buyer.cart[":lineId"].quantity.$post({
          param: { lineId },
          json: body,
          header: headers,
        }),
      );
    },
    async removeCartLine(lineId: string) {
      return parseJsonResponse(
        await client.buyer.cart[":lineId"].remove.$post({
          param: { lineId },
          json: {},
          header: headers,
        }),
      );
    },
    async checkoutCart(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.buyer.cart.checkout.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async listBuyerOrders(
      query = "",
    ): Promise<ListResponse<OrderingOrderListItem>> {
      return parseJsonResponse(
        await client.buyer.orders.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getBuyerOrder(orderId: string): Promise<OrderingOrderDetail> {
      return parseJsonResponse(
        await client.buyer.orders[":id"].$get({
          param: { id: orderId },
          header: headers,
        }),
      );
    },
    async cancelBuyerOrder(orderId: string) {
      return parseJsonResponse(
        await client.buyer.orders[":id"].cancel.$post({
          param: { id: orderId },
          json: {},
          header: headers,
        }),
      );
    },
    async listSellerOrders(
      query = "",
    ): Promise<ListResponse<OrderingOrderListItem>> {
      return parseJsonResponse(
        await client.seller.orders.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getSellerOrder(orderId: string): Promise<OrderingOrderDetail> {
      return parseJsonResponse(
        await client.seller.orders[":id"].$get({
          param: { id: orderId },
          header: headers,
        }),
      );
    },
    async cancelSellerOrder(orderId: string) {
      return parseJsonResponse(
        await client.seller.orders[":id"].cancel.$post({
          param: { id: orderId },
          json: {},
          header: headers,
        }),
      );
    },
  };
}

export const orderingApi = createOrderingApiClient();
