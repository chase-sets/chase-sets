import { resolveWebHostNavItems } from "@chase-sets/platform-runtime/web";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { resolveWebHostRouteConfigRecords } from "@chase-sets/platform-runtime/web-route-config";
import type { NavigationItem } from "@chase-sets/design-system";
import { webContextRegistry } from "./context-registry";

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

function withAdminSectionPrefix(pathname: string, section: WebHostSection) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `/${section}${normalizedPath}`.replace(/\/+/g, "/");
}

function isSameRouteFamily(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

type ShellContributionHrefCandidate = Readonly<{
  href?: string;
  requiredPermissions: readonly string[];
  children?: readonly ShellContributionHrefCandidate[];
}>;

function shellContributionHrefCandidates(
  contribution: ShellContributionHrefCandidate,
  section: WebHostSection,
  defaultPermission: string,
): readonly Readonly<{ href: string; permission: string }>[] {
  const ownCandidate =
    contribution.href && contribution.requiredPermissions.length > 0
      ? [
          {
            href: withAdminSectionPrefix(contribution.href, section),
            permission: contribution.requiredPermissions[0] ?? defaultPermission,
          },
        ]
      : [];

  return [
    ...ownCandidate,
    ...(contribution.children ?? []).flatMap((child) =>
      shellContributionHrefCandidates(child, section, defaultPermission),
    ),
  ];
}

export function resolveAdminWebRouteFallbackPermission(
  section: WebHostSection,
  pathname: string,
  defaultPermission: string,
) {
  const sectionPrefix = `/${section}`;
  const sectionPath = pathname.startsWith(sectionPrefix) ? pathname : withAdminSectionPrefix(pathname, section);
  const matches = webContextRegistry.flatMap((entry) =>
    (entry.manifest.shellContributions ?? [])
      .filter((contribution) => contribution.deployable === "admin-web")
      .filter((contribution) => contribution.slot === "primary-nav")
      .filter((contribution) => contribution.section === section)
      .flatMap((contribution) => shellContributionHrefCandidates(contribution, section, defaultPermission))
      .filter((candidate) => isSameRouteFamily(sectionPath, candidate.href)),
  );

  return matches.sort((left, right) => right.href.length - left.href.length)[0]?.permission ?? defaultPermission;
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
