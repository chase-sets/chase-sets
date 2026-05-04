import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  CheckoutLayout,
  CheckoutTrustPanel,
  Divider,
  Grid,
  LinkButton,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { ReactNode } from "react";
import type { PurchaseDetail, SaleDetail } from "./contracts";

function formatMoney(amount: string) {
  return `$${amount}`;
}

function isPendingStatus(status: string) {
  return status === "pending-payment" || status === "pending-reservation";
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

export function OrderingOrderDetailPage({
  role,
  backHref,
  paymentHref,
  order,
  errorMessage,
  supplementarySection,
  supplementarySectionTitle = t("ordering.features.orders.ui.orderDetailPage.next.steps"),
}: {
  role: "buyer" | "seller";
  backHref: string;
  paymentHref?: string | null;
  order: PurchaseDetail | SaleDetail;
  errorMessage?: string | null;
  supplementarySection?: ReactNode;
  supplementarySectionTitle?: string;
}) {
  const counterpartLabel =
    role === "buyer"
      ? order.seller_display_name ?? order.seller_account_id
      : order.buyer_display_name ?? order.buyer_account_id;
  const canPay = order.status === "pending-payment" && paymentHref;
  const projectionLabel = role === "buyer" ? t("ordering.features.orders.ui.orderDetailPage.purchase") : t("ordering.features.orders.ui.orderDetailPage.sale");
  const cancelIntent = role === "buyer" ? "cancel-purchase" : "cancel-sale";

  return (
    <Page>
      <PageHeader
        eyebrow={role === "buyer" ? t("ordering.features.orders.ui.orderDetailPage.buyer") : t("ordering.features.orders.ui.orderDetailPage.seller")}
        title={t("ordering.features.orders.ui.orderDetailPage.order.title", {
          projectionLabel,
          orderId: order.order_id,
        })}
        description={t("ordering.features.orders.ui.orderDetailPage.counterparty.description", {
          counterparty: counterpartLabel,
        })}
        actions={
          <LinkButton href={backHref} tone="secondary">
            {t("ordering.features.orders.ui.orderDetailPage.back")}</LinkButton>
        }
      />

      {errorMessage ? (
        <Surface tone="subtle" elevated>
          <Stack gap={2}>
            <Badge tone="danger">
              {t("ordering.features.orders.ui.orderDetailPage.projection.issue", {
                projectionLabel,
              })}
            </Badge>
            <Text>{errorMessage}</Text>
          </Stack>
        </Surface>
      ) : null}

      <CheckoutLayout
        summary={
          <Stack gap={4}>
            <OrderSummary
              title={t("ordering.features.orders.ui.orderDetailPage.summary.title", {
                projectionLabel,
              })}
              lines={[
                { label: t("ordering.features.orders.ui.orderDetailPage.status"), value: <Badge tone={statusTone(order.status)}>{order.status}</Badge> },
                { label: t("ordering.features.orders.ui.orderDetailPage.item.subtotal"), value: formatMoney(order.item_subtotal_amount) },
                { label: t("ordering.features.orders.ui.orderDetailPage.shipping.allowance"), value: formatMoney(order.shipping_allowance_amount) },
                { label: t("ordering.features.orders.ui.orderDetailPage.shipping.overage"), value: formatMoney(order.shipping_overage_amount) },
                { label: t("ordering.features.orders.ui.orderDetailPage.marketplace.fee"), value: formatMoney(order.marketplace_sales_fee_amount) },
                { label: t("ordering.features.orders.ui.orderDetailPage.seller.item.net"), value: formatMoney(order.seller_item_net_amount) },
                { label: t("ordering.features.orders.ui.orderDetailPage.seller.payout"), value: formatMoney(order.seller_payout_amount) },
              ]}
              total={formatMoney(order.total_amount)}
            />
            <CheckoutTrustPanel
              title={role === "buyer" ? t("ordering.features.orders.ui.orderDetailPage.buyer.protection") : t("ordering.features.orders.ui.orderDetailPage.seller.protection")}
              items={[
                {
                  icon: "shield",
                  title: t("ordering.features.orders.ui.orderDetailPage.resolved.terms"),
                  description: order.terms_schedule_id ?? t("ordering.features.orders.ui.orderDetailPage.no.schedule.snapshot"),
                },
                {
                  icon: "truck",
                  title: t("ordering.features.orders.ui.orderDetailPage.shipping.preference"),
                  description: order.shipping_option,
                },
                {
                  icon: "lock",
                  title: t("ordering.features.orders.ui.orderDetailPage.payment.state"),
                  description: order.status,
                },
              ]}
            />
          </Stack>
        }
      >
        <Stack gap={4}>
          <Surface elevated glow>
            <Stack gap={4}>
              <Grid columns={{ base: 1, md: 3 }} gap={3}>
                <Stack gap={1}>
                  <Text size="sm" tone="secondary">{t("ordering.features.orders.ui.orderDetailPage.source")}</Text>
                  <Text weight="semibold">{order.source_type}</Text>
                </Stack>
                <Stack gap={1}>
                  <Text size="sm" tone="secondary">{t("ordering.features.orders.ui.orderDetailPage.counterparty")}</Text>
                  <Text weight="semibold">{counterpartLabel}</Text>
                </Stack>
                <Stack gap={1}>
                  <Text size="sm" tone="secondary">{t("ordering.features.orders.ui.orderDetailPage.terms.resolved")}</Text>
                  <Text>{new Date(order.terms_resolved_at).toLocaleString()}</Text>
                </Stack>
              </Grid>
              <Divider />
              <Stack gap={3} direction={{ base: "column", sm: "row" }}>
                {canPay ? <LinkButton href={paymentHref}>{t("ordering.features.orders.ui.orderDetailPage.pay.now")}</LinkButton> : null}
                {isPendingStatus(order.status) ? (
                  <form method="post">
                    <Button type="submit" name="intent" value={cancelIntent} tone="danger">
                      {t("ordering.features.orders.ui.orderDetailPage.cancel.projection", {
                        projectionLabel: projectionLabel.toLowerCase(),
                      })}
                    </Button>
                  </form>
                ) : null}
              </Stack>
            </Stack>
          </Surface>

          {supplementarySection ? (
            <PageSection title={supplementarySectionTitle}>
              {supplementarySection}
            </PageSection>
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
                      <Text size="sm" tone="secondary">
                        {line.product_summary ?? t("ordering.features.orders.ui.orderDetailPage.standard")}
                      </Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">{t("ordering.features.orders.ui.orderDetailPage.quantity")}</Text>
                      <Text weight="semibold">{line.quantity}</Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">{t("ordering.features.orders.ui.orderDetailPage.line.total")}</Text>
                      <Text weight="semibold">
                        {line.quantity} x {formatMoney(line.unit_price_amount)} ={" "}
                        {formatMoney(line.line_total_amount)}
                      </Text>
                    </Stack>
                  </Grid>
                </Surface>
              ))}
            </Stack>
          </PageSection>

          <PageSection title={t("ordering.features.orders.ui.orderDetailPage.inventory.holds")}>
            <Stack gap={3}>
              {order.inventory_holds.map((hold) => (
                <Surface key={hold.hold_id} elevated>
                  <Grid columns={{ base: 1, md: 3 }} gap={3}>
                    <Stack gap={1}>
                      <Text weight="semibold">{hold.hold_id}</Text>
                      <Text size="sm" tone="secondary">
                        {t("ordering.features.orders.ui.orderDetailPage.inventory.item")}{hold.inventory_item_id}
                      </Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">{t("ordering.features.orders.ui.orderDetailPage.quantity.2")}</Text>
                      <Text>{hold.quantity}</Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">{t("ordering.features.orders.ui.orderDetailPage.status.2")}</Text>
                      <Badge tone="accent">{hold.status}</Badge>
                    </Stack>
                  </Grid>
                </Surface>
              ))}
            </Stack>
          </PageSection>
        </Stack>
      </CheckoutLayout>
    </Page>
  );
}
