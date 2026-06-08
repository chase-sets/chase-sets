import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  HiddenInput,
  Form,
  Button,
  Badge,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
  NumberInput,
  ProductOptions,
  Textarea,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { InventoryItemDetail } from "./contracts";

function displayItemLabel(item: InventoryItemDetail) {
  return item.item_title ?? item.catalog_catalog_item_id;
}

function listingHref(item: InventoryItemDetail) {
  return `/account/listings?inventoryItemId=${encodeURIComponent(item.item_id)}`;
}

export function InventoryItemDetailPage({
  item,
  errorMessage,
  feedbackPrompt,
}: {
  item: InventoryItemDetail;
  errorMessage?: string | null;
  feedbackPrompt?: ReactNode;
}) {
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
              <LinkButton href={listingHref(item)}>
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
              <NumberInput
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
              <NumberInput
                label={t("inventory.features.inventoryItems.ui.inventoryItemDetailPage.hold.quantity")}
                name="quantity"
                required
                min="1"
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
                  {hold.status === "active" ? (
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
    </Page>
  );
}
