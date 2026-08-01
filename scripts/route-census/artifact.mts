import { execFile as execFileCallback } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { collisionFixtureVector } from "./collision-path.mts";
import { compareCaptures, type RouteComparison, type SequenceDiff } from "./comparison.mts";
import { deriveCollisionProjection } from "./collision-path.mts";
import { fail } from "./errors.mts";
import {
  ARTIFACT_SCHEMA_VERSION,
  MAX_COLLECTION_COUNT,
  deriveCounts,
  deriveDuplicateGroups,
  deriveGrammarCoverage,
  primitivePayload,
  type AssemblyRow,
  type CensusRow,
  type FileEvidence,
  type HandlerEvidence,
  type MountRecord,
  type RouteCapture,
} from "./model.mts";
import { isPathInside, loadTargetHonoAuthority, sha256 } from "./target-authority.mts";
import {
  apiContextRegistrySourcePaths,
  movedApiContextRegistrySourcePath,
  resolveApiContextRegistrySource,
} from "./registry-source.mts";

const execFile = promisify(execFileCallback);
const MAX_STRING = 65_536;
const SHA_PATTERN = /^[a-f0-9]{64}$/;
const HEAD_PATTERN = /^[a-f0-9]{40}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type HarnessProvenance = Readonly<{
  root: string;
  head: string;
  runFile: FileEvidence;
}>;

export type RouteParityArtifact = Readonly<{
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  generatedAt: string;
  harness: HarnessProvenance;
  collisionVector: typeof collisionFixtureVector;
  base: RouteCapture;
  candidate: RouteCapture;
  comparison: RouteComparison;
  contentSha256: string;
}>;

export type ArtifactExpectations = Readonly<{
  baseHead: string;
  candidateHead: string;
  harnessHead: string;
  baseRoot?: string;
  candidateRoot?: string;
}>;

type ValidationOptions = Readonly<{
  requireCleanTrees?: boolean;
  verifyLiveProvenance?: boolean;
  allowSameRootForTests?: boolean;
  allowExpectationMismatchForParity?: boolean;
}>;

type CaptureSide = "base" | "candidate";

function invalid(message: string): never {
  fail("E_ARTIFACT_INVALID", message);
}

function record(value: unknown, pathName: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${pathName} must be an object.`);
  const actual = Object.keys(value as object).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    invalid(`${pathName} fields are not recursively closed.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, pathName: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_COUNT) invalid(`${pathName} must be a bounded array.`);
  return value;
}

function string(value: unknown, pathName: string, options: { nonempty?: boolean } = {}): string {
  if (typeof value !== "string" || value.length > MAX_STRING || (options.nonempty && value.length === 0)) {
    invalid(`${pathName} must be a bounded${options.nonempty ? " nonempty" : ""} string.`);
  }
  return value;
}

function integer(value: unknown, pathName: string, minimum = 0, maximum = MAX_COLLECTION_COUNT): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${pathName} must be an integer in [${minimum}, ${maximum}].`);
  }
  return value as number;
}

function boolean(value: unknown, pathName: string): boolean {
  if (typeof value !== "boolean") invalid(`${pathName} must be boolean.`);
  return value;
}

function sha(value: unknown, pathName: string): string {
  const result = string(value, pathName, { nonempty: true });
  if (!SHA_PATTERN.test(result)) invalid(`${pathName} must be a lowercase SHA-256.`);
  return result;
}

function head(value: unknown, pathName: string): string {
  const result = string(value, pathName, { nonempty: true });
  if (!HEAD_PATTERN.test(result)) invalid(`${pathName} must be a lowercase exact Git head.`);
  return result;
}

function instant(value: unknown, pathName: string): string {
  const result = string(value, pathName, { nonempty: true });
  if (!INSTANT_PATTERN.test(result) || Number.isNaN(Date.parse(result))) {
    invalid(`${pathName} must be a timezone-bearing instant.`);
  }
  return result;
}

function exact(left: unknown, right: unknown, message: string): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) invalid(message);
}

function validateFileEvidence(value: unknown, pathName: string): FileEvidence {
  const object = record(value, pathName, ["relativePath", "realpath", "sha256"]);
  string(object.relativePath, `${pathName}.relativePath`, { nonempty: true });
  string(object.realpath, `${pathName}.realpath`, { nonempty: true });
  sha(object.sha256, `${pathName}.sha256`);
  return object as FileEvidence;
}

function validateHandler(value: unknown, pathName: string): HandlerEvidence {
  const object = record(value, pathName, ["referenceId", "name", "arity", "constructorName", "sourceSha256"]);
  if (!/^H\d{4,}$/.test(string(object.referenceId, `${pathName}.referenceId`, { nonempty: true }))) {
    invalid(`${pathName}.referenceId is invalid.`);
  }
  string(object.name, `${pathName}.name`, { nonempty: true });
  integer(object.arity, `${pathName}.arity`, 0, 100);
  string(object.constructorName, `${pathName}.constructorName`, { nonempty: true });
  sha(object.sourceSha256, `${pathName}.sourceSha256`);
  return object as HandlerEvidence;
}

function validateMount(value: unknown, pathName: string): MountRecord {
  const object = record(value, pathName, [
    "mountIndex",
    "context",
    "contextOrdinal",
    "contextMountOrdinal",
    "declaredContextMountOrdinal",
    "routerOrdinal",
    "entryShape",
    "mountPath",
    "mountKind",
    "requiresAuth",
    "freshnessRouteCount",
    "rowStart",
    "routeCount",
  ]);
  integer(object.mountIndex, `${pathName}.mountIndex`, 1);
  string(object.context, `${pathName}.context`, { nonempty: true });
  integer(object.contextOrdinal, `${pathName}.contextOrdinal`, 1);
  integer(object.contextMountOrdinal, `${pathName}.contextMountOrdinal`, 1);
  if (object.declaredContextMountOrdinal !== null) {
    integer(object.declaredContextMountOrdinal, `${pathName}.declaredContextMountOrdinal`, 1);
  }
  integer(object.routerOrdinal, `${pathName}.routerOrdinal`, 1);
  if (object.entryShape !== "positional" && object.entryShape !== "keyed")
    invalid(`${pathName}.entryShape is invalid.`);
  string(object.mountPath, `${pathName}.mountPath`, { nonempty: true });
  if (object.mountKind !== "primary" && object.mountKind !== "additional") invalid(`${pathName}.mountKind is invalid.`);
  boolean(object.requiresAuth, `${pathName}.requiresAuth`);
  integer(object.freshnessRouteCount, `${pathName}.freshnessRouteCount`);
  integer(object.rowStart, `${pathName}.rowStart`, 1);
  integer(object.routeCount, `${pathName}.routeCount`);
  return object as MountRecord;
}

function validateProjectionArray(
  value: unknown,
  pathName: string,
): readonly { acceptedPath: string; collisionPath: string }[] {
  return array(value, pathName).map((projection, index) => {
    const object = record(projection, `${pathName}[${index}]`, ["acceptedPath", "collisionPath"]);
    return {
      acceptedPath: string(object.acceptedPath, `${pathName}[${index}].acceptedPath`, { nonempty: true }),
      collisionPath: string(object.collisionPath, `${pathName}[${index}].collisionPath`, { nonempty: true }),
    };
  });
}

function validateCensusRow(value: unknown, pathName: string): CensusRow {
  const object = record(value, pathName, [
    "rowIndex",
    "context",
    "contextOrdinal",
    "mountIndex",
    "contextMountOrdinal",
    "declaredContextMountOrdinal",
    "routerOrdinal",
    "routeOrdinal",
    "mountPath",
    "mountKind",
    "requiresAuth",
    "rawBasePath",
    "method",
    "rawPath",
    "combinedPath",
    "acceptedPathProjections",
    "collisionShape",
    "handler",
  ]);
  integer(object.rowIndex, `${pathName}.rowIndex`, 1);
  string(object.context, `${pathName}.context`, { nonempty: true });
  integer(object.contextOrdinal, `${pathName}.contextOrdinal`, 1);
  integer(object.mountIndex, `${pathName}.mountIndex`, 1);
  integer(object.contextMountOrdinal, `${pathName}.contextMountOrdinal`, 1);
  if (object.declaredContextMountOrdinal !== null)
    integer(object.declaredContextMountOrdinal, `${pathName}.declaredContextMountOrdinal`, 1);
  integer(object.routerOrdinal, `${pathName}.routerOrdinal`, 1);
  integer(object.routeOrdinal, `${pathName}.routeOrdinal`, 1);
  string(object.mountPath, `${pathName}.mountPath`, { nonempty: true });
  if (object.mountKind !== "primary" && object.mountKind !== "additional") invalid(`${pathName}.mountKind is invalid.`);
  boolean(object.requiresAuth, `${pathName}.requiresAuth`);
  string(object.rawBasePath, `${pathName}.rawBasePath`, { nonempty: true });
  if (!/^[A-Z]+$/.test(string(object.method, `${pathName}.method`, { nonempty: true })))
    invalid(`${pathName}.method is invalid.`);
  string(object.rawPath, `${pathName}.rawPath`, { nonempty: true });
  string(object.combinedPath, `${pathName}.combinedPath`, { nonempty: true });
  validateProjectionArray(object.acceptedPathProjections, `${pathName}.acceptedPathProjections`);
  array(object.collisionShape, `${pathName}.collisionShape`).forEach((part, index) =>
    string(part, `${pathName}.collisionShape[${index}]`, { nonempty: true }),
  );
  validateHandler(object.handler, `${pathName}.handler`);
  return object as CensusRow;
}

function validateAssemblyRow(value: unknown, pathName: string): AssemblyRow {
  const object = record(value, pathName, [
    "rowIndex",
    "basePath",
    "path",
    "method",
    "handler",
    "sourceCensusRowIndex",
    "sameHandlerReference",
  ]);
  integer(object.rowIndex, `${pathName}.rowIndex`, 1);
  string(object.basePath, `${pathName}.basePath`, { nonempty: true });
  string(object.path, `${pathName}.path`, { nonempty: true });
  if (!/^[A-Z]+$/.test(string(object.method, `${pathName}.method`, { nonempty: true })))
    invalid(`${pathName}.method is invalid.`);
  validateHandler(object.handler, `${pathName}.handler`);
  if (object.sourceCensusRowIndex !== null) integer(object.sourceCensusRowIndex, `${pathName}.sourceCensusRowIndex`, 1);
  if (object.sameHandlerReference !== null) boolean(object.sameHandlerReference, `${pathName}.sameHandlerReference`);
  return object as AssemblyRow;
}

async function git(root: string, argumentsList: readonly string[]): Promise<string> {
  try {
    const result = await execFile("git", ["-C", root, ...argumentsList], { encoding: "utf8", windowsHide: true });
    return result.stdout.trim();
  } catch {
    fail("E_PROVENANCE", `Git provenance query failed for '${root}'.`);
  }
}

async function validateLiveFile(root: string, evidence: FileEvidence, pathName: string): Promise<void> {
  let actualRealpath: string;
  try {
    actualRealpath = await realpath(path.resolve(root, evidence.relativePath));
  } catch {
    fail("E_PROVENANCE", `${pathName} is missing.`);
  }
  if (actualRealpath !== evidence.realpath || !isPathInside(root, actualRealpath)) {
    fail("E_PROVENANCE", `${pathName} realpath does not match its target root.`);
  }
  if (sha256(await readFile(actualRealpath)) !== evidence.sha256) fail("E_PROVENANCE", `${pathName} hash drifted.`);
}

async function validateProvenance(
  value: unknown,
  pathName: string,
  side: CaptureSide,
  options: ValidationOptions,
): Promise<{ provenance: RouteCapture["provenance"]; authority: Awaited<ReturnType<typeof loadTargetHonoAuthority>> }> {
  const object = record(value, pathName, [
    "root",
    "head",
    "capturedAt",
    "durationMs",
    "nodeEnvironment",
    "appRuntimeProfile",
    "effectiveTsconfig",
    "bareSpecifierProbe",
    "honoAuthority",
    "sourceFiles",
  ]);
  const root = string(object.root, `${pathName}.root`, { nonempty: true });
  if (!path.isAbsolute(root)) invalid(`${pathName}.root must be absolute.`);
  head(object.head, `${pathName}.head`);
  instant(object.capturedAt, `${pathName}.capturedAt`);
  integer(object.durationMs, `${pathName}.durationMs`, 0, 86_400_000);
  if (object.nodeEnvironment !== "test") invalid(`${pathName}.nodeEnvironment must be 'test'.`);
  if (object.appRuntimeProfile !== "public") invalid(`${pathName}.appRuntimeProfile must be 'public'.`);
  const effectiveTsconfig = validateFileEvidence(object.effectiveTsconfig, `${pathName}.effectiveTsconfig`);
  const probe = record(object.bareSpecifierProbe, `${pathName}.bareSpecifierProbe`, ["specifier", "resolvedRealpath"]);
  if (probe.specifier !== "hono/utils/url") invalid(`${pathName}.bareSpecifierProbe.specifier is invalid.`);
  string(probe.resolvedRealpath, `${pathName}.bareSpecifierProbe.resolvedRealpath`, { nonempty: true });
  const hono = record(object.honoAuthority, `${pathName}.honoAuthority`, [
    "specifier",
    "packageVersion",
    "packageRealpath",
    "moduleRealpath",
    "moduleSha256",
    "helperExports",
  ]);
  if (hono.specifier !== "hono/utils/url") invalid(`${pathName}.honoAuthority.specifier is invalid.`);
  string(hono.packageVersion, `${pathName}.honoAuthority.packageVersion`, { nonempty: true });
  string(hono.packageRealpath, `${pathName}.honoAuthority.packageRealpath`, { nonempty: true });
  string(hono.moduleRealpath, `${pathName}.honoAuthority.moduleRealpath`, { nonempty: true });
  sha(hono.moduleSha256, `${pathName}.honoAuthority.moduleSha256`);
  exact(
    hono.helperExports,
    ["mergePath", "checkOptionalParameter", "splitRoutingPath", "getPattern"],
    `${pathName}.honoAuthority.helperExports is invalid.`,
  );
  const sourceFiles = array(object.sourceFiles, `${pathName}.sourceFiles`).map((item, index) =>
    validateFileEvidence(item, `${pathName}.sourceFiles[${index}]`),
  );
  const recordedRegistryPath = sourceFiles[0]?.relativePath;
  if (!apiContextRegistrySourcePaths.includes(recordedRegistryPath as (typeof apiContextRegistrySourcePaths)[number])) {
    invalid(`${pathName}.sourceFiles[0] is not an allowed API context registry path.`);
  }
  if (side === "candidate" && recordedRegistryPath !== movedApiContextRegistrySourcePath) {
    invalid(`${pathName}.sourceFiles[0] must use the moved API context registry path on the candidate side.`);
  }
  const expectedSources = [
    recordedRegistryPath,
    "infrastructure/bounded-context-runtime/api-mounts.ts",
    "deployables/platform-api/src/app.ts",
    "pnpm-lock.yaml",
  ];
  exact(
    sourceFiles.map(({ relativePath }) => relativePath),
    expectedSources,
    `${pathName}.sourceFiles is incomplete or reordered.`,
  );
  const authority = await loadTargetHonoAuthority(root);
  exact(
    {
      specifier: authority.specifier,
      packageVersion: authority.packageVersion,
      packageRealpath: authority.packageRealpath,
      moduleRealpath: authority.moduleRealpath,
      moduleSha256: authority.moduleSha256,
      helperExports: authority.helperExports,
    },
    hono,
    `${pathName}.honoAuthority does not match the target tree.`,
  );
  if (probe.resolvedRealpath !== authority.moduleRealpath)
    invalid(`${pathName}.bareSpecifierProbe is not the target helper.`);

  if (options.verifyLiveProvenance !== false) {
    let actualRoot: string;
    try {
      actualRoot = await realpath(root);
    } catch {
      fail("E_PROVENANCE", `${pathName}.root is unavailable.`);
    }
    const gitRoot = await realpath(path.resolve(await git(root, ["rev-parse", "--show-toplevel"])));
    if (actualRoot !== root || gitRoot !== root) {
      fail("E_PROVENANCE", `${pathName}.root is not the canonical Git worktree root.`);
    }
    if ((await git(root, ["rev-parse", "HEAD"])) !== object.head) fail("E_HEAD_MISMATCH", `${pathName}.head drifted.`);
    const resolvedRegistryPath = resolveApiContextRegistrySource(root).relativePath;
    if (recordedRegistryPath !== resolvedRegistryPath) {
      fail(
        "E_PROVENANCE",
        `${pathName}.sourceFiles[0] does not match the API context registry path resolving under its recorded root.`,
      );
    }
    if (options.requireCleanTrees && (await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]))) {
      fail("E_WORKTREE_DIRTY", `${pathName}.root is dirty.`);
    }
    await validateLiveFile(root, effectiveTsconfig, `${pathName}.effectiveTsconfig`);
    for (let index = 0; index < sourceFiles.length; index += 1) {
      await validateLiveFile(root, sourceFiles[index], `${pathName}.sourceFiles[${index}]`);
    }
  }
  return { provenance: object as RouteCapture["provenance"], authority };
}

async function validateCapture(
  value: unknown,
  pathName: string,
  side: CaptureSide,
  options: ValidationOptions,
): Promise<RouteCapture> {
  const object = record(value, pathName, [
    "provenance",
    "counts",
    "grammarCoverage",
    "mountRecords",
    "censusRows",
    "duplicateGroups",
    "assemblyRows",
    "mountedBlockStart",
    "primitiveSha256",
  ]);
  const { provenance, authority } = await validateProvenance(
    object.provenance,
    `${pathName}.provenance`,
    side,
    options,
  );
  const mounts = array(object.mountRecords, `${pathName}.mountRecords`).map((item, index) =>
    validateMount(item, `${pathName}.mountRecords[${index}]`),
  );
  const census = array(object.censusRows, `${pathName}.censusRows`).map((item, index) =>
    validateCensusRow(item, `${pathName}.censusRows[${index}]`),
  );
  const assembly = array(object.assemblyRows, `${pathName}.assemblyRows`).map((item, index) =>
    validateAssemblyRow(item, `${pathName}.assemblyRows[${index}]`),
  );
  integer(object.mountedBlockStart, `${pathName}.mountedBlockStart`, 0);
  sha(object.primitiveSha256, `${pathName}.primitiveSha256`);

  let rowCursor = 1;
  let previousContext = "";
  let expectedContextOrdinal = 0;
  let expectedContextMountOrdinal = 0;
  for (let index = 0; index < mounts.length; index += 1) {
    const mount = mounts[index];
    if (
      mount.mountIndex !== index + 1 ||
      mount.rowStart !== rowCursor ||
      mount.routerOrdinal !== mount.contextMountOrdinal
    ) {
      invalid(`${pathName}.mountRecords do not form a contiguous mount/row partition.`);
    }
    if (mount.context !== previousContext) {
      previousContext = mount.context;
      expectedContextOrdinal += 1;
      expectedContextMountOrdinal = 1;
    } else expectedContextMountOrdinal += 1;
    if (mount.contextOrdinal !== expectedContextOrdinal || mount.contextMountOrdinal !== expectedContextMountOrdinal) {
      invalid(`${pathName}.mountRecords context ordinals are not contiguous.`);
    }
    if (mount.entryShape === "keyed" && mount.declaredContextMountOrdinal !== mount.contextMountOrdinal) {
      invalid(`${pathName}.mountRecords keyed declaration does not match position.`);
    }
    if (mount.entryShape === "positional" && mount.declaredContextMountOrdinal !== null) {
      invalid(`${pathName}.mountRecords positional declaration fabricated an ordinal.`);
    }
    for (let offset = 0; offset < mount.routeCount; offset += 1) {
      const row = census[rowCursor - 1 + offset];
      if (
        !row ||
        row.rowIndex !== rowCursor + offset ||
        row.mountIndex !== mount.mountIndex ||
        row.context !== mount.context ||
        row.contextOrdinal !== mount.contextOrdinal ||
        row.contextMountOrdinal !== mount.contextMountOrdinal ||
        row.declaredContextMountOrdinal !== mount.declaredContextMountOrdinal ||
        row.routerOrdinal !== mount.routerOrdinal ||
        row.routeOrdinal !== offset + 1 ||
        row.mountPath !== mount.mountPath ||
        row.mountKind !== mount.mountKind ||
        row.requiresAuth !== mount.requiresAuth
      ) {
        invalid(`${pathName}.censusRows do not map exactly to their source mounts.`);
      }
      const projection = deriveCollisionProjection(row.mountPath, row.rawPath, authority.helpers);
      exact(
        {
          combinedPath: row.combinedPath,
          acceptedPathProjections: row.acceptedPathProjections,
          collisionShape: row.collisionShape,
        },
        projection,
        `${pathName}.censusRows[${row.rowIndex - 1}] retained a false collision projection.`,
      );
    }
    rowCursor += mount.routeCount;
  }
  if (rowCursor !== census.length + 1) invalid(`${pathName}.mountRecords do not conserve every census row.`);

  const countsObject = record(object.counts, `${pathName}.counts`, [
    "contexts",
    "mounts",
    "routers",
    "distinctMountPaths",
    "zeroRouteMounts",
    "censusRecords",
    "censusAllRecords",
    "assemblyRecords",
    "assemblyAllRecords",
    "preMountRecords",
    "scanned",
    "total",
  ]);
  for (const [field, count] of Object.entries(countsObject)) integer(count, `${pathName}.counts.${field}`);
  exact(
    countsObject,
    deriveCounts(mounts, census, assembly),
    `${pathName}.counts do not conserve the primitive captures.`,
  );

  const coverage = record(object.grammarCoverage, `${pathName}.grammarCoverage`, [
    "targetVersion",
    "derivedMembers",
    "handled",
    "indeterminate",
  ]);
  string(coverage.targetVersion, `${pathName}.grammarCoverage.targetVersion`, { nonempty: true });
  integer(coverage.derivedMembers, `${pathName}.grammarCoverage.derivedMembers`);
  const handled = record(coverage.handled, `${pathName}.grammarCoverage.handled`, [
    "empty",
    "literal",
    "wildcard",
    "colonParameter",
  ]);
  for (const [field, count] of Object.entries(handled)) integer(count, `${pathName}.grammarCoverage.handled.${field}`);
  array(coverage.indeterminate, `${pathName}.grammarCoverage.indeterminate`).forEach((item, index) =>
    string(item, `${pathName}.grammarCoverage.indeterminate[${index}]`, { nonempty: true }),
  );
  const derivedCoverage = deriveGrammarCoverage(census, authority.helpers, authority.packageVersion);
  exact(coverage, derivedCoverage, `${pathName}.grammarCoverage is incomplete.`);
  if (derivedCoverage.indeterminate.length > 0)
    invalid(`${pathName}.grammarCoverage contains indeterminate target grammar members.`);

  const groups = array(object.duplicateGroups, `${pathName}.duplicateGroups`);
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = record(groups[groupIndex], `${pathName}.duplicateGroups[${groupIndex}]`, [
      "displayId",
      "method",
      "collisionShape",
      "memberOccurrences",
      "routeCount",
    ]);
    if (group.displayId !== `D${String(groupIndex + 1).padStart(3, "0")}`)
      invalid(`${pathName}.duplicateGroups display ID is invalid.`);
    string(group.method, `${pathName}.duplicateGroups[${groupIndex}].method`, { nonempty: true });
    array(group.collisionShape, `${pathName}.duplicateGroups[${groupIndex}].collisionShape`).forEach((item, index) =>
      string(item, `${pathName}.duplicateGroups[${groupIndex}].collisionShape[${index}]`, { nonempty: true }),
    );
    integer(group.routeCount, `${pathName}.duplicateGroups[${groupIndex}].routeCount`, 2);
    const occurrences = array(group.memberOccurrences, `${pathName}.duplicateGroups[${groupIndex}].memberOccurrences`);
    for (let occurrenceIndex = 0; occurrenceIndex < occurrences.length; occurrenceIndex += 1) {
      const occurrenceCount = record(
        occurrences[occurrenceIndex],
        `${pathName}.duplicateGroups[${groupIndex}].memberOccurrences[${occurrenceIndex}]`,
        ["occurrence", "count"],
      );
      integer(
        occurrenceCount.count,
        `${pathName}.duplicateGroups[${groupIndex}].memberOccurrences[${occurrenceIndex}].count`,
        1,
      );
      const occurrence = record(
        occurrenceCount.occurrence,
        `${pathName}.duplicateGroups[${groupIndex}].memberOccurrences[${occurrenceIndex}].occurrence`,
        ["context", "mountPath", "method", "rawPath", "combinedPath", "collisionShape", "handler"],
      );
      for (const field of ["context", "mountPath", "method", "rawPath", "combinedPath"] as const) {
        string(occurrence[field], `${pathName}.duplicateGroups occurrence.${field}`, { nonempty: true });
      }
      array(occurrence.collisionShape, `${pathName}.duplicateGroups occurrence.collisionShape`).forEach((item, index) =>
        string(item, `${pathName}.duplicateGroups occurrence.collisionShape[${index}]`, { nonempty: true }),
      );
      const occurrenceHandler = record(occurrence.handler, `${pathName}.duplicateGroups occurrence.handler`, [
        "name",
        "arity",
      ]);
      string(occurrenceHandler.name, `${pathName}.duplicateGroups occurrence.handler.name`, { nonempty: true });
      integer(occurrenceHandler.arity, `${pathName}.duplicateGroups occurrence.handler.arity`, 0, 100);
    }
  }
  exact(
    groups,
    deriveDuplicateGroups(census),
    `${pathName}.duplicateGroups omit, invent, reorder, or miscount a group.`,
  );

  const expectedMountedBlockStart = assembly.length - census.length;
  if (object.mountedBlockStart !== expectedMountedBlockStart) invalid(`${pathName}.mountedBlockStart violates D-A8.`);
  const mountPaths = new Set(mounts.map(({ mountPath }) => mountPath));
  for (let index = 0; index < assembly.length; index += 1) {
    const row = assembly[index];
    if (row.rowIndex !== index + 1) invalid(`${pathName}.assemblyRows indexes are not contiguous.`);
    if (index < expectedMountedBlockStart) {
      if (row.sourceCensusRowIndex !== null || row.sameHandlerReference !== null || mountPaths.has(row.basePath)) {
        invalid(`${pathName}.assemblyRows has a false pre-mount qualifier.`);
      }
    } else {
      const source = census[index - expectedMountedBlockStart];
      if (
        row.sourceCensusRowIndex !== source.rowIndex ||
        row.sameHandlerReference !== true ||
        row.method !== source.method ||
        row.path !== source.combinedPath ||
        !mountPaths.has(row.basePath) ||
        JSON.stringify(row.handler) !== JSON.stringify(source.handler)
      ) {
        invalid(`${pathName}.assemblyRows mounted tail violates D-A8.`);
      }
    }
  }

  const capture = object as RouteCapture;
  if (
    sha256(JSON.stringify(primitivePayload({ ...capture, primitiveSha256: undefined } as never))) !==
    object.primitiveSha256
  ) {
    invalid(`${pathName}.primitiveSha256 does not conserve its primitive capture.`);
  }
  return capture;
}

function artifactContent(artifact: Omit<RouteParityArtifact, "contentSha256">): unknown {
  return artifact;
}

export function createArtifact(
  generatedAt: string,
  harness: HarnessProvenance,
  base: RouteCapture,
  candidate: RouteCapture,
  expectedState: "empty" | "nonempty",
): RouteParityArtifact {
  const content = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    generatedAt,
    harness,
    collisionVector: collisionFixtureVector,
    base,
    candidate,
    comparison: compareCaptures(base, candidate, expectedState),
  } as const;
  return { ...content, contentSha256: sha256(JSON.stringify(artifactContent(content))) };
}

async function validateHarness(
  value: unknown,
  expectedHead: string,
  options: ValidationOptions,
): Promise<HarnessProvenance> {
  const object = record(value, "artifact.harness", ["root", "head", "runFile"]);
  const root = string(object.root, "artifact.harness.root", { nonempty: true });
  if (!path.isAbsolute(root)) invalid("artifact.harness.root must be absolute.");
  const actualHead = head(object.head, "artifact.harness.head");
  if (actualHead !== expectedHead) fail("E_HEAD_MISMATCH", "Harness head does not match --expect-harness-head.");
  const runFile = validateFileEvidence(object.runFile, "artifact.harness.runFile");
  if (runFile.relativePath !== "scripts/route-census/run.mts") invalid("artifact.harness.runFile is not canonical.");
  if (options.verifyLiveProvenance !== false) {
    const gitRoot = await realpath(path.resolve(await git(root, ["rev-parse", "--show-toplevel"])));
    if ((await realpath(root)) !== root || gitRoot !== root) fail("E_PROVENANCE", "Harness root is not canonical.");
    if ((await git(root, ["rev-parse", "HEAD"])) !== actualHead) fail("E_HEAD_MISMATCH", "Harness head drifted.");
    if (options.requireCleanTrees && (await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])))
      fail("E_WORKTREE_DIRTY", "Harness root is dirty.");
    await validateLiveFile(root, runFile, "artifact.harness.runFile");
  }
  return object as HarnessProvenance;
}

function validateSequenceDiffs<T>(
  diffs: unknown,
  pathName: string,
  validateRow: (value: unknown, pathName: string) => T,
): void {
  array(diffs, pathName).forEach((diff, index) => {
    const object = record(diff, `${pathName}[${index}]`, [
      "kind",
      "baseIndex",
      "candidateIndex",
      "changedFields",
      "base",
      "candidate",
    ]);
    if (!(["added", "removed", "changed"] as const).includes(object.kind as never))
      invalid(`${pathName}[${index}].kind is invalid.`);
    if (object.baseIndex !== null) integer(object.baseIndex, `${pathName}[${index}].baseIndex`, 1);
    if (object.candidateIndex !== null) integer(object.candidateIndex, `${pathName}[${index}].candidateIndex`, 1);
    array(object.changedFields, `${pathName}[${index}].changedFields`).forEach((field, fieldIndex) =>
      string(field, `${pathName}[${index}].changedFields[${fieldIndex}]`, { nonempty: true }),
    );
    if (object.base !== null) validateRow(object.base, `${pathName}[${index}].base`);
    if (object.candidate !== null) validateRow(object.candidate, `${pathName}[${index}].candidate`);
  });
}

function validateComparison(value: unknown): RouteComparison {
  const object = record(value, "artifact.comparison", [
    "expectedState",
    "actualState",
    "countDiffs",
    "mountDiffs",
    "censusDiffs",
    "duplicateGroupDiffs",
    "assemblyDiffs",
  ]);
  if (object.expectedState !== "empty" && object.expectedState !== "nonempty")
    invalid("artifact.comparison.expectedState is invalid.");
  if (object.actualState !== "empty" && object.actualState !== "nonempty")
    invalid("artifact.comparison.actualState is invalid.");
  array(object.countDiffs, "artifact.comparison.countDiffs").forEach((diff, index) => {
    const item = record(diff, `artifact.comparison.countDiffs[${index}]`, ["field", "base", "candidate"]);
    string(item.field, `artifact.comparison.countDiffs[${index}].field`, { nonempty: true });
    integer(item.base, `artifact.comparison.countDiffs[${index}].base`);
    integer(item.candidate, `artifact.comparison.countDiffs[${index}].candidate`);
  });
  validateSequenceDiffs(object.mountDiffs, "artifact.comparison.mountDiffs", validateMount);
  validateSequenceDiffs(object.censusDiffs, "artifact.comparison.censusDiffs", validateCensusRow);
  validateSequenceDiffs(object.assemblyDiffs, "artifact.comparison.assemblyDiffs", validateAssemblyRow);
  array(object.duplicateGroupDiffs, "artifact.comparison.duplicateGroupDiffs").forEach((diff, index) => {
    const item = record(diff, `artifact.comparison.duplicateGroupDiffs[${index}]`, [
      "kind",
      "method",
      "collisionShape",
      "baseMembers",
      "candidateMembers",
    ]);
    if (!(["added", "removed", "changed"] as const).includes(item.kind as never))
      invalid(`artifact.comparison.duplicateGroupDiffs[${index}].kind is invalid.`);
    string(item.method, `artifact.comparison.duplicateGroupDiffs[${index}].method`, { nonempty: true });
    array(item.collisionShape, `artifact.comparison.duplicateGroupDiffs[${index}].collisionShape`).forEach(
      (part, partIndex) =>
        string(part, `artifact.comparison.duplicateGroupDiffs[${index}].collisionShape[${partIndex}]`, {
          nonempty: true,
        }),
    );
    for (const side of ["baseMembers", "candidateMembers"] as const) {
      if (item[side] !== null) array(item[side], `artifact.comparison.duplicateGroupDiffs[${index}].${side}`);
    }
  });
  return object as RouteComparison;
}

export async function validateArtifactObject(
  value: unknown,
  expectations: ArtifactExpectations,
  options: ValidationOptions = {},
): Promise<RouteParityArtifact> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Artifact root must be an object.");
  const schemaVersion = (value as Record<string, unknown>).schemaVersion;
  if (schemaVersion !== ARTIFACT_SCHEMA_VERSION)
    fail("E_SCHEMA_MISMATCH", `Expected schema '${ARTIFACT_SCHEMA_VERSION}'.`);
  const object = record(value, "artifact", [
    "schemaVersion",
    "generatedAt",
    "harness",
    "collisionVector",
    "base",
    "candidate",
    "comparison",
    "contentSha256",
  ]);
  instant(object.generatedAt, "artifact.generatedAt");
  await validateHarness(object.harness, expectations.harnessHead, options);
  exact(
    object.collisionVector,
    collisionFixtureVector,
    "Artifact collision vector does not match the executable shared vector.",
  );
  const base = await validateCapture(object.base, "artifact.base", "base", options);
  const candidate = await validateCapture(object.candidate, "artifact.candidate", "candidate", options);
  if (!options.allowSameRootForTests && base.provenance.root === candidate.provenance.root) {
    invalid("Artifact base and candidate must be separately rooted worktrees.");
  }
  if (base.provenance.head !== expectations.baseHead) fail("E_HEAD_MISMATCH", "Base head does not match expectation.");
  if (candidate.provenance.head !== expectations.candidateHead)
    fail("E_HEAD_MISMATCH", "Candidate head does not match expectation.");
  if (expectations.baseRoot) {
    let expectedRoot: string;
    try {
      expectedRoot = await realpath(path.resolve(expectations.baseRoot));
    } catch {
      fail("E_PROVENANCE", "Expected base root is unavailable.");
    }
    if (base.provenance.root !== expectedRoot) fail("E_PROVENANCE", "Base root does not match expectation.");
  }
  if (expectations.candidateRoot) {
    let expectedRoot: string;
    try {
      expectedRoot = await realpath(path.resolve(expectations.candidateRoot));
    } catch {
      fail("E_PROVENANCE", "Expected candidate root is unavailable.");
    }
    if (candidate.provenance.root !== expectedRoot) fail("E_PROVENANCE", "Candidate root does not match expectation.");
  }
  const comparison = validateComparison(object.comparison);
  exact(
    comparison,
    compareCaptures(base, candidate, comparison.expectedState),
    "Artifact comparison is not the complete canonical comparison.",
  );
  if (!options.allowExpectationMismatchForParity && comparison.expectedState !== comparison.actualState) {
    invalid("Published artifact comparison does not match its invocation expectation.");
  }
  sha(object.contentSha256, "artifact.contentSha256");
  const content = {
    schemaVersion: object.schemaVersion,
    generatedAt: object.generatedAt,
    harness: object.harness,
    collisionVector: object.collisionVector,
    base: object.base,
    candidate: object.candidate,
    comparison: object.comparison,
  };
  if (sha256(JSON.stringify(content)) !== object.contentSha256)
    invalid("Artifact contentSha256 does not conserve the complete payload.");
  return object as RouteParityArtifact;
}
