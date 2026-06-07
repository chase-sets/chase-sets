import { resolveWebHostNavItems } from "@chase-sets/platform-runtime/web";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { resolveWebHostRouteConfigRecords } from "@chase-sets/platform-runtime/web-route-config";
import type { NavigationItem } from "@chase-sets/design-system";
import { webContextRegistry } from "./generated/web-context-registry";

const adminSectionLabels: Record<WebHostSection, string> = {
  catalog: "Catalog",
  identity: "Identity",
  experience: "Experience",
  operations: "Operations",
  commercial: "Commercial Terms",
};

const adminSectionIcons: Record<WebHostSection, NavigationItem["icon"]> = {
  catalog: "package",
  identity: "users",
  experience: "message",
  operations: "dashboard",
  commercial: "dollar",
};

const adminSections: readonly WebHostSection[] = ["catalog", "identity", "experience", "operations", "commercial"];

export function resolveAdminWebRouteConfigRecords() {
  return resolveWebHostRouteConfigRecords(webContextRegistry, "admin-web");
}

export function resolveAdminWebNavItems(
  actor: Readonly<{ permissions?: readonly string[] }> | null | undefined,
  options: Readonly<{ section: WebHostSection }>,
) {
  return resolveWebHostNavItems(webContextRegistry, "admin-web", "primary-nav", actor, options);
}

export function resolveAdminWebSectionNavItems(
  actor: Readonly<{ permissions?: readonly string[] }> | null | undefined,
): NavigationItem[] {
  return adminSections.flatMap((section) => {
    const sectionNavItems = resolveAdminWebNavItems(actor, { section });
    const firstVisibleItem = sectionNavItems[0];

    if (!firstVisibleItem) {
      return [];
    }

    return [
      {
        key: section,
        label: adminSectionLabels[section],
        icon: adminSectionIcons[section],
        href: firstVisibleItem.href,
      },
    ];
  });
}
