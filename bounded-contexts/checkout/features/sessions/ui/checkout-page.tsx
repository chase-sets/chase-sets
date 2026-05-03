import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  CheckoutLayout,
  CheckoutTrustPanel,
  Divider,
  EmptyState,
  Grid,
  LinkButton,
  NativeSelect,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  Stack,
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
      <OrderSummary
        title={t("checkout.features.sessions.ui.checkoutPage.checkout.summary")}
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
      />
      <CheckoutTrustPanel
        items={[
          {
            icon: "shield",
            title: t("checkout.features.sessions.ui.checkoutPage.buyer.protection"),
            description: t("checkout.features.sessions.ui.checkoutPage.eligible.orders.are.protected.through.payment"),
          },
          {
            icon: "lock",
            title: t("checkout.features.sessions.ui.checkoutPage.secure.payment"),
            description: t("checkout.features.sessions.ui.checkoutPage.payment.starts.only.after.orders.are"),
          },
          {
            icon: "truck",
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
        <EmptyState
          title={t("checkout.features.sessions.ui.checkoutPage.your.cart.is.empty")}
          description={t("checkout.features.sessions.ui.checkoutPage.add.a.product.before.starting.checkout")}
          icon="cart"
          actions={<LinkButton href="/search">{t("checkout.features.sessions.ui.checkoutPage.browse.marketplace")}</LinkButton>}
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
                  <form method="post">
                    <Stack gap={3}>
                      <input type="hidden" name="intent" value="confirm-checkout" />
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
          </Stack>
        </CheckoutLayout>
      )}
    </Page>
  );
}
