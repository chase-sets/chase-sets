import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { t } from "../localization/translator";
import { ChannelPublicationListPage } from "../publication-pages";
import type { loader } from "./account-channels-publication.server";

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("channels.publication.meta.title"),
    description: t("channels.publication.meta.description"),
  });

export default function AccountChannelsPublicationRoute() {
  const data = useLoaderData<typeof loader>();
  return <ChannelPublicationListPage state={{ kind: "ready", connections: data.connections }} />;
}
