import { AdminSectionLayout } from "../admin-section-layout";
import { createAdminSectionLoader } from "../admin-section-loader.server";

const config = {
  section: "catalog",
  brand: "Catalog",
  fallbackPermission: "catalog.view",
  defaultActiveKey: "dimensions",
  activeKeys: {
    "reference-types": "reference-records",
    // The integrations surfaces are real nested routes under one "Integrations"
    // nav group; map each to its child key so the side nav highlights and expands
    // the active child (the base route is the Import child).
    integrations: "integrations-import",
    // The Settings nav child is the canonical path; the pre-existing governance
    // path stays registered (old bookmarks/evidence links) and highlights the
    // same nav child since it renders the identical surface.
    "integrations/settings": "integrations-settings",
    "integrations/governance": "integrations-settings",
    "integrations/health": "integrations-health",
  },
} as const;

export const loader = createAdminSectionLoader(config);

export default function CatalogAdminLayoutRoute() {
  return <AdminSectionLayout config={config} />;
}
