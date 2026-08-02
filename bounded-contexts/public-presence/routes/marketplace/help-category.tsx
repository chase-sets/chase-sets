import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { isHelpCategory, listHelpArticlesByCategory } from "../../features/help/ui/help-route-data";
import { HelpCategoryPage, helpCategoryLabel } from "../../features/help/ui/help-pages";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export function loader({ params }: LoaderFunctionArgs) {
  if (!isHelpCategory(params.category)) {
    throw new Response(t("publicPresence.help.notFound"), { status: 404 });
  }
  const articles = listHelpArticlesByCategory(params.category);
  if (articles.length === 0) {
    throw new Response(t("publicPresence.help.notFound"), { status: 404 });
  }
  return {
    category: params.category,
    articles: articles.map(({ audience, title, description, href }) => ({ audience, title, description, href })),
  };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: t("publicPresence.help.notFound") }];
  return [
    { title: t("publicPresence.help.category.meta.title", { category: helpCategoryLabel(data.category) }) },
    {
      name: "description",
      content: t("publicPresence.help.category.meta.description", { category: helpCategoryLabel(data.category) }),
    },
  ];
};

export { headers } from "./help";

export default function HelpCategoryRoute() {
  const data = useLoaderData<typeof loader>();
  return <HelpCategoryPage {...data} />;
}
