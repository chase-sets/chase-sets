import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { SessionDetailPage, type Session } from "@chase-sets/identity/web";
import { createIdentityServerApiClient } from "../api.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityServerApiClient(request);
  return {
    id: params.id!,
    data: await api.getSession<Session>(params.id!),
  };
}

export const meta: MetaFunction = () => [{ title: "Session Detail | Identity Admin" }];

export default function SessionDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <SessionDetailPage data={data.data} />;
}
