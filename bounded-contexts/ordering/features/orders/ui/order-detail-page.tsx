import { formatDateTime, formatMoney, t } from "@chase-sets/localization";
import {
  Form,
  Badge,
  OrderProtectionModule,
  Button,
  CheckoutLayout,
  Divider,
  Grid,
  LinkButton,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProductOptions,
  SecurePaymentIndicator,
  Stack,
  Surface,
  Text,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { ReactNode } from "react";
import type { PurchaseDetail, SaleDetail } from "./contracts";

function isPendingStatus(status: string) {
  return status === "pending-payment" || status === "pending-reservation";
}

function canSelfServiceCancel(order: PurchaseDetail | SaleDetail) {
  return Boolean(order.self_service_cancellation_available) || isPendingStatus(order.status);
}

function statusTone(status: string) {
  switch (status) {
    case "cancelled":
      return "danger";
    case "ready-for-fulfillment":
      return "success";
    default:
      return "accent";
  }
}

function formatSourceType(sourceType: string) {
  switch (sourceType) {
    case "buy-now":
      return "Buy now";
    case "cart":
      return "Cart checkout";
    case "offer-acceptance":
      return "Accepted offer";
    default:
      return sourceType
        .split("-")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

export function OrderingOrderDetailPage({
  role,
  backHref,
  paymentHref,
  supportHref,
  fulfillmentHref,
  order,
  errorMessage,
  supplementarySection,
  supplementarySectionTitle = t("ordering.features.orders.ui.orderDetailPage.next.steps"),
}: {
  role: "buyer" | "seller";
  backHref: string;
  paymentHref?: string | null;
  supportHref?: string | null;
  fulfillmentHref?: string | null;
  order: PurchaseDetail | SaleDetail;
  errorMessage?: string | null;
  supplementarySection?: ReactNode;
  supplementarySectionTitle?: string;
}) {
  const counterpartLabel =
    role === "buyer"
      ? (order.seller_display_name ?? order.seller_account_id)
      : (order.buyer_display_name ?? order.buyer_account_id);
  const canPay = order.status === "pending-payment" && paymentHref;
  const canCancel = role === "buyer" ? canSelfServiceCancel(order) : isPendingStatus(order.status);
  const projectionLabel =
    role === "buyer"
      ? t("ordering.features.orders.ui.orderDetailPage.purchase")
      : t("ordering.features.orders.ui.orderDetailPage.sale");
  const cancelIntent = role === "buyer" ? "cancel-purchase" : "cancel-sale";
  const sourceReference = order.source_reference_id?.trim() || order.order_id;
  const canViewFulfillment =
    Boolean(fulfillmentHref) && order.status !== "pending-payment" && order.status !== "pending-reservation";
  const paymentDeadlineAt = order.status === "pending-payment" ? order.payment_deadline_at : null;
  const supportLabel =
    role === "buyer" && order.cancellation_unavailable_reason === "fulfillment-started"
      ? t("ordering.features.orders.ui.orderDetailPage.ask.to.cancel")
      : t("ordering.features.orders.ui.orderDetailPage.open.support");
  const statusLine = {
    label: t("ordering.features.orders.ui.orderDetailPage.status"),
    value: <Badge tone={statusTone(order.status)}>{order.status}</Badge>,
  };
  const itemSubtotalLine = {
    label: t("ordering.features.orders.ui.orderDetailPage.item.subtotal"),
    value: formatMoney(order.item_subtotal_amount, "USD"),
  };
  // Role-scoped money lines: buyers see what they paid (subtotal/shipping/tax/total).
  // Sellers see their own economics (fee/net/payout). Neither role ever sees the
  // other side's numbers rendered from this list.
  const priceBreakdownLines =
    role === "buyer"
      ? [
          statusLine,
          itemSubtotalLine,
          {
            label: t("ordering.features.orders.ui.orderDetailPage.shipping"),
            value: formatMoney(order.shipping_charge_amount, "USD"),
          },
          {
            label: t("ordering.features.orders.ui.orderDetailPage.tax"),
            value: formatMoney(order.sales_tax_amount, "USD"),
          },
        ]
      : [
          statusLine,
          itemSubtotalLine,
          {
            label: t("ordering.features.orders.ui.orderDetailPage.shipping.allowance"),
            value: formatMoney(order.shipping_allowance_amount, "USD"),
          },
          {
            label: t("ordering.features.orders.ui.orderDetailPage.shipping.overage"),
            value: formatMoney(order.shipping_overage_amount, "USD"),
          },
          {
            label: t("ordering.features.orders.ui.orderDetailPage.marketplace.fee"),
            value: formatMoney(order.marketplace_sales_fee_amount, "USD"),
          },
          {
            label: t("ordering.features.orders.ui.orderDetailPage.seller.item.net"),
            value: formatMoney(order.seller_item_net_amount, "USD"),
          },
          {
            label: t("ordering.features.orders.ui.orderDetailPage.seller.payout"),
            value: formatMoney(order.seller_payout_amount, "USD"),
          },
        ];

  return (
    <Page>
      <PageHeader
        eyebrow={
          role === "buyer"
            ? t("ordering.features.orders.ui.orderDetailPage.buyer")
            : t("ordering.features.orders.ui.orderDetailPage.seller")
        }
        title={t("ordering.features.orders.ui.orderDetailPage.order.title", {
          projectionLabel,
          orderReference: order.display_reference,
        })}
        description={t("ordering.features.orders.ui.orderDetailPage.counterparty.description", {
          counterparty: counterpartLabel,
        })}
        actions={
          <LinkButton href={backHref} tone="secondary">
            {t("ordering.features.orders.ui.orderDetailPage.back")}
          </LinkButton>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("ordering.features.orders.ui.orderDetailPage.projection.issue", {
            projectionLabel,
          })}
          description={errorMessage}
        />
      ) : null}

      <CheckoutLayout
        summaryLabel="Order summary"
        summary={
          <Stack gap={4}>
            <PriceBreakdown
              lines={priceBreakdownLines}
              total={formatMoney(order.total_amount, "USD")}
              totalLabel={t("ordering.features.orders.ui.orderDetailPage.summary.title", {
                projectionLabel,
              })}
              reassurance={
                <SecurePaymentIndicator label={t("ordering.features.orders.ui.orderDetailPage.secure.payment")} />
              }
            />
            <OrderProtectionModule
              title={
                role === "buyer"
                  ? t("ordering.features.orders.ui.orderDetailPage.buyer.protection")
                  : t("ordering.features.orders.ui.orderDetailPage.seller.protection")
              }
              items={[
                {
                  title: t("ordering.features.orders.ui.orderDetailPage.resolved.terms"),
                  description: order.terms_schedule_id
                    ? "Seller terms were locked when this order was created."
                    : t("ordering.features.orders.ui.orderDetailPage.no.schedule.snapshot"),
                },
                {
                  title: t("ordering.features.orders.ui.orderDetailPage.shipping.preference"),
                  description: order.shipping_option,
                },
                {
                  title: t("ordering.features.orders.ui.orderDetailPage.payment.state"),
                  description: paymentDeadlineAt
                    ? t("ordering.features.orders.ui.orderDetailPage.payment.deadline.description", {
                        deadline: formatDateTime(paymentDeadlineAt),
                      })
                    : order.status,
                },
              ]}
            />
          </Stack>
        }
      >
        <Stack gap={4}>
          <Surface elevated glow>
            <Stack gap={4}>
              <Grid columns={{ base: 1, md: 4 }} gap={3}>
                <Stack gap={1}>
                  <Text size="sm" tone="secondary">
                    {t("ordering.features.orders.ui.orderDetailPage.source")}
                  </Text>
                  <Text weight="semibold">{formatSourceType(order.source_type)}</Text>
                </Stack>
                <Stack gap={1}>
                  <Text size="sm" tone="secondary">
                    {t("ordering.features.orders.ui.orderDetailPage.support.reference")}
                  </Text>
                  <Text weight="semibold" wrap="anywhere">
                    {sourceReference}
                  </Text>
                </Stack>
                <Stack gap={1}>
                  <Text size="sm" tone="secondary">
                    {t("ordering.features.orders.ui.orderDetailPage.counterparty")}
                  </Text>
                  <Text weight="semibold">{counterpartLabel}</Text>
                </Stack>
                <Stack gap={1}>
                  <Text size="sm" tone="secondary">
                    {t("ordering.features.orders.ui.orderDetailPage.terms.resolved")}
                  </Text>
                  <Text>{formatDateTime(order.terms_resolved_at)}</Text>
                </Stack>
              </Grid>
              <Divider />
              {paymentDeadlineAt ? (
                <MarketplaceNotice
                  tone="info"
                  title={t("ordering.features.orders.ui.orderDetailPage.payment.deadline.title")}
                  description={t("ordering.features.orders.ui.orderDetailPage.payment.deadline.description", {
                    deadline: formatDateTime(paymentDeadlineAt),
                  })}
                />
              ) : null}
              <Stack gap={3} direction={{ base: "column", sm: "row" }}>
                {canPay ? (
                  <LinkButton href={paymentHref}>{t("ordering.features.orders.ui.orderDetailPage.pay.now")}</LinkButton>
                ) : null}
                {supportHref ? (
                  <LinkButton href={supportHref} tone="secondary">
                    {supportLabel}
                  </LinkButton>
                ) : null}
                {canViewFulfillment ? (
                  <LinkButton href={fulfillmentHref!} tone="secondary">
                    {t("ordering.features.orders.ui.orderDetailPage.view.fulfillment")}
                  </LinkButton>
                ) : null}
                {canCancel ? (
                  <Form spacing="none" method="post">
                    <Button type="submit" name="intent" value={cancelIntent} tone="danger">
                      {t("ordering.features.orders.ui.orderDetailPage.cancel.projection", {
                        projectionLabel: projectionLabel.toLowerCase(),
                      })}
                    </Button>
                  </Form>
                ) : null}
              </Stack>
            </Stack>
          </Surface>

          {supplementarySection ? (
            <PageSection title={supplementarySectionTitle}>{supplementarySection}</PageSection>
          ) : null}

          <PageSection title={t("ordering.features.orders.ui.orderDetailPage.lines")}>
            <Stack gap={3}>
              {order.lines.map((line) => (
                <Surface key={line.line_id} elevated>
                  <Grid columns={{ base: 1, md: 3 }} gap={3}>
                    <Stack gap={1}>
                      <Text weight="semibold">{line.item_title}</Text>
                      {line.item_subtitle ? (
                        <Text tone="secondary" size="sm">
                          {line.item_subtitle}
                        </Text>
                      ) : null}
                      <ProductOptions
                        options={productOptionsFromSummary(
                          line.product_summary ?? t("ordering.features.orders.ui.orderDetailPage.standard"),
                        )}
                        variant="chips"
                      />
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">
                        {t("ordering.features.orders.ui.orderDetailPage.quantity")}
                      </Text>
                      <Text weight="semibold">{line.quantity}</Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">
                        {t("ordering.features.orders.ui.orderDetailPage.line.total")}
                      </Text>
                      <Text weight="semibold">
                        {line.quantity} x {formatMoney(line.unit_price_amount, "USD")} ={" "}
                        {formatMoney(line.line_total_amount, "USD")}
                      </Text>
                    </Stack>
                  </Grid>
                </Surface>
              ))}
            </Stack>
          </PageSection>

          {role === "seller" ? (
            <PageSection title={t("ordering.features.orders.ui.orderDetailPage.inventory.holds")}>
              <Stack gap={3}>
                {order.inventory_holds.map((hold) => (
                  <Surface key={hold.hold_id} elevated>
                    <Grid columns={{ base: 1, md: 3 }} gap={3}>
                      <Stack gap={1}>
                        <Text weight="semibold">{t("ordering.features.orders.ui.orderDetailPage.reserved.item")}</Text>
                        <Text size="sm" tone="secondary">
                          {t("ordering.features.orders.ui.orderDetailPage.inventory.is.reserved")}
                        </Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">
                          {t("ordering.features.orders.ui.orderDetailPage.quantity.2")}
                        </Text>
                        <Text>{hold.quantity}</Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">
                          {t("ordering.features.orders.ui.orderDetailPage.status.2")}
                        </Text>
                        <Badge tone="accent">{hold.status}</Badge>
                      </Stack>
                    </Grid>
                  </Surface>
                ))}
              </Stack>
            </PageSection>
          ) : null}
        </Stack>
      </CheckoutLayout>
    </Page>
  );
}
