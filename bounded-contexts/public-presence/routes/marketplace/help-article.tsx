import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  findHelpArticle,
  listRelatedHelpArticles,
  resolveArticlePolicyValues,
} from "../../features/help/ui/help-route-data";
import { HelpArticlePage } from "../../features/help/ui/help-pages";
import { loadPublicPolicyValues } from "../../features/help/integrations/public-policy-values-client";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const source = findHelpArticle(params.category, params.slug);
  if (!source) {
    throw new Response(t("publicPresence.help.notFound"), { status: 404 });
  }
  // Token-bearing articles resolve their whitelisted live policy values at
  // render, exactly like the /sales-fees composition; token-free articles
  // stay read-free.
  const article =
    source.policyValueKeys.length > 0
      ? resolveArticlePolicyValues(source, await loadPublicPolicyValues(request))
      : source;
  return { article, related: listRelatedHelpArticles(source) };
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
