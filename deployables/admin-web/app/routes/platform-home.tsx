import { createAdminSectionHomeLoader } from "../admin-section-loader.server";

export const loader = createAdminSectionHomeLoader({
  section: "platform",
  fallbackPermission: "projection-operations.view",
});

export default function PlatformHomeRoute() {
  return null;
}
