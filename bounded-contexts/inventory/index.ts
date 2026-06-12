export { default as contextManifest } from "./context.json";

import {
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcEventSubscriptionHandler,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { InventoryHostPorts, InventoryServices } from "./support/runtime-support/services";
import { buildInventoryApi } from "./api";
import { buildInventoryCatalogItemProjectionHandlers } from "./features/inventory-items/integrations/catalog/projection";
import { InventoryDomainError } from "./support/runtime-support/common";
import { createInventoryServices } from "./support/runtime-support/services";
import { inventorySchemaSql } from "./support/runtime-support/schema";
import { seedInventoryDatabase } from "./support/runtime-support/seed";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export const module = defineBoundedContextModule<InventoryServices, PgTransactionalPool, InventoryHostPorts>({
  manifest: contextManifest,
  schemaSql: inventorySchemaSql,
  createServices: (pool, ports) => createInventoryServices(pool, ports),
  buildApis: (services) => [buildInventoryApi(services)],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "inventory",
      manifest: contextManifest,
      handlers: {
        "catalog.inventory-catalog-item-projection": () => buildInventoryCatalogItemProjectionHandlers(services.db),
        "ordering.inventory-order-reservation-workflow": () => ({
          "ordering.order.created": async (event: Parameters<BcEventSubscriptionHandler>[0]) => {
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
              const existingState = await services.reservations.getReservationState(request.reservationRequestId);
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
                    accountId: request.sellerAccountId as AccountId,
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
          "ordering.order.cancelled": async (event: Parameters<BcEventSubscriptionHandler>[0]) => {
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

              const reservationState = await services.reservations.getReservationState(request.reservationRequestId);
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
                if (!(error instanceof InventoryDomainError) || error.message !== "Inventory hold not found.") {
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
        }),
      },
    }),
  seed: seedInventoryDatabase,
});
