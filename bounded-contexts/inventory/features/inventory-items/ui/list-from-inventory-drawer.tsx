import { t } from "@chase-sets/localization";
import {
  Button,
  CurrencyInput,
  FileDropzone,
  Form,
  HiddenInput,
  NumberField,
  SideSheet,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { InventoryItemDetail } from "./contracts";

// List-from-inventory one-flow: turn an inventory item the seller already owns
// into a live listing without a page hop to the listings section. The drawer
// opens over the inventory item, prefilled from the item — the catalog identity,
// product options, and ship-from are already the item's, so the seller only sets
// price, quantity, and photos. The form posts to the marketplace create route
// (create + publish in one step), which owns listing creation; on success it
// lands on the new listing. Posting to that route by path keeps this drawer free
// of a cross-context dependency.
export function ListFromInventoryDrawer({ item }: { item: InventoryItemDetail }) {
  const itemLabel = item.item_title ?? item.catalog_catalog_item_id;

  return (
    <SideSheet
      width="lg"
      title={t("inventory.features.inventoryItems.ui.listFromInventoryDrawer.list.it")}
      description={t("inventory.features.inventoryItems.ui.listFromInventoryDrawer.description", { item: itemLabel })}
      closeLabel={t("inventory.features.inventoryItems.ui.listFromInventoryDrawer.close")}
      trigger={<Button>{t("inventory.features.inventoryItems.ui.listFromInventoryDrawer.list.it")}</Button>}
    >
      <Form spacing="none" method="post" action="/account/listings/new" encType="multipart/form-data">
        <Stack gap={3}>
          <HiddenInput type="hidden" name="inventoryItemId" value={item.item_id} />
          <Text tone="secondary">
            {t("inventory.features.inventoryItems.ui.listFromInventoryDrawer.available", {
              item: itemLabel,
              count: item.available_quantity,
            })}
          </Text>
          <CurrencyInput
            label={t("inventory.features.inventoryItems.ui.listFromInventoryDrawer.price")}
            name="priceAmount"
            currencyCode="USD"
            required
          />
          <NumberField
            label={t("inventory.features.inventoryItems.ui.listFromInventoryDrawer.quantity.cap")}
            name="quantityCap"
            min={1}
            max={item.available_quantity}
            defaultValue={1}
            required
          />
          <FileDropzone
            label={t("inventory.features.inventoryItems.ui.listFromInventoryDrawer.photos")}
            name="evidence"
            accept="image/jpeg,image/png,image/webp"
            multiple
            capture="environment"
            description={t("inventory.features.inventoryItems.ui.listFromInventoryDrawer.photos.help")}
          />
          <Stack direction="row" gap={2}>
            <Button type="submit" name="intent" value="create-and-publish-listing">
              {t("inventory.features.inventoryItems.ui.listFromInventoryDrawer.create.and.publish")}
            </Button>
            <Button type="submit" name="intent" value="create-listing" tone="secondary">
              {t("inventory.features.inventoryItems.ui.listFromInventoryDrawer.save.as.draft")}
            </Button>
          </Stack>
        </Stack>
      </Form>
    </SideSheet>
  );
}
