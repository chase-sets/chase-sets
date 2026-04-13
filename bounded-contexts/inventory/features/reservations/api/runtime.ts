import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
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
  commandHandler: CommandHandler<
    InventoryReservationCommand,
    InventoryReservationState,
    InventoryReservationEvent
  >;
  getReservation: (
    reservationRequestId: string,
  ) => ReturnType<typeof getInventoryReservation>;
  getReservationState: (
    reservationRequestId: string,
  ) => Promise<InventoryReservationState>;
  projectors: readonly Projector[];
}>;

export function createInventoryReservationRuntime(
  deps: InventoryRuntimeDeps,
): InventoryReservationServices {
  const repository = createAggregateRepository({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<InventoryReservationEvent>(),
    initialState: () => initialInventoryReservationState,
    evolve: evolveInventoryReservation,
  });

  const commandHandler = createCommandHandler({
    repository,
    evolve: evolveInventoryReservation,
    decide: decideInventoryReservation,
  });

  return {
    commandHandler,
    getReservation: (reservationRequestId) =>
      getInventoryReservation(deps.db, reservationRequestId),
    getReservationState: async (reservationRequestId) => {
      const aggregate = await repository.load(
        `inventory.reservation-${reservationRequestId}`,
      );
      return aggregate.state;
    },
    projectors: [
      createProjector({
        projectorName: "inventory-reservation-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildInventoryReservationProjectionHandlers(deps.db),
      }),
    ],
  };
}
