import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { ChannelPublicationListPage } from "../../features/listing-composition/ui/publication-pages";
import { createChannelsPublicationRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "channels.view" });
  return { connections: await createChannelsPublicationRequestApiClient(request).listConnections() };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("channels.publication.meta.title"),
    description: t("channels.publication.meta.description"),
  });

export default function AccountChannelsPublicationRoute() {
  const data = useLoaderData<typeof loader>();
  return <ChannelPublicationListPage state={{ kind: "ready", connections: data.connections }} />;
}
