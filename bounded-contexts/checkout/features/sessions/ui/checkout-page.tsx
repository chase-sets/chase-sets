import { t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import {
  HiddenInput,
  Form,
  Button,
  Checkbox,
  CheckoutConfirmationPanel,
  CheckoutFlowShell,
  CheckoutFormSection,
  CheckoutMobileSummaryDisclosure,
  CheckoutNoticeStack,
  CheckoutSavedInfoGroup,
  CheckoutSavedInfoRow,
  CheckoutStateNotice,
  CheckoutStickyActionBar,
  CheckoutSummaryPanel,
  OrderProtectionModule,
  ActionRow,
  Grid,
  LinkButton,
  MarketplaceEmptyState,
  NativeSelect,
  Page,
  PageHeader,
  PageStepper,
  ProductOptions,
  ProgressiveDisclosure,
  SecurePaymentIndicator,
  Show,
  Stack,
  Surface,
  TextInput,
  productOptionsFromSummary,
  type CheckoutNoticeCandidate,
  type CheckoutSummaryItem,
  type PageStepperItem,
} from "@chase-sets/design-system";
import type { CheckoutFulfillmentPreview, CheckoutSessionRow } from "../../../support/request-support/api-client";
import { buyCheckoutSupportReference, formatBuyCheckoutReferenceList } from "./buy-checkout-confirmation-formatting";
import { CheckoutPolicyLinks } from "./checkout-policy-links";

type CheckoutPaymentPreview = Readonly<{
  currency_code: string;
  amount: string;
  marketplace_checkout_fee: Readonly<{
    marketplace_checkout_fee_amount: string;
    marketplace_checkout_fee_reduction_amount: string;
    total_amount: string;
    processor_amount: string;
    quote_fingerprint: string;
  }>;
  payment_method_quotes: readonly Readonly<{
    payment_method_category: "card" | "bank-account" | "platform-credit";
    marketplace_checkout_fee_amount: string;
    total_amount: string;
  }>[];
  wallet_credit: Readonly<{
    requested_amount: string;
    applied_amount: string;
    external_amount: string;
  }>;
  can_start_payment?: boolean;
}>;

const checkoutPaymentMethodCategories = ["card", "bank-account", "platform-credit"] as const;

type CheckoutPaymentMethodCategory = (typeof checkoutPaymentMethodCategories)[number];

export type CheckoutSavedShippingAddress = Readonly<{
  shipping_address_id: string;
  label: string;
  recipient_name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  phone: string | null;
  email: string | null;
  is_default: boolean;
}>;

export type CheckoutSavedPaymentInstrument = Readonly<{
  instrument_id: string;
  payment_method_category: "card" | "bank-account" | "platform-credit";
  provider: string;
  display_label: string;
  confirmation_experience: "trusted-payment-step" | "off-session-token";
  is_default: boolean;
  readiness: "ready" | "setup-required" | "removed";
}>;

export type CheckoutEditSection = "contact" | "delivery" | "shipping" | "payment";

export type GuestCheckoutContact = Readonly<{
  contactEmail: string;
  contactName: string | null;
}>;

export type CheckoutReservationUnavailableLine = Pick<
  CheckoutFulfillmentPreview["sellerGroups"][number]["lines"][number],
  "lineKey" | "sellerAccountId" | "inventoryItemId" | "itemTitle" | "productSummary" | "quantity"
>;

function deliveryWindowLabel(group: CheckoutFulfillmentPreview["sellerGroups"][number]) {
  return `${group.deliveryEstimate.earliestDate} - ${group.deliveryEstimate.latestDate}`;
}

function addressIsComplete(
  address: Readonly<{
    name: string;
    line1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }>,
) {
  return [address.name, address.line1, address.city, address.state, address.postalCode, address.country].every(
    (value) => value.trim().length > 0,
  );
}

function addressSummary(
  address: Readonly<{
    line1: string;
    line2: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }>,
) {
  const region = [address.state, address.postalCode].filter((value) => value.trim().length > 0).join(" ");
  const locality = [address.city, region].filter((value) => value.trim().length > 0).join(", ");
  return [address.line1, address.line2, locality, address.country]
    .filter((value) => value.trim().length > 0)
    .join(", ");
}

function isCheckoutPaymentMethodCategory(value: string): value is CheckoutPaymentMethodCategory {
  return checkoutPaymentMethodCategories.includes(value as CheckoutPaymentMethodCategory);
}

function paymentMethodCategoryLabel(category: CheckoutPaymentMethodCategory) {
  switch (category) {
    case "bank-account":
      return t("checkout.features.sessions.ui.checkoutPage.bank.account");
    case "platform-credit":
      return t("checkout.features.sessions.ui.checkoutPage.platform.credit.only");
    default:
      return t("checkout.features.sessions.ui.checkoutPage.card");
  }
}

function contactSupportingText(phone: string) {
  return phone.trim().length > 0
    ? t("checkout.features.sessions.ui.checkoutPage.contact.row.supporting.phone", { phone })
    : t("checkout.features.sessions.ui.checkoutPage.contact.row.supporting");
}

function normalizedAddressSignature(
  address: Readonly<{
    name: string;
    company: string;
    line1: string;
    line2: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone: string;
    email: string;
  }>,
) {
  return JSON.stringify({
    name: address.name.trim(),
    company: address.company.trim(),
    line1: address.line1.trim(),
    line2: address.line2.trim(),
    city: address.city.trim(),
    state: address.state.trim().toUpperCase(),
    postalCode: address.postalCode.trim(),
    country: address.country.trim().toUpperCase(),
    phone: address.phone.trim(),
    email: address.email.trim().toLowerCase(),
  });
}

function firstSellerGroup(preview: CheckoutFulfillmentPreview | null) {
  return preview?.sellerGroups[0] ?? null;
}

function formatMoney(value: string | null | undefined) {
  return value ? `$${value}` : t("checkout.features.sessions.ui.checkoutPage.pending");
}

function formatReservationTime(msRemaining: number) {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function reservationUnavailableItemsLabel(lines: readonly CheckoutReservationUnavailableLine[]) {
  return [...new Set(lines.map((line) => line.itemTitle).filter((title) => title.trim().length > 0))]
    .slice(0, 3)
    .join(", ");
}

function previewLineForSessionLine(
  line: CheckoutSessionRow["lines"][number],
  previewLines: readonly CheckoutFulfillmentPreview["sellerGroups"][number]["lines"][number][],
) {
  return (
    previewLines.find((previewLine) => line.cartLineId && previewLine.lineKey === line.cartLineId) ??
    previewLines.find((previewLine) => line.listingId && previewLine.listingId === line.listingId) ??
    previewLines.find((previewLine) => previewLine.productId === line.productId) ??
    null
  );
}

function shippingOptionLabel(option: CheckoutSessionRow["shipping_option"]) {
  switch (option) {
    case "expedited":
      return t("checkout.features.sessions.ui.checkoutPage.expedited");
    case "priority":
      return t("checkout.features.sessions.ui.checkoutPage.priority");
    default:
      return t("checkout.features.sessions.ui.checkoutPage.standard.insured");
  }
}

export function CheckoutSessionPage({
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
}: {
  session: CheckoutSessionRow;
  wallet?: { available_balance_amount: string; currency_code: string } | null;
  paymentPreview?: CheckoutPaymentPreview | null;
  selectedPaymentMethodCategory?: string;
  fulfillmentPreview?: CheckoutFulfillmentPreview | null;
  reservationUnavailableLines?: readonly CheckoutReservationUnavailableLine[];
  errorMessage?: string | null;
  reviewRefreshed?: boolean;
  paymentQuoteRequired?: boolean;
  isSubmitting?: boolean;
  savedShippingAddresses?: readonly CheckoutSavedShippingAddress[];
  savedCheckoutInstruments?: readonly CheckoutSavedPaymentInstrument[];
  guestCheckoutContact?: GuestCheckoutContact | null;
  canManageShippingAddresses?: boolean;
  canSavePaymentMethods?: boolean;
  isSignedInBuyer?: boolean;
  initialEditSection?: CheckoutEditSection | null;
  autoResumePaymentStart?: boolean;
}) {
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
  const addressDefaults = session.shipping_address
    ? {
        shippingAddressId: session.shipping_address.shippingAddressId ?? "__manual",
        name: session.shipping_address.name,
        company: session.shipping_address.company ?? "",
        line1: session.shipping_address.line1,
        line2: session.shipping_address.line2 ?? "",
        city: session.shipping_address.city,
        state: session.shipping_address.state,
        postalCode: session.shipping_address.postalCode,
        country: session.shipping_address.country,
        phone: session.shipping_address.phone ?? "",
        email: session.shipping_address.email ?? "",
      }
    : defaultSavedAddress
      ? {
          shippingAddressId: defaultSavedAddress.shipping_address_id,
          name: defaultSavedAddress.recipient_name,
          company: defaultSavedAddress.company ?? "",
          line1: defaultSavedAddress.line1,
          line2: defaultSavedAddress.line2 ?? "",
          city: defaultSavedAddress.city,
          state: defaultSavedAddress.state,
          postalCode: defaultSavedAddress.postal_code,
          country: defaultSavedAddress.country,
          phone: defaultSavedAddress.phone ?? "",
          email: defaultSavedAddress.email ?? "",
        }
      : {
          shippingAddressId: "__manual",
          name: guestBuyCheckout ? (guestCheckoutContact?.contactName ?? "") : "",
          company: "",
          line1: "",
          line2: "",
          city: "",
          state: "",
          postalCode: "",
          country: "US",
          phone: "",
          email: guestBuyCheckout ? (guestCheckoutContact?.contactEmail ?? "") : "",
        };
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
  function editRowAction(section: CheckoutEditSection, label: string) {
    return (
      <Button type="button" tone="secondary" size="sm" leadingIcon="edit" onClick={() => setEditingSection(section)}>
        {label}
      </Button>
    );
  }
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

  // The flow spine. Each step is `complete` once its data is collected and the
  // section is collapsed, `current` for the first step still presented as a form,
  // and `upcoming` for later forms. The review step is `blocked` when unavailable
  // lines gate confirmation. Offer-intent has no payment step.
  function stepStatus(ready: boolean, showForm: boolean, reached: boolean): PageStepperItem["status"] {
    if (ready && !showForm) {
      return "complete";
    }
    if (reached) {
      return "current";
    }
    return "upcoming";
  }
  const contactStep = stepStatus(contactReady, showContactForm, true);
  const contactComplete = contactStep === "complete";
  const deliveryStep = stepStatus(deliveryReady, showDeliveryForm, contactComplete);
  const deliveryComplete = deliveryStep === "complete";
  const shippingStep = stepStatus(shippingMethodReady, showShippingMethodForm, deliveryComplete);
  const shippingComplete = shippingStep === "complete";
  const paymentStep = isOfferIntent ? "complete" : stepStatus(paymentMethodReady, showPaymentForm, shippingComplete);
  const paymentComplete = paymentStep === "complete";
  const allCollected = contactComplete && deliveryComplete && shippingComplete && paymentComplete;
  const reviewStep: PageStepperItem["status"] = hasPayment
    ? "complete"
    : hasUnavailableCheckoutLines
      ? "blocked"
      : allCollected
        ? "current"
        : "upcoming";
  const stepperItems: PageStepperItem[] = [
    {
      label: t("checkout.features.sessions.ui.checkoutPage.step.contact"),
      description: t("checkout.features.sessions.ui.checkoutPage.step.contact.description"),
      status: contactStep,
    },
    {
      label: t("checkout.features.sessions.ui.checkoutPage.step.delivery"),
      description: t("checkout.features.sessions.ui.checkoutPage.step.delivery.description"),
      status: deliveryStep,
    },
    {
      label: t("checkout.features.sessions.ui.checkoutPage.step.shipping"),
      description: t("checkout.features.sessions.ui.checkoutPage.step.shipping.description"),
      status: shippingStep,
    },
    ...(!isOfferIntent
      ? [
          {
            label: t("checkout.features.sessions.ui.checkoutPage.step.payment"),
            description: t("checkout.features.sessions.ui.checkoutPage.step.payment.description"),
            status: paymentStep,
          },
        ]
      : []),
    {
      label: t("checkout.features.sessions.ui.checkoutPage.step.review"),
      description: t("checkout.features.sessions.ui.checkoutPage.step.review.description"),
      status: reviewStep,
    },
  ];

  const orderSummaryItems: CheckoutSummaryItem[] = lines.map((line, index) => {
    const previewLine = previewLineForSessionLine(line, previewOrderLines);
    const lineAmount = isOfferIntent ? line.offerPriceAmount : (previewLine?.estimatedLineTotalAmount ?? null);
    return {
      id: line.cartLineId ?? line.listingId ?? `${line.productId}:${index}`,
      title: line.itemTitle,
      subtitle: line.itemSubtitle ?? undefined,
      facts: line.productSummary
        ? [<ProductOptions key="opts" options={productOptionsFromSummary(line.productSummary)} variant="compact" />]
        : undefined,
      quantity: line.quantity,
      price: lineAmount ? `$${lineAmount}` : undefined,
      priceState: lineAmount ? "exact" : "deferred",
      deferredPriceLabel: t("checkout.features.sessions.ui.checkoutPage.pending"),
    };
  });

  const totalsLines = [
    {
      label: t("checkout.features.sessions.ui.checkoutPage.subtotal"),
      value: formatMoney(preview?.totals.itemSubtotalAmount),
    },
    {
      label: t("checkout.features.sessions.ui.checkoutPage.shipping.2"),
      value: isOfferIntent
        ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
        : formatMoney(preview?.totals.shippingAmount),
      muted: true,
    },
    {
      label: t("checkout.features.sessions.ui.checkoutPage.estimated.tax"),
      value: isOfferIntent
        ? t("checkout.features.sessions.ui.checkoutPage.not.applicable")
        : formatMoney(preview?.totals.salesTaxAmount),
      muted: true,
    },
    ...(!isOfferIntent
      ? [
          {
            label: t("checkout.features.sessions.ui.checkoutPage.marketplace.checkout.fee"),
            value: payment
              ? `$${payment.marketplace_checkout_fee.marketplace_checkout_fee_amount}`
              : t("checkout.features.sessions.ui.checkoutPage.calculated.before.payment"),
            muted: !payment,
          },
          {
            label: t("checkout.features.sessions.ui.checkoutPage.wallet.credit"),
            value: payment ? `-$${payment.wallet_credit.applied_amount}` : "$0.00",
          },
        ]
      : []),
    ...(authenticityCheckShowsInTotals && authenticityCheckOffer
      ? [
          {
            label: t("checkout.features.sessions.ui.checkoutPage.authenticity.check.fee"),
            value: `$${authenticityCheckOffer.fee_amount}`,
          },
        ]
      : []),
    ...(wallet
      ? [
          {
            label: t("checkout.features.sessions.ui.checkoutPage.available.balance"),
            value: `${wallet.available_balance_amount} ${wallet.currency_code.toUpperCase()}`,
            muted: true,
          },
        ]
      : []),
  ];
  const totalsTotalLabel = isOfferIntent
    ? t("checkout.features.sessions.ui.checkoutPage.total")
    : t("checkout.features.sessions.ui.checkoutPage.payable.total");
  const totalsTotal = isOfferIntent
    ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
    : previewPayableTotal
      ? `$${previewPayableTotal}`
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
  const commitIcon = shouldRefreshBeforeCommit ? "refreshCcw" : "lock";
  const reReserveIntent = "confirm-checkout";
  const hasAutoResumedPaymentStartRef = useRef(false);
  const canAutoResumePaymentStart = Boolean(
    autoResumePaymentStart &&
    !hasPayment &&
    !isOfferIntent &&
    session.order_ids.length > 0 &&
    payment?.marketplace_checkout_fee.quote_fingerprint &&
    payment.can_start_payment !== false &&
    !needsReviewRefresh,
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

  const orderSummary = (
    <Stack gap={4}>
      <CheckoutSummaryPanel
        title={t("checkout.features.sessions.ui.checkoutPage.order.summary")}
        status={t("checkout.features.sessions.ui.checkoutPage.item.count", { count: lineCount })}
        statusTone="neutral"
        items={orderSummaryItems}
        totals={totalsLines}
        totalLabel={totalsTotalLabel}
        total={totalsTotal}
        totalCaption={totalsCaption}
        deferred={totalsDeferred}
        reassurance={
          <SecurePaymentIndicator
            label={
              isOfferIntent
                ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
                : t("checkout.features.sessions.ui.checkoutPage.secure.payment")
            }
          />
        }
      />
      <OrderProtectionModule
        items={[
          {
            title: t("checkout.features.sessions.ui.checkoutPage.buyer.protection"),
            description: t("checkout.features.sessions.ui.checkoutPage.eligible.orders.are.protected.through.payment"),
          },
          isOfferIntent
            ? {
                title: t("checkout.features.sessions.ui.checkoutPage.no.payment.today"),
                description: t(
                  "checkout.features.sessions.ui.checkoutPage.sellers.can.accept.purchase.intent.before.order",
                ),
              }
            : {
                title: t("checkout.features.sessions.ui.checkoutPage.secure.payment"),
                description: t("checkout.features.sessions.ui.checkoutPage.payment.starts.only.after.orders.are"),
              },
          {
            title: t("checkout.features.sessions.ui.checkoutPage.fulfillment.ready"),
            description: isOfferIntent
              ? t("checkout.features.sessions.ui.checkoutPage.shipping.preference.is.captured.for.purchase.intent")
              : t("checkout.features.sessions.ui.checkoutPage.fulfillment.resolved.before.checkout"),
          },
          ...(authenticityCheckShowsInTotals
            ? [
                {
                  title: t("checkout.features.sessions.ui.checkoutPage.authenticity.check.protection"),
                  description: t(
                    "checkout.features.sessions.ui.checkoutPage.authenticity.check.protection.description",
                  ),
                },
              ]
            : []),
        ]}
      />
    </Stack>
  );

  const mobileSummary = (
    <CheckoutMobileSummaryDisclosure
      label={t("checkout.features.sessions.ui.checkoutPage.order.summary")}
      collapsedSummary={t("checkout.features.sessions.ui.checkoutPage.item.count", { count: lineCount })}
      total={totalsTotal}
    >
      {orderSummary}
    </CheckoutMobileSummaryDisclosure>
  );

  // One notice at a time, by the §4 priority ladder. Each in-flow checkout state
  // is a candidate; the stack renders only the highest-priority active one.
  const noticeCandidates: CheckoutNoticeCandidate[] = [
    {
      priority: "needs-review",
      active: hasReservationUnavailableCheckoutLines,
      notice: (
        <CheckoutStateNotice
          tone="warning"
          title={t("checkout.features.sessions.ui.checkoutPage.reservation.unavailable.title")}
          description={t(
            reservationUnavailableCheckoutLines.length === 1
              ? "checkout.features.sessions.ui.checkoutPage.reservation.unavailable.description.one"
              : "checkout.features.sessions.ui.checkoutPage.reservation.unavailable.description.many",
            {
              count: reservationUnavailableCheckoutLines.length,
              items: reservationUnavailableItemsLabel(reservationUnavailableCheckoutLines),
            },
          )}
          action={
            <LinkButton href="/account/cart" tone="secondary" size="sm">
              {t("checkout.features.sessions.ui.checkoutPage.review.buy.cart")}
            </LinkButton>
          }
        />
      ),
    },
    {
      priority: "needs-review",
      active: !isOfferIntent && reservationExpired,
      notice: (
        <CheckoutStateNotice
          tone="warning"
          title={t("checkout.features.sessions.ui.checkoutPage.reservation.expired")}
          description={t("checkout.features.sessions.ui.checkoutPage.reservation.expired.description")}
          action={
            <Button
              type="submit"
              form="checkout-confirmation-form"
              name="intent"
              value={reReserveIntent}
              leadingIcon="refreshCcw"
              loading={isSubmitting}
              size="sm"
            >
              {t("checkout.features.sessions.ui.checkoutPage.reserve.again")}
            </Button>
          }
        />
      ),
    },
    {
      priority: "needs-review",
      active:
        !isOfferIntent &&
        !hasReservationUnavailableCheckoutLines &&
        !reservationExpired &&
        (unavailableCheckoutLines.length > 0 || unavailableCount > 0),
      notice: (
        <CheckoutStateNotice
          tone="warning"
          title={t("checkout.features.sessions.ui.checkoutPage.checkout.needs.cart.review")}
          description={t("checkout.features.sessions.ui.checkoutPage.checkout.needs.cart.review.description", {
            count: unavailableCheckoutLines.length || unavailableCount,
          })}
          action={
            <LinkButton href="/account/cart" tone="secondary" size="sm">
              {t("checkout.features.sessions.ui.checkoutPage.review.buy.cart")}
            </LinkButton>
          }
        />
      ),
    },
    {
      priority: "needs-review",
      active: !isOfferIntent && hasAcknowledgedVisibleFulfillmentPreview,
      notice: (
        <CheckoutStateNotice
          tone="warning"
          title={t("checkout.features.sessions.ui.checkoutPage.fulfillment.changed")}
          description={
            materialChangeDescription ?? t("checkout.features.sessions.ui.checkoutPage.fulfillment.changed.description")
          }
        />
      ),
    },
    {
      priority: "needs-review",
      active: hasPendingReviewChanges,
      notice: (
        <CheckoutStateNotice
          tone="warning"
          title={t("checkout.features.sessions.ui.checkoutPage.totals.need.refresh")}
          description={t("checkout.features.sessions.ui.checkoutPage.totals.need.refresh.description")}
        />
      ),
    },
    {
      priority: "savings",
      active: paymentQuoteRequired,
      notice: (
        <CheckoutStateNotice
          tone="info"
          title={t("checkout.features.sessions.ui.checkoutPage.payment.quote.required")}
          description={t("checkout.features.sessions.ui.checkoutPage.payment.quote.required.description")}
        />
      ),
    },
    {
      priority: "savings",
      active: reviewRefreshed,
      notice: (
        <CheckoutStateNotice
          tone="success"
          title={t("checkout.features.sessions.ui.checkoutPage.review.updated")}
          description={t("checkout.features.sessions.ui.checkoutPage.review.updated.description")}
        />
      ),
    },
    {
      priority: "info",
      active: !showSavedCheckoutRows && canUseAcceleratedSavedPayment,
      notice: (
        <CheckoutStateNotice
          tone="success"
          title={t("checkout.features.sessions.ui.checkoutPage.fast.checkout.ready")}
          description={t("checkout.features.sessions.ui.checkoutPage.fast.checkout.ready.description", {
            addressLabel: defaultSavedAddress?.label,
            paymentMethodCategory:
              selectedSavedPaymentInstrument?.display_label ?? effectivePaymentMethodCategory.replace("-", " "),
          })}
        />
      ),
    },
    {
      priority: "info",
      active: !showSavedCheckoutRows && returningBuyerFastPath && !canUseAcceleratedSavedPayment,
      notice: (
        <CheckoutStateNotice
          tone="info"
          title={t("checkout.features.sessions.ui.checkoutPage.saved.payment.step.ready")}
          description={t("checkout.features.sessions.ui.checkoutPage.saved.payment.step.ready.description", {
            addressLabel: defaultSavedAddress?.label,
            paymentMethodCategory:
              selectedSavedPaymentInstrument?.display_label ?? effectivePaymentMethodCategory.replace("-", " "),
          })}
        />
      ),
    },
    {
      priority: "info",
      active: !showSavedCheckoutRows && savedAddressReady,
      notice: (
        <CheckoutStateNotice
          tone="info"
          title={t("checkout.features.sessions.ui.checkoutPage.saved.address.ready")}
          description={t("checkout.features.sessions.ui.checkoutPage.saved.address.ready.description", {
            addressLabel: defaultSavedAddress?.label,
          })}
        />
      ),
    },
  ];

  const commitButton = (form?: string) =>
    hasPayment && session.payment_id ? (
      <LinkButton href={`/account/payments/${session.payment_id}`} block>
        {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}
      </LinkButton>
    ) : !isOfferIntent && reservationExpired ? (
      <Button
        type="submit"
        form={form}
        name="intent"
        value={reReserveIntent}
        leadingIcon="refreshCcw"
        loading={isSubmitting}
        disabled={isSubmitting}
        block
      >
        {isSubmitting
          ? t("checkout.features.sessions.ui.checkoutPage.processing.payment")
          : t("checkout.features.sessions.ui.checkoutPage.reserve.again")}
      </Button>
    ) : !canConfirm && !isOfferIntent ? (
      <LinkButton href="/account/cart" leadingIcon="cart" block>
        {t("checkout.features.sessions.ui.checkoutPage.review.buy.cart")}
      </LinkButton>
    ) : (
      <Button
        type="submit"
        form={form}
        name="intent"
        value={commitIntent}
        leadingIcon={commitIcon}
        loading={isSubmitting}
        disabled={isSubmitting || (!canConfirm && !isOfferIntent)}
        block
      >
        {isSubmitting ? submittingCtaLabel : primaryCtaLabel}
      </Button>
    );

  const backToCartAction = (
    <LinkButton href="/account/cart" tone="secondary" block>
      {t("checkout.features.sessions.ui.checkoutPage.back.to.cart")}
    </LinkButton>
  );

  const main = (
    <Stack gap={5}>
      <PageStepper items={stepperItems} aria-label={t("checkout.features.sessions.ui.checkoutPage.checkout.steps")} />

      {errorMessage ? (
        <CheckoutStateNotice
          tone="danger"
          title={t("checkout.features.sessions.ui.checkoutPage.checkout.issue")}
          description={errorMessage}
        />
      ) : null}

      <CheckoutNoticeStack candidates={noticeCandidates} />

      {session.payment_id ? (
        <CheckoutConfirmationPanel
          title={t("checkout.features.sessions.ui.checkoutPage.payment.ready.2")}
          description={t("checkout.features.sessions.ui.checkoutPage.purchases.have.been.created.and.payment")}
          referenceLabel={t("checkout.features.sessions.ui.checkoutPage.order.reference")}
          referenceValue={orderReferenceValue}
          supportReferenceLabel={t("checkout.features.sessions.ui.checkoutPage.support.reference")}
          supportReferenceValue={buySupportReferenceValue}
          totalLabel={t("checkout.features.sessions.ui.checkoutPage.payable.total")}
          total={formatMoney(previewPayableTotal)}
          nextSteps={[
            {
              title: t("checkout.features.sessions.ui.checkoutPage.payment.handoff.title"),
              description: t("checkout.features.sessions.ui.checkoutPage.payment.handoff.description"),
              icon: "lock",
            },
            {
              title: t("checkout.features.sessions.ui.checkoutPage.account.fulfillment.pending.title"),
              description: t("checkout.features.sessions.ui.checkoutPage.account.fulfillment.pending.description"),
              icon: "truck",
            },
            {
              title: t("checkout.features.sessions.ui.checkoutPage.support.reference.ready.title"),
              description: t("checkout.features.sessions.ui.checkoutPage.support.reference.ready.description"),
              icon: "shield",
            },
          ]}
          actions={
            <LinkButton href={`/account/payments/${session.payment_id}`}>
              {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}
            </LinkButton>
          }
        />
      ) : (
        <Form spacing="none" id="checkout-confirmation-form" method="post">
          <Stack gap={4}>
            <HiddenInput type="hidden" name="fulfillmentPreviewRevision" value={preview?.revision ?? ""} />
            <HiddenInput
              type="hidden"
              name="marketplaceCheckoutFeeQuoteFingerprint"
              value={payment?.marketplace_checkout_fee.quote_fingerprint ?? ""}
            />
            <HiddenInput
              type="hidden"
              name="requestedBalanceCreditAmount"
              value={payment?.wallet_credit.requested_amount ?? wallet?.available_balance_amount ?? "0.00"}
            />
            <HiddenInput type="hidden" name="paymentMethodCategory" value={effectivePaymentMethodCategory} />
            <HiddenInput
              type="hidden"
              name="acceleratedSavedPayment"
              value={canUseAcceleratedSavedPayment ? "true" : "false"}
            />
            <HiddenInput type="hidden" name="sourceType" value={session.source_type} />
            <HiddenInput type="hidden" name="reviewedShippingOption" value={session.shipping_option} />
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
            {!showContactForm ? <HiddenInput type="hidden" name="shippingEmail" value={addressDefaults.email} /> : null}
            {!showDeliveryForm ? (
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
            ) : null}
            {!showShippingMethodForm ? (
              <HiddenInput type="hidden" name="shippingOption" value={session.shipping_option} />
            ) : null}
            {!showPaymentForm && !isOfferIntent ? (
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
            ) : null}
            {showSavedCheckoutRows ? (
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
                        ? editRowAction("contact", t("checkout.features.sessions.ui.checkoutPage.edit.contact"))
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
                    action={editRowAction("delivery", t("checkout.features.sessions.ui.checkoutPage.edit.delivery"))}
                  />
                ) : null}
                {shippingMethodReady && firstDeliveryGroup ? (
                  <CheckoutSavedInfoRow
                    icon="truck"
                    label={t("checkout.features.sessions.ui.checkoutPage.shipping")}
                    value={shippingOptionLabel(session.shipping_option)}
                    supportingText={t("checkout.features.sessions.ui.checkoutPage.delivery.estimate.summary", {
                      window: deliveryWindowLabel(firstDeliveryGroup),
                      packageCount: firstDeliveryGroup.deliveryEstimate.packageCount,
                      serviceLevel: firstDeliveryGroup.deliveryEstimate.serviceLevel,
                      shippingOption: shippingOptionLabel(session.shipping_option),
                    })}
                    status={t("checkout.features.sessions.ui.checkoutPage.ready")}
                    statusTone="success"
                    action={editRowAction("shipping", t("checkout.features.sessions.ui.checkoutPage.edit.shipping"))}
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
                    action={editRowAction("payment", t("checkout.features.sessions.ui.checkoutPage.edit.payment"))}
                  />
                ) : null}
              </CheckoutSavedInfoGroup>
            ) : null}
            {showContactForm ? (
              <Surface elevated glow>
                <CheckoutFormSection title={t("checkout.features.sessions.ui.checkoutPage.contact")}>
                  <TextInput
                    label={t("checkout.features.sessions.ui.checkoutPage.email")}
                    name="shippingEmail"
                    type="email"
                    defaultValue={addressDefaults.email}
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
            ) : null}

            {showDeliveryForm ? (
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
                      onChange={markReviewStale}
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
                      onChange={markReviewStale}
                      required
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.checkoutPage.company")}
                      name="shippingCompany"
                      defaultValue={addressDefaults.company}
                      autoComplete="shipping organization"
                      onChange={markReviewStale}
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.checkoutPage.country")}
                      name="shippingCountry"
                      defaultValue={addressDefaults.country}
                      autoComplete="shipping country"
                      onChange={markReviewStale}
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.checkoutPage.address.line1")}
                      name="shippingLine1"
                      defaultValue={addressDefaults.line1}
                      autoComplete="shipping address-line1"
                      onChange={markReviewStale}
                      required
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.checkoutPage.address.line2")}
                      name="shippingLine2"
                      defaultValue={addressDefaults.line2}
                      autoComplete="shipping address-line2"
                      onChange={markReviewStale}
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.checkoutPage.city")}
                      name="shippingCity"
                      defaultValue={addressDefaults.city}
                      autoComplete="shipping address-level2"
                      onChange={markReviewStale}
                      required
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.checkoutPage.state")}
                      name="shippingState"
                      defaultValue={addressDefaults.state}
                      autoComplete="shipping address-level1"
                      onChange={markReviewStale}
                      required
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.checkoutPage.postal.code")}
                      name="shippingPostalCode"
                      defaultValue={addressDefaults.postalCode}
                      autoComplete="shipping postal-code"
                      onChange={markReviewStale}
                      required
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.checkoutPage.phone")}
                      name="shippingPhone"
                      defaultValue={addressDefaults.phone}
                      autoComplete="shipping tel"
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
            ) : null}

            {showShippingMethodForm ? (
              <Surface elevated>
                <CheckoutFormSection
                  title={t("checkout.features.sessions.ui.checkoutPage.shipping.method")}
                  description={t("checkout.features.sessions.ui.checkoutPage.shipping.method.description")}
                >
                  <NativeSelect
                    label={t("checkout.features.sessions.ui.checkoutPage.shipping.option")}
                    name="shippingOption"
                    defaultValue={session.shipping_option}
                    onChange={markReviewStale}
                    items={[
                      {
                        value: "standard",
                        label: t("checkout.features.sessions.ui.checkoutPage.standard.insured"),
                      },
                      { value: "expedited", label: t("checkout.features.sessions.ui.checkoutPage.expedited") },
                      {
                        value: "priority",
                        label: t("checkout.features.sessions.ui.checkoutPage.priority"),
                      },
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
                        shippingOption: shippingOptionLabel(session.shipping_option),
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
                          amount: `$${authenticityCheckOffer.fee_amount}`,
                        })}
                        description={t(
                          "checkout.features.sessions.ui.checkoutPage.authenticity.check.opt.in.description",
                        )}
                        name="authenticityCheckOptIn"
                        value="true"
                        defaultChecked={authenticityCheckSelected}
                        onCheckedChange={markReviewStale}
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
                      value={session.authenticity_check_opt_in?.quoteFingerprint ?? ""}
                    />
                  )}
                </CheckoutFormSection>
              </Surface>
            ) : null}
            {!showShippingMethodForm ? (
              <HiddenInput
                type="hidden"
                name="authenticityCheckOptIn"
                value={authenticityCheckSelected ? "true" : "false"}
              />
            ) : null}
            {!isOfferIntent && showPaymentForm ? (
              <Surface elevated glow>
                <CheckoutFormSection
                  title={t("checkout.features.sessions.ui.checkoutPage.payment")}
                  description={t("checkout.features.sessions.ui.checkoutPage.payment.section.description")}
                  badge={
                    <SecurePaymentIndicator label={t("checkout.features.sessions.ui.checkoutPage.secure.payment")} />
                  }
                >
                  <NativeSelect
                    label={t("checkout.features.sessions.ui.checkoutPage.payment.method")}
                    name="previewPaymentMethodCategory"
                    defaultValue={effectivePaymentMethodCategory}
                    onChange={markReviewStale}
                    items={supportedPaymentMethodCategories.map((category) => ({
                      value: category,
                      label: paymentMethodCategoryLabel(category),
                    }))}
                  />
                  {!isOfferIntent && savedPaymentInstrumentsForEffectiveMethod.length > 0 ? (
                    <NativeSelect
                      label={t("checkout.features.sessions.ui.checkoutPage.saved.payment")}
                      name="savedCheckoutInstrumentId"
                      defaultValue={selectedSavedPaymentInstrument?.instrument_id ?? ""}
                      onChange={markReviewStale}
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
                  {!isOfferIntent &&
                  canSavePaymentMethods &&
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
            ) : null}
            {/* The mobile primary lives in CheckoutStickyActionBar (md:hidden). This
                in-form row is the md+ counterpart, so it hides below md to keep exactly
                one visible "Pay now" per viewport. Both submit checkout-confirmation-form. */}
            <Show from="md">
              <ActionRow
                align="between"
                primary={commitButton()}
                secondary={
                  <LinkButton href="/account/cart" tone="secondary">
                    {t("checkout.features.sessions.ui.checkoutPage.back.to.cart")}
                  </LinkButton>
                }
              />
            </Show>
            <CheckoutPolicyLinks
              guestDataDescription={
                isSignedInBuyer ? null : t("checkout.features.sessions.ui.checkoutPage.guest.data.description")
              }
            />
          </Stack>
        </Form>
      )}
    </Stack>
  );

  const stickyAction = (
    <CheckoutStickyActionBar
      totalLabel={totalsTotalLabel}
      total={hasPayment ? t("checkout.features.sessions.ui.checkoutPage.payment.ready") : totalsTotal}
      context={
        isOfferIntent
          ? t("checkout.features.sessions.ui.checkoutPage.shipping.saved.for.seller.acceptance")
          : t("checkout.features.sessions.ui.checkoutPage.secure.checkout.context")
      }
      reassurance={
        <SecurePaymentIndicator
          label={
            isOfferIntent
              ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
              : t("checkout.features.sessions.ui.checkoutPage.secure.payment")
          }
        />
      }
      primaryAction={commitButton("checkout-confirmation-form")}
      secondaryAction={backToCartAction}
    />
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.features.sessions.ui.checkoutPage.secure.checkout")}
        title={t("checkout.features.sessions.ui.checkoutPage.checkout")}
        description={
          isOfferIntent
            ? t("checkout.features.sessions.ui.checkoutPage.confirm.shipping.place.purchase.intent")
            : signedInBuyCheckout
              ? t("checkout.features.sessions.ui.checkoutPage.signed.in.checkout.description")
              : t("checkout.features.sessions.ui.checkoutPage.simple.checkout.description")
        }
        actions={
          <LinkButton href="/account/cart" tone="secondary">
            {t("checkout.features.sessions.ui.checkoutPage.back.to.cart")}
          </LinkButton>
        }
      />

      {lines.length === 0 ? (
        <MarketplaceEmptyState
          title={t("checkout.features.sessions.ui.checkoutPage.your.cart.is.empty")}
          description={t("checkout.features.sessions.ui.checkoutPage.add.a.product.before.starting.checkout")}
          recoveryActions={
            <LinkButton href="/search">{t("checkout.features.sessions.ui.checkoutPage.browse.marketplace")}</LinkButton>
          }
        />
      ) : (
        <CheckoutFlowShell
          main={main}
          desktopSummary={orderSummary}
          mobileSummary={mobileSummary}
          stickyAction={stickyAction}
          summaryLabel={t("checkout.features.sessions.ui.checkoutPage.checkout.summary")}
        />
      )}
    </Page>
  );
}
