import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const legacyAdminPrimitivePattern =
  /\bUi(?:Page|PageHeader|PageSection|Table|TableBody|TableCell|TableHead|TableHeader|TableRow)\b/;
const unsafeAdminMarketplaceLinkPattern = /(?:href|to)=\{?`?["']?\/account[/?]/;
const unsafeAdminPublicRelativeLinkPattern =
  /(?:href|to)=\{?`?["']?\/(?:contact|faq|items|listings|order-protection|privacy|refunds-and-returns|sales-fees|search|terms)(?:[/?#]|[`"'])/;
const embeddedObservabilityDashboardPattern =
  /\b(?:histogram_quantile|rate|increase)\s*\(|\b(?:PromQL|LogQL|datasourceUid|datasource|legendFormat)\b|_bucket\b/i;
const ignoredDirectories = new Set(["build", "dist", "generated", "node_modules"]);
const importPattern = /import(?:\s+type)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g;
const literalHrefPattern = /\b(?:href|to)=\{?([`"'])(\/[^`"']*)\1/g;
const adminSectionPrefixes = new Set(["access", "catalog", "commerce", "growth", "platform", "support"]);
const featureContextAdminSections = new Map([
  ["auth", "access"],
  ["catalog", "catalog"],
  ["commercial-terms", "commerce"],
  ["discovery", "growth"],
  ["identity", "access"],
  ["ordering", "commerce"],
  ["platform-operations", "platform"],
  ["public-presence", "growth"],
  ["settlement", "commerce"],
]);
const featureSliceAdminSections = new Map([
  ["platform-operations/features/platform-feedback", "support"],
  ["platform-operations/features/reported-content", "support"],
  ["platform-operations/features/risk-alerts", "support"],
  ["platform-operations/features/support-requests", "support"],
]);

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

function adminSectionForFeatureUi(filePath: string) {
  const relative = relativePath(filePath);

  for (const [slicePrefix, section] of featureSliceAdminSections) {
    if (relative.startsWith(`bounded-contexts/${slicePrefix}/`)) {
      return section;
    }
  }

  const [, contextName] = /^bounded-contexts\/([^/]+)\//.exec(relative) ?? [];
  return contextName ? featureContextAdminSections.get(contextName) : undefined;
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

function literalHrefSection(pathname: string) {
  const [section] = pathname.slice(1).split(/[/?#]/);
  return adminSectionPrefixes.has(section ?? "") ? section : null;
}

function crossSectionLinkOffenders(filePath: string) {
  const source = readFileSync(filePath, "utf8");
  const owningSection = adminSectionForFeatureUi(filePath);

  if (!owningSection) {
    return [];
  }

  return [...source.matchAll(literalHrefPattern)].flatMap((match) => {
    const href = match[2];
    const targetSection = href ? literalHrefSection(href) : null;

    if (!targetSection || targetSection === owningSection) {
      return [];
    }

    const beforeHref = source.slice(Math.max(0, match.index - 350), match.index);
    if (beforeHref.includes("hasPermission(actorPermissions")) {
      return [];
    }

    return [`${relativePath(filePath)} -> ${href}`];
  });
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

  it("keeps admin-rendered feature UI from introducing public-relative links that bind to the admin host", () => {
    const offenders = collectAdminRenderedFeatureUiFiles()
      .filter((filePath) => unsafeAdminPublicRelativeLinkPattern.test(readFileSync(filePath, "utf8")))
      .map(relativePath);

    expect(offenders).toEqual([]);
  });

  it("keeps same-host cross-section admin links permission-aware", () => {
    const offenders = collectAdminRenderedFeatureUiFiles().flatMap(crossSectionLinkOffenders);

    expect(offenders).toEqual([]);
  });

  it("keeps admin-rendered UI from embedding observability dashboard primitives", () => {
    const offenders = [...collectAdminRouteFiles(), ...collectAdminRenderedFeatureUiFiles()].flatMap((filePath) => {
      const match = embeddedObservabilityDashboardPattern.exec(readFileSync(filePath, "utf8"));
      return match ? [`${relativePath(filePath)} -> ${match[0]}`] : [];
    });

    expect(offenders).toEqual([]);
  });

  it("discovers feature UI rendered by admin routes", () => {
    expect(collectAdminRenderedFeatureUiFiles().map(relativePath)).toEqual(
      expect.arrayContaining([
        "bounded-contexts/platform-operations/features/support-requests/ui/support-operations-page.tsx",
        "bounded-contexts/platform-operations/features/platform-feedback/ui/admin-pages.tsx",
        "bounded-contexts/public-presence/features/promo-bar/ui/admin-pages.tsx",
        "bounded-contexts/platform-operations/features/projection-operations/ui/projection-operations-page.tsx",
      ]),
    );
  });
});
