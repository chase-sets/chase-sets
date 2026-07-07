import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import type { RiskAlertAction } from "../../features/risk-alerts/api/contracts";
import { RiskAlertAdminDetailPage } from "../../features/risk-alerts/ui/admin-pages";
import { createRiskAlertRequestApiClient } from "../../support/request-support/risk-alert-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  return { item: await createRiskAlertRequestApiClient(request).getRiskAlertQueueItem(params.alertId ?? "") };
}

function normalizeAction(value: FormDataEntryValue | null): RiskAlertAction {
  if (value === "request-manual-payout-review" || value === "acknowledge") {
    return value;
  }
  throw new Response("Invalid risk alert action.", { status: 400 });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const alertId = params.alertId ?? "";
  await createRiskAlertRequestApiClient(request).recordRiskAlertAction(
    alertId,
    normalizeAction(formData.get("action")),
    String(formData.get("note") ?? "").trim() || null,
  );
  return redirect(`/risk-alerts/${encodeURIComponent(alertId)}`);
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.item
      ? t("platformOperations.riskAlerts.detailMetaTitle", { alertKind: data.item.alert_kind })
      : t("platformOperations.riskAlerts.metaTitle"),
  },
];

export default function RiskAlertDetailRoute() {
  const { item } = useLoaderData<typeof loader>();
  return <RiskAlertAdminDetailPage item={item} />;
}
