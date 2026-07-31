import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createArtifact } from "./artifact.mts";
import { deriveCollisionProjection } from "./collision-path.mts";
import {
  deriveCounts,
  deriveDuplicateGroups,
  deriveGrammarCoverage,
  primitivePayload,
  withPrimitiveDigest,
} from "./model.mts";
import { loadTargetHonoAuthority, sha256 } from "./target-authority.mts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function evidence(relativePath) {
  const filePath = await realpath(path.join(repoRoot, relativePath));
  return { relativePath, realpath: filePath, sha256: sha256(await readFile(filePath)) };
}

export async function syntheticContext() {
  const root = await realpath(repoRoot);
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const authority = await loadTargetHonoAuthority(root);
  const sourceFiles = await Promise.all([
    evidence("deployables/platform-api/src/generated/api-context-registry.ts"),
    evidence("infrastructure/bounded-context-runtime/api-mounts.ts"),
    evidence("deployables/platform-api/src/app.ts"),
    evidence("pnpm-lock.yaml"),
  ]);
  return { root, head, authority, sourceFiles };
}

function handler(index, overrides = {}) {
  return {
    referenceId: `H${String(index).padStart(4, "0")}`,
    name: "handler",
    arity: 1,
    constructorName: "Function",
    sourceSha256: sha256(`handler-${index}`),
    ...overrides,
  };
}

export async function makeCapture(
  context,
  {
    routes = ["/items/:id", "/items/:slug"],
    routeContexts = [],
    routeHandlers = [],
    zeroRouteMount = false,
    positionalShift = 0,
  } = {},
) {
  const mountRecords = [];
  const censusRows = [];
  let rowIndex = 0;
  const mounts = [
    { context: "alpha", mountPath: "/api", routes },
    ...(zeroRouteMount ? [{ context: "zero", mountPath: "/zero", routes: [] }] : []),
  ];
  for (let mountIndex = 0; mountIndex < mounts.length; mountIndex += 1) {
    const mount = mounts[mountIndex];
    mountRecords.push({
      mountIndex: mountIndex + 1,
      context: mount.context,
      contextOrdinal: mountIndex + 1,
      contextMountOrdinal: 1,
      declaredContextMountOrdinal: null,
      routerOrdinal: 1,
      entryShape: "positional",
      mountPath: mount.mountPath,
      mountKind: "primary",
      requiresAuth: true,
      freshnessRouteCount: 0,
      rowStart: rowIndex + 1,
      routeCount: mount.routes.length,
    });
    for (let routeIndex = 0; routeIndex < mount.routes.length; routeIndex += 1) {
      const rawPath = mount.routes[routeIndex];
      rowIndex += 1;
      censusRows.push({
        rowIndex,
        context: routeContexts[routeIndex] ?? mount.context,
        contextOrdinal: mountIndex + 1 + positionalShift,
        mountIndex: mountIndex + 1 + positionalShift,
        contextMountOrdinal: 1 + positionalShift,
        declaredContextMountOrdinal: null,
        routerOrdinal: 1 + positionalShift,
        routeOrdinal: routeIndex + 1 + positionalShift,
        mountPath: mount.mountPath,
        mountKind: "primary",
        requiresAuth: true,
        rawBasePath: "/",
        method: "GET",
        rawPath,
        ...deriveCollisionProjection(mount.mountPath, rawPath, context.authority.helpers),
        handler: handler(routeIndex + 1, routeHandlers[routeIndex]),
      });
    }
  }
  const preHandler = handler(9000, { name: "host" });
  const assemblyRows = [
    {
      rowIndex: 1,
      basePath: "/",
      path: "/host",
      method: "GET",
      handler: preHandler,
      sourceCensusRowIndex: null,
      sameHandlerReference: null,
    },
    ...censusRows.map((row, index) => ({
      rowIndex: index + 2,
      basePath: row.mountPath,
      path: row.combinedPath,
      method: row.method,
      handler: row.handler,
      sourceCensusRowIndex: row.rowIndex,
      sameHandlerReference: true,
    })),
  ];
  const provenance = {
    root: context.root,
    head: context.head,
    capturedAt: "2026-07-31T12:00:00.000Z",
    durationMs: 25,
    nodeEnvironment: "test",
    appRuntimeProfile: "public",
    effectiveTsconfig: await evidence("tsconfig.json"),
    bareSpecifierProbe: { specifier: "hono/utils/url", resolvedRealpath: context.authority.moduleRealpath },
    honoAuthority: {
      specifier: context.authority.specifier,
      packageVersion: context.authority.packageVersion,
      packageRealpath: context.authority.packageRealpath,
      moduleRealpath: context.authority.moduleRealpath,
      moduleSha256: context.authority.moduleSha256,
      helperExports: context.authority.helperExports,
    },
    sourceFiles: context.sourceFiles,
  };
  return withPrimitiveDigest({
    provenance,
    counts: deriveCounts(mountRecords, censusRows, assemblyRows),
    grammarCoverage: deriveGrammarCoverage(censusRows, context.authority.helpers, context.authority.packageVersion),
    mountRecords,
    censusRows,
    duplicateGroups: deriveDuplicateGroups(censusRows),
    assemblyRows,
    mountedBlockStart: 1,
  });
}

export async function makeArtifact(baseOptions = {}, candidateOptions = baseOptions, expectedState = "empty") {
  const context = await syntheticContext();
  const base = await makeCapture(context, baseOptions);
  const candidate = await makeCapture(context, candidateOptions);
  const runFile = await evidence("scripts/route-census/run.mts");
  return {
    context,
    artifact: createArtifact(
      "2026-07-31T12:01:00.000Z",
      { root: context.root, head: context.head, runFile },
      base,
      candidate,
      expectedState,
    ),
  };
}

export function clone(value) {
  return structuredClone(value);
}

export function rehashArtifact(artifact) {
  const content = clone(artifact);
  delete content.contentSha256;
  artifact.contentSha256 = sha256(JSON.stringify(content));
  return artifact;
}

export function rehashCapture(capture) {
  capture.primitiveSha256 = sha256(JSON.stringify(primitivePayload(capture)));
  return capture;
}
