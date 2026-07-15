import { t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  Badge,
  Button,
  Grid,
  Inline,
  LinkButton,
  MarketplaceEmptyState,
  ModalDialog,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  ResponsiveEditSheet,
  Stack,
  Surface,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { ShippingAddress } from "./contracts";

function addressLines(address: ShippingAddress) {
  return [
    address.recipient_name,
    address.company,
    address.line1,
    address.line2,
    `${address.city}, ${address.state} ${address.postal_code}`,
    address.country,
  ].filter(Boolean);
}

function AddressFields({ address }: { address?: ShippingAddress }) {
  return (
    <Grid columns={{ base: 1, md: 2 }} gap={3}>
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.label")}
        name="label"
        defaultValue={address?.label ?? ""}
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.recipient.name")}
        name="name"
        autoComplete="name"
        defaultValue={address?.recipient_name ?? ""}
        required
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.company")}
        name="company"
        autoComplete="organization"
        defaultValue={address?.company ?? ""}
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.country")}
        name="country"
        autoComplete="country"
        defaultValue={address?.country ?? "US"}
        required
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.address.line1")}
        name="line1"
        autoComplete="address-line1"
        defaultValue={address?.line1 ?? ""}
        required
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.address.line2")}
        name="line2"
        autoComplete="address-line2"
        defaultValue={address?.line2 ?? ""}
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.city")}
        name="city"
        autoComplete="address-level2"
        defaultValue={address?.city ?? ""}
        required
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.state")}
        name="state"
        autoComplete="address-level1"
        defaultValue={address?.state ?? ""}
        required
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.postal.code")}
        name="postalCode"
        autoComplete="postal-code"
        defaultValue={address?.postal_code ?? ""}
        required
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.phone")}
        name="phone"
        autoComplete="tel"
        defaultValue={address?.phone ?? ""}
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.email")}
        name="email"
        type="email"
        autoComplete="email"
        defaultValue={address?.email ?? ""}
      />
      <NativeSelect
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.default")}
        name="makeDefault"
        defaultValue={address?.is_default ? "true" : "false"}
        items={[
          { value: "false", label: t("identity.features.shippingAddresses.ui.shippingAddressPage.keep.default") },
          { value: "true", label: t("identity.features.shippingAddresses.ui.shippingAddressPage.make.default") },
        ]}
      />
    </Grid>
  );
}

export function ShippingAddressPage({
  addresses,
  errorMessage,
}: {
  addresses: readonly ShippingAddress[];
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("identity.features.shippingAddresses.ui.shippingAddressPage.account")}
        title={t("identity.features.shippingAddresses.ui.shippingAddressPage.shipping.addresses")}
        description={t("identity.features.shippingAddresses.ui.shippingAddressPage.manage.reusable.destinations")}
        actions={
          <LinkButton href="/account" tone="secondary">
            {t("identity.features.shippingAddresses.ui.shippingAddressPage.back.to.account")}
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Surface elevated>
          <Stack gap={2}>
            <Badge tone="danger">{t("identity.features.shippingAddresses.ui.shippingAddressPage.address.issue")}</Badge>
            <Text>{errorMessage}</Text>
          </Stack>
        </Surface>
      ) : null}

      <PageSection
        title={t("identity.features.shippingAddresses.ui.shippingAddressPage.add.shipping.address")}
        description={t("identity.features.shippingAddresses.ui.shippingAddressPage.add.description")}
      >
        <Surface elevated>
          <Form spacing="none" method="post">
            <Stack gap={3}>
              <HiddenInput type="hidden" name="intent" value="create" />
              <AddressFields />
              <Button type="submit" leadingIcon="plus">
                {t("identity.features.shippingAddresses.ui.shippingAddressPage.save.address")}
              </Button>
            </Stack>
          </Form>
        </Surface>
      </PageSection>

      <PageSection
        title={t("identity.features.shippingAddresses.ui.shippingAddressPage.saved.addresses")}
        description={t("identity.features.shippingAddresses.ui.shippingAddressPage.saved.description")}
      >
        {addresses.length === 0 ? (
          <MarketplaceEmptyState
            title={t("identity.features.shippingAddresses.ui.shippingAddressPage.no.saved.addresses")}
            description={t("identity.features.shippingAddresses.ui.shippingAddressPage.no.saved.addresses.description")}
          />
        ) : (
          <Stack gap={3}>
            {addresses.map((address) => (
              <Surface key={address.shipping_address_id} elevated>
                <Stack gap={3}>
                  <Inline gap={2}>
                    <Text weight="semibold">{address.label}</Text>
                    {address.is_default ? (
                      <Badge tone="success">
                        {t("identity.features.shippingAddresses.ui.shippingAddressPage.default.badge")}
                      </Badge>
                    ) : null}
                  </Inline>
                  <Stack gap={1}>
                    {addressLines(address).map((line) => (
                      <Text key={line} size="sm" tone="secondary">
                        {line}
                      </Text>
                    ))}
                  </Stack>
                  <Inline gap={2}>
                    <ResponsiveEditSheet
                      title={t("identity.features.shippingAddresses.ui.shippingAddressPage.update.address")}
                      description={t("identity.features.shippingAddresses.ui.shippingAddressPage.saved.description")}
                      trigger={
                        <Button type="button" tone="secondary">
                          {t("identity.features.shippingAddresses.ui.shippingAddressPage.update.address")}
                        </Button>
                      }
                    >
                      <Form spacing="none" method="post">
                        <Stack gap={3}>
                          <HiddenInput type="hidden" name="intent" value="update" />
                          <HiddenInput type="hidden" name="shippingAddressId" value={address.shipping_address_id} />
                          <AddressFields address={address} />
                          <Button type="submit" tone="secondary">
                            {t("identity.features.shippingAddresses.ui.shippingAddressPage.update.address")}
                          </Button>
                        </Stack>
                      </Form>
                    </ResponsiveEditSheet>
                    {!address.is_default ? (
                      <Form spacing="none" method="post">
                        <HiddenInput type="hidden" name="intent" value="default" />
                        <HiddenInput type="hidden" name="shippingAddressId" value={address.shipping_address_id} />
                        <Button type="submit" tone="secondary">
                          {t("identity.features.shippingAddresses.ui.shippingAddressPage.set.default")}
                        </Button>
                      </Form>
                    ) : null}
                    <ModalDialog
                      title={t("identity.features.shippingAddresses.ui.shippingAddressPage.archive")}
                      description={t(
                        "identity.features.shippingAddresses.ui.shippingAddressPage.archive.confirm.description",
                      )}
                      trigger={
                        <Button type="button" tone="danger">
                          {t("identity.features.shippingAddresses.ui.shippingAddressPage.archive")}
                        </Button>
                      }
                    >
                      <Form spacing="none" method="post">
                        <Stack gap={3}>
                          <HiddenInput type="hidden" name="intent" value="archive" />
                          <HiddenInput type="hidden" name="shippingAddressId" value={address.shipping_address_id} />
                          <Button type="submit" tone="danger">
                            {t("identity.features.shippingAddresses.ui.shippingAddressPage.archive")}
                          </Button>
                        </Stack>
                      </Form>
                    </ModalDialog>
                  </Inline>
                </Stack>
              </Surface>
            ))}
          </Stack>
        )}
      </PageSection>
    </Page>
  );
}
