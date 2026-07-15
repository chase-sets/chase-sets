import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import {
  decideRecoveredItem,
  evolveRecoveredItem,
  initialRecoveredItemState,
  type RecoveredItemCommand,
  type RecoveredItemEvent,
  type RecoveredItemState,
} from "../domain/recovered-item";
import { buildInventoryRecoveredItemProjectionHandlers } from "../read-model/projection";
import { getRecoveredItem, getRecoveredItemMetrics, listRecoveredItems } from "../read-model/queries";

export type FacilityIntakeRecoveredItemInput = Readonly<{
  returnShipmentId: string;
  remedyId: string;
  facilityId: string;
  stationId: string;
  custodyIdentifier: string;
  evidenceReferences: readonly string[];
  intakeDisposition: "completed" | "quarantine" | "manual-review";
  hasDiscrepancy: boolean;
  observedItemReference: string | null;
  policyVersion: string;
  receivedAt: string;
}>;

export type RecoveredItemServices = Readonly<{
  commandHandler: CommandHandler<RecoveredItemCommand, RecoveredItemState, RecoveredItemEvent>;
  createFromFacilityIntake: (
    input: FacilityIntakeRecoveredItemInput,
    context: EventStoreContext,
  ) => Promise<{ recoveredItemId: string; version: number }>;
  execute: (
    recoveredItemId: string,
    command: Exclude<RecoveredItemCommand, { type: "CreateRecoveredItem" }>,
    context: EventStoreContext,
  ) => Promise<{ recoveredItemId: string; version: number; state: RecoveredItemState }>;
  list: (params?: Parameters<typeof listRecoveredItems>[1]) => ReturnType<typeof listRecoveredItems>;
  get: (recoveredItemId: string) => ReturnType<typeof getRecoveredItem>;
  metrics: () => ReturnType<typeof getRecoveredItemMetrics>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function recoveredItemIdForReturnShipment(returnShipmentId: string): string {
  const hash = createHash("sha256").update(returnShipmentId).digest("hex").slice(0, 24);
  return `rcv_${hash}`;
}

export function createRecoveredItemRuntime(deps: InventoryRuntimeDeps): RecoveredItemServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<RecoveredItemEvent>(),
    initialState: () => initialRecoveredItemState,
    evolve: evolveRecoveredItem,
    decide: decideRecoveredItem,
  });

  return {
    commandHandler,
    createFromFacilityIntake: async (input, context) => {
      const recoveredItemId = recoveredItemIdForReturnShipment(input.returnShipmentId);
      const result = await commandHandler({
        streamId: `inventory.recovered-item-${recoveredItemId}`,
        command: {
          type: "CreateRecoveredItem",
          recoveredItemId,
          returnShipmentId: input.returnShipmentId,
          remedyId: input.remedyId,
          custodyLocationId: `${input.facilityId}:${input.stationId}`,
          custodyIdentifier: input.custodyIdentifier,
          evidenceReferences: input.evidenceReferences,
          intakeDisposition: input.intakeDisposition,
          hasDiscrepancy: input.hasDiscrepancy,
          observedItemReference: input.observedItemReference,
          policyVersion: input.policyVersion,
          receivedAt: input.receivedAt,
        },
        context,
      });
      return { recoveredItemId, version: result.version };
    },
    execute: async (recoveredItemId, command, context) => {
      const result = await commandHandler({
        streamId: `inventory.recovered-item-${recoveredItemId}`,
        command,
        context,
      });
      return { recoveredItemId, version: result.version, state: result.state };
    },
    list: (params) => listRecoveredItems(deps.db, params),
    get: (recoveredItemId) => getRecoveredItem(deps.db, recoveredItemId),
    metrics: () => getRecoveredItemMetrics(deps.db),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inventory-recovered-item-projection",
        handlers: buildInventoryRecoveredItemProjectionHandlers(deps.db),
      }),
    ],
  };
}
