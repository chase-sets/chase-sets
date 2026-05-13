import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useLoaderData } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createDiscoveryRequestApiClient } from "../support/request-support/api-client";
import { ProductAlertListPage } from "../features/product-alerts/ui/product-alert-list-page";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "accounts.view" });
  const discovery = createDiscoveryRequestApiClient(request);
  return discovery.listProductAlerts();
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

  return redirect("/account/product-alerts");
}

export const meta: MetaFunction = () => [
  {
    title: "Product Alerts | Chase Sets",
  },
];

export default function AccountProductAlertsRoute() {
  const data = useLoaderData<typeof loader>();
  return <ProductAlertListPage alerts={data.items} />;
}
