import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
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

export function FulfillmentShipmentListPage({
  title,
  eyebrow,
  emptyTitle,
  emptyDescription,
  shipmentDetailBasePath,
  shipments,
}: {
  title: string;
  eyebrow: string;
  emptyTitle: string;
  emptyDescription: string;
  shipmentDetailBasePath: string;
  shipments: readonly FulfillmentShipmentListItem[];
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description="Track the post-payment shipping workflow from package prep through delivery or exception handling."
      />

      <PageSection title="Shipments">
        <Stack gap={3}>
          {shipments.length === 0 ? (
            <EmptyState
              title={emptyTitle}
              description={emptyDescription}
              icon="package"
            />
          ) : (
            shipments.map((shipment) => (
              <Card key={shipment.shipment_id}>
                <Stack gap={2}>
                  <Stack gap={1}>
                    <Text weight="semibold">Shipment {shipment.shipment_id}</Text>
                    <Badge tone={statusTone(shipment.status)}>{shipment.status}</Badge>
                  </Stack>
                  <Text size="sm" tone="secondary">
                    Order {shipment.order_id}
                  </Text>
                  <Text size="sm" tone="secondary">
                    Quantity: {shipment.total_quantity} across {shipment.line_count} line
                    {shipment.line_count === 1 ? "" : "s"}
                  </Text>
                  <Text size="sm" tone="secondary">
                    Tracking: {shipment.tracking_identifier ?? "Not attached yet"}
                  </Text>
                  <LinkButton
                    href={`${shipmentDetailBasePath}/${shipment.shipment_id}`}
                    tone="secondary"
                  >
                    Open shipment
                  </LinkButton>
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
