import {
  Badge,
  Button,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@chase-sets/design-system";
import type { InventoryStorageLocation } from "./contracts";

function formatDescription(location: InventoryStorageLocation) {
  return location.description ?? "No description";
}

export function StorageLocationPage({
  locations,
  errorMessage,
}: {
  locations: readonly InventoryStorageLocation[];
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Seller"
        title="Storage Locations"
        description="Map seller-defined storage areas to ship-from codes."
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

      <PageSection title="Create Location">
        <Card>
          <form method="post">
            <Stack gap={3}>
              <input type="hidden" name="intent" value="create-location" />
              <TextInput label="Name" name="name" required />
              <Textarea label="Description" name="description" rows={3} />
              <TextInput label="Ship-from code" name="shipFromCode" required />
              <Button type="submit">Create location</Button>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title="Current Locations">
        <Stack gap={4}>
          {locations.map((location) => (
            <Card key={location.storage_location_id}>
              <Stack gap={3}>
                <Stack gap={1}>
                  <Text weight="semibold">{location.name}</Text>
                  <Text tone="secondary">{formatDescription(location)}</Text>
                  <Badge tone={location.is_archived ? "warning" : "accent"}>
                    {location.is_archived ? "Archived" : "Active"}
                  </Badge>
                </Stack>
                <form method="post">
                  <Stack gap={3}>
                    <input
                      type="hidden"
                      name="intent"
                      value="update-location"
                    />
                    <input
                      type="hidden"
                      name="storageLocationId"
                      value={location.storage_location_id}
                    />
                    <TextInput
                      label="Name"
                      name="name"
                      defaultValue={location.name}
                      required
                    />
                    <Textarea
                      label="Description"
                      name="description"
                      rows={3}
                      defaultValue={location.description ?? ""}
                    />
                    <TextInput
                      label="Ship-from code"
                      name="shipFromCode"
                      defaultValue={location.ship_from_code}
                      required
                    />
                    <Button type="submit" tone="secondary">
                      Save location
                    </Button>
                  </Stack>
                </form>
                {!location.is_archived ? (
                  <form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="archive-location"
                    />
                    <input
                      type="hidden"
                      name="storageLocationId"
                      value={location.storage_location_id}
                    />
                    <input type="hidden" name="name" value={location.name} />
                    <input
                      type="hidden"
                      name="description"
                      value={location.description ?? ""}
                    />
                    <input
                      type="hidden"
                      name="shipFromCode"
                      value={location.ship_from_code}
                    />
                    <Button type="submit" tone="danger">
                      Archive location
                    </Button>
                  </form>
                ) : null}
              </Stack>
            </Card>
          ))}
        </Stack>
      </PageSection>
    </Page>
  );
}
