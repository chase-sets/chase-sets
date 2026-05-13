import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";

const notificationCenterHref = "/search?notifications=feed";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "accounts.view" });
  return redirect(notificationCenterHref);
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("notifications.routes.accountNotifications.title"),
    description: t("notifications.routes.accountNotifications.description"),
  });

export default function AccountNotificationsRedirectRoute() {
  return null;
}
