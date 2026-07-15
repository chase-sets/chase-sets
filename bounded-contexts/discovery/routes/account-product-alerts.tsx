import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createDiscoveryRequestApiClient } from "../support/request-support/api-client";
import { productAlertSettingsHref } from "../features/search/ui/product-alert-settings-link";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "accounts.view" });
  return redirect(productAlertSettingsHref);
}

const afterAlertAction = formActionRedirect(null, productAlertSettingsHref);

export const action = defineFormAction({
  authorization: { permission: "accounts.view" },
  intents: {
    pause: async ({ request, formData }) => {
      await createDiscoveryRequestApiClient(request).pauseProductAlert(String(formData.get("alertId") ?? ""));
      return afterAlertAction;
    },
    resume: async ({ request, formData }) => {
      await createDiscoveryRequestApiClient(request).resumeProductAlert(String(formData.get("alertId") ?? ""));
      return afterAlertAction;
    },
    delete: async ({ request, formData }) => {
      await createDiscoveryRequestApiClient(request).deleteProductAlert(String(formData.get("alertId") ?? ""));
      return afterAlertAction;
    },
  },
  onUnknownIntent: () => afterAlertAction,
});

export const meta: MetaFunction = () => [
  {
    title: t("discovery.routes.accountProductAlerts.title"),
  },
];

export default function AccountProductAlertsRedirectRoute() {
  return null;
}
