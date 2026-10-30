import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { t } from "@chase-sets/localization";
import { AccountMutationForm as Form } from "../../account-management/ui/controller";
import type { MutationNotification } from "../../account-management/ui/controller";
import type { MutationFailure } from "../../account-management/ui/transport";
import {
  HiddenInput,
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
  ValidationSummary,
} from "@chase-sets/design-system";
import type { ShippingAddress } from "./contracts";

const SHIPPING_ADDRESS_FIELDS = [
  "label",
  "name",
  "company",
  "country",
  "line1",
  "line2",
  "city",
  "state",
  "postalCode",
  "phone",
  "email",
  "makeDefault",
] as const;
type ShippingAddressField = (typeof SHIPPING_ADDRESS_FIELDS)[number];
const SHIPPING_ADDRESS_FIELD_SET = new Set<string>(SHIPPING_ADDRESS_FIELDS);

function fieldLabel(field: ShippingAddressField) {
  switch (field) {
    case "label":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.label");
    case "name":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.recipient.name");
    case "company":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.company");
    case "country":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.country");
    case "line1":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.address.line1");
    case "line2":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.address.line2");
    case "city":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.city");
    case "state":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.state");
    case "postalCode":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.postal.code");
    case "phone":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.phone");
    case "email":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.email");
    case "makeDefault":
      return t("identity.features.shippingAddresses.ui.shippingAddressPage.default");
  }
}

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

function AddressFields({
  address,
  errors,
  fieldId,
}: {
  address?: ShippingAddress;
  errors?: Partial<Record<ShippingAddressField, string>>;
  fieldId: (field: ShippingAddressField) => string;
}) {
  return (
    <Grid columns={{ base: 1, md: 2 }} gap={3}>
      <TextInput
        id={fieldId("label")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.label")}
        name="label"
        defaultValue={address?.label ?? ""}
        error={errors?.label}
      />
      <TextInput
        id={fieldId("name")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.recipient.name")}
        name="name"
        autoComplete="name"
        defaultValue={address?.recipient_name ?? ""}
        required
        error={errors?.name}
      />
      <TextInput
        id={fieldId("company")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.company")}
        name="company"
        autoComplete="organization"
        defaultValue={address?.company ?? ""}
        error={errors?.company}
      />
      <TextInput
        id={fieldId("country")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.country")}
        name="country"
        autoComplete="country"
        defaultValue={address?.country ?? "US"}
        required
        error={errors?.country}
      />
      <TextInput
        id={fieldId("line1")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.address.line1")}
        name="line1"
        autoComplete="address-line1"
        defaultValue={address?.line1 ?? ""}
        required
        error={errors?.line1}
      />
      <TextInput
        id={fieldId("line2")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.address.line2")}
        name="line2"
        autoComplete="address-line2"
        defaultValue={address?.line2 ?? ""}
        error={errors?.line2}
      />
      <TextInput
        id={fieldId("city")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.city")}
        name="city"
        autoComplete="address-level2"
        defaultValue={address?.city ?? ""}
        required
        error={errors?.city}
      />
      <TextInput
        id={fieldId("state")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.state")}
        name="state"
        autoComplete="address-level1"
        defaultValue={address?.state ?? ""}
        required
        error={errors?.state}
      />
      <TextInput
        id={fieldId("postalCode")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.postal.code")}
        name="postalCode"
        autoComplete="postal-code"
        defaultValue={address?.postal_code ?? ""}
        required
        error={errors?.postalCode}
      />
      <TextInput
        id={fieldId("phone")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.phone")}
        name="phone"
        autoComplete="tel"
        defaultValue={address?.phone ?? ""}
        error={errors?.phone}
      />
      <TextInput
        id={fieldId("email")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.email")}
        name="email"
        type="email"
        autoComplete="email"
        defaultValue={address?.email ?? ""}
        error={errors?.email}
      />
      <NativeSelect
        id={fieldId("makeDefault")}
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.default")}
        name="makeDefault"
        defaultValue={address?.is_default ? "true" : "false"}
        items={[
          { value: "false", label: t("identity.features.shippingAddresses.ui.shippingAddressPage.keep.default") },
          { value: "true", label: t("identity.features.shippingAddresses.ui.shippingAddressPage.make.default") },
        ]}
        error={errors?.makeDefault}
      />
    </Grid>
  );
}

function ShippingAddressMutationForm({ address, intent }: { address?: ShippingAddress; intent: "create" | "update" }) {
  const instanceId = useId().replaceAll(":", "");
  const location = useLocation();
  const previousLocation = useRef(location);
  const summaryRef = useRef<HTMLElement>(null);
  const [presentation, setPresentation] = useState<Readonly<{ failure: MutationFailure; occurrence: number }> | null>(
    null,
  );

  const fieldId = useCallback(
    (field: ShippingAddressField) => `shipping-address-${intent}-${instanceId}-${field}`,
    [instanceId, intent],
  );
  const fieldErrors = presentation?.failure.errors?.fieldErrors ?? {};
  const visibleFieldErrors = Object.entries(fieldErrors).flatMap(([field, messages]) =>
    SHIPPING_ADDRESS_FIELD_SET.has(field)
      ? (messages ?? []).map((message) => ({ field: field as ShippingAddressField, message }))
      : [],
  );
  const errors = Object.fromEntries(visibleFieldErrors.map(({ field, message }) => [field, message])) as Partial<
    Record<ShippingAddressField, string>
  >;
  const summaryErrors =
    visibleFieldErrors.length > 0
      ? visibleFieldErrors.map(({ field, message }) => ({
          fieldId: fieldId(field),
          fieldName: fieldLabel(field),
          message,
        }))
      : presentation
        ? [{ message: presentation.failure.message }]
        : [];

  useLayoutEffect(() => {
    if (presentation) summaryRef.current?.focus();
  }, [presentation?.occurrence]);

  useEffect(() => {
    const previous = previousLocation.current;
    previousLocation.current = location;
    if (
      previous.key === location.key ||
      (previous.pathname === location.pathname && previous.search === location.search && location.hash !== "")
    ) {
      return;
    }
    setPresentation(null);
  }, [location]);

  const onMutation = useCallback((notification: MutationNotification) => {
    if (notification.type === "accepted") {
      setPresentation(null);
      return;
    }
    setPresentation((current) => ({ failure: notification.failure, occurrence: (current?.occurrence ?? 0) + 1 }));
  }, []);

  if (intent === "create") {
    return (
      <Form
        spacing="none"
        method="post"
        onMutation={onMutation}
        errorAnnouncement={presentation ? "summary" : "inline"}
        validationSummaryId={presentation ? `${instanceId}-shipping-address-errors` : undefined}
      >
        <Stack gap={3}>
          {presentation ? (
            <ValidationSummary ref={summaryRef} id={`${instanceId}-shipping-address-errors`} errors={summaryErrors} />
          ) : null}
          <HiddenInput type="hidden" name="intent" value="create" />
          <AddressFields address={address} errors={errors} fieldId={fieldId} />
          <Button type="submit" leadingIcon="plus">
            {t("identity.features.shippingAddresses.ui.shippingAddressPage.save.address")}
          </Button>
        </Stack>
      </Form>
    );
  }

  return (
    <Form
      spacing="none"
      method="post"
      onMutation={onMutation}
      errorAnnouncement={presentation ? "summary" : "inline"}
      validationSummaryId={presentation ? `${instanceId}-shipping-address-errors` : undefined}
    >
      <Stack gap={3}>
        {presentation ? (
          <ValidationSummary ref={summaryRef} id={`${instanceId}-shipping-address-errors`} errors={summaryErrors} />
        ) : null}
        <HiddenInput type="hidden" name="intent" value="update" />
        <HiddenInput type="hidden" name="shippingAddressId" value={address?.shipping_address_id ?? ""} />
        <AddressFields address={address} errors={errors} fieldId={fieldId} />
        <Button type="submit" tone="secondary">
          {t("identity.features.shippingAddresses.ui.shippingAddressPage.update.address")}
        </Button>
      </Stack>
    </Form>
  );
}

function ShippingAddressUpdateSheet({ address }: { address: ShippingAddress }) {
  const [revision, setRevision] = useState(0);
  return (
    <ResponsiveEditSheet
      title={t("identity.features.shippingAddresses.ui.shippingAddressPage.update.address")}
      description={t("identity.features.shippingAddresses.ui.shippingAddressPage.saved.description")}
      trigger={
        <Button type="button" tone="secondary">
          {t("identity.features.shippingAddresses.ui.shippingAddressPage.update.address")}
        </Button>
      }
      onOpenChange={(open) => {
        if (!open) setRevision((current) => current + 1);
      }}
    >
      <ShippingAddressMutationForm key={revision} address={address} intent="update" />
    </ResponsiveEditSheet>
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
        <Surface elevation="tinted">
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
        <Surface elevation="tinted">
          <ShippingAddressMutationForm intent="create" />
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
              <Surface key={address.shipping_address_id} elevation="elevated">
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
                    <ShippingAddressUpdateSheet address={address} />
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
