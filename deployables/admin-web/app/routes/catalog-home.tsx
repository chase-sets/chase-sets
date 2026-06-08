import { createAdminSectionHomeLoader } from "../admin-section-loader.server";

export const loader = createAdminSectionHomeLoader({ section: "catalog", fallbackPermission: "catalog.view" });

export default function CatalogHomeRoute() {
  return null;
}
