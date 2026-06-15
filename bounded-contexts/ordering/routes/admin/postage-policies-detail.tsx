import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { appendFreshWriteToken, loadFreshlyWrittenResource } from "@chase-sets/http/responses";
import { OrderingApiError, createOrderingRequestApiClient } from "../../support/request-support/api-client";
import { PostagePolicyDetailPage } from "../../features/postage-policies/ui/postage-policy-detail-page";
import {
  postagePolicyPreviewRequestFromForm,
  postagePolicyRequestFromForm,
} from "../../features/postage-policies/ui/form-data";

export async function loader({ params, request }: LoaderFunctionArgs) {
  if (!params.id) {
    throw new Response(t("ordering.routes.admin.postagePoliciesDetail.not.found"), { status: 404 });
  }
  const api = createOrderingRequestApiClient(request);
  return loadFreshlyWrittenResource({
    request,
    load: () => api.getPostagePolicy(params.id!),
    isNotFound: (error) => error instanceof OrderingApiError && error.status === 404,
  });
}

export async function action({ params, request }: ActionFunctionArgs) {
  if (!params.id) {
    throw new Response(t("ordering.routes.admin.postagePoliciesDetail.not.found"), { status: 404 });
  }
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "revise");
  const api = createOrderingRequestApiClient(request);

  try {
    let result: { id: string; version: number } | null = null;
    if (intent === "activate") {
      result = await api.activatePostagePolicy(params.id, String(formData.get("activationReason") ?? ""));
    } else if (intent === "retire") {
      result = await api.retirePostagePolicy(params.id, String(formData.get("retirementReason") ?? ""));
    } else if (intent === "clone") {
      const result = await api.clonePostagePolicy(params.id, {
        label: String(formData.get("cloneLabel") ?? ""),
        effectiveFrom: String(formData.get("cloneEffectiveFrom") ?? ""),
        effectiveUntil: String(formData.get("cloneEffectiveUntil") ?? ""),
      });
      return redirect(appendFreshWriteToken(`/commerce/postage-policies/${result.id}`, result));
    } else if (intent === "preview") {
      return { preview: await api.previewPostagePolicy(postagePolicyPreviewRequestFromForm(formData)) };
    } else {
      result = await api.revisePostagePolicy(params.id, postagePolicyRequestFromForm(formData));
    }
    return redirect(appendFreshWriteToken(`/commerce/postage-policies/${params.id}`, result));
  } catch (error) {
    if (error instanceof OrderingApiError || error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: t("ordering.routes.admin.postagePoliciesDetail.title", {
      label: data?.label ?? t("ordering.routes.admin.postagePoliciesDetail.fallback.title"),
    }),
  },
];

export default function PostagePolicyDetailRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <PostagePolicyDetailPage
      policy={data}
      previewResult={"preview" in (actionData ?? {}) ? actionData?.preview?.packagePlan : null}
      errorMessage={actionData && "error" in actionData ? actionData.error : null}
    />
  );
}
