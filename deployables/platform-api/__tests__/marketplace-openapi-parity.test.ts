import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlatformApiApp } from "../src/app";
import { apiContextRegistry } from "../src/generated/api-context-registry";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const openApiPath = join(repoRoot, "docs/api/marketplace.openapi.json");
const parityDocPath = join(repoRoot, "docs/api/marketplace-api-parity.md");

type OpenApiDocument = Readonly<{
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
  };
}>;

type HonoRoute = Readonly<{
  method: string;
  path: string;
}>;

type RouteInventoryRuntime = Parameters<typeof buildPlatformApiApp>[0];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readMarkdownEndpointKeys(): readonly string[] {
  const content = readFileSync(parityDocPath, "utf8");
  const endpointMatches = content.matchAll(
    /`(GET|POST|PUT|PATCH|DELETE) ([^`]+)`/g,
  );

  return [...endpointMatches].map(
    ([, method, path]) => `${method.toLowerCase()} ${path}`,
  );
}

function readOpenApiEndpointKeys(openApi: OpenApiDocument): readonly string[] {
  return Object.entries(openApi.paths).flatMap(([path, methods]) =>
    Object.keys(methods)
      .filter((method) =>
        ["get", "post", "put", "patch", "delete"].includes(method),
      )
      .map((method) => `${method} ${path}`),
  );
}

function normalizeRoutePattern(path: string): string {
  const normalized =
    path
      .replace(/\/:([^/]+)/g, "/{}")
      .replace(/{[^/}]+}/g, "{}")
      .replace(/\/+$/g, "") || "/";

  return normalized;
}

function normalizeEndpointKey(endpointKey: string): string {
  const [method, path] = endpointKey.split(" ");

  return `${method} ${normalizeRoutePattern(path)}`;
}

function createServiceProxy(): unknown {
  const target = () => createServiceProxy();

  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") {
        return undefined;
      }

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

function createRouteInventoryRuntime(): RouteInventoryRuntime {
  const mountedContexts = apiContextRegistry
    .filter((entry) => entry.manifest.apiDeployables?.includes("platform-api"))
    .map((entry) => ({
      contextName: entry.contextName,
      mountRole: "active" as const,
      module: entry.module,
      services: createServiceProxy(),
      pool: createServiceProxy(),
      projectors: [],
    }));
  const services = Object.fromEntries(
    mountedContexts.map((entry) => [entry.contextName, entry.services]),
  );

  return {
    mountedContexts,
    mountedModules: mountedContexts.map((entry) => ({
      module: entry.module,
      services: entry.services,
    })),
    services,
    projectors: [],
    projectionGroups: [],
    subscriptionRunners: [],
  } as RouteInventoryRuntime;
}

function readMountedPlatformApiEndpointKeys(): readonly string[] {
  const app = buildPlatformApiApp(createRouteInventoryRuntime());
  const routes = (app as unknown as { routes?: readonly HonoRoute[] }).routes ?? [];
  const supportedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

  return routes
    .filter((route) => supportedMethods.has(route.method.toUpperCase()))
    .filter((route) => route.path.startsWith("/api/"))
    .map(
      (route) =>
        `${route.method.toLowerCase()} ${normalizeRoutePattern(route.path)}`,
    );
}

function readMarketplaceWebApiMounts(): readonly string[] {
  const boundedContextsRoot = join(repoRoot, "bounded-contexts");
  const mountPaths = new Set<string>();

  for (const entry of readdirSync(boundedContextsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const contextPath = join(boundedContextsRoot, entry.name, "context.json");
    let manifest: {
      deployableContributions?: readonly { deployable: string }[];
      shellContributions?: readonly { deployable: string }[];
      apiMounts?: readonly { mountPath: string; kind: string }[];
    };

    try {
      manifest = readJson(contextPath);
    } catch {
      continue;
    }

    const contributesToMarketplaceWeb =
      manifest.deployableContributions?.some(
        (contribution) => contribution.deployable === "marketplace-web",
      ) ||
      manifest.shellContributions?.some(
        (contribution) => contribution.deployable === "marketplace-web",
      );

    if (!contributesToMarketplaceWeb) {
      continue;
    }

    for (const mount of manifest.apiMounts ?? []) {
      if (mount.kind === "primary" && mount.mountPath !== "/api/auth") {
        mountPaths.add(mount.mountPath);
      }
    }
  }

  return [...mountPaths].sort();
}

describe("marketplace OpenAPI parity", () => {
  it("documents every endpoint in the marketplace-web parity matrix", () => {
    const openApi = readJson<OpenApiDocument>(openApiPath);
    const openApiEndpoints = new Set(readOpenApiEndpointKeys(openApi));
    const parityEndpoints = readMarkdownEndpointKeys();

    expect(parityEndpoints.length).toBeGreaterThan(70);
    expect(
      parityEndpoints.filter((endpoint) => !openApiEndpoints.has(endpoint)),
    ).toEqual([]);
  });

  it("keeps documented marketplace endpoints mounted by platform-api", () => {
    const openApi = readJson<OpenApiDocument>(openApiPath);
    const mountedEndpoints = new Set(readMountedPlatformApiEndpointKeys());
    const documentedEndpoints = readOpenApiEndpointKeys(openApi).map(
      normalizeEndpointKey,
    );

    expect(
      documentedEndpoints.filter((endpoint) => !mountedEndpoints.has(endpoint)),
    ).toEqual([]);
  });

  it("keeps marketplace-web bounded-context API mounts represented", () => {
    const openApi = readJson<OpenApiDocument>(openApiPath);
    const openApiPaths = Object.keys(openApi.paths);

    expect(readMarketplaceWebApiMounts()).toEqual([
      "/api/identity",
      "/api/inventory",
      "/api/marketplace",
      "/api/settlement",
    ]);
    for (const mountPath of readMarketplaceWebApiMounts()) {
      expect(
        openApiPaths.some((path) => path === mountPath || path.startsWith(`${mountPath}/`)),
      ).toBe(true);
    }
  });

  it("uses the standardized nested error response envelope", () => {
    const openApi = readJson<OpenApiDocument>(openApiPath);
    const errorSchema = openApi.components?.schemas?.Error;

    expect(errorSchema).toMatchObject({
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
        },
      },
    });
  });
});
