import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readPackageFile(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function readRepoFile(path: string) {
  return readFileSync(resolve(process.cwd(), "..", "..", path), "utf8");
}

function designSystemImports(source: string) {
  return [...source.matchAll(/import\s*{([\s\S]*?)}\s*from\s*"@chase-sets\/design-system";/g)]
    .map((match) => match[0] ?? "")
    .join("\n");
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
    path: "bounded-contexts/catalog/features/catalog-items/ui/catalog-item-detail-page.tsx",
  },
  {
    name: "Discovery item reference data",
    path: "bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx",
  },
  {
    name: "Discovery marketplace rail details",
    path: "bounded-contexts/discovery/features/item-detail/ui/commerce-sections.tsx",
  },
  {
    name: "Checkout Sell List terms",
    path: "bounded-contexts/checkout/features/sell-list/ui/sell-list-page.tsx",
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
      const source = readRepoFile(surface.path);
      const imports = designSystemImports(source);

      expect(imports, `${surface.name} should use the design-system import boundary`).toContain(
        "@chase-sets/design-system",
      );
      expect(imports, `${surface.name} should import the shared dialog primitive`).toContain("ReferenceInfoDialog");
      expect(imports, `${surface.name} should import the shared trigger primitive`).toContain("ReferenceInfoTrigger");
      expect(imports, `${surface.name} should not import Popover for structured reference detail`).not.toMatch(
        /\bPopover\b/,
      );
      expect(imports, `${surface.name} should not import Tooltip for structured reference detail`).not.toMatch(
        /\bTooltip\b/,
      );
    }
  });
});
