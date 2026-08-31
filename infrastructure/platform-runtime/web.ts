import type {
  BcDeployableContribution,
  BcRouteModule,
  BcShellContribution,
  BcShellContributionItem,
  BcShellContributionSlot,
  BcShellContributionVisibility,
} from "@chase-sets/bounded-context-module";
import { t } from "@chase-sets/localization";
import type { NavigationItem } from "@chase-sets/design-system";
import { assertMarketplaceRouteContract } from "./portable-route-contract";

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
  Omit<BcShellContribution, "children" | "section"> & {
    contextName: string;
    section?: WebHostSection;
    children?: readonly ShellContributionItemRecord[];
  }
>;

type ShellContributionItemRecord = Readonly<
  Omit<BcShellContributionItem, "children"> & {
    contextName: string;
    section?: WebHostSection;
    children?: readonly ShellContributionItemRecord[];
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

function isWebHostSection(value: string): value is WebHostSection {
  return (ADMIN_WEB_SECTIONS as readonly string[]).includes(value);
}

function resolveAdminWebSection(
  contextName: string,
  fileExportOrKey?: string,
  explicitSection?: string,
): WebHostSection {
  if (!explicitSection) {
    throw new Error(
      `Missing explicit admin-web section for context '${contextName}' route or shell contribution '${fileExportOrKey ?? "unknown"}'.`,
    );
  }

  if (isWebHostSection(explicitSection)) {
    return explicitSection;
  }

  throw new Error(`Unknown admin-web section '${explicitSection}' for context '${contextName}'.`);
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

function sortShellContributionItems<T extends Pick<BcShellContributionItem, "label" | "order">>(
  items: readonly T[],
): T[] {
  return [...items].sort((left, right) =>
    left.order === right.order ? left.label.localeCompare(right.label) : left.order - right.order,
  );
}

function resolveShellContributionChildRecords(
  children: readonly BcShellContributionItem[] | undefined,
  contextName: string,
  section: WebHostSection | undefined,
): readonly ShellContributionItemRecord[] | undefined {
  if (!children?.length) {
    return undefined;
  }

  return sortShellContributionItems(children).map((child) => ({
    ...child,
    ...(child.href ? { href: section ? withPrefixedPath(child.href, `/${section}`) : child.href } : {}),
    contextName,
    section,
    children: resolveShellContributionChildRecords(child.children, contextName, section),
  }));
}

function filterShellContributionTree<T extends ShellContributionItemRecord>(
  actor: ShellActor,
  contribution: T,
): T | null {
  if (!isVisibleForActor(actor, contribution.visibility, contribution.requiredPermissions)) {
    return null;
  }

  const visibleChildren = (contribution.children ?? [])
    .map((child) => filterShellContributionTree(actor, child))
    .filter((child): child is ShellContributionItemRecord => child !== null);

  if (contribution.children?.length && visibleChildren.length === 0) {
    return null;
  }

  return {
    ...contribution,
    ...(visibleChildren.length > 0 ? { children: visibleChildren } : {}),
  };
}

function toNavigationItem(contribution: ShellContributionItemRecord): NavigationItem {
  return {
    key: contribution.key,
    label: contribution.labelKey ? t(contribution.labelKey) : contribution.label,
    icon: contribution.icon as NavigationItem["icon"],
    ...(contribution.href ? { href: contribution.href } : {}),
    ...(contribution.children?.length
      ? { children: contribution.children.map((child) => toNavigationItem(child)) }
      : {}),
  };
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
          if (hostName === "marketplace-web") {
            assertMarketplaceRouteContract(entry.contextName, route);
          }
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
                children: resolveShellContributionChildRecords(contribution.children, entry.contextName, undefined),
              } satisfies ShellContributionRecord;
            }

            const section = resolveAdminWebSection(entry.contextName, contribution.key, explicitSection);

            return {
              ...contributionRecord,
              slot: placement,
              ...(contribution.href ? { href: withPrefixedPath(contribution.href, `/${section}`) } : {}),
              contextName: entry.contextName,
              section,
              children: resolveShellContributionChildRecords(contribution.children, entry.contextName, section),
            } satisfies ShellContributionRecord;
          }),
      );
  });

  return sortShellContributionItems(
    contributions
      .filter((contribution) => (options.section ? contribution.section === options.section : true))
      .map((contribution) => filterShellContributionTree(actor, contribution))
      .filter((contribution): contribution is ShellContributionRecord => contribution !== null),
  ).map((contribution) => toNavigationItem(contribution));
}

export function getWebHostSections(hostName: WebHostName): readonly WebHostSection[] {
  return hostName === "admin-web" ? ADMIN_WEB_SECTIONS : [];
}
