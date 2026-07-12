import type { MetaFunction } from "react-router";
import { HelpHubPage } from "../../features/help/ui/help-pages";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export const meta: MetaFunction = () => [
  { title: t("publicPresence.help.meta.title") },
  { name: "description", content: t("publicPresence.help.meta.description") },
];

export function headers() {
  return { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=60" };
}

export default HelpHubPage;
