import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { classifyFreshWriteReadError } from "@chase-sets/http/responses";
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

// A Product alert write redirects here with its receipt, which only Discovery's alerts read
// should wait for; the preferences read is Notifications' and does not depend on it.
function requestWithoutWriteReceipt(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete("afterWrite");
  url.searchParams.delete("postWriteHandoff");
  url.searchParams.delete("postWriteToken");
  return new Request(url, { headers: request.headers, method: request.method, signal: request.signal });
}

// After a write, an alerts read that has not caught up yet is null: the change is saved and the
// page reads again, rather than showing the alerts as they were or a failed read.
async function readProductAlerts(request: Request) {
  try {
    return await createNotificationCenterProductAlertsRequestClient(request).listProductAlerts();
  } catch (error) {
    if (classifyFreshWriteReadError({ request, error }).transient) {
      return null;
    }
    throw error;
  }
}

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
      createNotificationCenterRequestApiClient(requestWithoutWriteReceipt(request)).listPreferences(),
      readProductAlerts(request),
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
