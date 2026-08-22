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

export type WebHostShellResolutionErrorCode =
  | "SHELL_DUPLICATE_EXPANDED_KEY"
  | "SHELL_DUPLICATE_EXPANDED_HREF"
  | "SHELL_PARENT_MISSING"
  | "SHELL_PARENT_INVALID"
  | "SHELL_PARENT_SELF"
  | "SHELL_PARENT_CYCLE"
  | "SHELL_ACCESS_WIDENING"
  | "SHELL_ACTION_MALFORMED"
  | "SHELL_ROUTE_MALFORMED"
  | "SHELL_ORDER_NON_FINITE"
  | "SHELL_PACKING_PRIORITY_NON_FINITE"
  | "SHELL_BADGE_INVALID"
  | "SHELL_BADGE_MAX_INVALID"
  | "SHELL_DUPLICATE_BADGE_OWNER"
  | "SHELL_ACTIVE_PATH_MALFORMED"
  | "SHELL_ACTIVE_AMBIGUITY"
  | "SHELL_LIMIT_INVALID"
  | "SHELL_LIMIT_PRIORITY_MISSING";

export class WebHostShellResolutionError extends Error {
  readonly code: WebHostShellResolutionErrorCode;

  constructor(code: WebHostShellResolutionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "WebHostShellResolutionError";
    this.code = code;
  }
}

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

type MutableShellContributionRecord = Omit<ShellContributionRecord, "children"> & {
  children?: MutableShellContributionRecord[];
  naturalParentKey?: string;
};

export type ResolveWebHostNavOptions = Readonly<{
  section?: WebHostSection;
  dynamicValues?: Readonly<Record<string, number | undefined>>;
  limit?: number;
}>;

export type ResolveWebHostActiveKeyOptions = ResolveWebHostNavOptions &
  Readonly<{
    defaultKey: string;
  }>;

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

function failShellResolution(code: WebHostShellResolutionErrorCode, message: string): never {
  throw new WebHostShellResolutionError(code, message);
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
  excludedRoleKeys: readonly string[] = [],
) {
  if (visibility === "signed-in" && !actor) {
    return false;
  }

  if (visibility === "signed-out" && actor) {
    return false;
  }

  if (actor?.roleKey && excludedRoleKeys.includes(actor.roleKey)) {
    return false;
  }

  return hasRequiredPermissions(actor, requiredPermissions);
}

function sortShellContributionItems<T extends Pick<BcShellContributionItem, "key" | "order">>(
  items: readonly T[],
): T[] {
  return [...items].sort((left, right) =>
    left.order === right.order ? compareShellKeys(left.key, right.key) : left.order - right.order,
  );
}

function compareShellKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
    ...(child.href
      ? {
          href:
            section && typeof child.href === "string" && child.href.startsWith("/")
              ? withPrefixedPath(child.href, `/${section}`)
              : child.href,
        }
      : {}),
    ...(child.activePathPatterns
      ? {
          activePathPatterns: child.activePathPatterns.map((pattern) =>
            section && typeof pattern === "string" && pattern.startsWith("/")
              ? withPrefixedPath(pattern, `/${section}`)
              : pattern,
          ),
        }
      : {}),
    contextName,
    section,
    children: resolveShellContributionChildRecords(child.children, contextName, section),
  }));
}

function normalizeShellPath(pathname: string): string {
  const pathOnly = pathname.split(/[?#]/, 1)[0] ?? "";
  const segments = pathOnly.split("/").filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function isLiteralAbsoluteShellPath(pathname: unknown): pathname is string {
  return (
    typeof pathname === "string" &&
    pathname.startsWith("/") &&
    !pathname.includes("?") &&
    !pathname.includes("#") &&
    !/[\\:*{}]/.test(pathname)
  );
}

function isRouteLeaf(contribution: ShellContributionItemRecord): boolean {
  return (
    contribution.activation !== "action" && typeof contribution.href === "string" && contribution.children === undefined
  );
}

function isGroup(contribution: ShellContributionItemRecord): boolean {
  return contribution.activation !== "action" && !isRouteLeaf(contribution);
}

function accessCohorts(visibility: BcShellContributionVisibility): readonly string[] {
  if (visibility === "signed-in") {
    return ["signed-in"];
  }
  if (visibility === "signed-out") {
    return ["signed-out"];
  }
  return ["signed-in", "signed-out"];
}

function validateAccessDoesNotWiden(parent: ShellContributionItemRecord, child: ShellContributionItemRecord): void {
  const parentCohorts = new Set(accessCohorts(parent.visibility));
  const widensVisibility = accessCohorts(child.visibility).some((cohort) => !parentCohorts.has(cohort));
  const childPermissions = new Set(child.requiredPermissions);
  const dropsPermission = parent.requiredPermissions.some((permission) => !childPermissions.has(permission));
  const childExcludedRoles = new Set(child.excludedRoleKeys ?? []);
  const dropsRoleExclusion = (parent.excludedRoleKeys ?? []).some((roleKey) => !childExcludedRoles.has(roleKey));

  if (widensVisibility || dropsPermission || dropsRoleExclusion) {
    failShellResolution(
      "SHELL_ACCESS_WIDENING",
      `Shell contribution '${child.key}' widens access declared by parent '${parent.key}'.`,
    );
  }
}

function validateExpandedShellRecords(records: readonly ShellContributionItemRecord[], limit?: number): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    failShellResolution("SHELL_LIMIT_INVALID", "A shell contribution limit must be a non-negative integer.");
  }

  const keys = new Set<string>();
  const hrefOwners = new Map<string, string>();
  const badgeOwners = new Map<string, string>();
  const activePathOwners = new Map<string, string>();

  for (const contribution of records) {
    if (keys.has(contribution.key)) {
      failShellResolution(
        "SHELL_DUPLICATE_EXPANDED_KEY",
        `Expanded shell contribution key '${contribution.key}' has more than one owner.`,
      );
    }
    keys.add(contribution.key);

    if (!Number.isFinite(contribution.order)) {
      failShellResolution(
        "SHELL_ORDER_NON_FINITE",
        `Shell contribution '${contribution.key}' must declare a finite order.`,
      );
    }

    if (contribution.packingPriority !== undefined && !Number.isFinite(contribution.packingPriority)) {
      failShellResolution(
        "SHELL_PACKING_PRIORITY_NON_FINITE",
        `Shell contribution '${contribution.key}' must declare a finite packingPriority when provided.`,
      );
    }

    if (limit !== undefined && !Number.isFinite(contribution.packingPriority)) {
      failShellResolution(
        "SHELL_LIMIT_PRIORITY_MISSING",
        `Limited shell resolution requires finite packingPriority on '${contribution.key}'.`,
      );
    }

    if (contribution.activation === "action") {
      if (
        contribution.href !== undefined ||
        contribution.children !== undefined ||
        contribution.activePathPatterns !== undefined
      ) {
        failShellResolution(
          "SHELL_ACTION_MALFORMED",
          `Action shell contribution '${contribution.key}' must not declare href, children, or activePathPatterns.`,
        );
      }
    } else if (contribution.activation !== undefined && contribution.activation !== "route") {
      failShellResolution(
        "SHELL_ROUTE_MALFORMED",
        `Shell contribution '${contribution.key}' declares unsupported activation '${String(contribution.activation)}'.`,
      );
    } else if (
      contribution.activation === "route" &&
      (typeof contribution.href !== "string" || contribution.children !== undefined)
    ) {
      failShellResolution(
        "SHELL_ROUTE_MALFORMED",
        `Route shell contribution '${contribution.key}' must declare href and no children.`,
      );
    }

    if (contribution.href !== undefined) {
      if (!isLiteralAbsoluteShellPath(contribution.href)) {
        failShellResolution(
          "SHELL_ACTIVE_PATH_MALFORMED",
          `Shell contribution '${contribution.key}' href must be a literal absolute path.`,
        );
      }
      const href = normalizeShellPath(contribution.href);
      const hrefOwner = hrefOwners.get(href);
      if (hrefOwner && hrefOwner !== contribution.key) {
        failShellResolution(
          "SHELL_DUPLICATE_EXPANDED_HREF",
          `Expanded href '${href}' is owned by '${hrefOwner}' and '${contribution.key}'.`,
        );
      }
      hrefOwners.set(href, contribution.key);
    }

    if (contribution.activePathPatterns !== undefined) {
      if (!isRouteLeaf(contribution) || !Array.isArray(contribution.activePathPatterns)) {
        failShellResolution(
          "SHELL_ACTIVE_PATH_MALFORMED",
          `Only a route leaf may declare activePathPatterns ('${contribution.key}').`,
        );
      }
      for (const pattern of contribution.activePathPatterns) {
        if (!isLiteralAbsoluteShellPath(pattern)) {
          failShellResolution(
            "SHELL_ACTIVE_PATH_MALFORMED",
            `Shell contribution '${contribution.key}' declares a malformed active path.`,
          );
        }
      }
    }

    if (contribution.badge !== undefined) {
      if (
        typeof contribution.badge.valueKey !== "string" ||
        contribution.badge.valueKey.length === 0 ||
        typeof contribution.badge.hideWhenEmptyForSignedOut !== "boolean"
      ) {
        failShellResolution(
          "SHELL_BADGE_INVALID",
          `Shell contribution '${contribution.key}' declares a malformed badge.`,
        );
      }
      if (
        !Number.isFinite(contribution.badge.max) ||
        !Number.isInteger(contribution.badge.max) ||
        contribution.badge.max <= 0
      ) {
        failShellResolution(
          "SHELL_BADGE_MAX_INVALID",
          `Shell contribution '${contribution.key}' badge max must be a positive finite integer.`,
        );
      }
      const badgeOwner = badgeOwners.get(contribution.badge.valueKey);
      if (badgeOwner && badgeOwner !== contribution.key) {
        failShellResolution(
          "SHELL_DUPLICATE_BADGE_OWNER",
          `Badge value '${contribution.badge.valueKey}' is owned by '${badgeOwner}' and '${contribution.key}'.`,
        );
      }
      badgeOwners.set(contribution.badge.valueKey, contribution.key);
    }

    if (isRouteLeaf(contribution)) {
      for (const path of [contribution.href, ...(contribution.activePathPatterns ?? [])]) {
        const normalizedPath = normalizeShellPath(path);
        const activeOwner = activePathOwners.get(normalizedPath);
        if (activeOwner && activeOwner !== contribution.key) {
          failShellResolution(
            "SHELL_ACTIVE_AMBIGUITY",
            `Active path '${normalizedPath}' is owned by '${activeOwner}' and '${contribution.key}'.`,
          );
        }
        activePathOwners.set(normalizedPath, contribution.key);
      }
    }
  }
}

function flattenShellRecords(contributions: readonly ShellContributionRecord[]): MutableShellContributionRecord[] {
  const flattened: MutableShellContributionRecord[] = [];

  function visit(contribution: ShellContributionItemRecord, naturalParentKey?: string) {
    const { children, ...record } = contribution;
    flattened.push({
      ...(record as Omit<ShellContributionRecord, "children">),
      ...(children !== undefined ? { children: [] } : {}),
      ...(naturalParentKey ? { naturalParentKey } : {}),
    });
    for (const child of children ?? []) {
      visit(child, contribution.key);
    }
  }

  for (const contribution of contributions) {
    visit(contribution);
  }

  return flattened;
}

function attachShellContributionParents(
  contributions: readonly ShellContributionRecord[],
  allHostContributionKeys: ReadonlySet<string>,
): ShellContributionRecord[] {
  const records = flattenShellRecords(contributions);
  const byKey = new Map(records.map((record) => [record.key, record]));
  const parentByKey = new Map<string, string>();

  for (const record of records) {
    const parentKey = record.parentKey ?? record.naturalParentKey;
    if (!parentKey) {
      continue;
    }
    if (parentKey === record.key) {
      failShellResolution("SHELL_PARENT_SELF", `Shell contribution '${record.key}' cannot parent itself.`);
    }
    const parent = byKey.get(parentKey);
    if (!parent) {
      failShellResolution(
        allHostContributionKeys.has(parentKey) ? "SHELL_PARENT_INVALID" : "SHELL_PARENT_MISSING",
        `Shell contribution '${record.key}' cannot attach to parent '${parentKey}' in this expanded slot.`,
      );
    }
    if (!isGroup(parent)) {
      failShellResolution(
        "SHELL_PARENT_INVALID",
        `Shell contribution '${record.key}' parent '${parentKey}' must be a group.`,
      );
    }
    parentByKey.set(record.key, parentKey);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visitParent(key: string) {
    if (visiting.has(key)) {
      failShellResolution("SHELL_PARENT_CYCLE", `Shell contribution parent cycle includes '${key}'.`);
    }
    if (visited.has(key)) {
      return;
    }
    visiting.add(key);
    const parentKey = parentByKey.get(key);
    if (parentKey) {
      visitParent(parentKey);
    }
    visiting.delete(key);
    visited.add(key);
  }
  for (const record of records) {
    visitParent(record.key);
  }

  for (const record of records) {
    const parentKey = parentByKey.get(record.key);
    if (!parentKey) {
      continue;
    }
    const parent = byKey.get(parentKey)!;
    validateAccessDoesNotWiden(parent, record);
    parent.children ??= [];
    parent.children.push(record);
  }

  return records.filter((record) => !parentByKey.has(record.key));
}

function resolveExpandedShellTree(
  registry: WebContextRegistry,
  hostName: WebHostName,
  slot: BcShellContributionSlot,
  limit?: number,
): ShellContributionRecord[] {
  const allHostContributionKeys = new Set<string>();
  const contributions: ShellContributionRecord[] = registry.flatMap((entry) => {
    const manifest = entry.manifest as WebContextManifest;

    function collectHostContributionKeys(contribution: BcShellContributionItem) {
      allHostContributionKeys.add(contribution.key);
      for (const child of contribution.children ?? []) {
        collectHostContributionKeys(child);
      }
    }

    for (const contribution of manifest.shellContributions ?? []) {
      if (contribution.deployable === hostName) {
        collectHostContributionKeys(contribution);
      }
    }

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
              ...(contribution.href
                ? {
                    href:
                      typeof contribution.href === "string" && contribution.href.startsWith("/")
                        ? withPrefixedPath(contribution.href, `/${section}`)
                        : contribution.href,
                  }
                : {}),
              ...(contribution.activePathPatterns
                ? {
                    activePathPatterns: contribution.activePathPatterns.map((pattern) =>
                      typeof pattern === "string" && pattern.startsWith("/")
                        ? withPrefixedPath(pattern, `/${section}`)
                        : pattern,
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

  const flattened = flattenShellRecords(contributions);
  validateExpandedShellRecords(flattened, limit);
  return attachShellContributionParents(contributions, allHostContributionKeys);
}

function normalizeDynamicValue(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? 0) : 0;
}

function resolveBadge(
  contribution: ShellContributionItemRecord,
  dynamicValues: Readonly<Record<string, number | undefined>>,
): string | undefined {
  if (!contribution.badge) {
    return undefined;
  }
  const value = normalizeDynamicValue(dynamicValues[contribution.badge.valueKey]);
  if (value === 0) {
    return undefined;
  }
  return value > contribution.badge.max ? `${contribution.badge.max}+` : String(value);
}

function filterShellContributionTree<T extends ShellContributionItemRecord>(
  actor: ShellActor,
  contribution: T,
  dynamicValues: Readonly<Record<string, number | undefined>>,
): T | null {
  const badgeValue = contribution.badge ? normalizeDynamicValue(dynamicValues[contribution.badge.valueKey]) : undefined;
  if (
    !isVisibleForActor(
      actor,
      contribution.visibility,
      contribution.requiredPermissions,
      contribution.excludedRoleKeys,
    ) ||
    (!actor && contribution.badge?.hideWhenEmptyForSignedOut && badgeValue === 0)
  ) {
    return null;
  }

  const visibleChildren = (contribution.children ?? [])
    .map((child) => filterShellContributionTree(actor, child, dynamicValues))
    .filter((child): child is ShellContributionItemRecord => child !== null);

  if (isGroup(contribution) && visibleChildren.length === 0) {
    return null;
  }

  return {
    ...contribution,
    ...(visibleChildren.length > 0 ? { children: visibleChildren } : {}),
  };
}

function toNavigationItem(
  contribution: ShellContributionItemRecord,
  dynamicValues: Readonly<Record<string, number | undefined>>,
): NavigationItem {
  const badge = resolveBadge(contribution, dynamicValues);
  return {
    key: contribution.key,
    label: contribution.labelKey ? t(contribution.labelKey) : contribution.label,
    icon: contribution.icon as NavigationItem["icon"],
    ...(contribution.href ? { href: contribution.href } : {}),
    ...(contribution.placement ? { placement: contribution.placement } : {}),
    ...(badge ? { badge } : {}),
    ...(contribution.children?.length
      ? {
          children: sortShellContributionItems(contribution.children).map((child) =>
            toNavigationItem(child, dynamicValues),
          ),
        }
      : {}),
  };
}

function selectLimitedShellContributions(
  contributions: readonly ShellContributionRecord[],
  limit: number | undefined,
): ShellContributionRecord[] {
  if (limit === undefined) {
    return sortShellContributionItems(contributions);
  }

  return sortShellContributionItems(
    [...contributions]
      .sort((left, right) =>
        left.packingPriority === right.packingPriority
          ? left.order === right.order
            ? compareShellKeys(left.key, right.key)
            : left.order - right.order
          : (right.packingPriority ?? 0) - (left.packingPriority ?? 0),
      )
      .slice(0, limit),
  );
}

function resolveRenderedShellTree(
  registry: WebContextRegistry,
  hostName: WebHostName,
  slot: BcShellContributionSlot,
  actor: ShellActor,
  options: ResolveWebHostNavOptions,
): ShellContributionRecord[] {
  const dynamicValues = options.dynamicValues ?? {};
  const expandedTree = resolveExpandedShellTree(registry, hostName, slot, options.limit);
  const visibleTree = expandedTree
    .filter((contribution) => (options.section ? contribution.section === options.section : true))
    .map((contribution) => filterShellContributionTree(actor, contribution, dynamicValues))
    .filter((contribution): contribution is ShellContributionRecord => contribution !== null);

  return selectLimitedShellContributions(visibleTree, options.limit);
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
  options: ResolveWebHostNavOptions = {},
): NavigationItem[] {
  const dynamicValues = options.dynamicValues ?? {};
  return resolveRenderedShellTree(registry, hostName, slot, actor, options).map((contribution) =>
    toNavigationItem(contribution, dynamicValues),
  );
}

function flattenRenderedKeys(contributions: readonly ShellContributionItemRecord[]): ReadonlySet<string> {
  const keys = new Set<string>();
  function visit(contribution: ShellContributionItemRecord) {
    keys.add(contribution.key);
    for (const child of contribution.children ?? []) {
      visit(child);
    }
  }
  for (const contribution of contributions) {
    visit(contribution);
  }
  return keys;
}

type ActivePathMatch = Readonly<{
  key: string;
  segments: number;
  exact: boolean;
}>;

function collectActivePathMatches(
  contributions: readonly ShellContributionItemRecord[],
  pathname: string,
): ActivePathMatch[] {
  const matches: ActivePathMatch[] = [];

  function visit(contribution: ShellContributionItemRecord) {
    if (isRouteLeaf(contribution)) {
      for (const candidate of [contribution.href!, ...(contribution.activePathPatterns ?? [])]) {
        const normalizedCandidate = normalizeShellPath(candidate);
        const exact = pathname === normalizedCandidate;
        const descendant =
          normalizedCandidate === "/" ? pathname.startsWith("/") : pathname.startsWith(`${normalizedCandidate}/`);
        if (exact || descendant) {
          matches.push({
            key: contribution.key,
            segments: normalizedCandidate === "/" ? 0 : normalizedCandidate.slice(1).split("/").length,
            exact,
          });
        }
      }
    }
    for (const child of contribution.children ?? []) {
      visit(child);
    }
  }

  for (const contribution of contributions) {
    visit(contribution);
  }
  return matches;
}

export function resolveWebHostActiveKey(
  registry: WebContextRegistry,
  hostName: WebHostName,
  slot: BcShellContributionSlot,
  pathname: string,
  actor: ShellActor,
  options: ResolveWebHostActiveKeyOptions,
): string | undefined {
  const expandedTree = resolveExpandedShellTree(registry, hostName, slot, options.limit).filter((contribution) =>
    options.section ? contribution.section === options.section : true,
  );
  const normalizedPathname = normalizeShellPath(pathname);
  const matches = collectActivePathMatches(expandedTree, normalizedPathname).sort((left, right) =>
    left.segments === right.segments ? Number(right.exact) - Number(left.exact) : right.segments - left.segments,
  );
  const bestMatch = matches[0];

  if (!bestMatch) {
    return options.defaultKey;
  }

  const equalPrecedenceKeys = new Set(
    matches
      .filter((match) => match.segments === bestMatch.segments && match.exact === bestMatch.exact)
      .map((match) => match.key),
  );
  if (equalPrecedenceKeys.size > 1) {
    failShellResolution(
      "SHELL_ACTIVE_AMBIGUITY",
      `Path '${normalizedPathname}' has equal-precedence shell identities: ${[...equalPrecedenceKeys].sort().join(", ")}.`,
    );
  }

  const renderedKeys = flattenRenderedKeys(resolveRenderedShellTree(registry, hostName, slot, actor, options));
  return renderedKeys.has(bestMatch.key) ? bestMatch.key : undefined;
}

export function getWebHostSections(hostName: WebHostName): readonly WebHostSection[] {
  return hostName === "admin-web" ? ADMIN_WEB_SECTIONS : [];
}
