import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import type { Membership } from "../../support/request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { MembershipListPage } from "../../features/memberships/ui/membership-list-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";
import {
  IDENTITY_MEMBERSHIP_STATUSES,
  identityListQuery,
  readIdentityListFilters,
} from "../../support/route-support/list-filters";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const page = readOffsetPageParams(request);
  const filters = readIdentityListFilters(request, IDENTITY_MEMBERSHIP_STATUSES);
  const data = await api.listMemberships<ListResponse<Membership>>(identityListQuery(page.query, filters));
  return { ...data, limit: page.limit, offset: page.offset, filters };
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.memberships.memberships.identity.admin") }];

export default function MembershipsRoute() {
  const data = useLoaderData<typeof loader>();
  return <MembershipListPage initialData={data} filters={data.filters} />;
}
