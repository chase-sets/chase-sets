import { parseJsonResponse, type FulfillmentClientTransport } from "../../../support/request-support/client";
import type { ListResponse } from "@chase-sets/http/responses";
import type { FulfillmentShipmentDetail, FulfillmentShipmentListItem, FulfillmentPackingSlipBatch } from "./contracts";
import type { FulfillmentCommandCenter } from "../read-model/command-center";

export function createShipmentClient({ client, headers }: FulfillmentClientTransport) {
  const mutationHeaders = (mutationAttemptId: string) => {
    const next = new Headers(headers);
    next.set("Idempotency-Key", mutationAttemptId);
    return Object.fromEntries(next.entries());
  };
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
    async getSellerCommandCenter(): Promise<FulfillmentCommandCenter> {
      return parseJsonResponse(
        await client.account.sales.shipments["command-center"].$get({
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
    async packShipment(shipmentId: string, body: Record<string, unknown>, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].pack.$post({
          param: { id: shipmentId },
          json: body,
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async startPackingShipment(shipmentId: string, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].packing.start.$post({
          param: { id: shipmentId },
          json: {},
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async updatePackingLine(shipmentId: string, lineId: string, confirmed: boolean, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].packing.lines[":lineId"].$post({
          param: { id: shipmentId, lineId },
          json: { confirmed },
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async updatePackingLineQuantity(
      shipmentId: string,
      lineId: string,
      confirmedQuantity: number,
      mutationAttemptId: string,
    ) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].packing.lines[":lineId"].$post({
          param: { id: shipmentId, lineId },
          json: { confirmedQuantity },
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async attachLabel(shipmentId: string, body: Record<string, unknown>, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].label.$post({
          param: { id: shipmentId },
          json: body,
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async purchaseUspsLabel(shipmentId: string, body: Record<string, unknown>, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].label.purchase.$post({
          param: { id: shipmentId },
          json: body,
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async voidLabel(shipmentId: string, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].label.void.$post({
          param: { id: shipmentId },
          json: {},
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async cancelShipment(shipmentId: string, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].cancel.$post({
          param: { id: shipmentId },
          json: {},
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async dispatchShipment(shipmentId: string, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].dispatch.$post({
          param: { id: shipmentId },
          json: {},
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async deliverShipment(shipmentId: string, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].deliver.$post({
          param: { id: shipmentId },
          json: {},
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async returnShipment(shipmentId: string, body: Record<string, unknown>, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"]["return"].$post({
          param: { id: shipmentId },
          json: body,
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async raiseShipmentException(shipmentId: string, body: Record<string, unknown>, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"].exception.$post({
          param: { id: shipmentId },
          json: body,
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
    async recoverShipmentMutation(shipmentId: string, mutationAttemptId: string) {
      return parseJsonResponse(
        await client.account.sales.shipments[":id"]["mutation-recovery"].$get({
          param: { id: shipmentId },
          header: mutationHeaders(mutationAttemptId),
        }),
      );
    },
  };
}
