import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fail } from "./errors.mts";

export type TargetHonoUrlHelpers = Readonly<{
  mergePath: (...paths: string[]) => string;
  checkOptionalParameter: (routePath: string) => string[] | null;
  splitRoutingPath: (routePath: string) => string[];
  getPattern: (label: string, next?: string) => readonly [string, string, RegExp | true] | "*" | null;
}>;

export type TargetHonoAuthority = Readonly<{
  specifier: "hono/utils/url";
  packageVersion: string;
  packageRealpath: string;
  moduleRealpath: string;
  moduleSha256: string;
  helperExports: readonly ["mergePath", "checkOptionalParameter", "splitRoutingPath", "getPattern"];
  helpers: TargetHonoUrlHelpers;
}>;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function findPackageRoot(resolvedCjsModule: string): Promise<string> {
  let current = path.dirname(resolvedCjsModule);
  while (true) {
    const packagePath = path.join(current, "package.json");
    try {
      const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { name?: unknown };
      if (parsed.name === "hono") return await realpath(current);
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) fail("E_PROVENANCE", "Unable to locate the target Hono package root.");
    current = parent;
  }
}

function resolveImportExport(packageJson: Record<string, unknown>): string {
  const exportsValue = packageJson.exports;
  if (!exportsValue || typeof exportsValue !== "object" || Array.isArray(exportsValue)) {
    fail("E_PROVENANCE", "Target Hono package exports are unavailable.");
  }
  const wildcard = (exportsValue as Record<string, unknown>)["./utils/*"];
  if (!wildcard || typeof wildcard !== "object" || Array.isArray(wildcard)) {
    fail("E_PROVENANCE", "Target Hono utils export is unavailable.");
  }
  const importTarget = (wildcard as Record<string, unknown>).import;
  if (typeof importTarget !== "string" || !importTarget.includes("*")) {
    fail("E_PROVENANCE", "Target Hono utils import export is invalid.");
  }
  return importTarget.replaceAll("*", "url");
}

export async function loadTargetHonoAuthority(targetRootInput: string): Promise<TargetHonoAuthority> {
  let targetRoot: string;
  try {
    targetRoot = await realpath(path.resolve(targetRootInput));
  } catch {
    fail("E_PROVENANCE", `Target root is unavailable: '${path.resolve(targetRootInput)}'.`);
  }
  const platformPackage = path.join(targetRoot, "deployables", "platform-api", "package.json");
  try {
    if (!(await stat(platformPackage)).isFile()) throw new Error("not a file");
  } catch {
    fail("E_PROVENANCE", `Target platform-api package is missing below '${targetRoot}'.`);
  }

  const targetRequire = createRequire(pathToFileURL(platformPackage));
  let resolvedCjs: string;
  try {
    resolvedCjs = targetRequire.resolve("hono/utils/url");
  } catch (error) {
    fail("E_PROVENANCE", `Target root cannot resolve bare specifier 'hono/utils/url': ${String(error)}.`);
  }
  const packageRoot = await findPackageRoot(resolvedCjs);
  if (!isPathInside(targetRoot, packageRoot)) {
    fail("E_PROVENANCE", `Target Hono resolved outside '${targetRoot}'.`);
  }
  const packageRealpath = await realpath(path.join(packageRoot, "package.json"));
  const packageJson = JSON.parse(await readFile(packageRealpath, "utf8")) as Record<string, unknown>;
  if (packageJson.name !== "hono" || typeof packageJson.version !== "string") {
    fail("E_PROVENANCE", "Target Hono package identity is invalid.");
  }
  const importTarget = resolveImportExport(packageJson);
  const moduleRealpath = await realpath(path.resolve(packageRoot, importTarget));
  if (!isPathInside(packageRoot, moduleRealpath) || !isPathInside(targetRoot, moduleRealpath)) {
    fail("E_PROVENANCE", "Target Hono URL module escaped its target package/root.");
  }
  const moduleBytes = await readFile(moduleRealpath);
  const namespace = (await import(pathToFileURL(moduleRealpath).href)) as Record<string, unknown>;
  const helperNames = ["mergePath", "checkOptionalParameter", "splitRoutingPath", "getPattern"] as const;
  for (const helperName of helperNames) {
    if (typeof namespace[helperName] !== "function") {
      fail("E_PROVENANCE", `Target Hono URL module does not export '${helperName}'.`);
    }
  }

  return {
    specifier: "hono/utils/url",
    packageVersion: packageJson.version,
    packageRealpath,
    moduleRealpath,
    moduleSha256: sha256(moduleBytes),
    helperExports: helperNames,
    helpers: {
      mergePath: namespace.mergePath as TargetHonoUrlHelpers["mergePath"],
      checkOptionalParameter: namespace.checkOptionalParameter as TargetHonoUrlHelpers["checkOptionalParameter"],
      splitRoutingPath: namespace.splitRoutingPath as TargetHonoUrlHelpers["splitRoutingPath"],
      getPattern: namespace.getPattern as TargetHonoUrlHelpers["getPattern"],
    },
  };
}
