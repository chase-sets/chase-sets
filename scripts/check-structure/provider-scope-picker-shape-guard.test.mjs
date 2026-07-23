import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateProviderScopePickerShapeGuard } from "./provider-scope-picker-shape-guard.mjs";

const roots = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("provider scope-picker shape guard", () => {
  it("rejects an if/else-if provider-key-keyed scope picker at an arbitrary path with no picker vocabulary", async () => {
    // The path and identifiers deliberately avoid "scope", "picker", or
    // "catalog" — discovery must be by code shape, not filename.
    const plantedPath = "bounded-contexts/inventory/features/restock-planning/ui/vendor-source-panel.tsx";
    const root = await fixture({
      [plantedPath]: `
        export function VendorSourcePanel({ providerKey }: { providerKey: string | null }) {
          if (providerKey === "tcgplayer") {
            return <Select name="productLineId" label="Product line" items={[]} />;
          } else if (providerKey === "scryfall") {
            return <Select name="expansionId" label="Expansion" items={[]} />;
          }
          return <Select name="seriesId" label="Series" items={[]} />;
        }
      `,
    });

    const result = await validateProviderScopePickerShapeGuard({ repoRoot: root });
    expect(result.discovery).toMatchObject({ scannedFiles: 1 });
    expect(result.discovery.candidateSurfaces).toBeGreaterThan(0);
    expect(result.violations).toEqual([
      expect.stringContaining(`${plantedPath}:`),
      expect.stringContaining(`${plantedPath}:`),
    ]);
    expect(result.violations.join("\n")).toContain("tcgplayer");
    expect(result.violations.join("\n")).toContain("scryfall");
  });

  it("rejects a switch-statement provider-key-keyed scope picker", async () => {
    const plantedPath = "packages/design-system/src/patterns/one-off-region-select.tsx";
    const root = await fixture({
      [plantedPath]: `
        export function OneOffRegionSelect({ providerKey }: { providerKey: string }) {
          switch (providerKey) {
            case "mtgjson":
              return <NativeSelect name="expansionId" items={[]} />;
            default:
              return <NativeSelect name="seriesId" items={[]} />;
          }
        }
      `,
    });

    const result = await validateProviderScopePickerShapeGuard({ repoRoot: root });
    expect(result.violations).toHaveLength(2);
    expect(result.violations.every((violation) => violation.startsWith(`${plantedPath}:`))).toBe(true);
    expect(result.violations.join("\n")).toContain("mtgjson");
  });

  it("rejects a ternary provider-key-keyed scope picker", async () => {
    const plantedPath = "deployables/admin-web/app/routes/misc/quick-filter.tsx";
    const root = await fixture({
      [plantedPath]: `
        export function QuickFilter({ providerKey }: { providerKey: string }) {
          return providerKey === "tcgplayer" ? (
            <RadioGroup name="productLineId" options={[]} />
          ) : (
            <RadioGroup name="seriesId" options={[]} />
          );
        }
      `,
    });

    const result = await validateProviderScopePickerShapeGuard({ repoRoot: root });
    expect(result.violations).toHaveLength(2);
    expect(result.violations.every((violation) => violation.startsWith(`${plantedPath}:`))).toBe(true);
    expect(result.violations.join("\n")).toContain("tcgplayer");
  });

  it("rejects an object-literal-keyed provider scope picker lookup", async () => {
    const plantedPath = "bounded-contexts/catalog/features/unrelated-widgets/ui/widget-panel.tsx";
    const root = await fixture({
      [plantedPath]: `
        const pickersByProvider = {
          tcgplayer: <Combobox name="productLineId" options={[]} />,
          scryfall: <Combobox name="expansionId" options={[]} />,
        };
        export function WidgetPanel({ providerKey }: { providerKey: string }) {
          return pickersByProvider[providerKey] ?? null;
        }
      `,
    });

    const result = await validateProviderScopePickerShapeGuard({ repoRoot: root });
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.join("\n")).toContain(plantedPath);
  });

  it("does not reject a provider-keyed branch that renders operational content instead of a scope-field picker", async () => {
    const plantedPath = "bounded-contexts/catalog/features/provider-scope-mapping/ui/vendor-status-panel.tsx";
    const root = await fixture({
      [plantedPath]: `
        export function VendorStatusPanel({ providerKey }: { providerKey: string }) {
          if (providerKey === "tcgplayer") {
            return <Badge tone="success">TCGplayer</Badge>;
          }
          return <Badge tone="neutral">Other</Badge>;
        }
      `,
    });

    const result = await validateProviderScopePickerShapeGuard({ repoRoot: root });
    expect(result.violations).toEqual([]);
  });

  it("does not reject a provider-keyed picker branch whose field is not a structured scope field", async () => {
    const plantedPath = "bounded-contexts/catalog/features/provider-scope-mapping/ui/vendor-locale-panel.tsx";
    const root = await fixture({
      [plantedPath]: `
        export function VendorLocalePanel({ providerKey }: { providerKey: string }) {
          if (providerKey === "tcgplayer") {
            return <Select name="localeDisplayFormat" items={[]} />;
          }
          return <Select name="localeDisplayFormat" items={[]} />;
        }
      `,
    });

    const result = await validateProviderScopePickerShapeGuard({ repoRoot: root });
    expect(result.violations).toEqual([]);
  });

  it("does not reject registry-backed compact-importScope compatibility parsing (no JSX, .ts only)", async () => {
    const plantedPath = "bounded-contexts/catalog/features/source-observations/api/provider-import-scope-shape.ts";
    const root = await fixture({
      [plantedPath]: `
        export const catalogProviderImportScopeSecondSegmentKindByProvider = {
          tcgplayer: "product-line",
          scryfall: "expansion",
        };
        export function providerImportScopeSecondSegmentIsProductLine(providerKey) {
          return catalogProviderImportScopeSecondSegmentKindByProvider[providerKey ?? ""] === "product-line";
        }
      `,
    });

    const result = await validateProviderScopePickerShapeGuard({ repoRoot: root });
    // .ts files are outside this guard's .tsx scan entirely (no JSX is possible).
    expect(result.discovery.scannedFiles).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it("passes on the current production repository with a nonzero scanned/candidate surface count", async () => {
    const result = await validateProviderScopePickerShapeGuard({ repoRoot: process.cwd() });
    expect(result.violations).toEqual([]);
    expect(result.discovery.scannedFiles).toBeGreaterThan(0);
    expect(result.discovery.candidateSurfaces).toBeGreaterThan(0);
  });
});

async function fixture(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-scope-picker-shape-guard-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(entries)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return root;
}
