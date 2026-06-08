import { createAdminSectionHomeLoader } from "../admin-section-loader.server";

export const loader = createAdminSectionHomeLoader({ section: "support", fallbackPermission: "support.manage" });

export default function SupportHomeRoute() {
  return null;
}
