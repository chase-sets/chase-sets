import { t } from "@chase-sets/localization";
import {
  AccountReputationSummary,
  Badge,
  Banner,
  Button,
  OrderProtectionModule,
  CheckoutLayout,
  Divider,
  Grid,
  Inline,
  KeyValueList,
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
  readiness: "ready" | "setup-required";
}>;

function formatLineLabel(line: CheckoutSessionRow["lines"][number]) {
  return [line.itemTitle, line.itemSubtitle, line.productSummary].filter(Boolean).join(" | ");
}

function sellerGroupLabel(group: CheckoutFulfillmentPreview["sellerGroups"][number]) {
  return group.sellerDisplayName?.trim() || "Marketplace seller";
}

function deliveryWindowLabel(group: CheckoutFulfillmentPreview["sellerGroups"][number]) {
  return `${group.deliveryEstimate.earliestDate} - ${group.deliveryEstimate.latestDate}`;
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

function marketRecoveryHref(itemTitle: string) {
  return `/search?q=${encodeURIComponent(itemTitle)}`;
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
}) {
  const lines = session.lines;
  const lineCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const hasPayment = Boolean(session.payment_id);
  const isOfferIntent = session.source_type === "offer-intent";
  const preview = fulfillmentPreview ?? null;
  const payment = paymentPreview ?? null;
  const readyCount = isOfferIntent ? 0 : (preview?.readyLineKeys.length ?? lines.length);
  const unavailableCount = isOfferIntent ? lines.length : (preview?.unavailableLineKeys.length ?? 0);
  const canConfirm = isOfferIntent ? lines.length > 0 : readyCount > 0;
  const needsPaymentQuote = !isOfferIntent && !hasPayment && !payment;
  const previewAllocationLines = preview?.sellerGroups.flatMap((group) => group.lines) ?? [];
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
  const hasOnlyLockedAllocations =
    previewAllocationLines.length > 0 && previewAllocationLines.every((line) => line.priceState === "locked");
  const previewPayableTotal = payment?.marketplace_checkout_fee.total_amount ?? preview?.totals.totalAmount ?? null;
  const defaultSavedPaymentInstrument =
    savedCheckoutInstruments.find((instrument) => instrument.is_default && instrument.readiness === "ready") ??
    savedCheckoutInstruments.find((instrument) => instrument.readiness === "ready") ??
    null;
  const returningBuyerFastPath = Boolean(
    defaultSavedAddress && defaultSavedPaymentInstrument && !isOfferIntent && !hasPayment,
  );
  const canUseAcceleratedSavedPayment = Boolean(
    returningBuyerFastPath && payment && defaultSavedPaymentInstrument?.confirmation_experience === "off-session-token",
  );
  const savedAddressReady = Boolean(
    defaultSavedAddress && !defaultSavedPaymentInstrument && !isOfferIntent && !hasPayment,
  );
  function requestPreviewRefresh(event: { currentTarget: HTMLInputElement | HTMLSelectElement }) {
    if (!isOfferIntent && !hasPayment) {
      const form = event.currentTarget.form;
      const refreshButton = form?.querySelector<HTMLButtonElement>(
        'button[name="intent"][value="refresh-checkout-preview"]',
      );
      if (refreshButton) {
        form?.requestSubmit(refreshButton);
      }
    }
  }
  const summary = (
    <Stack gap={4}>
      <PriceBreakdown
        lines={[
          { label: t("checkout.features.sessions.ui.checkoutPage.items"), value: lineCount },
          { label: t("checkout.features.sessions.ui.checkoutPage.lines"), value: lines.length },
          { label: t("checkout.features.sessions.ui.checkoutPage.ready.now"), value: readyCount },
          { label: t("checkout.features.sessions.ui.checkoutPage.needs.supply"), value: unavailableCount },
          {
            label: t("checkout.features.sessions.ui.checkoutPage.source"),
            value: isOfferIntent
              ? t("checkout.features.sessions.ui.checkoutPage.purchase.intent")
              : session.source_type === "buy-now"
                ? t("checkout.features.sessions.ui.checkoutPage.buy.now")
                : t("checkout.features.sessions.ui.checkoutPage.cart"),
          },
          {
            label: t("checkout.features.sessions.ui.checkoutPage.pricing"),
            value: isOfferIntent
              ? t("checkout.features.sessions.ui.checkoutPage.offer.submitted.after.review")
              : session.order_ids.length > 0
                ? t("checkout.features.sessions.ui.checkoutPage.order.totals.created")
                : "Previewed now, committed on confirmation",
          },
          ...(!isOfferIntent
            ? [
                {
                  label: t("checkout.features.sessions.ui.checkoutPage.marketplace.checkout.fee"),
                  value: payment
                    ? `$${payment.marketplace_checkout_fee.marketplace_checkout_fee_amount}`
                    : t("checkout.features.sessions.ui.checkoutPage.reviewed.before.payment"),
                },
                {
                  label: t("checkout.features.sessions.ui.checkoutPage.wallet.credit"),
                  value: payment ? `-$${payment.wallet_credit.applied_amount}` : "$0.00",
                },
                {
                  label: t("checkout.features.sessions.ui.checkoutPage.payable.total"),
                  value: payment
                    ? `$${payment.marketplace_checkout_fee.total_amount}`
                    : t("checkout.features.sessions.ui.checkoutPage.preview.after.address"),
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
          hasPayment
            ? t("checkout.features.sessions.ui.checkoutPage.payment.ready")
            : isOfferIntent
              ? t("checkout.features.sessions.ui.checkoutPage.ready.to.place.purchase.intent")
              : t("checkout.features.sessions.ui.checkoutPage.ready.to.create.purchases")
        }
        totalLabel={t("checkout.features.sessions.ui.checkoutPage.checkout.status")}
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
              : t("checkout.features.sessions.ui.checkoutPage.shipping.preference.is.captured.before.order"),
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
            : t("checkout.features.sessions.ui.checkoutPage.choose.shipping.create.purchases.grouped.by")
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
        <CheckoutLayout summary={summary} summaryLabel="Checkout summary">
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

            <Banner
              title={
                isOfferIntent
                  ? t("checkout.features.sessions.ui.checkoutPage.purchase.intent.review")
                  : t("checkout.features.sessions.ui.checkoutPage.live.fulfillment.preview")
              }
              description={
                isOfferIntent
                  ? t("checkout.features.sessions.ui.checkoutPage.purchase.intent.review.description")
                  : t("checkout.features.sessions.ui.checkoutPage.live.fulfillment.preview.description")
              }
            />
            {canUseAcceleratedSavedPayment ? (
              <MarketplaceNotice
                tone="success"
                title={t("checkout.features.sessions.ui.checkoutPage.fast.checkout.ready")}
                description={t("checkout.features.sessions.ui.checkoutPage.fast.checkout.ready.description", {
                  addressLabel: defaultSavedAddress?.label,
                  paymentMethodCategory:
                    defaultSavedPaymentInstrument?.display_label ?? selectedPaymentMethodCategory.replace("-", " "),
                })}
              />
            ) : null}
            {returningBuyerFastPath && !canUseAcceleratedSavedPayment ? (
              <MarketplaceNotice
                tone="info"
                title={t("checkout.features.sessions.ui.checkoutPage.saved.payment.step.ready")}
                description={t("checkout.features.sessions.ui.checkoutPage.saved.payment.step.ready.description", {
                  addressLabel: defaultSavedAddress?.label,
                  paymentMethodCategory:
                    defaultSavedPaymentInstrument?.display_label ?? selectedPaymentMethodCategory.replace("-", " "),
                })}
              />
            ) : null}
            {savedAddressReady ? (
              <MarketplaceNotice
                tone="info"
                title={t("checkout.features.sessions.ui.checkoutPage.saved.address.ready")}
                description={t("checkout.features.sessions.ui.checkoutPage.saved.address.ready.description", {
                  addressLabel: defaultSavedAddress?.label,
                })}
              />
            ) : null}
            {!isOfferIntent && savedCheckoutInstruments.length === 0 ? (
              <MarketplaceNotice
                tone="info"
                title={t("checkout.features.sessions.ui.checkoutPage.saved.payment.instrument.ready")}
                description={t("checkout.features.sessions.ui.checkoutPage.saved.payment.instrument.ready.description")}
              />
            ) : null}

            {!isOfferIntent ? (
              <PageSection
                title={t("checkout.features.sessions.ui.checkoutPage.fulfillment")}
                description={t("checkout.features.sessions.ui.checkoutPage.fulfillment.description")}
              >
                <Stack gap={3}>
                  <Surface elevated>
                    {hasOnlyLockedAllocations ? (
                      <Stack gap={2}>
                        <Inline gap={2}>
                          <Badge tone="success">{t("checkout.features.sessions.ui.checkoutPage.locked.seller")}</Badge>
                          <Text weight="semibold">
                            {t("checkout.features.sessions.ui.checkoutPage.optimization.locked")}
                          </Text>
                        </Inline>
                        <Text size="sm" tone="secondary">
                          {t("checkout.features.sessions.ui.checkoutPage.locked.optimization.description")}
                        </Text>
                      </Stack>
                    ) : (
                      <form method="post">
                        <Stack gap={3}>
                          <input type="hidden" name="intent" value="select-optimization-goal" />
                          <NativeSelect
                            label={t("checkout.features.sessions.ui.checkoutPage.optimization")}
                            name="optimizationGoal"
                            defaultValue={session.optimization_goal}
                            items={[
                              {
                                value: "lowest-total",
                                label: t("checkout.features.sessions.ui.checkoutPage.lowest.delivered.total"),
                              },
                              {
                                value: "fewest-shipments",
                                label: t("checkout.features.sessions.ui.checkoutPage.fewest.shipments"),
                              },
                            ]}
                          />
                          <Button type="submit" tone="secondary">
                            {t("checkout.features.sessions.ui.checkoutPage.recalculate.fulfillment")}
                          </Button>
                        </Stack>
                      </form>
                    )}
                  </Surface>

                  {preview ? (
                    <>
                      <PriceBreakdown
                        lines={[
                          {
                            label: t("checkout.features.sessions.ui.checkoutPage.items.2"),
                            value: `$${preview.totals.itemSubtotalAmount}`,
                          },
                          {
                            label: t("checkout.features.sessions.ui.checkoutPage.shipping.2"),
                            value: `$${preview.totals.shippingAmount}`,
                          },
                          {
                            label: t("checkout.features.sessions.ui.checkoutPage.estimated.tax"),
                            value: `$${preview.totals.salesTaxAmount}`,
                          },
                          {
                            label: t("checkout.features.sessions.ui.checkoutPage.packages"),
                            value: preview.totals.packageCount,
                          },
                          ...(payment
                            ? [
                                {
                                  label: t("checkout.features.sessions.ui.checkoutPage.marketplace.checkout.fee"),
                                  value: `$${payment.marketplace_checkout_fee.marketplace_checkout_fee_amount}`,
                                },
                                {
                                  label: t("checkout.features.sessions.ui.checkoutPage.wallet.credit"),
                                  value: `-$${payment.wallet_credit.applied_amount}`,
                                },
                              ]
                            : []),
                        ]}
                        total={`$${previewPayableTotal ?? preview.totals.totalAmount}`}
                        totalLabel={
                          payment
                            ? t("checkout.features.sessions.ui.checkoutPage.payable.total")
                            : t("checkout.features.sessions.ui.checkoutPage.estimated.total")
                        }
                        reassurance={
                          <SecurePaymentIndicator
                            label={t("checkout.features.sessions.ui.checkoutPage.current.preview")}
                          />
                        }
                      />
                      {preview.sellerGroups.map((group) => (
                        <Surface key={group.sellerAccountId} elevated>
                          <Stack gap={3}>
                            <Inline gap={2}>
                              <Badge tone="accent">
                                {t("checkout.features.sessions.ui.checkoutPage.seller.group")}
                              </Badge>
                              <AccountReputationSummary
                                accountName={sellerGroupLabel(group)}
                                averageRating={
                                  (group as typeof group & { sellerAverageRating?: string | null }).sellerAverageRating
                                }
                                reviewCount={
                                  (group as typeof group & { sellerReviewCount?: number }).sellerReviewCount ?? 0
                                }
                                ratingLabel={t("checkout.features.sessions.ui.checkoutPage.seller.reputation")}
                              />
                              <Text tone="secondary">${group.totalAmount}</Text>
                            </Inline>
                            <KeyValueList
                              density="compact"
                              variant="plain"
                              items={[
                                {
                                  key: t("checkout.features.sessions.ui.checkoutPage.delivery.estimate"),
                                  value: deliveryWindowLabel(group),
                                },
                                {
                                  key: t("checkout.features.sessions.ui.checkoutPage.shipping.service"),
                                  value: t("checkout.features.sessions.ui.checkoutPage.estimated.days.after.purchase", {
                                    minimumDays: group.deliveryEstimate.minimumTransitDays,
                                    maximumDays: group.deliveryEstimate.maximumTransitDays,
                                  }),
                                },
                                {
                                  key: t("checkout.features.sessions.ui.checkoutPage.ships.from"),
                                  value: group.deliveryEstimate.shipFromRegion,
                                },
                                {
                                  key: t("checkout.features.sessions.ui.checkoutPage.package.plan"),
                                  value: t("checkout.features.sessions.ui.checkoutPage.package.plan.value", {
                                    packageCount: group.deliveryEstimate.packageCount,
                                    packagePlural: group.deliveryEstimate.packageCount === 1 ? "" : "s",
                                    serviceLevel: group.deliveryEstimate.serviceLevel,
                                  }),
                                },
                                {
                                  key: t("checkout.features.sessions.ui.checkoutPage.delivery.basis"),
                                  value: group.deliveryEstimate.basis,
                                },
                                {
                                  key: t("checkout.features.sessions.ui.checkoutPage.fulfillment.cutoff"),
                                  value: t("checkout.features.sessions.ui.checkoutPage.fulfillment.cutoff.value", {
                                    cutoffTime: group.deliveryEstimate.cutoffTimeLocal,
                                    packingStartDate: group.deliveryEstimate.packingStartDate,
                                    carrierHandoffDate: group.deliveryEstimate.carrierHandoffDate,
                                  }),
                                },
                                {
                                  key: t("checkout.features.sessions.ui.checkoutPage.delivery.promise"),
                                  value: t("checkout.features.sessions.ui.checkoutPage.delivery.promise.preview"),
                                },
                              ]}
                            />
                            {group.lines.map((line) => (
                              <Grid
                                key={`${group.sellerAccountId}:${line.lineKey}:${line.listingId}`}
                                columns={{ base: 1, md: 4 }}
                                gap={3}
                              >
                                <Stack gap={1}>
                                  <Text weight="semibold">{line.itemTitle}</Text>
                                  {line.productSummary ? (
                                    <ProductOptions
                                      options={productOptionsFromSummary(line.productSummary)}
                                      variant="compact"
                                    />
                                  ) : (
                                    <ProductOptions
                                      options={[]}
                                      emptyLabel={t("checkout.features.sessions.ui.checkoutPage.standard")}
                                      variant="compact"
                                    />
                                  )}
                                </Stack>
                                <Stack gap={1}>
                                  <Text size="sm" tone="secondary">
                                    {t("checkout.features.sessions.ui.checkoutPage.allocation")}
                                  </Text>
                                  <Text>
                                    {line.priceState === "locked"
                                      ? t("checkout.features.sessions.ui.checkoutPage.selected.seller.listing")
                                      : t("checkout.features.sessions.ui.checkoutPage.optimized.seller.listing")}
                                  </Text>
                                </Stack>
                                <Stack gap={1}>
                                  <Text size="sm" tone="secondary">
                                    {t("checkout.features.sessions.ui.checkoutPage.quantity.2")}
                                  </Text>
                                  <Text>{line.quantity}</Text>
                                </Stack>
                                <Stack gap={1}>
                                  <Text size="sm" tone="secondary">
                                    {t("checkout.features.sessions.ui.checkoutPage.estimate")}
                                  </Text>
                                  <Text>${line.estimatedLineTotalAmount}</Text>
                                  <Badge tone={line.priceState === "locked" ? "success" : "neutral"}>
                                    {line.priceState === "locked"
                                      ? t("checkout.features.sessions.ui.checkoutPage.locked.listing")
                                      : t("checkout.features.sessions.ui.checkoutPage.optimized")}
                                  </Badge>
                                </Stack>
                              </Grid>
                            ))}
                          </Stack>
                        </Surface>
                      ))}
                      {preview.unavailableLines.length > 0 ? (
                        <Surface tone="subtle" elevated>
                          <Stack gap={3}>
                            <Badge tone="warning">{t("checkout.features.sessions.ui.checkoutPage.needs.supply")}</Badge>
                            {preview.unavailableLines.map((line) => (
                              <Grid key={line.lineKey} columns={{ base: 1, md: 3 }} gap={3}>
                                <Stack gap={1}>
                                  <Text weight="semibold">{line.itemTitle}</Text>
                                  {line.productSummary ? (
                                    <ProductOptions
                                      options={productOptionsFromSummary(line.productSummary)}
                                      variant="compact"
                                    />
                                  ) : (
                                    <ProductOptions
                                      options={[]}
                                      emptyLabel={t("checkout.features.sessions.ui.checkoutPage.standard")}
                                      variant="compact"
                                    />
                                  )}
                                </Stack>
                                <Text>{line.reason}</Text>
                                <LinkButton href={marketRecoveryHref(line.itemTitle)} tone="secondary" size="sm">
                                  {t("checkout.features.sessions.ui.checkoutPage.make.offer")}
                                </LinkButton>
                              </Grid>
                            ))}
                          </Stack>
                        </Surface>
                      ) : null}
                      {preview.materialChangeReasons.length > 0 ? (
                        <MarketplaceNotice
                          tone="warning"
                          title={t("checkout.features.sessions.ui.checkoutPage.fulfillment.changed")}
                          description={preview.materialChangeReasons.join(" ")}
                        />
                      ) : null}
                    </>
                  ) : null}
                </Stack>
              </PageSection>
            ) : null}

            <PageSection
              title={t("checkout.features.sessions.ui.checkoutPage.review.items")}
              description={
                isOfferIntent
                  ? t("checkout.features.sessions.ui.checkoutPage.purchase.intent.review.items.description")
                  : t("checkout.features.sessions.ui.checkoutPage.checkout.creates.purchases.grouped.by.seller")
              }
            >
              <Stack gap={3}>
                {lines.map((line, index) => (
                  <Surface key={line.cartLineId ?? line.listingId ?? index} elevated>
                    <Grid columns={{ base: 1, md: 3 }} gap={4}>
                      <Stack gap={1}>
                        <Text weight="semibold">{formatLineLabel(line)}</Text>
                        <Text size="sm" tone="secondary">
                          {isOfferIntent
                            ? t("checkout.features.sessions.ui.checkoutPage.purchase.intent.saved")
                            : t("checkout.features.sessions.ui.checkoutPage.product.intent.saved")}
                        </Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">
                          {t("checkout.features.sessions.ui.checkoutPage.product")}
                        </Text>
                        {line.productSummary ? (
                          <ProductOptions options={productOptionsFromSummary(line.productSummary)} />
                        ) : (
                          <Text weight="medium">{t("checkout.features.sessions.ui.checkoutPage.standard")}</Text>
                        )}
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">
                          {t("checkout.features.sessions.ui.checkoutPage.quantity")}
                        </Text>
                        <Text>{line.quantity}</Text>
                      </Stack>
                    </Grid>
                  </Surface>
                ))}
              </Stack>
            </PageSection>

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
              <PageSection
                title={t("checkout.features.sessions.ui.checkoutPage.shipping")}
                description={
                  isOfferIntent
                    ? t("checkout.features.sessions.ui.checkoutPage.destination.required.for.purchase.intent")
                    : t("checkout.features.sessions.ui.checkoutPage.destination.required.for.sales.tax")
                }
              >
                <Surface elevated glow>
                  <form id="checkout-confirmation-form" method="post">
                    <Stack gap={3}>
                      <input type="hidden" name="fulfillmentPreviewRevision" value={preview?.revision ?? ""} />
                      <input
                        type="hidden"
                        name="marketplaceCheckoutFeeQuoteFingerprint"
                        value={payment?.marketplace_checkout_fee.quote_fingerprint ?? ""}
                      />
                      <input
                        type="hidden"
                        name="requestedBalanceCreditAmount"
                        value={payment?.wallet_credit.requested_amount ?? wallet?.available_balance_amount ?? "0.00"}
                      />
                      <input type="hidden" name="paymentMethodCategory" value={selectedPaymentMethodCategory} />
                      <input
                        type="hidden"
                        name="acceleratedSavedPayment"
                        value={canUseAcceleratedSavedPayment ? "true" : "false"}
                      />
                      <input type="hidden" name="sourceType" value={session.source_type} />
                      <input type="hidden" name="reviewedShippingOption" value={session.shipping_option} />
                      <input
                        type="hidden"
                        name="reviewedShippingAddressSignature"
                        value={normalizedAddressSignature(addressDefaults)}
                      />
                      <input
                        type="hidden"
                        name="acknowledgedMaterialChanges"
                        value={preview?.materialChangeReasons.length ? "true" : ""}
                      />
                      <MarketplaceNotice
                        tone="info"
                        title={
                          isOfferIntent
                            ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
                            : t("checkout.features.sessions.ui.checkoutPage.transparent.totals")
                        }
                        description={
                          isOfferIntent
                            ? t(
                                "checkout.features.sessions.ui.checkoutPage.purchase.intent.shipping.notice.description",
                              )
                            : t("checkout.features.sessions.ui.checkoutPage.transparent.totals.description")
                        }
                      />
                      {savedShippingAddresses.length > 0 ? (
                        <NativeSelect
                          label={t("checkout.features.sessions.ui.checkoutPage.saved.shipping.address")}
                          name="shippingAddressId"
                          defaultValue={addressDefaults.shippingAddressId}
                          onChange={requestPreviewRefresh}
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
                          onBlur={requestPreviewRefresh}
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.company")}
                          name="shippingCompany"
                          defaultValue={addressDefaults.company}
                          autoComplete="shipping organization"
                          onBlur={requestPreviewRefresh}
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.country")}
                          name="shippingCountry"
                          defaultValue={addressDefaults.country}
                          autoComplete="shipping country"
                          onBlur={requestPreviewRefresh}
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.address.line1")}
                          name="shippingLine1"
                          defaultValue={addressDefaults.line1}
                          autoComplete="shipping address-line1"
                          onBlur={requestPreviewRefresh}
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.address.line2")}
                          name="shippingLine2"
                          defaultValue={addressDefaults.line2}
                          autoComplete="shipping address-line2"
                          onBlur={requestPreviewRefresh}
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.city")}
                          name="shippingCity"
                          defaultValue={addressDefaults.city}
                          autoComplete="shipping address-level2"
                          onBlur={requestPreviewRefresh}
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.state")}
                          name="shippingState"
                          defaultValue={addressDefaults.state}
                          autoComplete="shipping address-level1"
                          onBlur={requestPreviewRefresh}
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.postal.code")}
                          name="shippingPostalCode"
                          defaultValue={addressDefaults.postalCode}
                          autoComplete="shipping postal-code"
                          onBlur={requestPreviewRefresh}
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.phone")}
                          name="shippingPhone"
                          defaultValue={addressDefaults.phone}
                          autoComplete="shipping tel"
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.email")}
                          name="shippingEmail"
                          type="email"
                          defaultValue={addressDefaults.email}
                          autoComplete="shipping email"
                        />
                      </Grid>
                      {canManageShippingAddresses ? (
                        <ProgressiveDisclosure
                          title={t("checkout.features.sessions.ui.checkoutPage.address.book.action")}
                          summary={
                            savedShippingAddresses.length > 0
                              ? t("checkout.features.sessions.ui.checkoutPage.use.for.this.checkout")
                              : t("checkout.features.sessions.ui.checkoutPage.save.as.new.address")
                          }
                          tone="info"
                        >
                          <Grid columns={{ base: 1, md: 2 }} gap={3}>
                            <NativeSelect
                              label={t("checkout.features.sessions.ui.checkoutPage.address.book.action")}
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
                              label={t("checkout.features.sessions.ui.checkoutPage.saved.address.default")}
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
                      <NativeSelect
                        label={t("checkout.features.sessions.ui.checkoutPage.shipping.option")}
                        name="shippingOption"
                        defaultValue={session.shipping_option}
                        onChange={requestPreviewRefresh}
                        items={[
                          {
                            value: "standard",
                            label: t("checkout.features.sessions.ui.checkoutPage.standard.insured"),
                          },
                          { value: "expedited", label: t("checkout.features.sessions.ui.checkoutPage.expedited") },
                          {
                            value: "priority",
                            label: t("checkout.features.sessions.ui.checkoutPage.priority.signature"),
                          },
                        ]}
                      />
                      {!isOfferIntent ? (
                        <NativeSelect
                          label={t("checkout.features.sessions.ui.checkoutPage.payment.method")}
                          name="previewPaymentMethodCategory"
                          defaultValue={selectedPaymentMethodCategory}
                          onChange={requestPreviewRefresh}
                          items={[
                            { value: "card", label: t("checkout.features.sessions.ui.checkoutPage.card") },
                            {
                              value: "bank-account",
                              label: t("checkout.features.sessions.ui.checkoutPage.bank.account"),
                            },
                          ]}
                        />
                      ) : null}
                      {!isOfferIntent ? (
                        <MarketplaceNotice
                          tone="info"
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
                      ) : null}
                      <Divider />
                      <Inline gap={2}>
                        {!isOfferIntent ? (
                          <Button
                            type="submit"
                            name="intent"
                            value="refresh-checkout-preview"
                            tone="secondary"
                            leadingIcon="refreshCcw"
                            loading={isSubmitting}
                          >
                            {t("checkout.features.sessions.ui.checkoutPage.refresh.totals")}
                          </Button>
                        ) : null}
                        <Button
                          type="submit"
                          name="intent"
                          value={needsPaymentQuote ? "refresh-checkout-preview" : "confirm-checkout"}
                          size="lg"
                          leadingIcon={needsPaymentQuote ? "refreshCcw" : "lock"}
                          loading={isSubmitting}
                          disabled={isSubmitting || !canConfirm}
                        >
                          {isSubmitting
                            ? isOfferIntent
                              ? t("checkout.features.sessions.ui.checkoutPage.placing.purchase.intent")
                              : t("checkout.features.sessions.ui.checkoutPage.creating.purchases")
                            : canConfirm
                              ? isOfferIntent
                                ? t("checkout.features.sessions.ui.checkoutPage.place.purchase.intent")
                                : canUseAcceleratedSavedPayment
                                  ? t("checkout.features.sessions.ui.checkoutPage.place.order.with.saved.payment", {
                                      paymentMethodCategory:
                                        defaultSavedPaymentInstrument?.display_label ??
                                        selectedPaymentMethodCategory.replace("-", " "),
                                    })
                                  : payment
                                    ? t(
                                        "checkout.features.sessions.ui.checkoutPage.create.purchases.continue.to.payment",
                                      )
                                    : t("checkout.features.sessions.ui.checkoutPage.review.latest.total")
                              : t("checkout.features.sessions.ui.checkoutPage.no.available.supply")}
                        </Button>
                      </Inline>
                    </Stack>
                  </form>
                </Surface>
              </PageSection>
            )}
            <StickyCtaBar
              price={
                isOfferIntent
                  ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
                  : hasPayment
                    ? t("checkout.features.sessions.ui.checkoutPage.payment.ready")
                    : previewPayableTotal
                      ? `$${previewPayableTotal}`
                      : t("checkout.features.sessions.ui.checkoutPage.ready.to.review.payment")
              }
              context={
                isOfferIntent
                  ? t("checkout.features.sessions.ui.checkoutPage.shipping.saved.for.seller.acceptance")
                  : t("checkout.features.sessions.ui.checkoutPage.orders.then.payment.review")
              }
              primaryAction={
                hasPayment && session.payment_id ? (
                  <LinkButton href={`/account/payments/${session.payment_id}`}>
                    {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}
                  </LinkButton>
                ) : (
                  <Button
                    type="submit"
                    form="checkout-confirmation-form"
                    name="intent"
                    value={needsPaymentQuote ? "refresh-checkout-preview" : "confirm-checkout"}
                    leadingIcon={needsPaymentQuote ? "refreshCcw" : "lock"}
                    disabled={isSubmitting || !canConfirm}
                    loading={isSubmitting}
                  >
                    {isSubmitting
                      ? isOfferIntent
                        ? t("checkout.features.sessions.ui.checkoutPage.placing.purchase.intent")
                        : t("checkout.features.sessions.ui.checkoutPage.creating.purchases")
                      : isOfferIntent
                        ? t("checkout.features.sessions.ui.checkoutPage.place.purchase.intent")
                        : needsPaymentQuote
                          ? t("checkout.features.sessions.ui.checkoutPage.review.latest.total")
                          : canUseAcceleratedSavedPayment
                            ? t("checkout.features.sessions.ui.checkoutPage.place.order.with.saved.payment", {
                                paymentMethodCategory:
                                  defaultSavedPaymentInstrument?.display_label ??
                                  selectedPaymentMethodCategory.replace("-", " "),
                              })
                            : t("checkout.features.sessions.ui.checkoutPage.create.purchases.continue.to.payment")}
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
