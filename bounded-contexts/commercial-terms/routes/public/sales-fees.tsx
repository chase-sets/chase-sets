import { PublicHelpArticlePage } from "@chase-sets/public-presence/web";
import { findPublicHelpArticleByPath, resolvePublicPolicyArticle } from "@chase-sets/public-presence/server";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

const SALES_FEES_PATH = "/sales-fees";

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? `${data.article.title} | Chase Sets` : "Marketplace fees | Chase Sets" },
  ...(data ? [{ name: "description", content: data.article.description }] : []),
];

export async function loader({ request }: LoaderFunctionArgs) {
  const source = findPublicHelpArticleByPath(SALES_FEES_PATH);
  if (!source) throw new Error("The compiled sales-fees article is unavailable.");
  const article = await resolvePublicPolicyArticle(request, source, SALES_FEES_PATH);
  return { article, related: [] };
}

export function headers() {
  return { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=60" };
}

export default function SalesFeesRoute() {
  return <PublicHelpArticlePage {...useLoaderData<typeof loader>()} />;
}
