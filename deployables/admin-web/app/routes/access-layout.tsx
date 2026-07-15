import { AdminSectionLayout } from "../admin-section-layout";
import { createAdminSectionLoader } from "../admin-section-loader.server";

const config = {
  section: "access",
  brand: "Access",
  fallbackPermission: "accounts.view",
  defaultActiveKey: "access-home",
} as const;

export const loader = createAdminSectionLoader(config);

export default function AccessLayoutRoute() {
  return <AdminSectionLayout config={config} />;
}
