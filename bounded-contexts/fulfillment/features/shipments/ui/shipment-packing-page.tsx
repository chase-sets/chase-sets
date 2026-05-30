import { useEffect, useMemo, useState } from "react";
import { t } from "@chase-sets/localization";
import {
  AddressBlock,
  Badge,
  Button,
  ChecklistCard,
  LinkButton,
  MarketplaceNotice,
  NumberInput,
  OperationalStatusBanner,
  Page,
  PageHeader,
  PageStepper,
  ProductOptions,
  Stack,
  StickyTaskFooter,
  TaskLineItem,
  TaskProgress,
  TaskSummary,
  Text,
  WorkstationLayout,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { FulfillmentShipmentDetail, FulfillmentShipmentLine } from "./contracts";

function statusLabel(status: string) {
  switch (status) {
    case "awaiting-package":
      return t("fulfillment.features.shipments.ui.shipmentPackingPage.status.awaiting.package");
    case "packing":
      return t("fulfillment.features.shipments.ui.shipmentPackingPage.status.packing");
    case "awaiting-label":
      return t("fulfillment.features.shipments.ui.shipmentPackingPage.status.awaiting.label");
    case "label-attached":
      return t("fulfillment.features.shipments.ui.shipmentPackingPage.status.label.attached");
    case "cancelled":
      return t("fulfillment.features.shipments.ui.shipmentPackingPage.status.cancelled");
    case "dispatched":
      return t("fulfillment.features.shipments.ui.shipmentPackingPage.status.dispatched");
    case "delivered":
      return t("fulfillment.features.shipments.ui.shipmentPackingPage.status.delivered");
    case "returned":
      return t("fulfillment.features.shipments.ui.shipmentPackingPage.status.returned");
    case "exception":
      return t("fulfillment.features.shipments.ui.shipmentPackingPage.status.exception");
    default:
      return status;
  }
}

function statusTone(status: string) {
  switch (status) {
    case "packing":
    case "awaiting-label":
    case "label-attached":
    case "dispatched":
      return "accent";
    case "delivered":
      return "success";
    case "cancelled":
      return "danger";
    case "returned":
    case "exception":
      return "warning";
    default:
      return "neutral";
  }
}

function addressLines(address: FulfillmentShipmentDetail["shipping_destination_snapshot"]) {
  return [
    address.name,
    address.company,
    address.line1,
    address.line2,
    `${address.city}, ${address.state} ${address.postalCode}`,
    address.country,
  ].filter((line): line is string => Boolean(line));
}

function formatAddressForCopy(lines: readonly string[]) {
  return lines.join("\n");
}

function shortReference(value: string) {
  const parts = value.split("_");
  const suffix = parts[1] ?? value;
  return suffix.length > 8 ? suffix.slice(-8).toUpperCase() : suffix.toUpperCase();
}

function itemCountLabel(quantity: number, lines: number) {
  const itemLabel = quantity === 1 ? "item" : "items";
  const lineLabel = lines === 1 ? "line" : "lines";
  return `${quantity} ${itemLabel} across ${lines} ${lineLabel}`;
}

function PackingLine({
  line,
  checked,
  disabled,
  saving,
  onCheckedChange,
}: {
  line: FulfillmentShipmentLine;
  checked: boolean;
  disabled: boolean;
  saving: boolean;
  onCheckedChange: (lineId: string, checked: boolean) => void;
}) {
  const productOptions = productOptionsFromSummary(
    line.product_summary ?? t("fulfillment.features.shipments.ui.shipmentPackingPage.standard"),
  );

  return (
    <TaskLineItem
      title={line.item_title}
      subtitle={line.item_subtitle}
      quantity={line.quantity}
      checked={checked}
      disabled={disabled || saving}
      checkboxLabel={t("fulfillment.features.shipments.ui.shipmentPackingPage.line.checked", {
        title: line.item_title,
        quantity: line.quantity,
      })}
      onCheckedChange={(nextChecked) => onCheckedChange(line.line_id, nextChecked)}
      meta={<ProductOptions options={productOptions} variant="chips" />}
      reference={
        <span className="inline-flex flex-wrap gap-x-2 gap-y-1">
          <span>
            {t("fulfillment.features.shipments.ui.shipmentPackingPage.order.line.reference", {
              reference: shortReference(line.order_line_id),
            })}
          </span>
          <span>
            {t("fulfillment.features.shipments.ui.shipmentPackingPage.product.reference", {
              reference: shortReference(line.product_id),
            })}
          </span>
          {saving ? <span>{t("fulfillment.features.shipments.ui.shipmentPackingPage.saving")}</span> : null}
        </span>
      }
    />
  );
}

export function FulfillmentShipmentPackingPage({
  shipment,
  backHref,
  errorMessage,
}: {
  shipment: FulfillmentShipmentDetail;
  backHref: string;
  errorMessage?: string | null;
}) {
  const [checkedLineIds, setCheckedLineIds] = useState<ReadonlySet<string>>(
    () => new Set(shipment.lines.filter((line) => line.packing_confirmed_at).map((line) => line.line_id)),
  );
  const [savingLineIds, setSavingLineIds] = useState<ReadonlySet<string>>(() => new Set());
  const checkedCount = checkedLineIds.size;
  const lineCount = shipment.lines.length;
  const progressValue = lineCount > 0 ? Math.round((checkedCount / lineCount) * 100) : 0;
  const allLinesChecked = checkedCount === lineCount;
  const hasSavingLines = savingLineIds.size > 0;
  const canCompletePacking = allLinesChecked && !hasSavingLines;
  const isPacking = shipment.status === "packing";
  const isAwaitingPackage = shipment.status === "awaiting-package";
  const isPackedOrLater = shipment.package_status === "packed" || shipment.status === "awaiting-label";
  const packingSlipHref = `/account/sales/shipments/packing-slips?shipmentIds=${encodeURIComponent(
    shipment.shipment_id,
  )}&format=letter`;
  const destinationLines = useMemo(() => addressLines(shipment.shipping_destination_snapshot), [shipment]);
  const buyerLabel = shipment.buyer_display_name ?? shipment.buyer_account_id;
  const orderReference = shortReference(shipment.order_id);

  useEffect(() => {
    setCheckedLineIds(new Set(shipment.lines.filter((line) => line.packing_confirmed_at).map((line) => line.line_id)));
  }, [shipment.lines]);

  async function persistLineConfirmation(lineId: string, checked: boolean) {
    setCheckedLineIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(lineId);
      } else {
        next.delete(lineId);
      }
      return next;
    });
    setSavingLineIds((current) => new Set(current).add(lineId));

    const formData = new FormData();
    formData.set("intent", "set-line-confirmed");
    formData.set("lineId", lineId);
    formData.set("confirmed", String(checked));

    try {
      const response = await fetch(window.location.pathname, {
        method: "POST",
        credentials: "same-origin",
        body: formData,
      });
      if (!response.ok) {
        throw new Error("Packing line update failed.");
      }
    } catch {
      setCheckedLineIds((current) => {
        const next = new Set(current);
        if (checked) {
          next.delete(lineId);
        } else {
          next.add(lineId);
        }
        return next;
      });
    } finally {
      setSavingLineIds((current) => {
        const next = new Set(current);
        next.delete(lineId);
        return next;
      });
    }
  }

  const secondaryRail = (
    <Stack gap={3}>
      <TaskSummary
        title={t("fulfillment.features.shipments.ui.shipmentPackingPage.fulfillment.summary")}
        items={[
          {
            label: t("fulfillment.features.shipments.ui.shipmentPackingPage.status"),
            value: <Badge tone={statusTone(shipment.status)}>{statusLabel(shipment.status)}</Badge>,
          },
          {
            label: t("fulfillment.features.shipments.ui.shipmentPackingPage.buyer"),
            value: buyerLabel,
          },
          {
            label: t("fulfillment.features.shipments.ui.shipmentPackingPage.shipping.option"),
            value: shipment.shipping_option,
          },
          {
            label: t("fulfillment.features.shipments.ui.shipmentPackingPage.items"),
            value: itemCountLabel(shipment.total_quantity, shipment.line_count),
          },
        ]}
      />
      <AddressBlock
        title={t("fulfillment.features.shipments.ui.shipmentPackingPage.ship.to")}
        lines={destinationLines}
        copyValue={formatAddressForCopy(destinationLines)}
        copyLabel={t("fulfillment.features.shipments.ui.shipmentPackingPage.copy.address")}
      />
    </Stack>
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("fulfillment.features.shipments.ui.shipmentPackingPage.seller")}
        title={t("fulfillment.features.shipments.ui.shipmentPackingPage.title")}
        description={t("fulfillment.features.shipments.ui.shipmentPackingPage.description", {
          orderId: orderReference,
          buyer: buyerLabel,
        })}
        actions={
          <Stack gap={2}>
            <LinkButton href={backHref} tone="secondary" leadingIcon="chevronLeft">
              {t("fulfillment.features.shipments.ui.shipmentPackingPage.back")}
            </LinkButton>
            <LinkButton href={packingSlipHref} target="_blank" tone="secondary" leadingIcon="externalLink">
              {t("fulfillment.features.shipments.ui.shipmentPackingPage.print.packing.slip")}
            </LinkButton>
          </Stack>
        }
      />

      <PageStepper
        variant="compact"
        items={[
          {
            label: t("fulfillment.features.shipments.ui.shipmentPackingPage.step.review"),
            description: t("fulfillment.features.shipments.ui.shipmentPackingPage.step.review.description"),
            status: isAwaitingPackage ? "current" : "complete",
          },
          {
            label: t("fulfillment.features.shipments.ui.shipmentPackingPage.step.pack"),
            description: t("fulfillment.features.shipments.ui.shipmentPackingPage.step.pack.description"),
            status: isPacking ? "current" : isPackedOrLater ? "complete" : "upcoming",
          },
          {
            label: t("fulfillment.features.shipments.ui.shipmentPackingPage.step.finish"),
            description: t("fulfillment.features.shipments.ui.shipmentPackingPage.step.finish.description"),
            status: isPackedOrLater ? "complete" : "upcoming",
          },
        ]}
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="error"
          title={t("fulfillment.features.shipments.ui.shipmentPackingPage.error")}
          description={errorMessage}
        />
      ) : null}

      {isAwaitingPackage ? (
        <OperationalStatusBanner
          tone="info"
          title={t("fulfillment.features.shipments.ui.shipmentPackingPage.ready.title")}
          description={t("fulfillment.features.shipments.ui.shipmentPackingPage.ready.description")}
          action={
            <form method="post">
              <Button type="submit" name="intent" value="start-packing" leadingIcon="package">
                {t("fulfillment.features.shipments.ui.shipmentPackingPage.start.packing")}
              </Button>
            </form>
          }
        />
      ) : null}

      {isPacking ? (
        <OperationalStatusBanner
          tone="warning"
          title={t("fulfillment.features.shipments.ui.shipmentPackingPage.locked.title")}
          description={t("fulfillment.features.shipments.ui.shipmentPackingPage.locked.description", {
            timestamp: shipment.packing_started_at ?? shipment.updated_at,
          })}
        />
      ) : null}

      {isPackedOrLater ? (
        <OperationalStatusBanner
          tone="success"
          title={t("fulfillment.features.shipments.ui.shipmentPackingPage.packed.title")}
          description={t("fulfillment.features.shipments.ui.shipmentPackingPage.packed.description")}
          action={
            <LinkButton href={`/account/sales/shipments/${shipment.shipment_id}`} tone="primary" leadingIcon="truck">
              {t("fulfillment.features.shipments.ui.shipmentPackingPage.continue.to.label")}
            </LinkButton>
          }
        />
      ) : null}

      <WorkstationLayout
        secondaryTitle={t("fulfillment.features.shipments.ui.shipmentPackingPage.shipment.details")}
        secondaryDescription={itemCountLabel(shipment.total_quantity, shipment.line_count)}
        secondary={secondaryRail}
        primary={
          <Stack gap={3}>
            <ChecklistCard
              title={t("fulfillment.features.shipments.ui.shipmentPackingPage.item.checklist")}
              description={t("fulfillment.features.shipments.ui.shipmentPackingPage.item.checklist.description")}
              progress={
                isPacking || isPackedOrLater ? (
                  <TaskProgress
                    label={t("fulfillment.features.shipments.ui.shipmentPackingPage.progress", {
                      checked: isPackedOrLater ? lineCount : checkedCount,
                      total: lineCount,
                    })}
                    value={isPackedOrLater ? 100 : progressValue}
                    tone={allLinesChecked || isPackedOrLater ? "success" : "active"}
                  />
                ) : null
              }
            >
              {shipment.lines.map((line) => (
                <PackingLine
                  key={line.line_id}
                  line={line}
                  checked={checkedLineIds.has(line.line_id) || isPackedOrLater}
                  disabled={!isPacking}
                  saving={savingLineIds.has(line.line_id)}
                  onCheckedChange={persistLineConfirmation}
                />
              ))}
            </ChecklistCard>

            {isPacking ? (
              <>
                <form id="complete-packing-form" method="post" />
                <StickyTaskFooter
                  summary={t("fulfillment.features.shipments.ui.shipmentPackingPage.progress", {
                    checked: checkedCount,
                    total: lineCount,
                  })}
                  detail={
                    canCompletePacking
                      ? t("fulfillment.features.shipments.ui.shipmentPackingPage.complete.ready")
                      : hasSavingLines
                        ? t("fulfillment.features.shipments.ui.shipmentPackingPage.complete.saving")
                        : t("fulfillment.features.shipments.ui.shipmentPackingPage.complete.disabled")
                  }
                >
                  <NumberInput
                    label={t("fulfillment.features.shipments.ui.shipmentPackingPage.package.count")}
                    form="complete-packing-form"
                    name="packageCount"
                    required
                    min="1"
                    defaultValue={shipment.package_count ?? 1}
                  />
                  <Button
                    type="submit"
                    form="complete-packing-form"
                    name="intent"
                    value="complete-packing"
                    disabled={!canCompletePacking}
                    leadingIcon="check"
                  >
                    {t("fulfillment.features.shipments.ui.shipmentPackingPage.complete.packing")}
                  </Button>
                </StickyTaskFooter>
              </>
            ) : null}
          </Stack>
        }
      />

      <Text size="sm" tone="secondary">
        {t("fulfillment.features.shipments.ui.shipmentPackingPage.full.order.reference", {
          orderId: shipment.order_id,
        })}
      </Text>
    </Page>
  );
}
