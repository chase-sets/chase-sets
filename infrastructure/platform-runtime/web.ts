import type {
  BcDeployableContribution,
  BcRouteModule,
  BcShellContribution,
  BcShellContributionSlot,
  BcShellContributionVisibility,
} from "@chase-sets/bounded-context-module";
import type { NavigationItem } from "@chase-sets/design-system";

export type WebHostName = "admin-web" | "marketplace-web" | "public-web";
export type WebHostSection = "access" | "catalog" | "commerce" | "growth" | "support" | "platform";

export type WebContextManifest = Readonly<{
  contextName: string;
  deployableContributions?: readonly BcDeployableContribution[];
  shellContributions?: readonly (BcShellContribution &
    Readonly<{
      placements?: readonly BcShellContributionSlot[];
    }>)[];
}>;

export type WebContextRegistryEntry = Readonly<{
  contextName: string;
  packageName: string;
  manifest: WebContextManifest;
}>;

export type WebContextRegistry = readonly WebContextRegistryEntry[];

type ShellActor =
  | Readonly<{
      permissions?: readonly string[];
    }>
  | null
  | undefined;

export type WebHostRouteRecord = Readonly<
  Omit<BcRouteModule, "section"> & {
    contextName: string;
    section?: WebHostSection;
  }
>;

type ShellContributionRecord = Readonly<
  Omit<BcShellContribution, "section"> & {
    contextName: string;
    section?: WebHostSection;
  }
>;

const ADMIN_WEB_SECTIONS = [
  "access",
  "catalog",
  "commerce",
  "growth",
  "support",
  "platform",
] as const satisfies readonly WebHostSection[];
const catalogAdminMarker = ["catalog", "admin"].join("-");

function isWebHostSection(value: string): value is WebHostSection {
  return (ADMIN_WEB_SECTIONS as readonly string[]).includes(value);
}

function resolveAdminWebSection(
  contextName: string,
  fileExportOrKey?: string,
  explicitSection?: string,
): WebHostSection {
  if (explicitSection) {
    if (isWebHostSection(explicitSection)) {
      return explicitSection;
    }

    throw new Error(`Unknown admin-web section '${explicitSection}' for context '${contextName}'.`);
  }

  if (contextName === "catalog") {
    return "catalog";
  }

  if (fileExportOrKey?.includes(catalogAdminMarker)) {
    return "catalog";
  }

  if (contextName === "identity") {
    return "access";
  }

  if (contextName === "auth") {
    return "access";
  }

  if (contextName === "experience") {
    return "support";
  }

  if (contextName === "platform-operations") {
    return "platform";
  }

  if (contextName === "support") {
    return "support";
  }

  if (contextName === "discovery" && fileExportOrKey?.includes("google-shopping")) {
    return "growth";
  }

  if (contextName === "public-presence") {
    return "growth";
  }

  if (contextName === "commercial-terms") {
    return "commerce";
  }

  throw new Error(
    `Missing explicit admin-web section for context '${contextName}' route or shell contribution '${fileExportOrKey ?? "unknown"}'.`,
  );
}

function withPrefixedPath(pathname: string, prefix: string) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${prefix}${normalizedPath}`.replace(/\/+/g, "/");
}

function withPrefixedRoutePath(routePath: string, prefix: string) {
  if (routePath.length === 0) {
    return prefix.replace(/^\//, "");
  }

  return withPrefixedPath(routePath, prefix).replace(/^\//, "");
}

function resolveShellContributionPlacements(
  contribution: BcShellContribution & Readonly<{ placements?: readonly BcShellContributionSlot[] }>,
) {
  if (Array.isArray(contribution.placements) && contribution.placements.length > 0) {
    return contribution.placements;
  }

  return [contribution.slot];
}

function hasRequiredPermissions(actor: ShellActor, requiredPermissions: readonly string[]) {
  if (requiredPermissions.length === 0) {
    return true;
  }

  const grantedPermissions = actor?.permissions ?? [];
  return requiredPermissions.every((permission) => grantedPermissions.includes(permission));
}

function isVisibleForActor(
  actor: ShellActor,
  visibility: BcShellContributionVisibility,
  requiredPermissions: readonly string[],
) {
  if (visibility === "signed-in" && !actor) {
    return false;
  }

  if (visibility === "signed-out" && actor) {
    return false;
  }

  return hasRequiredPermissions(actor, requiredPermissions);
}

export function resolveWebHostRouteRecords(
  registry: WebContextRegistry,
  hostName: WebHostName,
): readonly WebHostRouteRecord[] {
  return registry.flatMap((entry) => {
    const manifest = entry.manifest as WebContextManifest;
    const contributions = manifest.deployableContributions ?? [];

    return contributions
      .filter((contribution) => contribution.deployable === hostName)
      .flatMap((contribution) =>
        contribution.routes.map((route) => {
          const { section: explicitSection, ...routeRecord } = route;

          if (hostName !== "admin-web") {
            return {
              ...routeRecord,
              contextName: entry.contextName,
            } satisfies WebHostRouteRecord;
          }

          const section = resolveAdminWebSection(entry.contextName, route.fileExport, explicitSection);
          const prefix = `/${section}`;

          return {
            ...routeRecord,
            routePath: withPrefixedRoutePath(route.routePath, prefix),
            contextName: entry.contextName,
            section,
          } satisfies WebHostRouteRecord;
        }),
      );
  });
}

export function resolveWebHostNavItems(
  registry: WebContextRegistry,
  hostName: WebHostName,
  slot: BcShellContributionSlot,
  actor?: ShellActor,
  options: Readonly<{
    section?: WebHostSection;
  }> = {},
): NavigationItem[] {
  const contributions: ShellContributionRecord[] = registry.flatMap((entry) => {
    const manifest = entry.manifest as WebContextManifest;

    return (manifest.shellContributions ?? [])
      .filter((contribution) => contribution.deployable === hostName)
      .flatMap((contribution) =>
        resolveShellContributionPlacements(contribution)
          .filter((placement) => placement === slot)
          .map((placement) => {
            const { section: explicitSection, ...contributionRecord } = contribution;

            if (hostName !== "admin-web") {
              return {
                ...contributionRecord,
                slot: placement,
                contextName: entry.contextName,
              } satisfies ShellContributionRecord;
            }

            const section = resolveAdminWebSection(entry.contextName, contribution.key, explicitSection);

            return {
              ...contributionRecord,
              slot: placement,
              href: withPrefixedPath(contribution.href, `/${section}`),
              contextName: entry.contextName,
              section,
            } satisfies ShellContributionRecord;
          }),
      );
  });

  return contributions
    .filter((contribution) => (options.section ? contribution.section === options.section : true))
    .filter((contribution) => isVisibleForActor(actor, contribution.visibility, contribution.requiredPermissions))
    .sort((left, right) =>
      left.order === right.order ? left.label.localeCompare(right.label) : left.order - right.order,
    )
    .map(({ key, label, icon, href }) => ({
      key,
      label,
      icon: icon as NavigationItem["icon"],
      href,
    }));
}

export function getWebHostSections(hostName: WebHostName): readonly WebHostSection[] {
  return hostName === "admin-web" ? ADMIN_WEB_SECTIONS : [];
}
