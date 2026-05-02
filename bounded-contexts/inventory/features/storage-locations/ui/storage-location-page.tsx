import { t } from "@chase-sets/localization";
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
  return location.description ?? t("inventory.features.storageLocations.ui.storageLocationPage.no.description");
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
        eyebrow={t("inventory.features.storageLocations.ui.storageLocationPage.seller")}
        title={t("inventory.features.storageLocations.ui.storageLocationPage.storage.locations")}
        description={t("inventory.features.storageLocations.ui.storageLocationPage.map.seller.defined.storage.areas.to")}
        actions={
          <LinkButton href="/account/inventory" tone="secondary">
            {t("inventory.features.storageLocations.ui.storageLocationPage.back.to.inventory")}</LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("inventory.features.storageLocations.ui.storageLocationPage.create.location")}>
        <Card>
          <form method="post">
            <Stack gap={3}>
              <input type="hidden" name="intent" value="create-location" />
              <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.name")} name="name" required />
              <Textarea label={t("inventory.features.storageLocations.ui.storageLocationPage.description")} name="description" rows={3} />
              <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.code")} name="shipFromCode" required />
              <Button type="submit">{t("inventory.features.storageLocations.ui.storageLocationPage.create.location.2")}</Button>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title={t("inventory.features.storageLocations.ui.storageLocationPage.current.locations")}>
        <Stack gap={4}>
          {locations.map((location) => (
            <Card key={location.storage_location_id}>
              <Stack gap={3}>
                <Stack gap={1}>
                  <Text weight="semibold">{location.name}</Text>
                  <Text tone="secondary">{formatDescription(location)}</Text>
                  <Badge tone={location.is_archived ? "warning" : "accent"}>
                    {location.is_archived ? t("inventory.features.storageLocations.ui.storageLocationPage.archived") : t("inventory.features.storageLocations.ui.storageLocationPage.active")}
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
                      label={t("inventory.features.storageLocations.ui.storageLocationPage.name.2")}
                      name="name"
                      defaultValue={location.name}
                      required
                    />
                    <Textarea
                      label={t("inventory.features.storageLocations.ui.storageLocationPage.description.2")}
                      name="description"
                      rows={3}
                      defaultValue={location.description ?? ""}
                    />
                    <TextInput
                      label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.code.2")}
                      name="shipFromCode"
                      defaultValue={location.ship_from_code}
                      required
                    />
                    <Button type="submit" tone="secondary">
                      {t("inventory.features.storageLocations.ui.storageLocationPage.save.location")}</Button>
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
                      {t("inventory.features.storageLocations.ui.storageLocationPage.archive.location")}</Button>
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
