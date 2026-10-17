import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { projectInventoryAcquisitionLot } from "./acquisition-projection";

/**
 * Extends the one canonical Inventory subscription without moving its existing
 * recommendation inputs into Economics. The input projection runs first so a
 * positive adjustment can resolve the item-to-account binding in the same
 * transaction before its acquisition lot is persisted.
 */
export function composePricingInventoryEconomicsProjectionHandlers(
  db: PgQueryable,
  baseHandlers: ProjectorHandlerMap,
): ProjectorHandlerMap {
  const compose = (eventType: "inventory.item.created" | "inventory.item.adjusted") => {
    const base = baseHandlers[eventType];
    if (!base) throw new Error(`Pricing Inventory projection is missing ${eventType}.`);
    return async (event: Parameters<typeof base>[0]) => {
      await base(event);
      await projectInventoryAcquisitionLot(db, event, eventType);
    };
  };
  return {
    ...baseHandlers,
    "inventory.item.created": compose("inventory.item.created"),
    "inventory.item.adjusted": compose("inventory.item.adjusted"),
  };
}
