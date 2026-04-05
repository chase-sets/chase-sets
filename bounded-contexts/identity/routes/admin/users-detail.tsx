import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { User } from "../../request-support/api-client";
import { UserDetailPage } from "../../users/ui/user-detail-page";
import { createIdentityRequestApiClient } from "../../route-support/identity-request";

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

