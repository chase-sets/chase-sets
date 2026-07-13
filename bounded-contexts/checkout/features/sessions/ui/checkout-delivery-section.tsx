import { t } from "@chase-sets/localization";
import {
  CheckoutFormSection,
  Grid,
  HiddenInput,
  NativeSelect,
  ProgressiveDisclosure,
  Surface,
  TextInput,
} from "@chase-sets/design-system";
import type { CheckoutAddressDefaults, CheckoutSavedShippingAddress } from "./checkout-page-types";

export type CheckoutDeliverySectionProps = Readonly<{
  showDeliveryForm: boolean;
  isOfferIntent: boolean;
  savedAddressesForCheckout: readonly CheckoutSavedShippingAddress[];
  addressDefaults: CheckoutAddressDefaults;
  canManageAddressBookInCheckout: boolean;
  onFieldChange: () => void;
}>;

// Checkout delivery serviceability is currently limited to the United States.
const shippingCountryItems = [
  {
    value: "US",
    label: t("checkout.features.sessions.ui.checkoutPage.country.united.states"),
  },
];

/** The Delivery step: the shipping-address form (with an optional saved
 * address picker and address-book preferences) while active, or a hidden
 * mirror of the collected address once it collapses. */
export function CheckoutDeliverySection({
  showDeliveryForm,
  isOfferIntent,
  savedAddressesForCheckout,
  addressDefaults,
  canManageAddressBookInCheckout,
  onFieldChange,
}: CheckoutDeliverySectionProps) {
  if (!showDeliveryForm) {
    return (
      <>
        <HiddenInput type="hidden" name="shippingAddressId" value={addressDefaults.shippingAddressId} />
        <HiddenInput type="hidden" name="shippingName" value={addressDefaults.name} />
        <HiddenInput type="hidden" name="shippingCompany" value={addressDefaults.company} />
        <HiddenInput type="hidden" name="shippingCountry" value={addressDefaults.country} />
        <HiddenInput type="hidden" name="shippingLine1" value={addressDefaults.line1} />
        <HiddenInput type="hidden" name="shippingLine2" value={addressDefaults.line2} />
        <HiddenInput type="hidden" name="shippingCity" value={addressDefaults.city} />
        <HiddenInput type="hidden" name="shippingState" value={addressDefaults.state} />
        <HiddenInput type="hidden" name="shippingPostalCode" value={addressDefaults.postalCode} />
        <HiddenInput type="hidden" name="shippingPhone" value={addressDefaults.phone} />
      </>
    );
  }

  return (
    <Surface elevated>
      <CheckoutFormSection
        title={t("checkout.features.sessions.ui.checkoutPage.delivery")}
        description={
          isOfferIntent
            ? t("checkout.features.sessions.ui.checkoutPage.destination.required.for.purchase.intent")
            : t("checkout.features.sessions.ui.checkoutPage.destination.required.for.sales.tax")
        }
      >
        {savedAddressesForCheckout.length > 0 ? (
          <NativeSelect
            label={t("checkout.features.sessions.ui.checkoutPage.saved.shipping.address")}
            name="shippingAddressId"
            defaultValue={addressDefaults.shippingAddressId}
            onChange={onFieldChange}
            items={[
              {
                value: "__manual",
                label: t("checkout.features.sessions.ui.checkoutPage.enter.a.new.address"),
              },
              ...savedAddressesForCheckout.map((address) => ({
                value: address.shipping_address_id,
                label: address.is_default
                  ? t("checkout.features.sessions.ui.checkoutPage.default.address.option", {
                      label: address.label,
                    })
                  : address.label,
              })),
            ]}
          />
        ) : null}
        <Grid columns={{ base: 1, md: 2 }} gap={3}>
          <TextInput
            label={t("checkout.features.sessions.ui.checkoutPage.recipient.name")}
            name="shippingName"
            placeholder={t("checkout.features.sessions.ui.checkoutPage.recipient.placeholder")}
            defaultValue={addressDefaults.name}
            autoComplete="shipping name"
            onChange={onFieldChange}
            required
          />
          <TextInput
            label={t("checkout.features.sessions.ui.checkoutPage.company")}
            name="shippingCompany"
            defaultValue={addressDefaults.company}
            autoComplete="shipping organization"
            onChange={onFieldChange}
          />
          <NativeSelect
            label={t("checkout.features.sessions.ui.checkoutPage.country")}
            name="shippingCountry"
            defaultValue={addressDefaults.country}
            autoComplete="shipping country"
            onChange={onFieldChange}
            items={shippingCountryItems}
          />
          <TextInput
            label={t("checkout.features.sessions.ui.checkoutPage.address.line1")}
            name="shippingLine1"
            defaultValue={addressDefaults.line1}
            autoComplete="shipping address-line1"
            onChange={onFieldChange}
            required
          />
          <TextInput
            label={t("checkout.features.sessions.ui.checkoutPage.address.line2")}
            name="shippingLine2"
            defaultValue={addressDefaults.line2}
            autoComplete="shipping address-line2"
            onChange={onFieldChange}
          />
          <TextInput
            label={t("checkout.features.sessions.ui.checkoutPage.city")}
            name="shippingCity"
            defaultValue={addressDefaults.city}
            autoComplete="shipping address-level2"
            onChange={onFieldChange}
            required
          />
          <TextInput
            label={t("checkout.features.sessions.ui.checkoutPage.state")}
            name="shippingState"
            defaultValue={addressDefaults.state}
            autoComplete="shipping address-level1"
            onChange={onFieldChange}
            required
          />
          <TextInput
            label={t("checkout.features.sessions.ui.checkoutPage.postal.code")}
            name="shippingPostalCode"
            defaultValue={addressDefaults.postalCode}
            autoComplete="shipping postal-code"
            inputMode="numeric"
            onChange={onFieldChange}
            required
          />
          <TextInput
            label={t("checkout.features.sessions.ui.checkoutPage.phone")}
            name="shippingPhone"
            defaultValue={addressDefaults.phone}
            type="tel"
            autoComplete="shipping tel"
            inputMode="tel"
            onChange={onFieldChange}
          />
        </Grid>
        {canManageAddressBookInCheckout ? (
          <ProgressiveDisclosure
            title={t("checkout.features.sessions.ui.checkoutPage.address.preferences")}
            summary={
              savedAddressesForCheckout.length > 0
                ? t("checkout.features.sessions.ui.checkoutPage.use.for.this.checkout")
                : t("checkout.features.sessions.ui.checkoutPage.save.as.new.address")
            }
            tone="info"
          >
            <Grid columns={{ base: 1, md: 2 }} gap={3}>
              <NativeSelect
                label={t("checkout.features.sessions.ui.checkoutPage.address.book.preference")}
                name="addressBookAction"
                defaultValue={savedAddressesForCheckout.length > 0 ? "checkout-only" : "save-new"}
                items={[
                  {
                    value: "checkout-only",
                    label: t("checkout.features.sessions.ui.checkoutPage.use.for.this.checkout"),
                  },
                  {
                    value: "save-new",
                    label: t("checkout.features.sessions.ui.checkoutPage.save.as.new.address"),
                  },
                  {
                    value: "update-selected",
                    label: t("checkout.features.sessions.ui.checkoutPage.update.selected.address"),
                  },
                ]}
              />
              <NativeSelect
                label={t("checkout.features.sessions.ui.checkoutPage.default.address")}
                name="makeDefaultShippingAddress"
                defaultValue="false"
                items={[
                  {
                    value: "false",
                    label: t("checkout.features.sessions.ui.checkoutPage.do.not.change.default"),
                  },
                  {
                    value: "true",
                    label: t("checkout.features.sessions.ui.checkoutPage.make.this.default"),
                  },
                ]}
              />
            </Grid>
          </ProgressiveDisclosure>
        ) : null}
      </CheckoutFormSection>
    </Surface>
  );
}
