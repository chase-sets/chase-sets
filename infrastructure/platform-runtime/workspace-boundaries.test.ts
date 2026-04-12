import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apiContextRegistry } from "../../deployables/platform-api/src/generated/api-context-registry";
import { webContextRegistry as adminWebContextRegistry } from "../../deployables/admin-web/app/generated/web-context-registry";
import { webContextRegistry as marketplaceWebContextRegistry } from "../../deployables/marketplace/app/generated/web-context-registry";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const workspaceRoots = ["bounded-contexts", "contracts", "infrastructure", "packages", "deployables"];

function readJson(filePath: string) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function normalizeRelative(filePath: string) {
  return `./${path.relative(repoRoot, filePath).replaceAll("\\", "/")}`;
}

function toExportsObject(exportsField: unknown): Record<string, string> {
  if (typeof exportsField === "string") {
    return { ".": exportsField };
  }

  return (exportsField ?? {}) as Record<string, string>;
}

function listWorkspacePackages() {
  const workspaces: Array<{
    name: string;
    dir: string;
    exports: Record<string, string>;
  }> = [];

  for (const workspaceRoot of workspaceRoots) {
    const rootPath = path.join(repoRoot, workspaceRoot);

    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packageJsonPath = path.join(rootPath, entry.name, "package.json");

      try {
        const packageJson = readJson(packageJsonPath);
        workspaces.push({
          name: packageJson.name,
          dir: path.dirname(packageJsonPath),
          exports: toExportsObject(packageJson.exports),
        });
      } catch {
        // Ignore directories that are not workspace packages.
      }
    }
  }

  return workspaces.sort((left, right) => left.name.localeCompare(right.name));
}

function buildExpectedPaths() {
  const aliases: Record<string, string[]> = {};

  for (const workspace of listWorkspacePackages()) {
    for (const [exportKey, exportTarget] of Object.entries(workspace.exports)) {
      if (typeof exportTarget !== "string") {
        continue;
      }

      const targetPath = normalizeRelative(
        path.join(workspace.dir, exportTarget.replace(/^\.\//, "")),
      );

      if (exportKey === ".") {
        aliases[workspace.name] = [targetPath];
        continue;
      }

      const exportSuffix = exportKey.replace(/^\.\//, "");
      aliases[`${workspace.name}/${exportSuffix}`] = [targetPath];
    }
  }

  return Object.fromEntries(
    Object.entries(aliases).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function readFilesRecursively(rootPath: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "build" ||
      entry.name === ".react-router"
    ) {
      continue;
    }

    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...readFilesRecursively(fullPath));
      continue;
    }

    if (/\.test\.(ts|tsx)$/.test(entry.name)) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

describe("workspace metadata", () => {
  it("keeps tsconfig aliases aligned to workspace exports", () => {
    const tsconfigBase = readJson(path.join(repoRoot, "tsconfig.base.json"));

    expect(tsconfigBase.compilerOptions.paths).toEqual(buildExpectedPaths());
  });

  it("keeps canonical hosts free of legacy deployable references", () => {
    const forbiddenTokens = [
      "catalog-admin",
      "catalog-api",
      "identity-admin",
      "identity-api",
      "inventory-api",
      "marketplace-api",
      "platform-ingress",
      "generate-deployable-",
      "deployable-route-support",
      "deployable-shell-support",
      "deployable-api-mount-support",
      "deployable-runtime-support",
      "deployable-lifecycle-support",
    ];
    const scanRoots = [
      path.join(repoRoot, "package.json"),
      path.join(repoRoot, "tailwind.config.ts"),
      path.join(repoRoot, "scripts", "dev-system.mjs"),
      path.join(repoRoot, "scripts", "replay-projection.ts"),
      path.join(repoRoot, "infrastructure", "platform-runtime"),
      path.join(repoRoot, "deployables", "platform-api"),
      path.join(repoRoot, "deployables", "admin-web"),
      path.join(repoRoot, "deployables", "marketplace"),
    ];

    const files = scanRoots.flatMap((scanRoot) => {
      if (scanRoot.endsWith(".json") || scanRoot.endsWith(".mjs") || scanRoot.endsWith(".ts")) {
        return [scanRoot];
      }

      return readFilesRecursively(scanRoot);
    });

    for (const filePath of files) {
      const content = readFileSync(filePath, "utf8");

      for (const token of forbiddenTokens) {
        expect(content).not.toContain(token);
      }
    }
  });

  it("keeps platform-runtime imports explicit by runtime", () => {
    const sourceRoots = [
      path.join(repoRoot, "deployables", "platform-api", "src"),
      path.join(repoRoot, "deployables", "admin-web", "app"),
      path.join(repoRoot, "deployables", "marketplace", "app"),
    ];

    const files = sourceRoots.flatMap((sourceRoot) => readFilesRecursively(sourceRoot));

    for (const filePath of files) {
      const content = readFileSync(filePath, "utf8");

      if (filePath.includes(path.join("deployables", "platform-api"))) {
        expect(content).not.toContain('"@chase-sets/platform-runtime/web"');
        expect(content).not.toContain('"@chase-sets/platform-runtime/web-route-config"');
      } else {
        expect(content).not.toContain('"@chase-sets/platform-runtime/api"');
      }
    }
  });

  it("uses deployable-owned generated registries instead of platform-runtime generated registries", () => {
    expect(apiContextRegistry.some((entry) => entry.contextName === "auth")).toBe(true);
    expect(adminWebContextRegistry.some((entry) => entry.contextName === "catalog")).toBe(true);
    expect(
      marketplaceWebContextRegistry.some((entry) => entry.contextName === "marketplace"),
    ).toBe(true);

    const platformRuntimeFiles = readFilesRecursively(
      path.join(repoRoot, "infrastructure", "platform-runtime"),
    ).map((filePath) => path.basename(filePath));

    expect(platformRuntimeFiles).not.toContain("api-context-registry.generated.ts");
    expect(platformRuntimeFiles).not.toContain("web-context-registry.generated.ts");
  });
});
