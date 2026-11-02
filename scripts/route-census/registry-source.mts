import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";

export const LEGACY_API_REGISTRY_PATH = "deployables/platform-api/src/generated/api-context-registry.ts";
export const CURRENT_API_REGISTRY_PATH = "deployables/platform-api/src/context-registry.ts";
export const CLOSED_API_REGISTRY_PATHS = Object.freeze([LEGACY_API_REGISTRY_PATH, CURRENT_API_REGISTRY_PATH]);

function normalizeRoot(root: string): string {
  return realpathSync(path.resolve(root));
}

function trackedPath(root: string, relativePath: string): string | null {
  try {
    const output = execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", relativePath], {
      encoding: "utf8",
      maxBuffer: GIT_LISTING_MAX_BUFFER,
      windowsHide: true,
    }).trim();
    return output === relativePath ? output : null;
  } catch {
    return null;
  }
}

function contained(root: string, relativePath: string): boolean {
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export type RegistrySource = Readonly<{
  root: string;
  relativePath: string;
  absolutePath: string;
  legacy: boolean;
}>;

export function resolveApiRegistrySource(
  rootInput: string,
  options: Readonly<{ allowLegacy?: boolean }> = {},
): RegistrySource {
  const root = normalizeRoot(rootInput);
  const candidates = options.allowLegacy === false ? [CURRENT_API_REGISTRY_PATH] : CLOSED_API_REGISTRY_PATHS;
  const found = candidates.filter((relativePath) => {
    if (!contained(root, relativePath) || !existsSync(path.join(root, relativePath))) return false;
    return trackedPath(root, relativePath) === relativePath;
  });
  if (found.length !== 1) {
    throw new Error(
      found.length === 0
        ? `No tracked API context registry at the permitted paths under '${root}'.`
        : `Ambiguous API context registry paths under '${root}': ${found.join(", ")}.`,
    );
  }
  const relativePath = found[0];
  return {
    root,
    relativePath,
    absolutePath: path.join(root, relativePath),
    legacy: relativePath === LEGACY_API_REGISTRY_PATH,
  };
}

export const resolveRegistrySource = resolveApiRegistrySource;
