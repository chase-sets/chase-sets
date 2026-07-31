import { readFile, realpath } from "node:fs/promises";
import { isProxy } from "node:util/types";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deriveCollisionProjection } from "./collision-path.mts";
import { fail } from "./errors.mts";
import {
  deriveCounts,
  deriveDuplicateGroups,
  deriveGrammarCoverage,
  withPrimitiveDigest,
  type AssemblyRow,
  type CensusRow,
  type CaptureProvenance,
  type FileEvidence,
  type HandlerEvidence,
  type MountRecord,
  type RouteCapture,
} from "./model.mts";
import { isPathInside, loadTargetHonoAuthority, sha256 } from "./target-authority.mts";

type PublicRoute = Readonly<{
  basePath: string;
  path: string;
  method: string;
  handler: Function;
}>;

type UnwrappedEntry = Readonly<{
  router: object;
  routes: readonly PublicRoute[];
  entryShape: "positional" | "keyed";
  declaredMountPath: string | null;
  declaredContextMountOrdinal: number | null;
}>;

type RegistryEntry = Readonly<{
  contextName: string;
  manifest: Readonly<{ apiDeployables?: readonly string[] }>;
  module: Record<string, unknown> & {
    apiMounts: readonly Readonly<{
      mountPath: string;
      kind: string;
      requiresAuth: boolean;
      readFreshnessRoutes?: readonly unknown[];
    }>[];
    buildApis: (services: unknown) => readonly unknown[];
    projectionGroups?: readonly Record<string, unknown>[];
  };
}>;

function ownDataObject(value: object): boolean {
  if (isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor);
}

function readPublicRoutes(value: unknown): readonly PublicRoute[] | null {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return null;
  if (isProxy(value)) return null;
  try {
    const routes = (value as { routes?: unknown }).routes;
    if (!Array.isArray(routes)) return null;
    for (const route of routes) {
      if (!route || typeof route !== "object" || isProxy(route)) return null;
      const candidate = route as Record<string, unknown>;
      if (
        typeof candidate.basePath !== "string" ||
        typeof candidate.path !== "string" ||
        typeof candidate.method !== "string" ||
        typeof candidate.handler !== "function"
      ) {
        return null;
      }
    }
    return routes as readonly PublicRoute[];
  } catch {
    return null;
  }
}

export function unwrapRouteEntry(value: unknown): UnwrappedEntry {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    fail("E_ENTRY_SHAPE", "Route entry is neither a positional router nor an exact keyed entry.");
  }
  if (isProxy(value)) fail("E_ENTRY_SHAPE", "Route entry proxies are prohibited.");
  try {
    if ((value as { then?: unknown }).then !== undefined) {
      fail("E_ENTRY_SHAPE", "Thenable route entries are prohibited.");
    }
  } catch {
    fail("E_ENTRY_SHAPE", "Route entry thenability was unreadable.");
  }

  const positionalRoutes = readPublicRoutes(value);
  let keyed = false;
  let keyedLike = false;
  let keyedRouter: unknown;
  let declaredMountPath: unknown;
  let declaredContextMountOrdinal: unknown;
  if (typeof value === "object" && value !== null && ownDataObject(value)) {
    const ownKeys = Reflect.ownKeys(value);
    const keys = ownKeys.filter((key): key is string => typeof key === "string").sort();
    keyedLike = keys.some((key) => key === "mountPath" || key === "contextMountOrdinal" || key === "router");
    keyed =
      ownKeys.length === keys.length &&
      keys.length === 3 &&
      keys[0] === "contextMountOrdinal" &&
      keys[1] === "mountPath" &&
      keys[2] === "router";
    if (keyed) {
      const entry = value as Record<string, unknown>;
      keyedRouter = entry.router;
      declaredMountPath = entry.mountPath;
      declaredContextMountOrdinal = entry.contextMountOrdinal;
    }
  }
  if (!keyed && keyedLike) fail("E_ENTRY_SHAPE", "Keyed-like route entry is not the exact closed shape.");
  if (keyed && positionalRoutes) fail("E_ENTRY_SHAPE", "Route entry ambiguously matches both supported shapes.");
  if (!keyed && !positionalRoutes) fail("E_ENTRY_SHAPE", "Route entry matches neither supported shape.");
  if (positionalRoutes) {
    return {
      router: value as object,
      routes: positionalRoutes,
      entryShape: "positional",
      declaredMountPath: null,
      declaredContextMountOrdinal: null,
    };
  }
  if (typeof declaredMountPath !== "string" || !Number.isSafeInteger(declaredContextMountOrdinal)) {
    fail("E_ENTRY_SHAPE", "Keyed route entry declarations have invalid types.");
  }
  const keyedRoutes = readPublicRoutes(keyedRouter);
  if (!keyedRoutes) fail("E_ENTRY_SHAPE", "Keyed route entry router has no readable public routes.");
  return {
    router: keyedRouter as object,
    routes: keyedRoutes,
    entryShape: "keyed",
    declaredMountPath,
    declaredContextMountOrdinal: declaredContextMountOrdinal as number,
  };
}

function createServiceProxy(): unknown {
  const target = () => createServiceProxy();
  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") return undefined;
      return createServiceProxy();
    },
    has() {
      return true;
    },
    apply() {
      return createServiceProxy();
    },
  });
}

async function fileEvidence(root: string, candidate: string): Promise<FileEvidence> {
  const candidateRealpath = await realpath(candidate);
  if (!isPathInside(root, candidateRealpath)) fail("E_PROVENANCE", `Source file escaped target root: '${candidate}'.`);
  return {
    relativePath: path.relative(root, candidateRealpath).replaceAll("\\", "/"),
    realpath: candidateRealpath,
    sha256: sha256(await readFile(candidateRealpath)),
  };
}

function createHandlerEvidenceFactory(): (handler: Function) => HandlerEvidence {
  const identifiers = new WeakMap<Function, string>();
  const evidence = new WeakMap<Function, HandlerEvidence>();
  let nextIdentifier = 1;
  return (handler) => {
    const cached = evidence.get(handler);
    if (cached) return cached;
    let source: string;
    try {
      source = Function.prototype.toString.call(handler);
    } catch {
      fail("E_ROUTE_SHAPE", "Route handler source is unreadable.");
    }
    const referenceId = identifiers.get(handler) ?? `H${String(nextIdentifier).padStart(4, "0")}`;
    if (!identifiers.has(handler)) nextIdentifier += 1;
    identifiers.set(handler, referenceId);
    const result = {
      referenceId,
      name: handler.name || "(anonymous)",
      arity: handler.length,
      constructorName: handler.constructor?.name || "(unknown)",
      sourceSha256: sha256(source),
    };
    evidence.set(handler, result);
    return result;
  };
}

function projectionGroupsForRuntime(mountedContexts: readonly Record<string, unknown>[]): readonly unknown[] {
  return mountedContexts.flatMap((entry) => {
    const module = entry.module as { projectionGroups?: readonly Record<string, unknown>[] };
    return (module.projectionGroups ?? []).map((group) => ({
      projectionName: group.projectionName,
      projectionRevision: group.projectionRevision ?? 1,
      targetContextName: entry.contextName,
      sourceContextNames: group.sourceContextNames,
      optionalSourceContextNames: group.optionalSourceContextNames ?? [],
      ownedTables: group.ownedTables,
      resetStrategy: group.resetStrategy,
      requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
      subscriptionRunners: [],
      reset: async () => {},
      getStatus: () => ({}),
      refreshStatus: async () => ({}),
      markRevisionSynced: async () => {},
    }));
  });
}

export async function evaluateTargetRoot(targetRootInput: string, expectedHead: string): Promise<RouteCapture> {
  const startedAt = Date.now();
  const targetRoot = await realpath(path.resolve(targetRootInput));
  process.env.NODE_ENV = "test";
  process.env.TSX_TSCONFIG_PATH = path.join(targetRoot, "tsconfig.json");

  const registryPath = path.join(
    targetRoot,
    "deployables",
    "platform-api",
    "src",
    "generated",
    "api-context-registry.ts",
  );
  const apiMountsPath = path.join(targetRoot, "infrastructure", "bounded-context-runtime", "api-mounts.ts");
  const appPath = path.join(targetRoot, "deployables", "platform-api", "src", "app.ts");
  const authority = await loadTargetHonoAuthority(targetRoot);
  const [registryNamespace, apiMountsNamespace, appNamespace] = await Promise.all([
    import(pathToFileURL(registryPath).href),
    import(pathToFileURL(apiMountsPath).href),
    import(pathToFileURL(appPath).href),
  ]);
  const registry = registryNamespace.apiContextRegistry as unknown;
  if (!Array.isArray(registry)) fail("E_PROVENANCE", "Target generated API registry is invalid.");
  if (typeof apiMountsNamespace.resolveModuleApiMounts !== "function") {
    fail("E_PROVENANCE", "Target api-mounts module lacks resolveModuleApiMounts.");
  }
  if (typeof appNamespace.buildPlatformApiApp !== "function") {
    fail("E_PROVENANCE", "Target platform app module lacks buildPlatformApiApp.");
  }

  const handlerEvidence = createHandlerEvidenceFactory();
  const mountRecords: MountRecord[] = [];
  const censusRows: CensusRow[] = [];
  const mountedContexts: Record<string, unknown>[] = [];
  let mountIndex = 0;
  let rowIndex = 0;
  let contextOrdinal = 0;

  for (const rawRegistryEntry of registry as RegistryEntry[]) {
    if (!rawRegistryEntry.manifest.apiDeployables?.includes("platform-api")) continue;
    contextOrdinal += 1;
    const services = createServiceProxy();
    const rawEntries = rawRegistryEntry.module.buildApis(services);
    if (!Array.isArray(rawEntries) || rawEntries.length !== rawRegistryEntry.module.apiMounts.length) {
      fail("E_ENTRY_SHAPE", `Context '${rawRegistryEntry.contextName}' mount/router count is invalid.`);
    }
    const unwrapped = rawEntries.map(unwrapRouteEntry);
    const wrappedModule = { ...rawRegistryEntry.module, buildApis: () => rawEntries };
    const resolved = apiMountsNamespace.resolveModuleApiMounts(wrappedModule, services) as readonly Record<
      string,
      unknown
    >[];
    if (!Array.isArray(resolved) || resolved.length !== unwrapped.length) {
      fail("E_ENTRY_SHAPE", `Target resolver did not preserve '${rawRegistryEntry.contextName}' mount count.`);
    }

    for (let index = 0; index < unwrapped.length; index += 1) {
      const mount = rawRegistryEntry.module.apiMounts[index];
      const entry = unwrapped[index];
      const contextMountOrdinal = index + 1;
      if (
        entry.entryShape === "keyed" &&
        (entry.declaredMountPath !== mount.mountPath || entry.declaredContextMountOrdinal !== contextMountOrdinal)
      ) {
        fail(
          "E_ENTRY_SHAPE",
          `Keyed route entry ${rawRegistryEntry.contextName}[${contextMountOrdinal}] mismatches its manifest.`,
        );
      }
      if (resolved[index]?.mountPath !== mount.mountPath || resolved[index]?.router !== entry.router) {
        fail(
          "E_ENTRY_SHAPE",
          `Target resolver changed '${rawRegistryEntry.contextName}' entry ${contextMountOrdinal}.`,
        );
      }
      if (mount.kind !== "primary" && mount.kind !== "additional") {
        fail("E_ENTRY_SHAPE", `Mount '${rawRegistryEntry.contextName}[${contextMountOrdinal}]' has invalid kind.`);
      }
      mountIndex += 1;
      const rowStart = rowIndex + 1;
      mountRecords.push({
        mountIndex,
        context: rawRegistryEntry.contextName,
        contextOrdinal,
        contextMountOrdinal,
        declaredContextMountOrdinal: entry.declaredContextMountOrdinal,
        routerOrdinal: contextMountOrdinal,
        entryShape: entry.entryShape,
        mountPath: mount.mountPath,
        mountKind: mount.kind,
        requiresAuth: mount.requiresAuth,
        freshnessRouteCount: mount.readFreshnessRoutes?.length ?? 0,
        rowStart,
        routeCount: entry.routes.length,
      });
      for (let routeIndex = 0; routeIndex < entry.routes.length; routeIndex += 1) {
        const route = entry.routes[routeIndex];
        rowIndex += 1;
        const projection = deriveCollisionProjection(mount.mountPath, route.path, authority.helpers);
        censusRows.push({
          rowIndex,
          context: rawRegistryEntry.contextName,
          contextOrdinal,
          mountIndex,
          contextMountOrdinal,
          declaredContextMountOrdinal: entry.declaredContextMountOrdinal,
          routerOrdinal: contextMountOrdinal,
          routeOrdinal: routeIndex + 1,
          mountPath: mount.mountPath,
          mountKind: mount.kind,
          requiresAuth: mount.requiresAuth,
          rawBasePath: route.basePath,
          method: route.method,
          rawPath: route.path,
          ...projection,
          handler: handlerEvidence(route.handler),
        });
      }
    }
    mountedContexts.push({
      contextName: rawRegistryEntry.contextName,
      mountRole: "active",
      module: wrappedModule,
      services,
      pool: createServiceProxy(),
      projectionHandlerSets: [],
    });
  }

  const services = Object.fromEntries(mountedContexts.map((entry) => [entry.contextName, entry.services]));
  const runtime = {
    mountedContexts,
    mountedModules: mountedContexts.map((entry) => ({ module: entry.module, services: entry.services })),
    services,
    projectionGroups: projectionGroupsForRuntime(mountedContexts),
    subscriptionRunners: [],
  };
  const app = appNamespace.buildPlatformApiApp(runtime, { runtimeProfile: "public" }) as { routes?: unknown };
  const appRoutes = readPublicRoutes(app);
  if (!appRoutes) fail("E_ROUTE_SHAPE", "Composed platform app has no readable public routes.");
  const mountedBlockStart = appRoutes.length - censusRows.length;
  if (mountedBlockStart < 0) fail("E_ARTIFACT_INVALID", "Composed platform app is shorter than its census.");
  const rawHandlers = censusRows.map((_row, index) => {
    const mount = mountRecords.find(
      ({ rowStart, routeCount }) => index + 1 >= rowStart && index + 1 < rowStart + routeCount,
    );
    if (!mount) fail("E_ARTIFACT_INVALID", `Census row ${index + 1} is outside the mount partition.`);
    return unwrappedHandlerForRow(registry as RegistryEntry[], mountedContexts, mount, index + 1);
  });
  const assemblyRows: AssemblyRow[] = appRoutes.map((route, index) => {
    const sourceIndex = index >= mountedBlockStart ? index - mountedBlockStart : null;
    return {
      rowIndex: index + 1,
      basePath: route.basePath,
      path: route.path,
      method: route.method,
      handler: handlerEvidence(route.handler),
      sourceCensusRowIndex: sourceIndex === null ? null : sourceIndex + 1,
      sameHandlerReference: sourceIndex === null ? null : route.handler === rawHandlers[sourceIndex],
    };
  });

  const effectiveTsconfig = await fileEvidence(targetRoot, path.join(targetRoot, "tsconfig.json"));
  const provenance: CaptureProvenance = {
    root: targetRoot,
    head: expectedHead,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    nodeEnvironment: "test",
    appRuntimeProfile: "public",
    effectiveTsconfig,
    bareSpecifierProbe: { specifier: "hono/utils/url", resolvedRealpath: authority.moduleRealpath },
    honoAuthority: {
      specifier: authority.specifier,
      packageVersion: authority.packageVersion,
      packageRealpath: authority.packageRealpath,
      moduleRealpath: authority.moduleRealpath,
      moduleSha256: authority.moduleSha256,
      helperExports: authority.helperExports,
    },
    sourceFiles: await Promise.all(
      [registryPath, apiMountsPath, appPath, path.join(targetRoot, "pnpm-lock.yaml")].map((sourcePath) =>
        fileEvidence(targetRoot, sourcePath),
      ),
    ),
  };
  const counts = deriveCounts(mountRecords, censusRows, assemblyRows);
  return withPrimitiveDigest({
    provenance,
    counts,
    grammarCoverage: deriveGrammarCoverage(censusRows, authority.helpers, authority.packageVersion),
    mountRecords,
    censusRows,
    duplicateGroups: deriveDuplicateGroups(censusRows),
    assemblyRows,
    mountedBlockStart,
  });
}

function unwrappedHandlerForRow(
  _registry: readonly RegistryEntry[],
  mountedContexts: readonly Record<string, unknown>[],
  mount: MountRecord,
  rowIndex: number,
): Function {
  const context = mountedContexts.find((entry) => entry.contextName === mount.context);
  if (!context) fail("E_ARTIFACT_INVALID", `Mounted context '${mount.context}' disappeared.`);
  const module = context.module as { buildApis: (services: unknown) => readonly unknown[] };
  const entries = module.buildApis(context.services);
  const unwrapped = unwrapRouteEntry(entries[mount.contextMountOrdinal - 1]);
  return unwrapped.routes[rowIndex - mount.rowStart].handler;
}
