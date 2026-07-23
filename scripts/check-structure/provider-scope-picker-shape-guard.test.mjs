import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateProviderScopePickerShapeGuard } from "./provider-scope-picker-shape-guard.mjs";

const roots = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("provider scope-picker shape guard", () => {
  it("rejects direct and reversed provider-key equality through member access at an arbitrary path", async () => {
    const plantedPath = "bounded-contexts/inventory/features/restock-planning/ui/vendor-source-panel.tsx";
    const result = await validateFixture({
      [plantedPath]: `
        export function VendorSourcePanel({ input }) {
          if ("tcgplayer" === input.providerKey) {
            return <Select name="productLineId" label="Product line" items={[]} />;
          } else if (input.providerKey === "scryfall") {
            return <Select name="expansionId" label="Expansion" items={[]} />;
          }
          return null;
        }
      `,
    });

    expectNegativeControl(result, { scannedFiles: 1, candidateSurfaces: 1, violations: 2 });
    expect(result.violations.join("\n")).toContain(plantedPath);
    expect(result.violations.join("\n")).toContain("tcgplayer");
    expect(result.violations.join("\n")).toContain("scryfall");
  });

  it("rejects a switch-statement provider-key selection", async () => {
    const plantedPath = "packages/design-system/src/patterns/one-off-region-select.tsx";
    const result = await validateFixture({
      [plantedPath]: `
        export function OneOffRegionSelect({ providerKey }) {
          switch (providerKey) {
            case "mtgjson":
              return <NativeSelect name="expansionId" items={[]} />;
            default:
              return <NativeSelect name="seriesId" items={[]} />;
          }
        }
      `,
    });

    expectNegativeControl(result, { scannedFiles: 1, candidateSurfaces: 1, violations: 2 });
    expect(result.violations.every((violation) => violation.startsWith(`${plantedPath}:`))).toBe(true);
    expect(result.violations.join("\n")).toContain("mtgjson");
  });

  it("rejects inline-array provider membership", async () => {
    const plantedPath = "deployables/admin-web/app/routes/misc/quick-filter.tsx";
    const result = await validateFixture({
      [plantedPath]: `
        export function QuickFilter({ state }) {
          return ["tcgplayer", "scryfall"].includes(state.providerKey) ? (
            <RadioGroup name="productLineId" options={[]} />
          ) : (
            <RadioGroup name="seriesId" options={[]} />
          );
        }
      `,
    });

    expectNegativeControl(result, { scannedFiles: 1, candidateSurfaces: 1, violations: 2 });
    expect(result.violations.join("\n")).toContain("tcgplayer");
    expect(result.violations.join("\n")).toContain("scryfall");
  });

  it("rejects named-array provider membership", async () => {
    const plantedPath = "bounded-contexts/identity/features/preferences/ui/source-choice.tsx";
    const result = await validateFixture({
      [plantedPath]: `
        const preferredSources = ["tcgplayer", "mtgjson"] as const;
        export function SourceChoice({ providerKey }) {
          if (preferredSources.includes(providerKey)) {
            return <Autocomplete name="productLineId" options={[]} />;
          }
          return null;
        }
      `,
    });

    expectNegativeControl(result, { scannedFiles: 1, candidateSurfaces: 1, violations: 1 });
    expect(result.violations.join("\n")).toContain("tcgplayer");
    expect(result.violations.join("\n")).toContain("mtgjson");
  });

  it("rejects a provider-keyed object lookup wrapped in as const and counts its module-level JSX container", async () => {
    const plantedPath = "bounded-contexts/catalog/features/unrelated-widgets/ui/widget-panel.tsx";
    const result = await validateFixture({
      [plantedPath]: `
        const choices = {
          tcgplayer: <Combobox name="productLineId" options={[]} />,
          scryfall: <Combobox name="expansionId" options={[]} />,
        } as const;
        export function WidgetPanel({ providerKey }) {
          return choices[providerKey] ?? null;
        }
      `,
    });

    expectNegativeControl(result, { scannedFiles: 1, candidateSurfaces: 1, violations: 2 });
    expect(result.violations.join("\n")).toContain(plantedPath);
    expect(result.violations.join("\n")).toContain("tcgplayer");
    expect(result.violations.join("\n")).toContain("scryfall");
  });

  it("rejects Map.get(providerKey) selection and counts its module-level JSX container", async () => {
    const plantedPath = "bounded-contexts/ordering/features/intake/ui/vendor-region.tsx";
    const result = await validateFixture({
      [plantedPath]: `
        const choices = new Map([
          ["tcgplayer", <Select name="productLineId" items={[]} />],
          ["scryfall", <Select name="expansionId" items={[]} />],
        ]);
        export function VendorRegion({ providerKey }) {
          return choices.get(providerKey) ?? null;
        }
      `,
    });

    expectNegativeControl(result, { scannedFiles: 1, candidateSurfaces: 1, violations: 2 });
    expect(result.violations.join("\n")).toContain(plantedPath);
    expect(result.violations.join("\n")).toContain("tcgplayer");
    expect(result.violations.join("\n")).toContain("scryfall");
  });

  it("does not reject an unrelated provider condition around a structured-scope picker", async () => {
    const result = await validateFixture({
      "bounded-contexts/catalog/features/provider-ops/ui/advanced-panel.tsx": `
        export function AdvancedPanel({ provider, mode }) {
          if (provider && mode === "advanced") {
            return <Select name="seriesId" items={[]} />;
          }
          return null;
        }
      `,
    });

    expect(result.discovery).toEqual({ scannedFiles: 1, candidateSurfaces: 1 });
    expect(result.violations).toEqual([]);
  });

  it("does not join a non-scope picker to nearby unrelated scope-field text", async () => {
    const result = await validateFixture({
      "bounded-contexts/catalog/features/provider-ops/ui/vendor-locale-panel.tsx": `
        export function VendorLocalePanel({ providerKey, seriesId }) {
          if (providerKey === "tcgplayer") {
            return (
              <>
                <Select name="localeDisplayFormat" items={[]} />
                <span>{seriesId}</span>
              </>
            );
          }
          return null;
        }
      `,
    });

    expect(result.discovery).toEqual({ scannedFiles: 1, candidateSurfaces: 1 });
    expect(result.violations).toEqual([]);
  });

  it("does not resolve named membership through an unrelated lexical scope", async () => {
    const result = await validateFixture({
      "bounded-contexts/catalog/features/provider-ops/ui/external-source-choice.tsx": `
        import { preferredSources } from "./provider-registry";
        export function ExternalSourceChoice({ providerKey }) {
          if (preferredSources.includes(providerKey)) {
            return <Select name="seriesId" items={[]} />;
          }
          return null;
        }
        function unrelatedHelper() {
          const preferredSources = ["tcgplayer"];
          return preferredSources;
        }
      `,
    });

    expect(result.discovery).toEqual({ scannedFiles: 1, candidateSurfaces: 1 });
    expect(result.violations).toEqual([]);
  });

  it("does not reject a provider-keyed branch that renders operational content", async () => {
    const result = await validateFixture({
      "bounded-contexts/catalog/features/provider-scope-mapping/ui/vendor-status-panel.tsx": `
        export function VendorStatusPanel({ providerKey }) {
          if (providerKey === "tcgplayer") {
            return <Badge tone="success">TCGplayer</Badge>;
          }
          return <Badge tone="neutral">Other</Badge>;
        }
      `,
    });

    expect(result.discovery).toEqual({ scannedFiles: 1, candidateSurfaces: 1 });
    expect(result.violations).toEqual([]);
  });

  it("counts each nearest JSX execution container exactly once", async () => {
    const result = await validateFixture({
      "bounded-contexts/catalog/features/provider-ops/ui/container-count.tsx": `
        const first = <Badge>one</Badge>;
        const second = <Badge>two</Badge>;
        export function Third() {
          return <Badge>three</Badge>;
        }
      `,
    });

    expect(result.discovery).toEqual({ scannedFiles: 1, candidateSurfaces: 3 });
    expect(result.violations).toEqual([]);
  });

  it("does not scan registry-backed compact-importScope compatibility parsing without JSX", async () => {
    const result = await validateFixture({
      "bounded-contexts/catalog/features/source-observations/api/provider-import-scope-shape.ts": `
        export const catalogProviderImportScopeSecondSegmentKindByProvider = {
          tcgplayer: "product-line",
          scryfall: "expansion",
        };
        export function providerImportScopeSecondSegmentIsProductLine(providerKey) {
          return catalogProviderImportScopeSecondSegmentKindByProvider[providerKey ?? ""] === "product-line";
        }
      `,
    });

    expect(result.discovery).toEqual({ scannedFiles: 0, candidateSurfaces: 0 });
    expect(result.violations).toEqual([]);
  });

  it("passes on the current production repository with honest nonzero discovery totals", async () => {
    const result = await validateProviderScopePickerShapeGuard({ repoRoot: process.cwd() });
    expect(result.violations).toEqual([]);
    expect(result.discovery.scannedFiles).toBeGreaterThan(0);
    expect(result.discovery.candidateSurfaces).toBeGreaterThan(0);
  });
});

function expectNegativeControl(result, expected) {
  expect(result.discovery).toEqual({
    scannedFiles: expected.scannedFiles,
    candidateSurfaces: expected.candidateSurfaces,
  });
  expect(result.violations).toHaveLength(expected.violations);
}

async function validateFixture(entries) {
  const root = await fixture(entries);
  return validateProviderScopePickerShapeGuard({ repoRoot: root });
}

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
