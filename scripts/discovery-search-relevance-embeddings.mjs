import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const RELEVANCE_FIXTURE_MODEL = "deterministic-relevance-v1";
export const RELEVANCE_FIXTURE_DIMENSIONS = 1_024;
const CONCEPT_OFFSET = 8;
const RAW_TOKEN_OFFSET = 256;

const concepts = [
  ["charizard", /charizard|charzard|lizardon|リザードン|final kanto (?:flame )?evolution/iu],
  ["fire", /fire|flame|scorch|炎/iu],
  ["dragon", /dragon|winged|charizard|charzard|lizardon|リザードン/iu],
  ["sealed", /sealed|factory wrapped|factory-wrapped|unopened/iu],
  ["box", /box|display|collection|bundle|kit/iu],
  ["pikachu", /pikachu|pikachoo|ピカチュウ|kanto mascot/iu],
  ["electric", /electric|crackling cheeks/iu],
  ["mouse", /mouse|pikachu|pikachoo|ピカチュウ|kanto mascot/iu],
  ["snorlax", /snorlax|kabigon|カビゴン|drowsy heavyweight|sleeping giant/iu],
  ["moon", /moon|lunar|moonbreon/iu],
  ["dark", /dark|nocturnal|umbreon|moonbreon|ブラッキー/iu],
  ["umbreon", /umbreon|moonbreon|ブラッキー/iu],
  ["gengar", /gengar|ゲンガー|grinning spectral/iu],
  ["ghost", /ghost|spectral|gengar|ゲンガー/iu],
  ["alternate-art", /alternate art|alternate artwork|special illustration|illustrated/iu],
  ["dragonite", /dragonite|kairyu|カイリュー|orange courier/iu],
  ["mail", /mail|courier/iu],
  ["mewtwo", /mewtwo|ミュウツー|engineered legendary/iu],
  ["psychic", /psychic|mind-powered|laboratory|engineered/iu],
  ["lugia", /lugia|ルギア|guardian resting beneath ocean/iu],
  ["ocean", /ocean|sea|currents/iu],
  ["rayquaza", /rayquaza|レックウザ|emerald legendary serpent/iu],
  ["sky", /sky|clouds|soaring|circling high/iu],
  ["green", /green|emerald/iu],
  ["blastoise", /blastoise|kamex|カメックス|armored kanto/iu],
  ["water", /water|cannons|ocean/iu],
  ["turtle", /turtle|blastoise|kamex|カメックス|armored/iu],
  ["venusaur", /venusaur|fushigibana|フシギバナ|flowering plant/iu],
  ["flower", /flower|plant|venusaur|fushigibana|フシギバナ/iu],
  ["starter", /starter|kanto final evolution/iu],
  ["trainer-kit", /trainer kit|elite trainer|etb|sleeves|dice|accessories/iu],
  ["premium", /premium|ultra-premium|ultra premium/iu],
  ["rocket", /team rocket|rocket pack|old rocket/iu],
  ["vintage", /vintage|old|base set|jungle|fossil|neo genesis/iu],
  ["wrapper", /wrapper|booster pack/iu],
  ["magikarp", /magikarp|koiking|コイキング|red swimmer/iu],
  ["fish", /fish|swimmer|magikarp|koiking|コイキング/iu],
  ["illustration", /illustration|illustrated|artwork/iu],
];

export function deterministicSparseEmbedding(text) {
  const normalized = normalize(text);
  const values = new Map();

  for (const [index, [, pattern]] of concepts.entries()) {
    if (pattern.test(normalized)) add(values, CONCEPT_OFFSET + index, 4);
  }

  for (const token of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (token.length < 2) continue;
    add(values, RAW_TOKEN_OFFSET + (stableHash(token) % (RELEVANCE_FIXTURE_DIMENSIONS - RAW_TOKEN_OFFSET)), 1);
  }

  const magnitude = Math.sqrt([...values.values()].reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    add(
      values,
      RAW_TOKEN_OFFSET + (stableHash(normalized || "empty") % (RELEVANCE_FIXTURE_DIMENSIONS - RAW_TOKEN_OFFSET)),
      1,
    );
  }
  const finalMagnitude = Math.sqrt([...values.values()].reduce((sum, value) => sum + value * value, 0));
  return [...values.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, value]) => [index, Number((value / finalMagnitude).toFixed(8))]);
}

export function expandSparseEmbedding(components, dimensions = RELEVANCE_FIXTURE_DIMENSIONS) {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const component of components) {
    if (!Array.isArray(component) || component.length !== 2)
      throw new Error("Embedding component must be [index, value].");
    const [index, value] = component;
    if (!Number.isInteger(index) || index < 0 || index >= dimensions || !Number.isFinite(value)) {
      throw new Error("Embedding component is outside the declared dimensions.");
    }
    vector[index] = value;
  }
  return vector;
}

export async function buildRelevanceEmbeddingFixture({ catalogItems, goldenQueries, buildDocument }) {
  const documents = {};
  for (const item of catalogItems) {
    const document = buildDocument({
      title: item.title,
      subtitle: item.subtitle,
      description: item.description,
      categoryNames: item.categories,
      keyFieldValues: item.tags,
      resolvedAliases: {
        [item.languageCode]: item.aliases.map((aliasText) => ({ aliasText })),
      },
    });
    documents[item.catalogItemId] = deterministicSparseEmbedding(document.text);
  }
  const queries = Object.fromEntries(
    goldenQueries.map((goldenQuery) => [goldenQuery.id, deterministicSparseEmbedding(goldenQuery.query)]),
  );
  return {
    version: 1,
    model: RELEVANCE_FIXTURE_MODEL,
    dimensions: RELEVANCE_FIXTURE_DIMENSIONS,
    sourceHash: fixtureSourceHash(catalogItems, goldenQueries),
    documents,
    queries,
  };
}

export function fixtureSourceHash(catalogItems, goldenQueries) {
  return createHash("sha256").update(JSON.stringify({ catalogItems, goldenQueries })).digest("hex");
}

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const fixtureDirectory = path.join(root, "bounded-contexts/discovery/tests/fixtures/search-relevance");
  const [catalogItems, goldenQueries] = await Promise.all([
    readJson(path.join(fixtureDirectory, "catalog-items.json")),
    readJson(path.join(fixtureDirectory, "golden-queries.json")),
  ]);
  const { register } = await import("node:module");
  register("./typescript-source-loader.mjs", import.meta.url);
  const { buildDiscoveryEmbeddingDocument } =
    await import("../bounded-contexts/discovery/features/search/domain/embedding-document.ts");
  const fixture = await buildRelevanceEmbeddingFixture({
    catalogItems,
    goldenQueries,
    buildDocument: buildDiscoveryEmbeddingDocument,
  });
  const outputPath = path.join(fixtureDirectory, "fixture-embeddings.json");
  await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Wrote ${path.relative(root, outputPath)} (${Object.keys(fixture.documents).length} documents, ${Object.keys(fixture.queries).length} queries).\n`,
  );
}

function normalize(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-US").replace(/[-_]+/gu, " ").trim();
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function add(values, index, weight) {
  values.set(index, (values.get(index) ?? 0) + weight);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
