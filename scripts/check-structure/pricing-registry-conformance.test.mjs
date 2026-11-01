import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import { validatePricingRegistryConformance } from "./pricing-registry-conformance.mjs";

const roots = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const guide = "bounded-contexts/pricing/docs/pricing-goal-authoring.md";
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
  import { vi } from "vitest";
  import { createTargetStyles } from "../../features/offer-targets/domain/target-styles";
  import { targetStyles } from "../../features/offer-targets/api/styles-runtime";
  import { describeConformance } from "./kit";
  vi.mock("../../features/offer-targets/domain/target-styles", async (importOriginal) =>
    (await import("./kit")).recordRegistrations(await importOriginal(), "createTargetStyles"));
  describeConformance({ registry: createTargetStyles, entries: () => [targetStyles.resolve("flat")] });
`;

// The reviewer's synthetic module shapes (9654-review-r1 F2/F3): a factory, the
// production module that registers two entries through it, and a run.
const stylesFactory = "bounded-contexts/pricing/features/styles/domain/styles.ts";
const stylesRuntime = "bounded-contexts/pricing/features/styles/api/runtime.ts";
const stylesRun = "bounded-contexts/pricing/tests/conformance/styles.test.ts";
const styles = {
  [stylesFactory]: `export function createStyles(initial = []) {
    const styles = new Map();
    const registerStyle = style => styles.set(style.id, style);
    initial.forEach(registerStyle);
    return { registerStyle, definitions: () => [...styles.values()] };
  }`,
  [stylesRuntime]: `import { createStyles } from "../domain/styles";
    export const styles = createStyles([{ id: "synthetic-covered" }, { id: "synthetic-uncovered" }]);
    export type Style = { id: string };`,
  [kitPath]: kit,
  [stylesRun]: `import { vi } from "vitest";
    import { createStyles } from "../../features/styles/domain/styles";
    import { styles } from "../../features/styles/api/runtime";
    import { describeConformance } from "./kit";
    vi.mock("../../features/styles/domain/styles", async (importOriginal) =>
      (await import("./kit")).recordRegistrations(await importOriginal(), "createStyles"));
    describeConformance({ registry: createStyles, entries: () => styles.definitions(), key: style => style.id });`,
};
const withStylesRun = (edit, extra = {}) => ({ ...styles, [stylesRun]: edit(styles[stylesRun]), ...extra });
const unrecordedStylesRun = (source) => source.replace(/^\s*vi\.mock\([^]*?"createStyles"\)\);\n/m, "");
const notExecuted = (run) =>
  `${stylesRuntime}:2: constructs Pricing registry 'createStyles' but no conformance run of that registry executes this module through value imports or re-exports, so the entries registered here are never run; import it from the run in ${run}.`;

describe("pricing registry conformance guard", () => {
  it("rejects a registry planted at an arbitrary path with no conformance run", async () => {
    const result = await validateFixture({ [plantedPath]: planted, [kitPath]: kit });

    expect(result.registries).toEqual([{ id: `${plantedPath}#createTargetStyles`, line: 3, exported: true }]);
    expect(result.violations).toEqual([
      `${plantedPath}:3: Pricing registry 'createTargetStyles' has no Conformance Kit run; call describeConformance({ registry: createTargetStyles, ... }) from a Pricing test (see ${guide}).`,
    ]);
  });

  it("accepts a registry whose run records it and executes every module that constructs it", async () => {
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

  it("accepts a named local suite object for a discovered registry run", async () => {
    const namedSuiteRun = run.replace(
      'describeConformance({ registry: createTargetStyles, entries: () => [targetStyles.resolve("flat")] });',
      'const suite = { registry: createTargetStyles, entries: () => [targetStyles.resolve("flat")] };\n  describeConformance(suite);',
    );
    const result = await validateFixture({
      [plantedPath]: planted,
      [constructionPath]: construction,
      [kitPath]: kit,
      [runPath]: namedSuiteRun,
    });

    expect(result.violations).toEqual([]);
    expect(result.runs).toEqual([{ file: runPath, registry: `${plantedPath}#createTargetStyles` }]);
  });

  it("rejects a construction site that no run of its registry executes, so its entries are never covered", async () => {
    const runWithoutConstruction = run.replace(/^.*styles-runtime.*$/m, "");
    const result = await validateFixture({
      [plantedPath]: planted,
      [constructionPath]: construction,
      [kitPath]: kit,
      [runPath]: runWithoutConstruction,
    });

    expect(result.violations).toEqual([
      `${constructionPath}:3: constructs Pricing registry 'createTargetStyles' but no conformance run of that registry executes this module through value imports or re-exports, so the entries registered here are never run; import it from the run in ${runPath}.`,
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
      "bounded-contexts/pricing/tests/conformance/index.ts": `export { describeConformance as conform } from "./kit";`,
      "bounded-contexts/pricing/tests/conformance/providers-conformance.test.ts": `
        import { vi } from "vitest";
        import { makeProviders as subject } from "../../features/a/read-model/index";
        import * as services from "../../features/a/api/services";
        import * as conformance from "./index";
        vi.mock("../../features/a/domain/providers", async (importOriginal) =>
          (await import("./kit")).recordRegistrations(await importOriginal(), "createProviders"));
        conformance.conform({ registry: subject, entries: () => [services] });
      `,
    });

    expect(result.violations).toEqual([]);
    expect(result.registries.map(({ id }) => id)).toEqual([
      "bounded-contexts/pricing/features/a/domain/providers.ts#createProviders",
    ]);
  });

  it("ignores registries declared or built only by tests and functions whose store or register member is missing", async () => {
    const result = await validateFixture({
      [plantedPath]: planted,
      [kitPath]: kit,
      [runPath]: run.replace(/^.*styles-runtime.*$/m, ""),
      "bounded-contexts/pricing/tests/conformance/synthetic.test.ts": `
        function createSyntheticStyles() {
          const styles = new Map();
          return { registerSyntheticStyle: (style) => styles.set(style.id, style) };
        }
      `,
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
      `bounded-contexts/pricing/features/offer-targets/domain/wrappers.ts:4: constructs Pricing registry 'createTargetStyles' but no conformance run of that registry executes this module through value imports or re-exports, so the entries registered here are never run; import it from the run in ${runPath}.`,
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
        import { vi } from "vitest";
        import { createTargetStyles } from "../../features/offer-targets/domain/target-styles";
        import { helper } from "../../features/offer-targets/domain/helper";
        import { describeConformance } from "./kit";
        vi.mock("../../features/offer-targets/domain/target-styles");
        describeConformance({ registry: createTargetStyles, entries: () => [] });
        describeConformance({ registry: helper, entries: () => [] });
      `,
      "bounded-contexts/pricing/features/offer-targets/domain/helper.ts": `export const helper = () => 1;`,
    });
    expect(mistargeted.violations).toEqual([
      `${runPath}:8: describeConformance registry 'helper' does not resolve to a discovered Pricing registry.`,
    ]);

    const empty = await validateFixture({ [kitPath]: kit });
    expect(empty.violations).toEqual([
      "bounded-contexts/pricing: discovered no Pricing registries; the conformance guard's shape no longer matches the code.",
    ]);
  });

  describe("entry-level coverage binding (9654-review-r1 F2)", () => {
    it("accepts the reviewer's direct-import run once it records the factory", async () => {
      const result = await validateFixture(styles);

      expect(result.violations).toEqual([]);
      expect(result.runs).toEqual([{ file: stylesRun, registry: `${stylesFactory}#createStyles` }]);
    });

    it("rejects the reviewer's omitted-entry run, which reads a hand-written subset of an unrecorded registry", async () => {
      const result = await validateFixture(
        withStylesRun((source) =>
          unrecordedStylesRun(source).replace(
            "entries: () => styles.definitions()",
            "entries: () => [styles.definitions()[0]]",
          ),
        ),
      );

      expect(result.violations).toEqual([
        `${stylesRun}:5: conformance run of 'createStyles' does not record its production registrations; vi.mock("../../features/styles/domain/styles") through recordRegistrations from the kit so the run fails any registered entry it does not exercise (see ${guide}).`,
      ]);
    });

    it("does not count a type-only import of the construction module as executing it", async () => {
      const result = await validateFixture(
        withStylesRun((source) =>
          source
            .replace("import { styles }", "import type { Style }")
            .replace(
              "entries: () => styles.definitions()",
              'entries: (): Style[] => [{ id: "synthetic-handwritten" }]',
            ),
        ),
      );

      expect(result.violations).toEqual([notExecuted(stylesRun)]);
    });

    it("does not count a value import whose bindings are never used, which the TypeScript transform drops", async () => {
      const result = await validateFixture(
        withStylesRun((source) =>
          source.replace("entries: () => styles.definitions()", 'entries: () => [{ id: "synthetic-handwritten" }]'),
        ),
      );

      expect(result.violations).toEqual([notExecuted(stylesRun)]);
    });

    it("rejects a same-named harness that does not resolve to the Conformance Kit export", async () => {
      const unrelated = "bounded-contexts/pricing/tests/conformance/unrelated.ts";
      const result = await validateFixture(
        withStylesRun((source) => source.replace('from "./kit";', 'from "./unrelated";'), {
          [unrelated]: "export function describeConformance(suite) { /* no tests */ }",
        }),
      );

      expect(result.runs).toEqual([]);
      expect(result.violations).toEqual([
        `${stylesRun}:7: describeConformance resolves to '${unrelated}#describeConformance', not the Conformance Kit export '${kitPath}#describeConformance', so this call runs nothing.`,
        `${stylesFactory}:1: Pricing registry 'createStyles' has no Conformance Kit run; call describeConformance({ registry: createStyles, ... }) from a Pricing test (see ${guide}).`,
      ]);
    });
  });

  describe("module composition (9654-review-r1 F3)", () => {
    it("accepts the reviewer's barrel that re-exports the registering module", async () => {
      const result = await validateFixture(
        withStylesRun(
          (source) =>
            source.replace('from "../../features/styles/api/runtime"', 'from "../../features/styles/api/index"'),
          { "bounded-contexts/pricing/features/styles/api/index.ts": 'export { styles } from "./runtime";' },
        ),
      );

      expect(result.violations).toEqual([]);
    });

    it("accepts the reviewer's factory imported through an export-star barrel", async () => {
      const result = await validateFixture(
        withStylesRun(
          (source) =>
            source.replace(
              'import { createStyles } from "../../features/styles/domain/styles"',
              'import { createStyles } from "../../features/styles/domain/index"',
            ),
          { "bounded-contexts/pricing/features/styles/domain/index.ts": 'export * from "./styles";' },
        ),
      );

      expect(result.violations).toEqual([]);
      expect(result.runs).toEqual([{ file: stylesRun, registry: `${stylesFactory}#createStyles` }]);
    });

    it("accepts a construction the run reaches through an import cycle, and still rejects one it never reaches", async () => {
      const services = "bounded-contexts/pricing/features/styles/api/services.ts";
      const cyclic = await validateFixture(
        withStylesRun(
          (source) =>
            source
              .replace(
                'import { styles } from "../../features/styles/api/runtime"',
                'import { services } from "../../features/styles/api/services"',
              )
              .replace("styles.definitions()", "services().definitions()"),
          {
            [stylesRuntime]: `import { createStyles } from "../domain/styles";
              export const styles = createStyles([{ id: "synthetic-covered" }]);
              import { services } from "./services";
              export const again = () => services();`,
            [services]: `import { styles } from "./runtime";
              export const services = () => styles;`,
          },
        ),
      );
      expect(cyclic.violations).toEqual([]);

      const unreached = await validateFixture(
        withStylesRun((source) => source.replace(/^.*api\/runtime.*$/m, "").replace("styles.definitions()", "[]")),
      );
      expect(unreached.violations).toEqual([notExecuted(stylesRun)]);
    });

    it("refuses an ambiguous export-star name and terminates on an export-star cycle", async () => {
      const ambiguous = await validateFixture(
        withStylesRun(
          (source) =>
            source.replace('from "../../features/styles/domain/styles"', 'from "../../features/styles/domain/index"'),
          {
            "bounded-contexts/pricing/features/styles/domain/index.ts":
              'export * from "./styles";\nexport * from "./legacy";',
            "bounded-contexts/pricing/features/styles/domain/legacy.ts": "export const createStyles = () => null;",
          },
        ),
      );
      expect(ambiguous.violations).toEqual([
        `${stylesRun}:7: describeConformance registry 'createStyles' is ambiguous: export * provides it from bounded-contexts/pricing/features/styles/domain/legacy.ts#createStyles, ${stylesFactory}#createStyles.`,
        `${stylesFactory}:1: Pricing registry 'createStyles' has no Conformance Kit run; call describeConformance({ registry: createStyles, ... }) from a Pricing test (see ${guide}).`,
      ]);

      const cycle = await validateFixture(
        withStylesRun(
          (source) =>
            source.replace('from "../../features/styles/domain/styles"', 'from "../../features/styles/domain/index"'),
          {
            "bounded-contexts/pricing/features/styles/domain/index.ts": 'export * from "./more";',
            "bounded-contexts/pricing/features/styles/domain/more.ts": 'export * from "./index";',
          },
        ),
      );
      expect(cycle.violations).toEqual([
        `${stylesRun}:7: describeConformance registry 'createStyles' does not resolve to a discovered Pricing registry.`,
        `${stylesFactory}:1: Pricing registry 'createStyles' has no Conformance Kit run; call describeConformance({ registry: createStyles, ... }) from a Pricing test (see ${guide}).`,
      ]);
    });
  });

  // Modeled on the Forecast Kind registry (#9638, 7711-split-delta-r1 F2): the
  // factory's module constructs the registry itself and exports its enumeration.
  describe("production-enumeration binding (7711-split-delta-r1 F2)", () => {
    const kinds = "bounded-contexts/pricing/features/synthetic-ledger/domain/kinds.ts";
    const kindsRun = "bounded-contexts/pricing/tests/conformance/kinds.test.ts";
    const colocated = {
      [kinds]: `export function createKindRegistry(initial = []) {
        const kinds = new Map();
        const registerKind = kind => kinds.set(kind.name, kind);
        initial.forEach(registerKind);
        return { registerKind, definitions: () => [...kinds.values()] };
      }
      export const curveKind = { name: "synthetic-curve" };
      export const buyerChoiceKind = { name: "synthetic-buyer-choice" };
      export const conditionRateKind = { name: "synthetic-condition-rate" };
      const kindRegistry = createKindRegistry([curveKind, buyerChoiceKind, conditionRateKind]);
      export const kindDefinitions = kindRegistry.definitions;`,
      [kitPath]: kit,
      [kindsRun]: `import { createKindRegistry, kindDefinitions } from "../../features/synthetic-ledger/domain/kinds";
        import { describeConformance } from "./kit";
        describeConformance({ registry: createKindRegistry, production: kindDefinitions, entries: () => kindDefinitions(), key: kind => kind.name });`,
    };
    const withKindsRun = (edit, extra = {}) => ({ ...colocated, [kindsRun]: edit(colocated[kindsRun]), ...extra });
    const kindsRegistry = `${kinds}#createKindRegistry`;
    const notBound = (reference, line = 3) =>
      `${kindsRun}:${line}: conformance run of 'createKindRegistry' reads production entries from '${reference}', which is not an enumeration member of a production construction of that registry; pass an export such as \`export const definitions = registry.definitions\` from the module that constructs it (see ${guide}).`;
    const ownModule = `${kinds}:10: constructs Pricing registry 'createKindRegistry' in the factory's own module, which recordRegistrations cannot intercept; export an enumeration member of this construction and pass it to the registry's run as \`production\` (see ${guide}).`;

    it("accepts a run that binds the enumeration of the co-located production construction", async () => {
      const result = await validateFixture(colocated);

      expect(result.violations).toEqual([]);
      expect(result.runs).toEqual([{ file: kindsRun, registry: kindsRegistry, binds: { file: kinds, line: 10 } }]);
      expect(result.constructions).toEqual([{ file: kinds, line: 10, registry: kindsRegistry }]);
    });

    it("follows a namespace import and a barrel to the bound enumeration", async () => {
      const barrel = "bounded-contexts/pricing/features/synthetic-ledger/index.ts";
      const result = await validateFixture(
        withKindsRun(
          (source) =>
            source
              .replace(
                'import { createKindRegistry, kindDefinitions } from "../../features/synthetic-ledger/domain/kinds";',
                'import { createKindRegistry } from "../../features/synthetic-ledger/domain/kinds";\nimport * as ledger from "../../features/synthetic-ledger/index";',
              )
              .replaceAll("kindDefinitions", "ledger.forecastKinds"),
          { [barrel]: 'export { kindDefinitions as forecastKinds } from "./domain/kinds";' },
        ),
      );

      expect(result.violations).toEqual([]);
    });

    it("rejects a recording run, whose wrapper cannot intercept the co-located construction", async () => {
      const result = await validateFixture(
        withKindsRun((source) =>
          source
            .replace(
              'import { describeConformance } from "./kit";',
              `import { describeConformance } from "./kit";
        import { vi } from "vitest";
        vi.mock("../../features/synthetic-ledger/domain/kinds", async (importOriginal) =>
          (await import("./kit")).recordRegistrations(await importOriginal(), "createKindRegistry"));`,
            )
            .replace("production: kindDefinitions, ", ""),
        ),
      );

      expect(result.violations).toEqual([ownModule]);
    });

    it("rejects a test-only reconstruction as the production enumeration", async () => {
      const result = await validateFixture(
        withKindsRun((source) =>
          source
            .replace(
              'import { describeConformance } from "./kit";',
              'import { describeConformance } from "./kit";\nconst reconstructed = createKindRegistry(kindDefinitions());\nconst rebuilt = reconstructed.definitions;',
            )
            .replace("production: kindDefinitions", "production: rebuilt"),
        ),
      );

      expect(result.violations).toEqual([notBound("rebuilt", 5), ownModule]);
    });

    it("rejects a reconstruction exported by a test helper module", async () => {
      const helper = "bounded-contexts/pricing/tests/conformance/kinds-fixture.ts";
      const result = await validateFixture(
        withKindsRun(
          (source) =>
            source
              .replace(
                'import { describeConformance } from "./kit";',
                'import { describeConformance } from "./kit";\nimport { rebuilt } from "./kinds-fixture";',
              )
              .replace("production: kindDefinitions", "production: rebuilt"),
          {
            [helper]: `import { createKindRegistry, kindDefinitions } from "../../features/synthetic-ledger/domain/kinds";
              const reconstructed = createKindRegistry(kindDefinitions());
              export const rebuilt = reconstructed.definitions;`,
          },
        ),
      );

      expect(result.violations).toEqual([notBound("rebuilt", 4), ownModule]);
    });

    it("rejects a handwritten production list, a type-only enumeration, a register member and a reassignable construction", async () => {
      const handwritten = await validateFixture(
        withKindsRun((source) =>
          source
            .replace(
              "import { createKindRegistry, kindDefinitions }",
              "import { createKindRegistry, kindDefinitions, curveKind }",
            )
            .replace("production: kindDefinitions", "production: () => [curveKind]"),
        ),
      );
      expect(handwritten.violations).toEqual([notBound("() => [curveKind]"), ownModule]);

      const typeOnly = await validateFixture(
        withKindsRun((source) =>
          source.replace(
            "import { createKindRegistry, kindDefinitions }",
            "import { createKindRegistry, type kindDefinitions }",
          ),
        ),
      );
      expect(typeOnly.violations).toEqual([notBound("kindDefinitions"), ownModule]);

      const registerMember = await validateFixture({
        ...withKindsRun((source) => source.replaceAll("kindDefinitions", "addKind")),
        [kinds]: `${colocated[kinds]}\nexport const addKind = kindRegistry.registerKind;`,
      });
      expect(registerMember.violations).toEqual([notBound("addKind"), ownModule]);

      const reassignable = await validateFixture({
        ...colocated,
        [kinds]: colocated[kinds].replace("const kindRegistry", "let kindRegistry"),
      });
      expect(reassignable.violations).toEqual([notBound("kindDefinitions"), ownModule]);
    });

    it("rejects an enumeration of another registry's construction", async () => {
      const result = await validateFixture({
        ...withKindsRun((source) =>
          source
            .replace("import { createKindRegistry, kindDefinitions }", "import { createKindRegistry }")
            .replace(
              'import { describeConformance } from "./kit";',
              'import { describeConformance } from "./kit";\nimport { styleDefinitions } from "../../features/styles/api/runtime";',
            )
            .replace("production: kindDefinitions", "production: styleDefinitions")
            .replace("entries: () => kindDefinitions()", "entries: () => styleDefinitions()"),
        ),
        ...styles,
        [stylesRuntime]: `${styles[stylesRuntime]}\nexport const styleDefinitions = styles.definitions;`,
      });

      expect(result.violations).toEqual([notBound("styleDefinitions", 4), ownModule]);
    });

    it("rejects a construction elsewhere that the enumeration does not bind and no run records", async () => {
      const runtime = "bounded-contexts/pricing/features/synthetic-ledger/api/runtime.ts";
      const result = await validateFixture(
        withKindsRun(
          (source) =>
            source.replace(
              'import { describeConformance } from "./kit";',
              'import { describeConformance } from "./kit";\nimport { extraKinds } from "../../features/synthetic-ledger/api/runtime";\nconst unused = () => extraKinds;',
            ),
          {
            [runtime]: `import { createKindRegistry } from "../domain/kinds";
              export const extraKinds = createKindRegistry([{ name: "synthetic-extra" }]);`,
          },
        ),
      );

      expect(result.violations).toEqual([
        `${runtime}:2: constructs Pricing registry 'createKindRegistry' but neither binds the enumeration of a run of that registry nor is executed by a run that records it, so the entries registered here are never run; bind its enumeration or record it from a run (see ${guide}).`,
      ]);
    });
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
