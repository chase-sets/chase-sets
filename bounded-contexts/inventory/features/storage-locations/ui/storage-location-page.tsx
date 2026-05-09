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

function ShipFromAddressFields({
  address,
}: {
  address?: InventoryStorageLocation["ship_from_address"];
}) {
  return (
    <>
      <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.name")} name="shipFromName" defaultValue={address?.name ?? ""} required />
      <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.company")} name="shipFromCompany" defaultValue={address?.company ?? ""} />
      <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.line1")} name="shipFromLine1" defaultValue={address?.line1 ?? ""} required />
      <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.line2")} name="shipFromLine2" defaultValue={address?.line2 ?? ""} />
      <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.city")} name="shipFromCity" defaultValue={address?.city ?? ""} required />
      <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.state")} name="shipFromState" defaultValue={address?.state ?? ""} required />
      <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.postal.code")} name="shipFromPostalCode" defaultValue={address?.postalCode ?? ""} required />
      <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.country")} name="shipFromCountry" defaultValue={address?.country ?? "US"} required />
      <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.phone")} name="shipFromPhone" defaultValue={address?.phone ?? ""} />
      <TextInput label={t("inventory.features.storageLocations.ui.storageLocationPage.ship.from.email")} name="shipFromEmail" defaultValue={address?.email ?? ""} type="email" />
    </>
  );
}

function ShipFromAddressHiddenFields({
  address,
}: {
  address: InventoryStorageLocation["ship_from_address"];
}) {
  return (
    <>
      <input type="hidden" name="shipFromName" value={address.name} />
      <input type="hidden" name="shipFromCompany" value={address.company ?? ""} />
      <input type="hidden" name="shipFromLine1" value={address.line1} />
      <input type="hidden" name="shipFromLine2" value={address.line2 ?? ""} />
      <input type="hidden" name="shipFromCity" value={address.city} />
      <input type="hidden" name="shipFromState" value={address.state} />
      <input type="hidden" name="shipFromPostalCode" value={address.postalCode} />
      <input type="hidden" name="shipFromCountry" value={address.country} />
      <input type="hidden" name="shipFromPhone" value={address.phone ?? ""} />
      <input type="hidden" name="shipFromEmail" value={address.email ?? ""} />
    </>
  );
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
              <ShipFromAddressFields />
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
                    <ShipFromAddressFields address={location.ship_from_address} />
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
                    <ShipFromAddressHiddenFields address={location.ship_from_address} />
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
