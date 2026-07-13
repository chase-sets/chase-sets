import { t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import { buyCheckoutSupportReference, formatBuyCheckoutReferenceList } from "./buy-checkout-confirmation-formatting";
import {
  addressIsComplete,
  buildCheckoutAddressDefaults,
  firstSellerGroup,
  formatMoneyOrPending,
  isCheckoutPaymentMethodCategory,
} from "./checkout-page-formatting";
import { buildCheckoutNoticeCandidates } from "./checkout-notice-candidates";
import { buildCheckoutOrderSummaryItems, buildCheckoutTotalsLines } from "./checkout-order-summary-section";
import { buildCheckoutStepperItems } from "./checkout-stepper";
import type {
  CheckoutEditSection,
  CheckoutPaymentMethodCategory,
  CheckoutSessionPageProps,
} from "./checkout-page-types";

/** Every derived value, step status, and notice for the checkout session
 * page — the model half of the model-hook + view split (mirrors
 * discovery/features/item-detail's use-item-detail-page-model). Section
 * components consume this model's fields as plain props; none of them read
 * session/props directly. */
export function useCheckoutSessionModel({
  session,
  wallet,
  paymentPreview,
  selectedPaymentMethodCategory = "card",
  fulfillmentPreview,
  reservationUnavailableLines = [],
  errorMessage,
  reviewRefreshed = false,
  paymentQuoteRequired = false,
  isSubmitting = false,
  savedShippingAddresses = [],
  savedCheckoutInstruments = [],
  guestCheckoutContact = null,
  canManageShippingAddresses = false,
  canSavePaymentMethods = false,
  isSignedInBuyer = false,
  initialEditSection = null,
  autoResumePaymentStart = false,
  preparedPayment = null,
  preparedPaymentBuyerEmail = null,
}: CheckoutSessionPageProps) {
  const lines = session.lines;
  const lineCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const hasPayment = Boolean(session.payment_id);
  const isOfferIntent = session.source_type === "offer-intent";
  const signedInBuyCheckout = isSignedInBuyer && !isOfferIntent;
  const guestBuyCheckout = !isSignedInBuyer && !isOfferIntent;
  const preview = fulfillmentPreview ?? null;
  const payment = paymentPreview ?? null;
  const fulfillmentPreviewChanged = Boolean(
    !isOfferIntent &&
    preview?.revision &&
    session.fulfillment_preview_revision &&
    preview.revision !== session.fulfillment_preview_revision,
  );
  const materialChangeDescription = preview?.materialChangeReasons.length
    ? preview.materialChangeReasons.join(" ")
    : null;
  const hasAcknowledgedVisibleFulfillmentPreview = Boolean(
    preview?.materialChangeReasons.length || fulfillmentPreviewChanged,
  );
  const [hasPendingReviewChanges, setHasPendingReviewChanges] = useState(false);
  const [editingSection, setEditingSection] = useState<CheckoutEditSection | null>(initialEditSection);
  const [reservationClock, setReservationClock] = useState(() => Date.now());
  const activeReservations = session.checkout_reservations.filter((reservation) => reservation.status === "active");
  const nextReservationExpiry = activeReservations
    .map((reservation) => Date.parse(reservation.expiresAt))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)[0];
  const reservationMsRemaining = nextReservationExpiry ? nextReservationExpiry - reservationClock : null;
  const reservationExpired = Boolean(
    activeReservations.length > 0 && reservationMsRemaining !== null && reservationMsRemaining <= 0,
  );
  const readyCount = isOfferIntent ? 0 : (preview?.readyLineKeys.length ?? lines.length);
  const unavailableCount = isOfferIntent ? lines.length : (preview?.unavailableLineKeys.length ?? 0);
  const needsPaymentQuote = !isOfferIntent && !hasPayment && !payment;
  const needsReviewRefresh = needsPaymentQuote || hasPendingReviewChanges;
  const previewOrderLines = preview?.sellerGroups.flatMap((group) => group.lines) ?? [];
  const unavailableCheckoutLines = !isOfferIntent ? (preview?.unavailableLines ?? []) : [];
  const reservationUnavailableCheckoutLines = !isOfferIntent ? reservationUnavailableLines : [];
  const hasReservationUnavailableCheckoutLines = reservationUnavailableCheckoutLines.length > 0;
  const hasUnavailableCheckoutLines =
    unavailableCheckoutLines.length > 0 ||
    unavailableCount > 0 ||
    hasReservationUnavailableCheckoutLines ||
    reservationExpired;
  const canConfirm = isOfferIntent ? lines.length > 0 : readyCount > 0 && !hasUnavailableCheckoutLines;
  const firstDeliveryGroup = firstSellerGroup(preview);
  const savedAddressesForCheckout = signedInBuyCheckout ? savedShippingAddresses : [];
  const canManageAddressBookInCheckout = signedInBuyCheckout && canManageShippingAddresses;
  const defaultSavedAddress =
    savedAddressesForCheckout.find((address) => address.shipping_address_id === session.shipping_address_id) ??
    savedAddressesForCheckout.find((address) => address.is_default) ??
    savedAddressesForCheckout[0] ??
    null;
  const addressDefaults = buildCheckoutAddressDefaults({
    session,
    defaultSavedAddress,
    guestBuyCheckout,
    guestCheckoutContact,
  });
  const previewPayableTotal = payment?.marketplace_checkout_fee.total_amount ?? preview?.totals.totalAmount ?? null;
  const authenticityCheckOffer = preview?.authenticityCheckOffer ?? null;
  const authenticityCheckEligible = authenticityCheckOffer?.eligible === true;
  const authenticityCheckSelected = session.authenticity_check_opt_in?.selected === true;
  const authenticityCheckShowsInTotals = authenticityCheckEligible && authenticityCheckSelected;
  const orderReferenceValue = formatBuyCheckoutReferenceList(session.order_ids);
  const buySupportReferenceValue = buyCheckoutSupportReference(session);
  const quotedPaymentMethodCategories = payment
    ? Array.from(new Set(payment.payment_method_quotes.map((quote) => quote.payment_method_category)))
    : [];
  const supportedPaymentMethodCategories =
    quotedPaymentMethodCategories.length > 0
      ? quotedPaymentMethodCategories
      : (["card", "bank-account"] satisfies CheckoutPaymentMethodCategory[]);
  const normalizedSelectedPaymentMethodCategory = isCheckoutPaymentMethodCategory(selectedPaymentMethodCategory)
    ? selectedPaymentMethodCategory
    : "card";
  const selectedPaymentMethodCategoryForCheckout = supportedPaymentMethodCategories.includes(
    normalizedSelectedPaymentMethodCategory,
  )
    ? normalizedSelectedPaymentMethodCategory
    : (supportedPaymentMethodCategories[0] ?? "card");
  const readySavedPaymentInstruments = signedInBuyCheckout
    ? savedCheckoutInstruments.filter(
        (instrument) =>
          instrument.readiness === "ready" &&
          supportedPaymentMethodCategories.includes(instrument.payment_method_category),
      )
    : [];
  const savedPaymentInstrumentsForSelectedMethod = readySavedPaymentInstruments.filter(
    (instrument) => instrument.payment_method_category === selectedPaymentMethodCategoryForCheckout,
  );
  const selectedSavedPaymentInstrument =
    savedPaymentInstrumentsForSelectedMethod.find((instrument) => instrument.is_default) ??
    savedPaymentInstrumentsForSelectedMethod[0] ??
    readySavedPaymentInstruments.find((instrument) => instrument.is_default) ??
    readySavedPaymentInstruments[0] ??
    null;
  const effectivePaymentMethodCategory =
    selectedSavedPaymentInstrument?.payment_method_category ?? selectedPaymentMethodCategoryForCheckout;
  const savedPaymentInstrumentsForEffectiveMethod = readySavedPaymentInstruments.filter(
    (instrument) => instrument.payment_method_category === effectivePaymentMethodCategory,
  );
  const returningBuyerFastPath = Boolean(
    defaultSavedAddress && selectedSavedPaymentInstrument && !isOfferIntent && !hasPayment,
  );
  const canUseAcceleratedSavedPayment = Boolean(
    returningBuyerFastPath &&
    payment &&
    selectedSavedPaymentInstrument?.confirmation_experience === "off-session-token",
  );
  const savedAddressReady = Boolean(
    defaultSavedAddress && !selectedSavedPaymentInstrument && !isOfferIntent && !hasPayment,
  );
  const guestContactReady = guestBuyCheckout && addressDefaults.email.trim().length > 0;
  const contactReady = (signedInBuyCheckout || guestContactReady) && addressDefaults.email.trim().length > 0;
  const deliveryReady = signedInBuyCheckout && addressIsComplete(addressDefaults);
  const shippingMethodReady = signedInBuyCheckout && Boolean(firstDeliveryGroup);
  const paymentMethodReady = signedInBuyCheckout && Boolean(selectedSavedPaymentInstrument);
  const showSavedCheckoutRows = Boolean(
    contactReady || (signedInBuyCheckout && (deliveryReady || shippingMethodReady || paymentMethodReady)),
  );
  const activeEditSection = editingSection ?? initialEditSection;
  const canEditCollapsedContact = signedInBuyCheckout;
  const showContactForm = !contactReady || (canEditCollapsedContact && activeEditSection === "contact");
  const showDeliveryForm = !signedInBuyCheckout || !deliveryReady || activeEditSection === "delivery";
  const showShippingMethodForm = !signedInBuyCheckout || !shippingMethodReady || activeEditSection === "shipping";
  const showPaymentForm = !signedInBuyCheckout || !paymentMethodReady || activeEditSection === "payment";
  const selectedPaymentSupportingText =
    selectedSavedPaymentInstrument?.confirmation_experience === "off-session-token"
      ? t("checkout.features.sessions.ui.checkoutPage.saved.payment.row.supporting.fast")
      : t("checkout.features.sessions.ui.checkoutPage.saved.payment.row.supporting.secure.step");

  function markReviewStale() {
    if (!isOfferIntent && !hasPayment) {
      setHasPendingReviewChanges(true);
    }
  }

  useEffect(() => {
    if (!activeReservations.length || hasPayment) {
      return undefined;
    }

    const timer = window.setInterval(() => setReservationClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeReservations.length, hasPayment]);

  const stepperItems = buildCheckoutStepperItems({
    contactReady,
    showContactForm,
    deliveryReady,
    showDeliveryForm,
    shippingMethodReady,
    showShippingMethodForm,
    paymentMethodReady,
    showPaymentForm,
    isOfferIntent,
    hasPayment,
    hasUnavailableCheckoutLines,
  });

  const orderSummaryItems = buildCheckoutOrderSummaryItems({ lines, isOfferIntent, previewOrderLines });
  const totalsLines = buildCheckoutTotalsLines({
    isOfferIntent,
    preview,
    payment,
    authenticityCheckShowsInTotals,
    authenticityCheckOffer,
    wallet,
  });
  const totalsTotalLabel = isOfferIntent
    ? t("checkout.features.sessions.ui.checkoutPage.total")
    : t("checkout.features.sessions.ui.checkoutPage.payable.total");
  const totalsTotal = isOfferIntent
    ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
    : previewPayableTotal
      ? formatMoneyOrPending(previewPayableTotal)
      : t("checkout.features.sessions.ui.checkoutPage.pending");
  // The single deferral statement for this surface lives once, beneath the total.
  // For offer intent the total already reads "No payment today", so the caption
  // carries a distinct reassurance instead of repeating the total verbatim.
  const totalsCaption = isOfferIntent
    ? t("checkout.features.sessions.ui.checkoutPage.sellers.can.accept.purchase.intent.before.order")
    : t("checkout.features.sessions.ui.checkoutPage.secure.payment.confirmed.caption");
  const totalsDeferred = !isOfferIntent && !previewPayableTotal;

  const primaryCtaLabel = isOfferIntent
    ? t("checkout.features.sessions.ui.checkoutPage.place.purchase.intent")
    : needsReviewRefresh
      ? t("checkout.features.sessions.ui.checkoutPage.update.totals")
      : canUseAcceleratedSavedPayment
        ? t("checkout.features.sessions.ui.checkoutPage.pay.now.with.saved.payment", {
            paymentMethodCategory:
              selectedSavedPaymentInstrument?.display_label ?? effectivePaymentMethodCategory.replace("-", " "),
          })
        : t("checkout.features.sessions.ui.checkoutPage.pay.now");
  const submittingCtaLabel = isOfferIntent
    ? t("checkout.features.sessions.ui.checkoutPage.placing.purchase.intent")
    : t("checkout.features.sessions.ui.checkoutPage.processing.payment");
  const shouldRefreshBeforeCommit = !isOfferIntent && needsReviewRefresh;
  const commitIntent = shouldRefreshBeforeCommit ? "refresh-checkout-preview" : "confirm-checkout";
  const commitIcon: "refreshCcw" | "lock" = shouldRefreshBeforeCommit ? "refreshCcw" : "lock";
  const reReserveIntent = "confirm-checkout";
  const hasAutoResumedPaymentStartRef = useRef(false);
  const canAutoResumePaymentStart = Boolean(
    autoResumePaymentStart &&
    !hasPayment &&
    !isOfferIntent &&
    addressIsComplete(addressDefaults) &&
    contactReady &&
    payment?.marketplace_checkout_fee.quote_fingerprint &&
    payment.can_start_payment !== false &&
    !needsReviewRefresh &&
    !canUseAcceleratedSavedPayment,
  );

  useEffect(() => {
    if (hasAutoResumedPaymentStartRef.current || isSubmitting || !canAutoResumePaymentStart) {
      return;
    }

    const form = document.getElementById("checkout-confirmation-form");
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const submitter = form.querySelector<HTMLButtonElement>(
      'button[type="submit"][name="intent"][value="confirm-checkout"]',
    );
    if (!submitter) {
      return;
    }

    hasAutoResumedPaymentStartRef.current = true;
    form.requestSubmit(submitter);
  }, [canAutoResumePaymentStart, isSubmitting]);

  const noticeCandidates = buildCheckoutNoticeCandidates({
    hasReservationUnavailableCheckoutLines,
    reservationUnavailableCheckoutLines,
    isOfferIntent,
    reservationExpired,
    reReserveIntent,
    isSubmitting,
    unavailableCheckoutLines,
    unavailableCount,
    hasAcknowledgedVisibleFulfillmentPreview,
    materialChangeDescription,
    hasPendingReviewChanges,
    paymentQuoteRequired,
    reviewRefreshed,
    showSavedCheckoutRows,
    canUseAcceleratedSavedPayment,
    returningBuyerFastPath,
    savedAddressReady,
    defaultSavedAddressLabel: defaultSavedAddress?.label,
    selectedSavedPaymentInstrumentLabel: selectedSavedPaymentInstrument?.display_label,
    effectivePaymentMethodCategory,
  });

  return {
    session,
    wallet,
    errorMessage: errorMessage ?? null,
    isSubmitting,
    isSignedInBuyer,
    isOfferIntent,
    signedInBuyCheckout,
    lines,
    lineCount,
    hasPayment,
    preview,
    payment,
    hasAcknowledgedVisibleFulfillmentPreview,
    canConfirm,
    reservationExpired,
    reservationMsRemaining,
    activeReservations,
    firstDeliveryGroup,
    savedAddressesForCheckout,
    canManageAddressBookInCheckout,
    defaultSavedAddress,
    addressDefaults,
    authenticityCheckOffer,
    authenticityCheckEligible,
    authenticityCheckSelected,
    authenticityCheckShowsInTotals,
    orderReferenceValue,
    buySupportReferenceValue,
    supportedPaymentMethodCategories,
    savedPaymentInstrumentsForEffectiveMethod,
    selectedSavedPaymentInstrument,
    effectivePaymentMethodCategory,
    canSavePaymentMethods,
    canManageShippingAddresses,
    returningBuyerFastPath,
    canUseAcceleratedSavedPayment,
    showSavedCheckoutRows,
    canEditCollapsedContact,
    showContactForm,
    showDeliveryForm,
    showShippingMethodForm,
    showPaymentForm,
    contactReady,
    deliveryReady,
    shippingMethodReady,
    paymentMethodReady,
    selectedPaymentSupportingText,
    setEditingSection,
    markReviewStale,
    stepperItems,
    orderSummaryItems,
    totalsLines,
    totalsTotalLabel,
    totalsTotal,
    totalsCaption,
    totalsDeferred,
    primaryCtaLabel,
    submittingCtaLabel,
    commitIntent,
    commitIcon,
    reReserveIntent,
    noticeCandidates,
    preparedPayment,
    preparedPaymentBuyerEmail,
  };
}
