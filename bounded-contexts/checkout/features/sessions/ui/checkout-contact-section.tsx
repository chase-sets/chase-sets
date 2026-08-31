import { t } from "@chase-sets/localization";
import { Checkbox, CheckoutFormSection, HiddenInput, Surface, TextInput } from "@chase-sets/design-system";

export type CheckoutContactSectionProps = Readonly<{
  showContactForm: boolean;
  isOfferIntent: boolean;
  email: string;
}>;

/** The Contact step: an editable email form while the step is active, or a
 * hidden mirror of the collected email once it collapses into the saved-info
 * summary. */
export function CheckoutContactSection({ showContactForm, isOfferIntent, email }: CheckoutContactSectionProps) {
  if (!showContactForm) {
    return <HiddenInput type="hidden" name="shippingEmail" value={email} />;
  }

  return (
    <Surface elevation="tinted">
      <CheckoutFormSection title={t("checkout.features.sessions.ui.checkoutPage.contact")}>
        <TextInput
          label={t("checkout.features.sessions.ui.checkoutPage.email")}
          name="shippingEmail"
          type="email"
          defaultValue={email}
          autoComplete="email"
          required={!isOfferIntent}
        />
        {!isOfferIntent ? (
          <Checkbox
            label={t("checkout.features.sessions.ui.checkoutPage.email.me.with.news")}
            name="marketingOptIn"
            value="true"
          />
        ) : null}
      </CheckoutFormSection>
    </Surface>
  );
}
