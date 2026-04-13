import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { OrderingOrderListItem } from "./contracts";

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

export function OrderingOrderListPage({
  title,
  eyebrow,
  emptyTitle,
  emptyDescription,
  orderDetailBasePath,
  orders,
}: {
  title: string;
  eyebrow: string;
  emptyTitle: string;
  emptyDescription: string;
  orderDetailBasePath: string;
  orders: readonly OrderingOrderListItem[];
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description="Review pending commercial commitments created by checkout or accepted offers."
      />

      <PageSection title="Orders">
        <Stack gap={3}>
          {orders.length === 0 ? (
            <EmptyState
              title={emptyTitle}
              description={emptyDescription}
              icon="cart"
            />
          ) : (
            orders.map((order) => (
              <Card key={order.order_id}>
                <Stack gap={2}>
                  <Stack gap={1}>
                    <Text weight="semibold">Order {order.order_id}</Text>
                    <Badge tone={statusTone(order.status)}>{order.status}</Badge>
                  </Stack>
                  <Text size="sm" tone="secondary">
                    Quantity: {order.total_quantity} across {order.line_count} line
                    {order.line_count === 1 ? "" : "s"}
                  </Text>
                  <Text>Total: {formatMoney(order.total_amount)}</Text>
                  <LinkButton href={`${orderDetailBasePath}/${order.order_id}`} tone="secondary">
                    Open order
                  </LinkButton>
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
