import { AdminSectionLayout } from "../admin-section-layout";
import { createAdminSectionLoader } from "../admin-section-loader.server";

const config = {
  section: "support",
  brand: "Support",
  fallbackPermission: "support.manage",
  defaultActiveKey: "support-requests",
  activeKeys: {
    requests: "support-requests",
    "platform-feedback": "platform-feedback",
  },
} as const;

export const loader = createAdminSectionLoader(config);

export default function SupportLayoutRoute() {
  return <AdminSectionLayout config={config} />;
}
