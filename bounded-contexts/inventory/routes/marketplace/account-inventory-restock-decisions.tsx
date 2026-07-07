import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { loadAfterWrite, navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { InventoryApiError, type InventoryRestockDecision } from "../../support/request-support/api-client";
import { createInventoryRequestApiClient } from "../../support/request-support/api-client";
import { RestockDecisionQueuePage } from "../../features/restock-decisions/ui/restock-decision-queue-page";

const DEFAULT_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.view",
  });
  const api = createInventoryRequestApiClient(request);
  const decisionsRead = await loadAfterWrite({
    request,
    load: () => api.listRestockDecisions(DEFAULT_QUERY),
    isNotFound: () => false,
  });

  if (decisionsRead.kind === "data") {
    return {
      decisions: decisionsRead.data,
    };
  }

  throw new Response("Restock decisions are still updating. Reload this page in a moment.", {
    status: 503,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.manage",
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const decisionId = String(formData.get("decisionId") ?? "");
  const api = createInventoryRequestApiClient(request);

  try {
    if (intent === "restock") {
      return redirect(
        navigateAfterWrite(
          await api.recordRestockDecision(decisionId, { outcome: "restocked" }),
          new URL(request.url).pathname,
        ),
      );
    }
    if (intent === "write-off") {
      return redirect(
        navigateAfterWrite(
          await api.recordRestockDecision(decisionId, {
            outcome: "written-off",
            damageNote: String(formData.get("damageNote") ?? "").trim() || null,
          }),
          new URL(request.url).pathname,
        ),
      );
    }

    return redirect(new URL(request.url).pathname);
  } catch (error) {
    if (error instanceof InventoryApiError) {
      return {
        error: error.message,
      };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("inventory.routes.marketplace.accountInventoryRestockDecisions.title"),
    description: t("inventory.routes.marketplace.accountInventoryRestockDecisions.description"),
  });

export default function MarketplaceInventoryRestockDecisionsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <RestockDecisionQueuePage
      decisions={(data.decisions.items ?? []) as InventoryRestockDecision[]}
      errorMessage={actionData?.error ?? null}
    />
  );
}
