import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ShipmentId } from "@chase-sets/primitives/typed-ids";
import { withShipmentDisplayReference } from "./display-reference";

export function buildFulfillmentShipmentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  function labelStatusFromRefundStatus(refundStatus: string) {
    if (refundStatus === "refunded") {
      return "voided";
    }
    if (refundStatus === "rejected") {
      return "void-rejected";
    }
    return "void-requested";
  }

  function shipmentStatusFromRefundStatus(refundStatus: string) {
    return refundStatus === "rejected" ? "label-attached" : "awaiting-label";
  }

  return {
    ...defineProjectorHandlers<
      Pick<ChaseSetsEventPayloads, "fulfillment.shipment.created" | "fulfillment.shipment.packing-started">
    >({
      "fulfillment.shipment.created": async (event) => {
        const { data } = event;

        await withShipmentDisplayReference(data.shipmentId as ShipmentId, (displayReference) =>
          db.query(
            `INSERT INTO fulfillment_shipment_pages (
           shipment_id,
           tenant_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           shipping_option,
           shipping_destination_snapshot,
           shipping_origin_snapshot,
           shipping_plan_snapshot,
           shipping_method,
           carrier_name,
           display_reference,
           label_reference,
           label_document_url,
           tracking_identifier,
           postage_provider_name,
           postage_provider_mode,
           postage_provider_shipment_id,
           postage_provider_label_id,
           postage_rate_id,
           postage_service_level,
           postage_amount_cents,
           postage_currency,
           label_status,
           label_error_code,
           label_error_message,
           label_refund_status,
           label_refund_reference,
           status,
           package_status,
           package_count,
           current_exception_type,
           current_exception_notes,
           created_at,
           updated_at,
           packing_started_at,
           package_prepared_at,
           label_attached_at,
           label_voided_at,
           cancelled_at,
           dispatched_at,
           delivered_at,
           returned_at,
           exception_raised_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, $10, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'not-purchased', NULL, NULL, NULL, NULL, 'awaiting-package', 'awaiting-package', NULL, NULL, NULL, $11, $11, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
         )
         ON CONFLICT (shipment_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             tenant_id = EXCLUDED.tenant_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             shipping_option = EXCLUDED.shipping_option,
             shipping_destination_snapshot = EXCLUDED.shipping_destination_snapshot,
             shipping_origin_snapshot = EXCLUDED.shipping_origin_snapshot,
             shipping_plan_snapshot = EXCLUDED.shipping_plan_snapshot,
             display_reference = EXCLUDED.display_reference,
             updated_at = EXCLUDED.updated_at`,
            [
              data.shipmentId,
              event.tenantId,
              data.orderId,
              data.buyerAccountId,
              data.sellerAccountId,
              data.shippingOption,
              JSON.stringify(data.shippingDestinationSnapshot),
              JSON.stringify(data.shippingOriginSnapshot),
              JSON.stringify(data.shippingPlanSnapshot ?? {}),
              displayReference,
              data.createdAt,
            ],
          ),
        );

        await db.query(
          `INSERT INTO fulfillment_shipment_tenant_resolutions (
             shipment_id, tenant_id, seller_account_id, status, reason_code, resolved_at
           ) VALUES ($1, $2, $3, 'resolved', 'authoritative-history', $4)
           ON CONFLICT (shipment_id) DO UPDATE
           SET tenant_id = EXCLUDED.tenant_id,
               seller_account_id = EXCLUDED.seller_account_id,
               status = CASE
                 WHEN fulfillment_shipment_tenant_resolutions.tenant_id = EXCLUDED.tenant_id
                  AND fulfillment_shipment_tenant_resolutions.seller_account_id = EXCLUDED.seller_account_id
                 THEN 'resolved' ELSE 'quarantined' END,
               reason_code = CASE
                 WHEN fulfillment_shipment_tenant_resolutions.tenant_id = EXCLUDED.tenant_id
                  AND fulfillment_shipment_tenant_resolutions.seller_account_id = EXCLUDED.seller_account_id
                 THEN 'authoritative-history' ELSE 'projection-identity-mismatch' END,
               resolved_at = EXCLUDED.resolved_at`,
          [data.shipmentId, event.tenantId, data.sellerAccountId, data.createdAt],
        );

        await db.query(`DELETE FROM fulfillment_shipment_line_pages WHERE shipment_id = $1`, [data.shipmentId]);

        for (const [index, line] of data.lines.entries()) {
          await db.query(
            `INSERT INTO fulfillment_shipment_line_pages (
             shipment_id,
             line_id,
             line_index,
             order_line_id,
             catalog_catalog_item_id,
             product_id,
             item_title,
             item_subtitle,
             product_summary,
             quantity,
             packing_confirmed_quantity,
             packing_confirmed_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
           )`,
            [
              data.shipmentId,
              line.lineId,
              index,
              line.orderLineId,
              line.catalogItemId,
              line.productId,
              line.itemTitle,
              line.itemSubtitle,
              line.productSummary,
              line.quantity,
              line.packingConfirmedQuantity ?? (line.packingConfirmedAt ? line.quantity : 0),
              line.packingConfirmedAt ?? null,
            ],
          );
        }
      },
      "fulfillment.shipment.packing-started": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE fulfillment_shipment_pages
         SET status = 'packing',
             package_status = 'packing',
             packing_started_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
          [data.shipmentId, data.startedAt],
        );
      },
    }),
    "fulfillment.shipment.packing-line-confirmed": async (event) => {
      const data = event.data as {
        shipmentId: string;
        lineId: string;
        confirmedAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_line_pages
         SET packing_confirmed_quantity = quantity,
             packing_confirmed_at = $3
         WHERE shipment_id = $1
           AND line_id = $2`,
        [data.shipmentId, data.lineId, data.confirmedAt],
      );

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.confirmedAt],
      );
    },
    "fulfillment.shipment.packing-line-unconfirmed": async (event) => {
      const data = event.data as {
        shipmentId: string;
        lineId: string;
        unconfirmedAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_line_pages
         SET packing_confirmed_quantity = 0,
             packing_confirmed_at = NULL
         WHERE shipment_id = $1
           AND line_id = $2`,
        [data.shipmentId, data.lineId],
      );

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.unconfirmedAt],
      );
    },
    "fulfillment.shipment.packing-line-quantity-set": async (event) => {
      const data = event.data as {
        shipmentId: string;
        lineId: string;
        confirmedQuantity: number;
        confirmedAt: string | null;
        setAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_line_pages
         SET packing_confirmed_quantity = $3,
             packing_confirmed_at = $4
         WHERE shipment_id = $1
           AND line_id = $2`,
        [data.shipmentId, data.lineId, data.confirmedQuantity, data.confirmedAt],
      );

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.setAt],
      );
    },
    ...defineProjectorHandlers<
      Pick<ChaseSetsEventPayloads, "fulfillment.shipment.package-prepared" | "fulfillment.shipment.label-attached">
    >({
      "fulfillment.shipment.package-prepared": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE fulfillment_shipment_pages
         SET status = 'awaiting-label',
             package_status = 'packed',
             package_count = $2,
             package_prepared_at = $3,
             updated_at = $3
         WHERE shipment_id = $1`,
          [data.shipmentId, data.packageCount, data.preparedAt],
        );
      },
      "fulfillment.shipment.label-attached": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE fulfillment_shipment_pages
         SET status = 'label-attached',
             shipping_method = $2,
             carrier_name = $3,
             label_reference = $4,
             label_document_url = $5,
             tracking_identifier = $6,
             postage_provider_name = $7,
             postage_provider_mode = $8,
             postage_provider_shipment_id = $9,
             postage_provider_label_id = $10,
             postage_rate_id = $11,
             postage_service_level = $12,
             postage_amount_cents = $13,
             postage_currency = $14,
             label_status = 'purchased',
             label_error_code = NULL,
             label_error_message = NULL,
             label_refund_status = NULL,
             label_refund_reference = NULL,
             label_attached_at = $15,
             label_voided_at = NULL,
             updated_at = $15
         WHERE shipment_id = $1`,
          [
            data.shipmentId,
            data.shippingMethod,
            data.carrierName,
            data.labelReference,
            data.labelDocumentUrl,
            data.trackingIdentifier,
            data.postageProviderName,
            data.postageProviderMode,
            data.postageProviderShipmentId,
            data.postageProviderLabelId,
            data.postageRateId,
            data.postageServiceLevel,
            data.postageAmountCents,
            data.postageCurrency,
            data.attachedAt,
          ],
        );

        if (data.addressOverrideAudit) {
          await db.query(
            `INSERT INTO fulfillment_label_address_override_audit_pages (
             shipment_id,
             recorded_at,
             changed_side,
             reason,
             actor,
             original_sender_snapshot,
             submitted_sender_address,
             original_recipient_snapshot,
             submitted_recipient_address
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (shipment_id, recorded_at) DO UPDATE SET
             changed_side = EXCLUDED.changed_side,
             reason = EXCLUDED.reason,
             actor = EXCLUDED.actor,
             original_sender_snapshot = EXCLUDED.original_sender_snapshot,
             submitted_sender_address = EXCLUDED.submitted_sender_address,
             original_recipient_snapshot = EXCLUDED.original_recipient_snapshot,
             submitted_recipient_address = EXCLUDED.submitted_recipient_address`,
            [
              data.shipmentId,
              data.addressOverrideAudit.timestamp,
              data.addressOverrideAudit.changedSide,
              data.addressOverrideAudit.reason,
              data.addressOverrideAudit.actor,
              JSON.stringify(data.addressOverrideAudit.originalSenderSnapshot),
              JSON.stringify(data.addressOverrideAudit.submittedSenderAddress),
              JSON.stringify(data.addressOverrideAudit.originalRecipientSnapshot),
              JSON.stringify(data.addressOverrideAudit.submittedRecipientAddress),
            ],
          );
        }
      },
    }),
    "fulfillment.shipment.label-purchase-failed": async (event) => {
      const data = event.data as {
        shipmentId: string;
        postageProviderName: string;
        postageProviderMode: string;
        errorCode: string | null;
        errorMessage: string;
        failedAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET label_status = 'purchase-error',
             postage_provider_name = $2,
             postage_provider_mode = $3,
             label_error_code = $4,
             label_error_message = $5,
             updated_at = $6
         WHERE shipment_id = $1`,
        [
          data.shipmentId,
          data.postageProviderName,
          data.postageProviderMode,
          data.errorCode,
          data.errorMessage,
          data.failedAt,
        ],
      );
    },
    "fulfillment.shipment.label-voided": async (event) => {
      const data = event.data as {
        shipmentId: string;
        refundStatus: string;
        refundReference: string | null;
        voidedAt: string;
      };
      const labelStatus = labelStatusFromRefundStatus(data.refundStatus);
      const shipmentStatus = shipmentStatusFromRefundStatus(data.refundStatus);

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET status = $2,
              label_status = $3,
              label_refund_status = $4,
              label_refund_reference = $5,
              label_voided_at = $6,
              updated_at = $6
          WHERE shipment_id = $1`,
        [data.shipmentId, shipmentStatus, labelStatus, data.refundStatus, data.refundReference, data.voidedAt],
      );
    },
    "fulfillment.shipment.label-refund-status-recorded": async (event) => {
      const data = event.data as {
        shipmentId: string;
        refundStatus: string;
        refundReference: string | null;
        resolvedAt: string;
      };
      const labelStatus = labelStatusFromRefundStatus(data.refundStatus);
      const shipmentStatus = shipmentStatusFromRefundStatus(data.refundStatus);

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET status = $2,
             label_status = $3,
             label_refund_status = $4,
             label_refund_reference = $5,
             updated_at = $6
         WHERE shipment_id = $1
           AND label_status = 'void-requested'`,
        [data.shipmentId, shipmentStatus, labelStatus, data.refundStatus, data.refundReference, data.resolvedAt],
      );
    },
    ...defineProjectorHandlers<
      Pick<
        ChaseSetsEventPayloads,
        "fulfillment.shipment.cancelled" | "fulfillment.shipment.dispatched" | "fulfillment.shipment.delivered"
      >
    >({
      "fulfillment.shipment.cancelled": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE fulfillment_shipment_pages
         SET status = 'cancelled',
             cancelled_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
          [data.shipmentId, data.cancelledAt],
        );
      },
      "fulfillment.shipment.dispatched": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE fulfillment_shipment_pages
         SET status = 'dispatched',
             dispatched_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
          [data.shipmentId, data.dispatchedAt],
        );
      },
      "fulfillment.shipment.delivered": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE fulfillment_shipment_pages
         SET status = 'delivered',
             delivered_at = $2,
             current_exception_type = NULL,
             current_exception_notes = NULL,
             exception_raised_at = NULL,
             updated_at = $2
         WHERE shipment_id = $1`,
          [data.shipmentId, data.deliveredAt],
        );
      },
    }),
    "fulfillment.shipment.returned": async (event) => {
      const data = event.data as {
        shipmentId: string;
        returnedAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET status = 'returned',
             returned_at = $2,
             current_exception_type = NULL,
             current_exception_notes = NULL,
             exception_raised_at = NULL,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.returnedAt],
      );
    },
    "fulfillment.shipment.exception-raised": async (event) => {
      const data = event.data as {
        shipmentId: string;
        exceptionType: string;
        notes: string | null;
        raisedAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET status = 'exception',
             current_exception_type = $2,
             current_exception_notes = $3,
             exception_raised_at = $4,
             updated_at = $4
         WHERE shipment_id = $1`,
        [data.shipmentId, data.exceptionType, data.notes, data.raisedAt],
      );

      await db.query(
        `INSERT INTO fulfillment_shipment_exception_pages (
           shipment_id,
           raised_at,
           exception_type,
           notes
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (shipment_id, raised_at) DO UPDATE
         SET exception_type = EXCLUDED.exception_type,
             notes = EXCLUDED.notes`,
        [data.shipmentId, data.raisedAt, data.exceptionType, data.notes],
      );
    },
  };
}
