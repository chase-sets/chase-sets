import {
  Button,
  Card,
  ConditionBadge,
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
import type { InventoryRecordDetail } from "./contracts";

function displayItemLabel(record: InventoryRecordDetail) {
  return record.item_title ?? record.catalog_item_id;
}

export function InventoryRecordDetailPage({
  record,
  errorMessage,
}: {
  record: InventoryRecordDetail;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Seller"
        title={displayItemLabel(record)}
        description={record.item_subtitle ?? "Inventory record detail"}
        actions={
          <LinkButton href="/account/inventory" tone="secondary">
            Back to inventory
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Record Summary">
        <Card>
          <Stack gap={2}>
            <Text>
              <strong>Catalog item:</strong> {record.catalog_item_id}
            </Text>
            {record.version_summary ? (
              <Text>
                <strong>Version:</strong> {record.version_summary}
              </Text>
            ) : null}
            <Text>
              <strong>Condition:</strong>{" "}
              <ConditionBadge condition={record.condition as never} />
            </Text>
            <Text>
              <strong>Location:</strong> {record.storage_location_name} ({record.ship_from_code})
            </Text>
            <Text>
              <strong>Total quantity:</strong> {record.total_quantity}
            </Text>
            <Text>
              <strong>Held quantity:</strong> {record.held_quantity}
            </Text>
            <Text>
              <strong>Available quantity:</strong> {record.available_quantity}
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Adjust Quantity">
        <Card>
          <form method="post">
            <Stack gap={3}>
              <input type="hidden" name="intent" value="adjust-record" />
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
          {record.holds.length === 0 ? (
            <Card>
              <Text>No holds have been created for this record.</Text>
            </Card>
          ) : (
            record.holds.map((hold) => (
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
