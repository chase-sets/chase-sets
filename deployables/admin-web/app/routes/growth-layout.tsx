import { AdminSectionLayout } from "../admin-section-layout";
import { createAdminSectionLoader } from "../admin-section-loader.server";

const config = {
  section: "growth",
  brand: "Growth",
  fallbackPermission: "google-shopping.view",
  defaultActiveKey: "google-shopping",
  activeKeys: {
    "google-shopping": "google-shopping",
    waitlist: "waitlist",
    "promo-bar": "promo-bar",
  },
} as const;

export const loader = createAdminSectionLoader(config);

export default function GrowthLayoutRoute() {
  return <AdminSectionLayout config={config} />;
}
