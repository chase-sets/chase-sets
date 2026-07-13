import { formatMoney, t } from "@chase-sets/localization";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  Badge,
  Banner,
  Button,
  CheckoutFlowShell,
  CheckoutMobileSummaryDisclosure,
  Divider,
  Grid,
  HiddenInput,
  LinkButton,
  MarketplaceNotice,
  OrderProtectionModule,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProgressiveDisclosure,
  SecurePaymentIndicator,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { AccountPaymentOrderView, AccountPaymentPageProps } from "./account-payment-contracts";
import { formatPaymentTimestamp, paymentStatusCopy, providerEventLabel, statusTone } from "./account-payment-display";
import { StripeConfirmationCard } from "./stripe-confirmation-card";

function PaymentTimestamp({ value }: { value: string }) {
  return <time dateTime={value}>{formatPaymentTimestamp(value)}</time>;
}

function earliestPaymentDeadline(orders: readonly AccountPaymentOrderView[]) {
  return orders
    .map((order) => order.payment_deadline_at)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

export function AccountPaymentPage({
  payment,
  orders,
  isGuestCheckoutPayment,
  showSupportDetails,
  paymentElementDefaultValues,
  retryActionError,
  feedbackPrompt,
  guestClaimSection,
}: AccountPaymentPageProps) {
  const statusCopy = paymentStatusCopy(payment.status);
  const paymentDeadlineAt = earliestPaymentDeadline(orders);
  const paymentSummary = (
    <Stack gap={4}>
      <PriceBreakdown
        lines={[
          {
            label: t("payments.routes.marketplace.accountPayment.status"),
            value: <Badge tone={statusTone(payment.status)}>{statusCopy.label}</Badge>,
          },
          {
            label: t("payments.routes.marketplace.accountPayment.wallet.balance.used"),
            value: formatMoney(payment.balance_credit_amount, "USD"),
          },
          {
            label: t("payments.routes.marketplace.accountPayment.external.payment"),
            value: formatMoney(payment.processor_amount, "USD"),
          },
          {
            label: t("payments.routes.marketplace.accountPayment.marketplace.sales.fee"),
            value: formatMoney(payment.marketplace_sales_fee_amount, "USD"),
          },
          {
            label: t("payments.routes.marketplace.accountPayment.marketplace.checkout.fee"),
            value: formatMoney(payment.marketplace_checkout_fee_amount, "USD"),
          },
          {
            label: t("payments.routes.marketplace.accountPayment.payment.method"),
            value: payment.payment_method_category ?? "card",
          },
          {
            label: t("payments.routes.marketplace.accountPayment.seller.payout"),
            value: formatMoney(payment.seller_payout_amount, "USD"),
          },
          {
            label: t("payments.routes.marketplace.accountPayment.processor"),
            value: payment.processor_name,
          },
        ]}
        total={formatMoney(payment.amount, "USD")}
        totalLabel={t("payments.routes.marketplace.accountPayment.payment.summary")}
        reassurance={<SecurePaymentIndicator label={t("payments.routes.marketplace.accountPayment.secure.payment")} />}
      />
      <OrderProtectionModule
        title={t("payments.routes.marketplace.accountPayment.checkout.confidence")}
        items={[
          {
            title: t("payments.routes.marketplace.accountPayment.secure.payment.flow"),
            description: t("payments.routes.marketplace.accountPayment.payment.details.stay.inside.the.secure"),
          },
          {
            title: t("payments.routes.marketplace.accountPayment.purchase.coverage"),
            description: t("payments.routes.marketplace.accountPayment.covers.purchases", {
              count: payment.order_ids.length,
              purchaseLabel: t(
                payment.order_ids.length === 1
                  ? "payments.routes.marketplace.accountPayment.purchase.singular"
                  : "payments.routes.marketplace.accountPayment.purchase.plural",
              ),
            }),
          },
          {
            title: t("payments.routes.marketplace.accountPayment.fee.transparency"),
            description: t("payments.routes.marketplace.accountPayment.marketplace.and.processor.fees.stay.visible"),
          },
        ]}
      />
    </Stack>
  );
  const paymentEntry = (
    <PageSection title={t("payments.routes.marketplace.accountPayment.secure.payment.2")}>
      {payment.processor_client_secret && payment.processor_publishable_key ? (
        <StripeConfirmationCard payment={payment} defaultValues={paymentElementDefaultValues} />
      ) : payment.processor_redirect_url ? (
        <Surface elevated glow>
          <Stack gap={3}>
            <Badge tone="accent">{t("payments.routes.marketplace.accountPayment.secure.payment.3")}</Badge>
            <Text>{t("payments.routes.marketplace.accountPayment.payment.is.ready.continue.to.the")}</Text>
            <LinkButton href={payment.processor_redirect_url} size="lg" leadingIcon="lock">
              {t("payments.routes.marketplace.accountPayment.continue.to.secure.checkout")}
            </LinkButton>
          </Stack>
        </Surface>
      ) : (
        <Surface tone="subtle" elevated>
          <Text>{t("payments.routes.marketplace.accountPayment.secure.payment.confirmation.is.not.configured")}</Text>
        </Surface>
      )}
    </PageSection>
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("payments.routes.marketplace.accountPayment.secure.checkout")}
        title={t("payments.routes.marketplace.accountPayment.payment.title", {
          paymentId: payment.payment_id,
        })}
        description={t("payments.routes.marketplace.accountPayment.track.payment.state.purchase.coverage.marketplace")}
        actions={
          isGuestCheckoutPayment ? null : (
            <LinkButton href="/account/purchases" tone="secondary">
              {t("payments.routes.marketplace.accountPayment.back.to.purchases")}
            </LinkButton>
          )
        }
      />

      <CheckoutFlowShell
        summaryLabel={t("payments.routes.marketplace.accountPayment.payment.summary")}
        desktopSummary={paymentSummary}
        mobileSummary={
          <CheckoutMobileSummaryDisclosure
            label={t("payments.routes.marketplace.accountPayment.payment.summary")}
            collapsedSummary={statusCopy.label}
            total={formatMoney(payment.amount, "USD")}
          >
            {paymentSummary}
          </CheckoutMobileSummaryDisclosure>
        }
        main={
          <Stack gap={4}>
            {payment.status === "failed" || payment.status === "cancelled" ? (
              <MarketplaceNotice
                tone="warning"
                title={
                  payment.status === "cancelled"
                    ? t("payments.routes.marketplace.accountPayment.payment.session.closed")
                    : t("payments.routes.marketplace.accountPayment.payment.issue")
                }
                description={
                  payment.failure_message ??
                  t(
                    payment.status === "cancelled"
                      ? "payments.routes.marketplace.accountPayment.this.secure.payment.session.is.no"
                      : "payments.routes.marketplace.accountPayment.the.secure.processor.could.not.complete",
                  )
                }
              />
            ) : null}

            {payment.status === "failed" || payment.status === "cancelled" ? (
              <Surface tone="subtle" elevated>
                <Stack gap={2}>
                  {isGuestCheckoutPayment ? (
                    <Stack gap={2}>
                      {retryActionError ? (
                        <Banner
                          title={t("payments.routes.marketplace.accountPayment.could.not.retry.payment")}
                          description={retryActionError}
                          tone="danger"
                        />
                      ) : null}
                      <RouterForm method="post" spacing="none">
                        <HiddenInput type="hidden" name="intent" value="retry-payment" readOnly />
                        <Button type="submit" leadingIcon="creditCard">
                          {t("payments.routes.marketplace.accountPayment.retry.payment")}
                        </Button>
                      </RouterForm>
                    </Stack>
                  ) : (
                    <LinkButton
                      href={`/account/payments/new?orderIds=${encodeURIComponent(payment.order_ids.join(","))}`}
                    >
                      {t("payments.routes.marketplace.accountPayment.retry.payment")}
                    </LinkButton>
                  )}
                </Stack>
              </Surface>
            ) : null}

            {feedbackPrompt}

            {paymentDeadlineAt && payment.status === "pending-confirmation" ? (
              <MarketplaceNotice
                tone="info"
                title={t("payments.routes.marketplace.accountPayment.payment.deadline.title")}
                description={t("payments.routes.marketplace.accountPayment.payment.deadline.description", {
                  deadline: formatPaymentTimestamp(paymentDeadlineAt),
                })}
              />
            ) : null}

            {payment.status === "pending-confirmation" ? paymentEntry : null}

            <PageSection title={t("payments.routes.marketplace.accountPayment.payment.status")}>
              <Surface elevated>
                <Stack gap={2}>
                  <Badge tone={statusTone(payment.status)}>{statusCopy.label}</Badge>
                  <Text>{statusCopy.description}</Text>
                </Stack>
              </Surface>
            </PageSection>

            {guestClaimSection}

            <PageSection title={t("payments.routes.marketplace.accountPayment.event.timeline")}>
              <Surface elevated>
                <Stack gap={2}>
                  <Stack gap={1}>
                    <Badge tone="success">{t("payments.routes.marketplace.accountPayment.payment.created")}</Badge>
                    <Text size="sm" tone="secondary">
                      <PaymentTimestamp value={payment.created_at} />
                    </Text>
                  </Stack>
                  {payment.provider_events.map((event) => (
                    <Stack key={event.provider_event_id} gap={1}>
                      <Badge tone="accent">{providerEventLabel(event.event_kind)}</Badge>
                      <Text size="sm" tone="secondary">
                        <PaymentTimestamp value={event.received_at} />
                      </Text>
                    </Stack>
                  ))}
                  <Stack gap={1}>
                    <Badge tone={payment.captured_at ? "success" : statusTone(payment.status)}>
                      {payment.captured_at
                        ? t("payments.routes.marketplace.accountPayment.payment.captured")
                        : payment.failed_at
                          ? t("payments.routes.marketplace.accountPayment.payment.failed")
                          : payment.cancelled_at
                            ? t("payments.routes.marketplace.accountPayment.payment.cancelled.2")
                            : t("payments.routes.marketplace.accountPayment.waiting.for.provider.event")}
                    </Badge>
                    <Text size="sm" tone="secondary">
                      {payment.captured_at ? (
                        <PaymentTimestamp value={payment.captured_at} />
                      ) : payment.failed_at ? (
                        <PaymentTimestamp value={payment.failed_at} />
                      ) : payment.cancelled_at ? (
                        <PaymentTimestamp value={payment.cancelled_at} />
                      ) : (
                        payment.processor_status
                      )}
                    </Text>
                  </Stack>
                </Stack>
              </Surface>
            </PageSection>

            {showSupportDetails ? (
              <PageSection title={t("payments.routes.marketplace.accountPayment.support.details")}>
                <ProgressiveDisclosure
                  title={t("payments.routes.marketplace.accountPayment.support.details")}
                  summary={t("payments.routes.marketplace.accountPayment.provider.events.status.summary", {
                    count: payment.provider_events.length,
                    status: payment.processor_status,
                  })}
                  tone={payment.failure_code ? "warning" : "info"}
                  defaultOpen={Boolean(payment.failure_code)}
                >
                  <Surface elevated>
                    <Stack gap={2}>
                      <Text size="sm" tone="secondary">
                        {t("payments.routes.marketplace.accountPayment.internal.payment")}
                        {payment.payment_id}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("payments.routes.marketplace.accountPayment.account")}
                        {payment.buyer_account_id}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("payments.routes.marketplace.accountPayment.processor.reference")}
                        {payment.processor_payment_reference}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("payments.routes.marketplace.accountPayment.processor.status")}
                        {payment.processor_status}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("payments.routes.marketplace.accountPayment.source")}
                        {payment.source_context ?? "direct"} / {payment.source_reference_id ?? "none"}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("payments.routes.marketplace.accountPayment.updated")}
                        <PaymentTimestamp value={payment.updated_at} />
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("payments.routes.marketplace.accountPayment.provider.events")}
                        {payment.provider_events.length}
                      </Text>
                      {payment.provider_events.map((event) => (
                        <Text key={event.provider_event_id} size="sm" tone="secondary">
                          {t("payments.routes.marketplace.accountPayment.provider.event")}
                          {event.provider_event_id}: {providerEventLabel(event.event_kind)}
                        </Text>
                      ))}
                      {payment.failure_code ? (
                        <Text size="sm" tone="secondary">
                          {t("payments.routes.marketplace.accountPayment.failure.code")}
                          {payment.failure_code}
                        </Text>
                      ) : null}
                    </Stack>
                  </Surface>
                </ProgressiveDisclosure>
              </PageSection>
            ) : null}

            {payment.status !== "pending-confirmation" && payment.processor_amount === "0.00" ? (
              <PageSection title={t("payments.routes.marketplace.accountPayment.wallet.balance")}>
                <Surface elevated glow>
                  <Stack gap={2}>
                    <Badge tone="success">{t("payments.routes.marketplace.accountPayment.paid.with.balance")}</Badge>
                    <Text>
                      {t("payments.routes.marketplace.accountPayment.this.purchase.was.covered.by.available")}
                    </Text>
                  </Stack>
                </Surface>
              </PageSection>
            ) : null}

            <PageSection title={t("payments.routes.marketplace.accountPayment.purchases")}>
              <Stack gap={3}>
                {orders.map((order: AccountPaymentOrderView) => (
                  <Surface key={order.order_id} elevated>
                    <Stack gap={3}>
                      <Grid columns={{ base: 1, md: 3 }} gap={3}>
                        <Stack gap={1}>
                          <Text weight="semibold">
                            {t("payments.routes.marketplace.accountPayment.purchase")}
                            {order.order_id}
                          </Text>
                          <Badge tone="accent">{order.status}</Badge>
                        </Stack>
                        <Stack gap={1}>
                          <Text size="sm" tone="secondary">
                            {t("payments.routes.marketplace.accountPayment.total")}
                          </Text>
                          <Text weight="semibold">{formatMoney(order.total_amount, "USD")}</Text>
                        </Stack>
                        <Stack gap={1}>
                          <Text size="sm" tone="secondary">
                            {t("payments.routes.marketplace.accountPayment.seller.payout")}
                          </Text>
                          <Text>{formatMoney(order.seller_payout_amount, "USD")}</Text>
                        </Stack>
                      </Grid>
                      <Divider />
                      {isGuestCheckoutPayment ? null : (
                        <LinkButton href={`/account/purchases/${order.order_id}`} tone="secondary">
                          {t("payments.routes.marketplace.accountPayment.open.purchase")}
                        </LinkButton>
                      )}
                    </Stack>
                  </Surface>
                ))}
              </Stack>
            </PageSection>
          </Stack>
        }
      />
    </Page>
  );
}
