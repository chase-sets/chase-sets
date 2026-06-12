import type { ShipmentId } from "@chase-sets/primitives/typed-ids";

export const fulfillmentReservedSeedIds = {
  shipments: {
    demoCharizardShipment: "shp_seed_demo_charizard" as ShipmentId,
    awaitingLabel: "shp_seed_awaiting_label" as ShipmentId,
    labelAttached: "shp_seed_label_attached" as ShipmentId,
    dispatchedShipment: "shp_seed_dispatched" as ShipmentId,
    exceptionShipment: "shp_seed_exception" as ShipmentId,
    returnedShipment: "shp_seed_returned" as ShipmentId,
    reviewEligibleDelivered: "shp_seed_review_eligible" as ShipmentId,
  },
} as const;
