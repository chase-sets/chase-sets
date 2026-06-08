import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const legacyAdminPrimitivePattern =
  /\bUi(?:Page|PageHeader|PageSection|Table|TableBody|TableCell|TableHead|TableHeader|TableRow)\b/;
const unsafeAdminMarketplaceLinkPattern = /(?:href|to)=\{?`?["']?\/account[/?]/;
const ignoredDirectories = new Set(["build", "dist", "generated", "node_modules"]);
const importPattern = /import(?:\s+type)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g;

function collectTsxFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    if (ignoredDirectories.has(entry)) {
      return [];
    }

    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);

    if (stats.isDirectory()) {
      return collectTsxFiles(absolutePath);
    }

    return absolutePath.endsWith(".tsx") ? [absolutePath] : [];
  });
}

function collectAdminRouteFiles() {
  return [
    ...collectTsxFiles(path.join(repoRoot, "deployables/admin-web/app/routes")),
    ...readdirSync(path.join(repoRoot, "bounded-contexts")).flatMap((contextName) => {
      const contextPath = path.join(repoRoot, "bounded-contexts", contextName);

      if (!statSync(contextPath).isDirectory()) {
        return [];
      }

      const adminRoutesPath = path.join(contextPath, "routes", "admin");

      try {
        return collectTsxFiles(adminRoutesPath);
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          return [];
        }

        throw error;
      }
    }),
  ];
}

function relativePath(filePath: string): string {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

function toSourceFile(importer: string, importPath: string) {
  if (!importPath.startsWith(".")) {
    return null;
  }

  const resolved = path.resolve(path.dirname(importer), importPath);
  const candidates = [resolved, `${resolved}.tsx`, `${resolved}.ts`, path.join(resolved, "index.tsx")];
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function isFeatureUiSource(filePath: string) {
  return relativePath(filePath).includes("/features/") && relativePath(filePath).includes("/ui/");
}

function importedSourceFiles(filePath: string) {
  const source = readFileSync(filePath, "utf8");
  return [...source.matchAll(importPattern)].flatMap((match) => {
    const importPath = match[1];
    if (!importPath) {
      return [];
    }

    const resolved = toSourceFile(filePath, importPath);
    return resolved ? [resolved] : [];
  });
}

function collectAdminRenderedFeatureUiFiles() {
  const seen = new Set<string>();
  const pending = collectAdminRouteFiles().flatMap(importedSourceFiles).filter(isFeatureUiSource);

  while (pending.length > 0) {
    const next = pending.pop();

    if (!next || seen.has(next)) {
      continue;
    }

    seen.add(next);

    for (const imported of importedSourceFiles(next)) {
      if (isFeatureUiSource(imported) && !seen.has(imported)) {
        pending.push(imported);
      }
    }
  }

  return [...seen].sort();
}

describe("admin web primitive usage", () => {
  it("keeps admin routes and rendered feature UI on canonical page and table primitives", () => {
    const adminRouteFiles = [...collectAdminRouteFiles(), ...collectAdminRenderedFeatureUiFiles()];

    const offenders = adminRouteFiles
      .filter((filePath) => legacyAdminPrimitivePattern.test(readFileSync(filePath, "utf8")))
      .map(relativePath);

    expect(offenders).toEqual([]);
  });

  it("keeps admin-rendered feature UI from introducing same-host marketplace account links", () => {
    const offenders = collectAdminRenderedFeatureUiFiles()
      .filter((filePath) => unsafeAdminMarketplaceLinkPattern.test(readFileSync(filePath, "utf8")))
      .map(relativePath);

    expect(offenders).toEqual([]);
  });

  it("discovers feature UI rendered by admin routes", () => {
    expect(collectAdminRenderedFeatureUiFiles().map(relativePath)).toEqual(
      expect.arrayContaining([
        "bounded-contexts/support/features/support-requests/ui/support-operations-page.tsx",
        "bounded-contexts/experience/features/platform-feedback/ui/admin-pages.tsx",
        "bounded-contexts/public-presence/features/promo-bar/ui/admin-pages.tsx",
        "bounded-contexts/platform-operations/features/projection-operations/ui/projection-operations-page.tsx",
      ]),
    );
  });
});
