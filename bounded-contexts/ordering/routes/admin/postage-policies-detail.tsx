import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { loadAfterWrite, navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { OrderingApiError, createOrderingRequestApiClient } from "../../support/request-support/api-client";
import { PostagePolicyDetailPage } from "../../features/postage-policies/ui/postage-policy-detail-page";
import {
  postagePolicyPreviewRequestFromForm,
  postagePolicyRequestFromForm,
} from "../../features/postage-policies/ui/form-data";

function postagePolicyPreparingResponse() {
  return new Response("We are preparing this postage policy. Refresh in a moment and it should appear.", {
    status: 503,
    statusText: "Preparing postage policy",
  });
}

function postagePolicyNotFoundResponse() {
  return new Response(t("ordering.routes.admin.postagePoliciesDetail.not.found"), { status: 404 });
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  if (!params.id) {
    throw postagePolicyNotFoundResponse();
  }
  const api = createOrderingRequestApiClient(request);
  const policyRead = await loadAfterWrite({
    request,
    load: () => api.getPostagePolicy(params.id!),
    isNotFound: (error) => error instanceof OrderingApiError && error.status === 404,
  });
  if (policyRead.kind === "pending") {
    throw postagePolicyPreparingResponse();
  }
  if (policyRead.kind === "permanent-failure") {
    if ("error" in policyRead && policyRead.error instanceof OrderingApiError && policyRead.error.status === 404) {
      throw postagePolicyNotFoundResponse();
    }

    throw "error" in policyRead
      ? policyRead.error
      : new Response("Postage policy handoff is no longer valid.", { status: 410 });
  }

  return policyRead.data;
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
      return redirect(navigateAfterWrite(result, `/commerce/postage-policies/${result.id}`));
    } else if (intent === "preview") {
      return { preview: await api.previewPostagePolicy(postagePolicyPreviewRequestFromForm(formData)) };
    } else {
      result = await api.revisePostagePolicy(params.id, postagePolicyRequestFromForm(formData));
    }
    return redirect(navigateAfterWrite(result, `/commerce/postage-policies/${params.id}`));
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
