import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { t } from "@chase-sets/localization";
import { tryMoneyToCents } from "@chase-sets/primitives/money";
import { createUcpOAuthRequestApiClient } from "../../support/request-support/api-client";
import type { AgentGrant, AgentGrantActivityPage } from "../../features/agent-grants/ui/contracts";
import { AgentGrantDetailPage } from "../../features/agent-grants/ui/agent-grant-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createUcpOAuthRequestApiClient(request);
  const grantId = params.id!;
  const [detail, activity] = await Promise.all([
    api.getAgentGrant<{ authorization: AgentGrant }>(grantId),
    api.listAgentGrantActivity<AgentGrantActivityPage>(grantId, "limit=50&offset=0"),
  ]);
  return { grant: detail.authorization, activity: activity.activity };
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

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createUcpOAuthRequestApiClient(request);
  const grantId = params.id!;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "revoke") {
    await api.revokeAgentGrant(grantId);
  }

  if (intent === "update-mandate") {
    const allowedRails = formData.getAll("allowed_rails").map(String);
    await api.updateAgentGrantMandate(grantId, {
      max_per_order_cents: centsFromAmountField(formData.get("max_per_order_amount")),
      daily_cap_cents: centsFromAmountField(formData.get("daily_cap_amount")),
      monthly_cap_cents: centsFromAmountField(formData.get("monthly_cap_amount")),
      human_present_required: formData.get("human_present_required") !== "false",
      allowed_rails: allowedRails.length > 0 ? allowedRails : ["handoff-only"],
    });
  }

  return redirect(`/account/agents/${grantId}`);
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("auth.features.agentGrants.ui.agentGrantListPage.connected.agents") });

export default function MarketplaceAccountAgentDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <AgentGrantDetailPage grant={data.grant} activity={data.activity} />;
}
