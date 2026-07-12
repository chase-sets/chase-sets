import { t } from "@chase-sets/localization";
import {
  Checkbox,
  CheckoutFormSection,
  CheckoutStateNotice,
  HiddenInput,
  NativeSelect,
  SecurePaymentIndicator,
  Surface,
} from "@chase-sets/design-system";
import { formatReservationTime, paymentMethodCategoryLabel } from "./checkout-page-formatting";
import type {
  CheckoutPaymentMethodCategory,
  CheckoutPaymentPreview,
  CheckoutSavedPaymentInstrument,
} from "./checkout-page-types";

export type CheckoutActiveReservation = Readonly<{ expiresAt: string }>;

export type CheckoutPaymentSectionProps = Readonly<{
  isOfferIntent: boolean;
  showPaymentForm: boolean;
  effectivePaymentMethodCategory: CheckoutPaymentMethodCategory;
  supportedPaymentMethodCategories: readonly CheckoutPaymentMethodCategory[];
  savedPaymentInstrumentsForEffectiveMethod: readonly CheckoutSavedPaymentInstrument[];
  selectedSavedPaymentInstrument: CheckoutSavedPaymentInstrument | null;
  canSavePaymentMethods: boolean;
  activeReservations: readonly CheckoutActiveReservation[];
  reservationExpired: boolean;
  reservationMsRemaining: number | null;
  payment: CheckoutPaymentPreview | null;
  wallet: { available_balance_amount: string; currency_code: string } | null | undefined;
  onFieldChange: () => void;
}>;

/** The Payment step: payment-method selection, saved-instrument picker, and
 * the reservation/final-totals reassurance notices, or a hidden mirror once
 * the step collapses. Offer-intent checkout has no payment step at all. */
export function CheckoutPaymentSection({
  isOfferIntent,
  showPaymentForm,
  effectivePaymentMethodCategory,
  supportedPaymentMethodCategories,
  savedPaymentInstrumentsForEffectiveMethod,
  selectedSavedPaymentInstrument,
  canSavePaymentMethods,
  activeReservations,
  reservationExpired,
  reservationMsRemaining,
  payment,
  wallet,
  onFieldChange,
}: CheckoutPaymentSectionProps) {
  if (isOfferIntent) {
    return null;
  }

  if (!showPaymentForm) {
    return (
      <>
        <HiddenInput type="hidden" name="previewPaymentMethodCategory" value={effectivePaymentMethodCategory} />
        {selectedSavedPaymentInstrument ? (
          <HiddenInput
            type="hidden"
            name="savedCheckoutInstrumentId"
            value={selectedSavedPaymentInstrument.instrument_id}
          />
        ) : null}
      </>
    );
  }

  return (
    <Surface elevated glow>
      <CheckoutFormSection
        title={t("checkout.features.sessions.ui.checkoutPage.payment")}
        description={t("checkout.features.sessions.ui.checkoutPage.payment.section.description")}
        badge={<SecurePaymentIndicator label={t("checkout.features.sessions.ui.checkoutPage.secure.payment")} />}
      >
        <NativeSelect
          label={t("checkout.features.sessions.ui.checkoutPage.payment.method")}
          name="previewPaymentMethodCategory"
          defaultValue={effectivePaymentMethodCategory}
          onChange={onFieldChange}
          items={supportedPaymentMethodCategories.map((category) => ({
            value: category,
            label: paymentMethodCategoryLabel(category),
          }))}
        />
        {savedPaymentInstrumentsForEffectiveMethod.length > 0 ? (
          <NativeSelect
            label={t("checkout.features.sessions.ui.checkoutPage.saved.payment")}
            name="savedCheckoutInstrumentId"
            defaultValue={selectedSavedPaymentInstrument?.instrument_id ?? ""}
            onChange={onFieldChange}
            items={savedPaymentInstrumentsForEffectiveMethod.map((instrument) => ({
              value: instrument.instrument_id,
              label: instrument.is_default
                ? t("checkout.features.sessions.ui.checkoutPage.default.saved.payment.option", {
                    label: instrument.display_label,
                  })
                : instrument.display_label,
            }))}
          />
        ) : null}
        {canSavePaymentMethods &&
        !selectedSavedPaymentInstrument &&
        effectivePaymentMethodCategory !== "platform-credit" ? (
          <Checkbox
            label={t("checkout.features.sessions.ui.checkoutPage.save.payment.method")}
            description={t("checkout.features.sessions.ui.checkoutPage.save.payment.method.description")}
            name="savePaymentMethodForFuture"
            value="true"
          />
        ) : null}
        {activeReservations.length > 0 ? (
          <CheckoutStateNotice
            tone={reservationExpired ? "warning" : "success"}
            title={
              reservationExpired
                ? t("checkout.features.sessions.ui.checkoutPage.reservation.expired")
                : t("checkout.features.sessions.ui.checkoutPage.reserved.for.you", {
                    time: formatReservationTime(reservationMsRemaining ?? 0),
                  })
            }
            description={
              reservationExpired
                ? t("checkout.features.sessions.ui.checkoutPage.reservation.expired.description")
                : t("checkout.features.sessions.ui.checkoutPage.payment.starts.only.after.orders.are")
            }
          />
        ) : null}
        <CheckoutStateNotice
          tone={payment ? "success" : "info"}
          title={
            payment
              ? t("checkout.features.sessions.ui.checkoutPage.final.totals.before.payment")
              : t("checkout.features.sessions.ui.checkoutPage.payment.review.next")
          }
          description={
            payment
              ? t("checkout.features.sessions.ui.checkoutPage.final.totals.before.payment.description")
              : wallet
                ? t("checkout.features.sessions.ui.checkoutPage.payment.review.next.with.wallet", {
                    amount: wallet.available_balance_amount,
                    currency: wallet.currency_code.toUpperCase(),
                  })
                : t("checkout.features.sessions.ui.checkoutPage.payment.review.next.description")
          }
        />
      </CheckoutFormSection>
    </Surface>
  );
}
