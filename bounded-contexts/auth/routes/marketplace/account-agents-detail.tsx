import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { t } from "@chase-sets/localization";
import { tryMoneyToCents } from "@chase-sets/primitives/money";
import { createUcpOAuthRequestApiClient } from "../../support/request-support/api-client";
import type { AgentGrant, AgentGrantActivityPage, AgentGrantWebhook } from "../../features/agent-grants/ui/contracts";
import { AgentGrantDetailPage } from "../../features/agent-grants/ui/agent-grant-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createUcpOAuthRequestApiClient(request);
  const grantId = params.id!;
  const [detail, activity] = await Promise.all([
    api.getAgentGrant<{ authorization: AgentGrant }>(grantId),
    api.listAgentGrantActivity<AgentGrantActivityPage>(grantId, "limit=50&offset=0"),
  ]);
  const webhook = await api.getAgentGrantWebhook<{ webhook: AgentGrantWebhook | null }>(grantId);
  return { grant: detail.authorization, activity: activity.activity, webhook: webhook.webhook };
}

// Decimal-string form field (e.g. "12.50", empty for "no cap") -> integer cents or null,
// matching the wire shape parseSpendingMandate expects in oauth.ts.
function centsFromAmountField(value: FormDataEntryValue | null): number | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }
  const cents = tryMoneyToCents(raw);
  return cents === null ? null : Number(cents);
}

const agentDestination = (id: string) => `/account/agents/${id}`;

export const action = defineFormAction({
  intents: {
    revoke: async ({ request, params }) => {
      await createUcpOAuthRequestApiClient(request).revokeAgentGrant(params.id!);
      return formActionRedirect(null, agentDestination(params.id!));
    },
    "update-mandate": async ({ request, params, formData }) => {
      const allowedRails = formData.getAll("allowed_rails").map(String);
      await createUcpOAuthRequestApiClient(request).updateAgentGrantMandate(params.id!, {
        max_per_order_cents: centsFromAmountField(formData.get("max_per_order_amount")),
        daily_cap_cents: centsFromAmountField(formData.get("daily_cap_amount")),
        monthly_cap_cents: centsFromAmountField(formData.get("monthly_cap_amount")),
        human_present_required: formData.get("human_present_required") !== "false",
        allowed_rails: allowedRails.length > 0 ? allowedRails : ["handoff-only"],
      });
      return formActionRedirect(null, agentDestination(params.id!));
    },
    "update-webhook": async ({ request, params, formData }) => {
      const result = await createUcpOAuthRequestApiClient(request).updateAgentGrantWebhook<{
        webhook: AgentGrantWebhook | null;
      }>(params.id!, String(formData.get("callback_url") ?? "").trim() || null);
      return { webhook: result.webhook };
    },
    "disable-webhook": async ({ request, params }) => {
      const result = await createUcpOAuthRequestApiClient(request).updateAgentGrantWebhook<{
        webhook: AgentGrantWebhook | null;
      }>(params.id!, null);
      return { webhook: result.webhook };
    },
  },
  onUnknownIntent: ({ params }) => formActionRedirect(null, agentDestination(params.id!)),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("auth.features.agentGrants.ui.agentGrantListPage.connected.agents") });

export default function MarketplaceAccountAgentDetailRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { webhook?: AgentGrantWebhook | null } | undefined;
  return (
    <AgentGrantDetailPage
      grant={data.grant}
      activity={data.activity}
      webhook={data.webhook}
      savedWebhook={actionData?.webhook}
    />
  );
}
