import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { User } from "../../support/request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { UserListPage } from "../../features/users/ui/user-list-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return api.listUsers<ListResponse<User>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.users.users.identity.admin") }];

export default function UsersRoute() {
  const data = useLoaderData<typeof loader>();
  return <UserListPage initialData={data} />;
}

