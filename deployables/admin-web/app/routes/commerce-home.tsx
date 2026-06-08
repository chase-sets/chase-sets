import { createAdminSectionHomeLoader } from "../admin-section-loader.server";

export const loader = createAdminSectionHomeLoader({
  section: "commerce",
  fallbackPermission: "commercial-terms.view",
});

export default function CommerceHomeRoute() {
  return null;
}
