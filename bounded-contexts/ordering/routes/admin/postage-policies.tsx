import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { defineResourceRoute, navigateAfterWrite, readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import { OrderingApiError, createOrderingRequestApiClient } from "../../support/request-support/api-client";
import { PostagePolicyListPage } from "../../features/postage-policies/ui/postage-policy-list-page";
import { postagePolicyRequestFromForm } from "../../features/postage-policies/ui/form-data";
import contextManifest from "../../context.json";
import { orderingApiErrorAdapter } from "../../support/request-support/route-api-error";

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "ordering-postage-policies",
  errorAdapter: orderingApiErrorAdapter,
  load: ({ request }) =>
    createOrderingRequestApiClient(request).listPostagePolicies(readOffsetPageParams(request).query),
  map: (policies, { request }) => {
    const page = readOffsetPageParams(request);
    return { ...policies, pagination: { limit: page.limit, offset: page.offset, total: policies.total } };
  },
  messages: {
    pending: "We are preparing postage policies. Refresh in a moment and the draft should appear.",
    pendingStatusText: "Preparing postage policies",
    unverified: "Postage policy handoff is no longer valid.",
  },
});

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createOrderingRequestApiClient(request);

  try {
    const result = await api.createPostagePolicy(postagePolicyRequestFromForm(formData));
    return redirect(navigateAfterWrite(result, `/commerce/postage-policies/${result.id}`));
  } catch (error) {
    if (error instanceof OrderingApiError || error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }
}

export const meta: MetaFunction = () => [{ title: t("ordering.routes.admin.postagePolicies.title") }];

export default function PostagePoliciesRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <PostagePolicyListPage items={data.items} pagination={data.pagination} errorMessage={actionData?.error ?? null} />
  );
}
