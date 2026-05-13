import { useCallback, useEffect, useMemo, useState } from "react";
import {
  NotificationCenterDrawer,
  type NotificationCenterItem,
  type NotificationCenterPreference,
  type NotificationCenterProductAlert,
  type NotificationCenterView,
} from "@chase-sets/design-system";
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

const preferenceLabels: Record<NotificationPreference["key"], {
  label: string;
  description: string;
}> = {
  web: {
    label: "In-app notifications",
    description: "Show marketplace updates in the notification center.",
  },
  email: {
    label: "Email notifications",
    description: "Allow email delivery for eligible marketplace updates.",
  },
  "product-alerts": {
    label: "Product alerts",
    description: "Notify this account when watched products match alert rules.",
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
        .then((response) =>
          response.ok
            ? response.json() as Promise<ProductAlertResponse>
            : { items: [] },
        )
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
        createdAtLabel: formatTimestamp(item.createdAt),
        actionHref: item.actionHref,
        actionLabel: "Open",
        read: Boolean(item.readAt),
      })),
    [feed.items],
  );
  const preferenceItems = useMemo<readonly NotificationCenterPreference[]>(
    () =>
      preferences.map((preference) => ({
        key: preference.key,
        label: preferenceLabels[preference.key]?.label ?? preference.key,
        description: preferenceLabels[preference.key]?.description,
        enabled: preference.enabled,
      })),
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

  const reloadAfterProductAlertAction = useCallback(async (
    id: string,
    action: "pause" | "resume" | "delete",
  ) => {
    await fetch(`/api/marketplace/account/product-alerts/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
    await loadSettings();
  }, [loadSettings]);

  return (
    <NotificationCenterDrawer
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
        await notificationsApi.markRead(deliveryId).catch(() => undefined);
        await loadFeed();
      }}
      onMarkAllRead={async () => {
        await notificationsApi.markAllRead().catch(() => undefined);
        await loadFeed();
      }}
      onPreferenceChange={async (key, enabled) => {
        await notificationsApi.setPreference(key as NotificationPreference["key"], enabled)
          .catch(() => undefined);
        await loadSettings();
      }}
      onProductAlertPause={(id) => void reloadAfterProductAlertAction(id, "pause")}
      onProductAlertResume={(id) => void reloadAfterProductAlertAction(id, "resume")}
      onProductAlertDelete={(id) => void reloadAfterProductAlertAction(id, "delete")}
    />
  );
}

function sourceLabel(messageType: string) {
  if (messageType.startsWith("ordering.")) {
    return "Orders";
  }

  if (messageType.startsWith("fulfillment.")) {
    return "Shipments";
  }

  if (messageType.startsWith("discovery.product-alert")) {
    return "Product alerts";
  }

  return "Marketplace";
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function productAlertDetail(alert: ProductAlertResponse["items"][number]) {
  const side = alert.market_side === "listing" ? "Listings" : "Offers";
  if (!alert.threshold_amount) {
    return `${side} · all new matches`;
  }

  return alert.market_side === "listing"
    ? `${side} · at or below $${alert.threshold_amount}`
    : `${side} · at or above $${alert.threshold_amount}`;
}
