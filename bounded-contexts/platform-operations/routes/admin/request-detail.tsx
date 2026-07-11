import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { SupportOperationsDetailPage } from "../../features/support-requests/ui/support-operations-page";
import { createSupportRequestRequestApiClient } from "../../support/request-support/support-request-api-client";
import { resolveSupportRequestsMarketplaceOrigin } from "./requests";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("support.routes.admin.operationsRequestDetail.request.failed");
}

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createSupportRequestRequestApiClient(request);
  return {
    supportRequest: await api.getSupportOperationsRequest(params.id ?? ""),
    marketplaceOrigin: resolveSupportRequestsMarketplaceOrigin(),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const supportRequestId = params.id ?? "";
  const api = createSupportRequestRequestApiClient(request);
  const formData = await request.formData();
  const intent = formValue(formData, "intent");

  try {
    if (intent === "note") {
      await api.recordSupportOperationsNote(supportRequestId, {
        summary: formValue(formData, "summary"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=note`);
    }

    if (intent === "response") {
      await api.recordSupportOperationsResponse(supportRequestId, {
        responseType: formValue(formData, "responseType"),
        summary: formValue(formData, "summary"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=response`);
    }

    if (intent === "escalate") {
      await api.escalateSupportOperationsRequest(supportRequestId, {
        reason: formValue(formData, "reason"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=escalate`);
    }

    if (intent === "resolve") {
      await api.resolveSupportOperationsRequest(supportRequestId, {
        resolutionType: formValue(formData, "resolutionType"),
        summary: formValue(formData, "summary"),
        refundAmount: formValue(formData, "refundAmount") || null,
      });
      return redirect(`/support/requests/${supportRequestId}?action=resolve`);
    }

    if (intent === "close") {
      await api.closeSupportOperationsRequest(supportRequestId);
      return redirect(`/support/requests/${supportRequestId}?action=close`);
    }

    if (intent === "cancel") {
      await api.cancelSupportOperationsRequest(supportRequestId, {
        reason: formValue(formData, "reason"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=cancel`);
    }

    return null;
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.supportRequest
      ? t("support.routes.admin.operationsRequestDetail.meta.title", {
          id: data.supportRequest.support_request_id,
        })
      : t("support.routes.admin.operationsQueue.meta.title"),
  },
];

export default function SupportOperationsRequestDetailRoute() {
  const { supportRequest, marketplaceOrigin } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  return (
    <SupportOperationsDetailPage
      request={supportRequest}
      actionError={actionData?.error ?? null}
      actionResult={searchParams.get("action")}
      marketplaceOrigin={marketplaceOrigin}
    />
  );
}
