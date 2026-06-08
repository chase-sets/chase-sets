import { createAdminSectionHomeLoader } from "../admin-section-loader.server";

export const loader = createAdminSectionHomeLoader({ section: "platform", fallbackPermission: "security.manage" });

export default function PlatformHomeRoute() {
  return null;
}
