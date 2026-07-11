import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { loadAfterWrite, navigateAfterWrite, readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import { OrderingApiError, createOrderingRequestApiClient } from "../../support/request-support/api-client";
import { PostagePolicyListPage } from "../../features/postage-policies/ui/postage-policy-list-page";
import { postagePolicyRequestFromForm } from "../../features/postage-policies/ui/form-data";

function postagePoliciesPreparingResponse() {
  return new Response("We are preparing postage policies. Refresh in a moment and the draft should appear.", {
    status: 503,
    statusText: "Preparing postage policies",
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createOrderingRequestApiClient(request);
  const page = readOffsetPageParams(request);
  const policiesRead = await loadAfterWrite({
    request,
    load: () => api.listPostagePolicies(page.query),
    isNotFound: () => false,
  });
  if (policiesRead.kind === "pending") {
    throw postagePoliciesPreparingResponse();
  }
  if (policiesRead.kind === "permanent-failure") {
    throw "error" in policiesRead
      ? policiesRead.error
      : new Response("Postage policy handoff is no longer valid.", { status: 410 });
  }

  return {
    ...policiesRead.data,
    pagination: { limit: page.limit, offset: page.offset, total: policiesRead.data.total },
  };
}

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
