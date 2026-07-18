import type { InventoryReservationReleasedPayload } from "@chase-sets/event-core/public-event-payloads";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { SupportRequestServices } from "../../api/runtime";

/**
 * Inventory owns the decision to displace a reservation. Support owns the
 * resulting seller-cannot-fulfill case and its deterministic cancel-order
 * resolution, which lets Ordering, Payments, and Notifications keep consuming
 * the same facts used by a seller-initiated cannot-fulfill case.
 */
export function buildInventoryCollisionSupportReactionHandlers(
  supportRequests: Pick<SupportRequestServices, "openAutomatedSellerCannotFulfillRequest">,
): ProjectorHandlerMap {
  return {
    "inventory.reservation.released": async (event) => {
      const data = event.data as InventoryReservationReleasedPayload;
      if (data.releaseReason !== "hold-collision") {
        return;
      }

      const context: EventStoreContext = {
        tenantId: event.tenantId,
        audit: event.audit,
        trace: event.trace,
      };
      await supportRequests.openAutomatedSellerCannotFulfillRequest(
        {
          orderId: data.orderId,
          sellerAccountId: data.sellerAccountId,
          reservationRequestId: data.reservationRequestId,
          holdId: data.holdId,
          releasedAt: data.releasedAt,
        },
        context,
      );
    },
  };
}
