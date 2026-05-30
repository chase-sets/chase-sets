import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { SupportOperationsPage } from "../../features/support-requests/ui/support-operations-page";
import { createSupportRequestRequestApiClient } from "../../support/request-support/api-client";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("support.routes.admin.operationsQueue.request.failed");
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createSupportRequestRequestApiClient(request);
  const query = new URLSearchParams({
    limit: "100",
    offset: "0",
  });

  try {
    return {
      queue: await api.listSupportOperationsQueue(query.toString()),
      unavailableMessage: null,
    };
  } catch (error) {
    return {
      queue: {
        items: [],
        total: 0,
        count: 0,
      },
      unavailableMessage: errorMessage(error),
    };
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createSupportRequestRequestApiClient(request);

  if (intent === "escalate-overdue") {
    try {
      const result = await api.escalateOverdueSupportRequests({ limit: 100 });
      const query = new URLSearchParams({
        escalated: String(result.escalated),
        skipped: String(result.skipped),
      });
      return redirect(`/operations/support-requests?${query.toString()}`);
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  return null;
}

export const meta: MetaFunction = () => [{ title: t("support.routes.admin.operationsQueue.meta.title") }];

export default function SupportOperationsQueueRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const escalated = searchParams.get("escalated");
  const skipped = searchParams.get("skipped");
  const escalationResult =
    escalated !== null && skipped !== null
      ? {
          escalated: Number(escalated),
          skipped: Number(skipped),
        }
      : null;

  return (
    <SupportOperationsPage
      queue={data.queue}
      unavailableMessage={data.unavailableMessage}
      escalationResult={escalationResult}
      actionError={actionData?.error ?? null}
    />
  );
}
