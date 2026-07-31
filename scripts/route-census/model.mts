import { sha256, type TargetHonoUrlHelpers } from "./target-authority.mts";

export const ARTIFACT_SCHEMA_VERSION = "chase-sets-route-parity/v4" as const;
export const MAX_COLLECTION_COUNT = 10_000_000;

export type FileEvidence = Readonly<{
  relativePath: string;
  realpath: string;
  sha256: string;
}>;

export type CaptureProvenance = Readonly<{
  root: string;
  head: string;
  capturedAt: string;
  durationMs: number;
  nodeEnvironment: "test";
  appRuntimeProfile: "public";
  effectiveTsconfig: FileEvidence;
  bareSpecifierProbe: Readonly<{
    specifier: "hono/utils/url";
    resolvedRealpath: string;
  }>;
  honoAuthority: Readonly<{
    specifier: "hono/utils/url";
    packageVersion: string;
    packageRealpath: string;
    moduleRealpath: string;
    moduleSha256: string;
    helperExports: readonly ["mergePath", "checkOptionalParameter", "splitRoutingPath", "getPattern"];
  }>;
  sourceFiles: readonly FileEvidence[];
}>;

export type HandlerEvidence = Readonly<{
  referenceId: string;
  name: string;
  arity: number;
  constructorName: string;
  sourceSha256: string;
}>;

export type MountRecord = Readonly<{
  mountIndex: number;
  context: string;
  contextOrdinal: number;
  contextMountOrdinal: number;
  declaredContextMountOrdinal: number | null;
  routerOrdinal: number;
  entryShape: "positional" | "keyed";
  mountPath: string;
  mountKind: "primary" | "additional";
  requiresAuth: boolean;
  freshnessRouteCount: number;
  rowStart: number;
  routeCount: number;
}>;

export type CensusRow = Readonly<{
  rowIndex: number;
  context: string;
  contextOrdinal: number;
  mountIndex: number;
  contextMountOrdinal: number;
  declaredContextMountOrdinal: number | null;
  routerOrdinal: number;
  routeOrdinal: number;
  mountPath: string;
  mountKind: "primary" | "additional";
  requiresAuth: boolean;
  rawBasePath: string;
  method: string;
  rawPath: string;
  combinedPath: string;
  acceptedPathProjections: readonly Readonly<{ acceptedPath: string; collisionPath: string }>[];
  collisionShape: readonly string[];
  handler: HandlerEvidence;
}>;

export type AssemblyRow = Readonly<{
  rowIndex: number;
  basePath: string;
  path: string;
  method: string;
  handler: HandlerEvidence;
  sourceCensusRowIndex: number | null;
  sameHandlerReference: boolean | null;
}>;

export type MemberOccurrence = Readonly<{
  context: string;
  mountPath: string;
  method: string;
  rawPath: string;
  combinedPath: string;
  collisionShape: readonly string[];
  handler: Readonly<{ name: string; arity: number }>;
}>;

export type OccurrenceCount = Readonly<{
  occurrence: MemberOccurrence;
  count: number;
}>;

export type DuplicateGroup = Readonly<{
  displayId: string;
  method: string;
  collisionShape: readonly string[];
  memberOccurrences: readonly OccurrenceCount[];
  routeCount: number;
}>;

export type CaptureCounts = Readonly<{
  contexts: number;
  mounts: number;
  routers: number;
  distinctMountPaths: number;
  zeroRouteMounts: number;
  censusRecords: number;
  censusAllRecords: number;
  assemblyRecords: number;
  assemblyAllRecords: number;
  preMountRecords: number;
  scanned: number;
  total: number;
}>;

export type GrammarCoverage = Readonly<{
  targetVersion: string;
  derivedMembers: number;
  handled: Readonly<{
    empty: number;
    literal: number;
    wildcard: number;
    colonParameter: number;
  }>;
  indeterminate: readonly string[];
}>;

export type RouteCapture = Readonly<{
  provenance: CaptureProvenance;
  counts: CaptureCounts;
  grammarCoverage: GrammarCoverage;
  mountRecords: readonly MountRecord[];
  censusRows: readonly CensusRow[];
  duplicateGroups: readonly DuplicateGroup[];
  assemblyRows: readonly AssemblyRow[];
  mountedBlockStart: number;
  primitiveSha256: string;
}>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareStrings(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

export function compareGroupIdentity(
  left: Pick<DuplicateGroup, "method" | "collisionShape">,
  right: Pick<DuplicateGroup, "method" | "collisionShape">,
): number {
  return compareStrings(left.method, right.method) || compareStringArrays(left.collisionShape, right.collisionShape);
}

export function compareOccurrences(left: MemberOccurrence, right: MemberOccurrence): number {
  return (
    compareStrings(left.context, right.context) ||
    compareStrings(left.mountPath, right.mountPath) ||
    compareStrings(left.method, right.method) ||
    compareStrings(left.rawPath, right.rawPath) ||
    compareStrings(left.combinedPath, right.combinedPath) ||
    compareStringArrays(left.collisionShape, right.collisionShape) ||
    compareStrings(left.handler.name, right.handler.name) ||
    left.handler.arity - right.handler.arity
  );
}

function occurrenceForRow(row: CensusRow): MemberOccurrence {
  return {
    context: row.context,
    mountPath: row.mountPath,
    method: row.method,
    rawPath: row.rawPath,
    combinedPath: row.combinedPath,
    collisionShape: [...row.collisionShape],
    handler: { name: row.handler.name, arity: row.handler.arity },
  };
}

export function deriveDuplicateGroups(rows: readonly CensusRow[]): DuplicateGroup[] {
  const grouped: Array<{
    method: string;
    collisionShape: readonly string[];
    rows: CensusRow[];
  }> = [];
  for (const row of rows) {
    const existing = grouped.find(
      (group) => group.method === row.method && compareStringArrays(group.collisionShape, row.collisionShape) === 0,
    );
    if (existing) existing.rows.push(row);
    else grouped.push({ method: row.method, collisionShape: [...row.collisionShape], rows: [row] });
  }
  const duplicates = grouped.filter(({ rows: members }) => members.length >= 2);
  duplicates.sort(compareGroupIdentity);
  return duplicates.map((group, index) => {
    const occurrences: OccurrenceCount[] = [];
    for (const row of group.rows) {
      const occurrence = occurrenceForRow(row);
      const existing = occurrences.find((candidate) => compareOccurrences(candidate.occurrence, occurrence) === 0);
      if (existing) {
        occurrences[occurrences.indexOf(existing)] = { occurrence: existing.occurrence, count: existing.count + 1 };
      } else {
        occurrences.push({ occurrence, count: 1 });
      }
    }
    occurrences.sort((left, right) => compareOccurrences(left.occurrence, right.occurrence));
    return {
      displayId: `D${String(index + 1).padStart(3, "0")}`,
      method: group.method,
      collisionShape: [...group.collisionShape],
      memberOccurrences: occurrences,
      routeCount: group.rows.length,
    };
  });
}

export function deriveCounts(
  mountRecords: readonly MountRecord[],
  censusRows: readonly CensusRow[],
  assemblyRows: readonly AssemblyRow[],
): CaptureCounts {
  return {
    contexts: new Set(mountRecords.map(({ context }) => context)).size,
    mounts: mountRecords.length,
    routers: mountRecords.length,
    distinctMountPaths: new Set(mountRecords.map(({ mountPath }) => mountPath)).size,
    zeroRouteMounts: mountRecords.filter(({ routeCount }) => routeCount === 0).length,
    censusRecords: censusRows.length,
    censusAllRecords: censusRows.filter(({ method }) => method === "ALL").length,
    assemblyRecords: assemblyRows.length,
    assemblyAllRecords: assemblyRows.filter(({ method }) => method === "ALL").length,
    preMountRecords: assemblyRows.length - censusRows.length,
    scanned: mountRecords.length,
    total: mountRecords.length,
  };
}

export function deriveGrammarCoverage(
  rows: readonly CensusRow[],
  helpers: TargetHonoUrlHelpers,
  targetVersion: string,
): GrammarCoverage {
  const handled = { empty: 0, literal: 0, wildcard: 0, colonParameter: 0 };
  const indeterminate: string[] = [];
  for (const row of rows) {
    for (const { acceptedPath } of row.acceptedPathProjections) {
      const segments = helpers.splitRoutingPath(acceptedPath);
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment === "") handled.empty += 1;
        else if (segment === "*") handled.wildcard += 1;
        else if (segment.startsWith(":")) {
          if (helpers.getPattern(segment, segments[index + 1]) === null) {
            indeterminate.push(`${row.rowIndex}:${acceptedPath}:${segment}`);
          } else handled.colonParameter += 1;
        } else handled.literal += 1;
      }
    }
  }
  const derivedMembers = Object.values(handled).reduce((sum, count) => sum + count, 0) + indeterminate.length;
  return { targetVersion, derivedMembers, handled, indeterminate };
}

export function primitivePayload(capture: Omit<RouteCapture, "primitiveSha256">): unknown {
  return {
    provenance: capture.provenance,
    mountRecords: capture.mountRecords,
    censusRows: capture.censusRows.map((row) => ({
      rowIndex: row.rowIndex,
      context: row.context,
      contextOrdinal: row.contextOrdinal,
      mountIndex: row.mountIndex,
      contextMountOrdinal: row.contextMountOrdinal,
      declaredContextMountOrdinal: row.declaredContextMountOrdinal,
      routerOrdinal: row.routerOrdinal,
      routeOrdinal: row.routeOrdinal,
      mountPath: row.mountPath,
      mountKind: row.mountKind,
      requiresAuth: row.requiresAuth,
      rawBasePath: row.rawBasePath,
      method: row.method,
      rawPath: row.rawPath,
      handler: row.handler,
    })),
    assemblyRows: capture.assemblyRows,
  };
}

export function withPrimitiveDigest(capture: Omit<RouteCapture, "primitiveSha256">): RouteCapture {
  return {
    ...capture,
    primitiveSha256: sha256(JSON.stringify(primitivePayload(capture))),
  };
}
