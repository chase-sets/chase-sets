import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const legacyAdminPrimitivePattern =
  /\bUi(?:Page|PageHeader|PageSection|Table|TableBody|TableCell|TableHead|TableHeader|TableRow)\b/;
const ignoredDirectories = new Set(["build", "dist", "generated", "node_modules"]);

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

function relativePath(filePath: string): string {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

describe("admin web primitive usage", () => {
  it("keeps admin routes and operations admin surfaces on canonical page and table primitives", () => {
    const adminRouteFiles = [
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
      path.join(repoRoot, "bounded-contexts/support/features/support-requests/ui/support-operations-page.tsx"),
    ];

    const offenders = adminRouteFiles
      .filter((filePath) => legacyAdminPrimitivePattern.test(readFileSync(filePath, "utf8")))
      .map(relativePath);

    expect(offenders).toEqual([]);
  });
});
