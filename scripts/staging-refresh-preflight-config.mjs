// Canonical, support-safe inputs for the representative staging refresh preflight.
// Keep provider option identifiers here; the runner never records raw provider URLs,
// credentials, account identifiers, or option payloads.

export const STAGING_REFRESH_PREFLIGHT_VERSION = "staging-refresh-preflight/v1";

export const stagingRefreshRequiredSecrets = Object.freeze([
  { name: "TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE", valueKind: "present" },
  { name: "SCRYDEX_API_KEY", valueKind: "present" },
  { name: "SCRYDEX_TEAM_ID", valueKind: "present" },
  { name: "STRIPE_SECRET_KEY", valueKind: "stripe-secret-test" },
  { name: "STRIPE_PUBLISHABLE_KEY", valueKind: "stripe-publishable-test" },
  { name: "STRIPE_WEBHOOK_SECRET", valueKind: "stripe-webhook" },
  { name: "EASYPOST_API_KEY", valueKind: "easypost-test" },
]);

export const stagingRefreshCredentialedProviders = Object.freeze(["tcgplayer", "scrydex"]);

export const stagingRefreshOverlapWorkflowFiles = Object.freeze([
  ".github/workflows/platform-production.yml",
  ".github/workflows/platform-staging-reset.yml",
  ".github/workflows/platform-staging-wake-drills.yml",
  ".github/workflows/platform-staging-mixed-version-wake-drills.yml",
  ".github/workflows/platform-database-restore-drill.yml",
  ".github/workflows/catalog-staging-provider-uat.yml",
  ".github/workflows/platform-staging-representative-commerce-state.yml",
]);

function choice(queryKind, labels, values = [], extra = {}) {
  return Object.freeze({ queryKind, labels: Object.freeze(labels), values: Object.freeze(values), ...extra });
}

function providerSetCheck({ id, productLine, providerKey, unitKeys, labels, values = [] }) {
  return Object.freeze({
    id,
    productLine,
    providerKey,
    unitKeys: Object.freeze(unitKeys),
    selections: Object.freeze([choice("sets", labels, values)]),
  });
}

function tcgplayerSetCheck({ id, productLine, unitKeys, productLineLabels, productLineValues, setLabels }) {
  return Object.freeze({
    id,
    productLine,
    providerKey: "tcgplayer",
    unitKeys: Object.freeze(unitKeys),
    selections: Object.freeze([
      choice("product-lines", productLineLabels, productLineValues),
      choice("set-names", setLabels, [], { parentFrom: 0 }),
    ]),
  });
}

function tcgdexExpansionCheck({
  id,
  languageLabels,
  languageValues,
  seriesLabels = ["Scarlet & Violet"],
  seriesValues = ["SV"],
  expansionLabels,
  expansionValues,
}) {
  return Object.freeze({
    id,
    productLine: "pokemon",
    providerKey: "tcgdex",
    unitKeys: Object.freeze(["tcgdex:pokemon:single-card:source-observation-import"]),
    selections: Object.freeze([
      choice("languages", languageLabels, languageValues),
      choice("series", seriesLabels, seriesValues, { languageFrom: 0 }),
      choice("expansions", expansionLabels, expansionValues, { languageFrom: 0, parentFrom: 1 }),
    ]),
  });
}

const tcgplayerPokemonUnits = [
  "tcgplayer:pokemon:single-card:source-observation-import",
  "tcgplayer:pokemon:sealed-product:source-observation-import",
];
const tcgplayerMtgUnits = [
  "tcgplayer:mtg:single-card:source-observation-import",
  "tcgplayer:mtg:sealed-product:source-observation-import",
];
const tcgplayerLorcanaUnits = [
  "tcgplayer:lorcana:single-card:source-observation-import",
  "tcgplayer:lorcana:sealed-product:source-observation-import",
];

// This matrix mirrors the representative staging-refresh epic. It deliberately excludes the fixture-backed
// Scrydex Lorcana sealed profile, which is not a production staging-refresh unit.
export const stagingRefreshSetMatrix = Object.freeze([
  tcgdexExpansionCheck({
    id: "pokemon-en-base-set-tcgdex",
    languageLabels: ["English"],
    languageValues: ["en"],
    seriesLabels: ["Base"],
    seriesValues: ["base"],
    expansionLabels: ["Base Set"],
    expansionValues: ["base1"],
  }),
  tcgplayerSetCheck({
    id: "pokemon-en-base-set-tcgplayer",
    productLine: "pokemon",
    unitKeys: tcgplayerPokemonUnits,
    productLineLabels: ["Pokemon"],
    productLineValues: ["3"],
    setLabels: ["Base Set"],
  }),
  tcgplayerSetCheck({
    id: "pokemon-en-surging-sparks-tcgplayer",
    productLine: "pokemon",
    unitKeys: tcgplayerPokemonUnits,
    productLineLabels: ["Pokemon"],
    productLineValues: ["3"],
    setLabels: ["Surging Sparks"],
  }),
  tcgdexExpansionCheck({
    id: "pokemon-en-surging-sparks-tcgdex",
    languageLabels: ["English"],
    languageValues: ["en"],
    expansionLabels: ["Surging Sparks"],
    expansionValues: ["SV08", "SV8"],
  }),
  tcgdexExpansionCheck({
    id: "pokemon-ja-super-electric-breaker-tcgdex",
    languageLabels: ["Japanese"],
    languageValues: ["ja"],
    expansionLabels: ["Super Electric Breaker", "Surging Sparks"],
    expansionValues: ["SV8", "SV08"],
  }),
  tcgdexExpansionCheck({
    id: "pokemon-ja-triplet-beat-tcgdex",
    languageLabels: ["Japanese"],
    languageValues: ["ja"],
    expansionLabels: ["Triplet Beat"],
    expansionValues: ["SV1a"],
  }),
  tcgdexExpansionCheck({
    id: "pokemon-zh-tw-surging-sparks-tcgdex",
    languageLabels: ["Traditional Chinese", "Chinese Traditional"],
    languageValues: ["zh-tw"],
    expansionLabels: ["Surging Sparks"],
    expansionValues: ["SV08", "SV8"],
  }),
  tcgdexExpansionCheck({
    id: "pokemon-ko-surging-sparks-tcgdex",
    languageLabels: ["Korean"],
    languageValues: ["ko"],
    expansionLabels: ["Surging Sparks"],
    expansionValues: ["SV08", "SV8"],
  }),
  providerSetCheck({
    id: "mtg-fifth-dawn-mtgjson",
    productLine: "mtg",
    providerKey: "mtgjson",
    unitKeys: ["mtgjson:mtg:set:reference-data"],
    labels: ["Fifth Dawn"],
    values: ["5DN"],
  }),
  providerSetCheck({
    id: "mtg-time-spiral-mtgjson",
    productLine: "mtg",
    providerKey: "mtgjson",
    unitKeys: ["mtgjson:mtg:set:reference-data"],
    labels: ["Time Spiral"],
    values: ["TSP"],
  }),
  providerSetCheck({
    id: "mtg-fifth-dawn-scryfall",
    productLine: "mtg",
    providerKey: "scryfall",
    unitKeys: ["scryfall:mtg:single-card:reference-data"],
    labels: ["Fifth Dawn"],
    values: ["5DN"],
  }),
  providerSetCheck({
    id: "mtg-time-spiral-scryfall",
    productLine: "mtg",
    providerKey: "scryfall",
    unitKeys: ["scryfall:mtg:single-card:reference-data"],
    labels: ["Time Spiral"],
    values: ["TSP"],
  }),
  tcgplayerSetCheck({
    id: "mtg-fifth-dawn-tcgplayer",
    productLine: "mtg",
    unitKeys: tcgplayerMtgUnits,
    productLineLabels: ["Magic", "Magic: The Gathering"],
    productLineValues: ["1"],
    setLabels: ["Fifth Dawn"],
  }),
  tcgplayerSetCheck({
    id: "mtg-time-spiral-tcgplayer",
    productLine: "mtg",
    unitKeys: tcgplayerMtgUnits,
    productLineLabels: ["Magic", "Magic: The Gathering"],
    productLineValues: ["1"],
    setLabels: ["Time Spiral"],
  }),
  providerSetCheck({
    id: "yugioh-legend-blue-eyes-ygoprodeck",
    productLine: "yugioh",
    providerKey: "ygoprodeck",
    unitKeys: ["ygoprodeck:yugioh:single-card:reference-data"],
    labels: ["Legend of Blue Eyes White Dragon"],
  }),
  providerSetCheck({
    id: "yugioh-rarity-collection-ygoprodeck",
    productLine: "yugioh",
    providerKey: "ygoprodeck",
    unitKeys: ["ygoprodeck:yugioh:single-card:reference-data"],
    labels: ["25th Anniversary Rarity Collection"],
  }),
  providerSetCheck({
    id: "yugioh-legend-blue-eyes-ygojson",
    productLine: "yugioh",
    providerKey: "ygojson",
    unitKeys: ["ygojson:yugioh:set:reference-data"],
    labels: ["Legend of Blue Eyes White Dragon"],
  }),
  providerSetCheck({
    id: "yugioh-rarity-collection-ygojson",
    productLine: "yugioh",
    providerKey: "ygojson",
    unitKeys: ["ygojson:yugioh:set:reference-data"],
    labels: ["25th Anniversary Rarity Collection"],
  }),
  tcgplayerSetCheck({
    id: "yugioh-legend-blue-eyes-tcgplayer",
    productLine: "yugioh",
    unitKeys: ["tcgplayer:yugioh:single-card:source-observation-import"],
    productLineLabels: ["Yu-Gi-Oh!", "Yu-Gi-Oh", "YuGiOh"],
    productLineValues: ["2"],
    setLabels: ["Legend of Blue Eyes White Dragon"],
  }),
  tcgplayerSetCheck({
    id: "yugioh-rarity-collection-tcgplayer",
    productLine: "yugioh",
    unitKeys: ["tcgplayer:yugioh:single-card:source-observation-import"],
    productLineLabels: ["Yu-Gi-Oh!", "Yu-Gi-Oh", "YuGiOh"],
    productLineValues: ["2"],
    setLabels: ["25th Anniversary Rarity Collection"],
  }),
  providerSetCheck({
    id: "one-piece-romance-dawn-scrydex-cards",
    productLine: "one-piece",
    providerKey: "scrydex",
    unitKeys: ["scrydex:one-piece:single-card:source-observation-import"],
    labels: ["Romance Dawn"],
    values: ["op-01", "OP01", "OP-01"],
  }),
  providerSetCheck({
    id: "one-piece-op09-scrydex-sealed",
    productLine: "one-piece",
    providerKey: "scrydex",
    unitKeys: ["scrydex:one-piece:sealed-product:source-observation-import"],
    labels: ["Emperors In The New World"],
    values: ["OP09", "OP-09"],
  }),
  tcgplayerSetCheck({
    id: "one-piece-romance-dawn-tcgplayer",
    productLine: "one-piece",
    unitKeys: ["tcgplayer:one-piece:single-card:source-observation-import"],
    productLineLabels: ["One Piece Card Game"],
    productLineValues: ["68"],
    setLabels: ["Romance Dawn"],
  }),
  ...["The First Chapter", "Rise of the Floodborn"].flatMap((setLabel) => {
    const slug = setLabel === "The First Chapter" ? "first-chapter" : "rise-floodborn";
    const values = setLabel === "The First Chapter" ? ["TFC", "1"] : ["ROTF", "2"];
    return [
      providerSetCheck({
        id: `lorcana-${slug}-lorcanajson`,
        productLine: "lorcana",
        providerKey: "lorcanajson",
        unitKeys: ["lorcanajson:lorcana:single-card:reference-data", "lorcanajson:lorcana:set:reference-data"],
        labels: [setLabel],
        values,
      }),
      providerSetCheck({
        id: `lorcana-${slug}-lorcast`,
        productLine: "lorcana",
        providerKey: "lorcast",
        unitKeys: ["lorcast:lorcana:single-card:reference-data", "lorcast:lorcana:set:reference-data"],
        labels: [setLabel],
        values,
      }),
      providerSetCheck({
        id: `lorcana-${slug}-scrydex`,
        productLine: "lorcana",
        providerKey: "scrydex",
        unitKeys: ["scrydex:lorcana:single-card:source-observation-import", "scrydex:lorcana:set:reference-data"],
        labels: [setLabel],
        values,
      }),
      tcgplayerSetCheck({
        id: `lorcana-${slug}-tcgplayer`,
        productLine: "lorcana",
        unitKeys: tcgplayerLorcanaUnits,
        productLineLabels: ["Disney Lorcana", "Lorcana"],
        productLineValues: [],
        setLabels: [setLabel],
      }),
    ];
  }),
]);
