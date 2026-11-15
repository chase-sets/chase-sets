// Regenerates tcgplayer-set-name-observations.salvage.json by executing the removed server mapper
// exactly as it existed at the historical commit, read with `git show`, over the synthetic SetNames
// inputs below. Nothing here contacts TCGplayer: the client call is replaced by the local inputs.
//
//   pnpm exec tsx bounded-contexts/catalog/features/operator-session/tests/fixtures/generate-tcgplayer-set-name-observations-salvage.ts
//   pnpm exec prettier --write bounded-contexts/catalog/features/operator-session/tests/fixtures/tcgplayer-set-name-observations.salvage.json
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const commit = "232c0c02cb2d308aa5e231921a55fb32b070e15a";
const adapterPath = "bounded-contexts/catalog/features/source-observations/api/providers/tcgplayer/adapter.ts";
const runtimePath = "bounded-contexts/catalog/features/provider-scope-discovery/api/runtime.ts";

type Excerpt = Readonly<{ path: string; first: number; last: number; startsWith: string }>;

const excerpts = {
  setNamesBranch: { path: adapterPath, first: 526, last: 555, startsWith: '  if (optionKind === "set-names"' },
  optionalMetadata: { path: adapterPath, first: 1265, last: 1268, startsWith: "function optionalMetadata(" },
  positiveIntegerValue: { path: adapterPath, first: 1282, last: 1290, startsWith: "function positiveIntegerValue(" },
  stringValue: { path: adapterPath, first: 1292, last: 1299, startsWith: "function stringValue(" },
  collectTargetOptionsItems: {
    path: runtimePath,
    first: 369,
    last: 385,
    startsWith: "    for (const item of page.items) {",
  },
} as const satisfies Record<string, Excerpt>;

type SetNameInput = Readonly<{
  setNameId: number;
  categoryId: number;
  name: string;
  cleanSetName: string;
  urlName: string;
  abbreviation: string | null;
  releaseDate: string | null;
  isSupplemental: boolean;
  active: boolean;
}>;

// Synthetic SetNames entries shaped like the bound probe report: every releaseDate is the measured
// local `YYYY-MM-DDTHH:mm:ss` form, abbreviations are present, and each line carries an inactive set.
const units: readonly Readonly<{
  productLineId: number;
  unitKey: string;
  scopeKind: string;
  sets: readonly SetNameInput[];
}>[] = [
  {
    productLineId: 1,
    unitKey: "tcgplayer:mtg:single-card:source-observation-import",
    scopeKind: "set",
    sets: [
      set(
        1,
        900001,
        "Synthetic Magic Core Set",
        "Synthetic Magic Core Set",
        "synthetic-magic-core-set",
        "SMC",
        "2024-02-09T00:00:00",
        false,
        true,
      ),
      set(
        1,
        900002,
        "Commander: Synthetic Legends",
        "Commander Synthetic Legends",
        "commander-synthetic-legends",
        "SCL",
        "2023-08-04T00:00:00",
        true,
        true,
      ),
      set(
        1,
        900003,
        "Synthetic Masters & Myths",
        "Synthetic Masters and Myths",
        "synthetic-masters-and-myths",
        "SMM",
        "2022-11-18T00:00:00",
        false,
        true,
      ),
      set(
        1,
        900004,
        "Synthétique Promos",
        "Synthetique Promos",
        "synthetique-promos",
        "SYP",
        "2021-06-25T00:00:00",
        true,
        true,
      ),
      set(
        1,
        900005,
        "Synthetic Retired Set",
        "Synthetic Retired Set",
        "synthetic-retired-set",
        "SRS",
        "2019-01-25T00:00:00",
        false,
        false,
      ),
    ],
  },
  {
    productLineId: 68,
    unitKey: "tcgplayer:one-piece:single-card:source-observation-import",
    scopeKind: "set",
    sets: [
      set(
        68,
        910001,
        "Synthetic Dawn [OP-S1]",
        "Synthetic Dawn OPS1",
        "synthetic-dawn-ops1",
        "OP-S1",
        "2022-12-02T00:00:00",
        false,
        true,
      ),
      set(
        68,
        910002,
        "Starter Deck: Synthetic Crew [ST-S1]",
        "Starter Deck Synthetic Crew STS1",
        "starter-deck-synthetic-crew-sts1",
        "ST-S1",
        "2022-12-02T00:00:00",
        false,
        true,
      ),
      set(
        68,
        910003,
        "Synthetic Promotion Cards",
        "Synthetic Promotion Cards",
        "synthetic-promotion-cards",
        "P",
        "2022-12-02T00:00:00",
        true,
        true,
      ),
      set(
        68,
        910004,
        "Synthetic Prerelease Pack",
        "Synthetic Prerelease Pack",
        "synthetic-prerelease-pack",
        "PRE",
        "2022-11-25T00:00:00",
        true,
        false,
      ),
    ],
  },
];

function set(
  categoryId: number,
  setNameId: number,
  name: string,
  cleanSetName: string,
  urlName: string,
  abbreviation: string | null,
  releaseDate: string | null,
  isSupplemental: boolean,
  active: boolean,
): SetNameInput {
  return { setNameId, categoryId, name, cleanSetName, urlName, abbreviation, releaseDate, isSupplemental, active };
}

function readExcerpt(excerpt: Excerpt): string {
  const source = execFileSync("git", ["show", `${commit}:${excerpt.path}`], { encoding: "utf8" });
  const lines = source.split(/\r?\n/u).slice(excerpt.first - 1, excerpt.last);
  if (!lines[0]?.startsWith(excerpt.startsWith)) {
    throw new Error(`Historical excerpt ${excerpt.path}:${excerpt.first} no longer starts with the expected line.`);
  }
  return lines.join("\n");
}

function blobId(path: string): string {
  return execFileSync("git", ["rev-parse", `${commit}:${path}`], { encoding: "utf8" }).trim();
}

async function loadHistoricalMapper() {
  const source = `
${readExcerpt(excerpts.optionalMetadata)}
${readExcerpt(excerpts.positiveIntegerValue)}
${readExcerpt(excerpts.stringValue)}
// Replaces the adapter's TCGplayer unit check, which needed a live client; units are bound locally.
async function assertProductLineIdMatchesUnit(..._ignored: unknown[]): Promise<void> {}
export async function listSetNameOptions(
  optionKind: string,
  parentValues: Record<string, unknown>,
  client: { listCatalogSetNames(input: { categoryId: number }): Promise<{ results: any[] }> },
) {
  const profileVersion = null;
  const constraints = null;
${readExcerpt(excerpts.setNamesBranch)}
  return { items: [] };
}
export function collectTargetOptionsItems(target: any, parentValue: string | null, page: { items: any[] }) {
  const observations: unknown[] = [];
${readExcerpt(excerpts.collectTargetOptionsItems)}
  return observations;
}
`;
  const javascript = stripTypeScriptTypes(source);
  return (await import(`data:text/javascript,${encodeURIComponent(javascript)}`)) as {
    listSetNameOptions: (
      optionKind: string,
      parentValues: Record<string, unknown>,
      client: { listCatalogSetNames(input: { categoryId: number }): Promise<{ results: readonly SetNameInput[] }> },
    ) => Promise<{ items: readonly Record<string, unknown>[] }>;
    collectTargetOptionsItems: (
      target: Record<string, unknown>,
      parentValue: string | null,
      page: { items: readonly Record<string, unknown>[] },
    ) => readonly Record<string, unknown>[];
  };
}

async function generate() {
  const mapper = await loadHistoricalMapper();
  const generatedUnits = [];
  for (const unit of units) {
    const parentValue = String(unit.productLineId);
    const options = await mapper.listSetNameOptions(
      "set-names",
      { productLineId: parentValue },
      { listCatalogSetNames: async () => ({ results: unit.sets }) },
    );
    // The option-query layer delivered CatalogProviderIntegrationOption values: imageUrl null, metadata object.
    const items = options.items.map((item) => ({
      ...item,
      imageUrl: item.imageUrl ?? null,
      metadata: item.metadata ?? {},
    }));
    const target = {
      providerKey: "tcgplayer",
      ingestionUnitKey: unit.unitKey,
      scopeKind: unit.scopeKind,
      queryKind: "set-names",
      languageCode: "en",
      parentRequired: true,
    };
    generatedUnits.push({
      productLineId: unit.productLineId,
      unitKey: unit.unitKey,
      sets: unit.sets,
      observations: mapper.collectTargetOptionsItems(target, parentValue, { items }),
    });
  }
  const fixture = {
    synthetic: true,
    provenance:
      "Synthetic SetNames inputs and the observations the removed server discovery path produced for them, generated by executing the historical mapper. Inputs are not provider captures.",
    historicalMapper: {
      commit,
      adapter: { path: adapterPath, blob: blobId(adapterPath), lines: "526-555, 1265-1268, 1282-1290, 1292-1299" },
      collectTargetOptions: { path: runtimePath, blob: blobId(runtimePath), lines: "369-385" },
      generator:
        "bounded-contexts/catalog/features/operator-session/tests/fixtures/generate-tcgplayer-set-name-observations-salvage.ts",
    },
    units: generatedUnits,
  };
  const output = fileURLToPath(new URL("./tcgplayer-set-name-observations.salvage.json", import.meta.url));
  writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
}

await generate();
