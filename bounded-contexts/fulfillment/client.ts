import { hc } from "hono/client";
import type { HonoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, type ListResponse } from "@chase-sets/http/responses";
import type { buildFulfillmentApi } from "./api";

export type {
  FulfillmentShipmentDetail,
  FulfillmentShipmentException,
  FulfillmentLabelAddressOverrideAudit,
  FulfillmentPackingSlip,
  FulfillmentPackingSlipBatch,
  FulfillmentPackingSlipFormat,
  FulfillmentShipmentLine,
  FulfillmentShipmentListItem,
} from "./features/shipments/api/contracts";

import type {
  FulfillmentShipmentDetail,
  FulfillmentShipmentListItem,
  FulfillmentPackingSlipBatch,
} from "./features/shipments/api/contracts";

type FulfillmentApiApp = ReturnType<typeof buildFulfillmentApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export class FulfillmentApiError extends Error {
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

export interface FulfillmentApiClientOptions {
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
    throw new FulfillmentApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

export function createFulfillmentApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: FulfillmentApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = hc<FulfillmentApiApp>(baseUrl, {
    fetch: configuredFetch,
  }) as unknown as HonoClientResource;
  const headers = resolveHeaders(initialHeaders);

  return {
    async listBuyerShipments(query = ""): Promise<ListResponse<FulfillmentShipmentListItem>> {
      return parseJsonResponse(
        await client.account.shipments.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getBuyerShipment(shipmentId: string): Promise<FulfillmentShipmentDetail> {
      return parseJsonResponse(
        await client.account.shipments[":id"].$get({
          param: { id: shipmentId },
          header: headers,
        }),
      );
    },
    async listSellerShipments(query = ""): Promise<ListResponse<FulfillmentShipmentListItem>> {
      return parseJsonResponse(
        await client.account.sales.shipments.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getSellerShipment(shipmentId: string): Promise<FulfillmentShipmentDetail> {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].$get({
          param: { id: shipmentId },
          header: headers,
        }),
      );
    },
    async listSellerPackingSlips(shipmentIds: readonly string[]): Promise<FulfillmentPackingSlipBatch> {
      return parseJsonResponse(
        await client.account.sales.shipments["packing-slips"].$get({
          query: { shipmentIds: shipmentIds.join(",") },
          header: headers,
        }),
      );
    },
    async packShipment(shipmentId: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].pack.$post({
          param: { id: shipmentId },
          json: body,
          header: headers,
        }),
      );
    },
    async startPackingShipment(shipmentId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].packing.start.$post({
          param: { id: shipmentId },
          json: {},
          header: headers,
        }),
      );
    },
    async updatePackingLine(shipmentId: string, lineId: string, confirmed: boolean) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].packing.lines[":lineId"].$post({
          param: { id: shipmentId, lineId },
          json: { confirmed },
          header: headers,
        }),
      );
    },
    async updatePackingLineQuantity(shipmentId: string, lineId: string, confirmedQuantity: number) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].packing.lines[":lineId"].$post({
          param: { id: shipmentId, lineId },
          json: { confirmedQuantity },
          header: headers,
        }),
      );
    },
    async attachLabel(shipmentId: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].label.$post({
          param: { id: shipmentId },
          json: body,
          header: headers,
        }),
      );
    },
    async purchaseUspsLabel(shipmentId: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].label.purchase.$post({
          param: { id: shipmentId },
          json: body,
          header: headers,
        }),
      );
    },
    async voidLabel(shipmentId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].label.void.$post({
          param: { id: shipmentId },
          json: {},
          header: headers,
        }),
      );
    },
    async dispatchShipment(shipmentId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].dispatch.$post({
          param: { id: shipmentId },
          json: {},
          header: headers,
        }),
      );
    },
    async deliverShipment(shipmentId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].deliver.$post({
          param: { id: shipmentId },
          json: {},
          header: headers,
        }),
      );
    },
    async returnShipment(shipmentId: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"]["return"].$post({
          param: { id: shipmentId },
          json: body,
          header: headers,
        }),
      );
    },
    async raiseShipmentException(shipmentId: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].exception.$post({
          param: { id: shipmentId },
          json: body,
          header: headers,
        }),
      );
    },
  };
}

export const fulfillmentApi = createFulfillmentApiClient();
