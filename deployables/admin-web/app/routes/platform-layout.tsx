import { AdminSectionLayout } from "../admin-section-layout";
import { createAdminSectionLoader } from "../admin-section-loader.server";

const config = {
  section: "platform",
  brand: "Platform",
  fallbackPermission: "security.manage",
  defaultActiveKey: "projection-operations",
  activeKeys: {
    projections: "projection-operations",
    "release-dashboard": "release-dashboard",
    "release-controls": "release-controls",
  },
} as const;

export const loader = createAdminSectionLoader(config);

export default function PlatformLayoutRoute() {
  return <AdminSectionLayout config={config} />;
}
