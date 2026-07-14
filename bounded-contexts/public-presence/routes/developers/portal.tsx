import type { MetaFunction } from "react-router";
import {
  developerPortalResponseHeaders,
  developerPortalRobotsMeta,
  requireDeveloperPortalReady,
} from "../../features/developer-portal/ui/developer-route-data";
import { DeveloperPortalPage } from "../../features/developer-portal/ui/developer-pages";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export function loader() {
  requireDeveloperPortalReady();
  return null;
}

export const meta: MetaFunction = () => [
  { title: t("publicPresence.developers.meta.title") },
  { name: "description", content: t("publicPresence.developers.meta.description") },
  developerPortalRobotsMeta,
];

export function headers() {
  return developerPortalResponseHeaders;
}

export default DeveloperPortalPage;
