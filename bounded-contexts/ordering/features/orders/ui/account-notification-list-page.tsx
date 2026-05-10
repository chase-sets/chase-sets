import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Grid,
  Inline,
  LinkButton,
  MarketplaceEmptyState,
  Page,
  PageHeader,
  PageSection,
  PlatformCredibilityCue,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";

export type AccountNotificationSource = "orders" | "shipments";

export type AccountNotificationListItem = Readonly<{
  source: AccountNotificationSource;
  deliveryId: string;
  title: string;
  body: string;
  actionHref: string | null;
  criticality: string;
  readAt: string | null;
  createdAt: string;
}>;

export function AccountNotificationListPage({
  notifications,
  unreadCount,
}: {
  notifications: readonly AccountNotificationListItem[];
  unreadCount: number;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("ordering.features.orders.ui.accountNotificationListPage.account")}
        title={t("ordering.features.orders.ui.accountNotificationListPage.notifications")}
        description={t("ordering.features.orders.ui.accountNotificationListPage.notifications.description")}
        actions={
          unreadCount > 0 ? (
            <form method="post">
              <input type="hidden" name="intent" value="read-all" />
              <Button type="submit" tone="secondary" size="sm">
                {t("ordering.features.orders.ui.accountNotificationListPage.mark.all.read")}
              </Button>
            </form>
          ) : null
        }
      />

      <PageSection
        title={t("ordering.features.orders.ui.accountNotificationListPage.activity")}
        description={t("ordering.features.orders.ui.accountNotificationListPage.activity.description", {
          count: unreadCount,
        })}
      >
        {notifications.length === 0 ? (
          <MarketplaceEmptyState
            title={t("ordering.features.orders.ui.accountNotificationListPage.no.notifications")}
            description={t("ordering.features.orders.ui.accountNotificationListPage.no.notifications.description")}
            trustCue={
              <PlatformCredibilityCue
                title={t("ordering.features.orders.ui.accountNotificationListPage.feed.ready")}
                description={t("ordering.features.orders.ui.accountNotificationListPage.feed.ready.description")}
              />
            }
          />
        ) : (
          <Grid columns={{ base: 1, xl: 2 }} gap={3}>
            {notifications.map((notification) => (
              <Surface key={`${notification.source}:${notification.deliveryId}`} elevated>
                <Stack gap={3}>
                  <Stack gap={1}>
                    <Text weight="semibold">{notification.title}</Text>
                    <Text tone="secondary">{notification.body}</Text>
                  </Stack>
                  <Grid columns={{ base: 1, sm: 3 }} gap={2}>
                    <Badge tone={notification.readAt ? "neutral" : "accent"}>
                      {notification.readAt
                        ? t("ordering.features.orders.ui.accountNotificationListPage.read")
                        : t("ordering.features.orders.ui.accountNotificationListPage.unread")}
                    </Badge>
                    <Badge tone={notification.source === "orders" ? "success" : "accent"}>
                      {notification.source === "orders"
                        ? t("ordering.features.orders.ui.accountNotificationListPage.orders")
                        : t("ordering.features.orders.ui.accountNotificationListPage.shipments")}
                    </Badge>
                    <Text size="sm" tone="secondary">
                      {new Date(notification.createdAt).toLocaleString()}
                    </Text>
                  </Grid>
                  <Inline gap={2}>
                    {notification.actionHref ? (
                      <LinkButton href={notification.actionHref} tone="secondary">
                        {t("ordering.features.orders.ui.accountNotificationListPage.open")}
                      </LinkButton>
                    ) : null}
                    {!notification.readAt ? (
                      <form method="post">
                        <input type="hidden" name="intent" value="read-one" />
                        <input type="hidden" name="source" value={notification.source} />
                        <input type="hidden" name="deliveryId" value={notification.deliveryId} />
                        <Button type="submit" tone="ghost" size="sm">
                          {t("ordering.features.orders.ui.accountNotificationListPage.mark.read")}
                        </Button>
                      </form>
                    ) : null}
                  </Inline>
                </Stack>
              </Surface>
            ))}
          </Grid>
        )}
      </PageSection>
    </Page>
  );
}
