import { t } from "@chase-sets/localization";
import {
  AccountReputationSummary,
  Badge,
  Banner,
  Button,
  BuyerProtectionModule,
  CheckoutLayout,
  Divider,
  Grid,
  Inline,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProgressiveDisclosure,
  SecurePaymentIndicator,
  Stack,
  StickyCtaBar,
  Surface,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type {
  CheckoutFulfillmentPreview,
  CheckoutSessionRow,
} from "../../../support/request-support/api-client";

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

function formatLineLabel(line: CheckoutSessionRow["lines"][number]) {
  return [line.itemTitle, line.itemSubtitle, line.productSummary]
    .filter(Boolean)
    .join(" | ");
}

function sellerGroupLabel(group: CheckoutFulfillmentPreview["sellerGroups"][number]) {
  return group.sellerDisplayName?.trim() || "Marketplace seller";
}

function marketRecoveryHref(itemTitle: string) {
  return `/search?q=${encodeURIComponent(itemTitle)}`;
}

export function CheckoutSessionPage({
  session,
  wallet,
  fulfillmentPreview,
  errorMessage,
  isSubmitting = false,
  savedShippingAddresses = [],
  canManageShippingAddresses = false,
}: {
  session: CheckoutSessionRow;
  wallet?: { available_balance_amount: string; currency_code: string } | null;
  fulfillmentPreview?: CheckoutFulfillmentPreview | null;
  errorMessage?: string | null;
  isSubmitting?: boolean;
  savedShippingAddresses?: readonly CheckoutSavedShippingAddress[];
  canManageShippingAddresses?: boolean;
}) {
  const lines = session.lines;
  const lineCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const hasPayment = Boolean(session.payment_id);
  const isOfferIntent = session.source_type === "offer-intent";
  const preview = fulfillmentPreview ?? null;
  const readyCount = isOfferIntent ? 0 : preview?.readyLineKeys.length ?? lines.length;
  const unavailableCount = isOfferIntent ? lines.length : preview?.unavailableLineKeys.length ?? 0;
  const canConfirm = isOfferIntent ? lines.length > 0 : readyCount > 0;
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
    previewAllocationLines.length > 0 &&
    previewAllocationLines.every((line) => line.priceState === "locked");
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
          ...(wallet
            ? [
                {
                  label: t("checkout.features.sessions.ui.checkoutPage.available.balance"),
                  value: `${wallet.available_balance_amount} ${wallet.currency_code.toUpperCase()}`,
                },
              ]
            : []),
        ]}
        total={hasPayment ? t("checkout.features.sessions.ui.checkoutPage.payment.ready") : isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.ready.to.place.purchase.intent") : t("checkout.features.sessions.ui.checkoutPage.ready.to.create.purchases")}
        totalLabel={t("checkout.features.sessions.ui.checkoutPage.checkout.status")}
        reassurance={
          <SecurePaymentIndicator
            label={isOfferIntent
              ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
              : t("checkout.features.sessions.ui.checkoutPage.secure.payment")}
          />
        }
      />
      <BuyerProtectionModule
        items={[
          {
            title: t("checkout.features.sessions.ui.checkoutPage.buyer.protection"),
            description: t("checkout.features.sessions.ui.checkoutPage.eligible.orders.are.protected.through.payment"),
          },
          isOfferIntent
            ? {
                title: t("checkout.features.sessions.ui.checkoutPage.no.payment.today"),
                description: t("checkout.features.sessions.ui.checkoutPage.sellers.can.accept.purchase.intent.before.order"),
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
        description={isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.confirm.shipping.place.purchase.intent") : t("checkout.features.sessions.ui.checkoutPage.choose.shipping.create.purchases.grouped.by")}
        actions={
          <LinkButton href="/account/cart" tone="secondary">
            {t("checkout.features.sessions.ui.checkoutPage.back.to.cart")}</LinkButton>
        }
      />

      {lines.length === 0 ? (
        <MarketplaceEmptyState
          title={t("checkout.features.sessions.ui.checkoutPage.your.cart.is.empty")}
          description={t("checkout.features.sessions.ui.checkoutPage.add.a.product.before.starting.checkout")}
          recoveryActions={<LinkButton href="/search">{t("checkout.features.sessions.ui.checkoutPage.browse.marketplace")}</LinkButton>}
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

            <Banner
              title={isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.purchase.intent.review") : t("checkout.features.sessions.ui.checkoutPage.live.fulfillment.preview")}
              description={isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.purchase.intent.review.description") : t("checkout.features.sessions.ui.checkoutPage.live.fulfillment.preview.description")}
            />

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
                        <Text weight="semibold">{t("checkout.features.sessions.ui.checkoutPage.optimization.locked")}</Text>
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
                            { value: "lowest-total", label: t("checkout.features.sessions.ui.checkoutPage.lowest.delivered.total") },
                            { value: "fewest-shipments", label: t("checkout.features.sessions.ui.checkoutPage.fewest.shipments") },
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
                        { label: t("checkout.features.sessions.ui.checkoutPage.items.2"), value: `$${preview.totals.itemSubtotalAmount}` },
                        { label: t("checkout.features.sessions.ui.checkoutPage.shipping.2"), value: `$${preview.totals.shippingAmount}` },
                        { label: t("checkout.features.sessions.ui.checkoutPage.estimated.tax"), value: `$${preview.totals.salesTaxAmount}` },
                        { label: t("checkout.features.sessions.ui.checkoutPage.packages"), value: preview.totals.packageCount },
                      ]}
                      total={`$${preview.totals.totalAmount}`}
                      totalLabel={t("checkout.features.sessions.ui.checkoutPage.estimated.total")}
                      reassurance={<SecurePaymentIndicator label={t("checkout.features.sessions.ui.checkoutPage.current.preview")} />}
                    />
                    {preview.sellerGroups.map((group) => (
                      <Surface key={group.sellerAccountId} elevated>
                        <Stack gap={3}>
                          <Inline gap={2}>
                            <Badge tone="accent">{t("checkout.features.sessions.ui.checkoutPage.seller.group")}</Badge>
                            <AccountReputationSummary
                              accountName={sellerGroupLabel(group)}
                              averageRating={
                                (group as typeof group & { sellerAverageRating?: string | null }).sellerAverageRating
                              }
                              reviewCount={
                                (group as typeof group & { sellerReviewCount?: number }).sellerReviewCount ?? 0
                              }
                              emptyLabel={t("checkout.features.sessions.ui.checkoutPage.no.seller.feedback.yet")}
                              ratingLabel={t("checkout.features.sessions.ui.checkoutPage.seller.reputation")}
                            />
                            <Text tone="secondary">${group.totalAmount}</Text>
                          </Inline>
                          {group.lines.map((line) => (
                            <Grid key={`${group.sellerAccountId}:${line.lineKey}:${line.listingId}`} columns={{ base: 1, md: 4 }} gap={3}>
                              <Stack gap={1}>
                                <Text weight="semibold">{line.itemTitle}</Text>
                                <Text size="sm" tone="secondary">{line.productSummary ?? "Standard"}</Text>
                              </Stack>
                              <Stack gap={1}>
                                <Text size="sm" tone="secondary">{t("checkout.features.sessions.ui.checkoutPage.allocation")}</Text>
                                <Text>{line.priceState === "locked" ? t("checkout.features.sessions.ui.checkoutPage.selected.seller.listing") : t("checkout.features.sessions.ui.checkoutPage.optimized.seller.listing")}</Text>
                              </Stack>
                              <Stack gap={1}>
                                <Text size="sm" tone="secondary">{t("checkout.features.sessions.ui.checkoutPage.quantity.2")}</Text>
                                <Text>{line.quantity}</Text>
                              </Stack>
                              <Stack gap={1}>
                                <Text size="sm" tone="secondary">{t("checkout.features.sessions.ui.checkoutPage.estimate")}</Text>
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
                                <Text size="sm" tone="secondary">{line.productSummary ?? "Standard"}</Text>
                              </Stack>
                              <Text>{line.reason}</Text>
                              <LinkButton
                                href={marketRecoveryHref(line.itemTitle)}
                                tone="secondary"
                                size="sm"
                              >
                                {t("checkout.features.sessions.ui.checkoutPage.make.offer")}
                              </LinkButton>
                            </Grid>
                          ))}
                        </Stack>
                      </Surface>
                    ) : null}
                  </>
                ) : null}
              </Stack>
            </PageSection>
            ) : null}

            <PageSection
              title={t("checkout.features.sessions.ui.checkoutPage.review.items")}
              description={isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.purchase.intent.review.items.description") : t("checkout.features.sessions.ui.checkoutPage.checkout.creates.purchases.grouped.by.seller")}
            >
              <Stack gap={3}>
                {lines.map((line, index) => (
                  <Surface key={line.cartLineId ?? line.listingId ?? index} elevated>
                    <Grid columns={{ base: 1, md: 3 }} gap={4}>
                      <Stack gap={1}>
                        <Text weight="semibold">{formatLineLabel(line)}</Text>
                        <Text size="sm" tone="secondary">
                          {isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.purchase.intent.saved") : t("checkout.features.sessions.ui.checkoutPage.product.intent.saved")}
                        </Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">{t("checkout.features.sessions.ui.checkoutPage.product")}</Text>
                        <Text weight="medium">{line.productSummary ?? t("checkout.features.sessions.ui.checkoutPage.standard")}</Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">{t("checkout.features.sessions.ui.checkoutPage.quantity")}</Text>
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
                      {t("checkout.features.sessions.ui.checkoutPage.purchases.have.been.created.and.payment")}</Text>
                    <LinkButton href={`/account/payments/${session.payment_id}`}>
                      {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}</LinkButton>
                  </Stack>
                </Surface>
              </PageSection>
            ) : (
              <PageSection
                title={t("checkout.features.sessions.ui.checkoutPage.shipping")}
                description={isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.destination.required.for.purchase.intent") : t("checkout.features.sessions.ui.checkoutPage.destination.required.for.sales.tax")}
              >
                <Surface elevated glow>
                  <form id="checkout-confirmation-form" method="post">
                    <Stack gap={3}>
                      <input type="hidden" name="intent" value="confirm-checkout" />
                      <input
                        type="hidden"
                        name="fulfillmentPreviewRevision"
                        value={preview?.revision ?? ""}
                      />
                      <input
                        type="hidden"
                        name="acknowledgedMaterialChanges"
                        value={preview?.materialChangeReasons.length ? "true" : ""}
                      />
                      <MarketplaceNotice
                        tone="info"
                        title={isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today") : t("checkout.features.sessions.ui.checkoutPage.transparent.totals")}
                        description={isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.purchase.intent.shipping.notice.description") : t("checkout.features.sessions.ui.checkoutPage.transparent.totals.description")}
                      />
                      {savedShippingAddresses.length > 0 ? (
                        <NativeSelect
                          label={t("checkout.features.sessions.ui.checkoutPage.saved.shipping.address")}
                          name="shippingAddressId"
                          defaultValue={addressDefaults.shippingAddressId}
                          items={[
                            { value: "__manual", label: t("checkout.features.sessions.ui.checkoutPage.enter.a.new.address") },
                            ...savedShippingAddresses.map((address) => ({
                              value: address.shipping_address_id,
                              label: address.is_default
                                ? t("checkout.features.sessions.ui.checkoutPage.default.address.option", { label: address.label })
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
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.company")}
                          name="shippingCompany"
                          defaultValue={addressDefaults.company}
                          autoComplete="shipping organization"
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.country")}
                          name="shippingCountry"
                          defaultValue={addressDefaults.country}
                          autoComplete="shipping country"
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.address.line1")}
                          name="shippingLine1"
                          defaultValue={addressDefaults.line1}
                          autoComplete="shipping address-line1"
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.address.line2")}
                          name="shippingLine2"
                          defaultValue={addressDefaults.line2}
                          autoComplete="shipping address-line2"
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.city")}
                          name="shippingCity"
                          defaultValue={addressDefaults.city}
                          autoComplete="shipping address-level2"
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.state")}
                          name="shippingState"
                          defaultValue={addressDefaults.state}
                          autoComplete="shipping address-level1"
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.postal.code")}
                          name="shippingPostalCode"
                          defaultValue={addressDefaults.postalCode}
                          autoComplete="shipping postal-code"
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
                                { value: "checkout-only", label: t("checkout.features.sessions.ui.checkoutPage.use.for.this.checkout") },
                                { value: "save-new", label: t("checkout.features.sessions.ui.checkoutPage.save.as.new.address") },
                                { value: "update-selected", label: t("checkout.features.sessions.ui.checkoutPage.update.selected.address") },
                              ]}
                            />
                            <NativeSelect
                              label={t("checkout.features.sessions.ui.checkoutPage.saved.address.default")}
                              name="makeDefaultShippingAddress"
                              defaultValue="false"
                              items={[
                                { value: "false", label: t("checkout.features.sessions.ui.checkoutPage.do.not.change.default") },
                                { value: "true", label: t("checkout.features.sessions.ui.checkoutPage.make.this.default") },
                              ]}
                            />
                          </Grid>
                        </ProgressiveDisclosure>
                      ) : null}
                      <NativeSelect
                        label={t("checkout.features.sessions.ui.checkoutPage.shipping.option")}
                        name="shippingOption"
                        defaultValue={session.shipping_option}
                        items={[
                          { value: "standard", label: t("checkout.features.sessions.ui.checkoutPage.standard.insured") },
                          { value: "expedited", label: t("checkout.features.sessions.ui.checkoutPage.expedited") },
                          { value: "priority", label: t("checkout.features.sessions.ui.checkoutPage.priority.signature") },
                        ]}
                      />
                      {!isOfferIntent ? (
                        <>
                          <NativeSelect
                            label={t("checkout.features.sessions.ui.checkoutPage.payment.method")}
                            name="paymentMethodCategory"
                            defaultValue="card"
                            items={[
                              { value: "card", label: t("checkout.features.sessions.ui.checkoutPage.card") },
                              { value: "bank-account", label: t("checkout.features.sessions.ui.checkoutPage.bank.account") },
                              { value: "platform-credit", label: t("checkout.features.sessions.ui.checkoutPage.platform.credit.only") },
                            ]}
                            description={t("checkout.features.sessions.ui.checkoutPage.marketplace.checkout.fee.description")}
                          />
                          <ProgressiveDisclosure
                            title={t("checkout.features.sessions.ui.checkoutPage.use.balance")}
                            summary={
                              wallet
                                ? t("checkout.features.sessions.ui.checkoutPage.wallet.available.description", {
                                    amount: wallet.available_balance_amount,
                                    currency: wallet.currency_code.toUpperCase(),
                                  })
                                : t("checkout.features.sessions.ui.checkoutPage.apply.available.wallet.balance.to.this")
                            }
                            tone="info"
                          >
                            <TextInput
                              label={t("checkout.features.sessions.ui.checkoutPage.use.balance")}
                              name="requestedBalanceCreditAmount"
                              placeholder="0.00"
                              inputMode="decimal"
                              description={
                                wallet
                                  ? t("checkout.features.sessions.ui.checkoutPage.wallet.available.description", {
                                      amount: wallet.available_balance_amount,
                                      currency: wallet.currency_code.toUpperCase(),
                                    })
                                  : t("checkout.features.sessions.ui.checkoutPage.apply.available.wallet.balance.to.this")
                              }
                            />
                          </ProgressiveDisclosure>
                        </>
                      ) : null}
                      <Divider />
                      <Button
                        type="submit"
                        size="lg"
                        leadingIcon="lock"
                        loading={isSubmitting}
                        disabled={isSubmitting || !canConfirm}
                      >
                        {isSubmitting
                          ? isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.placing.purchase.intent") : t("checkout.features.sessions.ui.checkoutPage.creating.purchases")
                          : canConfirm
                            ? isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.place.purchase.intent") : t("checkout.features.sessions.ui.checkoutPage.continue.to.payment.2")
                            : "No available supply"}
                      </Button>
                    </Stack>
                  </form>
                </Surface>
              </PageSection>
            )}
            <StickyCtaBar
              price={isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today") : hasPayment ? t("checkout.features.sessions.ui.checkoutPage.payment.ready") : t("checkout.features.sessions.ui.checkoutPage.ready.to.create.purchases")}
              context={isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.shipping.saved.for.seller.acceptance") : t("checkout.features.sessions.ui.checkoutPage.final.totals.before.payment")}
              primaryAction={
                hasPayment && session.payment_id ? (
                  <LinkButton href={`/account/payments/${session.payment_id}`}>
                    {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}
                  </LinkButton>
                ) : (
                  <Button
                    type="submit"
                    form="checkout-confirmation-form"
                    leadingIcon="lock"
                    disabled={isSubmitting || !canConfirm}
                    loading={isSubmitting}
                  >
                    {isSubmitting
                      ? isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.placing.purchase.intent") : t("checkout.features.sessions.ui.checkoutPage.creating.purchases")
                      : isOfferIntent ? t("checkout.features.sessions.ui.checkoutPage.place.purchase.intent") : t("checkout.features.sessions.ui.checkoutPage.continue.to.payment.2")}
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
