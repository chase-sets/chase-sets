import { useState } from "react";
import { t } from "@chase-sets/localization";
import {
  Form,
  Badge,
  Button,
  Card,
  Checkbox,
  LinkButton,
  MarketplaceEmptyState,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { FulfillmentShipmentListItem } from "./contracts";

function statusTone(status: string) {
  switch (status) {
    case "delivered":
      return "success";
    case "returned":
    case "exception":
      return "warning";
    case "dispatched":
    case "label-attached":
      return "accent";
    default:
      return "neutral";
  }
}

function shipmentTitle(shipment: FulfillmentShipmentListItem) {
  if (shipment.tracking_identifier) {
    return t("fulfillment.features.shipments.ui.shipmentListPage.tracking.title", {
      trackingIdentifier: shipment.tracking_identifier,
    });
  }

  return t("fulfillment.features.shipments.ui.shipmentListPage.shipment", {
    reference: shipment.display_reference,
  });
}

export function FulfillmentShipmentListPage({
  title,
  eyebrow,
  emptyTitle,
  emptyDescription,
  shipmentDetailBasePath,
  shipments,
  batchPrintActionPath,
  packingFlowBasePath,
}: {
  title: string;
  eyebrow: string;
  emptyTitle: string;
  emptyDescription: string;
  shipmentDetailBasePath: string;
  shipments: readonly FulfillmentShipmentListItem[];
  batchPrintActionPath?: string;
  packingFlowBasePath?: string;
}) {
  const [selectedShipmentIds, setSelectedShipmentIds] = useState<string[]>([]);
  const selectedShipmentIdSet = new Set(selectedShipmentIds);

  function toggleShipment(shipmentId: string, checked: boolean) {
    setSelectedShipmentIds((current) =>
      checked ? Array.from(new Set([...current, shipmentId])) : current.filter((id) => id !== shipmentId),
    );
  }

  return (
    <Page>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={t("fulfillment.features.shipments.ui.shipmentListPage.track.the.post.payment.shipping.workflow")}
      />

      <PageSection title={t("fulfillment.features.shipments.ui.shipmentListPage.shipments")}>
        <Form spacing="none" method="get" action={batchPrintActionPath} target="_blank">
          <Stack gap={3}>
            {batchPrintActionPath && shipments.length > 0 ? (
              <Card elevation="tinted" data-elevation-role="furniture">
                <Stack gap={3}>
                  <NativeSelect
                    label={t("fulfillment.features.shipments.ui.shipmentListPage.packing.slip.format")}
                    name="format"
                    defaultValue="letter"
                    items={[
                      { value: "letter", label: t("fulfillment.features.shipments.ui.shipmentListPage.letter") },
                      {
                        value: "thermal-4x6",
                        label: t("fulfillment.features.shipments.ui.shipmentListPage.thermal.4x6"),
                      },
                    ]}
                  />
                  <Text size="sm" tone="secondary">
                    {t("fulfillment.features.shipments.ui.shipmentListPage.selected.shipments", {
                      count: selectedShipmentIds.length,
                    })}
                  </Text>
                  <Button type="submit" disabled={selectedShipmentIds.length === 0}>
                    {t("fulfillment.features.shipments.ui.shipmentListPage.print.packing.slips")}
                  </Button>
                </Stack>
              </Card>
            ) : null}
            {shipments.length === 0 ? (
              <MarketplaceEmptyState title={emptyTitle} description={emptyDescription} />
            ) : (
              shipments.map((shipment) => (
                <Card key={shipment.shipment_id} elevation="elevated" data-elevation-role="entity">
                  <Stack gap={2}>
                    {batchPrintActionPath ? (
                      <Checkbox
                        label={t("fulfillment.features.shipments.ui.shipmentListPage.select.for.packing.slip")}
                        name="shipmentIds"
                        value={shipment.shipment_id}
                        checked={selectedShipmentIdSet.has(shipment.shipment_id)}
                        onCheckedChange={(checked) => toggleShipment(shipment.shipment_id, checked === true)}
                      />
                    ) : null}
                    <Stack gap={1}>
                      <Text weight="semibold">{shipmentTitle(shipment)}</Text>
                      <Badge tone={statusTone(shipment.status)}>{shipment.status}</Badge>
                    </Stack>
                    <Text size="sm" tone="secondary">
                      {t("fulfillment.features.shipments.ui.shipmentListPage.quantity")}
                      {shipment.total_quantity} {t("fulfillment.features.shipments.ui.shipmentListPage.across")}
                      {shipment.line_count} line
                      {shipment.line_count === 1 ? "" : "s"}
                    </Text>
                    {shipment.tracking_identifier ? null : (
                      <Text size="sm" tone="secondary">
                        {t("fulfillment.features.shipments.ui.shipmentListPage.tracking")}
                        {t("fulfillment.features.shipments.ui.shipmentListPage.not.attached.yet")}
                      </Text>
                    )}
                    <LinkButton href={`${shipmentDetailBasePath}/${shipment.shipment_id}`} tone="secondary">
                      {t("fulfillment.features.shipments.ui.shipmentListPage.open.shipment")}
                    </LinkButton>
                    {packingFlowBasePath && shipment.status === "awaiting-package" ? (
                      <Button
                        type="submit"
                        name="intent"
                        value="start-packing"
                        leadingIcon="package"
                        formAction={`${packingFlowBasePath}/${shipment.shipment_id}/packing`}
                        formMethod="post"
                        formTarget="_self"
                      >
                        {t("fulfillment.features.shipments.ui.shipmentListPage.start.packing")}
                      </Button>
                    ) : null}
                    {packingFlowBasePath && shipment.status === "packing" ? (
                      <LinkButton
                        href={`${packingFlowBasePath}/${shipment.shipment_id}/packing`}
                        tone="primary"
                        leadingIcon="package"
                      >
                        {t("fulfillment.features.shipments.ui.shipmentListPage.resume.packing")}
                      </LinkButton>
                    ) : null}
                  </Stack>
                </Card>
              ))
            )}
          </Stack>
        </Form>
      </PageSection>
    </Page>
  );
}
