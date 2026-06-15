import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { appendFreshWriteTokenFromSources } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { t } from "@chase-sets/localization";
import { createAuthRequestApiClient } from "../../support/request-support/api-client";
import type { Session } from "../../features/sessions/ui/contracts";
import { SessionDetailPage } from "../../features/sessions/ui/session-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createAuthRequestApiClient(request);
  return {
    id: params.id!,
    data: await api.getSession<Session>(params.id!),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createAuthRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const sessionId = params.id!;
  const results: unknown[] = [];

  if (intent === "switch-account") {
    results.push(await api.switchSessionAccount(sessionId, String(formData.get("accountId") ?? "")));
  }

  if (intent === "revoke") {
    results.push(await api.revokeSession(sessionId));
  }

  return redirect(appendFreshWriteTokenFromSources(`/account/sessions/${sessionId}`, results));
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("auth.features.sessions.ui.sessionListPage.session") });

export default function MarketplaceAccountSessionDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <SessionDetailPage data={data.data} />;
}
