// Slice-local route adapter for the fulfillment command center. Keeps the marketplace
// route module composition-only: it names the command center the Fulfillment API returns and
// sends each shipment action to the API, which decides its legality against the shipment's
// stored state. The page posts only the shipment and the action, so no state the page was
// drawn with can admit or refuse an action.

import type { createFulfillmentRequestApiClient } from "../../../support/request-support/api-client";
import type { ShipmentActionName } from "../domain/shipment-action";

export type { FulfillmentCommandCenter } from "../read-model/command-center";
export type { ShipmentActionName } from "../domain/shipment-action";

type FulfillmentRequestApi = ReturnType<typeof createFulfillmentRequestApiClient>;

export type ShipmentCommandCenterActionOutcome = Readonly<{ ok: true } | { ok: false; error: string }>;

async function sendShipmentAction(
  api: FulfillmentRequestApi,
  action: ShipmentActionName,
  shipmentId: string,
  mutationAttemptId: string,
  formData: FormData,
): Promise<unknown> {
  switch (action) {
    case "start-packing":
      return api.startPackingShipment(shipmentId, mutationAttemptId);
    case "complete-packing":
      return api.packShipment(shipmentId, { packageCount: 1 }, mutationAttemptId);
    case "buy-label":
      return api.purchaseUspsLabel(shipmentId, { serviceLevel: "USPS_GROUND_ADVANTAGE" }, mutationAttemptId);
    case "void-label":
      return api.voidLabel(shipmentId, mutationAttemptId);
    case "cancel-shipment":
      return api.cancelShipment(shipmentId, mutationAttemptId);
    case "dispatch":
      return api.dispatchShipment(shipmentId, mutationAttemptId);
    case "record-delivery":
      return api.deliverShipment(shipmentId, mutationAttemptId);
    case "return":
      return api.returnShipment(
        shipmentId,
        { reason: String(formData.get("reason") ?? "") || null },
        mutationAttemptId,
      );
    case "raise-exception":
      return api.raiseShipmentException(
        shipmentId,
        {
          exceptionType: String(formData.get("exceptionType") ?? "") || "other",
          notes: String(formData.get("notes") ?? "") || null,
        },
        mutationAttemptId,
      );
  }
}

// Sends one named shipment action for the web command center. The Fulfillment API refuses an
// action the shipment's stored state does not allow; that refusal is the outcome's error.
export async function runShipmentCommandCenterAction(
  api: FulfillmentRequestApi,
  action: ShipmentActionName,
  formData: FormData,
): Promise<ShipmentCommandCenterActionOutcome> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const mutationAttemptId = String(formData.get("mutationAttemptId") ?? "");
  formData.delete("mutationAttemptId");

  try {
    await sendShipmentAction(api, action, shipmentId, mutationAttemptId, formData);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Shipment action failed." };
  }
}
