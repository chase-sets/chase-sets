import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlatformApiApp } from "../src/app";
import { createRouteInventoryRuntime } from "./route-inventory-test-support";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const openApiPath = join(repoRoot, "docs/api/marketplace.openapi.json");
const apiDocPath = join(repoRoot, "docs/api/marketplace-api.md");

type OpenApiDocument = Readonly<{
  paths: Record<string, Record<string, OpenApiOperation | unknown>>;
  components?: {
    parameters?: Record<string, unknown>;
    responses?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
  };
}>;

type OpenApiOperation = Readonly<{
  parameters?: readonly Readonly<{ $ref?: string }>[];
  responses?: Record<string, Readonly<{ $ref?: string }> | unknown>;
}>;

type HonoRoute = Readonly<{
  method: string;
  path: string;
}>;

type ContextManifestForOpenApi = Readonly<{
  apiMounts?: readonly Readonly<{
    mountPath: string;
    readFreshnessRoutes?: readonly Readonly<{ routePath: string; methods?: readonly string[] }>[];
  }>[];
}>;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readOpenApiEndpointKeys(openApi: OpenApiDocument): readonly string[] {
  return Object.entries(openApi.paths).flatMap(([path, methods]) =>
    Object.keys(methods)
      .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
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

function toOpenApiPath(mountPath: string, routePath: string): string {
  return `${mountPath}${routePath}`.replace(/:([^/]+)/g, "{$1}");
}

function normalizeEndpointKey(endpointKey: string): string {
  const [method, path] = endpointKey.split(" ");

  return `${method} ${normalizeRoutePattern(path)}`;
}

function readReadFreshnessEndpointKeys(): readonly string[] {
  return diskContextManifests().flatMap((manifest) =>
    (manifest.apiMounts ?? []).flatMap((mount) =>
      (mount.readFreshnessRoutes ?? []).flatMap((route) =>
        (route.methods ?? ["GET", "HEAD"])
          .map((method) => method.toLowerCase())
          .filter((method) => method !== "head")
          .map((method) => `${method} ${toOpenApiPath(mount.mountPath, route.routePath)}`),
      ),
    ),
  );
}

function diskContextManifests(): readonly ContextManifestForOpenApi[] {
  const boundedContextsRoot = join(repoRoot, "bounded-contexts");
  const manifests: unknown[] = [];

  for (const entry of readdirSync(boundedContextsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const contextPath = join(boundedContextsRoot, entry.name, "context.json");
    try {
      manifests.push(readJson(contextPath));
    } catch {
      // Ignore non-context folders.
    }
  }

  return manifests as readonly ContextManifestForOpenApi[];
}

function readMountedPlatformApiEndpointKeys(): readonly string[] {
  const app = Reflect.apply(buildPlatformApiApp, undefined, [createRouteInventoryRuntime()]);
  const routes = (app as unknown as { routes?: readonly HonoRoute[] }).routes ?? [];
  const supportedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

  return routes
    .filter((route) => supportedMethods.has(route.method.toUpperCase()))
    .filter((route) => route.path.startsWith("/api/"))
    .map((route) => `${route.method.toLowerCase()} ${normalizeRoutePattern(route.path)}`);
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
      manifest.deployableContributions?.some((contribution) => contribution.deployable === "marketplace-web") ||
      manifest.shellContributions?.some((contribution) => contribution.deployable === "marketplace-web");

    if (!contributesToMarketplaceWeb) {
      continue;
    }

    // A context's marketplace-web-facing API is its /api/marketplace mount
    // when one is declared (for example platform-operations hosts support
    // requests on an additional /api/marketplace mount while its primary
    // mount serves admin-web platform operations); otherwise it is the
    // context's primary mount.
    const mounts = manifest.apiMounts ?? [];
    const marketplaceWebMount =
      mounts.find((mount) => mount.mountPath === "/api/marketplace") ??
      mounts.find((mount) => mount.kind === "primary");

    if (marketplaceWebMount && marketplaceWebMount.mountPath !== "/api/auth") {
      mountPaths.add(marketplaceWebMount.mountPath);
    }
  }

  return [...mountPaths].sort();
}

describe("marketplace OpenAPI parity", () => {
  it("keeps endpoint coverage in the machine-readable OpenAPI contract", () => {
    const content = readFileSync(apiDocPath, "utf8");

    expect(readOpenApiEndpointKeys(readJson<OpenApiDocument>(openApiPath)).length).toBeGreaterThan(70);
    expect(content).toContain("marketplace.openapi.json");
    expect(content).toContain("rather than maintaining a separate manual parity matrix");
  });

  it("keeps documented marketplace endpoints mounted by platform-api", () => {
    const openApi = readJson<OpenApiDocument>(openApiPath);
    const mountedEndpoints = new Set(readMountedPlatformApiEndpointKeys());
    const documentedEndpoints = readOpenApiEndpointKeys(openApi).map(normalizeEndpointKey);

    expect(documentedEndpoints.filter((endpoint) => !mountedEndpoints.has(endpoint))).toEqual([]);
  });

  it("keeps marketplace-web bounded-context API mounts represented", () => {
    const openApi = readJson<OpenApiDocument>(openApiPath);
    const openApiPaths = Object.keys(openApi.paths);

    expect(readMarketplaceWebApiMounts()).toEqual([
      "/api/identity",
      "/api/inventory",
      "/api/marketplace",
      "/api/notifications",
      "/api/settlement",
    ]);
    for (const mountPath of readMarketplaceWebApiMounts()) {
      expect(openApiPaths.some((path) => path === mountPath || path.startsWith(`${mountPath}/`))).toBe(true);
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

  it("documents the read-after-write freshness contract for generated clients", () => {
    const openApi = readJson<OpenApiDocument>(openApiPath);

    expect(openApi.components?.parameters).toMatchObject({
      ReadAfterWrite: {
        name: "Chase-Sets-Read-After-Write",
        in: "header",
        required: false,
      },
      ReadTargetContext: {
        name: "Chase-Sets-Read-Target-Context",
        in: "header",
        required: false,
      },
    });
    expect(openApi.components?.responses?.Command).toMatchObject({
      headers: {
        "Chase-Sets-Consistency": { $ref: "#/components/headers/Consistency" },
        "Chase-Sets-Commit-Position": { $ref: "#/components/headers/CommitPosition" },
        "Chase-Sets-Commit-Receipt": { $ref: "#/components/headers/CommitReceipt" },
      },
    });
    expect(openApi.components?.responses?.ProjectionFreshnessTimeout).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProjectionFreshnessTimeoutError" },
        },
      },
    });

    let documentedFreshReadOperations = 0;
    const violations: string[] = [];
    for (const endpointKey of readReadFreshnessEndpointKeys()) {
      const [method, path] = endpointKey.split(" ");
      const operation = openApi.paths[path]?.[method] as OpenApiOperation | undefined;

      if (!operation) {
        continue;
      }
      documentedFreshReadOperations += 1;

      const parameterRefs = new Set((operation.parameters ?? []).map((parameter) => parameter.$ref));
      if (!parameterRefs.has("#/components/parameters/ReadAfterWrite")) {
        violations.push(`${endpointKey}: missing Chase-Sets-Read-After-Write parameter`);
      }
      if (!parameterRefs.has("#/components/parameters/ReadTargetContext")) {
        violations.push(`${endpointKey}: missing Chase-Sets-Read-Target-Context parameter`);
      }
      if (
        (operation.responses?.["503"] as { $ref?: string } | undefined)?.$ref !==
        "#/components/responses/ProjectionFreshnessTimeout"
      ) {
        violations.push(`${endpointKey}: missing projection freshness timeout response`);
      }
    }

    expect(documentedFreshReadOperations).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("documents the closed per-unit offline-sale request and typed result", () => {
    const openApi = readJson<OpenApiDocument>(openApiPath);
    const operation = openApi.paths["/api/inventory/items/{id}/offline-sales"]?.post as {
      description?: string;
      requestBody?: { content?: { "application/json"?: { schema?: Record<string, unknown> } } };
      responses?: Record<string, unknown>;
    };
    const requestSchema = operation.requestBody?.content?.["application/json"]?.schema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<string, unknown>;
    };
    const success = operation.responses?.["200"] as {
      content?: { "application/json"?: { schema?: Record<string, unknown> } };
    };
    const responseSchema = success.content?.["application/json"]?.schema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<string, unknown>;
    };

    expect(requestSchema).toMatchObject({
      additionalProperties: false,
      required: ["quantity", "channel", "idempotencyKey"],
      properties: {
        quantity: { type: "integer", minimum: 1 },
        salePriceAmount: { type: "string", nullable: true, description: expect.stringContaining("per-unit") },
        channel: { enum: ["in-store", "card-show", "other"] },
        collisionMode: { enum: ["protect-orders", "honor-offline"], default: "protect-orders" },
        idempotencyKey: { type: "string", minLength: 1 },
      },
    });
    expect(Object.keys(requestSchema.properties ?? {})).toEqual([
      "quantity",
      "salePriceAmount",
      "channel",
      "note",
      "collisionMode",
      "confirmSellerCannotFulfill",
      "idempotencyKey",
    ]);
    expect(operation.description).toContain("server stamps the recorded time");
    expect(operation.description).toContain("Currency");
    expect(responseSchema).toMatchObject({
      additionalProperties: false,
      required: ["itemId", "version", "requestedQuantity", "appliedQuantity", "refusedQuantity", "collision"],
      properties: {
        collision: {
          nullable: true,
          properties: {
            affectedOrders: { type: "array" },
          },
        },
      },
    });
    expect(operation.responses).toMatchObject({
      "400": { $ref: "#/components/responses/ValidationFailed" },
      "401": { $ref: "#/components/responses/AuthenticationRequired" },
      "403": { $ref: "#/components/responses/Forbidden" },
    });
  });
});
