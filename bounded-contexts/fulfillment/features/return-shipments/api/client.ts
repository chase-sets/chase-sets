import { parseJsonResponse, type FulfillmentClientTransport } from "../../../support/request-support/client";
import type {
  OperatorReturnShipmentView,
  ReturnIntakeMetrics,
  UnidentifiedReturnPackageView,
} from "../read-model/queries";
import type { ReturnIntakeEvidenceAttachment } from "../domain/facility-intake";

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

export function createReturnIntakeClient({ client, configuredFetch, directUrl, headers }: FulfillmentClientTransport) {
  return {
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
