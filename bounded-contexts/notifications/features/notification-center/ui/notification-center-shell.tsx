import { useCallback, useEffect, useMemo, useState } from "react";
import {
  NotificationCenterSheet,
  type NotificationCenterItem,
  type NotificationCenterPreference,
  type NotificationCenterProductAlert,
  type NotificationCenterView,
} from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import {
  createNotificationCenterApiClient,
  type NotificationCenterFeedResponse,
  type NotificationPreference,
} from "../../../client";

type ProductAlertResponse = Readonly<{
  items: readonly Readonly<{
    alert_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    product_summary: string | null;
    market_side: "listing" | "offer";
    threshold_amount: string | null;
    status: "active" | "paused";
  }>[];
}>;

export interface NotificationCenterShellProps {
  open: boolean;
  view?: NotificationCenterView;
  onOpenChange?: (open: boolean) => void;
  onViewChange?: (view: NotificationCenterView) => void;
}

const preferenceCopyKeys: Record<
  NotificationPreference["key"],
  {
    labelKey: string;
    descriptionKey: string;
  }
> = {
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

const notificationsApi = createNotificationCenterApiClient();

export function NotificationCenterShell({
  open,
  view = "feed",
  onOpenChange,
  onViewChange,
}: NotificationCenterShellProps) {
  const [loading, setLoading] = useState(false);
  const [feed, setFeed] = useState<NotificationCenterFeedResponse>({
    items: [],
    count: 0,
    unread: 0,
  });
  const [preferences, setPreferences] = useState<readonly NotificationPreference[]>([]);
  const [productAlerts, setProductAlerts] = useState<ProductAlertResponse>({ items: [] });

  const loadFeed = useCallback(async () => {
    setLoading(true);
    try {
      setFeed(await notificationsApi.listCenterFeed("limit=25&includeRead=true"));
    } catch {
      setFeed({ items: [], count: 0, unread: 0 });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const [nextPreferences, nextProductAlerts] = await Promise.all([
      notificationsApi.listPreferences().catch(() => ({ items: [] })),
      fetch("/api/marketplace/account/product-alerts", { credentials: "include" })
        .then((response) => (response.ok ? (response.json() as Promise<ProductAlertResponse>) : { items: [] }))
        .catch(() => ({ items: [] })),
    ]);

    setPreferences(nextPreferences.items);
    setProductAlerts(nextProductAlerts);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    void loadFeed();
    if (view === "settings") {
      void loadSettings();
    }
  }, [loadFeed, loadSettings, open, view]);

  const items = useMemo<readonly NotificationCenterItem[]>(
    () =>
      feed.items.map((item) => ({
        deliveryId: item.deliveryId,
        title: item.title,
        body: item.body,
        sourceLabel: sourceLabel(item.messageType),
        createdAtLabel: formatDateTime(item.createdAt),
        actionHref: item.actionHref,
        actionLabel: t("notifications.features.notificationCenter.ui.shell.open"),
        read: Boolean(item.readAt),
      })),
    [feed.items],
  );
  const preferenceItems = useMemo<readonly NotificationCenterPreference[]>(
    () =>
      preferences.map((preference) => {
        const copy = preferenceCopyKeys[preference.key];

        return {
          key: preference.key,
          label: copy ? t(copy.labelKey) : preference.key,
          description: copy ? t(copy.descriptionKey) : undefined,
          enabled: preference.enabled,
        };
      }),
    [preferences],
  );
  const alertItems = useMemo<readonly NotificationCenterProductAlert[]>(
    () =>
      productAlerts.items.map((alert) => ({
        id: alert.alert_id,
        title: alert.product_summary ?? alert.product_id,
        detail: productAlertDetail(alert),
        status: alert.status,
        productHref: `/items/${encodeURIComponent(alert.catalog_catalog_item_id)}`,
      })),
    [productAlerts.items],
  );

  const reloadAfterProductAlertAction = useCallback(
    async (id: string, action: "pause" | "resume" | "delete") => {
      await fetch(`/api/marketplace/account/product-alerts/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => undefined);
      await loadSettings();
    },
    [loadSettings],
  );

  return (
    <NotificationCenterSheet
      open={open}
      view={view}
      unreadCount={feed.unread}
      loading={loading}
      notifications={items}
      preferences={preferenceItems}
      productAlerts={alertItems}
      onOpenChange={onOpenChange}
      onViewChange={(nextView) => {
        onViewChange?.(nextView);
        if (nextView === "settings") {
          void loadSettings();
        }
      }}
      onMarkRead={async (deliveryId) => {
        const response = await notificationsApi.markRead(deliveryId).catch(() => null);
        if (response) {
          setFeed(response.feed);
        }
      }}
      onMarkAllRead={async () => {
        const response = await notificationsApi.markAllRead().catch(() => null);
        if (response) {
          setFeed(response.feed);
        }
      }}
      onPreferenceChange={async (key, enabled) => {
        const response = await notificationsApi
          .setPreference(key as NotificationPreference["key"], enabled)
          .catch(() => null);
        if (response) {
          setPreferences((current) =>
            current.map((preference) => (preference.key === key ? response.item : preference)),
          );
        }
      }}
      onProductAlertPause={(id) => void reloadAfterProductAlertAction(id, "pause")}
      onProductAlertResume={(id) => void reloadAfterProductAlertAction(id, "resume")}
      onProductAlertDelete={(id) => void reloadAfterProductAlertAction(id, "delete")}
    />
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

function productAlertDetail(alert: ProductAlertResponse["items"][number]) {
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
