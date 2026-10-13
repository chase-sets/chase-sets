import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { t } from "@chase-sets/localization";
import { Text } from "@chase-sets/design-system";
import { tryMoneyToCents } from "@chase-sets/primitives/money";
import { AuthApiError, createUcpOAuthRequestApiClient } from "../../support/request-support/api-client";
import type {
  AgentGrant,
  AgentGrantActivityPage,
  AgentGrantWebhook,
  AgentGrantRevocationReceipt,
} from "../../features/agent-grants/ui/contracts";
import { AgentGrantDetailPage } from "../../features/agent-grants/ui/agent-grant-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createUcpOAuthRequestApiClient(request);
  const grantId = params.id!;
  const [detail, activity] = await Promise.all([
    api.getAgentGrant<{ authorization: AgentGrant; revocation_available: boolean }>(grantId),
    api.listAgentGrantActivity<AgentGrantActivityPage>(grantId, "limit=50&offset=0"),
  ]);
  const webhook = await api.getAgentGrantWebhook<{ webhook: AgentGrantWebhook | null }>(grantId);
  return {
    grant: detail.authorization,
    activity: activity.activity,
    webhook: webhook.webhook,
    revocationAvailable: detail.revocation_available,
  };
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
    revoke: async ({ request, params, formData }) => {
      const submitted = formData.get("attempt_id");
      const attemptId = typeof submitted === "string" && submitted ? submitted : globalThis.crypto.randomUUID();
      const api = createUcpOAuthRequestApiClient(request);
      try {
        return {
          grantId: params.id!,
          revocation: safeRevocationReceipt(await api.revokeAgentGrant(params.id!, attemptId), attemptId),
        };
      } catch (error) {
        if (error instanceof AuthApiError)
          return { grantId: params.id!, revocation: revocationFailure(error.status, attemptId) };
        try {
          return {
            grantId: params.id!,
            revocation: safeRevocationReceipt(await api.getAgentGrantRevocation(params.id!, attemptId), attemptId),
          };
        } catch (readError) {
          return {
            grantId: params.id!,
            revocation: revocationFailure(readError instanceof AuthApiError ? readError.status : 0, attemptId),
          };
        }
      }
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
      return { grantId: params.id!, webhook: result.webhook };
    },
    "disable-webhook": async ({ request, params }) => {
      const result = await createUcpOAuthRequestApiClient(request).updateAgentGrantWebhook<{
        webhook: AgentGrantWebhook | null;
      }>(params.id!, null);
      return { grantId: params.id!, webhook: result.webhook };
    },
  },
  onUnknownIntent: ({ params }) => formActionRedirect(null, agentDestination(params.id!)),
});

function revocationFailure(status: number, attemptId: string): AgentGrantRevocationReceipt {
  return {
    attempt_id: attemptId,
    state:
      status === 401
        ? "reauth-required"
        : status === 404
          ? "route-denied"
          : status === 409
            ? "conflict"
            : status === 503
              ? "failed-safe"
              : "ambiguous",
  };
}

function safeRevocationReceipt(value: unknown, attemptId: string): AgentGrantRevocationReceipt {
  if (
    !value ||
    typeof value !== "object" ||
    !("attempt_id" in value) ||
    value.attempt_id !== attemptId ||
    !("state" in value) ||
    !["succeeded", "already-revoked-cleanup-complete", "ambiguous", "failed-safe", "conflict"].includes(
      String(value.state),
    )
  )
    return revocationFailure(0, attemptId);
  const receipt: AgentGrantRevocationReceipt = {
    attempt_id: attemptId,
    state: value.state as AgentGrantRevocationReceipt["state"],
  };
  if (
    ["succeeded", "already-revoked-cleanup-complete"].includes(receipt.state) &&
    (!("phase" in value) || value.phase !== "completed")
  )
    return revocationFailure(0, attemptId);
  if (
    "phase" in value &&
    ["admitted", "identity-terminal", "payments-terminal", "webhook-excluded", "completed"].includes(
      String(value.phase),
    )
  )
    return { ...receipt, phase: value.phase as AgentGrantRevocationReceipt["phase"] };
  return receipt;
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("auth.features.agentGrants.ui.agentGrantListPage.connected.agents") });

export default function MarketplaceAccountAgentDetailRoute() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>() as
    | { grantId?: string; webhook?: AgentGrantWebhook | null; revocation?: AgentGrantRevocationReceipt }
    | undefined;
  const currentAction = navigation.state === "idle" && actionData?.grantId === data.grant.id ? actionData : undefined;
  if (navigation.state !== "idle" && navigation.formData?.get("intent") !== "revoke")
    return <Text role="status">{t("auth.features.agentGrants.ui.agentGrantDetailPage.revocation.loading")}</Text>;
  return (
    <AgentGrantDetailPage
      key={`${data.grant.account_id}:${data.grant.id}`}
      grant={data.grant}
      activity={data.activity}
      webhook={data.webhook}
      savedWebhook={currentAction?.webhook}
      revocation={currentAction?.revocation}
      revocationAvailable={data.revocationAvailable}
    />
  );
}
