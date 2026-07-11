import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import type { User } from "../../support/request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { UserListPage } from "../../features/users/ui/user-list-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";
import {
  IDENTITY_USER_STATUSES,
  identityListQuery,
  readIdentityListFilters,
} from "../../support/route-support/list-filters";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const page = readOffsetPageParams(request);
  const filters = readIdentityListFilters(request, IDENTITY_USER_STATUSES);
  const data = await api.listUsers<ListResponse<User>>(identityListQuery(page.query, filters));
  return { ...data, limit: page.limit, offset: page.offset, filters };
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.users.users.identity.admin") }];

export default function UsersRoute() {
  const data = useLoaderData<typeof loader>();
  return <UserListPage initialData={data} filters={data.filters} />;
}
