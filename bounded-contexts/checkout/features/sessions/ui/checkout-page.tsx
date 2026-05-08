import { t } from "@chase-sets/localization";
import {
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
}: {
  session: CheckoutSessionRow;
  wallet?: { available_balance_amount: string; currency_code: string } | null;
  fulfillmentPreview?: CheckoutFulfillmentPreview | null;
  errorMessage?: string | null;
  isSubmitting?: boolean;
}) {
  const lines = session.lines;
  const lineCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const hasPayment = Boolean(session.payment_id);
  const preview = fulfillmentPreview ?? null;
  const readyCount = preview?.readyLineKeys.length ?? lines.length;
  const unavailableCount = preview?.unavailableLineKeys.length ?? 0;
  const canConfirm = readyCount > 0;
  const previewAllocationLines = preview?.sellerGroups.flatMap((group) => group.lines) ?? [];
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
          { label: t("checkout.features.sessions.ui.checkoutPage.source"), value: session.source_type === "buy-now" ? t("checkout.features.sessions.ui.checkoutPage.buy.now") : t("checkout.features.sessions.ui.checkoutPage.cart") },
          {
            label: t("checkout.features.sessions.ui.checkoutPage.pricing"),
            value: session.order_ids.length > 0
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
        total={hasPayment ? t("checkout.features.sessions.ui.checkoutPage.payment.ready") : t("checkout.features.sessions.ui.checkoutPage.ready.to.create.purchases")}
        totalLabel={t("checkout.features.sessions.ui.checkoutPage.checkout.status")}
        reassurance={<SecurePaymentIndicator label={t("checkout.features.sessions.ui.checkoutPage.secure.payment")} />}
      />
      <BuyerProtectionModule
        items={[
          {
            title: t("checkout.features.sessions.ui.checkoutPage.buyer.protection"),
            description: t("checkout.features.sessions.ui.checkoutPage.eligible.orders.are.protected.through.payment"),
          },
          {
            title: t("checkout.features.sessions.ui.checkoutPage.secure.payment"),
            description: t("checkout.features.sessions.ui.checkoutPage.payment.starts.only.after.orders.are"),
          },
          {
            title: t("checkout.features.sessions.ui.checkoutPage.fulfillment.ready"),
            description: t("checkout.features.sessions.ui.checkoutPage.shipping.preference.is.captured.before.order"),
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
        description={t("checkout.features.sessions.ui.checkoutPage.choose.shipping.create.purchases.grouped.by")}
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
        <CheckoutLayout summary={summary}>
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
              title={t("checkout.features.sessions.ui.checkoutPage.live.fulfillment.preview")}
              description={t("checkout.features.sessions.ui.checkoutPage.live.fulfillment.preview.description")}
            />

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
                            <Text weight="semibold">{sellerGroupLabel(group)}</Text>
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

            <PageSection
              title={t("checkout.features.sessions.ui.checkoutPage.review.items")}
              description={t("checkout.features.sessions.ui.checkoutPage.checkout.creates.purchases.grouped.by.seller")}
            >
              <Stack gap={3}>
                {lines.map((line, index) => (
                  <Surface key={line.cartLineId ?? line.listingId ?? index} elevated>
                    <Grid columns={{ base: 1, md: 3 }} gap={4}>
                      <Stack gap={1}>
                        <Text weight="semibold">{formatLineLabel(line)}</Text>
                        <Text size="sm" tone="secondary">
                          {t("checkout.features.sessions.ui.checkoutPage.product.intent.saved")}
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
                description={t("checkout.features.sessions.ui.checkoutPage.destination.required.for.sales.tax")}
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
                        title={t("checkout.features.sessions.ui.checkoutPage.transparent.totals")}
                        description={t("checkout.features.sessions.ui.checkoutPage.transparent.totals.description")}
                      />
                      <Grid columns={{ base: 1, md: 2 }} gap={3}>
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.recipient.name")}
                          name="shippingName"
                          placeholder={t("checkout.features.sessions.ui.checkoutPage.recipient.placeholder")}
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.country")}
                          name="shippingCountry"
                          defaultValue="US"
                          autoComplete="shipping country"
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.address.line1")}
                          name="shippingLine1"
                          autoComplete="shipping address-line1"
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.address.line2")}
                          name="shippingLine2"
                          autoComplete="shipping address-line2"
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.city")}
                          name="shippingCity"
                          autoComplete="shipping address-level2"
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.state")}
                          name="shippingState"
                          autoComplete="shipping address-level1"
                          required
                        />
                        <TextInput
                          label={t("checkout.features.sessions.ui.checkoutPage.postal.code")}
                          name="shippingPostalCode"
                          autoComplete="shipping postal-code"
                          required
                        />
                      </Grid>
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
                      <Divider />
                      <Button
                        type="submit"
                        size="lg"
                        leadingIcon="lock"
                        loading={isSubmitting}
                        disabled={isSubmitting || !canConfirm}
                      >
                        {isSubmitting ? t("checkout.features.sessions.ui.checkoutPage.creating.purchases") : canConfirm ? t("checkout.features.sessions.ui.checkoutPage.continue.to.payment.2") : "No available supply"}
                      </Button>
                    </Stack>
                  </form>
                </Surface>
              </PageSection>
            )}
            <StickyCtaBar
              price={hasPayment ? t("checkout.features.sessions.ui.checkoutPage.payment.ready") : t("checkout.features.sessions.ui.checkoutPage.ready.to.create.purchases")}
              context={t("checkout.features.sessions.ui.checkoutPage.final.totals.before.payment")}
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
                    {isSubmitting ? t("checkout.features.sessions.ui.checkoutPage.creating.purchases") : t("checkout.features.sessions.ui.checkoutPage.continue.to.payment.2")}
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
