import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { UserListPage, type User } from "@chase-sets/identity/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createIdentityRequestApiClient } from "../../client";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return api.listUsers<ListResponse<User>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: "Users | Identity Admin" }];

export default function UsersRoute() {
  const data = useLoaderData<typeof loader>();
  return <UserListPage initialData={data} />;
}

