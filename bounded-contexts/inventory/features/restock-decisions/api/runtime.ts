import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import type { InventoryItemServices } from "../../inventory-items/api/runtime";
import type { InventoryReservationServices } from "../../reservations/api/runtime";
import {
  decideRestockDecision,
  evolveRestockDecision,
  initialRestockDecisionState,
  type RestockDecisionCommand,
  type RestockDecisionEvent,
  type RestockDecisionSource,
  type RestockDecisionState,
} from "../domain/domain";
import {
  buildInventoryFulfillmentSourceProjectionHandlers,
  buildInventoryRestockDecisionProjectionHandlers,
} from "../read-model/projection";
import { getFulfillmentShipmentSource, getRestockDecision, listPendingRestockDecisions } from "../read-model/queries";

export type RestockDecisionServices = Readonly<{
  commandHandler: CommandHandler<RestockDecisionCommand, RestockDecisionState, RestockDecisionEvent>;
  markPending: (
    params: Readonly<{
      accountId: string;
      orderId: string;
      itemId: string;
      quantity: number;
      reservationRequestId: string;
      source: RestockDecisionSource;
      shipmentId?: string | null;
      returnReason?: string | null;
      pendingAt: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ decisionId: string; version: number }>;
  markShipmentReturned: (
    params: Readonly<{
      shipmentId: string;
      returnReason: string | null;
      returnedAt: string;
    }>,
    context: EventStoreContext,
  ) => Promise<readonly { decisionId: string; version: number }[]>;
  recordDecision: (
    params: Readonly<{
      accountId: string;
      decisionId: string;
      outcome: "restocked" | "written-off";
      damageNote?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ decisionId: string; version: number }>;
  listPending: (
    params: Parameters<typeof listPendingRestockDecisions>[1],
  ) => ReturnType<typeof listPendingRestockDecisions>;
  getDecision: (decisionId: string, accountId: string) => ReturnType<typeof getRestockDecision>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function restockDecisionId(input: Readonly<{ orderId: string; itemId: string }>) {
  const hash = createHash("sha256").update(`${input.orderId}:${input.itemId}`).digest("hex").slice(0, 24);
  return `rstk_${hash}`;
}

export function createRestockDecisionRuntime(
  deps: InventoryRuntimeDeps,
  inventoryItems: InventoryItemServices,
  reservations: InventoryReservationServices,
): RestockDecisionServices {
  const codec = createPassthroughDomainEventCodec<RestockDecisionEvent>();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec,
    initialState: () => initialRestockDecisionState,
    evolve: evolveRestockDecision,
    decide: decideRestockDecision,
  });

  async function markPending(
    params: Parameters<RestockDecisionServices["markPending"]>[0],
    context: EventStoreContext,
  ) {
    const decisionId = restockDecisionId({
      orderId: params.orderId,
      itemId: params.itemId,
    });
    const result = await commandHandler({
      streamId: `inventory.restock-decision-${decisionId}`,
      command: {
        type: "MarkRestockDecisionPending",
        decisionId,
        accountId: params.accountId as AccountId,
        orderId: params.orderId,
        itemId: params.itemId,
        quantity: params.quantity,
        source: params.source,
        sourceRef: {
          orderId: params.orderId,
          reservationRequestId: params.reservationRequestId,
        },
        shipmentId: params.shipmentId ?? null,
        returnReason: params.returnReason ?? null,
        pendingAt: params.pendingAt,
      },
      context,
    });

    return {
      decisionId,
      version: result.version,
    };
  }

  return {
    commandHandler,
    markPending,
    markShipmentReturned: async (params, context) => {
      const shipment = await getFulfillmentShipmentSource(deps.db, params.shipmentId);
      if (!shipment) {
        throw new InventoryDomainError("Shipment source not found for restock decision.");
      }

      const result = await deps.db.query<{
        reservation_request_id: string;
        order_id: string;
        seller_account_id: string;
        inventory_item_id: string;
        quantity: number;
      }>(
        `SELECT reservation_request_id, order_id, seller_account_id, inventory_item_id, quantity
         FROM inventory_reservation_pages
         WHERE order_id = $1
           AND seller_account_id = $2
           AND status = 'confirmed'
         ORDER BY reservation_request_id ASC`,
        [shipment.order_id, shipment.seller_account_id],
      );

      const decisions: { decisionId: string; version: number }[] = [];
      for (const row of result.rows) {
        decisions.push(
          await markPending(
            {
              accountId: row.seller_account_id,
              orderId: row.order_id,
              itemId: row.inventory_item_id,
              quantity: row.quantity,
              reservationRequestId: row.reservation_request_id,
              source: "shipment-returned",
              shipmentId: params.shipmentId,
              returnReason: params.returnReason,
              pendingAt: params.returnedAt,
            },
            context,
          ),
        );
      }

      return decisions;
    },
    recordDecision: async (params, context) => {
      const streamId = `inventory.restock-decision-${params.decisionId}`;
      const aggregate = await repository.load(streamId);
      if (aggregate.state.status === "recorded") {
        return {
          decisionId: params.decisionId,
          version: aggregate.version,
        };
      }
      if (aggregate.state.status !== "pending" || aggregate.state.accountId !== params.accountId) {
        throw new InventoryDomainError("Restock decision not found.");
      }

      if (params.outcome === "restocked") {
        await inventoryItems.adjustItem(
          {
            accountId: aggregate.state.accountId,
            itemId: aggregate.state.itemId!,
            quantityDelta: aggregate.state.quantity,
            reason: "return-restocked",
            reasonCode: "return-restocked",
            sourceRef: aggregate.state.sourceRef,
            idempotencyKey: `restock-decision:${params.decisionId}:restocked`,
          },
          context,
        );
      }

      const events = decideRestockDecision(aggregate.state, {
        type: "RecordRestockDecision",
        outcome: params.outcome,
        damageNote: params.damageNote ?? null,
        decidedAt: new Date().toISOString(),
      });
      const storedEvents = await deps.eventStore.appendToStream({
        streamId,
        expectedVersion: aggregate.version,
        events: events.map((event) => codec.encode(event)),
        context,
      });
      recordCommittedEvents(storedEvents);

      return {
        decisionId: params.decisionId,
        version: storedEvents.length === 0 ? aggregate.version : storedEvents[storedEvents.length - 1].streamVersion,
      };
    },
    listPending: (params) => listPendingRestockDecisions(deps.db, params),
    getDecision: (decisionId, accountId) => getRestockDecision(deps.db, decisionId, accountId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inventory-restock-decision-projection",
        handlers: buildInventoryRestockDecisionProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: "inventory-fulfillment-source-projection",
        handlers: buildInventoryFulfillmentSourceProjectionHandlers(deps.db),
      }),
    ],
  };
}
