import { formatDateTime, formatLanguageCodeLabel, t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  HiddenInput,
  Form,
  Button,
  Badge,
  Card,
  Inline,
  LinkButton,
  MarketplaceStatusTimeline,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
  NumberField,
  ProductOptions,
  Textarea,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { InventoryItemDetail } from "./contracts";
import { inventoryListingHref } from "./listing-handoff";

function displayItemLabel(item: InventoryItemDetail) {
  return item.item_title ?? item.catalog_catalog_item_id;
}

function holdPurposeLabel(purpose: string) {
  switch (purpose) {
    case "order":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.hold.purpose.order");
    case "manual":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.hold.purpose.manual");
    case "checkout":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.hold.purpose.checkout");
    case "pos":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.hold.purpose.pos");
    case "channel":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.hold.purpose.channel");
    case "transfer":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.hold.purpose.transfer");
    default:
      return purpose;
  }
}

function orderSourceRef(sourceRef: InventoryItemDetail["holds"][number]["source_ref"]) {
  return sourceRef && "orderId" in sourceRef ? sourceRef.orderId : null;
}

function formatTimestamp(value: string | null) {
  return value ? formatDateTime(value) : "";
}

function countdownLabel(expiresAt: string | null) {
  if (!expiresAt) {
    return null;
  }

  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs)) {
    return null;
  }
  if (remainingMs <= 0) {
    return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.expired");
  }

  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  if (remainingMinutes < 60) {
    return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.expires.in.minutes", {
      count: remainingMinutes,
    });
  }

  return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.expires.in.hours", {
    count: Math.ceil(remainingMinutes / 60),
  });
}

function ledgerKindLabel(kind: InventoryItemDetail["ledger"][number]["kind"]) {
  switch (kind) {
    case "created":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.ledger.created");
    case "adjusted":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.ledger.adjusted");
    case "hold-placed":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.ledger.hold.placed");
    case "hold-converted":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.ledger.hold.converted");
    case "hold-consumed":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.ledger.hold.consumed");
    case "hold-released":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.ledger.hold.released");
    case "hold-expired":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.ledger.hold.expired");
    case "restock-decision":
      return t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.ledger.restock.decision");
    default:
      return kind;
  }
}

function ledgerDescription(entry: InventoryItemDetail["ledger"][number]) {
  const parts = [
    entry.quantity_delta === null
      ? null
      : t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.quantity.delta.summary", {
          count: entry.quantity_delta,
        }),
    entry.hold_quantity === null
      ? null
      : t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.hold.quantity.summary", {
          count: entry.hold_quantity,
        }),
    entry.purpose ? holdPurposeLabel(entry.purpose) : null,
    entry.reason,
    entry.actor === "seller"
      ? t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.actor.seller")
      : t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.actor.system"),
    formatTimestamp(entry.occurred_at),
  ].filter(Boolean);

  const orderId = orderSourceRef(entry.source_ref);

  return (
    <Stack gap={1}>
      <Text size="sm" tone="secondary">
        {parts.join(" | ")}
      </Text>
      {orderId ? (
        <LinkButton href={`/account/sales/${orderId}`} tone="secondary" size="sm">
          {t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.view.order", { orderId })}
        </LinkButton>
      ) : null}
    </Stack>
  );
}

function ledgerFilterHref(currentPath: string | null | undefined, kind: string | null) {
  const [pathname = "", rawQuery = ""] = (currentPath ?? "").split("?");
  const params = new URLSearchParams(rawQuery);
  if (kind) {
    params.set("ledgerKind", kind);
  } else {
    params.delete("ledgerKind");
  }
  const query = params.toString();
  return `${pathname || "."}${query ? `?${query}` : ""}`;
}

function selectedLedgerKind(currentPath: string | null | undefined) {
  const [, rawQuery = ""] = (currentPath ?? "").split("?");
  const value = new URLSearchParams(rawQuery).get("ledgerKind");
  return value?.trim() || null;
}

export function InventoryItemDetailPage({
  item,
  errorMessage,
  feedbackPrompt,
  currentPath,
}: {
  item: InventoryItemDetail;
  errorMessage?: string | null;
  feedbackPrompt?: ReactNode;
  currentPath?: string | null;
}) {
  const selectedKind = selectedLedgerKind(currentPath);
  const ledgerEntries = selectedKind ? item.ledger.filter((entry) => entry.kind === selectedKind) : item.ledger;
  const ledgerKinds = [...new Set(item.ledger.map((entry) => entry.kind))];

  return (
    <Page>
      <PageHeader
        eyebrow={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.seller")}
        title={displayItemLabel(item)}
        description={
          item.item_subtitle ?? t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.inventory.item.detail")
        }
        actions={
          <Stack gap={2}>
            {item.available_quantity > 0 ? (
              <LinkButton href={inventoryListingHref(item.item_id, currentPath)}>
                {t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.create.listing")}
              </LinkButton>
            ) : null}
            <LinkButton href="/account/inventory" tone="secondary">
              {t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.back.to.inventory")}
            </LinkButton>
          </Stack>
        }
      />

      {feedbackPrompt}

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.inventory.item.summary")}>
        <Card>
          <Stack gap={2}>
            <Text>
              <strong>{t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.catalog.item")}</strong>{" "}
              {item.catalog_catalog_item_id}
            </Text>
            {item.language_code ? <Badge tone="neutral">{formatLanguageCodeLabel(item.language_code)}</Badge> : null}
            {item.product_summary ? (
              <Text>
                <strong>{t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.product")}</strong>{" "}
                <ProductOptions options={productOptionsFromSummary(item.product_summary)} variant="compact" />
              </Text>
            ) : null}
            <Text>
              <strong>{t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.location")}</strong>{" "}
              {item.storage_location_name} ({item.ship_from_code})
            </Text>
            <Text>
              <strong>{t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.total.quantity")}</strong>{" "}
              {item.total_quantity}
            </Text>
            <Text>
              <strong>{t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.held.quantity")}</strong>{" "}
              {item.held_quantity}
            </Text>
            <Text>
              <strong>{t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.available.quantity")}</strong>{" "}
              {item.available_quantity}
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.adjust.quantity")}>
        <Card>
          <Form spacing="none" method="post">
            <Stack gap={3}>
              <HiddenInput type="hidden" name="intent" value="adjust-item" />
              <NumberField
                label={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.quantity.delta")}
                name="quantityDelta"
                required
                placeholder={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.1.or.5")}
              />
              <TextInput
                label={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.reason")}
                name="reason"
                required
              />
              <Button type="submit">
                {t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.apply.adjustment")}
              </Button>
            </Stack>
          </Form>
        </Card>
      </PageSection>

      <PageSection title={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.create.hold")}>
        <Card>
          <Form spacing="none" method="post">
            <Stack gap={3}>
              <HiddenInput type="hidden" name="intent" value="create-hold" />
              <NumberField
                label={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.hold.quantity")}
                name="quantity"
                required
                min={1}
              />
              <TextInput
                label={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.reason.2")}
                name="reason"
                required
              />
              <Textarea
                label={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.notes")}
                name="notes"
                rows={3}
              />
              <Button type="submit">
                {t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.create.hold.2")}
              </Button>
            </Stack>
          </Form>
        </Card>
      </PageSection>

      <PageSection title={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.hold.history")}>
        <Stack gap={4}>
          {item.holds.length === 0 ? (
            <Card>
              <Text>
                {t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.no.holds.have.been.created.for")}
              </Text>
            </Card>
          ) : (
            item.holds.map((hold) => (
              <Card key={hold.hold_id}>
                <Stack gap={2}>
                  <Text weight="semibold">
                    {hold.reason} ({hold.quantity})
                  </Text>
                  <Stack gap={2}>
                    <Badge tone={hold.purpose === "manual" ? "neutral" : "info"}>
                      {holdPurposeLabel(hold.purpose)}
                    </Badge>
                    {hold.status === "active" && hold.expires_at ? (
                      <Badge tone="warning">{countdownLabel(hold.expires_at)}</Badge>
                    ) : null}
                    {orderSourceRef(hold.source_ref) ? (
                      <LinkButton href={`/account/sales/${orderSourceRef(hold.source_ref)}`} tone="secondary" size="sm">
                        {t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.view.order", {
                          orderId: orderSourceRef(hold.source_ref),
                        })}
                      </LinkButton>
                    ) : null}
                  </Stack>
                  <Text tone="secondary">
                    {hold.status === "active"
                      ? t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.active.hold")
                      : t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.released.hold")}
                  </Text>
                  {hold.notes ? <Text>{hold.notes}</Text> : null}
                  <Text tone="secondary" size="sm">
                    {t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.created")}
                    {hold.created_at}
                  </Text>
                  {hold.status === "active" && hold.purpose === "manual" ? (
                    <Form spacing="none" method="post">
                      <HiddenInput type="hidden" name="intent" value="release-hold" />
                      <HiddenInput type="hidden" name="holdId" value={hold.hold_id} />
                      <Button type="submit" tone="secondary">
                        {t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.release.hold")}
                      </Button>
                    </Form>
                  ) : null}
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      </PageSection>

      <PageSection title={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.stock.ledger")}>
        <Stack gap={4}>
          <Inline>
            <LinkButton
              href={ledgerFilterHref(currentPath, null)}
              tone={selectedKind ? "secondary" : "primary"}
              size="sm"
            >
              {t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.all.movements")}
            </LinkButton>
            {ledgerKinds.map((kind) => (
              <LinkButton
                key={kind}
                href={ledgerFilterHref(currentPath, kind)}
                tone={selectedKind === kind ? "primary" : "secondary"}
                size="sm"
              >
                {ledgerKindLabel(kind)}
              </LinkButton>
            ))}
          </Inline>
          {ledgerEntries.length === 0 ? (
            <Card>
              <Text>{t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.no.stock.movements")}</Text>
            </Card>
          ) : (
            <MarketplaceStatusTimeline
              steps={ledgerEntries.map((entry) => ({
                label: ledgerKindLabel(entry.kind),
                description: ledgerDescription(entry),
                status: entry.kind === "hold-expired" || entry.reason === "written-off" ? "issue" : "complete",
              }))}
            />
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
