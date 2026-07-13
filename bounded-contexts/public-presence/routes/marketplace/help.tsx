import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { HelpHubPage } from "../../features/help/ui/help-pages";
import { buildPublicSocialMeta, publicOpenGraphImages } from "../../features/waitlist/ui/social-meta";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export function loader({ request }: LoaderFunctionArgs) {
  // Social meta needs absolute URLs; mirror the home route's origin
  // resolution so a shared /help link renders the default brand OG card.
  return { publicOrigin: process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: t("publicPresence.help.meta.title") },
  { name: "description", content: t("publicPresence.help.meta.description") },
  ...buildPublicSocialMeta({
    publicOrigin: data?.publicOrigin ?? "https://chasesets.com",
    path: "/help",
    title: t("publicPresence.help.meta.title"),
    description: t("publicPresence.help.meta.description"),
    imagePath: publicOpenGraphImages.default,
  }),
];

export function headers() {
  return { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=60" };
}

export default HelpHubPage;
