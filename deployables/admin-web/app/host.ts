import { resolveWebHostNavItems } from "@chase-sets/platform-runtime/web";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { resolveWebHostRouteConfigRecords } from "@chase-sets/platform-runtime/web-route-config";
import type { NavigationItem } from "@chase-sets/design-system";
import { webContextRegistry } from "./generated/web-context-registry";

const adminSectionLabels: Record<WebHostSection, string> = {
  access: "Access",
  catalog: "Catalog",
  commerce: "Commerce",
  growth: "Growth",
  support: "Support",
  platform: "Platform",
};

const adminSectionIcons: Record<WebHostSection, NavigationItem["icon"]> = {
  access: "shield",
  catalog: "package",
  commerce: "dollar",
  growth: "rocket",
  support: "help",
  platform: "dashboard",
};

const adminSections: readonly WebHostSection[] = ["access", "catalog", "commerce", "growth", "support", "platform"];

const adminSectionHrefs: Record<WebHostSection, string> = {
  access: "/access",
  catalog: "/catalog",
  commerce: "/commerce",
  growth: "/growth",
  support: "/support",
  platform: "/platform",
};

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

    if (sectionNavItems.length === 0) {
      return [];
    }

    return [
      {
        key: section,
        label: adminSectionLabels[section],
        icon: adminSectionIcons[section],
        href: adminSectionHrefs[section],
      },
    ];
  });
}
