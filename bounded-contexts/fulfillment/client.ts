import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, readApiErrorMessage, type ListResponse } from "@chase-sets/http/responses";
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
import type {
  OperatorReturnShipmentView,
  ReturnIntakeMetrics,
  UnidentifiedReturnPackageView,
} from "./features/return-shipments/read-model/queries";
import type { ReturnIntakeEvidenceAttachment } from "./features/return-shipments/domain/facility-intake";

export type FulfillmentReturnIntakeQueue = Readonly<{
  items: readonly OperatorReturnShipmentView[];
  unidentified: readonly UnidentifiedReturnPackageView[];
  metrics: ReturnIntakeMetrics;
}>;

export type FulfillmentReturnIntakeResolution = Readonly<{
  outcome: "resolved";
  shipment: OperatorReturnShipmentView;
  version: number;
}>;

type FulfillmentApiApp = ReturnType<typeof buildFulfillmentApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export class FulfillmentApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body !== null
        ? readApiErrorMessage(body, `API error ${status}`)
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
  const client = honoClientResource(
    hc<FulfillmentApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);
  const directUrl = (path: string) => `${baseUrl.replace(/\/$/, "")}${path}`;

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
    async getReturnIntakeQueue(facilityId: string): Promise<FulfillmentReturnIntakeQueue> {
      return parseJsonResponse(
        await client.operations["return-intake"].$get({ query: { facilityId }, header: headers }),
      );
    },
    async resolveReturnIntake(identifier: string, facilityId: string): Promise<FulfillmentReturnIntakeResolution> {
      return parseJsonResponse(
        await client.operations["return-intake"].resolve.$get({ query: { identifier, facilityId }, header: headers }),
      );
    },
    async uploadReturnIntakeEvidence(
      facilityId: string,
      file: File,
    ): Promise<{ attachment: ReturnIntakeEvidenceAttachment }> {
      const formData = new FormData();
      formData.set("facilityId", facilityId);
      formData.set("evidence", file);
      return parseJsonResponse(
        await configuredFetch(directUrl("/operations/return-intake/evidence"), {
          method: "POST",
          headers,
          body: formData,
        }),
      );
    },
    async completeReturnIntake(returnShipmentId: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.operations["return-intake"][":returnShipmentId"].complete.$post({
          param: { returnShipmentId },
          json: body,
          header: headers,
        }),
      );
    },
    async correctReturnIntake(returnShipmentId: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.operations["return-intake"][":returnShipmentId"].corrections.$post({
          param: { returnShipmentId },
          json: body,
          header: headers,
        }),
      );
    },
    async recordUnidentifiedReturnPackage(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.operations["return-intake"].unidentified.$post({ json: body, header: headers }),
      );
    },
    async reconcileUnidentifiedReturnPackage(unidentifiedPackageId: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.operations["return-intake"].unidentified[":unidentifiedPackageId"].reconcile.$post({
          param: { unidentifiedPackageId },
          json: body,
          header: headers,
        }),
      );
    },
  };
}

export const fulfillmentApi = createFulfillmentApiClient();
