import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  findDeveloperArticle,
  developerPortalResponseHeaders,
  developerPortalRobotsMeta,
  requireDeveloperPortalReady,
} from "../../features/developer-portal/ui/developer-route-data";
import { DeveloperArticlePage } from "../../features/developer-portal/ui/developer-pages";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export function loader({ params }: LoaderFunctionArgs) {
  requireDeveloperPortalReady();
  const article = findDeveloperArticle(params.slug);
  if (!article) throw new Response(t("publicPresence.developers.notFound"), { status: 404 });
  return { article };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data
      ? t("publicPresence.developers.article.meta.title", { title: data.article.title })
      : t("publicPresence.developers.notFound"),
  },
  ...(data ? [{ name: "description", content: data.article.description }] : []),
  developerPortalRobotsMeta,
];

export function headers() {
  return developerPortalResponseHeaders;
}

export default function DeveloperArticleRoute() {
  const data = useLoaderData<typeof loader>();
  return <DeveloperArticlePage {...data} />;
}
