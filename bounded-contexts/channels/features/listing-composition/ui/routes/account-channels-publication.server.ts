import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { LoaderFunctionArgs } from "react-router";
import { createChannelsPublicationRequestApiClient } from "../../api/request-client";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireActorFromAuthApi({ request, permission: "channels.view" });
  return { connections: await createChannelsPublicationRequestApiClient(request).listConnections() };
};
