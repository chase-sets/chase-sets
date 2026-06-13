import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repositoryRoot(): string {
  let candidate = process.cwd();
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate the repository root from ${process.cwd()}`);
    }
    candidate = parent;
  }
  return candidate;
}

const packageRoot = join(repositoryRoot(), "packages", "design-system");

function readPackageFile(path: string) {
  return readFileSync(resolve(packageRoot, path), "utf8");
}

function readRepoFile(path: string) {
  return readFileSync(resolve(repositoryRoot(), path), "utf8");
}

function designSystemImports(source: string) {
  return [...source.matchAll(/import\s*{([\s\S]*?)}\s*from\s*["']@chase-sets\/design-system["'];/g)]
    .map((match) => match[0] ?? "")
    .join("\n");
}

function scanFiles(directory: string): string[] {
  return readdirSync(resolve(repositoryRoot(), directory), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") {
      return [];
    }

    const entryPath = `${directory}/${entry.name}`;

    if (entry.isDirectory()) {
      return scanFiles(entryPath);
    }

    return [".ts", ".tsx"].some((extension) => entry.name.endsWith(extension)) ? [entryPath] : [];
  });
}

function discoverDesignSystemSymbolImports(scope: string, symbols: readonly string[]) {
  const files = scanFiles(scope);
  return Object.fromEntries(
    symbols.map((symbol) => [symbol, files.filter((file) => designSystemImports(readRepoFile(file)).includes(symbol))]),
  ) as Record<string, string[]>;
}

const referenceInfoGuidance = readPackageFile("REFERENCE_INFO.md");
const readme = readPackageFile("README.md");
const progressiveDisclosure = readPackageFile("PROGRESSIVE_DISCLOSURE.md");
const panelInteractions = readPackageFile("PANEL_INTERACTIONS.md");
const marketplaceSystem = readPackageFile("MARKETPLACE_SYSTEM.md");
const feedbackExports = readPackageFile("src/components/feedback/index.ts");
const docsIndex = readRepoFile("docs/README.md");

const standardizedReferenceInfoSurfaces = [
  {
    name: "Catalog admin reference data",
    scope: "bounded-contexts/catalog/features/catalog-items/ui",
  },
  {
    name: "Discovery item reference data",
    scope: "bounded-contexts/discovery/features/item-detail/ui",
  },
  {
    name: "Discovery marketplace rail details",
    scope: "bounded-contexts/discovery/features/item-detail/ui/commerce",
  },
  {
    name: "Checkout Sell List terms",
    scope: "bounded-contexts/checkout/features/sell-list/ui",
  },
];

describe("Reference Info guidance", () => {
  it("documents Reference Info as the canonical popup primitive", () => {
    expect(referenceInfoGuidance).toContain("# Reference Info Popup");
    expect(referenceInfoGuidance).toContain("Use `ReferenceInfoTrigger` with `ReferenceInfoDialog`");
    expect(referenceInfoGuidance).toContain(
      "Admin, marketplace, and checkout surfaces should not create competing tooltip, popover, or local dialog treatments",
    );
    expect(referenceInfoGuidance).toContain("## Wrapper Rule");
    expect(referenceInfoGuidance).toContain("import `ReferenceInfoTrigger` and `ReferenceInfoDialog`");
    expect(referenceInfoGuidance).toContain("## Privacy And Telemetry");
    expect(referenceInfoGuidance).toContain("Do not expose private contact, shipping destination");
  });

  it("keeps the primitive exported from the design-system feedback package", () => {
    expect(feedbackExports).toContain('export { ReferenceInfoDialog, ReferenceInfoTrigger } from "./reference-info"');
    expect(feedbackExports).toContain(
      "export type { ReferenceInfoDialogProps, ReferenceInfoSection, ReferenceInfoTriggerProps }",
    );
  });

  it("links the canonical pattern from related design-system guidance", () => {
    for (const document of [readme, progressiveDisclosure, panelInteractions, marketplaceSystem]) {
      expect(document).toContain("Reference Info Popup");
      expect(document).toContain("./REFERENCE_INFO.md");
    }

    expect(docsIndex).toContain("[Reference Info Popup](../packages/design-system/REFERENCE_INFO.md)");
  });

  it("keeps current admin and marketplace reference details on the shared primitive", () => {
    for (const surface of standardizedReferenceInfoSurfaces) {
      const symbolFiles = discoverDesignSystemSymbolImports(surface.scope, [
        "ReferenceInfoDialog",
        "ReferenceInfoTrigger",
      ]);
      const discoveredFiles = [...new Set(Object.values(symbolFiles).flat())];

      expect(
        symbolFiles.ReferenceInfoDialog,
        `${surface.name} should import the shared dialog primitive in scope`,
      ).not.toHaveLength(0);
      expect(
        symbolFiles.ReferenceInfoTrigger,
        `${surface.name} should import the shared trigger primitive in scope`,
      ).not.toHaveLength(0);

      for (const file of discoveredFiles) {
        const imports = designSystemImports(readRepoFile(file));
        expect(imports, `${surface.name} should use the design-system import boundary in ${file}`).toContain(
          "@chase-sets/design-system",
        );
        expect(
          imports,
          `${surface.name} should not import Popover for structured reference detail in ${file}`,
        ).not.toMatch(/\bPopover\b/);
        expect(
          imports,
          `${surface.name} should not import Tooltip for structured reference detail in ${file}`,
        ).not.toMatch(/\bTooltip\b/);
      }

      expect(discoveredFiles, `${surface.name} should discover scoped Reference Info files`).toEqual(
        [...discoveredFiles].sort(),
      );
    }
  });
});
