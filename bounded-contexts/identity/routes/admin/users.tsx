import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { User } from "../../request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { UserListPage } from "../../users/ui/user-list-page";
import { createIdentityRequestApiClient } from "../../route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return api.listUsers<ListResponse<User>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: "Users | Identity Admin" }];

export default function UsersRoute() {
  const data = useLoaderData<typeof loader>();
  return <UserListPage initialData={data} />;
}

