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
      roleKey?: string | null;
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

function hasRequiredPermissions(
  actor: ShellActor,
  requiredPermissions: readonly string[],
  match: "all" | "any" = "all",
) {
  if (requiredPermissions.length === 0) {
    return true;
  }

  const grantedPermissions = actor?.permissions ?? [];
  const hasPermission = (permission: string) => grantedPermissions.includes(permission);
  return match === "any" ? requiredPermissions.some(hasPermission) : requiredPermissions.every(hasPermission);
}

function isVisibleForActor(
  actor: ShellActor,
  visibility: BcShellContributionVisibility,
  requiredPermissions: readonly string[],
  requiredPermissionsMatch?: "all" | "any",
) {
  if (visibility === "signed-in" && !actor) {
    return false;
  }

  if (visibility === "signed-out" && actor) {
    return false;
  }

  return hasRequiredPermissions(actor, requiredPermissions, requiredPermissionsMatch);
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
  if (children === undefined) {
    return undefined;
  }

  return sortShellContributionItems(children).map((child) => {
    assertShellNode(child);
    return {
      ...child,
      ...(child.href ? { href: section ? withPrefixedPath(child.href, `/${section}`) : child.href } : {}),
      ...(child.activePathPatterns
        ? {
            activePathPatterns: child.activePathPatterns.map((value) =>
              section ? withPrefixedPath(value, `/${section}`) : value,
            ),
          }
        : {}),
      contextName,
      section,
      children: resolveShellContributionChildRecords(child.children, contextName, section),
    };
  });
}

function filterShellContributionTree<T extends ShellContributionItemRecord>(
  actor: ShellActor,
  contribution: T,
  dynamicValues: Readonly<Record<string, number | undefined>>,
): T | null {
  if (
    !isVisibleForActor(
      actor,
      contribution.visibility,
      contribution.requiredPermissions,
      contribution.requiredPermissionsMatch,
    ) ||
    (actor?.roleKey != null && contribution.excludedRoleKeys?.includes(actor.roleKey)) ||
    (!actor && contribution.badge?.hideWhenEmptyForSignedOut && badgeCount(contribution, dynamicValues) === 0)
  ) {
    return null;
  }

  const visibleChildren = (contribution.children ?? [])
    .map((child) => filterShellContributionTree(actor, child, dynamicValues))
    .filter((child): child is ShellContributionItemRecord => child !== null);

  if (
    contribution.children !== undefined &&
    visibleChildren.length === 0 &&
    (!contribution.href || contribution.children.length > 0)
  ) {
    return null;
  }

  return {
    ...contribution,
    ...(visibleChildren.length > 0 ? { children: visibleChildren } : {}),
  };
}

function badgeCount(
  contribution: ShellContributionItemRecord,
  dynamicValues: Readonly<Record<string, number | undefined>>,
) {
  const count = contribution.badge ? dynamicValues[contribution.badge.valueKey] : undefined;
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
}

function toNavigationItem(
  contribution: ShellContributionItemRecord,
  dynamicValues: Readonly<Record<string, number | undefined>>,
  limited: boolean,
): NavigationItem {
  const count = badgeCount(contribution, dynamicValues);
  return {
    key: contribution.key,
    label: contribution.labelKey ? t(contribution.labelKey) : contribution.label,
    icon: contribution.icon as NavigationItem["icon"],
    ...(contribution.href ? { href: contribution.href } : {}),
    ...(contribution.placement ? { placement: contribution.placement } : {}),
    ...(count > 0 && contribution.badge
      ? { badge: count > contribution.badge.max ? `${contribution.badge.max}+` : String(count) }
      : {}),
    ...(contribution.children?.length
      ? {
          children: sortForRendering(contribution.children, limited).map((child) =>
            toNavigationItem(child, dynamicValues, limited),
          ),
        }
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

function resolveShellContributionRecords(
  registry: WebContextRegistry,
  hostName: WebHostName,
  slot: BcShellContributionSlot,
): ShellContributionRecord[] {
  const contributions: ShellContributionRecord[] = registry.flatMap((entry) => {
    const manifest = entry.manifest as WebContextManifest;

    return (manifest.shellContributions ?? [])
      .filter((contribution) => contribution.deployable === hostName)
      .flatMap((contribution) =>
        resolveShellContributionPlacements(contribution)
          .filter((placement) => placement === slot)
          .map((placement) => {
            assertShellNode(contribution);
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
              ...(contribution.activePathPatterns
                ? {
                    activePathPatterns: contribution.activePathPatterns.map((value) =>
                      withPrefixedPath(value, `/${section}`),
                    ),
                  }
                : {}),
              contextName: entry.contextName,
              section,
              children: resolveShellContributionChildRecords(contribution.children, entry.contextName, section),
            } satisfies ShellContributionRecord;
          }),
      );
  });

  return contributions;
}

export type WebHostNavOptions = Readonly<{
  section?: WebHostSection;
  dynamicValues?: Readonly<Record<string, number | undefined>>;
  limit?: number;
}>;

function compareOrderAndKey(left: ShellContributionItemRecord, right: ShellContributionItemRecord) {
  return left.order - right.order || left.key.localeCompare(right.key);
}

function sortForRendering<T extends ShellContributionItemRecord>(items: readonly T[], limited: boolean): T[] {
  return limited ? [...items].sort(compareOrderAndKey) : sortShellContributionItems(items);
}

function flattenShellItems(items: readonly ShellContributionItemRecord[]): ShellContributionItemRecord[] {
  return items.flatMap((item) => [item, ...flattenShellItems(item.children ?? [])]);
}

function isLiteralActivePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !/[?#*:[\]{}()\\\s]/.test(value);
}

function assertShellNode(node: BcShellContributionItem) {
  const fail = (code: string) => {
    throw new Error(`${code}: ${node.key}`);
  };
  if (!Number.isFinite(node.order)) fail("SHELL_ORDER_INVALID");
  if (node.href !== undefined && !isLiteralActivePath(node.href)) fail("SHELL_ROUTE_INVALID");
  if (node.children !== undefined && !Array.isArray(node.children)) fail("SHELL_CHILDREN_SHAPE");
  if (node.activation !== undefined && node.activation !== "route" && node.activation !== "action")
    fail("SHELL_ACTIVATION_INVALID");
  if (node.packingPriority !== undefined && !Number.isFinite(node.packingPriority)) fail("SHELL_PRIORITY_INVALID");
  if (
    node.badge !== undefined &&
    (!node.badge ||
      !Number.isFinite(node.badge.max) ||
      node.badge.max <= 0 ||
      typeof node.badge.valueKey !== "string" ||
      !node.badge.valueKey ||
      typeof node.badge.hideWhenEmptyForSignedOut !== "boolean")
  )
    fail("SHELL_BADGE_INVALID");
  if (
    node.activation === "action" &&
    (node.href !== undefined || node.children !== undefined || node.activePathPatterns !== undefined)
  )
    fail("SHELL_ACTION_INVALID");
  if (node.activation === "route" && (!node.href || !isLiteralActivePath(node.href) || node.children !== undefined))
    fail("SHELL_ROUTE_INVALID");
  if (
    node.activePathPatterns !== undefined &&
    (!node.href ||
      node.children?.length ||
      !Array.isArray(node.activePathPatterns) ||
      !node.activePathPatterns.every(isLiteralActivePath))
  )
    fail("SHELL_ACTIVE_PATH_INVALID");
}

function widensParentAccess(child: ShellContributionItemRecord, parent: ShellContributionItemRecord) {
  if (parent.visibility !== "always" && child.visibility !== parent.visibility) return true;
  if (parent.excludedRoleKeys?.some((role) => !child.excludedRoleKeys?.includes(role))) return true;
  const required = parent.requiredPermissions;
  const granted = child.requiredPermissions;
  if (!required.length) return false;
  if (!granted.length) return true;
  if (parent.requiredPermissionsMatch === "any")
    return child.requiredPermissionsMatch === "any"
      ? granted.some((permission) => !required.includes(permission))
      : !granted.some((permission) => required.includes(permission));
  return child.requiredPermissionsMatch === "any"
    ? granted.some((permission) => required.some((item) => item !== permission))
    : required.some((permission) => !granted.includes(permission));
}

function composeShellTree(
  records: readonly ShellContributionRecord[],
  limited: boolean,
): ShellContributionItemRecord[] {
  const nodes = flattenShellItems(records);
  for (const node of nodes) {
    if (limited && !Number.isFinite(node.packingPriority)) {
      throw new Error(`SHELL_PRIORITY_INVALID: ${node.key}`);
    }
  }
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const attached = new Map<ShellContributionItemRecord, ShellContributionItemRecord[]>();
  for (const node of nodes) {
    if (node.parentKey === undefined) continue;
    const fail = (code: string) => {
      throw new Error(`${code}: ${node.key}`);
    };
    if (!records.includes(node as ShellContributionRecord) || !node.parentKey) fail("SHELL_PARENT_INVALID");
    const parent = byKey.get(node.parentKey);
    if (!parent) {
      fail("SHELL_PARENT_MISSING");
      continue;
    }
    if (parent === node) fail("SHELL_PARENT_SELF");
    if (parent.activation !== undefined || parent.href !== undefined || parent.children === undefined)
      fail("SHELL_PARENT_INVALID");
    if (parent.section !== node.section) fail("SHELL_PARENT_SECTION");
    if (widensParentAccess(node, parent)) fail("SHELL_PARENT_WIDENING");
    attached.set(parent, [...(attached.get(parent) ?? []), node]);
  }
  const visiting = new Set<ShellContributionItemRecord>();
  const composed = new Map<ShellContributionItemRecord, ShellContributionItemRecord>();
  const compose = (node: ShellContributionItemRecord): ShellContributionItemRecord => {
    const existing = composed.get(node);
    if (existing) return existing;
    if (visiting.has(node)) throw new Error(`SHELL_PARENT_CYCLE: ${node.key}`);
    visiting.add(node);
    const children = [...(node.children ?? []), ...(attached.get(node) ?? [])];
    const result = {
      ...node,
      ...(node.children !== undefined || children.length ? { children: children.map(compose) } : {}),
    };
    visiting.delete(node);
    composed.set(node, result);
    return result;
  };
  // Visit even detached components so cycles cannot disappear from the roots.
  nodes.forEach(compose);
  return records.filter((node) => node.parentKey === undefined).map(compose);
}

function resolveShellTree(
  registry: WebContextRegistry,
  hostName: WebHostName,
  slot: BcShellContributionSlot,
  options: WebHostNavOptions,
) {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0))
    throw new Error("SHELL_LIMIT_INVALID");
  return composeShellTree(resolveShellContributionRecords(registry, hostName, slot), options.limit !== undefined);
}

function renderShellTree(tree: readonly ShellContributionItemRecord[], actor: ShellActor, options: WebHostNavOptions) {
  const dynamicValues = options.dynamicValues ?? {};
  let visible = tree
    .filter((item) => !options.section || item.section === options.section)
    .map((node) => filterShellContributionTree(actor, node, dynamicValues))
    .filter((node): node is ShellContributionItemRecord => node !== null);
  if (options.limit !== undefined) {
    visible = visible
      .sort((left, right) => right.packingPriority! - left.packingPriority! || compareOrderAndKey(left, right))
      .slice(0, options.limit);
  }
  return sortForRendering(visible, options.limit !== undefined).map((node) =>
    toNavigationItem(node, dynamicValues, options.limit !== undefined),
  );
}

export function resolveWebHostNavItems(
  registry: WebContextRegistry,
  hostName: WebHostName,
  slot: BcShellContributionSlot,
  actor?: ShellActor,
  options: WebHostNavOptions = {},
): NavigationItem[] {
  return renderShellTree(resolveShellTree(registry, hostName, slot, options), actor, options);
}

function normalizeActivePath(pathname: string) {
  return `/${pathname.split(/[?#]/, 1)[0].split("/").filter(Boolean).join("/")}`;
}

export function resolveWebHostActiveKey(
  registry: WebContextRegistry,
  hostName: WebHostName,
  slot: BcShellContributionSlot,
  pathname: string,
  actor?: ShellActor,
  options: WebHostNavOptions & Readonly<{ defaultKey?: string }> = {},
): string | undefined {
  const tree = resolveShellTree(registry, hostName, slot, options);
  const path = normalizeActivePath(pathname);
  const matches = flattenShellItems(tree)
    .filter((node) => node.activation !== "action" && node.href && !node.children?.length)
    .flatMap((node) =>
      [node.href!, ...(node.activePathPatterns ?? [])].flatMap((pattern) => {
        const candidate = normalizeActivePath(pattern);
        const exact = path === candidate;
        return exact || (candidate === "/" ? path.startsWith("/") : path.startsWith(`${candidate}/`))
          ? [{ key: node.key, segments: candidate.split("/").filter(Boolean).length, exact }]
          : [];
      }),
    )
    .sort((left, right) => right.segments - left.segments || Number(right.exact) - Number(left.exact));
  const best = matches[0];
  if (
    best &&
    matches.some((match) => match.segments === best.segments && match.exact === best.exact && match.key !== best.key)
  )
    return undefined;
  const key = best?.key ?? options.defaultKey;
  const hasKey = (items: readonly NavigationItem[]): boolean =>
    items.some((item) => item.key === key || hasKey(item.children ?? []));
  return key !== undefined && hasKey(renderShellTree(tree, actor, options)) ? key : undefined;
}

export function getWebHostSections(hostName: WebHostName): readonly WebHostSection[] {
  return hostName === "admin-web" ? ADMIN_WEB_SECTIONS : [];
}
