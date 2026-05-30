import { useMemo, useState } from "react";
import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  DetailConfidenceModule,
  LinkButton,
  MarketplaceNotice,
  NumberInput,
  OrderProtectionModule,
  Page,
  PageHeader,
  PageSection,
  PageStepper,
  ProductOptions,
  Progress,
  Stack,
  Text,
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
  ].filter(Boolean);
}

function PackingLine({
  line,
  checked,
  disabled,
  onCheckedChange,
}: {
  line: FulfillmentShipmentLine;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (lineId: string, checked: boolean) => void;
}) {
  return (
    <Card>
      <Stack gap={3}>
        <Checkbox
          label={t("fulfillment.features.shipments.ui.shipmentPackingPage.line.checked", {
            title: line.item_title,
            quantity: line.quantity,
          })}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(state) => onCheckedChange(line.line_id, state === true)}
        />
        <Stack gap={1}>
          <Text weight="semibold">{line.item_title}</Text>
          {line.item_subtitle ? (
            <Text size="sm" tone="secondary">
              {line.item_subtitle}
            </Text>
          ) : null}
          <ProductOptions
            options={productOptionsFromSummary(
              line.product_summary ?? t("fulfillment.features.shipments.ui.shipmentPackingPage.standard"),
            )}
            variant="chips"
          />
          <Text size="sm" tone="secondary">
            {t("fulfillment.features.shipments.ui.shipmentPackingPage.quantity", { quantity: line.quantity })}
          </Text>
        </Stack>
      </Stack>
    </Card>
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
  const [checkedLineIds, setCheckedLineIds] = useState<ReadonlySet<string>>(() => new Set());
  const checkedCount = checkedLineIds.size;
  const lineCount = shipment.lines.length;
  const progressValue = lineCount > 0 ? Math.round((checkedCount / lineCount) * 100) : 0;
  const allLinesChecked = checkedCount === lineCount;
  const isPacking = shipment.status === "packing";
  const isAwaitingPackage = shipment.status === "awaiting-package";
  const isPackedOrLater = shipment.package_status === "packed" || shipment.status === "awaiting-label";
  const packingSlipHref = `/account/sales/shipments/packing-slips?shipmentIds=${encodeURIComponent(
    shipment.shipment_id,
  )}&format=letter`;
  const destinationLines = useMemo(() => addressLines(shipment.shipping_destination_snapshot), [shipment]);
  const buyerLabel = shipment.buyer_display_name ?? shipment.buyer_account_id;

  function toggleLine(lineId: string, checked: boolean) {
    setCheckedLineIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(lineId);
      } else {
        next.delete(lineId);
      }
      return next;
    });
  }

  return (
    <Page>
      <PageHeader
        eyebrow={t("fulfillment.features.shipments.ui.shipmentPackingPage.seller")}
        title={t("fulfillment.features.shipments.ui.shipmentPackingPage.title")}
        description={t("fulfillment.features.shipments.ui.shipmentPackingPage.description", {
          orderId: shipment.order_id,
          buyer: buyerLabel,
        })}
        actions={
          <Stack gap={2}>
            <LinkButton href={packingSlipHref} target="_blank" tone="secondary" leadingIcon="externalLink">
              {t("fulfillment.features.shipments.ui.shipmentPackingPage.print.packing.slip")}
            </LinkButton>
            <LinkButton href={backHref} tone="secondary" leadingIcon="chevronLeft">
              {t("fulfillment.features.shipments.ui.shipmentPackingPage.back")}
            </LinkButton>
          </Stack>
        }
      />

      <PageStepper
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
        <MarketplaceNotice
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

      {isPackedOrLater ? (
        <MarketplaceNotice
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

      <PageSection title={t("fulfillment.features.shipments.ui.shipmentPackingPage.shipment.summary")}>
        <DetailConfidenceModule
          title={t("fulfillment.features.shipments.ui.shipmentPackingPage.shipment.summary")}
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
              value: t("fulfillment.features.shipments.ui.shipmentPackingPage.item.count", {
                quantity: shipment.total_quantity,
                lines: shipment.line_count,
              }),
            },
          ]}
        />
      </PageSection>

      <PageSection title={t("fulfillment.features.shipments.ui.shipmentPackingPage.ship.to")}>
        <OrderProtectionModule
          title={t("fulfillment.features.shipments.ui.shipmentPackingPage.ship.to")}
          items={destinationLines.map((line) => ({
            title: line,
            description: t("fulfillment.features.shipments.ui.shipmentPackingPage.destination.line"),
          }))}
        />
      </PageSection>

      <PageSection
        title={t("fulfillment.features.shipments.ui.shipmentPackingPage.item.checklist")}
        description={t("fulfillment.features.shipments.ui.shipmentPackingPage.item.checklist.description")}
      >
        <Stack gap={3}>
          {isPacking ? (
            <Card>
              <Stack gap={3}>
                <Text weight="semibold">
                  {t("fulfillment.features.shipments.ui.shipmentPackingPage.progress", {
                    checked: checkedCount,
                    total: lineCount,
                  })}
                </Text>
                <Progress value={progressValue} />
              </Stack>
            </Card>
          ) : null}

          {shipment.lines.map((line) => (
            <PackingLine
              key={line.line_id}
              line={line}
              checked={checkedLineIds.has(line.line_id) || isPackedOrLater}
              disabled={!isPacking}
              onCheckedChange={toggleLine}
            />
          ))}
        </Stack>
      </PageSection>

      {isPacking ? (
        <PageSection title={t("fulfillment.features.shipments.ui.shipmentPackingPage.finish.title")}>
          <Card>
            <form method="post">
              <Stack gap={3}>
                <NumberInput
                  label={t("fulfillment.features.shipments.ui.shipmentPackingPage.package.count")}
                  name="packageCount"
                  required
                  min="1"
                  defaultValue={shipment.package_count ?? 1}
                />
                <Button
                  type="submit"
                  name="intent"
                  value="complete-packing"
                  disabled={!allLinesChecked}
                  leadingIcon="check"
                >
                  {t("fulfillment.features.shipments.ui.shipmentPackingPage.complete.packing")}
                </Button>
                {!allLinesChecked ? (
                  <Text size="sm" tone="secondary">
                    {t("fulfillment.features.shipments.ui.shipmentPackingPage.complete.disabled")}
                  </Text>
                ) : null}
              </Stack>
            </form>
          </Card>
        </PageSection>
      ) : null}
    </Page>
  );
}
