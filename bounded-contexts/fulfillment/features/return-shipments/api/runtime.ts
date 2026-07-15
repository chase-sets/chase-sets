import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
import {
  decideReturnShipment,
  evolveReturnShipment,
  initialReturnShipmentState,
  type ReturnShipmentCommand,
  type ReturnShipmentEvent,
  type ReturnShipmentState,
} from "../domain/domain";
import { createReturnFacilityDirectory, type ReturnFacilityDirectory } from "../domain/facility-directory";
import { buildFulfillmentReturnShipmentProjectionHandlers } from "../read-model/projection";
import {
  findReturnShipmentIdForRemedy,
  getCustomerReturnShipment,
  getOperatorReturnShipment,
  listCustomerReturnShipmentsForRemedy,
} from "../read-model/queries";
import { createReturnShipmentLabelPurchaseService, type ReturnShipmentLabelPurchaseService } from "./label-purchase";

export const FULFILLMENT_RETURN_SHIPMENT_PROJECTION = "fulfillment-return-shipment-projection";

/** The event-store stream that carries one reverse shipment's fact log. */
export function returnShipmentStreamId(returnShipmentId: string): string {
  return `fulfillment.return-shipment-${returnShipmentId}`;
}

type ReturnShipmentRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  postageLabelProvider?: PostageLabelProvider;
  facilityDirectory?: ReturnFacilityDirectory;
}>;

export type FulfillmentReturnShipmentServices = Readonly<{
  commandHandler: CommandHandler<ReturnShipmentCommand, ReturnShipmentState, ReturnShipmentEvent>;
  streamIdFor: (returnShipmentId: string) => string;
  labelPurchase: ReturnShipmentLabelPurchaseService;
  getCustomerReturnShipment: (returnShipmentId: string) => ReturnType<typeof getCustomerReturnShipment>;
  listCustomerReturnShipmentsForRemedy: (remedyId: string) => ReturnType<typeof listCustomerReturnShipmentsForRemedy>;
  getOperatorReturnShipment: (returnShipmentId: string) => ReturnType<typeof getOperatorReturnShipment>;
  findReturnShipmentIdForRemedy: (remedyId: string) => ReturnType<typeof findReturnShipmentIdForRemedy>;
  projectors: readonly ProjectionHandlerSet[];
}>;

/**
 * A postage provider that is never configured. Slices that do not wire a real
 * provider still compose the label-purchase service, but any purchase/void attempt
 * fails loudly rather than silently succeeding.
 */
function createUnconfiguredReturnPostageLabelProvider(): PostageLabelProvider {
  const fail = async (): Promise<never> => {
    throw new Error("No postage label provider is configured for return-shipment label purchase.");
  };
  return {
    providerName: "unconfigured",
    providerMode: "test",
    purchaseUspsLabel: fail,
    voidLabel: fail,
  };
}

/**
 * Composition root for the ReturnShipment slice. Provides the aggregate command
 * handler, the return-label purchase/void workflow, the read-model query surface,
 * and the projection handler set that the fulfillment module registers. Carrier
 * webhook ingestion and refund release remain out of scope here; sibling slices
 * build on this foundation.
 */
export function createFulfillmentReturnShipmentRuntime(
  deps: ReturnShipmentRuntimeDeps,
): FulfillmentReturnShipmentServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ReturnShipmentEvent>(),
    initialState: () => initialReturnShipmentState,
    evolve: evolveReturnShipment,
    decide: decideReturnShipment,
  });

  const labelPurchase = createReturnShipmentLabelPurchaseService({
    eventStore: deps.eventStore,
    db: deps.db,
    postageLabelProvider: deps.postageLabelProvider ?? createUnconfiguredReturnPostageLabelProvider(),
    facilityDirectory: deps.facilityDirectory ?? createReturnFacilityDirectory([]),
  });

  return {
    commandHandler,
    streamIdFor: returnShipmentStreamId,
    labelPurchase,
    getCustomerReturnShipment: (returnShipmentId) => getCustomerReturnShipment(deps.db, returnShipmentId),
    listCustomerReturnShipmentsForRemedy: (remedyId) => listCustomerReturnShipmentsForRemedy(deps.db, remedyId),
    getOperatorReturnShipment: (returnShipmentId) => getOperatorReturnShipment(deps.db, returnShipmentId),
    findReturnShipmentIdForRemedy: (remedyId) => findReturnShipmentIdForRemedy(deps.db, remedyId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: FULFILLMENT_RETURN_SHIPMENT_PROJECTION,
        handlers: buildFulfillmentReturnShipmentProjectionHandlers(deps.db),
      }),
    ],
  };
}
