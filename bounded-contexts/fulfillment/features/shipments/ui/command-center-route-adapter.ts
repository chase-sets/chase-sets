// Slice-local route adapter for the fulfillment command center. Keeps the marketplace
// route module composition-only: it owns the loader view assembly and the single
// shipment-action dispatch so the route never imports domain / read-model internals
// directly. The web command center and the MCP seller tools both reach the shipment
// state machine through the same `executeShipmentAction` module wrapped here.

import type { createFulfillmentRequestApiClient } from "../../../support/request-support/api-client";
import type { PostageLabelStatus, ShipmentStatus } from "../domain/common";
import {
  assertShipmentActionAllowed,
  executeShipmentAction,
  type ShipmentActionLegalityInput,
  type ShipmentActionName,
  type ShipmentLifecycleDispatcher,
} from "../domain/shipment-action";

export {
  buildFulfillmentCommandCenter,
  type FulfillmentCommandCenter,
  type FulfillmentCommandCenterShipmentInput,
} from "../read-model/command-center";
export type { ShipmentActionName } from "../domain/shipment-action";

type FulfillmentRequestApi = ReturnType<typeof createFulfillmentRequestApiClient>;

export type ShipmentCommandCenterActionOutcome = Readonly<{ ok: true } | { ok: false; error: string }>;

function currentStateFrom(formData: FormData): ShipmentActionLegalityInput {
  return {
    status: String(formData.get("status") ?? "") as ShipmentStatus,
    labelStatus: (String(formData.get("labelStatus") ?? "") || null) as PostageLabelStatus | null,
  };
}

function shipmentResult(response: unknown, shipmentId: string) {
  return { shipmentId, version: Number((response as { version?: number }).version ?? 0) };
}

// Dispatches one named shipment action for the web command center. Label purchase/void
// keep their dedicated postage path; every action is gated by the module's legality
// check first, so an illegal transition is rejected here rather than in the UI.
export async function runShipmentCommandCenterAction(
  api: FulfillmentRequestApi,
  action: ShipmentActionName,
  formData: FormData,
): Promise<ShipmentCommandCenterActionOutcome> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const current = currentStateFrom(formData);

  try {
    if (action === "buy-label" || action === "void-label") {
      assertShipmentActionAllowed(action, current);
      if (action === "buy-label") {
        await api.purchaseUspsLabel(shipmentId, { serviceLevel: "USPS_GROUND_ADVANTAGE" });
      } else {
        await api.voidLabel(shipmentId);
      }
      return { ok: true };
    }

    const dispatcher: ShipmentLifecycleDispatcher = {
      startPacking: async () => shipmentResult(await api.startPackingShipment(shipmentId), shipmentId),
      completePacking: async () => shipmentResult(await api.packShipment(shipmentId, { packageCount: 1 }), shipmentId),
      dispatch: async () => shipmentResult(await api.dispatchShipment(shipmentId), shipmentId),
      recordDelivery: async () => shipmentResult(await api.deliverShipment(shipmentId), shipmentId),
      returnShipment: async () =>
        shipmentResult(
          await api.returnShipment(shipmentId, { reason: String(formData.get("reason") ?? "") || null }),
          shipmentId,
        ),
      raiseException: async () =>
        shipmentResult(
          await api.raiseShipmentException(shipmentId, {
            exceptionType: String(formData.get("exceptionType") ?? "") || "other",
            notes: String(formData.get("notes") ?? "") || null,
          }),
          shipmentId,
        ),
    };

    await executeShipmentAction(dispatcher, { action, current });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Shipment action failed." };
  }
}
