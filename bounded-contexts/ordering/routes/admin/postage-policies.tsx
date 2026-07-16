import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  defineFormAction,
  defineResourceRoute,
  navigateAfterWrite,
  readOffsetPageParams,
} from "@chase-sets/platform-runtime/http";
import { OrderingApiError, createOrderingRequestApiClient } from "../../support/request-support/api-client";
import { PostagePolicyListPage } from "../../features/postage-policies/ui/postage-policy-list-page";
import {
  postagePolicyPreviewRequestFromForm,
  postagePolicyRequestFromForm,
} from "../../features/postage-policies/ui/form-data";
import contextManifest from "../../context.json";
import { orderingApiErrorAdapter } from "../../support/request-support/route-api-error";

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "ordering-postage-policies",
  errorAdapter: orderingApiErrorAdapter,
  load: async ({ request }) => {
    const api = createOrderingRequestApiClient(request);
    const selectedPolicyId = new URL(request.url).searchParams.get("policy");
    const [policies, selectedPolicy] = await Promise.all([
      api.listPostagePolicies(readOffsetPageParams(request).query),
      selectedPolicyId ? api.getPostagePolicy(selectedPolicyId) : Promise.resolve(null),
    ]);
    return { policies, selectedPolicy };
  },
  map: ({ policies, selectedPolicy }, { request }) => {
    const page = readOffsetPageParams(request);
    return {
      ...policies,
      selectedPolicy,
      pagination: { limit: page.limit, offset: page.offset, total: policies.total },
    };
  },
  messages: {
    pending: "We are preparing postage policies. Refresh in a moment and the draft should appear.",
    pendingStatusText: "Preparing postage policies",
    unverified: "Postage policy handoff is no longer valid.",
  },
});

function postagePolicyDestination(policyId: string) {
  const searchParams = new URLSearchParams({ policy: policyId });
  return `/commerce/postage-policies?${searchParams.toString()}`;
}

function policyIdFromForm(formData: FormData) {
  const policyId = String(formData.get("policyId") ?? "").trim();
  if (!policyId) {
    throw new Response(t("ordering.routes.admin.postagePoliciesDetail.not.found"), { status: 404 });
  }
  return policyId;
}

export const action = defineFormAction({
  defaultIntent: "create",
  intents: {
    create: async ({ request, formData }) => {
      const result = await createOrderingRequestApiClient(request).createPostagePolicy(
        postagePolicyRequestFromForm(formData),
      );
      return redirect(navigateAfterWrite(result, postagePolicyDestination(result.id)));
    },
    activate: async ({ request, formData }) => {
      const policyId = policyIdFromForm(formData);
      const result = await createOrderingRequestApiClient(request).activatePostagePolicy(
        policyId,
        String(formData.get("activationReason") ?? ""),
      );
      return redirect(navigateAfterWrite(result, postagePolicyDestination(policyId)));
    },
    retire: async ({ request, formData }) => {
      const policyId = policyIdFromForm(formData);
      const result = await createOrderingRequestApiClient(request).retirePostagePolicy(
        policyId,
        String(formData.get("retirementReason") ?? ""),
      );
      return redirect(navigateAfterWrite(result, postagePolicyDestination(policyId)));
    },
    clone: async ({ request, formData }) => {
      const policyId = policyIdFromForm(formData);
      const result = await createOrderingRequestApiClient(request).clonePostagePolicy(policyId, {
        label: String(formData.get("cloneLabel") ?? ""),
        effectiveFrom: String(formData.get("cloneEffectiveFrom") ?? ""),
        effectiveUntil: String(formData.get("cloneEffectiveUntil") ?? ""),
      });
      return redirect(navigateAfterWrite(result, postagePolicyDestination(result.id)));
    },
    preview: async ({ request, formData }) => ({
      preview: await createOrderingRequestApiClient(request).previewPostagePolicy(
        postagePolicyPreviewRequestFromForm(formData),
      ),
    }),
    revise: async ({ request, formData }) => {
      const policyId = policyIdFromForm(formData);
      const result = await createOrderingRequestApiClient(request).revisePostagePolicy(
        policyId,
        postagePolicyRequestFromForm(formData),
      );
      return redirect(navigateAfterWrite(result, postagePolicyDestination(policyId)));
    },
  },
  onError: (error) => {
    if (error instanceof OrderingApiError || error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  },
});

export const meta: MetaFunction = () => [{ title: t("ordering.routes.admin.postagePolicies.title") }];

export default function PostagePoliciesRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <PostagePolicyListPage
      items={data.items}
      selectedPolicy={data.selectedPolicy}
      previewResult={actionData && "preview" in actionData ? actionData.preview.packagePlan : null}
      pagination={data.pagination}
      errorMessage={actionData && "error" in actionData ? actionData.error : null}
    />
  );
}
