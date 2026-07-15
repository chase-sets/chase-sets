import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { OrderingApiError, createOrderingRequestApiClient } from "../../support/request-support/api-client";
import { PostagePolicyDetailPage } from "../../features/postage-policies/ui/postage-policy-detail-page";
import contextManifest from "../../context.json";
import { orderingApiErrorAdapter } from "../../support/request-support/route-api-error";
import {
  postagePolicyPreviewRequestFromForm,
  postagePolicyRequestFromForm,
} from "../../features/postage-policies/ui/form-data";

function postagePolicyNotFoundResponse() {
  return new Response(t("ordering.routes.admin.postagePoliciesDetail.not.found"), { status: 404 });
}

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "ordering-postage-policies-detail",
  errorAdapter: orderingApiErrorAdapter,
  load: ({ request, params }) => {
    if (!params.id) throw postagePolicyNotFoundResponse();
    return createOrderingRequestApiClient(request).getPostagePolicy(params.id);
  },
  map: (policy) => policy,
  messages: {
    pending: "We are preparing this postage policy. Refresh in a moment and it should appear.",
    pendingStatusText: "Preparing postage policy",
    unverified: "Postage policy handoff is no longer valid.",
    notFound: t("ordering.routes.admin.postagePoliciesDetail.not.found"),
  },
});

const postagePolicyDestination = (id: string) => `/commerce/postage-policies/${id}`;

export const action = defineFormAction({
  defaultIntent: "revise",
  intents: {
    activate: async ({ params, request, formData }) => {
      if (!params.id) throw postagePolicyNotFoundResponse();
      return formActionRedirect(
        await createOrderingRequestApiClient(request).activatePostagePolicy(
          params.id,
          String(formData.get("activationReason") ?? ""),
        ),
        postagePolicyDestination(params.id),
      );
    },
    retire: async ({ params, request, formData }) => {
      if (!params.id) throw postagePolicyNotFoundResponse();
      return formActionRedirect(
        await createOrderingRequestApiClient(request).retirePostagePolicy(
          params.id,
          String(formData.get("retirementReason") ?? ""),
        ),
        postagePolicyDestination(params.id),
      );
    },
    clone: async ({ params, request, formData }) => {
      if (!params.id) throw postagePolicyNotFoundResponse();
      const result = await createOrderingRequestApiClient(request).clonePostagePolicy(params.id, {
        label: String(formData.get("cloneLabel") ?? ""),
        effectiveFrom: String(formData.get("cloneEffectiveFrom") ?? ""),
        effectiveUntil: String(formData.get("cloneEffectiveUntil") ?? ""),
      });
      return formActionRedirect(result, postagePolicyDestination(result.id));
    },
    preview: async ({ request, formData }) => ({
      preview: await createOrderingRequestApiClient(request).previewPostagePolicy(
        postagePolicyPreviewRequestFromForm(formData),
      ),
    }),
    revise: async ({ params, request, formData }) => {
      if (!params.id) throw postagePolicyNotFoundResponse();
      return formActionRedirect(
        await createOrderingRequestApiClient(request).revisePostagePolicy(
          params.id,
          postagePolicyRequestFromForm(formData),
        ),
        postagePolicyDestination(params.id),
      );
    },
  },
  onError: (error) => {
    if (error instanceof OrderingApiError || error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  },
});

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
      previewResult={actionData && "preview" in actionData ? actionData.preview.packagePlan : null}
      errorMessage={actionData && "error" in actionData ? actionData.error : null}
    />
  );
}
