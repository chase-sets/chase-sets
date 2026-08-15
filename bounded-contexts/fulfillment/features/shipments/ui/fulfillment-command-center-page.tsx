import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  Form,
  HiddenInput,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  ProgressiveDisclosure,
  Stack,
  Text,
  Textarea,
} from "@chase-sets/design-system";
import type {
  FulfillmentCommandCenter,
  FulfillmentCommandCenterBucketId,
  FulfillmentCommandCenterItem,
} from "../read-model/command-center";
import type { ShipmentActionName } from "../domain/shipment-action";

function statusTone(status: string) {
  switch (status) {
    case "exception":
      return "warning";
    case "label-attached":
      return "accent";
    case "awaiting-label":
      return "info";
    default:
      return "neutral";
  }
}

function bucketTitle(bucket: FulfillmentCommandCenterBucketId) {
  switch (bucket) {
    case "exceptions":
      return t("fulfillment.features.shipments.ui.commandCenter.bucket.exceptions");
    case "ready-to-dispatch":
      return t("fulfillment.features.shipments.ui.commandCenter.bucket.readyToDispatch");
    case "needs-label":
      return t("fulfillment.features.shipments.ui.commandCenter.bucket.needsLabel");
    case "needs-packing":
      return t("fulfillment.features.shipments.ui.commandCenter.bucket.needsPacking");
  }
}

function actionLabel(action: ShipmentActionName) {
  switch (action) {
    case "start-packing":
      return t("fulfillment.features.shipments.ui.commandCenter.action.startPacking");
    case "complete-packing":
      return t("fulfillment.features.shipments.ui.commandCenter.action.completePacking");
    case "buy-label":
      return t("fulfillment.features.shipments.ui.commandCenter.action.buyLabel");
    case "void-label":
      return t("fulfillment.features.shipments.ui.commandCenter.action.voidLabel");
    case "dispatch":
      return t("fulfillment.features.shipments.ui.commandCenter.action.dispatch");
    case "record-delivery":
      return t("fulfillment.features.shipments.ui.commandCenter.action.recordDelivery");
    case "return":
      return t("fulfillment.features.shipments.ui.commandCenter.action.return");
    case "raise-exception":
      return t("fulfillment.features.shipments.ui.commandCenter.action.raiseException");
  }
}

function itemTitle(item: FulfillmentCommandCenterItem) {
  if (item.trackingIdentifier) {
    return t("fulfillment.features.shipments.ui.commandCenter.tracking.title", {
      trackingIdentifier: item.trackingIdentifier,
    });
  }
  return t("fulfillment.features.shipments.ui.commandCenter.shipment", { reference: item.displayReference });
}

function HiddenState({ item }: { item: FulfillmentCommandCenterItem }) {
  return (
    <>
      <HiddenInput type="hidden" name="shipmentId" value={item.shipmentId} readOnly />
      <HiddenInput type="hidden" name="status" value={item.status} readOnly />
      <HiddenInput type="hidden" name="labelStatus" value={item.labelStatus} readOnly />
    </>
  );
}

// A single disclosed action rendered as its own inline form so it resolves in place over
// the command center — never a route change.
function DisclosedAction({
  item,
  action,
  actionBasePath,
}: {
  item: FulfillmentCommandCenterItem;
  action: ShipmentActionName;
  actionBasePath: string;
}) {
  if (action === "raise-exception") {
    return (
      <Form method="post" action={actionBasePath} spacing="sm">
        <HiddenState item={item} />
        <Stack gap={2}>
          <NativeSelect
            label={t("fulfillment.features.shipments.ui.commandCenter.exception.type")}
            name="exceptionType"
            defaultValue="carrier-delay"
            items={[
              {
                value: "carrier-delay",
                label: t("fulfillment.features.shipments.ui.commandCenter.exception.carrierDelay"),
              },
              {
                value: "damaged-package",
                label: t("fulfillment.features.shipments.ui.commandCenter.exception.damaged"),
              },
              { value: "lost-in-transit", label: t("fulfillment.features.shipments.ui.commandCenter.exception.lost") },
              {
                value: "return-to-sender",
                label: t("fulfillment.features.shipments.ui.commandCenter.exception.returnToSender"),
              },
              { value: "other", label: t("fulfillment.features.shipments.ui.commandCenter.exception.other") },
            ]}
          />
          <Textarea
            label={t("fulfillment.features.shipments.ui.commandCenter.exception.notes")}
            name="notes"
            rows={2}
          />
          <Button type="submit" name="intent" value="raise-exception" tone="secondary" leadingIcon="warning">
            {actionLabel("raise-exception")}
          </Button>
        </Stack>
      </Form>
    );
  }

  return (
    <Form method="post" action={actionBasePath} spacing="none">
      <HiddenState item={item} />
      <Button type="submit" name="intent" value={action} tone="secondary">
        {actionLabel(action)}
      </Button>
    </Form>
  );
}

function PrimaryAction({
  item,
  actionBasePath,
  packingFlowBasePath,
}: {
  item: FulfillmentCommandCenterItem;
  actionBasePath: string;
  packingFlowBasePath: string;
}) {
  const primary = item.plan.primary;
  if (!primary) {
    return null;
  }

  // Packing keeps its checklist: the primary action opens the focused packing flow.
  if (primary === "start-packing" || primary === "complete-packing") {
    return (
      <LinkButton href={`${packingFlowBasePath}/${item.shipmentId}/packing`} tone="primary" leadingIcon="package">
        {actionLabel(primary)}
      </LinkButton>
    );
  }

  return (
    <Form method="post" action={actionBasePath} spacing="none">
      <HiddenState item={item} />
      <Button type="submit" name="intent" value={primary} tone="primary" leadingIcon="truck">
        {actionLabel(primary)}
      </Button>
    </Form>
  );
}

function CommandCenterItemCard({
  item,
  actionBasePath,
  packingFlowBasePath,
  shipmentDetailBasePath,
}: {
  item: FulfillmentCommandCenterItem;
  actionBasePath: string;
  packingFlowBasePath: string;
  shipmentDetailBasePath: string;
}) {
  return (
    <Card elevation="elevated" data-elevation-role="entity">
      <Stack gap={2}>
        <Stack gap={1}>
          <Text weight="semibold">{itemTitle(item)}</Text>
          <Badge tone={statusTone(item.status)}>{item.status}</Badge>
        </Stack>
        <Text size="sm" tone="secondary">
          {t("fulfillment.features.shipments.ui.commandCenter.summary", {
            buyer: item.buyerDisplayName ?? t("fulfillment.features.shipments.ui.commandCenter.buyer.unknown"),
            quantity: item.totalQuantity,
            lines: item.lineCount,
          })}
        </Text>
        {item.currentExceptionType ? (
          <MarketplaceNotice
            tone="warning"
            title={item.currentExceptionType}
            description={
              item.currentExceptionNotes ?? t("fulfillment.features.shipments.ui.commandCenter.exception.noNotes")
            }
          />
        ) : null}
        <PrimaryAction item={item} actionBasePath={actionBasePath} packingFlowBasePath={packingFlowBasePath} />
        {item.plan.disclosed.length > 0 ? (
          <ProgressiveDisclosure
            title={t("fulfillment.features.shipments.ui.commandCenter.moreActions")}
            tone="neutral"
          >
            <Stack gap={2}>
              {item.plan.disclosed.map((action) => (
                <DisclosedAction key={action} item={item} action={action} actionBasePath={actionBasePath} />
              ))}
            </Stack>
          </ProgressiveDisclosure>
        ) : null}
        <LinkButton href={`${shipmentDetailBasePath}/${item.shipmentId}`} tone="secondary">
          {t("fulfillment.features.shipments.ui.commandCenter.openShipment")}
        </LinkButton>
      </Stack>
    </Card>
  );
}

// The one fulfillment command center: pack, label, dispatch, and exceptions on a single
// work-ordered surface. Each shipment renders the one next action its state calls for,
// with the rest disclosed inline — no route change to complete the fulfillment spine.
export function FulfillmentCommandCenterPage({
  commandCenter,
  actionBasePath,
  shipmentDetailBasePath,
  packingFlowBasePath,
  errorMessage,
}: {
  commandCenter: FulfillmentCommandCenter;
  actionBasePath: string;
  shipmentDetailBasePath: string;
  packingFlowBasePath: string;
  errorMessage?: string | null;
}) {
  const activeBuckets = commandCenter.buckets.filter((bucket) => bucket.count > 0);

  return (
    <Page>
      <PageHeader
        eyebrow={t("fulfillment.features.shipments.ui.commandCenter.eyebrow")}
        title={t("fulfillment.features.shipments.ui.commandCenter.title")}
        description={t("fulfillment.features.shipments.ui.commandCenter.description")}
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("fulfillment.features.shipments.ui.commandCenter.actionFailed")}
          description={errorMessage}
        />
      ) : null}

      {commandCenter.totalNeedingAttention === 0 ? (
        <MarketplaceEmptyState
          title={t("fulfillment.features.shipments.ui.commandCenter.empty.title")}
          description={t("fulfillment.features.shipments.ui.commandCenter.empty.description")}
        />
      ) : (
        activeBuckets.map((bucket) => (
          <PageSection
            key={bucket.id}
            title={t("fulfillment.features.shipments.ui.commandCenter.bucketWithCount", {
              bucket: bucketTitle(bucket.id),
              count: bucket.count,
            })}
          >
            <Stack gap={3}>
              {bucket.items.map((item) => (
                <CommandCenterItemCard
                  key={item.shipmentId}
                  item={item}
                  actionBasePath={actionBasePath}
                  packingFlowBasePath={packingFlowBasePath}
                  shipmentDetailBasePath={shipmentDetailBasePath}
                />
              ))}
            </Stack>
          </PageSection>
        ))
      )}
    </Page>
  );
}
