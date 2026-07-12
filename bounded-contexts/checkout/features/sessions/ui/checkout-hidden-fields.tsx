import { HiddenInput } from "@chase-sets/design-system";
import { normalizedAddressSignature } from "./checkout-page-formatting";
import type { CheckoutAddressDefaults } from "./checkout-page-types";

export type CheckoutFormLevelHiddenFieldsProps = Readonly<{
  fulfillmentPreviewRevision: string | null | undefined;
  marketplaceCheckoutFeeQuoteFingerprint: string | null | undefined;
  requestedBalanceCreditAmount: string;
  effectivePaymentMethodCategory: string;
  canUseAcceleratedSavedPayment: boolean;
  sourceType: string;
  shippingOption: string;
  addressDefaults: CheckoutAddressDefaults;
  hasAcknowledgedVisibleFulfillmentPreview: boolean;
}>;

/** Hidden fields mirroring checkout-wide form state that every submission
 * needs regardless of which step sections are currently collapsed. */
export function CheckoutFormLevelHiddenFields({
  fulfillmentPreviewRevision,
  marketplaceCheckoutFeeQuoteFingerprint,
  requestedBalanceCreditAmount,
  effectivePaymentMethodCategory,
  canUseAcceleratedSavedPayment,
  sourceType,
  shippingOption,
  addressDefaults,
  hasAcknowledgedVisibleFulfillmentPreview,
}: CheckoutFormLevelHiddenFieldsProps) {
  return (
    <>
      <HiddenInput type="hidden" name="fulfillmentPreviewRevision" value={fulfillmentPreviewRevision ?? ""} />
      <HiddenInput
        type="hidden"
        name="marketplaceCheckoutFeeQuoteFingerprint"
        value={marketplaceCheckoutFeeQuoteFingerprint ?? ""}
      />
      <HiddenInput type="hidden" name="requestedBalanceCreditAmount" value={requestedBalanceCreditAmount} />
      <HiddenInput type="hidden" name="paymentMethodCategory" value={effectivePaymentMethodCategory} />
      <HiddenInput
        type="hidden"
        name="acceleratedSavedPayment"
        value={canUseAcceleratedSavedPayment ? "true" : "false"}
      />
      <HiddenInput type="hidden" name="sourceType" value={sourceType} />
      <HiddenInput type="hidden" name="reviewedShippingOption" value={shippingOption} />
      <HiddenInput
        type="hidden"
        name="reviewedShippingAddressSignature"
        value={normalizedAddressSignature(addressDefaults)}
      />
      <HiddenInput
        type="hidden"
        name="acknowledgedMaterialChanges"
        value={hasAcknowledgedVisibleFulfillmentPreview ? "true" : ""}
      />
    </>
  );
}
