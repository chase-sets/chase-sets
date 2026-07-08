export { default as contextManifest } from "./context.json";

import {
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
  type BcEventSubscriptionHandler,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type {
  OrderingOrderCancelledPayload,
  OrderingOrderCreatedPayload,
} from "@chase-sets/event-core/public-event-payloads";
import contextManifest from "./context.json";
import type { InventoryHostPorts, InventoryServices } from "./support/runtime-support/services";
import { buildInventoryApi } from "./api";
import { reserveOrderInventoryRequest } from "./features/reservations/api/order-reservation-workflow";
import { withInventorySystemHoldReleaseAuthority } from "./features/holds/api/runtime";
import { buildInventoryCatalogItemProjectionHandlers } from "./features/inventory-items/integrations/catalog/projection";
import { buildInventoryFulfillmentSourceProjectionHandlers } from "./features/restock-decisions/read-model/projection";
import { InventoryDomainError } from "./support/runtime-support/common";
import { createInventoryServices } from "./support/runtime-support/services";
import { inventorySchemaMigrations, inventorySchemaSql } from "./support/runtime-support/schema";
import { seedInventoryDatabase } from "./support/runtime-support/seed";
import { createInventoryImportBatchMcpHandlers } from "./features/import-batches/api/mcp";
import { createInventoryItemMcpHandlers } from "./features/inventory-items/api/mcp";

const inventoryContextManifest = contextManifest as BcContextManifest;

export const module = defineBoundedContextModule<InventoryServices, PgTransactionalPool, InventoryHostPorts>({
  manifest: inventoryContextManifest,
  schemaSql: inventorySchemaSql,
  schemaMigrations: inventorySchemaMigrations,
  createServices: (pool, ports, options) => createInventoryServices(pool, ports, options),
  buildApis: (services) => [buildInventoryApi(services)],
  buildMcpHandlers: (services) => {
    const importBatches = createInventoryImportBatchMcpHandlers(services.importBatches);
    const items = createInventoryItemMcpHandlers(services.items);

    return {
      toolHandlers: {
        ...importBatches.toolHandlers,
        ...items.toolHandlers,
      },
      resourceHandlers: {
        ...importBatches.resourceHandlers,
        ...items.resourceHandlers,
      },
    };
  },
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "inventory",
      manifest: inventoryContextManifest,
      handlers: {
        "catalog.inventory-catalog-item-projection": () => buildInventoryCatalogItemProjectionHandlers(services.db),
        "ordering.inventory-order-reservation-workflow": () => ({
          "ordering.order.created": async (event: Parameters<BcEventSubscriptionHandler>[0]) => {
            const data = event.data as OrderingOrderCreatedPayload;

            for (const request of data.reservationRequests ?? []) {
              await reserveOrderInventoryRequest(
                {
                  holds: services.holds,
                  reservations: services.reservations,
                  appendToStreams: services.appendToStreams,
                },
                {
                  orderId: data.orderId,
                  request,
                  context: {
                    tenantId: event.tenantId,
                    audit: event.audit,
                    trace: event.trace,
                  },
                },
              );
            }
          },
          "ordering.order.cancelled": async (event: Parameters<BcEventSubscriptionHandler>[0]) => {
            const data = event.data as OrderingOrderCancelledPayload;
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
                const hold = await services.holds.getHold(request.holdId, request.sellerAccountId);
                if (!hold) {
                  throw new InventoryDomainError("Inventory hold not found.");
                }

                if (hold.status === "consumed") {
                  await services.restockDecisions.markPending(
                    {
                      accountId: request.sellerAccountId,
                      orderId: data.orderId,
                      itemId: request.inventoryItemId,
                      quantity: request.quantity,
                      reservationRequestId: request.reservationRequestId,
                      source: "order-cancelled-after-dispatch",
                      shipmentId: null,
                      returnReason: data.reason ?? null,
                      pendingAt: data.cancelledAt,
                    },
                    context,
                  );
                  continue;
                }

                await services.holds.releaseHold(
                  {
                    accountId: request.sellerAccountId,
                    holdId: request.holdId,
                    releaseReason: data.reason === "payment-deadline" ? "payment-deadline" : "order-cancelled",
                  },
                  withInventorySystemHoldReleaseAuthority(context),
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
        "fulfillment.inventory-fulfillment-restock-workflow": () => {
          const sourceHandlers = buildInventoryFulfillmentSourceProjectionHandlers(services.db);

          return {
            "fulfillment.shipment.created": sourceHandlers["fulfillment.shipment.created"]!,
            "fulfillment.shipment.returned": async (event: Parameters<BcEventSubscriptionHandler>[0]) => {
              const data = event.data as {
                shipmentId: string;
                reason: string | null;
                returnedAt: string;
              };

              await services.restockDecisions.markShipmentReturned(
                {
                  shipmentId: data.shipmentId,
                  returnReason: data.reason,
                  returnedAt: data.returnedAt,
                },
                {
                  tenantId: event.tenantId,
                  audit: event.audit,
                  trace: event.trace,
                },
              );
            },
          };
        },
      },
    }),
  seed: seedInventoryDatabase,
});
