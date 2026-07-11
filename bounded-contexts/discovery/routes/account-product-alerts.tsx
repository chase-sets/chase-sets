import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createDiscoveryRequestApiClient } from "../support/request-support/api-client";
import { productAlertSettingsHref } from "../features/search/ui/product-alert-settings-link";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "accounts.view" });
  return redirect(productAlertSettingsHref);
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "accounts.view" });
  const formData = await request.formData();
  const alertId = String(formData.get("alertId") ?? "");
  const intent = String(formData.get("intent") ?? "");
  const discovery = createDiscoveryRequestApiClient(request);

  if (intent === "pause") {
    await discovery.pauseProductAlert(alertId);
  } else if (intent === "resume") {
    await discovery.resumeProductAlert(alertId);
  } else if (intent === "delete") {
    await discovery.deleteProductAlert(alertId);
  }

  return redirect(productAlertSettingsHref);
}

export const meta: MetaFunction = () => [
  {
    title: t("discovery.routes.accountProductAlerts.title"),
  },
];

export default function AccountProductAlertsRedirectRoute() {
  return null;
}
