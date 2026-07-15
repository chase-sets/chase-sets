import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { adminAuthHostConfig } from "../../support/route-support/host-config";
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

const sessionDestination = (id: string) => `/access/sessions/${id}`;

export const action = defineFormAction({
  intents: {
    "switch-account": async ({ request, params, formData }) =>
      formActionRedirect(
        await createAuthRequestApiClient(request).switchSessionAccount(
          params.id!,
          String(formData.get("accountId") ?? ""),
        ),
        sessionDestination(params.id!),
      ),
    revoke: async ({ request, params }) =>
      formActionRedirect(
        await createAuthRequestApiClient(request).revokeSession(params.id!),
        sessionDestination(params.id!),
      ),
  },
  onUnknownIntent: ({ params }) => formActionRedirect(null, sessionDestination(params.id!)),
});

export const meta: MetaFunction = () => [{ title: adminAuthHostConfig.titles.sessionDetail! }];

export default function SessionDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <SessionDetailPage data={data.data} />;
}
