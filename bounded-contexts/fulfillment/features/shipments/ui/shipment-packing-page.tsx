import { useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime, t } from "@chase-sets/localization";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import {
  Form,
  AddressBlock,
  Badge,
  Button,
  ChecklistCard,
  LinkButton,
  MarketplaceNotice,
  NumberInput,
  OperationalLockBanner,
  OperationalStatusBanner,
  Page,
  PageHeader,
  PageStepper,
  ProductOptions,
  QuantityChecklistControl,
  Stack,
  StickyTaskFooter,
  TaskLineItem,
  TaskProgress,
  TaskReference,
  TaskScanInput,
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
  return t("fulfillment.features.shipments.ui.shipmentPackingPage.item.count", {
    quantity,
    itemLabel:
      quantity === 1
        ? t("fulfillment.features.shipments.ui.shipmentPackingPage.item")
        : t("fulfillment.features.shipments.ui.shipmentPackingPage.items.label"),
    lines,
    lineLabel:
      lines === 1
        ? t("fulfillment.features.shipments.ui.shipmentPackingPage.line")
        : t("fulfillment.features.shipments.ui.shipmentPackingPage.lines"),
  });
}

function formatPackingTimestamp(value: string | null) {
  if (!value) {
    return t("fulfillment.features.shipments.ui.shipmentPackingPage.not.recorded");
  }

  return formatDateTime(value, { preset: "short" });
}

function packedQuantity(line: FulfillmentShipmentLine) {
  return line.packing_confirmed_quantity ?? (line.packing_confirmed_at ? line.quantity : 0);
}

function clampPackedQuantity(line: FulfillmentShipmentLine, quantity: number) {
  return Math.max(0, Math.min(line.quantity, quantity));
}

function initialPackedQuantities(lines: readonly FulfillmentShipmentLine[]) {
  return Object.fromEntries(lines.map((line) => [line.line_id, packedQuantity(line)]));
}

function scanValue(value: string) {
  return value.trim().toLowerCase();
}

function lineScanKeys(line: FulfillmentShipmentLine) {
  return [
    line.line_id,
    line.order_line_id,
    line.catalog_catalog_item_id,
    line.product_id,
    shortReference(line.line_id),
    shortReference(line.order_line_id),
    shortReference(line.product_id),
  ].map(scanValue);
}

function PackingLine({
  line,
  confirmedQuantity,
  disabled,
  saving,
  saved,
  error,
  matched,
  onQuantityChange,
}: {
  line: FulfillmentShipmentLine;
  confirmedQuantity: number;
  disabled: boolean;
  saving: boolean;
  saved: boolean;
  error?: string | null;
  matched: boolean;
  onQuantityChange: (lineId: string, confirmedQuantity: number) => void;
}) {
  const productOptions = productOptionsFromSummary(
    line.product_summary ?? t("fulfillment.features.shipments.ui.shipmentPackingPage.standard"),
  );
  const checked = confirmedQuantity >= line.quantity;
  const status = error ? "error" : saving ? "saving" : matched ? "matched" : saved ? "saved" : "idle";
  const statusLabel = error
    ? error
    : saving
      ? t("fulfillment.features.shipments.ui.shipmentPackingPage.line.saving")
      : matched
        ? t("fulfillment.features.shipments.ui.shipmentPackingPage.line.matched")
        : saved
          ? t("fulfillment.features.shipments.ui.shipmentPackingPage.line.saved")
          : null;

  return (
    <TaskLineItem
      title={line.item_title}
      subtitle={line.item_subtitle}
      quantity={line.quantity}
      quantityDetail={t("fulfillment.features.shipments.ui.shipmentPackingPage.line.quantity.detail", {
        packed: confirmedQuantity,
        total: line.quantity,
      })}
      quantityControl={
        line.quantity > 1 ? (
          <QuantityChecklistControl
            value={confirmedQuantity}
            total={line.quantity}
            decreaseLabel={t("fulfillment.features.shipments.ui.shipmentPackingPage.line.quantity.decrease", {
              title: line.item_title,
            })}
            increaseLabel={t("fulfillment.features.shipments.ui.shipmentPackingPage.line.quantity.increase", {
              title: line.item_title,
            })}
            disabled={disabled || saving}
            onChange={(nextQuantity) => onQuantityChange(line.line_id, nextQuantity)}
          />
        ) : null
      }
      checked={checked}
      disabled={disabled || saving}
      status={status}
      statusLabel={statusLabel}
      checkboxLabel={t("fulfillment.features.shipments.ui.shipmentPackingPage.line.checked", {
        title: line.item_title,
        quantity: line.quantity,
      })}
      onCheckedChange={(nextChecked) => onQuantityChange(line.line_id, nextChecked ? line.quantity : 0)}
      meta={<ProductOptions options={productOptions} variant="chips" />}
      reference={
        <>
          <TaskReference
            label={t("fulfillment.features.shipments.ui.shipmentPackingPage.line.reference.label")}
            value={line.line_id}
            displayValue={shortReference(line.line_id)}
            copyLabel={t("fulfillment.features.shipments.ui.shipmentPackingPage.copy.reference")}
          />
          <TaskReference
            label={t("fulfillment.features.shipments.ui.shipmentPackingPage.order.line.reference.label")}
            value={line.order_line_id}
            displayValue={shortReference(line.order_line_id)}
            copyLabel={t("fulfillment.features.shipments.ui.shipmentPackingPage.copy.reference")}
          />
          <TaskReference
            label={t("fulfillment.features.shipments.ui.shipmentPackingPage.product.reference.label")}
            value={line.product_id}
            displayValue={shortReference(line.product_id)}
            copyLabel={t("fulfillment.features.shipments.ui.shipmentPackingPage.copy.reference")}
          />
        </>
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
  const [packedQuantities, setPackedQuantities] = useState<Record<string, number>>(() =>
    initialPackedQuantities(shipment.lines),
  );
  const [savingLineIds, setSavingLineIds] = useState<ReadonlySet<string>>(() => new Set());
  const [savedLineIds, setSavedLineIds] = useState<ReadonlySet<string>>(() => new Set());
  const [lineErrors, setLineErrors] = useState<Record<string, string | null>>({});
  const [scanInput, setScanInput] = useState("");
  const [scanFeedback, setScanFeedback] = useState<{
    message: string;
    tone: "info" | "success" | "warning" | "danger";
  } | null>(null);
  const [matchedLineId, setMatchedLineId] = useState<string | null>(null);
  const [packingSlipOpened, setPackingSlipOpened] = useState(false);
  const lineRequestSequences = useRef<Record<string, number>>({});
  const checkedCount = shipment.lines.reduce((total, line) => total + (packedQuantities[line.line_id] ?? 0), 0);
  const totalQuantity = shipment.total_quantity;
  const progressValue = totalQuantity > 0 ? Math.round((checkedCount / totalQuantity) * 100) : 0;
  const allLinesChecked = shipment.lines.every((line) => (packedQuantities[line.line_id] ?? 0) >= line.quantity);
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
  const orderReference = deriveDisplayReferenceOrRaw(shipment.order_id as OrderId);

  useEffect(() => {
    setPackedQuantities(initialPackedQuantities(shipment.lines));
    setSavedLineIds(new Set());
    setLineErrors({});
  }, [shipment.lines]);

  async function persistLineQuantity(lineId: string, confirmedQuantity: number) {
    const line = shipment.lines.find((candidate) => candidate.line_id === lineId);
    if (!line) {
      return;
    }
    const nextQuantity = clampPackedQuantity(line, confirmedQuantity);
    const previousQuantity = packedQuantities[lineId] ?? 0;
    if (previousQuantity === nextQuantity) {
      return;
    }

    setPackedQuantities((current) => ({ ...current, [lineId]: nextQuantity }));
    setSavingLineIds((current) => new Set(current).add(lineId));
    setSavedLineIds((current) => {
      const next = new Set(current);
      next.delete(lineId);
      return next;
    });
    setLineErrors((current) => ({ ...current, [lineId]: null }));
    const requestSequence = (lineRequestSequences.current[lineId] ?? 0) + 1;
    lineRequestSequences.current[lineId] = requestSequence;

    const formData = new FormData();
    formData.set("intent", "set-line-confirmed");
    formData.set("lineId", lineId);
    formData.set("confirmedQuantity", String(nextQuantity));

    try {
      const response = await fetch(window.location.pathname, {
        method: "POST",
        credentials: "same-origin",
        body: formData,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? t("fulfillment.features.shipments.ui.shipmentPackingPage.line.save.failed"));
      }
      const result = (await response.json().catch(() => null)) as {
        lineId?: string;
        confirmedQuantity?: number;
      } | null;
      if (lineRequestSequences.current[lineId] !== requestSequence) {
        return;
      }
      if (result?.lineId !== lineId || typeof result.confirmedQuantity !== "number") {
        throw new Error(t("fulfillment.features.shipments.ui.shipmentPackingPage.line.save.failed"));
      }

      const serverQuantity = clampPackedQuantity(line, result.confirmedQuantity);
      setPackedQuantities((current) => ({ ...current, [lineId]: serverQuantity }));
      setSavedLineIds((current) => new Set(current).add(lineId));
    } catch (error) {
      if (lineRequestSequences.current[lineId] !== requestSequence) {
        return;
      }
      setPackedQuantities((current) => ({ ...current, [lineId]: previousQuantity }));
      setLineErrors((current) => ({
        ...current,
        [lineId]:
          error instanceof Error
            ? error.message
            : t("fulfillment.features.shipments.ui.shipmentPackingPage.line.save.failed"),
      }));
    } finally {
      if (lineRequestSequences.current[lineId] !== requestSequence) {
        return;
      }
      setSavingLineIds((current) => {
        const next = new Set(current);
        next.delete(lineId);
        return next;
      });
    }
  }

  function findScannedLine(rawValue: string) {
    const normalized = scanValue(rawValue);
    if (!normalized) {
      return null;
    }

    const exactMatches = shipment.lines.filter((line) => lineScanKeys(line).includes(normalized));
    if (exactMatches.length === 1) {
      return exactMatches[0];
    }
    if (exactMatches.length > 1) {
      return "ambiguous" as const;
    }

    const titleMatches = shipment.lines.filter((line) => scanValue(line.item_title).includes(normalized));
    if (titleMatches.length === 1) {
      return titleMatches[0];
    }
    if (titleMatches.length > 1) {
      return "ambiguous" as const;
    }

    return null;
  }

  function handleScanSubmit(value: string) {
    const match = findScannedLine(value);
    if (match === "ambiguous") {
      setScanFeedback({
        tone: "warning",
        message: t("fulfillment.features.shipments.ui.shipmentPackingPage.scan.ambiguous"),
      });
      return;
    }
    if (!match) {
      setScanFeedback({
        tone: "danger",
        message: t("fulfillment.features.shipments.ui.shipmentPackingPage.scan.no.match"),
      });
      return;
    }

    const currentQuantity = packedQuantities[match.line_id] ?? 0;
    if (currentQuantity >= match.quantity) {
      setMatchedLineId(match.line_id);
      setScanFeedback({
        tone: "warning",
        message: t("fulfillment.features.shipments.ui.shipmentPackingPage.scan.already.complete", {
          title: match.item_title,
        }),
      });
      setScanInput("");
      return;
    }

    setMatchedLineId(match.line_id);
    setScanFeedback({
      tone: "success",
      message: t("fulfillment.features.shipments.ui.shipmentPackingPage.scan.matched", {
        title: match.item_title,
      }),
    });
    setScanInput("");
    void persistLineQuantity(match.line_id, currentQuantity + 1);
  }

  const secondaryRail = (
    <Stack gap={3}>
      <TaskSummary
        title={t("fulfillment.features.shipments.ui.shipmentPackingPage.fulfillment.summary")}
        items={[
          {
            label: t("fulfillment.features.shipments.ui.shipmentPackingPage.shipment.reference.label"),
            value: shipment.display_reference,
          },
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
      <Stack gap={2}>
        <LinkButton
          href={packingSlipHref}
          target="_blank"
          tone="secondary"
          leadingIcon="externalLink"
          onClick={() => setPackingSlipOpened(true)}
        >
          {packingSlipOpened
            ? t("fulfillment.features.shipments.ui.shipmentPackingPage.print.packing.slip.again")
            : t("fulfillment.features.shipments.ui.shipmentPackingPage.print.packing.slip")}
        </LinkButton>
        <Text size="sm" tone="secondary">
          {packingSlipOpened
            ? t("fulfillment.features.shipments.ui.shipmentPackingPage.packing.slip.opened")
            : t("fulfillment.features.shipments.ui.shipmentPackingPage.packing.slip.ready")}
        </Text>
      </Stack>
    </Stack>
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("fulfillment.features.shipments.ui.shipmentPackingPage.seller")}
        title={t("fulfillment.features.shipments.ui.shipmentPackingPage.title")}
        description={t("fulfillment.features.shipments.ui.shipmentPackingPage.description", {
          orderReference,
          buyer: buyerLabel,
        })}
        actions={
          <Stack gap={2}>
            <LinkButton href={backHref} tone="secondary" leadingIcon="chevronLeft">
              {t("fulfillment.features.shipments.ui.shipmentPackingPage.back")}
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
          tone="danger"
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
            <Form spacing="none" method="post">
              <Button type="submit" name="intent" value="start-packing" leadingIcon="package">
                {t("fulfillment.features.shipments.ui.shipmentPackingPage.start.packing")}
              </Button>
            </Form>
          }
        />
      ) : null}

      {isPacking ? (
        <OperationalLockBanner
          title={t("fulfillment.features.shipments.ui.shipmentPackingPage.locked.title")}
          description={t("fulfillment.features.shipments.ui.shipmentPackingPage.locked.description", {
            timestamp: formatPackingTimestamp(shipment.packing_started_at ?? shipment.updated_at),
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
                      checked: isPackedOrLater ? totalQuantity : checkedCount,
                      total: totalQuantity,
                    })}
                    valueLabel={t("fulfillment.features.shipments.ui.shipmentPackingPage.progress.percent", {
                      percent: isPackedOrLater ? 100 : progressValue,
                    })}
                    value={isPackedOrLater ? 100 : progressValue}
                    tone={allLinesChecked || isPackedOrLater ? "success" : "accent"}
                  />
                ) : null
              }
            >
              {isPacking ? (
                <TaskScanInput
                  label={t("fulfillment.features.shipments.ui.shipmentPackingPage.scan.label")}
                  description={t("fulfillment.features.shipments.ui.shipmentPackingPage.scan.description")}
                  value={scanInput}
                  placeholder={t("fulfillment.features.shipments.ui.shipmentPackingPage.scan.placeholder")}
                  buttonLabel={t("fulfillment.features.shipments.ui.shipmentPackingPage.scan.confirm")}
                  feedback={scanFeedback?.message}
                  feedbackTone={scanFeedback?.tone}
                  disabled={hasSavingLines}
                  onValueChange={setScanInput}
                  onSubmit={handleScanSubmit}
                />
              ) : null}
              {shipment.lines.map((line) => (
                <PackingLine
                  key={line.line_id}
                  line={line}
                  confirmedQuantity={isPackedOrLater ? line.quantity : (packedQuantities[line.line_id] ?? 0)}
                  disabled={!isPacking}
                  saving={savingLineIds.has(line.line_id)}
                  saved={savedLineIds.has(line.line_id)}
                  error={lineErrors[line.line_id]}
                  matched={matchedLineId === line.line_id}
                  onQuantityChange={persistLineQuantity}
                />
              ))}
            </ChecklistCard>

            {isPacking ? (
              <>
                <Form spacing="none" id="complete-packing-form" method="post" />
                <StickyTaskFooter
                  mobileOffset="in-flow"
                  summary={t("fulfillment.features.shipments.ui.shipmentPackingPage.progress", {
                    checked: checkedCount,
                    total: totalQuantity,
                  })}
                  detail={
                    canCompletePacking
                      ? t("fulfillment.features.shipments.ui.shipmentPackingPage.complete.ready")
                      : hasSavingLines
                        ? t("fulfillment.features.shipments.ui.shipmentPackingPage.complete.saving")
                        : t("fulfillment.features.shipments.ui.shipmentPackingPage.complete.disabled")
                  }
                >
                  <LinkButton
                    href={packingSlipHref}
                    target="_blank"
                    tone="secondary"
                    leadingIcon="externalLink"
                    onClick={() => setPackingSlipOpened(true)}
                  >
                    {t("fulfillment.features.shipments.ui.shipmentPackingPage.print.packing.slip")}
                  </LinkButton>
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
    </Page>
  );
}
