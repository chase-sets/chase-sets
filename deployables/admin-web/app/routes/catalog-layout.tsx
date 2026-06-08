import { AdminSectionLayout } from "../admin-section-layout";
import { createAdminSectionLoader } from "../admin-section-loader.server";

const config = {
  section: "catalog",
  brand: "Catalog",
  fallbackPermission: "catalog.view",
  defaultActiveKey: "dimensions",
  activeKeys: {
    "reference-types": "reference-records",
  },
} as const;

export const loader = createAdminSectionLoader(config);

export default function CatalogAdminLayoutRoute() {
  return <AdminSectionLayout config={config} />;
}
