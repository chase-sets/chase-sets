import {
  Button,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
  NumberInput,
  Textarea,
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
}: {
  item: InventoryItemDetail;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Seller"
        title={displayItemLabel(item)}
        description={item.item_subtitle ?? "Inventory item detail"}
        actions={
          <Stack gap={2}>
            {item.available_quantity > 0 ? (
              <LinkButton href={listingHref(item)}>
                Create listing
              </LinkButton>
            ) : null}
            <LinkButton href="/account/inventory" tone="secondary">
              Back to inventory
            </LinkButton>
          </Stack>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Inventory Item Summary">
        <Card>
          <Stack gap={2}>
            <Text>
              <strong>Catalog item:</strong> {item.catalog_catalog_item_id}
            </Text>
            {item.product_summary ? (
              <Text>
                <strong>Product:</strong> {item.product_summary}
              </Text>
            ) : null}
            <Text>
              <strong>Location:</strong> {item.storage_location_name} ({item.ship_from_code})
            </Text>
            <Text>
              <strong>Total quantity:</strong> {item.total_quantity}
            </Text>
            <Text>
              <strong>Held quantity:</strong> {item.held_quantity}
            </Text>
            <Text>
              <strong>Available quantity:</strong> {item.available_quantity}
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Adjust Quantity">
        <Card>
          <form method="post">
            <Stack gap={3}>
              <input type="hidden" name="intent" value="adjust-item" />
              <NumberInput
                label="Quantity delta"
                name="quantityDelta"
                required
                placeholder="-1 or 5"
              />
              <TextInput label="Reason" name="reason" required />
              <Button type="submit">Apply adjustment</Button>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title="Create Hold">
        <Card>
          <form method="post">
            <Stack gap={3}>
              <input type="hidden" name="intent" value="create-hold" />
              <NumberInput label="Hold quantity" name="quantity" required min="1" />
              <TextInput label="Reason" name="reason" required />
              <Textarea label="Notes" name="notes" rows={3} />
              <Button type="submit">Create hold</Button>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title="Hold History">
        <Stack gap={4}>
          {item.holds.length === 0 ? (
            <Card>
              <Text>No holds have been created for this inventory item.</Text>
            </Card>
          ) : (
            item.holds.map((hold) => (
              <Card key={hold.hold_id}>
                <Stack gap={2}>
                  <Text weight="semibold">
                    {hold.reason} ({hold.quantity})
                  </Text>
                  <Text tone="secondary">
                    {hold.status === "active" ? "Active hold" : "Released hold"}
                  </Text>
                  {hold.notes ? <Text>{hold.notes}</Text> : null}
                  <Text tone="secondary" size="sm">
                    Created {hold.created_at}
                  </Text>
                  {hold.status === "active" ? (
                    <form method="post">
                      <input type="hidden" name="intent" value="release-hold" />
                      <input type="hidden" name="holdId" value={hold.hold_id} />
                      <Button type="submit" tone="secondary">
                        Release hold
                      </Button>
                    </form>
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
