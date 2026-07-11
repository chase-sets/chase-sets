import { formatMoney, t } from "@chase-sets/localization";
import {
  Badge,
  Grid,
  Icon,
  Image,
  Inline,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceEmptyState,
  Page,
  PageHeader,
  PageSection,
  Pagination,
  PlatformCredibilityCue,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { OrderListSummary, PurchaseListItem, SaleListItem } from "./contracts";

export type OrderListKind = "purchase" | "sale";

function formatOrderDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function navigateToOrderListPage(page: number, pageSize: number) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", String((page - 1) * pageSize));
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
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

function orderKindLabel(kind: OrderListKind) {
  return kind === "sale"
    ? t("ordering.features.orders.ui.orderListPage.kind.sale")
    : t("ordering.features.orders.ui.orderListPage.kind.purchase");
}

function orderCardHeadline(itemTitles: readonly string[]) {
  const [primary, ...rest] = itemTitles;
  if (!primary) {
    return t("ordering.features.orders.ui.orderListPage.untitled.order");
  }

  return rest.length > 0
    ? [primary, t("ordering.features.orders.ui.orderListPage.more.items", { count: rest.length })]
        .filter(Boolean)
        .join(" ")
    : primary;
}

export function OrderingOrderListPage({
  title,
  eyebrow,
  emptyTitle,
  emptyDescription,
  orderDetailBasePath,
  kind,
  orders,
  total,
  summary,
  pagination,
}: {
  title: string;
  eyebrow: string;
  emptyTitle: string;
  emptyDescription: string;
  orderDetailBasePath: string;
  kind: OrderListKind;
  orders: readonly (PurchaseListItem | SaleListItem)[];
  total?: number;
  summary?: OrderListSummary;
  pagination?: Readonly<{ limit: number; offset: number; total: number }>;
}) {
  const totalCount = total ?? orders.length;
  const totalQuantity = summary ? summary.total_quantity : orders.reduce((sum, order) => sum + order.total_quantity, 0);
  const pendingCount = summary
    ? summary.pending_count
    : orders.filter((order) => order.status.includes("pending")).length;
  const pageSize = pagination?.limit ?? orders.length;
  const currentPage = pagination && pageSize > 0 ? Math.floor(pagination.offset / pageSize) + 1 : 1;
  const totalPages = pagination && pageSize > 0 ? Math.max(1, Math.ceil(pagination.total / pageSize)) : 1;
  const showPagination = Boolean(pagination && (pagination.total > pageSize || pagination.offset > 0));

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
          { label: title, value: totalCount },
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
            orders.map((order) => {
              const caption = [orderKindLabel(kind), formatOrderDate(order.created_at), order.display_reference]
                .filter(Boolean)
                .join(" · ");

              return (
                <Surface key={order.order_id} elevated>
                  <Stack gap={3}>
                    <Inline gap={3} align="center">
                      <Image
                        src=""
                        alt={orderCardHeadline(order.item_titles)}
                        fallback={<Icon name="cards" size="md" tone="tertiary" />}
                        width={48}
                        rounded
                      />
                      <Stack gap={1}>
                        <Text weight="semibold">{orderCardHeadline(order.item_titles)}</Text>
                        <Text size="sm" tone="secondary">
                          {caption}
                        </Text>
                        <Badge tone={statusTone(order.status)}>{order.status}</Badge>
                      </Stack>
                    </Inline>
                    <Grid columns={{ base: 1, sm: kind === "sale" ? 3 : 2 }} gap={3}>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">
                          {t("ordering.features.orders.ui.orderListPage.quantity")}
                        </Text>
                        <Text weight="semibold">{order.total_quantity}</Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">
                          {t("ordering.features.orders.ui.orderListPage.total")}
                        </Text>
                        <Text weight="semibold">{formatMoney(order.total_amount, "USD")}</Text>
                      </Stack>
                      {kind === "sale" ? (
                        <Stack gap={1}>
                          <Text size="sm" tone="secondary">
                            {t("ordering.features.orders.ui.orderListPage.seller.payout")}
                          </Text>
                          <Text>{formatMoney(order.seller_payout_amount, "USD")}</Text>
                        </Stack>
                      ) : null}
                    </Grid>
                    <LinkButton href={`${orderDetailBasePath}/${order.order_id}`} tone="secondary">
                      {t("ordering.features.orders.ui.orderListPage.open.order")}
                    </LinkButton>
                  </Stack>
                </Surface>
              );
            })
          )}
        </Grid>
        {showPagination ? (
          <Pagination
            page={currentPage}
            totalPages={totalPages}
            onPageChange={(page) => navigateToOrderListPage(page, pageSize)}
          />
        ) : null}
      </PageSection>
    </Page>
  );
}
