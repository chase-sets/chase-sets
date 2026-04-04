import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { UserDetailPage, type User } from "@chase-sets/identity/web";
import { createIdentityRequestApiClient } from "../../client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return {
    id: params.id!,
    data: await api.getUser<User>(params.id!),
  };
}

export const meta: MetaFunction = () => [{ title: "User Detail | Identity Admin" }];

export default function UserDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <UserDetailPage data={data.data} />;
}

