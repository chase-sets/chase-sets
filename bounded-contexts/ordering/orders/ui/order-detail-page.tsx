import {
  Badge,
  Button,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { OrderingOrderDetail } from "./contracts";

function formatMoney(amount: string) {
  return `$${amount}`;
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
}: {
  role: "buyer" | "seller";
  backHref: string;
  paymentHref?: string | null;
  order: OrderingOrderDetail;
  errorMessage?: string | null;
}) {
  const counterpartLabel =
    role === "buyer"
      ? order.seller_display_name ?? order.seller_account_id
      : order.buyer_display_name ?? order.buyer_account_id;

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
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Summary">
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(order.status)}>{order.status}</Badge>
            <Text>Source: {order.source_type}</Text>
            <Text>Shipping: {order.shipping_option}</Text>
            <Text>Item subtotal: {formatMoney(order.item_subtotal_amount)}</Text>
            <Text>Shipping charge: {formatMoney(order.shipping_charge_amount)}</Text>
            <Text>Total: {formatMoney(order.total_amount)}</Text>
            {order.status === "pending-payment" && paymentHref ? (
              <LinkButton href={paymentHref}>Pay now</LinkButton>
            ) : null}
            {order.status === "pending-payment" ? (
              <form method="post">
                <Button type="submit" name="intent" value="cancel-order" tone="danger">
                  Cancel order
                </Button>
              </form>
            ) : null}
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Lines">
        <Stack gap={3}>
          {order.lines.map((line) => (
            <Card key={line.line_id}>
              <Stack gap={1}>
                <Text weight="semibold">{line.item_title}</Text>
                {line.item_subtitle ? (
                  <Text tone="secondary" size="sm">
                    {line.item_subtitle}
                  </Text>
                ) : null}
                <Text size="sm" tone="secondary">
                  {line.version_summary ?? "Standard"}
                </Text>
                <Text>
                  {line.quantity} x {formatMoney(line.unit_price_amount)} ={" "}
                  {formatMoney(line.line_total_amount)}
                </Text>
              </Stack>
            </Card>
          ))}
        </Stack>
      </PageSection>

      <PageSection title="Inventory Holds">
        <Stack gap={3}>
          {order.inventory_holds.map((hold) => (
            <Card key={hold.hold_id}>
              <Stack gap={1}>
                <Text weight="semibold">{hold.hold_id}</Text>
                <Text size="sm" tone="secondary">
                  Record {hold.inventory_record_id}
                </Text>
                <Text>Quantity: {hold.quantity}</Text>
                <Text>Status: {hold.status}</Text>
              </Stack>
            </Card>
          ))}
        </Stack>
      </PageSection>
    </Page>
  );
}
