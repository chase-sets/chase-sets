import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
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

export type InventoryReservationConfirmationParams = Readonly<{
  reservationRequestId: string;
  orderId: string;
  sellerAccountId: string;
  inventoryItemId: string;
  quantity: number;
  holdId: string;
}>;

export type InventoryReservationConfirmationPlan =
  | Readonly<{
      kind: "already-resolved";
      state: InventoryReservationState;
      version: number;
    }>
  | Readonly<{
      kind: "append";
      append: AppendToStreamInput;
    }>;

export type InventoryReservationServices = Readonly<{
  commandHandler: CommandHandler<InventoryReservationCommand, InventoryReservationState, InventoryReservationEvent>;
  planConfirmation: (
    params: InventoryReservationConfirmationParams,
    context: EventStoreContext,
  ) => Promise<InventoryReservationConfirmationPlan>;
  getReservation: (reservationRequestId: string) => ReturnType<typeof getInventoryReservation>;
  getReservationState: (reservationRequestId: string) => Promise<InventoryReservationState>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInventoryReservationRuntime(deps: InventoryRuntimeDeps): InventoryReservationServices {
  const codec = createPassthroughDomainEventCodec<InventoryReservationEvent>();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec,
    initialState: () => initialInventoryReservationState,
    evolve: evolveInventoryReservation,
    decide: decideInventoryReservation,
  });

  return {
    commandHandler,
    planConfirmation: async (params, context) => {
      const streamId = `inventory.reservation-${params.reservationRequestId}`;
      const aggregate = await repository.load(streamId);
      const events = decideInventoryReservation(aggregate.state, {
        type: "ConfirmInventoryReservation",
        ...params,
      });

      if (events.length === 0) {
        return {
          kind: "already-resolved",
          state: aggregate.state,
          version: aggregate.version,
        };
      }

      return {
        kind: "append",
        append: {
          streamId,
          expectedVersion: aggregate.version,
          events: events.map((event) => codec.encode(event)),
          context,
        },
      };
    },
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
