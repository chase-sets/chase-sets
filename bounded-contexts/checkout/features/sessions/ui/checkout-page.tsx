import { t } from "@chase-sets/localization";
import { useState } from "react";
import {
  HiddenInput,
  Form,
  Badge,
  Button,
  Checkbox,
  CheckoutSavedInfoGroup,
  CheckoutSavedInfoRow,
  OrderProtectionModule,
  CheckoutLayout,
  Divider,
  Grid,
  Inline,
  Icon,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProductOptions,
  ProgressiveDisclosure,
  SecurePaymentIndicator,
  Stack,
  StickyCtaBar,
  Surface,
  Text,
  TextInput,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { CheckoutFulfillmentPreview, CheckoutSessionRow } from "../../../support/request-support/api-client";
import { CheckoutPolicyLinks } from "../../shared/ui/checkout-policy-links";

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
}>;

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

function contactSupportingText(phone: string) {
  return phone.trim().length > 0
    ? t("checkout.features.sessions.ui.checkoutPage.contact.row.supporting.phone", { phone })
    : t("checkout.features.sessions.ui.checkoutPage.contact.row.supporting");
}

function normalizedAddressSignature(
  address: Readonly<{
    shippingAddressId: string;
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
    shippingAddressId: address.shippingAddressId.trim() || "__manual",
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
  errorMessage,
  reviewRefreshed = false,
  paymentQuoteRequired = false,
  isSubmitting = false,
  savedShippingAddresses = [],
  savedCheckoutInstruments = [],
  canManageShippingAddresses = false,
  canSavePaymentMethods = false,
  isSignedInBuyer = false,
  initialEditSection = null,
}: {
  session: CheckoutSessionRow;
  wallet?: { available_balance_amount: string; currency_code: string } | null;
  paymentPreview?: CheckoutPaymentPreview | null;
  selectedPaymentMethodCategory?: string;
  fulfillmentPreview?: CheckoutFulfillmentPreview | null;
  errorMessage?: string | null;
  reviewRefreshed?: boolean;
  paymentQuoteRequired?: boolean;
  isSubmitting?: boolean;
  savedShippingAddresses?: readonly CheckoutSavedShippingAddress[];
  savedCheckoutInstruments?: readonly CheckoutSavedPaymentInstrument[];
  canManageShippingAddresses?: boolean;
  canSavePaymentMethods?: boolean;
  isSignedInBuyer?: boolean;
  initialEditSection?: CheckoutEditSection | null;
}) {
  const lines = session.lines;
  const lineCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const hasPayment = Boolean(session.payment_id);
  const isOfferIntent = session.source_type === "offer-intent";
  const signedInBuyCheckout = isSignedInBuyer && !isOfferIntent;
  const preview = fulfillmentPreview ?? null;
  const payment = paymentPreview ?? null;
  const [hasPendingReviewChanges, setHasPendingReviewChanges] = useState(false);
  const [editingSection, setEditingSection] = useState<CheckoutEditSection | null>(initialEditSection);
  const readyCount = isOfferIntent ? 0 : (preview?.readyLineKeys.length ?? lines.length);
  const unavailableCount = isOfferIntent ? lines.length : (preview?.unavailableLineKeys.length ?? 0);
  const needsPaymentQuote = !isOfferIntent && !hasPayment && !payment;
  const needsReviewRefresh = needsPaymentQuote || hasPendingReviewChanges;
  const previewOrderLines = preview?.sellerGroups.flatMap((group) => group.lines) ?? [];
  const unavailableCheckoutLines = !isOfferIntent ? (preview?.unavailableLines ?? []) : [];
  const hasUnavailableCheckoutLines = unavailableCheckoutLines.length > 0 || unavailableCount > 0;
  const canConfirm = isOfferIntent ? lines.length > 0 : readyCount > 0 && !hasUnavailableCheckoutLines;
  const firstDeliveryGroup = firstSellerGroup(preview);
  const defaultSavedAddress =
    savedShippingAddresses.find((address) => address.shipping_address_id === session.shipping_address_id) ??
    savedShippingAddresses.find((address) => address.is_default) ??
    savedShippingAddresses[0] ??
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
          name: "",
          company: "",
          line1: "",
          line2: "",
          city: "",
          state: "",
          postalCode: "",
          country: "US",
          phone: "",
          email: "",
        };
  const previewPayableTotal = payment?.marketplace_checkout_fee.total_amount ?? preview?.totals.totalAmount ?? null;
  const readySavedPaymentInstruments = savedCheckoutInstruments.filter(
    (instrument) => instrument.readiness === "ready",
  );
  const savedPaymentInstrumentsForSelectedMethod = readySavedPaymentInstruments.filter(
    (instrument) => instrument.payment_method_category === selectedPaymentMethodCategory,
  );
  const selectedSavedPaymentInstrument =
    savedPaymentInstrumentsForSelectedMethod.find((instrument) => instrument.is_default) ??
    savedPaymentInstrumentsForSelectedMethod[0] ??
    readySavedPaymentInstruments.find((instrument) => instrument.is_default) ??
    readySavedPaymentInstruments[0] ??
    null;
  const effectivePaymentMethodCategory =
    selectedSavedPaymentInstrument?.payment_method_category ?? selectedPaymentMethodCategory;
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
  const contactReady = signedInBuyCheckout && addressDefaults.email.trim().length > 0;
  const deliveryReady = signedInBuyCheckout && addressIsComplete(addressDefaults);
  const shippingMethodReady = signedInBuyCheckout && Boolean(firstDeliveryGroup);
  const paymentMethodReady = signedInBuyCheckout && Boolean(selectedSavedPaymentInstrument);
  const showSavedCheckoutRows = Boolean(
    signedInBuyCheckout && (contactReady || deliveryReady || shippingMethodReady || paymentMethodReady),
  );
  const activeEditSection = editingSection ?? initialEditSection;
  const showContactForm = !signedInBuyCheckout || !contactReady || activeEditSection === "contact";
  const showDeliveryForm = !signedInBuyCheckout || !deliveryReady || activeEditSection === "delivery";
  const showShippingMethodForm = !signedInBuyCheckout || !shippingMethodReady || activeEditSection === "shipping";
  const showPaymentForm = !signedInBuyCheckout || !paymentMethodReady || activeEditSection === "payment";
  const selectedPaymentSupportingText =
    selectedSavedPaymentInstrument?.confirmation_experience === "off-session-token"
      ? t("checkout.features.sessions.ui.checkoutPage.saved.payment.row.supporting.fast")
      : t("checkout.features.sessions.ui.checkoutPage.saved.payment.row.supporting.secure.step");
  function editRowAction(section: CheckoutEditSection, label: string) {
    return (
      <button
        type="button"
        className="focus-ring inline-flex min-w-0 max-w-full items-center justify-center gap-2 rounded-tokenMd border border-border bg-surface-2 px-3 py-1.5 text-sm font-semibold leading-snug text-foreground shadow-tokenSm transition hover:border-accent hover:text-accent"
        onClick={() => setEditingSection(section)}
      >
        <Icon name="edit" size="sm" tone="accent" />
        <span className="min-w-0">{label}</span>
      </button>
    );
  }
  function markReviewStale() {
    if (!isOfferIntent && !hasPayment) {
      setHasPendingReviewChanges(true);
    }
  }
  const orderSummaryLines = lines.map((line, index) => {
    const previewLine = previewLineForSessionLine(line, previewOrderLines);
    return {
      key: line.cartLineId ?? line.listingId ?? `${line.productId}:${index}`,
      title: line.itemTitle,
      subtitle: line.itemSubtitle,
      productSummary: line.productSummary,
      quantity: line.quantity,
      price: isOfferIntent
        ? formatMoney(line.offerPriceAmount)
        : formatMoney(previewLine?.estimatedLineTotalAmount ?? null),
    };
  });
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
  const summary = (
    <Stack gap={4}>
      <Surface elevated>
        <Stack gap={3}>
          <Inline gap={2}>
            <Text weight="semibold">{t("checkout.features.sessions.ui.checkoutPage.order.summary")}</Text>
            <Badge tone="neutral">
              {t("checkout.features.sessions.ui.checkoutPage.item.count", { count: lineCount })}
            </Badge>
          </Inline>
          {orderSummaryLines.map((line) => (
            <Grid key={line.key} columns={{ base: 1, sm: 2 }} gap={3}>
              <Stack gap={1}>
                <Text weight="semibold">{line.title}</Text>
                {line.subtitle ? (
                  <Text size="sm" tone="secondary">
                    {line.subtitle}
                  </Text>
                ) : null}
                {line.productSummary ? (
                  <ProductOptions options={productOptionsFromSummary(line.productSummary)} variant="compact" />
                ) : null}
                <Text size="sm" tone="secondary">
                  {t("checkout.features.sessions.ui.checkoutPage.quantity.summary", { quantity: line.quantity })}
                </Text>
              </Stack>
              <Text weight="semibold">{line.price}</Text>
            </Grid>
          ))}
        </Stack>
      </Surface>
      <PriceBreakdown
        lines={[
          {
            label: t("checkout.features.sessions.ui.checkoutPage.subtotal"),
            value: formatMoney(preview?.totals.itemSubtotalAmount),
          },
          {
            label: t("checkout.features.sessions.ui.checkoutPage.shipping.2"),
            value: isOfferIntent
              ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
              : formatMoney(preview?.totals.shippingAmount),
          },
          {
            label: t("checkout.features.sessions.ui.checkoutPage.estimated.tax"),
            value: isOfferIntent
              ? t("checkout.features.sessions.ui.checkoutPage.not.applicable")
              : formatMoney(preview?.totals.salesTaxAmount),
          },
          ...(!isOfferIntent
            ? [
                {
                  label: t("checkout.features.sessions.ui.checkoutPage.marketplace.checkout.fee"),
                  value: payment
                    ? `$${payment.marketplace_checkout_fee.marketplace_checkout_fee_amount}`
                    : t("checkout.features.sessions.ui.checkoutPage.calculated.before.payment"),
                },
                {
                  label: t("checkout.features.sessions.ui.checkoutPage.wallet.credit"),
                  value: payment ? `-$${payment.wallet_credit.applied_amount}` : "$0.00",
                },
              ]
            : []),
          ...(wallet
            ? [
                {
                  label: t("checkout.features.sessions.ui.checkoutPage.available.balance"),
                  value: `${wallet.available_balance_amount} ${wallet.currency_code.toUpperCase()}`,
                },
              ]
            : []),
        ]}
        total={
          isOfferIntent
            ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
            : previewPayableTotal
              ? `$${previewPayableTotal}`
              : t("checkout.features.sessions.ui.checkoutPage.pending")
        }
        totalLabel={
          isOfferIntent
            ? t("checkout.features.sessions.ui.checkoutPage.total")
            : t("checkout.features.sessions.ui.checkoutPage.payable.total")
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
        ]}
      />
    </Stack>
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
        <CheckoutLayout
          summary={summary}
          summaryLabel={t("checkout.features.sessions.ui.checkoutPage.checkout.summary")}
        >
          <Stack gap={4}>
            {errorMessage ? (
              <Surface tone="subtle" elevated>
                <Stack gap={2}>
                  <Badge tone="danger">{t("checkout.features.sessions.ui.checkoutPage.checkout.issue")}</Badge>
                  <Text>{errorMessage}</Text>
                </Stack>
              </Surface>
            ) : null}
            {reviewRefreshed ? (
              <MarketplaceNotice
                tone="success"
                title={t("checkout.features.sessions.ui.checkoutPage.review.updated")}
                description={t("checkout.features.sessions.ui.checkoutPage.review.updated.description")}
              />
            ) : null}
            {paymentQuoteRequired ? (
              <MarketplaceNotice
                tone="info"
                title={t("checkout.features.sessions.ui.checkoutPage.payment.quote.required")}
                description={t("checkout.features.sessions.ui.checkoutPage.payment.quote.required.description")}
              />
            ) : null}
            {hasPendingReviewChanges ? (
              <MarketplaceNotice
                tone="warning"
                title={t("checkout.features.sessions.ui.checkoutPage.totals.need.refresh")}
                description={t("checkout.features.sessions.ui.checkoutPage.totals.need.refresh.description")}
              />
            ) : null}

            {!isOfferIntent && hasUnavailableCheckoutLines ? (
              <MarketplaceNotice
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
            ) : null}
            {!isOfferIntent && preview?.materialChangeReasons.length ? (
              <MarketplaceNotice
                tone="warning"
                title={t("checkout.features.sessions.ui.checkoutPage.fulfillment.changed")}
                description={preview.materialChangeReasons.join(" ")}
              />
            ) : null}
            {!showSavedCheckoutRows && canUseAcceleratedSavedPayment ? (
              <MarketplaceNotice
                tone="success"
                title={t("checkout.features.sessions.ui.checkoutPage.fast.checkout.ready")}
                description={t("checkout.features.sessions.ui.checkoutPage.fast.checkout.ready.description", {
                  addressLabel: defaultSavedAddress?.label,
                  paymentMethodCategory:
                    selectedSavedPaymentInstrument?.display_label ?? effectivePaymentMethodCategory.replace("-", " "),
                })}
              />
            ) : null}
            {!showSavedCheckoutRows && returningBuyerFastPath && !canUseAcceleratedSavedPayment ? (
              <MarketplaceNotice
                tone="info"
                title={t("checkout.features.sessions.ui.checkoutPage.saved.payment.step.ready")}
                description={t("checkout.features.sessions.ui.checkoutPage.saved.payment.step.ready.description", {
                  addressLabel: defaultSavedAddress?.label,
                  paymentMethodCategory:
                    selectedSavedPaymentInstrument?.display_label ?? effectivePaymentMethodCategory.replace("-", " "),
                })}
              />
            ) : null}
            {!showSavedCheckoutRows && savedAddressReady ? (
              <MarketplaceNotice
                tone="info"
                title={t("checkout.features.sessions.ui.checkoutPage.saved.address.ready")}
                description={t("checkout.features.sessions.ui.checkoutPage.saved.address.ready.description", {
                  addressLabel: defaultSavedAddress?.label,
                })}
              />
            ) : null}
            {session.payment_id ? (
              <PageSection title={t("checkout.features.sessions.ui.checkoutPage.payment")}>
                <Surface elevated glow>
                  <Stack gap={3}>
                    <Badge tone="success">{t("checkout.features.sessions.ui.checkoutPage.payment.ready.2")}</Badge>
                    <Text>
                      {t("checkout.features.sessions.ui.checkoutPage.purchases.have.been.created.and.payment")}
                    </Text>
                    <LinkButton href={`/account/payments/${session.payment_id}`}>
                      {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}
                    </LinkButton>
                  </Stack>
                </Surface>
              </PageSection>
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
                    value={preview?.materialChangeReasons.length ? "true" : ""}
                  />
                  {!showContactForm ? (
                    <HiddenInput type="hidden" name="shippingEmail" value={addressDefaults.email} />
                  ) : null}
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
                      <HiddenInput
                        type="hidden"
                        name="previewPaymentMethodCategory"
                        value={effectivePaymentMethodCategory}
                      />
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
                    <CheckoutSavedInfoGroup
                      title={t("checkout.features.sessions.ui.checkoutPage.saved.checkout.details")}
                    >
                      {contactReady ? (
                        <CheckoutSavedInfoRow
                          icon="user"
                          label={t("checkout.features.sessions.ui.checkoutPage.contact")}
                          value={addressDefaults.email}
                          supportingText={contactSupportingText(addressDefaults.phone)}
                          status={t("checkout.features.sessions.ui.checkoutPage.ready")}
                          statusTone="success"
                          action={editRowAction(
                            "contact",
                            t("checkout.features.sessions.ui.checkoutPage.edit.contact"),
                          )}
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
                          )}
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
                          action={editRowAction(
                            "shipping",
                            t("checkout.features.sessions.ui.checkoutPage.edit.shipping"),
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
                          action={editRowAction(
                            "payment",
                            t("checkout.features.sessions.ui.checkoutPage.edit.payment"),
                          )}
                        />
                      ) : null}
                    </CheckoutSavedInfoGroup>
                  ) : null}
                  {showContactForm ? (
                    <PageSection title={t("checkout.features.sessions.ui.checkoutPage.contact")}>
                      <Surface elevated glow>
                        <Stack gap={3}>
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
                        </Stack>
                      </Surface>
                    </PageSection>
                  ) : null}

                  {showDeliveryForm ? (
                    <PageSection
                      title={t("checkout.features.sessions.ui.checkoutPage.delivery")}
                      description={
                        isOfferIntent
                          ? t("checkout.features.sessions.ui.checkoutPage.destination.required.for.purchase.intent")
                          : t("checkout.features.sessions.ui.checkoutPage.destination.required.for.sales.tax")
                      }
                    >
                      <Surface elevated>
                        <Stack gap={3}>
                          {savedShippingAddresses.length > 0 ? (
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
                                ...savedShippingAddresses.map((address) => ({
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
                          {canManageShippingAddresses ? (
                            <ProgressiveDisclosure
                              title={t("checkout.features.sessions.ui.checkoutPage.address.preferences")}
                              summary={
                                savedShippingAddresses.length > 0
                                  ? t("checkout.features.sessions.ui.checkoutPage.use.for.this.checkout")
                                  : t("checkout.features.sessions.ui.checkoutPage.save.as.new.address")
                              }
                              tone="info"
                            >
                              <Grid columns={{ base: 1, md: 2 }} gap={3}>
                                <NativeSelect
                                  label={t("checkout.features.sessions.ui.checkoutPage.address.book.preference")}
                                  name="addressBookAction"
                                  defaultValue={savedShippingAddresses.length > 0 ? "checkout-only" : "save-new"}
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
                        </Stack>
                      </Surface>
                    </PageSection>
                  ) : null}

                  {showShippingMethodForm ? (
                    <PageSection
                      title={t("checkout.features.sessions.ui.checkoutPage.shipping.method")}
                      description={t("checkout.features.sessions.ui.checkoutPage.shipping.method.description")}
                    >
                      <Surface elevated>
                        <Stack gap={3}>
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
                            <MarketplaceNotice
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
                            <MarketplaceNotice
                              tone="info"
                              title={t("checkout.features.sessions.ui.checkoutPage.shipping.after.address")}
                              description={t(
                                "checkout.features.sessions.ui.checkoutPage.shipping.after.address.description",
                              )}
                            />
                          )}
                        </Stack>
                      </Surface>
                    </PageSection>
                  ) : null}
                  {!isOfferIntent && showPaymentForm ? (
                    <PageSection
                      title={t("checkout.features.sessions.ui.checkoutPage.payment")}
                      description={t("checkout.features.sessions.ui.checkoutPage.payment.section.description")}
                    >
                      <Surface elevated glow>
                        <Stack gap={3}>
                          <Text tone="secondary">
                            {t("checkout.features.sessions.ui.checkoutPage.all.transactions.secure")}
                          </Text>
                          <NativeSelect
                            label={t("checkout.features.sessions.ui.checkoutPage.payment.method")}
                            name="previewPaymentMethodCategory"
                            defaultValue={effectivePaymentMethodCategory}
                            onChange={markReviewStale}
                            items={[
                              { value: "card", label: t("checkout.features.sessions.ui.checkoutPage.card") },
                              {
                                value: "bank-account",
                                label: t("checkout.features.sessions.ui.checkoutPage.bank.account"),
                              },
                            ]}
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
                              description={t(
                                "checkout.features.sessions.ui.checkoutPage.save.payment.method.description",
                              )}
                              name="savePaymentMethodForFuture"
                              value="true"
                            />
                          ) : null}
                          <MarketplaceNotice
                            tone={payment ? "success" : "info"}
                            title={
                              payment
                                ? t("checkout.features.sessions.ui.checkoutPage.final.totals.before.payment")
                                : t("checkout.features.sessions.ui.checkoutPage.payment.review.next")
                            }
                            description={
                              payment
                                ? t(
                                    "checkout.features.sessions.ui.checkoutPage.final.totals.before.payment.description",
                                  )
                                : wallet
                                  ? t("checkout.features.sessions.ui.checkoutPage.payment.review.next.with.wallet", {
                                      amount: wallet.available_balance_amount,
                                      currency: wallet.currency_code.toUpperCase(),
                                    })
                                  : t("checkout.features.sessions.ui.checkoutPage.payment.review.next.description")
                            }
                          />
                        </Stack>
                      </Surface>
                    </PageSection>
                  ) : null}
                  <Divider />
                  <Inline gap={2}>
                    {!canConfirm && !isOfferIntent ? (
                      <LinkButton href="/account/cart" size="lg" leadingIcon="cart">
                        {t("checkout.features.sessions.ui.checkoutPage.review.buy.cart")}
                      </LinkButton>
                    ) : (
                      <Button
                        type="submit"
                        name="intent"
                        value={needsReviewRefresh ? "refresh-checkout-preview" : "confirm-checkout"}
                        size="lg"
                        leadingIcon={needsReviewRefresh ? "refreshCcw" : "lock"}
                        loading={isSubmitting}
                        disabled={isSubmitting}
                      >
                        {isSubmitting
                          ? isOfferIntent
                            ? t("checkout.features.sessions.ui.checkoutPage.placing.purchase.intent")
                            : t("checkout.features.sessions.ui.checkoutPage.processing.payment")
                          : primaryCtaLabel}
                      </Button>
                    )}
                    <LinkButton href="/account/cart" tone="secondary">
                      {t("checkout.features.sessions.ui.checkoutPage.back.to.cart")}
                    </LinkButton>
                  </Inline>
                  <CheckoutPolicyLinks
                    guestDataDescription={
                      isSignedInBuyer ? null : t("checkout.features.sessions.ui.checkoutPage.guest.data.description")
                    }
                  />
                </Stack>
              </Form>
            )}
            <StickyCtaBar
              price={
                isOfferIntent
                  ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
                  : hasPayment
                    ? t("checkout.features.sessions.ui.checkoutPage.payment.ready")
                    : previewPayableTotal
                      ? `$${previewPayableTotal}`
                      : t("checkout.features.sessions.ui.checkoutPage.pending")
              }
              context={
                isOfferIntent
                  ? t("checkout.features.sessions.ui.checkoutPage.shipping.saved.for.seller.acceptance")
                  : t("checkout.features.sessions.ui.checkoutPage.secure.checkout.context")
              }
              primaryAction={
                hasPayment && session.payment_id ? (
                  <LinkButton href={`/account/payments/${session.payment_id}`}>
                    {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}
                  </LinkButton>
                ) : !canConfirm && !isOfferIntent ? (
                  <LinkButton href="/account/cart" leadingIcon="cart">
                    {t("checkout.features.sessions.ui.checkoutPage.review.buy.cart")}
                  </LinkButton>
                ) : (
                  <Button
                    type="submit"
                    form="checkout-confirmation-form"
                    name="intent"
                    value={needsReviewRefresh ? "refresh-checkout-preview" : "confirm-checkout"}
                    leadingIcon={needsReviewRefresh ? "refreshCcw" : "lock"}
                    disabled={isSubmitting || !canConfirm}
                    loading={isSubmitting}
                  >
                    {isSubmitting
                      ? isOfferIntent
                        ? t("checkout.features.sessions.ui.checkoutPage.placing.purchase.intent")
                        : t("checkout.features.sessions.ui.checkoutPage.processing.payment")
                      : primaryCtaLabel}
                  </Button>
                )
              }
              secondaryAction={
                <LinkButton href="/account/cart" tone="secondary">
                  {t("checkout.features.sessions.ui.checkoutPage.back.to.cart")}
                </LinkButton>
              }
            />
          </Stack>
        </CheckoutLayout>
      )}
    </Page>
  );
}
