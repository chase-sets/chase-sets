import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";

function postagePolicyNotFoundResponse() {
  return new Response(t("ordering.routes.admin.postagePoliciesDetail.not.found"), { status: 404 });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (!params.id) throw postagePolicyNotFoundResponse();

  const source = new URL(request.url);
  const searchParams = new URLSearchParams(source.search);
  searchParams.set("policy", params.id);
  return redirect(`/commerce/postage-policies?${searchParams.toString()}`);
}

export const meta: MetaFunction = () => [{ title: t("ordering.routes.admin.postagePolicies.title") }];

export default function PostagePolicyDetailRedirectRoute() {
  return null;
}
