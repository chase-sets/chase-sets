import { t } from "@chase-sets/localization";
import {
  Badge,
  Banner,
  Button,
  BuyerProtectionModule,
  CheckoutLayout,
  Divider,
  Grid,
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
import type { CheckoutSessionRow } from "../../../support/request-support/api-client";

function formatLineLabel(line: CheckoutSessionRow["lines"][number]) {
  return [line.itemTitle, line.itemSubtitle, line.productSummary]
    .filter(Boolean)
    .join(" | ");
}

export function CheckoutSessionPage({
  session,
  wallet,
  errorMessage,
  isSubmitting = false,
}: {
  session: CheckoutSessionRow;
  wallet?: { available_balance_amount: string; currency_code: string } | null;
  errorMessage?: string | null;
  isSubmitting?: boolean;
}) {
  const lines = session.lines;
  const lineCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const hasPayment = Boolean(session.payment_id);
  const summary = (
    <Stack gap={4}>
      <PriceBreakdown
        lines={[
          { label: t("checkout.features.sessions.ui.checkoutPage.items"), value: lineCount },
          { label: t("checkout.features.sessions.ui.checkoutPage.lines"), value: lines.length },
          { label: t("checkout.features.sessions.ui.checkoutPage.source"), value: session.source_type === "buy-now" ? t("checkout.features.sessions.ui.checkoutPage.buy.now") : t("checkout.features.sessions.ui.checkoutPage.cart") },
          {
            label: t("checkout.features.sessions.ui.checkoutPage.pricing"),
            value: session.order_ids.length > 0
              ? t("checkout.features.sessions.ui.checkoutPage.order.totals.created")
              : t("checkout.features.sessions.ui.checkoutPage.calculated.when.purchases.are.created"),
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
              title={t("checkout.features.sessions.ui.checkoutPage.same.seller.shipping.credit")}
              description={t("checkout.features.sessions.ui.checkoutPage.each.seller.grouped.purchase.applies.the.listing.credit")}
            />

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
                          {t("checkout.features.sessions.ui.checkoutPage.catalog.item")}{line.catalogItemId}
                        </Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">{t("checkout.features.sessions.ui.checkoutPage.product")}</Text>
                        <Text weight="medium">{line.productSummary ?? t("checkout.features.sessions.ui.checkoutPage.standard")}</Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">{t("checkout.features.sessions.ui.checkoutPage.quantity")}</Text>
                        <Badge tone="accent">{line.quantity}</Badge>
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
                        disabled={isSubmitting}
                      >
                        {isSubmitting ? t("checkout.features.sessions.ui.checkoutPage.creating.purchases") : t("checkout.features.sessions.ui.checkoutPage.continue.to.payment.2")}
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
                    disabled={isSubmitting}
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
