export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { OrderingServiceOptions, OrderingServices } from "./support/runtime-support/services";
import { buildOrderingAccountProjectionHandlers } from "./support/account-support/projection";
import { buildOrderingApi } from "./api";
import { hasOrderForSource } from "./features/orders/read-model/queries";
import {
  buildOrderingInventorySupplyProjectionHandlers,
  buildOrderingMarketplaceSupplyProjectionHandlers,
} from "./features/orders/integrations/supply/supply-projection";
import { buildOrderingFulfillmentCancellationProjectionHandlers } from "./features/orders/integrations/fulfillment/fulfillment-projection";
import { listAcceptedOfferBatchInputs } from "./features/orders/integrations/supply/supply-queries";
import { createOrderingServices } from "./support/runtime-support/services";
import { orderingSchemaSql } from "./support/runtime-support/schema";
import { seedOrderingDatabase } from "./support/runtime-support/seed";

const eventSubscriptions = (contextManifest.eventSubscriptions ?? []) as readonly BcEventSubscriptionDeclaration[];
const projectionGroups = (contextManifest.projectionGroups ?? []) as readonly BcProjectionGroupDeclaration[];

function getEventSubscription(sourceContextName: string, projectionName: string): BcEventSubscriptionDeclaration {
  const declaration = eventSubscriptions.find(
    (entry) => entry.sourceContextName === sourceContextName && entry.projectionName === projectionName,
  );

  if (!declaration) {
    throw new Error(
      `Ordering is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

function selectSubscriptionHandlers(
  handlers: ProjectorHandlerMap,
  eventTypes: readonly string[] | undefined,
): ProjectorHandlerMap {
  if (!eventTypes) {
    return handlers;
  }

  return Object.fromEntries(
    eventTypes.flatMap((eventType) => (handlers[eventType] ? [[eventType, handlers[eventType]]] : [])),
  );
}

function createPaymentCaptureDispatchError(
  failures: readonly Readonly<{ orderId: string; reason: unknown }>[],
  orderCount: number,
): AggregateError {
  return new AggregateError(
    failures.map(({ orderId, reason }) =>
      reason instanceof Error
        ? new Error(`Order '${orderId}' readiness dispatch failed: ${reason.message}`, { cause: reason })
        : new Error(`Order '${orderId}' readiness dispatch failed: ${String(reason)}`),
    ),
    `Failed to mark ${failures.length} of ${orderCount} captured order(s) ready for fulfillment.`,
  );
}

export const module: BcApiModule<OrderingServices, PgTransactionalPool, OrderingServiceOptions> = {
  contextName: "ordering",
  routePrefix: "/api/marketplace",
  streamPrefix: "ordering.",
  schemaSql: orderingSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    OrderingServices,
    PgTransactionalPool,
    OrderingServiceOptions
  >["apiMounts"],
  projectionGroups,
  createServices: (pool, options) => createOrderingServices(pool, options),
  buildApis: (services) => [buildOrderingApi(services)],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const identitySubscription = getEventSubscription("identity", "ordering-account-projection");
    const marketplaceSupplySubscription = getEventSubscription(
      "marketplace",
      "ordering-marketplace-supply-input-projection",
    );
    const inventorySupplySubscription = getEventSubscription("inventory", "ordering-inventory-supply-input-projection");
    const inventoryReservationOutcomeSubscription = getEventSubscription(
      "inventory",
      "ordering-inventory-reservation-outcomes",
    );
    const marketplaceOfferAcceptanceSubscription = getEventSubscription(
      "marketplace",
      "ordering-marketplace-offer-acceptance",
    );
    const paymentCaptureSubscription = getEventSubscription("payments", "ordering-payment-capture");
    const fulfillmentCancellationSubscription = getEventSubscription(
      "fulfillment",
      "ordering-fulfillment-cancellation-inputs",
    );

    const marketplaceSupplyHandlers = buildOrderingMarketplaceSupplyProjectionHandlers(services.db);

    return [
      {
        subscriptionName: "ordering.identity-account-projection",
        sourceContextName: "identity",
        projectionName: identitySubscription.projectionName,
        subscriptionVersion: identitySubscription.subscriptionVersion,
        handlers: buildOrderingAccountProjectionHandlers(services.db),
        eventTypes: identitySubscription.eventTypes,
        streamPrefixes: identitySubscription.streamPrefixes,
        order: identitySubscription.order,
      },
      {
        subscriptionName: "ordering.marketplace-supply-input-projection",
        sourceContextName: "marketplace",
        projectionName: marketplaceSupplySubscription.projectionName,
        subscriptionVersion: marketplaceSupplySubscription.subscriptionVersion,
        handlers: selectSubscriptionHandlers(marketplaceSupplyHandlers, marketplaceSupplySubscription.eventTypes),
        eventTypes: marketplaceSupplySubscription.eventTypes,
        streamPrefixes: marketplaceSupplySubscription.streamPrefixes,
        order: marketplaceSupplySubscription.order,
      },
      {
        subscriptionName: "ordering.inventory-supply-input-projection",
        sourceContextName: "inventory",
        projectionName: inventorySupplySubscription.projectionName,
        subscriptionVersion: inventorySupplySubscription.subscriptionVersion,
        handlers: buildOrderingInventorySupplyProjectionHandlers(services.db),
        eventTypes: inventorySupplySubscription.eventTypes,
        streamPrefixes: inventorySupplySubscription.streamPrefixes,
        order: inventorySupplySubscription.order,
      },
      {
        subscriptionName: "ordering.inventory-reservation-outcomes",
        sourceContextName: "inventory",
        projectionName: inventoryReservationOutcomeSubscription.projectionName,
        subscriptionVersion: inventoryReservationOutcomeSubscription.subscriptionVersion,
        handlers: {
          "inventory.reservation.confirmed": async (event) => {
            const data = event.data as {
              reservationRequestId: string;
              holdId: string;
            };

            await services.orders.commandHandler({
              streamId: `ordering.order-${(event.data as { orderId: string }).orderId}`,
              command: {
                type: "RecordReservationConfirmed",
                reservationRequestId: data.reservationRequestId,
                holdId: data.holdId,
                confirmedAt: event.timing.recordedAt,
              },
              context: {
                tenantId: event.tenantId,
                audit: event.audit,
                trace: event.trace,
              } as never,
            });
          },
          "inventory.reservation.rejected": async (event) => {
            const data = event.data as {
              orderId: string;
              reservationRequestId: string;
              reason: string;
            };

            await services.orders.commandHandler({
              streamId: `ordering.order-${data.orderId}`,
              command: {
                type: "RecordReservationRejected",
                reservationRequestId: data.reservationRequestId,
                rejectedAt: event.timing.recordedAt,
                reason: data.reason,
              },
              context: {
                tenantId: event.tenantId,
                audit: event.audit,
                trace: event.trace,
              } as never,
            });
          },
          "inventory.reservation.released": async (event) => {
            const data = event.data as {
              orderId: string;
              reservationRequestId: string;
              holdId: string;
              releasedAt: string;
            };

            await services.orders.commandHandler({
              streamId: `ordering.order-${data.orderId}`,
              command: {
                type: "RecordReservationReleased",
                reservationRequestId: data.reservationRequestId,
                holdId: data.holdId,
                releasedAt: data.releasedAt,
              },
              context: {
                tenantId: event.tenantId,
                audit: event.audit,
                trace: event.trace,
              } as never,
            });
          },
        },
        eventTypes: inventoryReservationOutcomeSubscription.eventTypes,
        streamPrefixes: inventoryReservationOutcomeSubscription.streamPrefixes,
        order: inventoryReservationOutcomeSubscription.order,
      },
      {
        subscriptionName: "ordering.marketplace-offer-acceptance",
        sourceContextName: "marketplace",
        projectionName: marketplaceOfferAcceptanceSubscription.projectionName,
        subscriptionVersion: marketplaceOfferAcceptanceSubscription.subscriptionVersion,
        handlers: selectSubscriptionHandlers(
          buildOrderingMarketplaceSupplyProjectionHandlers(services.db, {
            onOfferAccepted: async (params) => {
              if (params.acceptanceBatchId) {
                const batchRows = await listAcceptedOfferBatchInputs(services.db, params.acceptanceBatchId);
                const expectedSize = params.acceptanceBatchSize ?? batchRows.length;
                if (batchRows.length < expectedSize) {
                  return;
                }
                if (await hasOrderForSource(services.db, "offer-acceptance", params.acceptanceBatchId)) {
                  return;
                }

                await services.orders.createOrdersFromAcceptedOfferBatch(
                  {
                    acceptanceBatchId: params.acceptanceBatchId,
                    offers: batchRows.map((row) => ({
                      offerId: row.offer_id,
                      buyerAccountId: row.buyer_account_id as never,
                      sellerAccountId: row.seller_account_id as never,
                      catalogItemId: row.catalog_catalog_item_id,
                      productId: row.product_id,
                      itemTitle: row.item_title,
                      itemSubtitle: row.item_subtitle,
                      selectedOptions: [...row.selected_options],
                      productSummary: row.product_summary,
                      priceAmount: row.price_amount,
                      marketplaceSalesFeeUnitAmount: row.marketplace_sales_fee_unit_amount,
                      sellerNetUnitAmount: row.seller_net_unit_amount,
                      shippingAllowancePercentageBps: row.shipping_allowance_percentage_bps,
                      shippingDestinationSnapshot: row.shipping_destination_snapshot,
                      termsScheduleId: row.terms_schedule_id,
                      termsAgreementId: row.terms_agreement_id,
                      termsResolvedAt: row.terms_resolved_at,
                      quantityRequested: row.quantity_requested,
                    })),
                  },
                  params.context,
                );
                return;
              }

              if (await hasOrderForSource(services.db, "offer-acceptance", params.offerId)) {
                return;
              }

              await services.orders.createOrdersFromAcceptedOffer(
                {
                  offerId: params.offerId,
                  buyerAccountId: params.buyerAccountId as never,
                  sellerAccountId: params.sellerAccountId as never,
                  catalogItemId: params.catalogItemId,
                  productId: params.productId as never,
                  itemTitle: params.itemTitle,
                  itemSubtitle: params.itemSubtitle,
                  selectedOptions: [...params.selectedOptions],
                  productSummary: params.productSummary,
                  priceAmount: params.priceAmount,
                  marketplaceSalesFeeUnitAmount: params.marketplaceSalesFeeUnitAmount,
                  sellerNetUnitAmount: params.sellerNetUnitAmount,
                  termsScheduleId: params.termsScheduleId,
                  termsAgreementId: params.termsAgreementId,
                  termsResolvedAt: params.termsResolvedAt,
                  shippingAllowancePercentageBps: params.shippingAllowancePercentageBps,
                  shippingDestinationSnapshot: params.shippingDestinationSnapshot as never,
                  quantityRequested: params.quantityRequested,
                },
                params.context,
              );
            },
          }),
          marketplaceOfferAcceptanceSubscription.eventTypes,
        ),
        eventTypes: marketplaceOfferAcceptanceSubscription.eventTypes,
        streamPrefixes: marketplaceOfferAcceptanceSubscription.streamPrefixes,
        order: marketplaceOfferAcceptanceSubscription.order,
      },
      {
        subscriptionName: "ordering.payment-capture",
        sourceContextName: "payments",
        projectionName: paymentCaptureSubscription.projectionName,
        subscriptionVersion: paymentCaptureSubscription.subscriptionVersion,
        handlers: {
          "payments.payment-captured": async (event) => {
            const data = event.data as {
              paymentId: string;
              orderIds: string[];
              buyerAccountId: string;
              amount: string;
              currencyCode: string;
              processorName: string;
              processorPaymentReference: string;
              processorStatus: string;
              capturedAt: string;
            };

            await services.db.query(
              `INSERT INTO ordering_payment_capture_inputs (
                 payment_id,
                 buyer_account_id,
                 order_ids,
                 amount,
                 currency_code,
                 processor_name,
                 processor_payment_reference,
                 processor_status,
                 captured_at,
                 updated_at
               ) VALUES ($1, $2, to_jsonb($3::text[]), $4, $5, $6, $7, $8, $9, $9)
               ON CONFLICT (payment_id) DO UPDATE
               SET buyer_account_id = EXCLUDED.buyer_account_id,
                   order_ids = EXCLUDED.order_ids,
                   amount = EXCLUDED.amount,
                   currency_code = EXCLUDED.currency_code,
                   processor_name = EXCLUDED.processor_name,
                   processor_payment_reference = EXCLUDED.processor_payment_reference,
                   processor_status = EXCLUDED.processor_status,
                   captured_at = EXCLUDED.captured_at,
                   updated_at = EXCLUDED.updated_at`,
              [
                data.paymentId,
                data.buyerAccountId,
                data.orderIds ?? [],
                data.amount,
                data.currencyCode,
                data.processorName,
                data.processorPaymentReference,
                data.processorStatus,
                data.capturedAt,
              ],
            );

            const orderIds = data.orderIds ?? [];
            const dispatchResults = await Promise.allSettled(
              orderIds.map((orderId) =>
                services.orders.commandHandler({
                  streamId: `ordering.order-${orderId}`,
                  command: {
                    type: "MarkReadyForFulfillment",
                    readyForFulfillmentAt: data.capturedAt,
                  },
                  context: {
                    tenantId: event.tenantId,
                    audit: event.audit,
                    trace: event.trace,
                  } as never,
                }),
              ),
            );
            const dispatchFailures = dispatchResults.flatMap((result, index) =>
              result.status === "rejected" ? [{ orderId: orderIds[index], reason: result.reason }] : [],
            );

            if (dispatchFailures.length > 0) {
              throw createPaymentCaptureDispatchError(dispatchFailures, orderIds.length);
            }
          },
        },
        eventTypes: paymentCaptureSubscription.eventTypes,
        streamPrefixes: paymentCaptureSubscription.streamPrefixes,
        order: paymentCaptureSubscription.order,
      },
      {
        subscriptionName: "ordering.fulfillment-cancellation-inputs",
        sourceContextName: "fulfillment",
        projectionName: fulfillmentCancellationSubscription.projectionName,
        subscriptionVersion: fulfillmentCancellationSubscription.subscriptionVersion,
        handlers: buildOrderingFulfillmentCancellationProjectionHandlers(services.db),
        eventTypes: fulfillmentCancellationSubscription.eventTypes,
        streamPrefixes: fulfillmentCancellationSubscription.streamPrefixes,
        order: fulfillmentCancellationSubscription.order,
      },
    ];
  },
  seed: seedOrderingDatabase,
};
