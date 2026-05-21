import { t } from "@chase-sets/localization";
import {
  Button,
  OrderProtectionModule,
  Card,
  DetailConfidenceModule,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
  MarketplaceStatusTimeline,
  NativeSelect,
  NumberInput,
  Page,
  PageHeader,
  PageSection,
  ProductOptions,
  Stack,
  Text,
  TextInput,
  Textarea,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { FulfillmentShipmentDetail } from "./contracts";

function canRaiseException(status: string) {
  return status !== "delivered" && status !== "returned";
}

const uspsServiceLevels = [
  {
    value: "USPS_GROUND_ADVANTAGE",
    label: t("fulfillment.features.shipments.ui.shipmentDetailPage.usps.ground.advantage"),
  },
  { value: "PRIORITY", label: t("fulfillment.features.shipments.ui.shipmentDetailPage.usps.priority.mail") },
  {
    value: "PRIORITY_EXPRESS",
    label: t("fulfillment.features.shipments.ui.shipmentDetailPage.usps.priority.mail.express"),
  },
  { value: "MEDIA_MAIL", label: t("fulfillment.features.shipments.ui.shipmentDetailPage.usps.media.mail") },
];

function AddressFields({
  prefix,
  address,
  labelPrefix,
}: {
  prefix: "sender" | "recipient";
  address: NonNullable<FulfillmentShipmentDetail["shipping_origin_snapshot"]>;
  labelPrefix: "sender" | "recipient";
}) {
  return (
    <>
      <TextInput
        label={t(`fulfillment.features.shipments.ui.shipmentDetailPage.${labelPrefix}.name`)}
        name={`${prefix}Name`}
        required
        defaultValue={address.name}
      />
      <TextInput
        label={t(`fulfillment.features.shipments.ui.shipmentDetailPage.${labelPrefix}.company`)}
        name={`${prefix}Company`}
        defaultValue={address.company ?? ""}
      />
      <TextInput
        label={t(`fulfillment.features.shipments.ui.shipmentDetailPage.${labelPrefix}.street`)}
        name={`${prefix}Street1`}
        required
        defaultValue={address.line1}
      />
      <TextInput
        label={t(`fulfillment.features.shipments.ui.shipmentDetailPage.${labelPrefix}.street.2`)}
        name={`${prefix}Street2`}
        defaultValue={address.line2 ?? ""}
      />
      <TextInput
        label={t(`fulfillment.features.shipments.ui.shipmentDetailPage.${labelPrefix}.city`)}
        name={`${prefix}City`}
        required
        defaultValue={address.city}
      />
      <TextInput
        label={t(`fulfillment.features.shipments.ui.shipmentDetailPage.${labelPrefix}.state`)}
        name={`${prefix}State`}
        required
        defaultValue={address.state}
      />
      <TextInput
        label={t(`fulfillment.features.shipments.ui.shipmentDetailPage.${labelPrefix}.zip`)}
        name={`${prefix}PostalCode`}
        required
        defaultValue={address.postalCode}
      />
      <TextInput
        label={t(`fulfillment.features.shipments.ui.shipmentDetailPage.${labelPrefix}.country`)}
        name={`${prefix}Country`}
        required
        defaultValue={address.country}
      />
      <TextInput
        label={t(`fulfillment.features.shipments.ui.shipmentDetailPage.${labelPrefix}.phone`)}
        name={`${prefix}Phone`}
        defaultValue={address.phone ?? ""}
      />
      <TextInput
        label={t(`fulfillment.features.shipments.ui.shipmentDetailPage.${labelPrefix}.email`)}
        name={`${prefix}Email`}
        type="email"
        defaultValue={address.email ?? ""}
      />
    </>
  );
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
      ? (shipment.seller_display_name ?? shipment.seller_account_id)
      : (shipment.buyer_display_name ?? shipment.buyer_account_id);
  const recipientSnapshot = shipment.shipping_destination_snapshot;
  const senderSnapshot = shipment.shipping_origin_snapshot;
  const packingSlipHref = `/account/sales/shipments/packing-slips?shipmentIds=${encodeURIComponent(shipment.shipment_id)}&format=letter`;

  return (
    <Page>
      <PageHeader
        eyebrow={
          role === "buyer"
            ? t("fulfillment.features.shipments.ui.shipmentDetailPage.buyer")
            : t("fulfillment.features.shipments.ui.shipmentDetailPage.seller")
        }
        title={t("fulfillment.features.shipments.ui.shipmentDetailPage.shipment")}
        description={t("fulfillment.features.shipments.ui.shipmentDetailPage.order.with.counterpart", {
          orderId: shipment.order_id,
          counterpart: counterpartLabel,
        })}
        actions={
          <Stack gap={2}>
            {role === "seller" ? (
              <LinkButton href={packingSlipHref} tone="primary" target="_blank">
                {t("fulfillment.features.shipments.ui.shipmentDetailPage.print.packing.slip")}
              </LinkButton>
            ) : null}
            <LinkButton href={backHref} tone="secondary">
              {t("fulfillment.features.shipments.ui.shipmentDetailPage.back")}
            </LinkButton>
          </Stack>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="error"
          title={t("fulfillment.features.shipments.ui.shipmentDetailPage.summary")}
          description={errorMessage}
        />
      ) : null}

      <PageSection title={t("fulfillment.features.shipments.ui.shipmentDetailPage.summary")}>
        <Stack gap={4}>
          <MarketplaceStatusTimeline
            steps={[
              {
                label: shipment.status,
                description:
                  t("fulfillment.features.shipments.ui.shipmentDetailPage.package.state") + shipment.package_status,
                status:
                  shipment.status === "delivered" ? "complete" : shipment.status === "exception" ? "issue" : "current",
              },
              {
                label: t("fulfillment.features.shipments.ui.shipmentDetailPage.tracking"),
                description:
                  shipment.tracking_identifier ??
                  t("fulfillment.features.shipments.ui.shipmentDetailPage.not.attached.yet"),
                status: shipment.tracking_identifier ? "complete" : "upcoming",
              },
              {
                label: t("fulfillment.features.shipments.ui.shipmentDetailPage.carrier"),
                description:
                  shipment.carrier_name ?? t("fulfillment.features.shipments.ui.shipmentDetailPage.not.selected.yet.3"),
                status: shipment.carrier_name ? "complete" : "upcoming",
              },
            ]}
          />

          <DetailConfidenceModule
            title={t("fulfillment.features.shipments.ui.shipmentDetailPage.summary")}
            items={[
              {
                label: t("fulfillment.features.shipments.ui.shipmentDetailPage.shipping.option"),
                value: shipment.shipping_option,
              },
              {
                label: t("fulfillment.features.shipments.ui.shipmentDetailPage.shipping.method"),
                value:
                  shipment.shipping_method ??
                  t("fulfillment.features.shipments.ui.shipmentDetailPage.not.selected.yet"),
              },
              {
                label: t("fulfillment.features.shipments.ui.shipmentDetailPage.service.level"),
                value:
                  shipment.postage_service_level ??
                  t("fulfillment.features.shipments.ui.shipmentDetailPage.not.selected.yet.2"),
              },
              {
                label: t("fulfillment.features.shipments.ui.shipmentDetailPage.label.status"),
                value: shipment.label_status,
              },
              {
                label: t("fulfillment.features.shipments.ui.shipmentDetailPage.postage.provider"),
                value:
                  shipment.postage_provider_name ??
                  t("fulfillment.features.shipments.ui.shipmentDetailPage.not.selected.yet.4"),
              },
              {
                label: t("fulfillment.features.shipments.ui.shipmentDetailPage.package.count"),
                value:
                  shipment.package_count ?? t("fulfillment.features.shipments.ui.shipmentDetailPage.not.recorded.yet"),
              },
            ]}
          />

          <OrderProtectionModule
            title={t("fulfillment.features.shipments.ui.shipmentDetailPage.summary")}
            items={[
              {
                title: t("fulfillment.features.shipments.ui.shipmentDetailPage.tracking"),
                description:
                  shipment.tracking_identifier ??
                  t("fulfillment.features.shipments.ui.shipmentDetailPage.not.attached.yet"),
              },
              {
                title: t("fulfillment.features.shipments.ui.shipmentDetailPage.label.status"),
                description: shipment.label_status,
              },
              {
                title: t("fulfillment.features.shipments.ui.shipmentDetailPage.postage"),
                description:
                  shipment.postage_amount_cents != null
                    ? `${(shipment.postage_amount_cents / 100).toFixed(2)} ${shipment.postage_currency ?? "USD"}`
                    : t("fulfillment.features.shipments.ui.shipmentDetailPage.not.selected.yet.4"),
              },
            ]}
          />

          {shipment.label_document_url ? (
            <LinkButton href={shipment.label_document_url} tone="secondary">
              {t("fulfillment.features.shipments.ui.shipmentDetailPage.open.label.pdf")}
            </LinkButton>
          ) : null}
          {shipment.label_error_message ? (
            <MarketplaceNotice
              tone="warning"
              title={t("fulfillment.features.shipments.ui.shipmentDetailPage.label.status")}
              description={shipment.label_error_message}
            />
          ) : null}
          {shipment.label_refund_status ? (
            <MarketplaceNotice
              tone="info"
              title={t("fulfillment.features.shipments.ui.shipmentDetailPage.refund")}
              description={`${shipment.label_refund_status}${
                shipment.label_refund_reference
                  ? t("fulfillment.features.shipments.ui.shipmentDetailPage.refund.reference", {
                      reference: shipment.label_refund_reference,
                    })
                  : ""
              }`}
            />
          ) : null}
        </Stack>
      </PageSection>

      <PageSection title={t("fulfillment.features.shipments.ui.shipmentDetailPage.lines")}>
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
                <ProductOptions
                  options={productOptionsFromSummary(
                    line.product_summary ?? t("fulfillment.features.shipments.ui.shipmentDetailPage.standard"),
                  )}
                  variant="chips"
                />
                <Text>
                  {t("fulfillment.features.shipments.ui.shipmentDetailPage.quantity")}
                  {line.quantity}
                </Text>
              </Stack>
            </Card>
          ))}
        </Stack>
      </PageSection>

      <PageSection title={t("fulfillment.features.shipments.ui.shipmentDetailPage.exceptions")}>
        <Stack gap={3}>
          {shipment.exceptions.length === 0 ? (
            <MarketplaceEmptyState
              title={t("fulfillment.features.shipments.ui.shipmentDetailPage.no.shipment.exceptions.recorded")}
              description={t("fulfillment.features.shipments.ui.shipmentDetailPage.no.shipment.exceptions.recorded")}
            />
          ) : (
            shipment.exceptions.map((exception) => (
              <Card key={`${exception.exception_type}-${exception.raised_at}`}>
                <Stack gap={1}>
                  <Text weight="semibold">{exception.exception_type}</Text>
                  <Text size="sm" tone="secondary">
                    {t("fulfillment.features.shipments.ui.shipmentDetailPage.raised.at")}
                    {exception.raised_at}
                  </Text>
                  {exception.notes ? <Text>{exception.notes}</Text> : null}
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      </PageSection>

      {role === "seller" ? (
        <PageSection title={t("fulfillment.features.shipments.ui.shipmentDetailPage.actions")}>
          <Stack gap={3}>
            {shipment.status === "awaiting-package" ? (
              <Card>
                <form method="post">
                  <Stack gap={3}>
                    <NumberInput
                      label={t("fulfillment.features.shipments.ui.shipmentDetailPage.package.count.2")}
                      name="packageCount"
                      required
                      min="1"
                      defaultValue={shipment.package_count ?? 1}
                    />
                    <Button type="submit" name="intent" value="prepare-package">
                      {t("fulfillment.features.shipments.ui.shipmentDetailPage.mark.package.ready")}
                    </Button>
                  </Stack>
                </form>
              </Card>
            ) : null}

            {shipment.status === "awaiting-label" ? (
              <Card>
                <form method="post">
                  <Stack gap={3}>
                    <NativeSelect
                      label={t("fulfillment.features.shipments.ui.shipmentDetailPage.usps.service")}
                      name="serviceLevel"
                      required
                      defaultValue={shipment.postage_service_level ?? "USPS_GROUND_ADVANTAGE"}
                      items={uspsServiceLevels}
                    />
                    {senderSnapshot ? (
                      <AddressFields prefix="sender" address={senderSnapshot} labelPrefix="sender" />
                    ) : null}
                    <AddressFields prefix="recipient" address={recipientSnapshot} labelPrefix="recipient" />
                    <Textarea
                      label={t("fulfillment.features.shipments.ui.shipmentDetailPage.override.reason")}
                      name="overrideReason"
                      rows={3}
                    />
                    <NumberInput
                      label={t("fulfillment.features.shipments.ui.shipmentDetailPage.length.in")}
                      name="packageLengthInches"
                      min="0.1"
                      step="0.1"
                      required
                      defaultValue="7"
                    />
                    <NumberInput
                      label={t("fulfillment.features.shipments.ui.shipmentDetailPage.width.in")}
                      name="packageWidthInches"
                      min="0.1"
                      step="0.1"
                      required
                      defaultValue="5"
                    />
                    <NumberInput
                      label={t("fulfillment.features.shipments.ui.shipmentDetailPage.height.in")}
                      name="packageHeightInches"
                      min="0.1"
                      step="0.1"
                      required
                      defaultValue="1"
                    />
                    <NumberInput
                      label={t("fulfillment.features.shipments.ui.shipmentDetailPage.weight.oz")}
                      name="packageWeightOunces"
                      min="0.1"
                      step="0.1"
                      required
                      defaultValue="4"
                    />
                    <Button type="submit" name="intent" value="purchase-label">
                      {t("fulfillment.features.shipments.ui.shipmentDetailPage.purchase.usps.label")}
                    </Button>
                  </Stack>
                </form>
              </Card>
            ) : null}

            {shipment.status === "label-attached" ? (
              <Card>
                <form method="post">
                  <Stack gap={3}>
                    <Button type="submit" name="intent" value="dispatch-shipment">
                      {t("fulfillment.features.shipments.ui.shipmentDetailPage.mark.dispatched")}
                    </Button>
                    <TextInput
                      label={t("fulfillment.features.shipments.ui.shipmentDetailPage.tracking.identifier")}
                      name="trackingIdentifier"
                      readOnly
                      defaultValue={shipment.tracking_identifier ?? ""}
                    />
                    <Button type="submit" name="intent" value="void-label" tone="secondary">
                      {t("fulfillment.features.shipments.ui.shipmentDetailPage.void.label")}
                    </Button>
                  </Stack>
                </form>
              </Card>
            ) : null}

            {shipment.status === "dispatched" || shipment.status === "exception" ? (
              <Card>
                <Stack gap={3}>
                  <form method="post">
                    <Button type="submit" name="intent" value="deliver-shipment">
                      {t("fulfillment.features.shipments.ui.shipmentDetailPage.mark.delivered")}
                    </Button>
                  </form>
                  <form method="post">
                    <Stack gap={3}>
                      <Textarea
                        label={t("fulfillment.features.shipments.ui.shipmentDetailPage.return.notes")}
                        name="reason"
                        rows={3}
                        defaultValue=""
                      />
                      <Button type="submit" name="intent" value="return-shipment" tone="secondary">
                        {t("fulfillment.features.shipments.ui.shipmentDetailPage.mark.returned")}
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
                      label={t("fulfillment.features.shipments.ui.shipmentDetailPage.exception.type")}
                      name="exceptionType"
                      required
                      defaultValue={shipment.current_exception_type ?? "carrier-delay"}
                    />
                    <Textarea
                      label={t("fulfillment.features.shipments.ui.shipmentDetailPage.notes")}
                      name="notes"
                      rows={3}
                      defaultValue={shipment.current_exception_notes ?? ""}
                    />
                    <Button type="submit" name="intent" value="raise-exception" tone="secondary">
                      {t("fulfillment.features.shipments.ui.shipmentDetailPage.raise.exception")}
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
