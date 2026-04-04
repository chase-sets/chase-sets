import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { createAuthRequestApiClient } from "../../client";
import { SessionListPage, type Session } from "../../web";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createAuthRequestApiClient(request);
  return api.listSessions<ListResponse<Session>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: "Sessions | Identity Admin" }];

export default function SessionsRoute() {
  const data = useLoaderData<typeof loader>();
  return <SessionListPage initialData={data} />;
}
