import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { findHelpArticle, listRelatedHelpArticles } from "../../features/help/ui/help-route-data";
import { HelpArticlePage } from "../../features/help/ui/help-pages";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export function loader({ params }: LoaderFunctionArgs) {
  const article = findHelpArticle(params.category, params.slug);
  if (!article) {
    throw new Response(t("publicPresence.help.notFound"), { status: 404 });
  }
  return { article, related: listRelatedHelpArticles(article) };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: t("publicPresence.help.notFound") }];
  return [
    { title: t("publicPresence.help.article.meta.title", { title: data.article.title }) },
    { name: "description", content: data.article.description },
  ];
};

export { headers } from "./help";

export default function HelpArticleRoute() {
  const data = useLoaderData<typeof loader>();
  return <HelpArticlePage {...data} />;
}
