import { execFile as execFileCallback } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fail } from "./errors.mts";
import { isPathInside } from "./target-authority.mts";

const execFile = promisify(execFileCallback);

// The closed set of API context registry sources a capture may import. A
// pre-move base tree carries only the legacy generated module; every later tree
// carries only the hand-authored module.
export const LEGACY_API_REGISTRY_SOURCE = "deployables/platform-api/src/generated/api-context-registry.ts";
export const API_REGISTRY_SOURCE = "deployables/platform-api/src/context-registry.ts";
export const API_REGISTRY_SOURCES: readonly string[] = Object.freeze([LEGACY_API_REGISTRY_SOURCE, API_REGISTRY_SOURCE]);

export type CaptureSide = "base" | "candidate";

export type ApiRegistrySource = Readonly<{
  relativePath: string;
  absolutePath: string;
}>;

export function admittedApiRegistrySources(side: CaptureSide): readonly string[] {
  return side === "base" ? API_REGISTRY_SOURCES : [API_REGISTRY_SOURCE];
}

// Walks the native directory entries segment by segment so a case-insensitive
// filesystem cannot stand in a differently spelled tree for the closed path.
// Returns the on-disk spelling when the path exists only under another case.
async function onDiskSpelling(root: string, segments: readonly string[]): Promise<"exact" | "absent" | string> {
  let directory = root;
  const spelled: string[] = [];
  for (const segment of segments) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return "absent";
    }
    const name = names.includes(segment)
      ? segment
      : names.find((candidate) => candidate.toLowerCase() === segment.toLowerCase());
    if (name === undefined) return "absent";
    spelled.push(name);
    directory = path.join(directory, name);
  }
  return spelled.every((name, index) => name === segments[index]) ? "exact" : spelled.join("/");
}

async function trackedWithExactSpelling(root: string, relativePath: string): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--full-name", "--", `:(literal)${relativePath}`],
      { encoding: "utf8", windowsHide: true },
    ));
  } catch {
    fail("E_PROVENANCE", `Git tracked-source query failed for '${root}'.`);
  }
  return stdout === `${relativePath}\0`;
}

async function resolveCandidate(root: string, relativePath: string): Promise<ApiRegistrySource | null> {
  const segments = relativePath.split("/");
  const spelling = await onDiskSpelling(root, segments);
  if (spelling === "absent") return null;
  if (spelling !== "exact") {
    fail("E_PROVENANCE", `API context registry '${relativePath}' is spelled '${spelling}' under '${root}'.`);
  }
  const absolutePath = path.join(root, ...segments);
  if (!(await lstat(absolutePath)).isFile()) {
    fail("E_PROVENANCE", `API context registry '${relativePath}' is not a plain file under '${root}'.`);
  }
  if (!(await trackedWithExactSpelling(root, relativePath))) {
    fail(
      "E_PROVENANCE",
      `API context registry '${relativePath}' is not Git-tracked with that spelling under '${root}'.`,
    );
  }
  const resolvedPath = await realpath(absolutePath);
  if (resolvedPath !== absolutePath || !isPathInside(root, resolvedPath)) {
    fail("E_PROVENANCE", `API context registry '${relativePath}' does not resolve inside '${root}'.`);
  }
  return { relativePath, absolutePath };
}

// Resolves independently under one target root: exactly one closed source must
// be present with exact spelling, Git-tracked, and contained in that root.
export async function resolveApiRegistrySource(rootInput: string): Promise<ApiRegistrySource> {
  let root: string;
  try {
    root = await realpath(path.resolve(rootInput));
  } catch {
    fail("E_PROVENANCE", `Target root '${rootInput}' is unavailable.`);
  }
  const resolved: ApiRegistrySource[] = [];
  for (const relativePath of API_REGISTRY_SOURCES) {
    const source = await resolveCandidate(root, relativePath);
    if (source) resolved.push(source);
  }
  if (resolved.length !== 1) {
    fail(
      "E_PROVENANCE",
      resolved.length === 0
        ? `No API context registry resolves under '${root}'; expected exactly one of ${API_REGISTRY_SOURCES.join(", ")}.`
        : `Both legacy and current API context registries resolve under '${root}'.`,
    );
  }
  return resolved[0];
}

export function assertAdmittedApiRegistrySource(side: CaptureSide, relativePath: unknown, pathName: string): void {
  if (typeof relativePath !== "string" || !admittedApiRegistrySources(side).includes(relativePath)) {
    fail("E_ARTIFACT_INVALID", `${pathName} is not an admitted ${side} API context registry.`);
  }
}

export async function assertRecordedApiRegistrySource(
  root: string,
  side: CaptureSide,
  relativePath: unknown,
  pathName: string,
): Promise<void> {
  assertAdmittedApiRegistrySource(side, relativePath, pathName);
  const resolved = await resolveApiRegistrySource(root);
  if (resolved.relativePath !== relativePath) {
    fail("E_PROVENANCE", `${pathName} does not resolve under its recorded root; '${resolved.relativePath}' does.`);
  }
}
