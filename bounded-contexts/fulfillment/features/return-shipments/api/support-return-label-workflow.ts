import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { PackagePlan } from "@chase-sets/product-measures";
import { FulfillmentDomainError } from "../domain/common";
import { createSellerReturnDestination } from "../domain/facility-directory";
import {
  returnLabelCostPayerForFlow,
  returnLabelRemedyIdForSupportRequest,
  returnShipmentIdForSupportRequest,
} from "../domain/support-return-label-policy";
import type {
  IssueReturnLabelResult,
  ReturnLabelDirective,
  ReturnShipmentLabelPurchaseService,
  VoidReturnLabelResult,
} from "./label-purchase";

export type SupportReturnLabelSource = Readonly<{
  supportRequestId: string;
  orderId: string;
  outboundShipmentId: string;
  affectedOrderLineIds: readonly string[];
  buyerAccountId: string;
  sellerAccountId: string;
  buyerAddress: AddressSnapshot;
  sellerAddress: AddressSnapshot;
  packagePlan: Pick<PackagePlan, "packages">;
}>;

type SupportResolutionInput = Readonly<{
  supportRequestId: string;
  flowType: string;
  resolution: Readonly<{ resolutionType: string; resolvedAt: string }>;
}>;

type SupportReturnLabelWorkflowDeps = Readonly<{
  loadSource: (supportRequestId: string) => Promise<SupportReturnLabelSource | null>;
  issueReturnLabel: ReturnShipmentLabelPurchaseService["issueReturnLabel"];
  voidReturnLabel: ReturnShipmentLabelPurchaseService["voidReturnLabel"];
  now?: () => string;
}>;

function addDays(value: string, days: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new FulfillmentDomainError("Return resolution time must be valid.");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function serviceLevel(value: string): string {
  if (value === "priority-parcel") return "usps_priority";
  if (value === "expedited-parcel") return "usps_priority";
  return "usps_ground_advantage";
}

function packageRequirements(source: SupportReturnLabelSource) {
  const selected =
    source.packagePlan.packages.find((entry) => entry.mailpieceClass === "parcel") ?? source.packagePlan.packages[0];
  if (!selected) throw new FulfillmentDomainError("The outbound shipment has no package plan for its return label.");
  return {
    lengthInches: selected.mailpieceClass === "letter" ? 9.5 : selected.lengthInches,
    widthInches: selected.mailpieceClass === "letter" ? 4.125 : selected.widthInches,
    heightInches: selected.mailpieceClass === "letter" ? 0.25 : selected.heightInches,
    weightOunces: selected.weightOunces,
  };
}

export function createSupportReturnLabelWorkflow(deps: SupportReturnLabelWorkflowDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  return {
    async issueForResolution(
      input: SupportResolutionInput,
      context: EventStoreContext,
    ): Promise<IssueReturnLabelResult | Readonly<{ outcome: "not-return-bearing" }>> {
      if (input.resolution.resolutionType !== "return-for-refund") return { outcome: "not-return-bearing" };
      const costPayer = returnLabelCostPayerForFlow(input.flowType);
      const source = await deps.loadSource(input.supportRequestId);
      if (!source)
        throw new FulfillmentDomainError("The resolved support return is missing its outbound shipment source.");
      const selectedPackage =
        source.packagePlan.packages.find((entry) => entry.mailpieceClass === "parcel") ??
        source.packagePlan.packages[0];
      if (!selectedPackage) throw new FulfillmentDomainError("The outbound shipment has no package plan for return.");
      const selectedAt = now();
      const directive: ReturnLabelDirective = {
        returnShipmentId: returnShipmentIdForSupportRequest(input.supportRequestId),
        remedyId: returnLabelRemedyIdForSupportRequest(input.supportRequestId),
        supportRequestId: input.supportRequestId as never,
        orderId: source.orderId as never,
        outboundShipmentId: source.outboundShipmentId as never,
        affectedOrderLineIds: source.affectedOrderLineIds,
        returnDirective: "return-to-seller",
        destinationSnapshot: createSellerReturnDestination({
          sellerAccountId: source.sellerAccountId,
          postalAddress: source.sellerAddress,
          selectedAt,
          snapshotVersion: "outbound-shipment-origin-v1",
        }),
        returnProgram: "seller-return",
        carrier: "usps",
        region: source.buyerAddress.country.toLowerCase(),
        serviceLevel: serviceLevel(selectedPackage.serviceLevel),
        shipFromSnapshot: source.buyerAddress,
        packageRequirements: packageRequirements(source),
        costPayer,
        costAllocationReference: `support-return-postage:${input.supportRequestId}`,
        estimatedPostageAmountCents: null,
        selectionPolicyVersion: "support-return-destination-v1",
        shipByDeadlineAt: addDays(input.resolution.resolvedAt, 14),
        returnByDeadlineAt: addDays(input.resolution.resolvedAt, 30),
        policyVersion: "support-return-label-v1",
        idempotencyKey: `support-return-label:${input.supportRequestId}`,
      };
      return deps.issueReturnLabel(directive, context);
    },

    voidForCancellation(
      input: Readonly<{ supportRequestId: string; reason: string }>,
      context: EventStoreContext,
    ): Promise<VoidReturnLabelResult> {
      return deps.voidReturnLabel(
        { returnShipmentId: returnShipmentIdForSupportRequest(input.supportRequestId), reason: input.reason },
        context,
      );
    },
  };
}

type SupportReturnLabelSourceRow = Readonly<{
  support_request_id: string;
  order_id: string;
  affected_order_line_ids: unknown;
  shipment_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  shipping_destination_snapshot: AddressSnapshot;
  shipping_origin_snapshot: AddressSnapshot;
  shipping_plan_snapshot: PackagePlan;
}>;

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export async function loadSupportReturnLabelSource(
  db: PgQueryable,
  supportRequestId: string,
): Promise<SupportReturnLabelSource | null> {
  const result = await db.query<SupportReturnLabelSourceRow>(
    `SELECT source.support_request_id,
            source.order_id,
            source.affected_order_line_ids,
            shipment.shipment_id,
            shipment.buyer_account_id,
            shipment.seller_account_id,
            shipment.shipping_destination_snapshot,
            shipment.shipping_origin_snapshot,
            shipment.shipping_plan_snapshot
     FROM fulfillment_support_return_sources source
     JOIN fulfillment_shipment_pages shipment ON shipment.order_id = source.order_id
     WHERE source.support_request_id = $1
       AND NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(source.affected_order_line_ids) affected(line_id)
         WHERE NOT EXISTS (
           SELECT 1 FROM fulfillment_shipment_line_pages line
           WHERE line.shipment_id = shipment.shipment_id
             AND line.order_line_id = affected.line_id
         )
       )
     ORDER BY shipment.created_at ASC, shipment.shipment_id ASC
     LIMIT 1`,
    [supportRequestId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    supportRequestId: row.support_request_id,
    orderId: row.order_id,
    outboundShipmentId: row.shipment_id,
    affectedOrderLineIds: stringArray(row.affected_order_line_ids),
    buyerAccountId: row.buyer_account_id,
    sellerAccountId: row.seller_account_id,
    buyerAddress: normalizeAddressSnapshot(row.shipping_destination_snapshot, "Return buyer address"),
    sellerAddress: normalizeAddressSnapshot(row.shipping_origin_snapshot, "Return seller address"),
    packagePlan: row.shipping_plan_snapshot,
  };
}
