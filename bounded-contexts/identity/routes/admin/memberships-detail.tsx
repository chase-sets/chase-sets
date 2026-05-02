import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
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

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.membershipsDetail.membership.detail.identity.admin") }];

export default function MembershipDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <MembershipDetailPage data={data.data} />;
}

