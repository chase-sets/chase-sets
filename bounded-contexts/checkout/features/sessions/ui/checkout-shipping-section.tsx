import { formatMoney, t } from "@chase-sets/localization";
import {
  Checkbox,
  CheckoutFormSection,
  CheckoutStateNotice,
  HiddenInput,
  NativeSelect,
  Surface,
} from "@chase-sets/design-system";
import { deliveryWindowLabel, shippingOptionLabel } from "./checkout-page-formatting";
import type { CheckoutFulfillmentPreview, CheckoutSessionRow } from "../../../support/request-support/api-client";

export type CheckoutAuthenticityCheckOffer = Readonly<{
  eligible: boolean;
  fee_amount: string;
  quote_fingerprint: string;
}>;

export type CheckoutShippingSectionProps = Readonly<{
  showShippingMethodForm: boolean;
  shippingOption: CheckoutSessionRow["shipping_option"];
  firstDeliveryGroup: CheckoutFulfillmentPreview["sellerGroups"][number] | null;
  authenticityCheckEligible: boolean;
  authenticityCheckOffer: CheckoutAuthenticityCheckOffer | null;
  authenticityCheckSelected: boolean;
  authenticityCheckStoredQuoteFingerprint: string;
  onFieldChange: () => void;
}>;

/** The Shipping method step: the shipping-option form plus the delivery
 * estimate and authenticity-check opt-in, or a hidden mirror once the step
 * collapses. */
export function CheckoutShippingSection({
  showShippingMethodForm,
  shippingOption,
  firstDeliveryGroup,
  authenticityCheckEligible,
  authenticityCheckOffer,
  authenticityCheckSelected,
  authenticityCheckStoredQuoteFingerprint,
  onFieldChange,
}: CheckoutShippingSectionProps) {
  if (!showShippingMethodForm) {
    return (
      <>
        <HiddenInput type="hidden" name="shippingOption" value={shippingOption} />
        <HiddenInput type="hidden" name="authenticityCheckOptIn" value={authenticityCheckSelected ? "true" : "false"} />
      </>
    );
  }

  return (
    <Surface elevated>
      <CheckoutFormSection
        title={t("checkout.features.sessions.ui.checkoutPage.shipping.method")}
        description={t("checkout.features.sessions.ui.checkoutPage.shipping.method.description")}
      >
        <NativeSelect
          label={t("checkout.features.sessions.ui.checkoutPage.shipping.option")}
          name="shippingOption"
          defaultValue={shippingOption}
          onChange={onFieldChange}
          items={[
            { value: "standard", label: t("checkout.features.sessions.ui.checkoutPage.standard.insured") },
            { value: "expedited", label: t("checkout.features.sessions.ui.checkoutPage.expedited") },
            { value: "priority", label: t("checkout.features.sessions.ui.checkoutPage.priority") },
          ]}
        />
        {firstDeliveryGroup ? (
          <CheckoutStateNotice
            tone="info"
            title={t("checkout.features.sessions.ui.checkoutPage.delivery.estimate")}
            description={t("checkout.features.sessions.ui.checkoutPage.delivery.estimate.summary", {
              window: deliveryWindowLabel(firstDeliveryGroup),
              packageCount: firstDeliveryGroup.deliveryEstimate.packageCount,
              serviceLevel: firstDeliveryGroup.deliveryEstimate.serviceLevel,
              shippingOption: shippingOptionLabel(shippingOption),
            })}
          />
        ) : (
          <CheckoutStateNotice
            tone="info"
            title={t("checkout.features.sessions.ui.checkoutPage.shipping.after.address")}
            description={t("checkout.features.sessions.ui.checkoutPage.shipping.after.address.description")}
          />
        )}
        {authenticityCheckEligible && authenticityCheckOffer ? (
          <>
            <Checkbox
              label={t("checkout.features.sessions.ui.checkoutPage.authenticity.check.opt.in", {
                amount: formatMoney(authenticityCheckOffer.fee_amount, "USD"),
              })}
              description={t("checkout.features.sessions.ui.checkoutPage.authenticity.check.opt.in.description")}
              name="authenticityCheckOptIn"
              value="true"
              defaultChecked={authenticityCheckSelected}
              onCheckedChange={onFieldChange}
            />
            <HiddenInput
              type="hidden"
              name="authenticityCheckOptInQuoteFingerprint"
              value={authenticityCheckOffer.quote_fingerprint}
            />
          </>
        ) : (
          <HiddenInput
            type="hidden"
            name="authenticityCheckOptInQuoteFingerprint"
            value={authenticityCheckStoredQuoteFingerprint}
          />
        )}
      </CheckoutFormSection>
    </Surface>
  );
}
