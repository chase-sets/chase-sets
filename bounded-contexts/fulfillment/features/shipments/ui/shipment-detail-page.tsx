import {
  Badge,
  Button,
  Card,
  LinkButton,
  NumberInput,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@chase-sets/design-system";
import type { FulfillmentShipmentDetail } from "./contracts";

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

function canRaiseException(status: string) {
  return status !== "delivered" && status !== "returned";
}

export function FulfillmentShipmentDetailPage({
  role,
  backHref,
  shipment,
  errorMessage,
}: {
  role: "buyer" | "seller";
  backHref: string;
  shipment: FulfillmentShipmentDetail;
  errorMessage?: string | null;
}) {
  const counterpartLabel =
    role === "buyer"
      ? shipment.seller_display_name ?? shipment.seller_account_id
      : shipment.buyer_display_name ?? shipment.buyer_account_id;

  return (
    <Page>
      <PageHeader
        eyebrow={role === "buyer" ? "Buyer" : "Seller"}
        title={`Shipment ${shipment.shipment_id}`}
        description={`Order ${shipment.order_id} with ${counterpartLabel}`}
        actions={
          <LinkButton href={backHref} tone="secondary">
            Back
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Summary">
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(shipment.status)}>{shipment.status}</Badge>
            <Text>Shipping option: {shipment.shipping_option}</Text>
            <Text>Shipping method: {shipment.shipping_method ?? "Not selected yet"}</Text>
            <Text>Carrier: {shipment.carrier_name ?? "Not selected yet"}</Text>
            <Text>Tracking: {shipment.tracking_identifier ?? "Not attached yet"}</Text>
            <Text>Package state: {shipment.package_status}</Text>
            <Text>Package count: {shipment.package_count ?? "Not recorded yet"}</Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Lines">
        <Stack gap={3}>
          {shipment.lines.map((line) => (
            <Card key={line.line_id}>
              <Stack gap={1}>
                <Text weight="semibold">{line.item_title}</Text>
                {line.item_subtitle ? (
                  <Text size="sm" tone="secondary">
                    {line.item_subtitle}
                  </Text>
                ) : null}
                <Text size="sm" tone="secondary">
                  {line.product_summary ?? "Standard"}
                </Text>
                <Text>Quantity: {line.quantity}</Text>
              </Stack>
            </Card>
          ))}
        </Stack>
      </PageSection>

      <PageSection title="Exceptions">
        <Stack gap={3}>
          {shipment.exceptions.length === 0 ? (
            <Card>
              <Text tone="secondary">No shipment exceptions recorded.</Text>
            </Card>
          ) : (
            shipment.exceptions.map((exception) => (
              <Card key={`${exception.exception_type}-${exception.raised_at}`}>
                <Stack gap={1}>
                  <Text weight="semibold">{exception.exception_type}</Text>
                  <Text size="sm" tone="secondary">
                    Raised at {exception.raised_at}
                  </Text>
                  {exception.notes ? <Text>{exception.notes}</Text> : null}
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      </PageSection>

      {role === "seller" ? (
        <PageSection title="Actions">
          <Stack gap={3}>
            {shipment.status === "awaiting-package" ? (
              <Card>
                <form method="post">
                  <Stack gap={3}>
                    <NumberInput
                      label="Package count"
                      name="packageCount"
                      required
                      min="1"
                      defaultValue={shipment.package_count ?? 1}
                    />
                    <Button type="submit" name="intent" value="prepare-package">
                      Mark package ready
                    </Button>
                  </Stack>
                </form>
              </Card>
            ) : null}

            {shipment.status === "awaiting-label" ? (
              <Card>
                <form method="post">
                  <Stack gap={3}>
                    <TextInput
                      label="Shipping method"
                      name="shippingMethod"
                      required
                      defaultValue={shipment.shipping_method ?? "standard"}
                    />
                    <TextInput
                      label="Carrier"
                      name="carrierName"
                      required
                      defaultValue={shipment.carrier_name ?? "USPS"}
                    />
                    <TextInput
                      label="Label reference"
                      name="labelReference"
                      required
                      defaultValue={shipment.label_reference ?? ""}
                    />
                    <TextInput
                      label="Tracking identifier"
                      name="trackingIdentifier"
                      required
                      defaultValue={shipment.tracking_identifier ?? ""}
                    />
                    <Button type="submit" name="intent" value="attach-label">
                      Attach label
                    </Button>
                  </Stack>
                </form>
              </Card>
            ) : null}

            {shipment.status === "label-attached" ? (
              <Card>
                <form method="post">
                  <Button type="submit" name="intent" value="dispatch-shipment">
                    Mark dispatched
                  </Button>
                </form>
              </Card>
            ) : null}

            {(shipment.status === "dispatched" || shipment.status === "exception") ? (
              <Card>
                <Stack gap={3}>
                  <form method="post">
                    <Button type="submit" name="intent" value="deliver-shipment">
                      Mark delivered
                    </Button>
                  </form>
                  <form method="post">
                    <Stack gap={3}>
                      <Textarea
                        label="Return notes"
                        name="reason"
                        rows={3}
                        defaultValue=""
                      />
                      <Button type="submit" name="intent" value="return-shipment" tone="secondary">
                        Mark returned
                      </Button>
                    </Stack>
                  </form>
                </Stack>
              </Card>
            ) : null}

            {canRaiseException(shipment.status) ? (
              <Card>
                <form method="post">
                  <Stack gap={3}>
                    <TextInput
                      label="Exception type"
                      name="exceptionType"
                      required
                      defaultValue={shipment.current_exception_type ?? "carrier-delay"}
                    />
                    <Textarea
                      label="Notes"
                      name="notes"
                      rows={3}
                      defaultValue={shipment.current_exception_notes ?? ""}
                    />
                    <Button type="submit" name="intent" value="raise-exception" tone="secondary">
                      Raise exception
                    </Button>
                  </Stack>
                </form>
              </Card>
            ) : null}
          </Stack>
        </PageSection>
      ) : null}
    </Page>
  );
}
