export { default as contextManifest } from "./context.json";

import {
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
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
import { InventoryDomainError } from "./support/runtime-support/common";
import { createInventoryServices } from "./support/runtime-support/services";
import { inventorySchemaMigrations, inventorySchemaSql } from "./support/runtime-support/schema";
import { seedInventoryDatabase } from "./support/runtime-support/seed";

export const module = defineBoundedContextModule<InventoryServices, PgTransactionalPool, InventoryHostPorts>({
  manifest: contextManifest,
  schemaSql: inventorySchemaSql,
  schemaMigrations: inventorySchemaMigrations,
  createServices: (pool, ports, options) => createInventoryServices(pool, ports, options),
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
      },
    }),
  seed: seedInventoryDatabase,
});
