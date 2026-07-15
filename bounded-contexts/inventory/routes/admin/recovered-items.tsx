import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, type FormActionContext } from "@chase-sets/platform-runtime/http";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { createInventoryRequestApiClient } from "../../support/request-support/api-client";
import { RecoveredItemsPage, type RecoveredItemMetrics } from "../../features/recovered-items/ui/recovered-items-page";

function csv(value: FormDataEntryValue | null): readonly string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "recovered-inventory.view" });
  const api = createInventoryRequestApiClient(request);
  const [items, metrics] = await Promise.all([api.listRecoveredItems(), api.getRecoveredItemMetrics()]);
  return { items: items.items ?? [], metrics: metrics as RecoveredItemMetrics };
}

async function handleAction(actionIntent: string, { request, formData }: FormActionContext) {
  const api = createInventoryRequestApiClient(request);
  const recoveredItemId = String(formData.get("recoveredItemId") ?? "").trim();
  const body: Record<string, unknown> = {
    intent: actionIntent,
    policyVersion: String(formData.get("policyVersion") ?? ""),
    evidenceReferences: csv(formData.get("evidenceReferences")),
    catalogItemId: String(formData.get("catalogItemId") ?? ""),
    productId: String(formData.get("productId") ?? ""),
    selectedOptions: [],
    conditionGrade: String(formData.get("conditionGrade") ?? ""),
    outcome: String(formData.get("outcome") ?? ""),
    reviewReference: String(formData.get("reviewReference") ?? ""),
    legalOwner: String(formData.get("legalOwner") ?? ""),
    authorityKind: String(formData.get("authorityKind") ?? ""),
    allowedDispositions: csv(formData.get("allowedDispositions")),
    disposition: String(formData.get("disposition") ?? ""),
    targetAccountId: String(formData.get("targetAccountId") ?? ""),
    storageLocationId: String(formData.get("storageLocationId") ?? ""),
    reasonCode: String(formData.get("reasonCode") ?? ""),
    reason: String(formData.get("reasonCode") ?? ""),
    recoveryId: String(formData.get("recoveryId") ?? ""),
    recoveryType: String(formData.get("recoveryType") ?? ""),
    grossAmount: String(formData.get("grossAmount") ?? "0.00"),
    costAmount: String(formData.get("costAmount") ?? "0.00"),
    currencyCode: String(formData.get("currencyCode") ?? "USD"),
    correctedReturnShipmentId: String(formData.get("correctedReturnShipmentId") ?? ""),
    canonicalRecoveredItemId: String(formData.get("canonicalRecoveredItemId") ?? ""),
  };
  try {
    return await api.executeRecoveredItemAction(recoveredItemId, body);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t("inventory.features.recoveredItems.ui.page.action.failed"),
    };
  }
}

export const action = defineFormAction({
  authorization: { permission: "recovered-inventory.manage" },
  intents: {
    identify: (context) => handleAction("identify", context),
    inspect: (context) => handleAction("inspect", context),
    "require-authenticity-review": (context) => handleAction("require-authenticity-review", context),
    "complete-authenticity-review": (context) => handleAction("complete-authenticity-review", context),
    "record-authority": (context) => handleAction("record-authority", context),
    "decide-disposition": (context) => handleAction("decide-disposition", context),
    "record-value": (context) => handleAction("record-value", context),
    "correct-source": (context) => handleAction("correct-source", context),
    merge: (context) => handleAction("merge", context),
  },
  onUnknownIntent: () => ({ error: t("inventory.features.recoveredItems.ui.page.action.unknown") }),
});

export const meta: MetaFunction = () => [{ title: t("inventory.routes.admin.recoveredItems.title") }];

export default function AdminRecoveredItemsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as { recoveredItemId?: string; status?: string; error?: string } | undefined;
  return <RecoveredItemsPage items={data.items} metrics={data.metrics} lastAction={actionData} />;
}
