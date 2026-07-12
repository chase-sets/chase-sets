import { t } from "@chase-sets/localization";
import { Button, CheckoutSavedInfoGroup, CheckoutSavedInfoRow } from "@chase-sets/design-system";
import {
  addressSummary,
  contactSupportingText,
  deliveryWindowLabel,
  shippingOptionLabel,
} from "./checkout-page-formatting";
import type {
  CheckoutAddressDefaults,
  CheckoutEditSection,
  CheckoutPaymentPreview,
  CheckoutSavedPaymentInstrument,
} from "./checkout-page-types";
import type { CheckoutFulfillmentPreview, CheckoutSessionRow } from "../../../support/request-support/api-client";

function editRowAction(
  section: CheckoutEditSection,
  label: string,
  onEditSection: (section: CheckoutEditSection) => void,
) {
  return (
    <Button type="button" tone="secondary" size="sm" leadingIcon="edit" onClick={() => onEditSection(section)}>
      {label}
    </Button>
  );
}

export type CheckoutSavedInfoSectionProps = Readonly<{
  showSavedCheckoutRows: boolean;
  contactReady: boolean;
  deliveryReady: boolean;
  shippingMethodReady: boolean;
  paymentMethodReady: boolean;
  addressDefaults: CheckoutAddressDefaults;
  firstDeliveryGroup: CheckoutFulfillmentPreview["sellerGroups"][number] | null;
  shippingOption: CheckoutSessionRow["shipping_option"];
  selectedSavedPaymentInstrument: CheckoutSavedPaymentInstrument | null;
  payment: CheckoutPaymentPreview | null;
  canEditCollapsedContact: boolean;
  selectedPaymentSupportingText: string;
  onEditSection: (section: CheckoutEditSection) => void;
}>;

/** The collapsed "Checkout details" summary for steps that already have
 * ready, saved data — each row exposes an edit affordance back into the
 * matching step section. */
export function CheckoutSavedInfoSection({
  showSavedCheckoutRows,
  contactReady,
  deliveryReady,
  shippingMethodReady,
  paymentMethodReady,
  addressDefaults,
  firstDeliveryGroup,
  shippingOption,
  selectedSavedPaymentInstrument,
  payment,
  canEditCollapsedContact,
  selectedPaymentSupportingText,
  onEditSection,
}: CheckoutSavedInfoSectionProps) {
  if (!showSavedCheckoutRows) {
    return null;
  }

  return (
    <CheckoutSavedInfoGroup title={t("checkout.features.sessions.ui.checkoutPage.saved.checkout.details")}>
      {contactReady ? (
        <CheckoutSavedInfoRow
          icon="user"
          label={t("checkout.features.sessions.ui.checkoutPage.contact")}
          value={addressDefaults.email}
          supportingText={contactSupportingText(addressDefaults.phone)}
          status={t("checkout.features.sessions.ui.checkoutPage.ready")}
          statusTone="success"
          action={
            canEditCollapsedContact
              ? editRowAction("contact", t("checkout.features.sessions.ui.checkoutPage.edit.contact"), onEditSection)
              : undefined
          }
        />
      ) : null}
      {deliveryReady ? (
        <CheckoutSavedInfoRow
          icon="home"
          label={t("checkout.features.sessions.ui.checkoutPage.ship.to")}
          value={addressDefaults.name}
          supportingText={addressSummary(addressDefaults)}
          status={t("checkout.features.sessions.ui.checkoutPage.ready")}
          statusTone="success"
          action={editRowAction(
            "delivery",
            t("checkout.features.sessions.ui.checkoutPage.edit.delivery"),
            onEditSection,
          )}
        />
      ) : null}
      {shippingMethodReady && firstDeliveryGroup ? (
        <CheckoutSavedInfoRow
          icon="truck"
          label={t("checkout.features.sessions.ui.checkoutPage.shipping")}
          value={shippingOptionLabel(shippingOption)}
          supportingText={t("checkout.features.sessions.ui.checkoutPage.delivery.estimate.summary", {
            window: deliveryWindowLabel(firstDeliveryGroup),
            packageCount: firstDeliveryGroup.deliveryEstimate.packageCount,
            serviceLevel: firstDeliveryGroup.deliveryEstimate.serviceLevel,
            shippingOption: shippingOptionLabel(shippingOption),
          })}
          status={t("checkout.features.sessions.ui.checkoutPage.ready")}
          statusTone="success"
          action={editRowAction(
            "shipping",
            t("checkout.features.sessions.ui.checkoutPage.edit.shipping"),
            onEditSection,
          )}
        />
      ) : null}
      {paymentMethodReady && selectedSavedPaymentInstrument ? (
        <CheckoutSavedInfoRow
          icon="creditCard"
          label={t("checkout.features.sessions.ui.checkoutPage.payment")}
          value={selectedSavedPaymentInstrument.display_label}
          supportingText={selectedPaymentSupportingText}
          status={
            payment
              ? t("checkout.features.sessions.ui.checkoutPage.ready")
              : t("checkout.features.sessions.ui.checkoutPage.review.required")
          }
          statusTone={payment ? "success" : "warning"}
          action={editRowAction("payment", t("checkout.features.sessions.ui.checkoutPage.edit.payment"), onEditSection)}
        />
      ) : null}
    </CheckoutSavedInfoGroup>
  );
}
