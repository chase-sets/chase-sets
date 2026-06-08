import { createAdminSectionHomeLoader } from "../admin-section-loader.server";

export const loader = createAdminSectionHomeLoader({ section: "access", fallbackPermission: "accounts.view" });

export default function AccessHomeRoute() {
  return null;
}
