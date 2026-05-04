import { t } from "@chase-sets/localization";
import {
  Badge,
  EmptyState,
  Grid,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { PurchaseListItem, SaleListItem } from "./contracts";

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
  orders: readonly (PurchaseListItem | SaleListItem)[];
}) {
  const totalQuantity = orders.reduce((sum, order) => sum + order.total_quantity, 0);
  const pendingCount = orders.filter((order) => order.status.includes("pending")).length;

  return (
    <Page>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={t("ordering.features.orders.ui.orderListPage.review.pending.commercial.commitments.created.by")}
      />

      <StatGrid columns={{ base: 1, md: 3 }}>
        <Stat label={title} value={orders.length} />
        <Stat label={t("ordering.features.orders.ui.orderListPage.items")} value={totalQuantity} />
        <Stat label={t("ordering.features.orders.ui.orderListPage.pending")} value={pendingCount} />
      </StatGrid>

      <PageSection title={title}>
        <Grid columns={{ base: 1, xl: 2 }} gap={3}>
          {orders.length === 0 ? (
            <EmptyState
              title={emptyTitle}
              description={emptyDescription}
              icon="cart"
            />
          ) : (
            orders.map((order) => (
              <Surface key={order.order_id} elevated>
                <Stack gap={3}>
                  <Stack gap={1}>
                    <Text weight="semibold">{t("ordering.features.orders.ui.orderListPage.order")}{order.order_id}</Text>
                    <Badge tone={statusTone(order.status)}>{order.status}</Badge>
                  </Stack>
                  <Grid columns={{ base: 1, sm: 3 }} gap={3}>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">{t("ordering.features.orders.ui.orderListPage.quantity")}</Text>
                      <Text weight="semibold">{order.total_quantity}</Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">{t("ordering.features.orders.ui.orderListPage.total")}</Text>
                      <Text weight="semibold">{formatMoney(order.total_amount)}</Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">{t("ordering.features.orders.ui.orderListPage.seller.payout")}</Text>
                      <Text>{formatMoney(order.seller_payout_amount)}</Text>
                    </Stack>
                  </Grid>
                  <LinkButton href={`${orderDetailBasePath}/${order.order_id}`} tone="secondary">
                    {t("ordering.features.orders.ui.orderListPage.open.order")}</LinkButton>
                </Stack>
              </Surface>
            ))
          )}
        </Grid>
      </PageSection>
    </Page>
  );
}
