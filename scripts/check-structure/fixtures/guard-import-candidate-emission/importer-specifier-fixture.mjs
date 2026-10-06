const IMP = "bounded-contexts/example/source.ts";
const WIN = "bounded-contexts\\example\\source.ts";
const OUT = "packages/example-2/nested/source.ts";

export const importerSpecifierFixture = Object.freeze(
  [
    [IMP, "./inferred"],
    [IMP, "./inferred.ts"],
    [IMP, "./dual"],
    [IMP, "./di"],
    [IMP, "./fi"],
    [IMP, "./target"],
    [IMP, "./t.tsx"],
    [IMP, "./onlytsx.tsx"],
    [IMP, "./onlymjs.mjs"],
    [IMP, "./absent"],
    [IMP, "../sibling/mod"],
    [IMP, "../../../escape/mod"],
    [IMP, ".\\inferred"],
    [IMP, ".hidden"],
    [IMP, "."],
    [IMP, ".."],
    [WIN, "./inferred"],
    [OUT, "./inferred"],
    [IMP, "@chase-sets/example/exact"],
    [IMP, "@chase-sets/example/refused"],
    [IMP, "@chase-sets/example/a/../b"],
    [IMP, "@chase-sets/example/../../packages/example/x"],
    [IMP, "@chase-sets/bounded-context-runtime/../../infrastructure/bounded-context-runtime/seeding.ts"],
    [IMP, "@chase-sets/collider/hit"],
    [IMP, "@chase-sets/example-2/deep/sub/path"],
    [IMP, "@chase-sets/example"],
    [IMP, "@chase-sets/Example/bad"],
    [IMP, "@chase-sets/example/"],
    [IMP, "node:fs"],
    [IMP, "typescript"],
    [IMP, "@vendor/example/looksalike"],
  ].map(([importerPath, specifierText]) => Object.freeze({ importerPath, specifierText })),
);
