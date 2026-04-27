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
import type { OrderingOrderDetail } from "./contracts";

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
  supplementarySectionTitle = "Next steps",
}: {
  role: "buyer" | "seller";
  backHref: string;
  paymentHref?: string | null;
  order: OrderingOrderDetail;
  errorMessage?: string | null;
  supplementarySection?: ReactNode;
  supplementarySectionTitle?: string;
}) {
  const counterpartLabel =
    role === "buyer"
      ? order.seller_display_name ?? order.seller_account_id
      : order.buyer_display_name ?? order.buyer_account_id;
  const canPay = order.status === "pending-payment" && paymentHref;

  return (
    <Page>
      <PageHeader
        eyebrow={role === "buyer" ? "Buyer" : "Seller"}
        title={`Order ${order.order_id}`}
        description={`Counterparty: ${counterpartLabel}`}
        actions={
          <LinkButton href={backHref} tone="secondary">
            Back
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Surface tone="subtle" elevated>
          <Stack gap={2}>
            <Badge tone="danger">Order issue</Badge>
            <Text>{errorMessage}</Text>
          </Stack>
        </Surface>
      ) : null}

      <CheckoutLayout
        summary={
          <Stack gap={4}>
            <OrderSummary
              title="Order Summary"
              lines={[
                { label: "Status", value: <Badge tone={statusTone(order.status)}>{order.status}</Badge> },
                { label: "Item subtotal", value: formatMoney(order.item_subtotal_amount) },
                { label: "Shipping", value: formatMoney(order.shipping_charge_amount) },
                { label: "Marketplace fee", value: formatMoney(order.marketplace_fee_amount) },
                { label: "Payment fee", value: formatMoney(order.payment_fee_amount) },
                { label: "Seller net", value: formatMoney(order.seller_net_amount) },
              ]}
              total={formatMoney(order.total_amount)}
            />
            <CheckoutTrustPanel
              title={role === "buyer" ? "Buyer Protection" : "Seller Protection"}
              items={[
                {
                  icon: "shield",
                  title: "Resolved Terms",
                  description: order.terms_schedule_id ?? "No schedule snapshot",
                },
                {
                  icon: "truck",
                  title: "Shipping Preference",
                  description: order.shipping_option,
                },
                {
                  icon: "lock",
                  title: "Payment State",
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
                  <Text size="sm" tone="secondary">Source</Text>
                  <Text weight="semibold">{order.source_type}</Text>
                </Stack>
                <Stack gap={1}>
                  <Text size="sm" tone="secondary">Counterparty</Text>
                  <Text weight="semibold">{counterpartLabel}</Text>
                </Stack>
                <Stack gap={1}>
                  <Text size="sm" tone="secondary">Terms resolved</Text>
                  <Text>{new Date(order.terms_resolved_at).toLocaleString()}</Text>
                </Stack>
              </Grid>
              <Divider />
              <Stack gap={3} direction={{ base: "column", sm: "row" }}>
                {canPay ? <LinkButton href={paymentHref}>Pay now</LinkButton> : null}
                {isPendingStatus(order.status) ? (
                  <form method="post">
                    <Button type="submit" name="intent" value="cancel-order" tone="danger">
                      Cancel order
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

          <PageSection title="Lines">
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
                        {line.product_summary ?? "Standard"}
                      </Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">Quantity</Text>
                      <Text weight="semibold">{line.quantity}</Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">Line total</Text>
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

          <PageSection title="Inventory Holds">
            <Stack gap={3}>
              {order.inventory_holds.map((hold) => (
                <Surface key={hold.hold_id} elevated>
                  <Grid columns={{ base: 1, md: 3 }} gap={3}>
                    <Stack gap={1}>
                      <Text weight="semibold">{hold.hold_id}</Text>
                      <Text size="sm" tone="secondary">
                        Record {hold.inventory_record_id}
                      </Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">Quantity</Text>
                      <Text>{hold.quantity}</Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">Status</Text>
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
