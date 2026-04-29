export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { InventoryServices } from "./support/runtime-support/services";
import { buildInventoryApi } from "./api";
import { buildInventoryCatalogItemProjectionHandlers } from "./features/inventory-items/integrations/catalog/projection";
import { InventoryDomainError } from "./support/runtime-support/common";
import { createInventoryServices } from "./support/runtime-support/services";
import { inventorySchemaSql } from "./support/runtime-support/schema";
import { seedInventoryDatabase } from "./support/runtime-support/seed";

const eventSubscriptions =
  (contextManifest.eventSubscriptions ?? []) as readonly BcEventSubscriptionDeclaration[];
const projectionGroups =
  (contextManifest.projectionGroups ?? []) as readonly BcProjectionGroupDeclaration[];

function getEventSubscription(
  sourceContextName: string,
  projectionName: string,
): BcEventSubscriptionDeclaration {
  const declaration = eventSubscriptions.find(
    (entry) =>
      entry.sourceContextName === sourceContextName &&
      entry.projectionName === projectionName,
  );

  if (!declaration) {
    throw new Error(
      `Inventory is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<InventoryServices, PgTransactionalPool, void> = {
  contextName: "inventory",
  routePrefix: "/api/inventory",
  streamPrefix: "inventory.",
  schemaSql: inventorySchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<InventoryServices, PgTransactionalPool, void>["apiMounts"],
  projectionGroups,
  createServices: (pool) => createInventoryServices(pool),
  buildApis: (services) => [buildInventoryApi(services)],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const catalogSubscription = getEventSubscription(
      "catalog",
      "inventory-catalog-item-projection",
    );
    const orderingReservationWorkflowSubscription = getEventSubscription(
      "ordering",
      "inventory-order-reservation-workflow",
    );

    return [
      {
        subscriptionName: "inventory.catalog-item-projection",
        sourceContextName: "catalog",
        projectionName: catalogSubscription.projectionName,
        subscriptionVersion: catalogSubscription.subscriptionVersion,
        handlers: buildInventoryCatalogItemProjectionHandlers(services.db),
        eventTypes: catalogSubscription.eventTypes,
        streamPrefixes: catalogSubscription.streamPrefixes,
        order: catalogSubscription.order,
      },
      {
        subscriptionName: "inventory.order-reservation-workflow",
        sourceContextName: "ordering",
        projectionName: orderingReservationWorkflowSubscription.projectionName,
        subscriptionVersion: orderingReservationWorkflowSubscription.subscriptionVersion,
        handlers: {
          "ordering.order.created": async (event) => {
            const data = event.data as {
              orderId: string;
              reservationRequests: Array<{
                reservationRequestId: string;
                inventoryItemId: string;
                sellerAccountId: string;
                quantity: number;
              }>;
            };

            for (const request of data.reservationRequests ?? []) {
              const existingState = await services.reservations.getReservationState(
                request.reservationRequestId,
              );
              if (existingState.status !== null) {
                continue;
              }

              const context = {
                tenantId: event.tenantId,
                audit: event.audit,
                trace: event.trace,
              } as const;

              try {
                const hold = await services.holds.createHold(
                  {
                    accountId: request.sellerAccountId as never,
                    itemId: request.inventoryItemId,
                    quantity: request.quantity,
                    reason: "Ordering commitment",
                    notes: null,
                  },
                  context,
                );

                await services.reservations.commandHandler({
                  streamId: `inventory.reservation-${request.reservationRequestId}`,
                  command: {
                    type: "ConfirmInventoryReservation",
                    reservationRequestId: request.reservationRequestId,
                    orderId: data.orderId,
                    sellerAccountId: request.sellerAccountId,
                    inventoryItemId: request.inventoryItemId,
                    quantity: request.quantity,
                    holdId: hold.holdId,
                  },
                  context,
                });
              } catch (error) {
                await services.reservations.commandHandler({
                  streamId: `inventory.reservation-${request.reservationRequestId}`,
                  command: {
                    type: "RejectInventoryReservation",
                    reservationRequestId: request.reservationRequestId,
                    orderId: data.orderId,
                    sellerAccountId: request.sellerAccountId,
                    inventoryItemId: request.inventoryItemId,
                    quantity: request.quantity,
                    reason:
                      error instanceof InventoryDomainError || error instanceof Error
                        ? error.message
                        : "Inventory reservation failed.",
                  },
                  context,
                });
              }
            }
          },
          "ordering.order.cancelled": async (event) => {
            const data = event.data as {
              reservationRequests: Array<{
                reservationRequestId: string;
                sellerAccountId: string;
                holdId: string | null;
                status: string;
              }>;
              cancelledAt: string;
            };
            const context = {
              tenantId: event.tenantId,
              audit: event.audit,
              trace: event.trace,
            } as const;

            for (const request of data.reservationRequests ?? []) {
              if (request.status !== "confirmed" || !request.holdId) {
                continue;
              }

              const reservationState = await services.reservations.getReservationState(
                request.reservationRequestId,
              );
              if (reservationState.status !== "confirmed") {
                continue;
              }

              try {
                await services.holds.releaseHold(
                  {
                    accountId: request.sellerAccountId,
                    holdId: request.holdId,
                  },
                  context,
                );
              } catch (error) {
                if (
                  !(error instanceof InventoryDomainError) ||
                  error.message !== "Inventory hold not found."
                ) {
                  throw error;
                }
              }
              await services.reservations.commandHandler({
                streamId: `inventory.reservation-${request.reservationRequestId}`,
                command: {
                  type: "ReleaseInventoryReservation",
                  releasedAt: data.cancelledAt,
                },
                context,
              });
            }
          },
        },
        eventTypes: orderingReservationWorkflowSubscription.eventTypes,
        streamPrefixes: orderingReservationWorkflowSubscription.streamPrefixes,
        order: orderingReservationWorkflowSubscription.order,
      },
    ];
  },
  seed: seedInventoryDatabase,
};
