import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
import type { Membership } from "../../support/request-support/api-client";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const membership = await api.getMembership<Membership>(params.id!);
  return redirect(
    `/access/accounts/${membership.account_id}?tab=team&membership=${encodeURIComponent(membership.membership_id)}`,
  );
}

const membershipDestination = (id: string) => `/access/memberships/${id}`;

export const action = defineFormAction({
  intents: {
    "change-role": async ({ request, params, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).changeMembershipRole(
          params.id!,
          String(formData.get("roleKey") ?? ""),
        ),
        membershipDestination(params.id!),
      ),
    revoke: async ({ request, params }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).revokeMembership(params.id!),
        membershipDestination(params.id!),
      ),
    reinstate: async ({ request, params }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).reinstateMembership(params.id!),
        membershipDestination(params.id!),
      ),
  },
  onUnknownIntent: ({ params }) => formActionRedirect(null, membershipDestination(params.id!)),
});

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.membershipsDetail.membership.detail.identity.admin") },
];

export default function MembershipDetailRoute() {
  return null;
}
