import { AdminSectionLayout } from "../admin-section-layout";
import { createAdminSectionLoader } from "../admin-section-loader.server";

const config = {
  section: "platform",
  brand: "Platform",
  fallbackPermission: "projection-operations.view",
  defaultActiveKey: "projection-operations",
  activeKeys: {
    projections: "projection-operations",
  },
} as const;

export const loader = createAdminSectionLoader(config);

export default function PlatformLayoutRoute() {
  return <AdminSectionLayout config={config} />;
}
