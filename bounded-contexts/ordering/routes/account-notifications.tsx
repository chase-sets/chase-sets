import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  AccountNotificationListPage,
  type AccountNotificationListItem,
  type AccountNotificationSource,
} from "../features/orders/ui/account-notification-list-page";
import { createOrderingRequestApiClient } from "../support/request-support/api-client";

type FeedResponse = Readonly<{
  items: readonly Readonly<{
    deliveryId: string;
    title: string;
    body: string;
    actionHref: string | null;
    criticality: string;
    readAt: string | null;
    createdAt: string;
  }>[];
  unread: number;
}>;

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "accounts.view" });
  const ordering = createOrderingRequestApiClient(request);
  const [orders, shipments, productAlerts] = await Promise.all([
    ordering.listOrderNotifications("limit=50&includeRead=true"),
    fetchNotificationFeed(request, "shipment-notifications"),
    fetchNotificationFeed(request, "product-alert-notifications"),
  ]);
  const notifications = [
    ...mapFeed("orders", orders),
    ...mapFeed("shipments", shipments),
    ...mapFeed("product-alerts", productAlerts),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return {
    notifications,
    unreadCount: orders.unread + shipments.unread + productAlerts.unread,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "accounts.view" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "read-all") {
    const ordering = createOrderingRequestApiClient(request);
    await Promise.all([
      ordering.markAllOrderNotificationsRead(),
      postNotificationAction(request, "shipment-notifications/read-all"),
      postNotificationAction(request, "product-alert-notifications/read-all"),
    ]);
    return redirect("/account/notifications");
  }

  if (intent === "read-one") {
    const source = String(formData.get("source") ?? "");
    const deliveryId = String(formData.get("deliveryId") ?? "");
    if (source === "orders") {
      await createOrderingRequestApiClient(request).markOrderNotificationRead(deliveryId);
    } else if (source === "shipments") {
      await postNotificationAction(
        request,
        `shipment-notifications/${encodeURIComponent(deliveryId)}/read`,
      );
    } else if (source === "product-alerts") {
      await postNotificationAction(
        request,
        `product-alert-notifications/${encodeURIComponent(deliveryId)}/read`,
      );
    }
  }

  return redirect("/account/notifications");
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("ordering.routes.accountNotifications.notifications.marketplace"),
    description: t("ordering.routes.accountNotifications.notifications.description"),
  });

export default function OrderingAccountNotificationsRoute() {
  const data = useLoaderData<typeof loader>();
  return (
    <AccountNotificationListPage
      notifications={data.notifications}
      unreadCount={data.unreadCount}
    />
  );
}

function mapFeed(
  source: AccountNotificationSource,
  feed: FeedResponse,
): readonly AccountNotificationListItem[] {
  return feed.items.map((item) => ({
    source,
    deliveryId: item.deliveryId,
    title: item.title,
    body: item.body,
    actionHref: item.actionHref,
    criticality: item.criticality,
    readAt: item.readAt,
    createdAt: item.createdAt,
  }));
}

async function fetchNotificationFeed(
  request: Request,
  path: "shipment-notifications" | "product-alert-notifications",
): Promise<FeedResponse> {
  const fetchWithAuth = createForwardedAuthFetch(request);
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/marketplace");
  const response = await fetchWithAuth(
    `${baseUrl}/account/${path}?limit=50&includeRead=true`,
  );
  if (!response.ok) {
    return { items: [], unread: 0 };
  }

  return response.json() as Promise<FeedResponse>;
}

async function postNotificationAction(request: Request, path: string) {
  const fetchWithAuth = createForwardedAuthFetch(request);
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/marketplace");
  await fetchWithAuth(`${baseUrl}/account/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}
