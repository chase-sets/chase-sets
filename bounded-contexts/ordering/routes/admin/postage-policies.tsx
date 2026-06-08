import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { OrderingApiError, createOrderingRequestApiClient } from "../../support/request-support/api-client";
import { PostagePolicyListPage } from "../../features/postage-policies/ui/postage-policy-list-page";
import { postagePolicyRequestFromForm } from "../../features/postage-policies/ui/form-data";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createOrderingRequestApiClient(request);
  return api.listPostagePolicies("limit=100&offset=0");
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createOrderingRequestApiClient(request);

  try {
    await api.createPostagePolicy(postagePolicyRequestFromForm(formData));
    return redirect("/commerce/postage-policies");
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
  return <PostagePolicyListPage items={data.items} errorMessage={actionData?.error ?? null} />;
}
