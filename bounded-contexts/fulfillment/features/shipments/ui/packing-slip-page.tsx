import { t } from "@chase-sets/localization";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import { PackingSlipPrintDocument, type PackingSlipPrintSlip } from "@chase-sets/design-system";
import type { FulfillmentPackingSlip, FulfillmentPackingSlipFormat } from "./contracts";

function formatAddress(address: FulfillmentPackingSlip["shipping_destination_snapshot"]): string[] {
  return [
    address.name,
    address.company,
    address.line1,
    address.line2,
    `${address.city}, ${address.state} ${address.postalCode}`,
    address.country,
  ].filter((line): line is string => Boolean(line));
}

function mapPackingSlip(slip: FulfillmentPackingSlip): PackingSlipPrintSlip {
  return {
    id: slip.shipment_id,
    orderReference: deriveDisplayReferenceOrRaw(slip.order_id as OrderId),
    referenceLabel: t("fulfillment.features.shipments.ui.packingSlipPage.shipment"),
    referenceValue: slip.display_reference,
    shipToTitle: t("fulfillment.features.shipments.ui.packingSlipPage.ship.to"),
    shipToLines: formatAddress(slip.shipping_destination_snapshot),
    shipFromTitle: t("fulfillment.features.shipments.ui.packingSlipPage.ship.from"),
    shipFromLines: slip.shipping_origin_snapshot ? formatAddress(slip.shipping_origin_snapshot) : undefined,
    itemsTitle: t("fulfillment.features.shipments.ui.packingSlipPage.items"),
    lines: slip.lines.map((line) => ({
      id: line.line_id,
      title: line.item_title,
      subtitle: line.item_subtitle,
      summary: line.product_summary,
      quantity: line.quantity,
    })),
    footer: t("fulfillment.features.shipments.ui.packingSlipPage.no.prices"),
  };
}

export function FulfillmentPackingSlipPrintPage({
  slips,
  format,
}: {
  slips: readonly FulfillmentPackingSlip[];
  format: FulfillmentPackingSlipFormat;
}) {
  return (
    <PackingSlipPrintDocument
      format={format}
      toolbar={{
        eyebrow: t("fulfillment.features.shipments.ui.packingSlipPage.seller"),
        title: t("fulfillment.features.shipments.ui.packingSlipPage.packing.slips"),
        description: t("fulfillment.features.shipments.ui.packingSlipPage.ready.to.print", {
          count: slips.length,
        }),
        formatLabel: t("fulfillment.features.shipments.ui.packingSlipPage.format"),
        format,
        letterLabel: t("fulfillment.features.shipments.ui.packingSlipPage.letter"),
        thermalLabel: t("fulfillment.features.shipments.ui.packingSlipPage.thermal.4x6"),
        changeFormatLabel: t("fulfillment.features.shipments.ui.packingSlipPage.change.format"),
        printLabel: t("fulfillment.features.shipments.ui.packingSlipPage.print"),
        shipmentIds: slips.map((slip) => slip.shipment_id),
      }}
      labels={{
        packingSlip: t("fulfillment.features.shipments.ui.packingSlipPage.packing.slip"),
        order: t("fulfillment.features.shipments.ui.packingSlipPage.order"),
        item: t("fulfillment.features.shipments.ui.packingSlipPage.item"),
        product: t("fulfillment.features.shipments.ui.packingSlipPage.product"),
        quantity: t("fulfillment.features.shipments.ui.packingSlipPage.qty"),
        standardProduct: t("fulfillment.features.shipments.ui.packingSlipPage.standard"),
      }}
      slips={slips.map(mapPackingSlip)}
    />
  );
}
