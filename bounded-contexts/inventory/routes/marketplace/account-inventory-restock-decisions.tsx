import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import contextManifest from "../../context.json";
import { InventoryApiError, type InventoryRestockDecision } from "../../support/request-support/api-client";
import { createInventoryRequestApiClient } from "../../support/request-support/api-client";
import { RestockDecisionQueuePage } from "../../features/restock-decisions/ui/restock-decision-queue-page";
import { inventoryApiErrorAdapter } from "../../support/request-support/route-api-error";

const DEFAULT_QUERY = "limit=100&offset=0";

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-inventory-restock-decisions",
  authorization: { permission: "inventory.view" },
  errorAdapter: inventoryApiErrorAdapter,
  load: ({ request }) => createInventoryRequestApiClient(request).listRestockDecisions(DEFAULT_QUERY),
  map: (decisions) => ({ decisions }),
  messages: { pending: "Restock decisions are still updating. Reload this page in a moment." },
});

export const action = defineFormAction({
  authorization: { permission: "inventory.manage" },
  errorAdapter: inventoryApiErrorAdapter,
  intents: {
    restock: async ({ request, formData }) =>
      formActionRedirect(
        await createInventoryRequestApiClient(request).recordRestockDecision(String(formData.get("decisionId") ?? ""), {
          outcome: "restocked",
        }),
        new URL(request.url).pathname,
      ),
    "write-off": async ({ request, formData }) =>
      formActionRedirect(
        await createInventoryRequestApiClient(request).recordRestockDecision(String(formData.get("decisionId") ?? ""), {
          outcome: "written-off",
          damageNote: String(formData.get("damageNote") ?? "").trim() || null,
        }),
        new URL(request.url).pathname,
      ),
  },
  onUnknownIntent: ({ request }) => formActionRedirect(null, new URL(request.url).pathname),
});

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
