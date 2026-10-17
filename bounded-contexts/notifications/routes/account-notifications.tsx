import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { readNotificationCenterLocation } from "../features/notification-center/ui/notification-center-location";
import {
  NotificationCenterPage,
  type NotificationCenterPageData,
  type NotificationCenterRead,
} from "../features/notification-center/ui/notification-center-page";
import {
  createNotificationCenterProductAlertsRequestClient,
  createNotificationCenterRequestApiClient,
} from "../support/request-support/api-client";

const feedQuery = "limit=25&includeRead=true";

function readResult<T>(read: Promise<T>): Promise<NotificationCenterRead<T>> {
  return read.then(
    (value) => ({ status: "loaded", value }),
    () => ({ status: "failed" }),
  );
}

export async function loader({ request }: LoaderFunctionArgs): Promise<NotificationCenterPageData> {
  await requireActorFromAuthApi({ request, permission: "accounts.view" });
  const location = readNotificationCenterLocation(new URL(request.url).searchParams);
  const notifications = createNotificationCenterRequestApiClient(request);

  if (location.view === "feed") {
    return { view: "feed", feed: await readResult(notifications.listCenterFeed(feedQuery)) };
  }

  // Settings needs both reads; either failing fails the settings load rather than
  // rendering empty preferences or an empty Product alerts list.
  const settings = await readResult(
    Promise.all([
      notifications.listPreferences(),
      createNotificationCenterProductAlertsRequestClient(request).listProductAlerts(),
    ]).then(([preferences, productAlerts]) => ({ preferences: preferences.items, productAlerts })),
  );

  return { view: "settings", section: location.section, settings };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("notifications.routes.accountNotifications.title"),
    description: t("notifications.routes.accountNotifications.description"),
  });

export default function AccountNotificationsRoute() {
  return <NotificationCenterPage data={useLoaderData<typeof loader>()} />;
}
