import { t } from "@chase-sets/localization";
import {
  Badge,
  Grid,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceEmptyState,
  Page,
  PageHeader,
  PageSection,
  PlatformCredibilityCue,
  Stack,
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

function orderLabel(title: string) {
  return title.toLowerCase().includes("sale") ? "Sale" : "Purchase";
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

      <MarketplaceDashboardPanel
        title={title}
        description={t("ordering.features.orders.ui.orderListPage.review.pending.commercial.commitments.created.by")}
        metrics={[
          { label: title, value: orders.length },
          { label: t("ordering.features.orders.ui.orderListPage.items"), value: totalQuantity },
          { label: t("ordering.features.orders.ui.orderListPage.pending"), value: pendingCount },
        ]}
      />

      <PageSection title={title}>
        <Grid columns={{ base: 1, xl: 2 }} gap={3}>
          {orders.length === 0 ? (
            <MarketplaceEmptyState
              title={emptyTitle}
              description={emptyDescription}
              trustCue={
                <PlatformCredibilityCue
                  title={t("ordering.features.orders.ui.orderListPage.empty.orders.protection.title")}
                  description={t("ordering.features.orders.ui.orderListPage.empty.orders.protection.description")}
                />
              }
              recoveryActions={
                <LinkButton href="/" tone="secondary">
                  {t("ordering.features.orders.ui.orderListPage.browse.marketplace")}
                </LinkButton>
              }
            />
          ) : (
            orders.map((order) => (
              <Surface key={order.order_id} elevated>
                <Stack gap={3}>
                  <Stack gap={1}>
                    <Text weight="semibold">{orderLabel(title)}</Text>
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
