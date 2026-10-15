import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import { validatePricingRegistryConformance } from "./pricing-registry-conformance.mjs";

const roots = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

// Deliberately named and placed so neither the file nor the factory mentions
// "registry": discovery must come from the code shape alone.
const plantedPath = "bounded-contexts/pricing/features/offer-targets/domain/target-styles.ts";
const planted = `
  export type TargetStyle = Readonly<{ id: string }>;
  export function createTargetStyles(initial: readonly TargetStyle[] = []) {
    const styles = new Map<string, TargetStyle>();
    const registerTargetStyle = (style: TargetStyle): void => {
      styles.set(style.id, style);
    };
    initial.forEach(registerTargetStyle);
    return { registerTargetStyle, resolve: (id: string) => styles.get(id) ?? null };
  }
`;
const constructionPath = "bounded-contexts/pricing/features/offer-targets/api/styles-runtime.ts";
const construction = `
  import { createTargetStyles } from "../domain/target-styles";
  export const targetStyles = createTargetStyles([{ id: "flat" }]);
`;
const kitPath = "bounded-contexts/pricing/tests/conformance/kit.ts";
const kit = `export function describeConformance(suite: unknown): void {}`;
const runPath = "bounded-contexts/pricing/tests/conformance/target-style-conformance.test.ts";
const run = `
  import { createTargetStyles } from "../../features/offer-targets/domain/target-styles";
  import { targetStyles } from "../../features/offer-targets/api/styles-runtime";
  import { describeConformance } from "./kit";
  describeConformance({ registry: createTargetStyles, entries: () => [targetStyles.resolve("flat")] });
`;

describe("pricing registry conformance guard", () => {
  it("rejects a registry planted at an arbitrary path with no conformance run", async () => {
    const result = await validateFixture({ [plantedPath]: planted, [kitPath]: kit });

    expect(result.registries).toEqual([{ id: `${plantedPath}#createTargetStyles`, line: 3, exported: true }]);
    expect(result.violations).toEqual([
      `${plantedPath}:3: Pricing registry 'createTargetStyles' has no Conformance Kit run; call describeConformance({ registry: createTargetStyles, ... }) from a Pricing test (see bounded-contexts/pricing/docs/pricing-goal-authoring.md).`,
    ]);
  });

  it("accepts a registry whose run imports both the factory and every module that constructs it", async () => {
    const result = await validateFixture({
      [plantedPath]: planted,
      [constructionPath]: construction,
      [kitPath]: kit,
      [runPath]: run,
    });

    expect(result.violations).toEqual([]);
    expect(result.runs).toEqual([{ file: runPath, registry: `${plantedPath}#createTargetStyles` }]);
    expect(result.constructions).toEqual([
      { file: constructionPath, line: 3, registry: `${plantedPath}#createTargetStyles` },
    ]);
  });

  it("rejects a construction site that no run of its registry imports, so its entries are never covered", async () => {
    const runWithoutConstruction = run.replace(/^.*styles-runtime.*$/m, "");
    const result = await validateFixture({
      [plantedPath]: planted,
      [constructionPath]: construction,
      [kitPath]: kit,
      [runPath]: runWithoutConstruction,
    });

    expect(result.violations).toEqual([
      `${constructionPath}:3: constructs Pricing registry 'createTargetStyles' but no conformance run of that registry imports this module, so the entries registered here are never run; import it from the run in ${runPath}.`,
    ]);
  });

  it("follows aliases and re-exports, and discovers method-shorthand and arrow-function registries", async () => {
    const result = await validateFixture({
      "bounded-contexts/pricing/features/a/domain/providers.ts": `
        export const createProviders = () => {
          const exact = new Map();
          return { registerExact(provider) { exact.set(provider.key, provider); }, resolve: (key) => exact.get(key) };
        };
      `,
      "bounded-contexts/pricing/features/a/read-model/index.ts": `export { createProviders as makeProviders } from "../domain/providers";`,
      "bounded-contexts/pricing/features/a/api/services.ts": `
        import { makeProviders } from "../read-model";
        export const services = () => ({ providers: makeProviders() });
      `,
      [kitPath]: kit,
      "bounded-contexts/pricing/tests/conformance/providers-conformance.test.ts": `
        import { makeProviders as subject } from "../../features/a/read-model/index";
        import * as services from "../../features/a/api/services";
        import { describeConformance as conform } from "./kit";
        conform({ registry: subject, entries: () => [services] });
      `,
    });

    expect(result.violations).toEqual([]);
    expect(result.registries.map(({ id }) => id)).toEqual([
      "bounded-contexts/pricing/features/a/domain/providers.ts#createProviders",
    ]);
  });

  it("ignores registries built only by tests and functions whose store or register member is missing", async () => {
    const result = await validateFixture({
      [plantedPath]: planted,
      [kitPath]: kit,
      [runPath]: run.replace(/^.*styles-runtime.*$/m, ""),
      "bounded-contexts/pricing/features/offer-targets/tests/style-fixture.ts": `
        import { createTargetStyles } from "../domain/target-styles";
        export const fixture = createTargetStyles();
      `,
      "bounded-contexts/pricing/features/offer-targets/domain/wrappers.ts": `
        import { createTargetStyles } from "./target-styles";
        export function createCloser() {
          const inner = createTargetStyles();
          const run = () => new Map();
          return { run, registerTargetStyle: inner.registerTargetStyle };
        }
        export function createIndex() {
          const index = new Map();
          return { lookup: (key) => index.get(key) };
        }
      `,
    });

    expect(result.registries.map(({ id }) => id)).toEqual([`${plantedPath}#createTargetStyles`]);
    expect(result.violations).toEqual([
      "bounded-contexts/pricing/features/offer-targets/domain/wrappers.ts:4: constructs Pricing registry 'createTargetStyles' but no conformance run of that registry imports this module, so the entries registered here are never run; import it from the run in bounded-contexts/pricing/tests/conformance/target-style-conformance.test.ts.",
    ]);
  });

  it("rejects an unexported registry, a run naming a non-registry, and an empty discovery", async () => {
    const unexported = await validateFixture({
      [plantedPath]: planted.replace("export function", "function"),
      [kitPath]: kit,
    });
    expect(unexported.violations).toEqual([
      `${plantedPath}:3: Pricing registry 'createTargetStyles' is not exported, so no conformance run can import it; export it and add a Conformance Kit run.`,
    ]);

    const mistargeted = await validateFixture({
      [plantedPath]: planted,
      [kitPath]: kit,
      [runPath]: `
        import { createTargetStyles } from "../../features/offer-targets/domain/target-styles";
        import { helper } from "../../features/offer-targets/domain/helper";
        import { describeConformance } from "./kit";
        describeConformance({ registry: createTargetStyles, entries: () => [] });
        describeConformance({ registry: helper, entries: () => [] });
      `,
      "bounded-contexts/pricing/features/offer-targets/domain/helper.ts": `export const helper = () => 1;`,
    });
    expect(mistargeted.violations).toEqual([
      `${runPath}:6: describeConformance registry 'helper' does not resolve to a discovered Pricing registry.`,
    ]);

    const empty = await validateFixture({ [kitPath]: kit });
    expect(empty.violations).toEqual([
      "bounded-contexts/pricing: discovered no Pricing registries; the conformance guard's shape no longer matches the code.",
    ]);
  });

  it("passes on this repository with every discovered registry run", async () => {
    const result = await validatePricingRegistryConformance({ repoRoot });

    expect(result.violations).toEqual([]);
    expect(result.registries.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "bounded-contexts/pricing/features/economics/domain/provider-registry.ts#createEconomicsProviderRegistry",
        "bounded-contexts/pricing/features/market-estimates/domain/demand-curve/curve-builder-registry.ts#createCurveBuilderRegistry",
        "bounded-contexts/pricing/features/repricing-policies/domain/goals/registry.ts#createPricingGoalRegistry",
        "bounded-contexts/pricing/features/repricing-policies/domain/guardrails/registry.ts#createGuardrailRegistry",
      ]),
    );
  });
});

async function validateFixture(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pricing-registry-conformance-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(entries)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return validatePricingRegistryConformance({ repoRoot: root });
}
