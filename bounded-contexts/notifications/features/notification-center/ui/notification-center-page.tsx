import { useEffect, useMemo, useState } from "react";
import { useFetcher, useNavigation, useRevalidator } from "react-router";
import {
  Badge,
  Banner,
  Button,
  Card,
  Cluster,
  Heading,
  Inline,
  LinkButton,
  MarketplaceEmptyState,
  Page,
  PageHeader,
  PageSection,
  Skeleton,
  Stack,
  Switch,
  Text,
} from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import {
  createNotificationCenterApiClient,
  type NotificationCenterFeedResponse,
  type NotificationPreference,
} from "../../../client";
import type {
  NotificationCenterProductAlert,
  NotificationCenterProductAlertList,
} from "../../../support/request-support/api-client";
import {
  notificationCenterPath,
  notificationCenterSettingsHref,
  type NotificationCenterSettingsSection,
} from "./notification-center-location";

// A failed read is its own state so the page never renders an outage as an empty feed or
// empty settings.
export type NotificationCenterRead<T> = Readonly<{ status: "loaded"; value: T }> | Readonly<{ status: "failed" }>;

export type NotificationCenterSettings = Readonly<{
  preferences: readonly NotificationPreference[];
  productAlerts: NotificationCenterProductAlertList;
}>;

export type NotificationCenterPageData =
  | Readonly<{ view: "feed"; feed: NotificationCenterRead<NotificationCenterFeedResponse> }>
  | Readonly<{
      view: "settings";
      section: NotificationCenterSettingsSection;
      settings: NotificationCenterRead<NotificationCenterSettings>;
    }>;

// Discovery owns Product Alert pause, resume, and delete; its account route action
// redirects back to the Product alerts settings view after the command commits.
const productAlertActionPath = "/account/product-alerts";
const productAlertsSectionId = "product-alerts";

const preferenceCopyKeys: Record<NotificationPreference["key"], { labelKey: string; descriptionKey: string }> = {
  web: {
    labelKey: "notifications.features.notificationCenter.ui.shell.preference.web.label",
    descriptionKey: "notifications.features.notificationCenter.ui.shell.preference.web.description",
  },
  email: {
    labelKey: "notifications.features.notificationCenter.ui.shell.preference.email.label",
    descriptionKey: "notifications.features.notificationCenter.ui.shell.preference.email.description",
  },
  "product-alerts": {
    labelKey: "notifications.features.notificationCenter.ui.shell.preference.productAlerts.label",
    descriptionKey: "notifications.features.notificationCenter.ui.shell.preference.productAlerts.description",
  },
};

export function NotificationCenterPage({ data }: Readonly<{ data: NotificationCenterPageData }>) {
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const loading =
    revalidator.state === "loading" ||
    (navigation.state === "loading" && navigation.location.pathname === notificationCenterPath);
  const failed = data.view === "feed" ? data.feed.status === "failed" : data.settings.status === "failed";

  return (
    <Page width="narrow">
      <PageHeader
        title={t("notifications.features.notificationCenter.ui.page.heading")}
        description={t("notifications.routes.accountNotifications.description")}
      />
      <Inline gap={2}>
        <LinkButton
          href={notificationCenterPath}
          tone={data.view === "feed" ? "primary" : "secondary"}
          size="sm"
          aria-current={data.view === "feed" ? "page" : undefined}
        >
          {t("notifications.features.notificationCenter.ui.page.feed.label")}
        </LinkButton>
        <LinkButton
          href={notificationCenterSettingsHref}
          tone={data.view === "settings" ? "primary" : "secondary"}
          size="sm"
          leadingIcon="settings"
          aria-current={data.view === "settings" ? "page" : undefined}
        >
          {t("notifications.features.notificationCenter.ui.page.settings.label")}
        </LinkButton>
      </Inline>
      {loading ? (
        <NotificationCenterLoading />
      ) : failed ? (
        <Banner
          tone="danger"
          title={t("notifications.features.notificationCenter.ui.page.readFailure.title")}
          description={t("notifications.features.notificationCenter.ui.page.readFailure.description")}
          actions={
            <Button type="button" tone="secondary" size="sm" onClick={() => revalidator.revalidate()}>
              {t("notifications.features.notificationCenter.ui.page.readFailure.retry")}
            </Button>
          }
        />
      ) : data.view === "feed" && data.feed.status === "loaded" ? (
        <NotificationFeed feed={data.feed.value} />
      ) : data.view === "settings" && data.settings.status === "loaded" ? (
        <NotificationSettings settings={data.settings.value} section={data.section} />
      ) : null}
    </Page>
  );
}

function NotificationCenterLoading() {
  return (
    <Stack gap={3} role="status" aria-label={t("notifications.features.notificationCenter.ui.page.loading")}>
      <Skeleton height="lg" />
      <Skeleton height="lg" />
      <Skeleton height="lg" />
    </Stack>
  );
}

function NotificationFeed({ feed: loadedFeed }: Readonly<{ feed: NotificationCenterFeedResponse }>) {
  // Seeded from the loader and then reconciled only from committed mutation snapshots;
  // a failed write leaves the current snapshot in place.
  const [feed, setFeed] = useState(loadedFeed);
  useEffect(() => {
    setFeed(loadedFeed);
  }, [loadedFeed]);
  const notificationsApi = useMemo(() => createNotificationCenterApiClient(), []);

  const markRead = async (deliveryId: string) => {
    const response = await notificationsApi.markRead(deliveryId).catch(() => null);
    if (response) {
      setFeed(response.feed);
    }
  };
  const markAllRead = async () => {
    const response = await notificationsApi.markAllRead().catch(() => null);
    if (response) {
      setFeed(response.feed);
    }
  };

  return (
    <Stack gap={3}>
      <Cluster gap={3}>
        <Heading level={2} visualSize={5}>
          {t("notifications.features.notificationCenter.ui.page.feed.heading")}
        </Heading>
        <Badge tone={feed.unread > 0 ? "accent" : "neutral"}>
          {t("notifications.features.notificationCenter.ui.page.feed.unread", { count: feed.unread })}
        </Badge>
      </Cluster>
      {feed.items.length > 0 ? (
        feed.items.map((item) => {
          const read = Boolean(item.readAt);

          return (
            <Card key={item.deliveryId}>
              <Stack gap={3}>
                <Cluster align="start" gap={3}>
                  <Stack gap={1} minWidth="0">
                    <Text size="sm" weight="semibold">
                      {item.title}
                    </Text>
                    <Text size="sm" tone="secondary">
                      {item.body}
                    </Text>
                  </Stack>
                  <Badge tone={read ? "neutral" : "accent"}>
                    {read
                      ? t("notifications.features.notificationCenter.ui.page.feed.read")
                      : t("notifications.features.notificationCenter.ui.page.feed.new")}
                  </Badge>
                </Cluster>
                <Inline gap={2}>
                  <Text element="span" size="xs" tone="secondary">
                    {sourceLabel(item.messageType)}
                  </Text>
                  <Text element="span" size="xs" tone="secondary">
                    {formatDateTime(item.createdAt)}
                  </Text>
                </Inline>
                {item.actionHref || !read ? (
                  <Inline gap={2}>
                    {item.actionHref ? (
                      <LinkButton href={item.actionHref} tone="secondary" size="sm">
                        {t("notifications.features.notificationCenter.ui.shell.open")}
                      </LinkButton>
                    ) : null}
                    {!read ? (
                      <Button type="button" tone="ghost" size="sm" onClick={() => void markRead(item.deliveryId)}>
                        {t("notifications.features.notificationCenter.ui.page.feed.markRead")}
                      </Button>
                    ) : null}
                  </Inline>
                ) : null}
              </Stack>
            </Card>
          );
        })
      ) : (
        <MarketplaceEmptyState
          title={t("notifications.features.notificationCenter.ui.page.feed.empty.title")}
          description={t("notifications.features.notificationCenter.ui.page.feed.empty.description")}
        />
      )}
      <Inline gap={2}>
        <Button
          type="button"
          tone="secondary"
          size="sm"
          disabled={feed.unread === 0}
          onClick={() => void markAllRead()}
        >
          {t("notifications.features.notificationCenter.ui.page.feed.markAllRead")}
        </Button>
      </Inline>
    </Stack>
  );
}

function NotificationSettings({
  settings,
  section,
}: Readonly<{ settings: NotificationCenterSettings; section: NotificationCenterSettingsSection }>) {
  const [preferences, setPreferences] = useState(settings.preferences);
  useEffect(() => {
    setPreferences(settings.preferences);
  }, [settings.preferences]);
  const notificationsApi = useMemo(() => createNotificationCenterApiClient(), []);
  const productAlertFetcher = useFetcher();
  const productAlertPending = productAlertFetcher.state !== "idle";

  useEffect(() => {
    if (section === "product-alerts") {
      document.getElementById(productAlertsSectionId)?.scrollIntoView?.();
    }
  }, [section]);

  const changePreference = async (key: NotificationPreference["key"], enabled: boolean) => {
    const response = await notificationsApi.setPreference(key, enabled).catch(() => null);
    if (response) {
      setPreferences((current) => current.map((preference) => (preference.key === key ? response.item : preference)));
    }
  };
  const submitProductAlertIntent = (intent: "pause" | "resume" | "delete", alertId: string) => {
    void productAlertFetcher.submit({ intent, alertId }, { method: "post", action: productAlertActionPath });
  };

  return (
    <Stack gap={6}>
      <PageSection
        title={t("notifications.features.notificationCenter.ui.page.settings.preferences.heading")}
        description={t("notifications.features.notificationCenter.ui.page.settings.preferences.description")}
      >
        <Stack gap={3}>
          {preferences.map((preference) => {
            const copy = preferenceCopyKeys[preference.key];

            return (
              <Switch
                key={preference.key}
                label={copy ? t(copy.labelKey) : preference.key}
                description={copy ? t(copy.descriptionKey) : undefined}
                checked={preference.enabled}
                onCheckedChange={(enabled) => void changePreference(preference.key, enabled)}
              />
            );
          })}
        </Stack>
      </PageSection>
      <PageSection
        id={productAlertsSectionId}
        title={t("notifications.features.notificationCenter.ui.page.settings.productAlerts.heading")}
        description={t("notifications.features.notificationCenter.ui.page.settings.productAlerts.description")}
      >
        {settings.productAlerts.items.length > 0 ? (
          <Stack gap={3}>
            {settings.productAlerts.items.map((alert) => (
              <Card key={alert.alert_id}>
                <Stack gap={3}>
                  <Cluster align="start" gap={3}>
                    <Stack gap={1} minWidth="0">
                      <Text size="sm" weight="semibold">
                        {alert.product_summary ?? alert.product_id}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {productAlertDetail(alert)}
                      </Text>
                    </Stack>
                    <Badge tone={alert.status === "active" ? "success" : "neutral"}>
                      {alert.status === "active"
                        ? t("notifications.features.notificationCenter.ui.page.settings.productAlerts.status.active")
                        : t("notifications.features.notificationCenter.ui.page.settings.productAlerts.status.paused")}
                    </Badge>
                  </Cluster>
                  <Inline gap={2}>
                    {alert.status === "active" ? (
                      <Button
                        type="button"
                        tone="secondary"
                        size="sm"
                        disabled={productAlertPending}
                        onClick={() => submitProductAlertIntent("pause", alert.alert_id)}
                      >
                        {t("notifications.features.notificationCenter.ui.page.settings.productAlerts.pause")}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        tone="secondary"
                        size="sm"
                        disabled={productAlertPending}
                        onClick={() => submitProductAlertIntent("resume", alert.alert_id)}
                      >
                        {t("notifications.features.notificationCenter.ui.page.settings.productAlerts.resume")}
                      </Button>
                    )}
                    <Button
                      type="button"
                      tone="ghost"
                      size="sm"
                      disabled={productAlertPending}
                      onClick={() => submitProductAlertIntent("delete", alert.alert_id)}
                    >
                      {t("notifications.features.notificationCenter.ui.page.settings.productAlerts.delete")}
                    </Button>
                    <LinkButton
                      href={`/items/${encodeURIComponent(alert.catalog_catalog_item_id)}`}
                      tone="ghost"
                      size="sm"
                    >
                      {t("notifications.features.notificationCenter.ui.page.settings.productAlerts.viewProduct")}
                    </LinkButton>
                  </Inline>
                </Stack>
              </Card>
            ))}
          </Stack>
        ) : (
          <MarketplaceEmptyState
            title={t("notifications.features.notificationCenter.ui.page.settings.productAlerts.empty.title")}
            description={t(
              "notifications.features.notificationCenter.ui.page.settings.productAlerts.empty.description",
            )}
          />
        )}
      </PageSection>
    </Stack>
  );
}

function sourceLabel(messageType: string) {
  if (messageType.startsWith("ordering.")) {
    return t("notifications.features.notificationCenter.ui.shell.source.orders");
  }

  if (messageType.startsWith("fulfillment.")) {
    return t("notifications.features.notificationCenter.ui.shell.source.shipments");
  }

  if (messageType.startsWith("inventory.")) {
    return t("notifications.features.notificationCenter.ui.shell.source.inventory");
  }

  if (messageType.startsWith("discovery.product-alert")) {
    return t("notifications.features.notificationCenter.ui.shell.source.productAlerts");
  }

  return t("notifications.features.notificationCenter.ui.shell.source.marketplace");
}

function productAlertDetail(alert: NotificationCenterProductAlert) {
  if (!alert.threshold_amount) {
    return alert.market_side === "listing"
      ? t("notifications.features.notificationCenter.ui.shell.productAlerts.listings.allNewMatches")
      : t("notifications.features.notificationCenter.ui.shell.productAlerts.offers.allNewMatches");
  }

  return alert.market_side === "listing"
    ? t("notifications.features.notificationCenter.ui.shell.productAlerts.listings.atOrBelow", {
        amount: alert.threshold_amount,
      })
    : t("notifications.features.notificationCenter.ui.shell.productAlerts.offers.atOrAbove", {
        amount: alert.threshold_amount,
      });
}
