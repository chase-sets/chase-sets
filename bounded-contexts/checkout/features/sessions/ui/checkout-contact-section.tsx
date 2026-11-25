import { t } from "@chase-sets/localization";
import {
  Checkbox,
  CheckoutFormSection,
  CheckoutStateNotice,
  HiddenInput,
  LinkButton,
  Surface,
  TextInput,
} from "@chase-sets/design-system";
import type { GuestContactAttempt } from "./checkout-page-types";

/** A guest's contact entry before Auth holds it: the name entered and why the last save failed. */
export type CheckoutGuestContactEntry = Readonly<{
  contactName: string;
  problem: GuestContactAttempt["problem"] | null;
  signInHref: string | null;
}>;

export type CheckoutContactSectionProps = Readonly<{
  showContactForm: boolean;
  isOfferIntent: boolean;
  email: string;
  /** Set for a guest whose contact is not saved: the section asks for a name as well as the email. */
  guestEntry?: CheckoutGuestContactEntry | null;
  /** Auth could not be read, so the contact is neither shown nor editable. */
  guestContactUnavailable?: boolean;
  /** A save tried to change the guest's saved contact. */
  guestContactLocked?: boolean;
}>;

/** The Contact step: an editable form while the step is active, or a hidden
 * mirror of the collected email once it collapses into the saved-info
 * summary. A guest also enters a name, and both are saved to Auth before the
 * checkout writes anything. */
export function CheckoutContactSection({
  showContactForm,
  isOfferIntent,
  email,
  guestEntry = null,
  guestContactUnavailable = false,
  guestContactLocked = false,
}: CheckoutContactSectionProps) {
  if (guestContactUnavailable) {
    return (
      <CheckoutStateNotice
        tone="warning"
        title={t("checkout.features.sessions.ui.checkoutPage.contact.unavailable.title")}
        description={t("checkout.features.sessions.ui.checkoutPage.contact.unavailable.description")}
      />
    );
  }

  if (!showContactForm) {
    return (
      <>
        <HiddenInput type="hidden" name="shippingEmail" value={email} />
        {guestContactLocked ? (
          <CheckoutStateNotice tone="info" title={t("checkout.features.sessions.ui.checkoutPage.contact.locked")} />
        ) : null}
      </>
    );
  }

  const emailError =
    guestEntry?.problem === "sign-in-required"
      ? t("checkout.features.sessions.ui.checkoutPage.contact.sign.in.required")
      : guestEntry?.problem === "invalid"
        ? t("checkout.features.sessions.ui.checkoutPage.contact.invalid")
        : undefined;

  return (
    <Surface elevation="tinted">
      <CheckoutFormSection title={t("checkout.features.sessions.ui.checkoutPage.contact")}>
        {guestEntry ? (
          <TextInput
            label={t("checkout.features.sessions.ui.checkoutPage.contact.name")}
            name="contactName"
            defaultValue={guestEntry.contactName}
            autoComplete="name"
            required
          />
        ) : null}
        <TextInput
          label={t("checkout.features.sessions.ui.checkoutPage.email")}
          name="shippingEmail"
          type="email"
          defaultValue={email}
          autoComplete="email"
          required={!isOfferIntent}
          error={emailError}
        />
        {guestEntry?.problem === "sign-in-required" && guestEntry.signInHref ? (
          <LinkButton href={guestEntry.signInHref} tone="secondary" size="sm" leadingIcon="lock">
            {t("checkout.features.sessions.ui.checkoutPage.contact.sign.in")}
          </LinkButton>
        ) : null}
        {guestEntry?.problem === "retry-later" ? (
          <CheckoutStateNotice
            tone="warning"
            title={t("checkout.features.sessions.ui.checkoutPage.contact.retry.later")}
          />
        ) : null}
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
