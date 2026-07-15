import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import type { Membership } from "../../support/request-support/api-client";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const membership = await api.getMembership<Membership>(params.id!);
  return redirect(
    `/access/accounts/${membership.account_id}?tab=team&membership=${encodeURIComponent(membership.membership_id)}`,
  );
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

  return redirect(navigateAfterWrite(result, `/access/memberships/${membershipId}`));
}

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.membershipsDetail.membership.detail.identity.admin") },
];

export default function MembershipDetailRoute() {
  return null;
}
