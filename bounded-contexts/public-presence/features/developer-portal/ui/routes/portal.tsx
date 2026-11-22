import type { MetaFunction } from "react-router";
import {
  developerPortalResponseHeaders,
  developerPortalRobotsMeta,
  requireDeveloperPortalReady,
} from "../developer-route-data";
import { DeveloperPortalPage } from "../developer-pages";
import { t } from "../localization/translator";

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
