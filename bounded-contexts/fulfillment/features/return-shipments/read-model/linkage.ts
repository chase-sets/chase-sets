import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type ReturnShipmentLinkage = Readonly<{
  supportRequestId: string;
  remedyId: string;
  orderId: string;
  outboundShipmentId: string;
  affectedOrderLineIds: readonly string[];
  returnDirective: string;
}>;

export type ReturnShipmentLinkageSource = Readonly<{
  supportOrderId: string | null;
  supportAffectedOrderLineIds: readonly string[];
  remedySupportRequestId: string | null;
  remedyReturnDirective: string | null;
  shipmentOrderId: string | null;
  shipmentOrderLineIds: readonly string[];
}>;

export type ReturnShipmentLinkageValidation = Readonly<{ ok: true }> | Readonly<{ ok: false; detail: string }>;

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function validateReturnShipmentLinkage(
  linkage: ReturnShipmentLinkage,
  source: ReturnShipmentLinkageSource,
): ReturnShipmentLinkageValidation {
  if (
    linkage.affectedOrderLineIds.length === 0 ||
    linkage.affectedOrderLineIds.some((lineId) => lineId.trim().length === 0) ||
    new Set(linkage.affectedOrderLineIds).size !== linkage.affectedOrderLineIds.length
  ) {
    return { ok: false, detail: "The return must declare one or more unique affected order lines." };
  }
  if (source.supportOrderId !== linkage.orderId) {
    return { ok: false, detail: "The support case does not belong to the declared order." };
  }
  if (source.remedySupportRequestId !== linkage.supportRequestId) {
    return { ok: false, detail: "The remedy does not belong to the declared support case." };
  }
  if (source.remedyReturnDirective !== linkage.returnDirective) {
    return { ok: false, detail: "The remedy does not authorize the declared return directive." };
  }
  if (source.shipmentOrderId !== linkage.orderId) {
    return { ok: false, detail: "The outbound shipment does not belong to the declared order." };
  }
  if (!sameSet(source.supportAffectedOrderLineIds, linkage.affectedOrderLineIds)) {
    return { ok: false, detail: "The return lines do not match the support case's affected lines." };
  }
  if (!linkage.affectedOrderLineIds.every((lineId) => source.shipmentOrderLineIds.includes(lineId))) {
    return { ok: false, detail: "An affected order line does not belong to the outbound shipment." };
  }
  return { ok: true };
}

type LinkageSourceRow = Readonly<{
  support_order_id: string | null;
  support_affected_order_line_ids: unknown;
  remedy_support_request_id: string | null;
  remedy_return_directive: string | null;
  shipment_order_id: string | null;
  shipment_order_line_ids: unknown;
}>;

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export async function loadReturnShipmentLinkageSource(
  db: PgQueryable,
  linkage: ReturnShipmentLinkage,
): Promise<ReturnShipmentLinkageSource> {
  const result = await db.query<LinkageSourceRow>(
    `SELECT
       support_source.order_id AS support_order_id,
       COALESCE(support_source.affected_order_line_ids, '[]'::jsonb) AS support_affected_order_line_ids,
       remedy_source.support_request_id AS remedy_support_request_id,
       remedy_source.return_directive AS remedy_return_directive,
       shipment.order_id AS shipment_order_id,
       COALESCE((
         SELECT jsonb_agg(line.order_line_id ORDER BY line.order_line_id)
         FROM fulfillment_shipment_line_pages line
         WHERE line.shipment_id = $3
       ), '[]'::jsonb) AS shipment_order_line_ids
     FROM (SELECT 1) anchor
     LEFT JOIN fulfillment_support_return_sources support_source
       ON support_source.support_request_id = $1
     LEFT JOIN fulfillment_support_return_remedy_sources remedy_source
       ON remedy_source.remedy_id = $2
     LEFT JOIN fulfillment_shipment_pages shipment
       ON shipment.shipment_id = $3`,
    [linkage.supportRequestId, linkage.remedyId, linkage.outboundShipmentId],
  );
  const row = result.rows[0];
  return {
    supportOrderId: row?.support_order_id ?? null,
    supportAffectedOrderLineIds: stringArray(row?.support_affected_order_line_ids),
    remedySupportRequestId: row?.remedy_support_request_id ?? null,
    remedyReturnDirective: row?.remedy_return_directive ?? null,
    shipmentOrderId: row?.shipment_order_id ?? null,
    shipmentOrderLineIds: stringArray(row?.shipment_order_line_ids),
  };
}
