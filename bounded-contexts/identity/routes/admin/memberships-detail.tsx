import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import type { Membership } from "../../support/request-support/api-client";
import { MembershipDetailPage } from "../../features/memberships/ui/membership-detail-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return {
    id: params.id!,
    data: await api.getMembership<Membership>(params.id!),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const membershipId = params.id!;
  let result: unknown = null;

  if (intent === "change-role") {
    result = await api.changeMembershipRole(membershipId, String(formData.get("roleKey") ?? ""));
  }

  if (intent === "revoke") {
    result = await api.revokeMembership(membershipId);
  }

  if (intent === "reinstate") {
    result = await api.reinstateMembership(membershipId);
  }

  return redirect(appendFreshWriteToken(`/access/memberships/${membershipId}`, result));
}

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.membershipsDetail.membership.detail.identity.admin") },
];

export default function MembershipDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <MembershipDetailPage data={data.data} />;
}
