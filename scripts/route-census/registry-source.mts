import { existsSync } from "node:fs";
import path from "node:path";
import { fail } from "./errors.mts";

export const apiContextRegistrySourcePaths = Object.freeze([
  "deployables/platform-api/src/context-registry.ts",
  "deployables/platform-api/src/generated/api-context-registry.ts",
] as const);

export const movedApiContextRegistrySourcePath = apiContextRegistrySourcePaths[0];
export const legacyApiContextRegistrySourcePath = apiContextRegistrySourcePaths[1];

export function resolveApiContextRegistrySource(targetRoot: string): {
  relativePath: (typeof apiContextRegistrySourcePaths)[number];
  absolutePath: string;
} {
  const matches = apiContextRegistrySourcePaths.filter((relativePath) =>
    existsSync(path.join(targetRoot, relativePath)),
  );
  if (matches.length === 0) {
    fail(
      "E_PROVENANCE",
      `Target root contains neither allowed API context registry path: '${apiContextRegistrySourcePaths.join("', '")}'.`,
    );
  }
  if (matches.length !== 1) {
    fail(
      "E_PROVENANCE",
      `Target root contains both allowed API context registry paths: '${apiContextRegistrySourcePaths.join("', '")}'.`,
    );
  }
  return { relativePath: matches[0], absolutePath: path.join(targetRoot, matches[0]) };
}
