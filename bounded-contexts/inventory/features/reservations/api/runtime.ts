import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import {
  decideInventoryReservation,
  evolveInventoryReservation,
  initialInventoryReservationState,
  type InventoryReservationCommand,
  type InventoryReservationEvent,
  type InventoryReservationState,
} from "../domain/domain";
import { buildInventoryReservationProjectionHandlers } from "../read-model/projection";
import { getInventoryReservation } from "../read-model/queries";

export type InventoryReservationServices = Readonly<{
  commandHandler: CommandHandler<InventoryReservationCommand, InventoryReservationState, InventoryReservationEvent>;
  getReservation: (reservationRequestId: string) => ReturnType<typeof getInventoryReservation>;
  getReservationState: (reservationRequestId: string) => Promise<InventoryReservationState>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInventoryReservationRuntime(deps: InventoryRuntimeDeps): InventoryReservationServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<InventoryReservationEvent>(),
    initialState: () => initialInventoryReservationState,
    evolve: evolveInventoryReservation,
    decide: decideInventoryReservation,
  });

  return {
    commandHandler,
    getReservation: (reservationRequestId) => getInventoryReservation(deps.db, reservationRequestId),
    getReservationState: async (reservationRequestId) => {
      const aggregate = await repository.load(`inventory.reservation-${reservationRequestId}`);
      return aggregate.state;
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inventory-reservation-projection",
        handlers: buildInventoryReservationProjectionHandlers(deps.db),
      }),
    ],
  };
}
