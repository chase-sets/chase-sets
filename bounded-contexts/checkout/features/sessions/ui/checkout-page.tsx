import { t } from "@chase-sets/localization";
import {
  CheckoutFlowShell,
  CheckoutNoticeStack,
  CheckoutStateNotice,
  Form,
  Page,
  PageHeader,
  PageStepper,
  Stack,
} from "@chase-sets/design-system";
import {
  CheckoutBackToCartAction,
  CheckoutEmptyCartState,
  CheckoutInFormCommitRow,
  CheckoutStickyAction,
  type CheckoutCommitButtonProps,
} from "./checkout-commit-actions";
import { CheckoutContactSection } from "./checkout-contact-section";
import { CheckoutDeliverySection } from "./checkout-delivery-section";
import { CheckoutFormLevelHiddenFields } from "./checkout-hidden-fields";
import {
  CheckoutConfirmationSection,
  CheckoutMobileSummarySection,
  CheckoutOrderSummarySection,
  type CheckoutOrderSummarySectionProps,
} from "./checkout-order-summary-section";
import { CheckoutPaymentSection } from "./checkout-payment-section";
import { CheckoutPolicyLinks } from "./checkout-policy-links";
import { CheckoutSavedInfoSection } from "./checkout-saved-info-section";
import { CheckoutShippingSection } from "./checkout-shipping-section";
import { useCheckoutSessionModel } from "./use-checkout-session-model";
import type { CheckoutSessionPageProps } from "./checkout-page-types";

export type {
  CheckoutAddressDefaults,
  CheckoutEditSection,
  CheckoutPaymentMethodCategory,
  CheckoutPaymentPreview,
  CheckoutReservationUnavailableLine,
  CheckoutSavedPaymentInstrument,
  CheckoutSavedShippingAddress,
  CheckoutSessionPageProps,
  GuestCheckoutContact,
} from "./checkout-page-types";

export function CheckoutSessionPage(props: CheckoutSessionPageProps) {
  const model = useCheckoutSessionModel(props);

  const commitButtonProps: CheckoutCommitButtonProps = {
    hasPayment: model.hasPayment,
    paymentId: model.session.payment_id,
    isOfferIntent: model.isOfferIntent,
    reservationExpired: model.reservationExpired,
    reReserveIntent: model.reReserveIntent,
    canConfirm: model.canConfirm,
    commitIntent: model.commitIntent,
    commitIcon: model.commitIcon,
    isSubmitting: model.isSubmitting,
    submittingCtaLabel: model.submittingCtaLabel,
    primaryCtaLabel: model.primaryCtaLabel,
  };

  const orderSummaryProps: CheckoutOrderSummarySectionProps = {
    lineCount: model.lineCount,
    orderSummaryItems: model.orderSummaryItems,
    totalsLines: model.totalsLines,
    totalsTotalLabel: model.totalsTotalLabel,
    totalsTotal: model.totalsTotal,
    totalsCaption: model.totalsCaption,
    totalsDeferred: model.totalsDeferred,
    isOfferIntent: model.isOfferIntent,
    authenticityCheckShowsInTotals: model.authenticityCheckShowsInTotals,
  };

  const main = (
    <Stack gap={5}>
      <PageStepper
        items={model.stepperItems}
        aria-label={t("checkout.features.sessions.ui.checkoutPage.checkout.steps")}
      />

      {model.errorMessage ? (
        <CheckoutStateNotice
          tone="danger"
          title={t("checkout.features.sessions.ui.checkoutPage.checkout.issue")}
          description={model.errorMessage}
        />
      ) : null}

      <CheckoutNoticeStack candidates={model.noticeCandidates} />

      {model.session.payment_id ? (
        <CheckoutConfirmationSection
          paymentId={model.session.payment_id}
          orderReferenceValue={model.orderReferenceValue}
          buySupportReferenceValue={model.buySupportReferenceValue}
          totalsPayableTotal={model.totalsTotal}
        />
      ) : (
        <Form spacing="none" id="checkout-confirmation-form" method="post">
          <Stack gap={4}>
            <CheckoutFormLevelHiddenFields
              fulfillmentPreviewRevision={model.preview?.revision}
              marketplaceCheckoutFeeQuoteFingerprint={model.payment?.marketplace_checkout_fee.quote_fingerprint}
              requestedBalanceCreditAmount={
                model.payment?.wallet_credit.requested_amount ?? model.wallet?.available_balance_amount ?? "0.00"
              }
              effectivePaymentMethodCategory={model.effectivePaymentMethodCategory}
              canUseAcceleratedSavedPayment={model.canUseAcceleratedSavedPayment}
              sourceType={model.session.source_type}
              shippingOption={model.session.shipping_option}
              addressDefaults={model.addressDefaults}
              hasAcknowledgedVisibleFulfillmentPreview={model.hasAcknowledgedVisibleFulfillmentPreview}
            />

            <CheckoutSavedInfoSection
              showSavedCheckoutRows={model.showSavedCheckoutRows}
              contactReady={model.contactReady}
              deliveryReady={model.deliveryReady}
              shippingMethodReady={model.shippingMethodReady}
              paymentMethodReady={model.paymentMethodReady}
              addressDefaults={model.addressDefaults}
              firstDeliveryGroup={model.firstDeliveryGroup}
              shippingOption={model.session.shipping_option}
              selectedSavedPaymentInstrument={model.selectedSavedPaymentInstrument}
              payment={model.payment}
              canEditCollapsedContact={model.canEditCollapsedContact}
              selectedPaymentSupportingText={model.selectedPaymentSupportingText}
              onEditSection={model.setEditingSection}
            />

            <CheckoutContactSection
              showContactForm={model.showContactForm}
              isOfferIntent={model.isOfferIntent}
              email={model.addressDefaults.email}
            />

            <CheckoutDeliverySection
              showDeliveryForm={model.showDeliveryForm}
              isOfferIntent={model.isOfferIntent}
              savedAddressesForCheckout={model.savedAddressesForCheckout}
              addressDefaults={model.addressDefaults}
              canManageAddressBookInCheckout={model.canManageAddressBookInCheckout}
              onFieldChange={model.markReviewStale}
            />

            <CheckoutShippingSection
              showShippingMethodForm={model.showShippingMethodForm}
              shippingOption={model.session.shipping_option}
              firstDeliveryGroup={model.firstDeliveryGroup}
              authenticityCheckEligible={model.authenticityCheckEligible}
              authenticityCheckOffer={model.authenticityCheckOffer}
              authenticityCheckSelected={model.authenticityCheckSelected}
              authenticityCheckStoredQuoteFingerprint={model.session.authenticity_check_opt_in?.quoteFingerprint ?? ""}
              onFieldChange={model.markReviewStale}
            />

            <CheckoutPaymentSection
              isOfferIntent={model.isOfferIntent}
              showPaymentForm={model.showPaymentForm}
              effectivePaymentMethodCategory={model.effectivePaymentMethodCategory}
              supportedPaymentMethodCategories={model.supportedPaymentMethodCategories}
              savedPaymentInstrumentsForEffectiveMethod={model.savedPaymentInstrumentsForEffectiveMethod}
              selectedSavedPaymentInstrument={model.selectedSavedPaymentInstrument}
              canSavePaymentMethods={model.canSavePaymentMethods}
              activeReservations={model.activeReservations}
              reservationExpired={model.reservationExpired}
              reservationMsRemaining={model.reservationMsRemaining}
              payment={model.payment}
              wallet={model.wallet}
              onFieldChange={model.markReviewStale}
            />

            <CheckoutInFormCommitRow {...commitButtonProps} />

            <CheckoutPolicyLinks
              guestDataDescription={
                model.isSignedInBuyer ? null : t("checkout.features.sessions.ui.checkoutPage.guest.data.description")
              }
            />
          </Stack>
        </Form>
      )}
    </Stack>
  );

  const stickyAction = (
    <CheckoutStickyAction
      totalsTotalLabel={model.totalsTotalLabel}
      hasPayment={model.hasPayment}
      totalsTotal={model.totalsTotal}
      isOfferIntent={model.isOfferIntent}
      commitButtonProps={commitButtonProps}
    />
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.features.sessions.ui.checkoutPage.secure.checkout")}
        title={t("checkout.features.sessions.ui.checkoutPage.checkout")}
        description={
          model.isOfferIntent
            ? t("checkout.features.sessions.ui.checkoutPage.confirm.shipping.place.purchase.intent")
            : model.signedInBuyCheckout
              ? t("checkout.features.sessions.ui.checkoutPage.signed.in.checkout.description")
              : t("checkout.features.sessions.ui.checkoutPage.simple.checkout.description")
        }
        actions={<CheckoutBackToCartAction tone="secondary" />}
      />

      {model.lines.length === 0 ? (
        <CheckoutEmptyCartState />
      ) : (
        <CheckoutFlowShell
          main={main}
          desktopSummary={<CheckoutOrderSummarySection {...orderSummaryProps} />}
          mobileSummary={<CheckoutMobileSummarySection {...orderSummaryProps} />}
          stickyAction={stickyAction}
          summaryLabel={t("checkout.features.sessions.ui.checkoutPage.checkout.summary")}
        />
      )}
    </Page>
  );
}
