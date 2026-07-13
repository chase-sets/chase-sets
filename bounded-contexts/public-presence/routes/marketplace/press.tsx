import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { findPublicHelpArticleByPath, resolveArticlePolicyValues } from "../../features/help/ui/help-route-data";
import { loadPublicPolicyValues } from "../../features/help/integrations/public-policy-values-client";
import { HelpArticlePage } from "../../features/help/ui/help-pages";
import { buildPublicSocialMeta, publicOpenGraphImages } from "../../features/waitlist/ui/social-meta";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

const PRESS_PATH = "/press";

export async function loader({ request }: LoaderFunctionArgs) {
  const source = findPublicHelpArticleByPath(PRESS_PATH);
  if (!source) throw new Error("The compiled creator and press fact sheet is unavailable.");
  // The fee facts on the sheet are live policy tokens, resolved exactly like
  // the /sales-fees composition so quoted numbers can never go stale.
  const article = resolveArticlePolicyValues(source, await loadPublicPolicyValues(request));
  return {
    article,
    related: [],
    publicOrigin: process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin,
  };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const title = data ? `${data.article.title} | ${t("publicPresence.brand")}` : t("publicPresence.brand");
  const description = data?.article.description ?? "";
  return [
    { title },
    ...(data ? [{ name: "description", content: description }] : []),
    ...buildPublicSocialMeta({
      publicOrigin: data?.publicOrigin ?? "https://chasesets.com",
      path: PRESS_PATH,
      title,
      description,
      imagePath: publicOpenGraphImages.default,
    }),
  ];
};

export function headers() {
  return { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=60" };
}

export default function PressRoute() {
  const data = useLoaderData<typeof loader>();
  return <HelpArticlePage article={data.article} related={data.related} />;
}
