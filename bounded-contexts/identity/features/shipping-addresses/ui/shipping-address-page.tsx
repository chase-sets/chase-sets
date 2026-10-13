import { t } from "@chase-sets/localization";
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
  ValidationSummary,
  type NormalizedFormErrors,
  hasFormErrors,
} from "@chase-sets/design-system";
import type { ShippingAddress } from "./contracts";
import { SHIPPING_ADDRESS_REQUIRED_MESSAGES } from "../domain/errors";

type AddressErrors = NormalizedFormErrors<Record<string, string>>;

export interface ShippingAddressFailure {
  intent: string;
  shippingAddressId?: string;
  errors: AddressErrors;
}

type FocusSummary = (element: HTMLElement | null, failure: ShippingAddressFailure) => void;

function FailureSummary({ failure, focusSummary }: { failure: ShippingAddressFailure; focusSummary: FocusSummary }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    focusSummary(ref.current, failure);
  }, [failure, focusSummary]);
  return (
    <ValidationSummary
      ref={ref}
      errors={[
        ...Object.values(failure.errors.fieldErrors).flatMap((messages) => messages ?? []),
        ...failure.errors.formErrors,
      ].map((message) => ({ message }))}
    />
  );
}

function AddressFormContent({
  address,
  failure,
  focusSummary,
}: {
  address?: ShippingAddress;
  failure?: ShippingAddressFailure | null;
  focusSummary: FocusSummary;
}) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const errors = failure?.errors;
  const summary = [
    ...Object.entries(errors?.fieldErrors ?? {}).flatMap(([field, messages]) =>
      (messages ?? []).map((message) => ({ message, fieldId: `${id}-${field}` })),
    ),
    ...(errors?.formErrors ?? []).map((message) => ({ message })),
  ];
  useEffect(() => {
    if (failure) focusSummary(ref.current, failure);
  }, [failure, focusSummary]);
  return (
    <Stack gap={3}>
      <HiddenInput type="hidden" name="intent" value={address ? "update" : "create"} />
      {address ? <HiddenInput type="hidden" name="shippingAddressId" value={address.shipping_address_id} /> : null}
      <ValidationSummary ref={ref} errors={summary} />
      <AddressFields address={address} id={id} errors={errors} />
      <Button type="submit" tone={address ? "secondary" : "primary"} leadingIcon={address ? undefined : "plus"}>
        {t(
          address
            ? "identity.features.shippingAddresses.ui.shippingAddressPage.update.address"
            : "identity.features.shippingAddresses.ui.shippingAddressPage.save.address",
        )}
      </Button>
    </Stack>
  );
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

function AddressFields({ address, id, errors }: { address?: ShippingAddress; id: string; errors?: AddressErrors }) {
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
        id={`${id}-name`}
        error={errors?.fieldErrors.name?.[0]}
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
        id={`${id}-country`}
        error={errors?.fieldErrors.country?.[0]}
        autoComplete="country"
        defaultValue={address?.country ?? "US"}
        required
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.address.line1")}
        name="line1"
        id={`${id}-line1`}
        error={errors?.fieldErrors.line1?.[0]}
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
        id={`${id}-city`}
        error={errors?.fieldErrors.city?.[0]}
        autoComplete="address-level2"
        defaultValue={address?.city ?? ""}
        required
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.state")}
        name="state"
        id={`${id}-state`}
        error={errors?.fieldErrors.state?.[0]}
        autoComplete="address-level1"
        defaultValue={address?.state ?? ""}
        required
      />
      <TextInput
        label={t("identity.features.shippingAddresses.ui.shippingAddressPage.postal.code")}
        name="postalCode"
        id={`${id}-postalCode`}
        error={errors?.fieldErrors.postalCode?.[0]}
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
  failure = null,
  submitting = false,
  locationKey,
}: {
  addresses: readonly ShippingAddress[];
  errorMessage?: string | null;
  failure?: ShippingAddressFailure | null;
  submitting?: boolean;
  locationKey?: string;
}) {
  const [activeFailure, setActiveFailure] = useState(failure);
  const [openAddressId, setOpenAddressId] = useState<string | null>(null);
  const [unavailableFailure, setUnavailableFailure] = useState<ShippingAddressFailure | null>(null);
  const previousLocation = useRef(locationKey);
  const focusedFailure = useRef<ShippingAddressFailure | null>(null);
  const focusSummary = useCallback<FocusSummary>((element, result) => {
    if (element && focusedFailure.current !== result) {
      focusedFailure.current = result;
      element.focus();
    }
  }, []);
  useEffect(() => {
    if (failure) {
      setActiveFailure(failure);
      setOpenAddressId(
        failure.intent === "update" && Object.keys(failure.errors.fieldErrors).length
          ? (failure.shippingAddressId ?? null)
          : null,
      );
    } else if (previousLocation.current !== locationKey) {
      setActiveFailure(null);
      setOpenAddressId(null);
    }
    previousLocation.current = locationKey;
  }, [failure, locationKey]);
  useEffect(() => {
    if (submitting) setActiveFailure(null);
  }, [submitting]);
  const submittedRowExists =
    activeFailure?.intent === "update" &&
    addresses.some((address) => address.shipping_address_id === activeFailure.shippingAddressId);
  useEffect(() => {
    if (activeFailure?.intent === "update" && !submittedRowExists) {
      setUnavailableFailure(activeFailure);
      setOpenAddressId(null);
    }
  }, [activeFailure, submittedRowExists]);
  const fieldsMounted =
    activeFailure &&
    Object.keys(activeFailure.errors.fieldErrors).every((field) =>
      Object.hasOwn(SHIPPING_ADDRESS_REQUIRED_MESSAGES, field),
    );
  const createFailure = fieldsMounted && activeFailure.intent === "create" ? activeFailure : null;
  const updateFailure =
    fieldsMounted &&
    Object.keys(activeFailure.errors.fieldErrors).length > 0 &&
    activeFailure.intent === "update" &&
    submittedRowExists &&
    unavailableFailure !== activeFailure
      ? activeFailure
      : null;
  const pageFailure = activeFailure && !createFailure && !updateFailure ? activeFailure : null;
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

      {pageFailure ? (
        <FailureSummary failure={pageFailure} focusSummary={focusSummary} />
      ) : !activeFailure && errorMessage ? (
        <ValidationSummary errors={[{ message: errorMessage }]} />
      ) : null}

      <PageSection
        title={t("identity.features.shippingAddresses.ui.shippingAddressPage.add.shipping.address")}
        description={t("identity.features.shippingAddresses.ui.shippingAddressPage.add.description")}
      >
        <Surface elevation="tinted">
          <Form
            spacing="none"
            method="post"
            onSubmit={() => setActiveFailure(null)}
            errorAnnouncement={createFailure && hasFormErrors(createFailure.errors) ? "summary" : "inline"}
          >
            <AddressFormContent failure={createFailure} focusSummary={focusSummary} />
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
                    <ResponsiveEditSheet
                      open={openAddressId === address.shipping_address_id}
                      onOpenChange={(open) => {
                        setActiveFailure(null);
                        setOpenAddressId(open ? address.shipping_address_id : null);
                      }}
                      title={t("identity.features.shippingAddresses.ui.shippingAddressPage.update.address")}
                      description={t("identity.features.shippingAddresses.ui.shippingAddressPage.saved.description")}
                      trigger={
                        <Button type="button" tone="secondary">
                          {t("identity.features.shippingAddresses.ui.shippingAddressPage.update.address")}
                        </Button>
                      }
                    >
                      <Form
                        spacing="none"
                        method="post"
                        onSubmit={() => setActiveFailure(null)}
                        errorAnnouncement={
                          updateFailure?.shippingAddressId === address.shipping_address_id &&
                          hasFormErrors(updateFailure.errors)
                            ? "summary"
                            : "inline"
                        }
                      >
                        <AddressFormContent
                          address={address}
                          focusSummary={focusSummary}
                          failure={
                            updateFailure?.shippingAddressId === address.shipping_address_id ? updateFailure : null
                          }
                        />
                      </Form>
                    </ResponsiveEditSheet>
                    {!address.is_default ? (
                      <Form spacing="none" method="post" onSubmit={() => setActiveFailure(null)}>
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
                      <Form spacing="none" method="post" onSubmit={() => setActiveFailure(null)}>
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
