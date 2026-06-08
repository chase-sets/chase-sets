import { AdminSectionLayout } from "../admin-section-layout";
import { createAdminSectionLoader } from "../admin-section-loader.server";

const config = {
  section: "commerce",
  brand: "Commerce",
  fallbackPermission: "commercial-terms.view",
  defaultActiveKey: "commercial-terms",
  activeKeys: {
    terms: "commercial-terms",
    "postage-policies": "postage-policies",
  },
} as const;

export const loader = createAdminSectionLoader(config);

export default function CommerceLayoutRoute() {
  return <AdminSectionLayout config={config} />;
}
