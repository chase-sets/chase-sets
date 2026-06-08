import { createAdminSectionHomeLoader } from "../admin-section-loader.server";

export const loader = createAdminSectionHomeLoader({ section: "growth", fallbackPermission: "google-shopping.view" });

export default function GrowthHomeRoute() {
  return null;
}
