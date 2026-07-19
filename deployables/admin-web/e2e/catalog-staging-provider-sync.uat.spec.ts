import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

const catalogWorkbenchCommand = {
  sync: "scope.sync",
  import: "scope.import",
  promote: "observation.promote",
  reapply: "observation.reapply",
} as const;

const sourceScopeWorksetDataContract = readFileSync(
  "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-source-scope-workset.ts",
  "utf8",
);
const sourceScopeWorksetRenderContract = readFileSync(
  "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/import-to-promotion/source-scope-workset-module.tsx",
  "utf8",
);
const catalogSyncScopeRenderContract = readFileSync(
  "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/import-to-promotion/catalog-sync-scope-module.tsx",
  "utf8",
);

const runStagingProviderUat = process.env.CATALOG_STAGING_PROVIDER_UAT === "true";
const providerUatJourneyScope = process.env.CATALOG_STAGING_PROVIDER_UAT_SCOPE?.trim() || "one-piece-launch";
const catalogAdminEmail = process.env.CATALOG_ADMIN_E2E_EMAIL?.trim() ?? "";
const catalogAdminPassword = process.env.CATALOG_ADMIN_E2E_PASSWORD?.trim() ?? "";
const pageReadyTimeoutMs = 90_000;
const sourceOptionTimeoutMs = 90_000;
const syncTimeoutMs = 120_000;
const terminalSyncTimeoutMs = 720_000;
const downstreamProjectionTimeoutMs = 300_000;
const controlActionTimeoutMs = 10_000;
const supportSafeDiagnosticMaxLength = 2_000;
const uatTestTimeoutMs =
  Number.parseInt(process.env.CATALOG_STAGING_PROVIDER_UAT_TEST_TIMEOUT_MS?.trim() ?? "", 10) || 3_000_000;
const supportedProviderUatJourneyScopes = [
  "one-piece-launch",
  "lorcana-launch",
  "tcgplayer-pokemon-targeted",
  "all-provider-regression",
  "staging-representative-catalog",
  "pokemon-matrix",
  "mtg-matrix",
  "yugioh-matrix",
  "one-piece-matrix",
  "lorcana-matrix",
  "full-matrix-uat",
] as const;

type SelectChoice = Readonly<{
  labels?: readonly string[];
  values?: readonly string[];
  fallbackToFirstAvailableOption?: Readonly<{
    valuePattern?: RegExp;
  }>;
}>;

type SelectedScopeChoice = Readonly<{
  label: string | RegExp;
  values: readonly string[];
}>;

type ScopeSelection = Readonly<{
  label: string | RegExp;
  choice: SelectChoice;
}>;

type ProviderSyncJourney = Readonly<{
  name: string;
  providerKey: string;
  unitKey: string;
  scope: readonly ScopeSelection[];
  preflight?: ImportPreflightExpectation;
  requiresTerminalSync?: boolean;
  allowPartialWithReview?: boolean;
}>;

type ImportPreflightExpectation = Readonly<{
  requestStrategy?: string;
  allowedUsageStates?: readonly string[];
  visibleText: readonly (string | RegExp)[];
}>;

type SelectedProviderScope = Readonly<{
  providerKey: string;
  importScope: string | null;
  displayLabel: string;
  fields: readonly SelectedProviderScopeField[];
}>;

type SelectedProviderScopeField = Readonly<{
  name: string;
  value: string;
}>;

type ProviderSyncAttempt = Readonly<{
  previousJobRows: readonly string[];
}>;

type CatalogSyncAttempt = Readonly<{
  previousJobRows: readonly string[];
}>;

type TargetedTcgplayerPokemonProgress = {
  checkpoint: string;
  nextBlocker: string;
  observed: readonly string[];
  lastLoggedAt: number;
};

type LorcanaDownstreamSmokeResult = Readonly<{
  mode: "promote" | "reapply";
  providerKey: string;
  unitKey: string;
  selectedScope: string;
  selectedObservationIds: readonly string[];
  promotionPreviewId: string | null;
  jobId: string | null;
}>;

type MissingOptionRecovery = () => Promise<boolean>;

const preferredYugiohSetLabels = [
  "25th Anniversary Rarity Collection",
  "2-Player Starter Set",
  "Starter Deck: Yugi",
  "Legend of Blue Eyes White Dragon",
] as const;

const yugiohSetChoice: SelectChoice = {
  labels: preferredYugiohSetLabels,
};

const ygojsonSetChoice: SelectChoice = {
  labels: preferredYugiohSetLabels,
  fallbackToFirstAvailableOption: {
    valuePattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  },
};

const tcgplayerYugiohSetChoice: SelectChoice = {
  labels: ["Ancient Sanctuary", "Absolute Powerforce", "Bonds Beyond Time Movie Pack"],
  fallbackToFirstAvailableOption: {},
};

const onePieceScrydexSetChoice: SelectChoice = {
  labels: ["Romance Dawn"],
  values: ["op-01", "OP01", "OP-01"],
  fallbackToFirstAvailableOption: { valuePattern: /^(?:OP|ST|EB|PRB)-?\d+$/i },
};

const onePieceScrydexSealedSetChoice: SelectChoice = {
  labels: ["Emperors In The New World", "Romance Dawn"],
  values: ["OP09", "op-01", "OP01", "OP-01"],
  fallbackToFirstAvailableOption: { valuePattern: /^OP-?0?9$/i },
};

const tcgplayerOnePieceSetChoice: SelectChoice = {
  labels: ["Romance Dawn"],
  fallbackToFirstAvailableOption: {},
};

const mtgjsonMtgSetChoice: SelectChoice = {
  labels: ["Fifth Dawn", "Time Spiral"],
  values: ["5DN", "TSP"],
  fallbackToFirstAvailableOption: { valuePattern: /^[A-Z0-9]+$/ },
};

const lorcanaSetChoice: SelectChoice = {
  labels: ["The First Chapter"],
  values: ["TFC", "1"],
};

const tcgplayerLorcanaSetChoice: SelectChoice = {
  labels: ["The First Chapter"],
};

const lorcanaFloodbornSetChoice: SelectChoice = {
  labels: ["Rise of the Floodborn"],
  values: ["ROTF", "2"],
};

const tcgplayerLorcanaFloodbornSetChoice: SelectChoice = {
  labels: ["Rise of the Floodborn"],
};

const tcgplayerLorcanaProductLineChoice: SelectChoice = {
  labels: ["Disney Lorcana", "Lorcana"],
  fallbackToFirstAvailableOption: {},
};

const tcgdexSurgingSparksExpansionChoice: SelectChoice = {
  labels: ["Surging Sparks"],
  values: ["SV08", "SV8"],
  fallbackToFirstAvailableOption: { valuePattern: /^SV0?8$/i },
};

const tcgdexBattlePartnersExpansionChoice: SelectChoice = {
  labels: ["Battle Partners"],
  values: ["SV09", "SV9"],
  fallbackToFirstAvailableOption: { valuePattern: /^SV0?9$/i },
};

const scryfallFifthDawnSetChoice: SelectChoice = {
  labels: ["Fifth Dawn"],
  values: ["5DN"],
  fallbackToFirstAvailableOption: { valuePattern: /^5DN$/i },
};

const scryfallTimeSpiralSetChoice: SelectChoice = {
  labels: ["Time Spiral"],
  values: ["TSP"],
  fallbackToFirstAvailableOption: { valuePattern: /^TSP$/i },
};

const tcgplayerMtgProductLineChoice: SelectChoice = {
  labels: ["Magic", "Magic: The Gathering"],
  values: ["1"],
  fallbackToFirstAvailableOption: {},
};

const tcgplayerFifthDawnSetChoice: SelectChoice = {
  labels: ["Fifth Dawn"],
  fallbackToFirstAvailableOption: {},
};

const tcgplayerTimeSpiralSetChoice: SelectChoice = {
  labels: ["Time Spiral"],
  fallbackToFirstAvailableOption: {},
};

// --- Full provider x product-line x form matrix option selectors ---------------
// The matrix proves every current provider and product line through at least two
// expansions AND a sealed form per game, plus Pokemon English + Japanese with
// localization matching. These selectors declare the preferred set/expansion for
// each cell; live staging option lists resolve the concrete id via the shared
// label -> value -> fallback resolution, and any substitution the operator makes
// against live selectors is recorded on the tracking issue during preflight.

// Pokemon English: two Scarlet & Violet-era expansions synced through both TCGdex
// and TCGplayer so cross-provider candidates merge into one Catalog Item per card.
const tcgplayerPokemonProductLineChoice: SelectChoice = { labels: ["Pokemon"], values: ["3"] };
const tcgplayerPokemonSurgingSparksSetChoice: SelectChoice = {
  labels: ["Surging Sparks"],
  fallbackToFirstAvailableOption: {},
};
const tcgplayerPokemonBattlePartnersSetChoice: SelectChoice = {
  labels: ["Battle Partners", "Journey Together"],
  fallbackToFirstAvailableOption: {},
};

// Pokemon Japanese: the same two expansions as the English rows, addressed by
// their Japanese-language editions so set-equivalent aliases link EN <-> JA.
const tcgdexJapaneseSurgingSparksExpansionChoice: SelectChoice = {
  labels: ["Super Electric Breaker", "Surging Sparks"],
  values: ["SV8", "SV08"],
  fallbackToFirstAvailableOption: { valuePattern: /^SV0?8[a-z]?$/i },
};
const tcgdexJapaneseBattlePartnersExpansionChoice: SelectChoice = {
  labels: ["Battle Partners"],
  values: ["SV9", "SV09"],
  fallbackToFirstAvailableOption: { valuePattern: /^SV0?9[a-z]?$/i },
};

// MTG: split the MTGJSON set-reference pull into two explicit expansions so the
// reference-data, image-evidence, and source-observation roles all participate in
// the same per-game sync run across two expansions.
const mtgjsonFifthDawnSetChoice: SelectChoice = {
  labels: ["Fifth Dawn"],
  values: ["5DN"],
  fallbackToFirstAvailableOption: { valuePattern: /^5DN$/i },
};
const mtgjsonTimeSpiralSetChoice: SelectChoice = {
  labels: ["Time Spiral"],
  values: ["TSP"],
  fallbackToFirstAvailableOption: { valuePattern: /^TSP$/i },
};

// Yu-Gi-Oh!: a second expansion per provider so pack-reference and sealed kinds
// promote cleanly alongside single-card imports.
const yugiohSecondSetChoice: SelectChoice = {
  labels: ["Metal Raiders", "Pharaoh's Servant"],
  fallbackToFirstAvailableOption: {},
};
const ygojsonSecondSetChoice: SelectChoice = {
  labels: ["Metal Raiders", "Pharaoh's Servant"],
  fallbackToFirstAvailableOption: {
    valuePattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  },
};
const tcgplayerYugiohSecondSetChoice: SelectChoice = {
  labels: ["Metal Raiders", "Pharaoh's Servant"],
  fallbackToFirstAvailableOption: {},
};

// One Piece: a second expansion so the credit-aware bulk-first preflight is proven
// across more than a single Scrydex expansion.
const onePieceScrydexSecondSetChoice: SelectChoice = {
  labels: ["Paramount War"],
  values: ["op-02", "OP02", "OP-02"],
  fallbackToFirstAvailableOption: { valuePattern: /^(?:OP|ST|EB|PRB)-?0?2$/i },
};
const onePieceScrydexSecondSealedSetChoice: SelectChoice = {
  labels: ["Paramount War"],
  values: ["op-02", "OP02", "OP-02"],
  fallbackToFirstAvailableOption: { valuePattern: /^(?:OP|ST|EB|PRB)-?0?2$/i },
};
const tcgplayerOnePieceSecondSetChoice: SelectChoice = {
  labels: ["Paramount War"],
  fallbackToFirstAvailableOption: {},
};

const tcgplayerPokemonUnitKey = "tcgplayer:pokemon:single-card:source-observation-import";

const tcgplayerPokemonProviderSyncJourney: ProviderSyncJourney = {
  name: "Pokemon set through the shared TCGplayer provider",
  providerKey: "tcgplayer",
  unitKey: tcgplayerPokemonUnitKey,
  scope: [
    { label: "Product Line", choice: { labels: ["Pokemon"], values: ["3"] } },
    { label: "Set Name", choice: { labels: ["Base Set"], fallbackToFirstAvailableOption: {} } },
  ],
  requiresTerminalSync: true,
};

const onePieceLaunchProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "One Piece card set through Scrydex bulk-first shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:one-piece:single-card:source-observation-import",
    scope: [{ label: "Set", choice: onePieceScrydexSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: [
        "Import preflight",
        "250",
        "id, name, number, printed_number, rarity, rarity_code, type, images, language, language_code, expansion, printings, variants",
        "Bulk-first",
        /Scrydex One Piece cards .*max page size/i,
        /scrydex:one-piece:expansion:[a-z0-9-]+:cards/i,
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "One Piece sealed products through Scrydex bulk-first shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:one-piece:sealed-product:source-observation-import",
    scope: [{ label: "Set", choice: onePieceScrydexSealedSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: [
        "Import preflight",
        "100",
        "id, name, type, images, language, language_code, expansion",
        "Bulk-first",
        "Fetch Scrydex One Piece expansion sealed products with max page size",
        /scrydex:one-piece:expansion:[a-z0-9-]+:sealed/i,
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "One Piece set through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:one-piece:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: { labels: ["One Piece Card Game"], values: ["68"] } },
      { label: "Set Name", choice: tcgplayerOnePieceSetChoice },
    ],
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
  {
    name: "Pokemon set regression through TCGdex",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Language", choice: { labels: ["Japanese"], values: ["ja"] } },
      { label: "Series", choice: { labels: ["Scarlet & Violet"], values: ["SV"] } },
      { label: "Expansion", choice: { labels: ["Super Electric Breaker"], values: ["SV8"] } },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "MTG set regression through MTGJSON shared importer",
    providerKey: "mtgjson",
    unitKey: "mtgjson:mtg:set:reference-data",
    scope: [{ label: "Set", choice: mtgjsonMtgSetChoice }],
    requiresTerminalSync: true,
  },
];

const lorcanaLaunchProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "Lorcana card set through Scrydex bulk-first shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:lorcana:single-card:source-observation-import",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: [
        "Import preflight",
        "250",
        "id, name, number, printed_number, rarity, rarity_code, type, ink, ink_color, images, language, language_code, expansion, printings, variants, tcgplayer_id",
        "Bulk-first",
        /Scrydex Lorcana cards .*max page size/i,
        /scrydex:lorcana:expansion:[a-z0-9-]+:cards/i,
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "Lorcana set reference through Scrydex shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:lorcana:set:reference-data",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "single-record",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: [
        "Import preflight",
        "1",
        "Fetch Scrydex Lorcana expansion by id",
        "Selected set-reference import uses the Scrydex expansion detail endpoint.",
        /scrydex:lorcana:set:[a-z0-9-]+$/i,
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "Lorcana card set through LorcanaJSON bulk-first shared importer",
    providerKey: "lorcanajson",
    unitKey: "lorcanajson:lorcana:single-card:reference-data",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["not-supported", "unknown"],
      visibleText: [
        "Import preflight",
        "1",
        "Bulk-first",
        "Fetch LorcanaJSON set file",
        "Select all card payloads from the selected set",
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "Lorcana set reference through LorcanaJSON bulk-first shared importer",
    providerKey: "lorcanajson",
    unitKey: "lorcanajson:lorcana:set:reference-data",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["not-supported", "unknown"],
      visibleText: [
        "Import preflight",
        "1",
        "Bulk-first",
        "Fetch LorcanaJSON set file",
        "Use allCards.json only for option discovery",
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "Lorcana card set through Lorcast bulk-first shared importer",
    providerKey: "lorcast",
    unitKey: "lorcast:lorcana:single-card:reference-data",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["not-supported", "unknown"],
      visibleText: [
        "Import preflight",
        "1",
        "Bulk-first",
        "Fetch Lorcast set cards endpoint",
        "Prefer cached set payloads for repeat diagnostics",
      ],
    },
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
  {
    name: "Lorcana set reference through Lorcast bulk-first shared importer",
    providerKey: "lorcast",
    unitKey: "lorcast:lorcana:set:reference-data",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["not-supported", "unknown"],
      visibleText: [
        "Import preflight",
        "1",
        "Bulk-first",
        "Fetch Lorcast selected set endpoint",
        "Prefer cached set payloads for repeat diagnostics",
      ],
    },
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
  {
    name: "Lorcana card set through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:lorcana:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: tcgplayerLorcanaProductLineChoice },
      { label: "Set Name", choice: tcgplayerLorcanaSetChoice },
    ],
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
  {
    name: "Lorcana sealed products through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:lorcana:sealed-product:source-observation-import",
    scope: [
      { label: "Product Line", choice: tcgplayerLorcanaProductLineChoice },
      { label: "Set Name", choice: tcgplayerLorcanaSetChoice },
    ],
    requiresTerminalSync: true,
  },
];

const yugiohProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "Yu-Gi-Oh set through YGOPRODeck",
    providerKey: "ygoprodeck",
    unitKey: "ygoprodeck:yugioh:single-card:reference-data",
    scope: [{ label: "Set", choice: yugiohSetChoice }],
  },
  {
    name: "Yu-Gi-Oh set through YGOJSON / YAML Yugi upstream data",
    providerKey: "ygojson",
    unitKey: "ygojson:yugioh:set:reference-data",
    scope: [{ label: "Set", choice: ygojsonSetChoice }],
  },
  {
    name: "Yu-Gi-Oh set through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:yugioh:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: { labels: ["Yu-Gi-Oh!", "Yu-Gi-Oh", "YuGiOh"], values: ["2"] } },
      { label: "Set Name", choice: tcgplayerYugiohSetChoice },
    ],
  },
];

const tcgdexRepresentativePokemonJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "Pokemon English Surging Sparks through TCGdex",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Language", choice: { labels: ["English"], values: ["en"] } },
      { label: "Series", choice: { labels: ["Scarlet & Violet"], values: ["SV"] } },
      { label: "Expansion", choice: tcgdexSurgingSparksExpansionChoice },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "Pokemon Traditional Chinese Surging Sparks through TCGdex",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Language", choice: { labels: ["Traditional Chinese", "Chinese Traditional"], values: ["zh-tw"] } },
      { label: "Series", choice: { labels: ["Scarlet & Violet"], values: ["SV"] } },
      { label: "Expansion", choice: tcgdexSurgingSparksExpansionChoice },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "Pokemon Korean Surging Sparks through TCGdex",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Language", choice: { labels: ["Korean"], values: ["ko"] } },
      { label: "Series", choice: { labels: ["Scarlet & Violet"], values: ["SV"] } },
      { label: "Expansion", choice: tcgdexSurgingSparksExpansionChoice },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "Pokemon Japanese Battle Partners through TCGdex",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Language", choice: { labels: ["Japanese"], values: ["ja"] } },
      { label: "Series", choice: { labels: ["Scarlet & Violet"], values: ["SV"] } },
      { label: "Expansion", choice: tcgdexBattlePartnersExpansionChoice },
    ],
    requiresTerminalSync: true,
  },
];

const scryfallRepresentativeMtgJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "MTG Fifth Dawn card prints through Scryfall",
    providerKey: "scryfall",
    unitKey: "scryfall:mtg:single-card:reference-data",
    scope: [{ label: "Set", choice: scryfallFifthDawnSetChoice }],
    requiresTerminalSync: true,
  },
  {
    name: "MTG Time Spiral card prints through Scryfall",
    providerKey: "scryfall",
    unitKey: "scryfall:mtg:single-card:reference-data",
    scope: [{ label: "Set", choice: scryfallTimeSpiralSetChoice }],
    requiresTerminalSync: true,
  },
];

const tcgplayerRepresentativeMtgJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "MTG Fifth Dawn single cards through TCGplayer",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:mtg:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: tcgplayerMtgProductLineChoice },
      { label: "Set Name", choice: tcgplayerFifthDawnSetChoice },
    ],
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
  {
    name: "MTG Time Spiral single cards through TCGplayer",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:mtg:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: tcgplayerMtgProductLineChoice },
      { label: "Set Name", choice: tcgplayerTimeSpiralSetChoice },
    ],
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
  {
    name: "MTG Fifth Dawn sealed products through TCGplayer",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:mtg:sealed-product:source-observation-import",
    scope: [
      { label: "Product Line", choice: tcgplayerMtgProductLineChoice },
      { label: "Set Name", choice: tcgplayerFifthDawnSetChoice },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "MTG Time Spiral sealed products through TCGplayer",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:mtg:sealed-product:source-observation-import",
    scope: [
      { label: "Product Line", choice: tcgplayerMtgProductLineChoice },
      { label: "Set Name", choice: tcgplayerTimeSpiralSetChoice },
    ],
    requiresTerminalSync: true,
  },
];

const lorcanaFloodbornProviderSyncJourneys: readonly ProviderSyncJourney[] = lorcanaLaunchProviderSyncJourneys.map(
  (journey) => ({
    ...journey,
    name: journey.name.replace("Lorcana", "Lorcana Rise of the Floodborn"),
    scope: journey.scope.map((selection) => ({
      ...selection,
      choice:
        journey.providerKey === "tcgplayer" && selection.label === "Set Name"
          ? tcgplayerLorcanaFloodbornSetChoice
          : selection.label === "Set"
            ? lorcanaFloodbornSetChoice
            : selection.choice,
    })),
  }),
);

const stagingRepresentativeCatalogProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  ...lorcanaLaunchProviderSyncJourneys,
  ...lorcanaFloodbornProviderSyncJourneys,
  ...onePieceLaunchProviderSyncJourneys,
  ...yugiohProviderSyncJourneys,
  ...tcgdexRepresentativePokemonJourneys,
  ...scryfallRepresentativeMtgJourneys,
  ...tcgplayerRepresentativeMtgJourneys,
];

// --- Full provider x product-line x form matrix journeys -----------------------
// Each per-game array runs the scope-first journey end-to-end for every provider
// the game supports, across two expansions and the sealed form, sized to fit the
// per-game 60-minute workflow timeout. The English/Japanese Pokemon rows carry
// the localization pair the matrix links by accepted alias records.

// Pokemon EN + JA: two Scarlet & Violet-era expansions (Surging Sparks, Battle
// Partners) through TCGdex and TCGplayer, TCGplayer sealed, and the Japanese
// editions of the same two expansions through TCGdex for EN <-> JA aliasing.
const pokemonMatrixProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "Pokemon English Surging Sparks through TCGdex",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Language", choice: { labels: ["English"], values: ["en"] } },
      { label: "Series", choice: { labels: ["Scarlet & Violet"], values: ["SV"] } },
      { label: "Expansion", choice: tcgdexSurgingSparksExpansionChoice },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "Pokemon English Battle Partners through TCGdex",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Language", choice: { labels: ["English"], values: ["en"] } },
      { label: "Series", choice: { labels: ["Scarlet & Violet"], values: ["SV"] } },
      { label: "Expansion", choice: tcgdexBattlePartnersExpansionChoice },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "Pokemon English Surging Sparks through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: tcgplayerPokemonProductLineChoice },
      { label: "Set Name", choice: tcgplayerPokemonSurgingSparksSetChoice },
    ],
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
  {
    name: "Pokemon English Battle Partners through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: tcgplayerPokemonProductLineChoice },
      { label: "Set Name", choice: tcgplayerPokemonBattlePartnersSetChoice },
    ],
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
  {
    name: "Pokemon English Surging Sparks sealed products through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:pokemon:sealed-product:source-observation-import",
    scope: [
      { label: "Product Line", choice: tcgplayerPokemonProductLineChoice },
      { label: "Set Name", choice: tcgplayerPokemonSurgingSparksSetChoice },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "Pokemon Japanese Surging Sparks through TCGdex",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Language", choice: { labels: ["Japanese"], values: ["ja"] } },
      { label: "Series", choice: { labels: ["Scarlet & Violet"], values: ["SV"] } },
      { label: "Expansion", choice: tcgdexJapaneseSurgingSparksExpansionChoice },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "Pokemon Japanese Battle Partners through TCGdex",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Language", choice: { labels: ["Japanese"], values: ["ja"] } },
      { label: "Series", choice: { labels: ["Scarlet & Violet"], values: ["SV"] } },
      { label: "Expansion", choice: tcgdexJapaneseBattlePartnersExpansionChoice },
    ],
    requiresTerminalSync: true,
  },
];

// MTG: MTGJSON set-reference, Scryfall single-card reference + image-evidence, and
// TCGplayer single-card + sealed, all across two expansions (Fifth Dawn, Time
// Spiral) so reference-data and image-evidence roles ride the same sync run.
const mtgMatrixProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "MTG Fifth Dawn set reference through MTGJSON shared importer",
    providerKey: "mtgjson",
    unitKey: "mtgjson:mtg:set:reference-data",
    scope: [{ label: "Set", choice: mtgjsonFifthDawnSetChoice }],
    requiresTerminalSync: true,
  },
  {
    name: "MTG Time Spiral set reference through MTGJSON shared importer",
    providerKey: "mtgjson",
    unitKey: "mtgjson:mtg:set:reference-data",
    scope: [{ label: "Set", choice: mtgjsonTimeSpiralSetChoice }],
    requiresTerminalSync: true,
  },
  ...scryfallRepresentativeMtgJourneys,
  {
    name: "MTG Fifth Dawn card images through Scryfall image-evidence role",
    providerKey: "scryfall",
    unitKey: "scryfall:mtg:single-card:image-evidence",
    scope: [{ label: "Set", choice: scryfallFifthDawnSetChoice }],
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
  ...tcgplayerRepresentativeMtgJourneys,
];

// Yu-Gi-Oh!: YGOPRODeck and TCGplayer single-card, plus YGOJSON set-reference,
// pack-reference, and sealed kinds, across two expansions so pack-reference kinds
// promote cleanly alongside single cards.
const yugiohMatrixProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "Yu-Gi-Oh set through YGOPRODeck",
    providerKey: "ygoprodeck",
    unitKey: "ygoprodeck:yugioh:single-card:reference-data",
    scope: [{ label: "Set", choice: yugiohSetChoice }],
  },
  {
    name: "Yu-Gi-Oh second set through YGOPRODeck",
    providerKey: "ygoprodeck",
    unitKey: "ygoprodeck:yugioh:single-card:reference-data",
    scope: [{ label: "Set", choice: yugiohSecondSetChoice }],
  },
  {
    name: "Yu-Gi-Oh set through YGOJSON / YAML Yugi upstream data",
    providerKey: "ygojson",
    unitKey: "ygojson:yugioh:set:reference-data",
    scope: [{ label: "Set", choice: ygojsonSetChoice }],
  },
  {
    name: "Yu-Gi-Oh second set through YGOJSON / YAML Yugi upstream data",
    providerKey: "ygojson",
    unitKey: "ygojson:yugioh:set:reference-data",
    scope: [{ label: "Set", choice: ygojsonSecondSetChoice }],
  },
  {
    name: "Yu-Gi-Oh pack reference through YGOJSON",
    providerKey: "ygojson",
    unitKey: "ygojson:yugioh:pack:reference-data",
    scope: [{ label: "Set", choice: ygojsonSetChoice }],
    allowPartialWithReview: true,
  },
  {
    name: "Yu-Gi-Oh sealed products through YGOJSON",
    providerKey: "ygojson",
    unitKey: "ygojson:yugioh:sealed-product:reference-data",
    scope: [{ label: "Set", choice: ygojsonSetChoice }],
    allowPartialWithReview: true,
  },
  {
    name: "Yu-Gi-Oh set through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:yugioh:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: { labels: ["Yu-Gi-Oh!", "Yu-Gi-Oh", "YuGiOh"], values: ["2"] } },
      { label: "Set Name", choice: tcgplayerYugiohSetChoice },
    ],
    allowPartialWithReview: true,
  },
  {
    name: "Yu-Gi-Oh second set through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:yugioh:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: { labels: ["Yu-Gi-Oh!", "Yu-Gi-Oh", "YuGiOh"], values: ["2"] } },
      { label: "Set Name", choice: tcgplayerYugiohSecondSetChoice },
    ],
    allowPartialWithReview: true,
  },
];

// One Piece: Scrydex single-card + sealed (bulk-first, credit-aware preflight) and
// TCGplayer single-card across two expansions (Romance Dawn, Paramount War).
const onePieceMatrixProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  ...onePieceLaunchProviderSyncJourneys.filter((journey) => journey.unitKey.startsWith("scrydex:one-piece:")),
  {
    name: "One Piece Paramount War card set through Scrydex bulk-first shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:one-piece:single-card:source-observation-import",
    scope: [{ label: "Set", choice: onePieceScrydexSecondSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: [
        "Import preflight",
        "250",
        "id, name, number, printed_number, rarity, rarity_code, type, images, language, language_code, expansion, printings, variants",
        "Bulk-first",
        /Scrydex One Piece cards .*max page size/i,
        /scrydex:one-piece:expansion:[a-z0-9-]+:cards/i,
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "One Piece Paramount War sealed products through Scrydex bulk-first shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:one-piece:sealed-product:source-observation-import",
    scope: [{ label: "Set", choice: onePieceScrydexSecondSealedSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: [
        "Import preflight",
        "100",
        "id, name, type, images, language, language_code, expansion",
        "Bulk-first",
        "Fetch Scrydex One Piece expansion sealed products with max page size",
        /scrydex:one-piece:expansion:[a-z0-9-]+:sealed/i,
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "One Piece Romance Dawn set through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:one-piece:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: { labels: ["One Piece Card Game"], values: ["68"] } },
      { label: "Set Name", choice: tcgplayerOnePieceSetChoice },
    ],
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
  {
    name: "One Piece Paramount War set through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:one-piece:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: { labels: ["One Piece Card Game"], values: ["68"] } },
      { label: "Set Name", choice: tcgplayerOnePieceSecondSetChoice },
    ],
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
];

// Lorcana: the full four-provider merge (Scrydex, LorcanaJSON, Lorcast, TCGplayer)
// across two expansions (First Chapter, Rise of the Floodborn), TCGplayer + Scrydex
// sealed, exercising at least one conflict resolution during candidate review.
const lorcanaMatrixProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  ...lorcanaLaunchProviderSyncJourneys,
  {
    name: "Lorcana sealed products through Scrydex bulk-first shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:lorcana:sealed-product:source-observation-import",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: ["Import preflight", "Bulk-first"],
    },
    requiresTerminalSync: true,
    allowPartialWithReview: true,
  },
  ...lorcanaFloodbornProviderSyncJourneys,
];

// The full matrix, one entry per product line, sized to run per game inside the
// workflow timeout. `full-matrix-uat` fans this out across every game.
const providerProductLineFormMatrixJourneys: readonly ProviderSyncJourney[] = [
  ...pokemonMatrixProviderSyncJourneys,
  ...mtgMatrixProviderSyncJourneys,
  ...yugiohMatrixProviderSyncJourneys,
  ...onePieceMatrixProviderSyncJourneys,
  ...lorcanaMatrixProviderSyncJourneys,
];

// Every provider unit key the matrix is allowed to reference. Mirrors the units
// the catalog context actually registers; a matrix journey that names a unit
// outside this set is a typo or a reference to a unit that no longer exists.
const knownProviderUnitKeys = new Set<string>([
  "lorcanajson:lorcana:set:reference-data",
  "lorcanajson:lorcana:single-card:reference-data",
  "lorcast:lorcana:set:reference-data",
  "lorcast:lorcana:single-card:reference-data",
  "mtgjson:mtg:set:reference-data",
  "mtgjson:mtg:single-card:reference-data",
  "scrydex:lorcana:sealed-product:source-observation-import",
  "scrydex:lorcana:set:reference-data",
  "scrydex:lorcana:single-card:source-observation-import",
  "scrydex:one-piece:sealed-product:source-observation-import",
  "scrydex:one-piece:set:reference-data",
  "scrydex:one-piece:single-card:source-observation-import",
  "scrydex:pokemon:single-card:source-observation-import",
  "scryfall:mtg:single-card:image-evidence",
  "scryfall:mtg:single-card:reference-data",
  "scryfall:mtg:single-card:source-observation-import",
  "tcgdex:pokemon:single-card:source-observation-import",
  "tcgplayer:lorcana:sealed-product:source-observation-import",
  "tcgplayer:lorcana:single-card:source-observation-import",
  "tcgplayer:mtg:sealed-product:source-observation-import",
  "tcgplayer:mtg:single-card:source-observation-import",
  "tcgplayer:one-piece:sealed-product:source-observation-import",
  "tcgplayer:one-piece:single-card:source-observation-import",
  "tcgplayer:pokemon:sealed-product:source-observation-import",
  "tcgplayer:pokemon:single-card:source-observation-import",
  "tcgplayer:yugioh:single-card:source-observation-import",
  "ygojson:yugioh:pack:reference-data",
  "ygojson:yugioh:sealed-product:reference-data",
  "ygojson:yugioh:set:reference-data",
  "ygoprodeck:yugioh:set:reference-data",
  "ygoprodeck:yugioh:single-card:reference-data",
]);

// A matrix row is the acceptance contract for one product line: the providers that
// must all participate, the minimum expansions, the providers whose sealed form
// must be exercised, the localization editions (Pokemon EN/JA), and the extra
// verification the redesign must prove for that game.
type ProviderProductLineFormMatrixRow = Readonly<{
  productLine: string;
  journeys: readonly ProviderSyncJourney[];
  scope: (typeof supportedProviderUatJourneyScopes)[number];
  requiredProviders: readonly string[];
  minExpansions: number;
  sealedProviders: readonly string[];
  localizations?: readonly string[];
  extraVerification: string;
}>;

const providerProductLineFormMatrix: readonly ProviderProductLineFormMatrixRow[] = [
  {
    productLine: "pokemon",
    journeys: pokemonMatrixProviderSyncJourneys,
    scope: "pokemon-matrix",
    requiredProviders: ["tcgdex", "tcgplayer"],
    minExpansions: 2,
    sealedProviders: ["tcgplayer"],
    localizations: ["english", "japanese"],
    extraVerification:
      "cross-provider candidates merge into one Catalog Item per card; EN and JA editions linked by set-equivalent alias",
  },
  {
    productLine: "mtg",
    journeys: mtgMatrixProviderSyncJourneys,
    scope: "mtg-matrix",
    requiredProviders: ["mtgjson", "scryfall", "tcgplayer"],
    minExpansions: 2,
    sealedProviders: ["tcgplayer"],
    extraVerification: "reference-data and image-evidence roles participate in the same sync run",
  },
  {
    productLine: "yugioh",
    journeys: yugiohMatrixProviderSyncJourneys,
    scope: "yugioh-matrix",
    requiredProviders: ["ygojson", "ygoprodeck", "tcgplayer"],
    minExpansions: 2,
    sealedProviders: ["ygojson"],
    extraVerification: "pack-reference kinds promote cleanly",
  },
  {
    productLine: "one-piece",
    journeys: onePieceMatrixProviderSyncJourneys,
    scope: "one-piece-matrix",
    requiredProviders: ["scrydex", "tcgplayer"],
    minExpansions: 2,
    sealedProviders: ["scrydex"],
    extraVerification: "credit-aware bulk-first preflight asserted (no per-record fallback without reason)",
  },
  {
    productLine: "lorcana",
    journeys: lorcanaMatrixProviderSyncJourneys,
    scope: "lorcana-matrix",
    requiredProviders: ["scrydex", "lorcanajson", "lorcast", "tcgplayer"],
    minExpansions: 2,
    sealedProviders: ["tcgplayer", "scrydex"],
    extraVerification: "four-provider merge exercised incl. at least one conflict resolution",
  },
];

// The support-safe evidence packet contract (one packet per game): only these
// fields are posted on the tracking issue. Nothing here can carry raw provider
// payloads, credentials, or provider URLs.
const providerUatEvidencePacketFields = [
  "providerKey",
  "unitKey",
  "profileVersion",
  "setLabel",
  "jobTerminalState",
  "observationCount",
  "candidateCount",
  "promotionCount",
  "conflictOutcome",
  "aliasOutcome",
] as const;

const forbiddenEvidencePacketFields = ["rawPayload", "credential", "authorization", "providerUrl", "cookie"] as const;

const unitFormLabelKinds = new Set(["set", "set name", "expansion"]);

function providerUnitFormOf(unitKey: string): string {
  return unitKey.split(":")[2] ?? "";
}

function providerUnitRoleOf(unitKey: string): string {
  return unitKey.split(":")[3] ?? "";
}

function providerUnitProductLineOf(unitKey: string): string {
  return unitKey.split(":")[1] ?? "";
}

function expansionKeyOfProviderSyncJourney(journey: ProviderSyncJourney): string | null {
  const selection = [...journey.scope]
    .reverse()
    .find((candidate) => unitFormLabelKinds.has(scopeSelectionLabelText(candidate)));
  return scopeSelectionChoiceKey(selection ?? journey.scope[journey.scope.length - 1]);
}

function localizationOfProviderSyncJourney(journey: ProviderSyncJourney): string | null {
  const selection = journey.scope.find((candidate) => scopeSelectionLabelText(candidate) === "language");
  return scopeSelectionChoiceKey(selection)?.toLowerCase() ?? null;
}

function distinctExpansionKeysForJourneys(journeys: readonly ProviderSyncJourney[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const journey of journeys) {
    const key = expansionKeyOfProviderSyncJourney(journey);
    if (key) {
      keys.add(key.toLowerCase());
    }
  }
  return keys;
}

const providerSyncJourneys =
  providerUatJourneyScope === "all-provider-regression"
    ? [...lorcanaLaunchProviderSyncJourneys, ...onePieceLaunchProviderSyncJourneys, ...yugiohProviderSyncJourneys]
    : providerUatJourneyScope === "tcgplayer-pokemon-targeted"
      ? []
      : providerUatJourneyScope === "lorcana-launch"
        ? lorcanaLaunchProviderSyncJourneys
        : providerUatJourneyScope === "staging-representative-catalog"
          ? stagingRepresentativeCatalogProviderSyncJourneys
          : providerUatJourneyScope === "pokemon-matrix"
            ? pokemonMatrixProviderSyncJourneys
            : providerUatJourneyScope === "mtg-matrix"
              ? mtgMatrixProviderSyncJourneys
              : providerUatJourneyScope === "yugioh-matrix"
                ? yugiohMatrixProviderSyncJourneys
                : providerUatJourneyScope === "one-piece-matrix"
                  ? onePieceMatrixProviderSyncJourneys
                  : providerUatJourneyScope === "lorcana-matrix"
                    ? lorcanaMatrixProviderSyncJourneys
                    : providerUatJourneyScope === "full-matrix-uat"
                      ? providerProductLineFormMatrixJourneys
                      : onePieceLaunchProviderSyncJourneys;

const lorcanaDownstreamCatalogItemsJourney: ProviderSyncJourney = {
  name: "Lorcana downstream Catalog Items projection through LorcanaJSON",
  providerKey: "lorcanajson",
  unitKey: "lorcanajson:lorcana:single-card:reference-data",
  scope: [{ label: "Set", choice: lorcanaSetChoice }],
};

// Canonical-scope dispatch grouping: several journeys pull the SAME real-world
// scope (a TCG + language edition + set/expansion) through different provider
// units (single-card imports, set-reference-data pulls, sealed products) — the
// operator thinks in terms of "sync the Lorcana First Chapter scope", not "sync
// scrydex:lorcana:single-card, then lorcanajson:lorcana:single-card, then...".
// Derive a canonical scope key from data the journey already declares (the
// unit's product domain, an explicit "Language" scope selection when the
// journey carries one, and the most specific remaining scope selection) rather
// than parsing the free-text `name`, so distinct language editions of the same
// set (which ARE distinct canonical scopes) never collapse onto one group.
function canonicalScopeKeyForProviderSyncJourney(journey: ProviderSyncJourney): string {
  const productDomain = journey.unitKey.split(":")[1] ?? journey.providerKey;
  const languageSelection = journey.scope.find((selection) => scopeSelectionLabelText(selection) === "language");
  const languageKey = scopeSelectionChoiceKey(languageSelection) ?? "en";
  const referenceSelection =
    [...journey.scope]
      .reverse()
      .find((selection) => scopeReferenceLabelKinds.has(scopeSelectionLabelText(selection))) ??
    journey.scope[journey.scope.length - 1];
  const referenceKey = scopeSelectionChoiceKey(referenceSelection) ?? journey.unitKey;
  return `${slugifyScopeKeyPart(productDomain)}:${slugifyScopeKeyPart(languageKey)}:${slugifyScopeKeyPart(referenceKey)}`;
}

const scopeReferenceLabelKinds = new Set(["set", "set name", "expansion", "product line"]);

function scopeSelectionLabelText(selection: ScopeSelection | undefined): string {
  if (!selection) {
    return "";
  }
  return (typeof selection.label === "string" ? selection.label : selection.label.source).toLowerCase();
}

function scopeSelectionChoiceKey(selection: ScopeSelection | undefined): string | null {
  if (!selection) {
    return null;
  }
  // Prefer the human-readable preferred label over the raw `values` entry: the
  // label ("The First Chapter") is the cross-provider-consistent join key,
  // while `values` is each provider's own opaque internal id/code (a numeric
  // TCGplayer product-line id, a Scrydex set code, a tcgdex expansion code) and
  // differs per provider for the identical real-world scope — some journeys
  // (e.g. TCGplayer's set-name choices) declare no `values` at all and resolve
  // the id only at runtime via `fallbackToFirstAvailableOption`.
  return selection.choice.labels?.[0] ?? selection.choice.values?.[0] ?? null;
}

function slugifyScopeKeyPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function groupProviderSyncJourneysByCanonicalScope(
  journeys: readonly ProviderSyncJourney[],
): ReadonlyMap<string, readonly ProviderSyncJourney[]> {
  const groups = new Map<string, ProviderSyncJourney[]>();
  for (const journey of journeys) {
    const scopeKey = canonicalScopeKeyForProviderSyncJourney(journey);
    const existing = groups.get(scopeKey);
    if (existing) {
      existing.push(journey);
    } else {
      groups.set(scopeKey, [journey]);
    }
  }
  return groups;
}

test.describe("catalog staging provider sync UAT helpers", () => {
  test("uses the canonical commands rendered by the Catalog workbench", async ({ page }) => {
    const unitKey = "scrydex:lorcana:single-card:source-observation-import";
    await page.setContent(
      `<form data-catalog-primary-workbench-command="scope.import" data-catalog-source-scope-unit="${unitKey}"><button>Sync scope</button></form>`,
    );

    await expect(sourceScopeSyncForms(page, unitKey)).toHaveCount(1);
    expect(sourceScopeWorksetRenderContract).toContain("data-catalog-primary-workbench-command={action.key}");
    expect(catalogSyncScopeRenderContract).toContain(
      `data-catalog-primary-workbench-command="${catalogWorkbenchCommand.sync}"`,
    );
    for (const command of [
      catalogWorkbenchCommand.import,
      catalogWorkbenchCommand.promote,
      catalogWorkbenchCommand.reapply,
    ]) {
      expect(sourceScopeWorksetDataContract).toContain(`"${command}"`);
    }
  });

  test("recognizes a no-promotable settled operator state", () => {
    expect(
      promotionPreviewHasNoPromotableBlocker(
        "Resolve before continuing 1 blocker(s). No promotable observations. Pull provider data or review rows.",
      ),
    ).toBe(true);
  });

  test("does not equate provider scopes that share a label but have different execution identities", () => {
    const scope = (importScope: string): SelectedProviderScope => ({
      providerKey: "lorcast",
      importScope,
      displayLabel: "lorcast · en / The First Chapter",
      fields: [
        { name: "languageCode", value: "en" },
        { name: "setName", value: "The First Chapter" },
      ],
    });

    expect(selectedProviderScopeMatchesSelectedScope(scope("en:1"), scope("en:1"))).toBe(true);
    expect(
      selectedProviderScopeMatchesSelectedScope(scope("en:set_7ecb0e0c71af496a9e0110e23824e0a5"), scope("en:1")),
    ).toBe(false);
  });

  test("allows rerunnable no-promotable coverage for launch and regression scopes", () => {
    expect(providerUatScopeAcceptsSettledNoPromotableCoverage("lorcana-launch")).toBe(true);
    expect(providerUatScopeAcceptsSettledNoPromotableCoverage("all-provider-regression")).toBe(true);
    expect(providerUatScopeAcceptsSettledNoPromotableCoverage("one-piece-launch")).toBe(false);
  });

  test("keeps Lorcast Lorcana partial imports reviewable", () => {
    expect(lorcanaLaunchProviderSyncJourneys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerKey: "lorcast",
          unitKey: "lorcast:lorcana:single-card:reference-data",
          allowPartialWithReview: true,
        }),
        expect.objectContaining({
          providerKey: "lorcast",
          unitKey: "lorcast:lorcana:set:reference-data",
          allowPartialWithReview: true,
        }),
      ]),
    );
  });

  test("keeps Admin Error diagnostics support-safe", () => {
    const sanitized = sanitizeSupportSafeEvidence(
      "Technical detail Error: boom authorization=Bearer fake-token session=session_fake user@example.test",
    );

    expect(sanitized).toContain("Technical detail Error: boom");
    expect(sanitized).toContain("authorization:[redacted]");
    expect(sanitized).toContain("session:[redacted]");
    expect(sanitized).toContain("[email redacted]");
    expect(sanitized).not.toContain("fake-token");
    expect(sanitized).not.toContain("user@example.test");
  });

  test("dispatches canonical-scope-first: groups the Lorcana First Chapter journey across every provider unit", () => {
    const groups = groupProviderSyncJourneysByCanonicalScope(lorcanaLaunchProviderSyncJourneys);
    const firstChapterGroup = [...groups.values()].find((journeysInGroup) =>
      journeysInGroup.some((journey) => journey.name === "Lorcana card set through Scrydex bulk-first shared importer"),
    );

    expect(firstChapterGroup).toBeTruthy();
    expect(firstChapterGroup!.map((journey) => journey.providerKey).sort()).toEqual([
      "lorcanajson",
      "lorcanajson",
      "lorcast",
      "lorcast",
      "scrydex",
      "scrydex",
      "tcgplayer",
      "tcgplayer",
    ]);
    // Every unit-kind pulling the First Chapter scope (card imports AND
    // set-reference-data pulls, single-card AND sealed products) lands in the
    // same canonical-scope group — this is the "dispatch by scope, not by
    // per-unit" property the group must have.
    expect(firstChapterGroup!.map((journey) => journey.unitKey).sort()).toEqual([
      "lorcanajson:lorcana:set:reference-data",
      "lorcanajson:lorcana:single-card:reference-data",
      "lorcast:lorcana:set:reference-data",
      "lorcast:lorcana:single-card:reference-data",
      "scrydex:lorcana:set:reference-data",
      "scrydex:lorcana:single-card:source-observation-import",
      "tcgplayer:lorcana:sealed-product:source-observation-import",
      "tcgplayer:lorcana:single-card:source-observation-import",
    ]);
  });

  test("keeps distinct language-edition Pokemon scopes from collapsing onto one canonical-scope group", () => {
    const groups = groupProviderSyncJourneysByCanonicalScope(tcgdexRepresentativePokemonJourneys);

    // English and Traditional Chinese Surging Sparks are the SAME expansion in
    // TWO different canonical scopes (language is part of scope identity), so
    // canonical-scope dispatch must keep them apart, not merge them because
    // they share a provider/unit/expansion.
    expect(groups.size).toBe(tcgdexRepresentativePokemonJourneys.length);
    for (const [scopeKey, journeysInGroup] of groups) {
      expect(journeysInGroup, scopeKey).toHaveLength(1);
    }
  });

  test("derives a stable canonical scope key from scope selections, not from the free-text journey name", () => {
    const englishSurgingSparks = tcgdexRepresentativePokemonJourneys.find(
      (journey) => journey.name === "Pokemon English Surging Sparks through TCGdex",
    )!;
    const traditionalChineseSurgingSparks = tcgdexRepresentativePokemonJourneys.find(
      (journey) => journey.name === "Pokemon Traditional Chinese Surging Sparks through TCGdex",
    )!;

    expect(canonicalScopeKeyForProviderSyncJourney(englishSurgingSparks)).toBe("pokemon:english:surging-sparks");
    expect(canonicalScopeKeyForProviderSyncJourney(traditionalChineseSurgingSparks)).toBe(
      "pokemon:traditional-chinese:surging-sparks",
    );
    expect(canonicalScopeKeyForProviderSyncJourney(englishSurgingSparks)).not.toBe(
      canonicalScopeKeyForProviderSyncJourney(traditionalChineseSurgingSparks),
    );
  });

  test("covers the staging representative catalog provider matrix", () => {
    expect(supportedProviderUatJourneyScopes).toContain("staging-representative-catalog");
    expect(stagingRepresentativeCatalogProviderSyncJourneys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerKey: "tcgdex", name: expect.stringContaining("English") }),
        expect.objectContaining({ providerKey: "tcgdex", name: expect.stringContaining("Traditional Chinese") }),
        expect.objectContaining({ providerKey: "tcgdex", name: expect.stringContaining("Korean") }),
        expect.objectContaining({ providerKey: "tcgdex", name: expect.stringContaining("Battle Partners") }),
        expect.objectContaining({ providerKey: "scryfall", unitKey: "scryfall:mtg:single-card:reference-data" }),
        expect.objectContaining({
          providerKey: "tcgplayer",
          unitKey: "tcgplayer:mtg:single-card:source-observation-import",
        }),
        expect.objectContaining({
          providerKey: "tcgplayer",
          unitKey: "tcgplayer:mtg:sealed-product:source-observation-import",
        }),
        expect.objectContaining({ providerKey: "lorcanajson", name: expect.stringContaining("Floodborn") }),
        expect.objectContaining({ providerKey: "lorcast", name: expect.stringContaining("Floodborn") }),
        expect.objectContaining({ providerKey: "scrydex", name: expect.stringContaining("Floodborn") }),
        expect.objectContaining({ providerKey: "tcgplayer", name: expect.stringContaining("Floodborn") }),
      ]),
    );
  });

  test("registers a dispatchable per-game scope for every matrix row and one full-matrix fan-out", () => {
    for (const row of providerProductLineFormMatrix) {
      expect(supportedProviderUatJourneyScopes, row.productLine).toContain(row.scope);
      expect(row.journeys.length, row.productLine).toBeGreaterThan(0);
    }
    expect(supportedProviderUatJourneyScopes).toContain("full-matrix-uat");
    // The full-matrix fan-out is exactly the concatenation of every game so a
    // single dispatch proves the whole matrix, and each per-game scope stays
    // runnable on its own inside the 60-minute workflow timeout.
    expect(providerProductLineFormMatrixJourneys).toEqual(
      providerProductLineFormMatrix.flatMap((row) => [...row.journeys]),
    );
  });

  test("every matrix journey references a real registered provider unit key", () => {
    for (const journey of providerProductLineFormMatrixJourneys) {
      expect(knownProviderUnitKeys, `${journey.name} (${journey.unitKey})`).toContain(journey.unitKey);
    }
  });

  test("each matrix row runs every required provider through at least two expansions", () => {
    for (const row of providerProductLineFormMatrix) {
      const providers = new Set(row.journeys.map((journey) => journey.providerKey));
      for (const requiredProvider of row.requiredProviders) {
        expect(providers, `${row.productLine} is missing provider ${requiredProvider}`).toContain(requiredProvider);
      }
      for (const journey of row.journeys) {
        expect(providerUnitProductLineOf(journey.unitKey), journey.name).toBe(row.productLine);
      }
      const expansions = distinctExpansionKeysForJourneys(row.journeys);
      expect(expansions.size, `${row.productLine} covers ${[...expansions].join(", ")}`).toBeGreaterThanOrEqual(
        row.minExpansions,
      );
    }
  });

  test("each matrix row exercises the sealed form through its designated providers", () => {
    for (const row of providerProductLineFormMatrix) {
      for (const sealedProvider of row.sealedProviders) {
        const sealedJourney = row.journeys.find(
          (journey) =>
            journey.providerKey === sealedProvider && providerUnitFormOf(journey.unitKey) === "sealed-product",
        );
        expect(sealedJourney, `${row.productLine} is missing a ${sealedProvider} sealed-product journey`).toBeTruthy();
      }
    }
  });

  test("Pokemon matrix covers English and Japanese with matching expansion counts for alias linking", () => {
    const pokemon = providerProductLineFormMatrix.find((row) => row.productLine === "pokemon")!;
    expect(pokemon.localizations).toEqual(["english", "japanese"]);
    const englishJourneys = pokemon.journeys.filter(
      (journey) => localizationOfProviderSyncJourney(journey) === "english",
    );
    const japaneseJourneys = pokemon.journeys.filter(
      (journey) => localizationOfProviderSyncJourney(journey) === "japanese",
    );
    const englishExpansions = distinctExpansionKeysForJourneys(englishJourneys);
    const japaneseExpansions = distinctExpansionKeysForJourneys(japaneseJourneys);
    expect(englishExpansions.size).toBeGreaterThanOrEqual(2);
    // JA carries the same number of expansions as EN so every English edition has
    // a Japanese counterpart to link by accepted set-equivalent alias.
    expect(japaneseExpansions.size).toBe(englishExpansions.size);
  });

  test("Pokemon matrix merges TCGdex and TCGplayer cards for the shared Surging Sparks expansion", () => {
    const pokemon = providerProductLineFormMatrix.find((row) => row.productLine === "pokemon")!;
    const surgingSparksProviders = new Set(
      pokemon.journeys
        .filter(
          (journey) =>
            providerUnitFormOf(journey.unitKey) === "single-card" &&
            expansionKeyOfProviderSyncJourney(journey)?.toLowerCase() === "surging sparks",
        )
        .map((journey) => journey.providerKey),
    );
    expect(surgingSparksProviders).toContain("tcgdex");
    expect(surgingSparksProviders).toContain("tcgplayer");
  });

  test("MTG matrix runs reference-data and image-evidence roles in the same sync run", () => {
    const mtg = providerProductLineFormMatrix.find((row) => row.productLine === "mtg")!;
    expect(mtg.journeys.some((journey) => providerUnitRoleOf(journey.unitKey) === "reference-data")).toBe(true);
    expect(mtg.journeys.some((journey) => providerUnitRoleOf(journey.unitKey) === "image-evidence")).toBe(true);
  });

  test("Yu-Gi-Oh matrix promotes pack-reference and sealed kinds through YGOJSON", () => {
    const yugioh = providerProductLineFormMatrix.find((row) => row.productLine === "yugioh")!;
    expect(yugioh.journeys.some((journey) => providerUnitFormOf(journey.unitKey) === "pack")).toBe(true);
    expect(
      yugioh.journeys.some(
        (journey) => journey.providerKey === "ygojson" && providerUnitFormOf(journey.unitKey) === "sealed-product",
      ),
    ).toBe(true);
  });

  test("One Piece matrix asserts credit-aware bulk-first preflight on every Scrydex journey", () => {
    const onePiece = providerProductLineFormMatrix.find((row) => row.productLine === "one-piece")!;
    const scrydexJourneys = onePiece.journeys.filter((journey) => journey.providerKey === "scrydex");
    expect(scrydexJourneys.length).toBeGreaterThan(0);
    for (const journey of scrydexJourneys) {
      expect(journey.preflight?.requestStrategy, journey.name).toBe("bulk-first");
    }
  });

  test("Lorcana matrix exercises the four-provider merge across two expansions", () => {
    const lorcana = providerProductLineFormMatrix.find((row) => row.productLine === "lorcana")!;
    const providers = new Set(lorcana.journeys.map((journey) => journey.providerKey));
    expect([...providers].sort()).toEqual(["lorcanajson", "lorcast", "scrydex", "tcgplayer"]);
    expect(distinctExpansionKeysForJourneys(lorcana.journeys).size).toBeGreaterThanOrEqual(2);
  });

  test("keeps the per-game evidence packet contract support-safe", () => {
    // The packet documents only support-safe fields and never a raw-payload,
    // credential, or provider-URL field.
    for (const forbidden of forbiddenEvidencePacketFields) {
      expect(providerUatEvidencePacketFields as readonly string[]).not.toContain(forbidden);
    }
    expect(providerUatEvidencePacketFields).toEqual(
      expect.arrayContaining([
        "providerKey",
        "unitKey",
        "jobTerminalState",
        "observationCount",
        "candidateCount",
        "promotionCount",
        "conflictOutcome",
        "aliasOutcome",
      ]),
    );
  });

  test("matrix scopes accept already-settled no-promotable coverage", () => {
    for (const row of providerProductLineFormMatrix) {
      expect(providerUatScopeAcceptsSettledNoPromotableCoverage(row.scope), row.scope).toBe(true);
    }
    expect(providerUatScopeAcceptsSettledNoPromotableCoverage("full-matrix-uat")).toBe(true);
  });
});

test.describe("catalog staging provider sync UAT", () => {
  test("operator syncs provider scopes from the shared importer UI @catalog-staging-provider-uat", async ({ page }) => {
    test.setTimeout(uatTestTimeoutMs);
    test.skip(!runStagingProviderUat, "Set CATALOG_STAGING_PROVIDER_UAT=true to run the staging provider sync UAT.");
    test.skip(
      !supportedProviderUatJourneyScopes.includes(
        providerUatJourneyScope as (typeof supportedProviderUatJourneyScopes)[number],
      ),
      `Unsupported CATALOG_STAGING_PROVIDER_UAT_SCOPE: ${providerUatJourneyScope}.`,
    );
    test.skip(
      !catalogAdminEmail || !catalogAdminPassword,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for staging provider sync UAT.",
    );

    await signInThroughVisibleForm(page);
    await openCatalogImporter(page);
    await assertSharedImporterSurface(page);

    // Dispatch by canonical scope, not by per-unit: journeys pulling the SAME
    // real-world scope through different provider units are grouped and run
    // together under one "Scope: <key>" step. Each provider import is executed
    // once. Settled-job reuse belongs to the parent scope.sync fan-out contract;
    // a direct scope.import intentionally starts a new job after completion.
    for (const [scopeKey, journeysInScope] of groupProviderSyncJourneysByCanonicalScope(providerSyncJourneys)) {
      await test.step(`Scope: ${scopeKey}`, async () => {
        for (const journey of journeysInScope) {
          await test.step(journey.name, async () => {
            const selectedScope = await selectProviderScope(page, journey);
            if (journey.preflight) {
              await expectImportPreflight(page, journey.unitKey, selectedScope, journey.preflight);
            }
            const syncAttempt = await syncSelectedProviderUnit(page, journey.unitKey, selectedScope);
            if (journey.requiresTerminalSync) {
              await expectImportJobSettledForSelectedUnit(
                page,
                journey.unitKey,
                selectedScope,
                syncAttempt.previousJobRows,
                undefined,
                { allowPartialWithReview: journey.allowPartialWithReview },
              );
            }
          });
        }
      });
    }

    if (providerUatJourneyScope === "tcgplayer-pokemon-targeted") {
      await test.step("TCGplayer Pokemon Catalog sync child scope and merge-candidate promotion", async () => {
        await expectTargetedTcgplayerPokemonCatalogSync(page);
      });
    }

    if (providerUatJourneyScope === "lorcana-launch" || providerUatJourneyScope === "all-provider-regression") {
      await test.step("Lorcana Catalog Items downstream projection through shared UI", async () => {
        await expectLorcanaCatalogItemsDownstreamProjection(page);
      });
    }
  });
});

async function signInThroughVisibleForm(page: Page): Promise<void> {
  await page.goto("/access/sign-in?returnTo=%2Fcatalog%2Fintegrations", {
    waitUntil: "domcontentloaded",
    timeout: pageReadyTimeoutMs,
  });

  const deadline = Date.now() + pageReadyTimeoutMs;
  while (Date.now() < deadline) {
    if (await isImporterVisible(page, 3_000)) {
      return;
    }

    const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
    if (await passwordInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await passwordInput.fill(catalogAdminPassword);
      await page.getByRole("button", { name: /^sign in$/i }).click();
      await openCatalogImporter(page);
      return;
    }

    const passwordChoice = page.getByRole("radio", { name: /^Password$/ }).first();
    if (
      (await passwordChoice.isVisible({ timeout: 1_000 }).catch(() => false)) &&
      !(await passwordChoice.isChecked().catch(() => false))
    ) {
      await passwordChoice.click();
      continue;
    }

    const emailInput = page.getByRole("textbox", { name: /email|phone/i });
    if (await emailInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await emailInput.fill(catalogAdminEmail);
      await page.getByRole("button", { name: /^continue$/i }).click();
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error("The staging admin sign-in form did not reach the password step or importer before the timeout.");
}

async function openCatalogImporter(page: Page): Promise<void> {
  const deadline = Date.now() + pageReadyTimeoutMs;
  let nextNavigationAt = Date.now();

  while (Date.now() < deadline) {
    if (await isImporterVisible(page, 2_000)) {
      await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", { timeout: 30_000 });
      return;
    }

    if (await recoverImporterFromAdminError(page)) {
      continue;
    }

    if (Date.now() >= nextNavigationAt) {
      await page.goto("/catalog/integrations", { waitUntil: "domcontentloaded", timeout: pageReadyTimeoutMs });
      nextNavigationAt = Date.now() + 10_000;
      continue;
    }

    await page.waitForTimeout(1_000);
  }

  if (await recoverImporterFromAdminError(page)) {
    return;
  }
  if (!(await isImporterVisible(page, 1_000))) {
    await page.goto("/catalog/integrations", { waitUntil: "domcontentloaded", timeout: pageReadyTimeoutMs });
  }
  await expectImporterVisible(page);
  await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", { timeout: 30_000 });
}

async function assertSharedImporterSurface(page: Page): Promise<void> {
  await expect(page.locator("[data-catalog-import-context-bar='true']")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Step 0 · Choose import scope/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Lorcana.*sync|Magic.*sync|Yu-Gi-Oh.*sync|Pokemon.*sync/i }),
  ).toHaveCount(0);
}

async function selectProviderScope(page: Page, journey: ProviderSyncJourney): Promise<SelectedProviderScope> {
  const contextBar = page.locator("[data-catalog-import-context-bar='true']");
  await expandImportContextBar(contextBar);

  const provider = contextBar.getByRole("combobox", { name: "Provider" });
  await selectOption(provider, { values: [journey.providerKey] }, () => recoverImporterFromAdminError(page));
  await expect(provider).toHaveValue(journey.providerKey, { timeout: pageReadyTimeoutMs });

  const unit = contextBar.getByRole("combobox", { name: "Unit" });
  await selectOption(unit, { values: [journey.unitKey] }, () => recoverImporterFromAdminError(page));
  await expect(unit).toHaveValue(journey.unitKey, { timeout: pageReadyTimeoutMs });

  const selectedChoices: SelectedScopeChoice[] = [];
  for (const selection of journey.scope) {
    const sourceScope = page.getByRole("group", { name: "Source scope" });
    await expect(sourceScope).toBeVisible({ timeout: sourceOptionTimeoutMs });
    const scopeSelect = sourceScope.getByRole("combobox", { name: selection.label });
    await selectOption(scopeSelect, selection.choice, () => recoverSourceOptionSelection(page, selection.label));
    await expect(scopeSelect).not.toHaveValue("", { timeout: sourceOptionTimeoutMs });
    selectedChoices.push({
      label: selection.label,
      values: await selectedScopeChoiceValues(scopeSelect, selection.choice),
    });
  }

  await contextBar.getByRole("button", { name: "Select source scope" }).click();
  return waitForSelectedProviderScope(page, journey, selectedChoices);
}

async function waitForSelectedProviderScope(
  page: Page,
  journey: ProviderSyncJourney,
  selectedChoices: readonly SelectedScopeChoice[],
): Promise<SelectedProviderScope> {
  const commandForms = sourceScopeSyncForms(page, journey.unitKey);
  await expect(commandForms.first()).toBeVisible({ timeout: sourceOptionTimeoutMs });

  const deadline = Date.now() + sourceOptionTimeoutMs;
  let lastScope: SelectedProviderScope | null = null;
  let lastRouteImportScope: string | null = null;
  while (Date.now() < deadline) {
    lastRouteImportScope = currentRouteImportScope(page);
    const count = await commandForms.count();
    for (let index = 0; index < count; index += 1) {
      const commandForm = commandForms.nth(index);
      if (!(await commandForm.isVisible().catch(() => false))) {
        continue;
      }
      const selectedScope = await selectedProviderScopeFromCommandForm(commandForm).catch(() => null);
      if (!selectedScope) {
        continue;
      }
      lastScope = selectedScope;
      if (
        lastRouteImportScope &&
        selectedProviderScopeMatchesImportScope(selectedScope, lastRouteImportScope) &&
        selectedProviderScopeMatchesJourneySelection(selectedScope, selectedChoices) &&
        selectedProviderScopeMatchesUnitDomain(selectedScope, journey.unitKey)
      ) {
        return selectedScope;
      }
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Selected source scope command form for ${journey.unitKey} did not settle on the current route scope for ${
      journey.name
    }. Route import scope: ${lastRouteImportScope ?? "none"}. Last observed command scope: ${
      lastScope?.importScope ?? lastScope?.displayLabel ?? "none"
    }.`,
  );
}

async function selectedScopeChoiceValues(scopeSelect: Locator, choice: SelectChoice): Promise<readonly string[]> {
  const selectedValue = await scopeSelect.inputValue();
  const selectedText = await scopeSelect
    .locator("option:checked")
    .innerText()
    .then(normalizeWhitespace)
    .catch(() => "");
  return uniqueTruthy([selectedValue, selectedText, ...(choice.labels ?? []), ...(choice.values ?? [])]);
}

async function expandImportContextBar(contextBar: Locator): Promise<void> {
  const trigger = contextBar.getByRole("button", { name: /Step 0 · Choose import scope/ });
  await expect(trigger).toBeVisible({ timeout: pageReadyTimeoutMs });
  for (let attempt = 0; attempt < 3 && !(await isImportContextBarExpanded(trigger)); attempt += 1) {
    await trigger.click();
    if (await isImportContextBarExpanded(trigger)) {
      return;
    }
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true", { timeout: pageReadyTimeoutMs });
}

async function isImportContextBarExpanded(trigger: Locator): Promise<boolean> {
  return expect(trigger)
    .toHaveAttribute("aria-expanded", "true", { timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
}

async function syncSelectedProviderUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<ProviderSyncAttempt> {
  await expandWorkflowStage(page, "run-sync");
  const commandForm = await selectedSourceScopeSyncForm(page, unitKey, selectedScope);
  const previousJobRows = await visibleImportJobRowTexts(page, unitKey, selectedScope);

  const syncButton = commandForm.getByRole("button", { name: /^Sync / });
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    if (await syncButton.isEnabled().catch(() => false)) {
      await syncButton.click();
      await expectCommandQueuedOrActiveImport(page, unitKey, selectedScope);
      return { previousJobRows };
    }

    if (await hasActiveImportJobForSelectedUnit(page, unitKey, selectedScope, 1_000)) {
      await expectActiveImportJobForSelectedUnit(page, unitKey, selectedScope);
      return { previousJobRows };
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `Sync action for ${unitKey} was neither enabled nor represented by a queued/running/completed import job row for the selected or covering scope in the shared UI.`,
  );
}

async function expectTargetedTcgplayerPokemonCatalogSync(page: Page): Promise<void> {
  const progress = createTargetedTcgplayerPokemonProgress();
  try {
    recordTargetedTcgplayerPokemonProgress(
      progress,
      "shared importer surface is ready for targeted TCGplayer Pokemon UAT",
      "select Product Line Pokemon and Set Name Base Set from the operator UI",
    );
    const selectedScope = await selectProviderScope(page, tcgplayerPokemonProviderSyncJourney);
    recordTargetedTcgplayerPokemonProgress(
      progress,
      `selected source scope ${selectedScope.displayLabel}`,
      "start Catalog sync for the selected provider participation row",
      selectedScope.fields.map((field) => `${field.name}:${field.value}`),
    );
    const catalogSyncAttempt = await startCatalogSyncForSelectedProviderUnit(
      page,
      tcgplayerPokemonProviderSyncJourney.unitKey,
      selectedScope,
      progress,
    );
    await expectCatalogSyncChildImportForSelectedUnit(
      page,
      tcgplayerPokemonProviderSyncJourney.unitKey,
      selectedScope,
      catalogSyncAttempt.previousJobRows,
      progress,
    );
    await expectImportJobSettledForSelectedUnit(
      page,
      tcgplayerPokemonProviderSyncJourney.unitKey,
      selectedScope,
      catalogSyncAttempt.previousJobRows,
      progress,
      { allowPartialWithReview: true },
    );
    await promoteTcgplayerPokemonMergeCandidateFromReview(page, selectedScope, progress);
  } catch (error) {
    throw new Error(targetedTcgplayerPokemonFailureMessage(progress, error));
  }
}

async function startCatalogSyncForSelectedProviderUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  progress?: TargetedTcgplayerPokemonProgress,
): Promise<CatalogSyncAttempt> {
  await expandWorkflowStage(page, "run-sync");
  const commandForm = page
    .locator(`form[data-catalog-primary-workbench-command="${catalogWorkbenchCommand.sync}"]`)
    .first();
  await expect(commandForm).toBeVisible({ timeout: sourceOptionTimeoutMs });
  const participationRow = catalogSyncParticipationRowForUnit(page, unitKey);
  await expect(participationRow).toBeVisible({ timeout: sourceOptionTimeoutMs });
  await expect(participationRow.getByText(unitKey, { exact: true })).toBeVisible({ timeout: sourceOptionTimeoutMs });
  await expect(
    participationRow.getByText(/ingestionUnitKey:tcgplayer:pokemon:single-card:source-observation-import/i),
  ).toBeVisible({ timeout: sourceOptionTimeoutMs });
  await expect(participationRow.getByText(/productLineId:3|setName:Base Set|provider:tcgplayer/i).first()).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
  recordTargetedTcgplayerPokemonProgress(
    progress,
    "Catalog sync provider participation row is visible",
    "enable/select the participation row and submit Start Catalog sync",
    [await visibleLocatorText(participationRow)],
  );

  const participationCheckbox = participationRow.getByRole("checkbox").first();
  await expect(participationCheckbox)
    .toBeEnabled({ timeout: sourceOptionTimeoutMs })
    .catch(async () => {
      throw new Error(
        `Catalog sync readiness blocks ${unitKey} for ${selectedScope.displayLabel}: the participation row is visible but not selectable. ${await visibleLocatorText(
          participationRow,
        )}`,
      );
    });
  if (!(await participationCheckbox.isChecked().catch(() => false))) {
    await selectCatalogSyncParticipationRow(participationRow, participationCheckbox);
  }
  await expect(participationCheckbox).toBeChecked({ timeout: sourceOptionTimeoutMs });
  recordTargetedTcgplayerPokemonProgress(
    progress,
    "Catalog sync provider participation row is selected",
    "submit Start Catalog sync and wait for command feedback",
    [await visibleLocatorText(participationRow)],
  );

  const startButton = commandForm.getByRole("button", { name: "Start Catalog sync" });
  await expect(startButton)
    .toBeEnabled({ timeout: sourceOptionTimeoutMs })
    .catch(async () => {
      throw new Error(
        `Catalog sync readiness blocks ${unitKey} for ${selectedScope.displayLabel}: Start Catalog sync is disabled. ${await visibleLocatorText(
          commandForm,
        )}`,
      );
    });
  const previousJobRows = await visibleImportJobRowTexts(page, unitKey, selectedScope);

  await startButton.click();
  recordTargetedTcgplayerPokemonProgress(
    progress,
    "Start Catalog sync was submitted",
    "observe queued command feedback or parent Catalog sync-run progress",
  );
  await expectCatalogSyncCommandAcceptedOrRunVisible(page, progress);
  return { previousJobRows };
}

function catalogSyncParticipationRowForUnit(page: Page, unitKey: string): Locator {
  return page
    .locator(
      `[data-catalog-sync-participation-row="true"][data-catalog-sync-participation-unit="${cssAttrValue(unitKey)}"]`,
    )
    .filter({ visible: true })
    .first();
}

async function visibleLocatorText(locator: Locator): Promise<string> {
  return locator
    .innerText({ timeout: 2_000 })
    .then(normalizeWhitespace)
    .catch(() => "row text unavailable");
}

async function selectCatalogSyncParticipationRow(participationRow: Locator, checkbox: Locator): Promise<void> {
  const checkboxId = await checkbox.getAttribute("id");
  const visibleToggle = checkboxId
    ? participationRow.locator(`label[for="${cssAttrValue(checkboxId)}"]`).first()
    : participationRow.locator("label").filter({ has: checkbox }).first();
  if (await visibleToggle.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await visibleToggle.click({ timeout: controlActionTimeoutMs });
    return;
  }

  await checkbox.check({ timeout: controlActionTimeoutMs });
}

const targetedTcgplayerPokemonObservedLimit = 3;
const targetedTcgplayerPokemonObservedMaxLength = 1_200;

function createTargetedTcgplayerPokemonProgress(): TargetedTcgplayerPokemonProgress {
  return {
    checkpoint: "targeted TCGplayer Pokemon UAT started",
    nextBlocker: "reach the shared importer operator UI",
    observed: [],
    lastLoggedAt: 0,
  };
}

function recordTargetedTcgplayerPokemonProgress(
  progress: TargetedTcgplayerPokemonProgress | undefined,
  checkpoint: string,
  nextBlocker: string,
  observed: readonly string[] = [],
  throttleMs = 0,
): void {
  if (!progress) {
    return;
  }
  const now = Date.now();
  progress.checkpoint = checkpoint;
  progress.nextBlocker = nextBlocker;
  progress.observed = observed
    .map(sanitizeTargetedTcgplayerPokemonEvidence)
    .filter(Boolean)
    .slice(0, targetedTcgplayerPokemonObservedLimit);
  if (throttleMs > 0 && now - progress.lastLoggedAt < throttleMs) {
    return;
  }
  progress.lastLoggedAt = now;
  console.log(targetedTcgplayerPokemonProgressMessage(progress));
}

function targetedTcgplayerPokemonProgressMessage(progress: TargetedTcgplayerPokemonProgress): string {
  const observed = progress.observed.length > 0 ? ` observed="${progress.observed.join(" | ")}"` : "";
  return `[catalog-staging-provider-uat] tcgplayer-pokemon-targeted checkpoint="${sanitizeTargetedTcgplayerPokemonEvidence(
    progress.checkpoint,
  )}" nextBlocker="${sanitizeTargetedTcgplayerPokemonEvidence(progress.nextBlocker)}"${observed}`;
}

function targetedTcgplayerPokemonFailureMessage(progress: TargetedTcgplayerPokemonProgress, error: unknown): string {
  const observed = progress.observed.length > 0 ? ` Observed operator UI: ${progress.observed.join(" | ")}.` : "";
  return `TCGplayer Pokemon targeted UAT failed after checkpoint "${sanitizeTargetedTcgplayerPokemonEvidence(
    progress.checkpoint,
  )}". Next concrete blocker: ${sanitizeTargetedTcgplayerPokemonEvidence(progress.nextBlocker)}.${observed} Original error: ${sanitizeTargetedTcgplayerPokemonEvidence(
    error instanceof Error ? error.message : String(error),
  )}`;
}

function sanitizeTargetedTcgplayerPokemonEvidence(value: string): string {
  return sanitizeSupportSafeEvidence(value, targetedTcgplayerPokemonObservedMaxLength);
}

function sanitizeSupportSafeEvidence(value: string, maxLength = supportSafeDiagnosticMaxLength): string {
  const sanitized = normalizeWhitespace(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(password|secret|token|authorization|api[-_\s]?key|cookie|session)\s*[:=]\s*\S+/gi, "$1:[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]");
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}... [truncated]` : sanitized;
}

async function expectCatalogSyncCommandAcceptedOrRunVisible(
  page: Page,
  progress?: TargetedTcgplayerPokemonProgress,
): Promise<void> {
  const deadline = Date.now() + syncTimeoutMs;
  const syncRun = page.locator("[data-catalog-sync-run]").first();
  while (Date.now() < deadline) {
    if (await syncRun.isVisible({ timeout: 500 }).catch(() => false)) {
      recordTargetedTcgplayerPokemonProgress(
        progress,
        "parent Catalog sync-run progress is visible",
        "wait for the child import job row for the selected Pokemon scope",
        [await visibleLocatorText(syncRun)],
      );
      return;
    }
    if (
      await page
        .getByText("Command queued")
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      await expectCommandQueued(page);
      recordTargetedTcgplayerPokemonProgress(
        progress,
        "Catalog sync command queued feedback is visible",
        "wait for parent Catalog sync-run progress and the child import job row",
      );
      return;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Catalog sync did not show queued command feedback or visible parent sync-run progress.");
}

async function expectCatalogSyncChildImportForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  previousJobRows: readonly string[],
  progress?: TargetedTcgplayerPokemonProgress,
): Promise<void> {
  const previous = new Set(previousJobRows.map(normalizeWhitespace));
  const syncRun = page.locator("[data-catalog-sync-run]").first();
  const deadline = Date.now() + sourceOptionTimeoutMs;
  let observedRows: readonly string[] = [];

  while (Date.now() < deadline) {
    await expandWorkflowStage(page, "run-sync");
    await expect(syncRun).toBeVisible({ timeout: sourceOptionTimeoutMs });
    observedRows = await visibleImportJobRowTexts(page, unitKey, selectedScope);
    const childRow = observedRows.find((row) => !previous.has(row)) ?? observedRows[0];
    if (childRow && /import job .*(?:queued|running|completed|partial)/i.test(childRow)) {
      await expect(syncRun.getByText(/Child jobs/i).first()).toBeVisible({ timeout: sourceOptionTimeoutMs });
      await expectVisibleCatalogSyncChildJobRow(syncRun);
      recordTargetedTcgplayerPokemonProgress(
        progress,
        "Catalog sync child import row is visible",
        "wait for the child import job to reach completed terminal state",
        [childRow],
      );
      return;
    }
    recordTargetedTcgplayerPokemonProgress(
      progress,
      "waiting for Catalog sync child import row",
      "Catalog sync parent run has not yet exposed a new child row for the selected Pokemon scope",
      observedRows,
      30_000,
    );
    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `Catalog sync did not expose a visible child import row for ${unitKey} and ${selectedScope.displayLabel}. Observed rows: ${
      observedRows.join(" | ") || "none"
    }`,
  );
}

async function expectVisibleCatalogSyncChildJobRow(syncRun: Locator): Promise<void> {
  const childJobsTable = syncRun.getByRole("table", { name: /Catalog sync child jobs/i }).first();
  await expect(childJobsTable).toBeVisible({ timeout: sourceOptionTimeoutMs });
  await expect(
    childJobsTable.getByRole("row", { name: /TCGplayer Pokemon.*(?:Queued|Running|Completed|Partial)/i }).first(),
  ).toBeVisible({ timeout: sourceOptionTimeoutMs });
}

async function promoteTcgplayerPokemonMergeCandidateFromReview(
  page: Page,
  selectedScope: SelectedProviderScope,
  progress?: TargetedTcgplayerPokemonProgress,
): Promise<void> {
  await expandWorkflowStage(page, "review-changes");
  const reviewModule = mergeCandidateReviewModule(page);
  await expect(reviewModule).toBeVisible({ timeout: sourceOptionTimeoutMs });
  recordTargetedTcgplayerPokemonProgress(
    progress,
    "Merged candidate review module is visible",
    "find an enabled TCGplayer Pokemon merge-candidate Promote action",
    [await visibleLocatorText(reviewModule)],
  );

  const candidate = await firstMergeCandidateRowWithEnabledPromotion(reviewModule);
  if (!candidate) {
    const reviewText = await reviewModule
      .innerText({ timeout: 2_000 })
      .then(normalizeWhitespace)
      .catch(() => "Merged candidate review text was not visible.");
    throw new Error(
      `TCGplayer Pokemon targeted UAT could not find an enabled merge-candidate Promote action for ${
        selectedScope.displayLabel
      }. ${reviewText}`,
    );
  }

  const { row, promoteButton } = candidate;
  await expect(row.getByText(/tcgplayer/i).first()).toBeVisible({ timeout: sourceOptionTimeoutMs });
  recordTargetedTcgplayerPokemonProgress(
    progress,
    "enabled TCGplayer Pokemon merge-candidate Promote action is visible",
    "open the evidence sheet and verify generated command payloads are visible",
    [await visibleLocatorText(row)],
  );
  await openMergeCandidateEvidenceSheet(page, row);
  recordTargetedTcgplayerPokemonProgress(
    progress,
    "merge-candidate evidence sheet is visible",
    "submit the Promote action and observe command queued feedback",
  );
  await expect(promoteButton).toBeEnabled({ timeout: sourceOptionTimeoutMs });
  await promoteButton.click();
  await expectCommandQueued(page);
  recordTargetedTcgplayerPokemonProgress(
    progress,
    `TCGplayer Pokemon merge-candidate promotion queued for ${selectedScope.displayLabel}`,
    "durable promotion command accepted; targeted UAT path is complete",
  );
}

function mergeCandidateReviewModule(page: Page): Locator {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Merged candidate review" }) })
    .first();
}

type MergeCandidatePromoteTarget = Readonly<{
  row: Locator;
  promoteButton: Locator;
}>;

async function firstMergeCandidateRowWithEnabledPromotion(
  reviewModule: Locator,
): Promise<MergeCandidatePromoteTarget | null> {
  const promoteButtons = reviewModule.getByRole("button", { name: /^Promote\b/i });
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    const count = await promoteButtons.count();
    for (let index = 0; index < count; index += 1) {
      const promoteButton = promoteButtons.nth(index);
      if (await promoteButton.isEnabled({ timeout: 500 }).catch(() => false)) {
        const row = promoteButton.locator("xpath=ancestor::tr[1]");
        if (
          await row
            .getByText(/tcgplayer/i)
            .first()
            .isVisible({ timeout: 500 })
            .catch(() => false)
        ) {
          return { row, promoteButton };
        }
      }
    }
    await reviewModule.page().waitForTimeout(1_000);
  }

  return null;
}

async function openMergeCandidateEvidenceSheet(page: Page, row: Locator): Promise<void> {
  await row.getByRole("button", { name: "Evidence" }).click();
  await expect(page.getByRole("heading", { name: /Candidate detail:/i }).first()).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
  await expect(page.getByText("Generated command payloads", { exact: true }).first()).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
  await expect(page.getByText(/Promote .* source/i).first()).toBeVisible({ timeout: sourceOptionTimeoutMs });
  await page.keyboard.press("Escape").catch(() => undefined);
}

async function expectImportPreflight(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  expectation: ImportPreflightExpectation,
): Promise<void> {
  const panel = await waitForSelectedImportPreflightPanel(page, unitKey, selectedScope);
  if (expectation.requestStrategy) {
    await expect(panel).toHaveAttribute("data-catalog-import-preview-strategy", expectation.requestStrategy, {
      timeout: sourceOptionTimeoutMs,
    });
  }
  const usageState = (await panel.getAttribute("data-catalog-import-preview-usage-state")) ?? "none";
  if (expectation.allowedUsageStates && !expectation.allowedUsageStates.includes(usageState)) {
    throw new Error(
      `Import preflight usage state ${usageState} was not one of ${expectation.allowedUsageStates.join(", ")}.`,
    );
  }
  for (const text of expectation.visibleText) {
    await expect(panel.getByText(text).filter({ visible: true }).first()).toBeVisible({
      timeout: sourceOptionTimeoutMs,
    });
  }
}

function cssAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function waitForSelectedImportPreflightPanel(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<Locator> {
  const panels = importPreflightPanelsForSelectedScope(page, unitKey, selectedScope.providerKey);
  const scopeCandidates = selectedScope.importScope ? importPreflightScopeCandidates(selectedScope.importScope) : [];
  const deadline = Date.now() + sourceOptionTimeoutMs;
  let nextRecoveryAttemptAt = Date.now() + 10_000;
  let observedScopes: readonly string[] = [];

  // Deferred review data can move the operator stepper back to Review Changes
  // after a scope change; reopen Run Sync the way an operator would.
  while (Date.now() < deadline) {
    await expandWorkflowStage(page, "run-sync");
    const panel = await firstVisibleImportPreflightPanelMatchingScope(panels, scopeCandidates);
    if (panel) {
      return panel;
    }
    observedScopes = await visibleImportPreflightPanelScopes(panels);
    if (observedScopes.length > 0 && Date.now() >= nextRecoveryAttemptAt) {
      await recoverSelectedImportPreflightScope(page, unitKey, selectedScope, observedScopes);
      nextRecoveryAttemptAt = Date.now() + 15_000;
    }
    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `Import preflight for ${unitKey} and ${selectedScope.displayLabel} did not settle on ${
      scopeCandidates.join(", ") || "any selected scope"
    }. Observed visible preview scopes: ${observedScopes.join(", ") || "none"}.`,
  );
}

async function recoverSelectedImportPreflightScope(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  observedScopes: readonly string[],
): Promise<void> {
  console.log(
    `[catalog-staging-provider-uat] refreshing import preflight for ${unitKey} and ${
      selectedScope.displayLabel
    }; observed visible preview scopes: ${observedScopes.join(", ") || "none"}`,
  );
  await selectedSourceScopeSyncForm(page, unitKey, selectedScope, 5_000).catch(() => undefined);
  const contextBar = page.locator("[data-catalog-import-context-bar='true']");
  await expandImportContextBar(contextBar).catch(() => undefined);
  const selectSourceScope = contextBar.getByRole("button", { name: "Select source scope" });
  if (
    (await selectSourceScope.isVisible({ timeout: 1_000 }).catch(() => false)) &&
    (await selectSourceScope.isEnabled().catch(() => false))
  ) {
    await selectSourceScope.click();
  }
  await expandWorkflowStage(page, "run-sync").catch(() => undefined);
}

function importPreflightPanelsForSelectedScope(page: Page, unitKey: string, providerKey: string): Locator {
  return page
    .locator(
      `[data-catalog-import-preview="ready"][data-catalog-import-preview-provider="${cssAttrValue(
        providerKey,
      )}"][data-catalog-import-preview-unit="${cssAttrValue(unitKey)}"]`,
    )
    .filter({ visible: true });
}

async function firstVisibleImportPreflightPanelMatchingScope(
  panels: Locator,
  scopeCandidates: readonly string[],
): Promise<Locator | null> {
  const count = await panels.count();
  for (let index = 0; index < count; index += 1) {
    const panel = panels.nth(index);
    if (!(await panel.isVisible().catch(() => false))) {
      continue;
    }
    if (scopeCandidates.length === 0) {
      return panel;
    }
    const observedScope = await panel.getAttribute("data-catalog-import-preview-scope");
    if (observedScope && scopeCandidates.includes(observedScope)) {
      return panel;
    }
  }

  return null;
}

async function visibleImportPreflightPanelScopes(panels: Locator): Promise<readonly string[]> {
  const scopes: string[] = [];
  const count = await panels.count();
  for (let index = 0; index < count; index += 1) {
    const panel = panels.nth(index);
    if (await panel.isVisible().catch(() => false)) {
      scopes.push((await panel.getAttribute("data-catalog-import-preview-scope")) ?? "none");
    }
  }

  return [...new Set(scopes)];
}

function importPreflightScopeCandidates(importScope: string): readonly string[] {
  const candidates = new Set([importScope]);
  const segments = importScope.split(":").filter(Boolean);
  const penultimate = segments.at(-2);
  const final = segments.at(-1);
  if (segments.length >= 3 && penultimate && penultimate === final) {
    candidates.add([...segments.slice(0, -2), final].join(":"));
  }
  return [...candidates];
}

type WorkflowStageKey = "run-sync" | "review-changes" | "create-items";

const workflowStageNames: Record<WorkflowStageKey, RegExp> = {
  "run-sync": /^Run sync\b/i,
  "review-changes": /^Review changes\b/i,
  "create-items": /^Create \/ update items\b/i,
};

async function expandWorkflowStage(page: Page, stage: WorkflowStageKey): Promise<void> {
  const trigger = page
    .locator(`[data-catalog-import-workflow-stage="${stage}"]`)
    .or(page.getByRole("heading", { name: workflowStageNames[stage] }).getByRole("button"))
    .first();
  await expect(trigger).toBeVisible({ timeout: pageReadyTimeoutMs });
  const deadline = Date.now() + pageReadyTimeoutMs;
  while ((await trigger.getAttribute("aria-expanded").catch(() => null)) !== "true" && Date.now() < deadline) {
    await trigger.click();
    await page.waitForTimeout(250);
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true", { timeout: pageReadyTimeoutMs });
}

async function expectImportJobSettledForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  previousJobRows: readonly string[],
  progress?: TargetedTcgplayerPokemonProgress,
  options: Readonly<{ allowPartialWithReview?: boolean }> = {},
): Promise<void> {
  const previous = new Set(previousJobRows.map(normalizeWhitespace));
  const deadline = Date.now() + terminalSyncTimeoutMs;
  let observedRows: readonly string[] = [];

  while (Date.now() < deadline) {
    await expandWorkflowStage(page, "run-sync");
    observedRows = await visibleImportJobRowTexts(page, unitKey, selectedScope);
    const changedRows = observedRows.filter((row) => !previous.has(row));
    const unsuccessful = changedRows.find(importJobRowReachedUnsuccessfulTerminal);
    if (unsuccessful) {
      if (options.allowPartialWithReview && importJobRowReachedPartialTerminal(unsuccessful)) {
        const partialRow = await importJobRowLocatorForStableSummary(page, unitKey, selectedScope, unsuccessful);
        if (!partialRow) {
          throw new Error(`Partial import job row for ${unitKey} was no longer visible: ${unsuccessful}`);
        }
        await expect(partialRow.getByRole("link", { name: "Review observations" }).first()).toBeVisible({
          timeout: sourceOptionTimeoutMs,
        });
        recordTargetedTcgplayerPokemonProgress(
          progress,
          "child import job reached partial terminal state with reviewable observations",
          "open Review changes and promote a TCGplayer Pokemon merge candidate",
          [unsuccessful],
        );
        return;
      }
      recordTargetedTcgplayerPokemonProgress(
        progress,
        "child import job reached an unsuccessful terminal state",
        "inspect the visible import job row and provider readiness before rerunning the targeted path",
        [unsuccessful],
      );
      throw new Error(`Import job for ${unitKey} reached an unsuccessful terminal state: ${unsuccessful}`);
    }
    const completed = changedRows.find(importJobRowReachedCompletedTerminal);
    if (completed) {
      recordTargetedTcgplayerPokemonProgress(
        progress,
        `child import job completed for ${selectedScope.displayLabel}`,
        "open Review changes and promote a TCGplayer Pokemon merge candidate",
        [completed],
      );
      return;
    }

    recordTargetedTcgplayerPokemonProgress(
      progress,
      "waiting for child import job terminal state",
      "child import job has not reached a new completed row for the selected Pokemon scope",
      observedRows,
      30_000,
    );
    await page.waitForTimeout(2_000);
  }

  throw new Error(
    `Import job for ${unitKey} did not reach a new completed terminal row for ${selectedScope.displayLabel}. Observed rows: ${
      observedRows.join(" | ") || "none"
    }`,
  );
}

async function expectLorcanaCatalogItemsDownstreamProjection(page: Page): Promise<void> {
  await openCatalogImporter(page);
  const selectedScope = await selectProviderScope(page, lorcanaDownstreamCatalogItemsJourney);
  const promoted =
    (await promoteFirstEligibleObservationFromReview(page, selectedScope)) ??
    (await promoteFromCompletedImportJobReview(page, selectedScope)) ??
    (await promoteSelectedScopeFromSharedImporter(page, selectedScope));
  const result = promoted ?? (await reapplyPromotedObservationFromSharedImporter(page, selectedScope));
  if (!result) {
    const operatorState = await promotionPreviewOperatorStateMessage(page, selectedScope);
    if (providerUatScopeAcceptsSettledNoPromotableCoverage() && promotionPreviewHasNoPromotableBlocker(operatorState)) {
      console.log(
        `[catalog-staging-provider-uat] Lorcana downstream Catalog Items projection skipped for already-settled no-promotable ${providerUatJourneyScope} scope: ${sanitizeSupportSafeEvidence(
          operatorState,
        )}`,
      );
      return;
    }

    throw new Error(
      `Lorcana downstream smoke could not find an eligible Source Observation to promote or reapply for ${
        selectedScope.displayLabel
      }. ${operatorState}`,
    );
  }

  await openCatalogItemsHandoff(page, result.providerKey);
  await expectCatalogItemsProjectionForProvider(page, result);

  console.log(
    `[catalog-staging-provider-uat] Lorcana downstream Catalog Items projection verified: mode=${result.mode}, provider=${result.providerKey}, unit=${result.unitKey}, scope=${result.selectedScope}, selectedObservationIds=${
      result.selectedObservationIds.join(",") || "scope"
    }, promotionPreviewId=${result.promotionPreviewId ?? "none"}, jobId=${result.jobId ?? "none"}`,
  );
}

async function promoteFromCompletedImportJobReview(
  page: Page,
  selectedScope: SelectedProviderScope,
): Promise<LorcanaDownstreamSmokeResult | null> {
  const opened = await openCompletedImportJobObservationReview(
    page,
    lorcanaDownstreamCatalogItemsJourney.unitKey,
    selectedScope,
  );
  if (!opened) {
    return null;
  }

  return promoteFirstEligibleObservationFromReview(page, selectedScope);
}

async function openCompletedImportJobObservationReview(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<boolean> {
  await expandWorkflowStage(page, "run-sync");
  const row = await completedImportJobRowLocatorForSelectedUnit(page, unitKey, selectedScope, sourceOptionTimeoutMs);
  if (!row) {
    return false;
  }

  const review = row.getByRole("link", { name: "Review observations" }).first();
  await expect(review).toBeVisible({ timeout: sourceOptionTimeoutMs });
  await review.click();
  await page.waitForLoadState("domcontentloaded", { timeout: pageReadyTimeoutMs }).catch(() => undefined);
  await expect(page.getByRole("heading", { name: "Source Observation review" })).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
  return true;
}

async function promoteFirstEligibleObservationFromReview(
  page: Page,
  selectedScope: SelectedProviderScope,
): Promise<LorcanaDownstreamSmokeResult | null> {
  await expandWorkflowStage(page, "review-changes");
  await expect(page.getByRole("heading", { name: "Source Observation review" })).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });

  const previewForms = page.locator(
    `form[data-catalog-primary-workbench-command="${catalogWorkbenchCommand.promote}"]:not([data-catalog-source-scope-unit])`,
  );
  const preview = await clickFirstEnabledObservationCommand(previewForms, {
    requireSelectedObservationIds: true,
  });
  if (!preview) {
    return null;
  }

  const promotionPreviewId = await expectPromotionPreviewReady(page);
  await executePromotionFromFreshPreview(page, selectedScope);
  const jobId = currentSearchParam(page, "jobId");

  return {
    mode: "promote",
    providerKey: selectedScope.providerKey,
    unitKey: lorcanaDownstreamCatalogItemsJourney.unitKey,
    selectedScope: selectedScope.displayLabel,
    selectedObservationIds: preview.selectedObservationIds,
    promotionPreviewId,
    jobId,
  };
}

async function promoteSelectedScopeFromSharedImporter(
  page: Page,
  selectedScope: SelectedProviderScope,
): Promise<LorcanaDownstreamSmokeResult | null> {
  const scopePreviewForms = sourceScopeCommandForms(
    page,
    lorcanaDownstreamCatalogItemsJourney.unitKey,
    catalogWorkbenchCommand.promote,
  ).filter({ has: page.getByRole("button", { name: /^Preview / }) });
  if (!(await clickSelectedScopeCommandForm(scopePreviewForms, selectedScope))) {
    return null;
  }

  const promotionPreviewId = await tryPromotionPreviewReady(page, 15_000);
  if (!promotionPreviewId) {
    console.log(
      `[catalog-staging-provider-uat] ${lorcanaDownstreamCatalogItemsJourney.unitKey} source-scope promotion preview did not produce a routable preview id for ${selectedScope.displayLabel}; trying to execute any fresh visible preview before row-level or reapply fallback.`,
    );
  }
  const freshPreview = await executePromotionFromFreshPreview(page, selectedScope, {
    allowOperatorStateFallback: true,
  });
  if (!freshPreview) {
    return null;
  }
  const jobId = currentSearchParam(page, "jobId");

  return {
    mode: "promote",
    providerKey: selectedScope.providerKey,
    unitKey: lorcanaDownstreamCatalogItemsJourney.unitKey,
    selectedScope: selectedScope.displayLabel,
    selectedObservationIds: [],
    promotionPreviewId: promotionPreviewId ?? currentSearchParam(page, "promotionPreviewId"),
    jobId,
  };
}

async function reapplyPromotedObservationFromSharedImporter(
  page: Page,
  selectedScope: SelectedProviderScope,
): Promise<LorcanaDownstreamSmokeResult | null> {
  const sourceScopeReapplyForms = sourceScopeCommandForms(
    page,
    lorcanaDownstreamCatalogItemsJourney.unitKey,
    catalogWorkbenchCommand.reapply,
  ).filter({ has: page.getByRole("button", { name: /^Reapply / }) });
  if (await clickSelectedScopeCommandForm(sourceScopeReapplyForms, selectedScope)) {
    if (!(await expectCommandQueuedOrSettledNoPromotable(page, selectedScope))) {
      return null;
    }
    return {
      mode: "reapply",
      providerKey: selectedScope.providerKey,
      unitKey: lorcanaDownstreamCatalogItemsJourney.unitKey,
      selectedScope: selectedScope.displayLabel,
      selectedObservationIds: [],
      promotionPreviewId: null,
      jobId: currentSearchParam(page, "jobId"),
    };
  }

  await expandWorkflowStage(page, "review-changes");
  const rowReapplyForms = page.locator(
    `form[data-catalog-primary-workbench-command="${catalogWorkbenchCommand.reapply}"]:not([data-catalog-source-scope-unit])`,
  );
  const reapplied = await clickFirstEnabledObservationCommand(rowReapplyForms, {
    requireSelectedObservationIds: true,
  });
  if (!reapplied) {
    if (await settledNoPromotableSkipReason(page, selectedScope)) {
      return null;
    }
    throw new Error(
      `Lorcana downstream smoke could not find an eligible Source Observation to promote or a promoted Source Observation to reapply for ${
        selectedScope.displayLabel
      }. ${await promotionPreviewOperatorStateMessage(page, selectedScope)}`,
    );
  }

  if (!(await expectCommandQueuedOrSettledNoPromotable(page, selectedScope))) {
    return null;
  }
  return {
    mode: "reapply",
    providerKey: selectedScope.providerKey,
    unitKey: lorcanaDownstreamCatalogItemsJourney.unitKey,
    selectedScope: selectedScope.displayLabel,
    selectedObservationIds: reapplied.selectedObservationIds,
    promotionPreviewId: null,
    jobId: currentSearchParam(page, "jobId"),
  };
}

async function clickFirstEnabledObservationCommand(
  forms: Locator,
  input: Readonly<{ requireSelectedObservationIds: boolean }>,
): Promise<{ selectedObservationIds: readonly string[]; promotionPreviewId: string | null } | null> {
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    const count = await forms.count();
    for (let index = 0; index < count; index += 1) {
      const form = forms.nth(index);
      const selectedObservationIds = await selectedObservationIdsFromForm(form);
      if (input.requireSelectedObservationIds && selectedObservationIds.length === 0) {
        continue;
      }

      const promotionPreviewId = await hiddenInputValue(form, "promotionPreviewId")
        .then(emptyToNull)
        .catch(() => null);
      if (await clickCommandFormButtonIfEnabled(form)) {
        return {
          selectedObservationIds,
          promotionPreviewId,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return null;
}

async function clickSelectedScopeCommandForm(forms: Locator, selectedScope: SelectedProviderScope): Promise<boolean> {
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    const count = await forms.count();
    for (let index = 0; index < count; index += 1) {
      const form = forms.nth(index);
      const candidate = await selectedProviderScopeFromCommandForm(form).catch(() => null);
      if (
        candidate &&
        selectedProviderScopeMatchesSelectedScope(candidate, selectedScope) &&
        (await clickCommandFormButtonIfEnabled(form))
      ) {
        return true;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return false;
}

async function selectedObservationIdsFromForm(form: Locator): Promise<readonly string[]> {
  return hiddenInputValue(form, "selectedObservationIds")
    .then((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .catch(() => []);
}

async function clickCommandFormButtonIfEnabled(form: Locator): Promise<boolean> {
  const button = form.getByRole("button").first();
  if (!(await button.isVisible({ timeout: 1_000 }).catch(() => false))) {
    return false;
  }
  if (!(await button.isEnabled().catch(() => false))) {
    return false;
  }

  await button.click();
  return true;
}

async function expectPromotionPreviewReady(page: Page): Promise<string> {
  const promotionPreviewId = await tryPromotionPreviewReady(page, syncTimeoutMs);
  if (!promotionPreviewId) {
    throw new Error("Expected promotion preview to be ready with a routable promotionPreviewId before the timeout.");
  }

  return promotionPreviewId;
}

async function tryPromotionPreviewReady(page: Page, timeout: number): Promise<string | null> {
  if (
    !(await page
      .getByText("Promotion preview ready")
      .first()
      .isVisible({ timeout })
      .catch(() => false))
  ) {
    return null;
  }
  await expect(
    page
      .getByText("Promotion preview is ready for the current provider, scope, filters, and selection checkpoint.")
      .first(),
  ).toBeVisible({ timeout });

  return waitForSearchParamOrNull(page, "promotionPreviewId", timeout);
}

async function waitForFreshPromotionPreviewOrOperatorBlocker(
  page: Page,
  selectedScope: SelectedProviderScope,
  timeout: number,
): Promise<Readonly<{ fresh: boolean; operatorState: string }>> {
  const deadline = Date.now() + timeout;
  let operatorState = await promotionPreviewOperatorStateMessage(page, selectedScope);

  while (Date.now() < deadline) {
    await expandWorkflowStage(page, "create-items");
    const stageText = await createItemsStageOperatorText(page);
    if (/\bPreviewed impact is current\b/i.test(stageText)) {
      return {
        fresh: true,
        operatorState: promotionPreviewOperatorState(selectedScope, stageText),
      };
    }
    if (promotionPreviewHasTerminalOperatorBlocker(stageText)) {
      return {
        fresh: false,
        operatorState: promotionPreviewOperatorState(selectedScope, stageText),
      };
    }

    operatorState = promotionPreviewOperatorState(selectedScope, stageText);
    await page.waitForTimeout(1_000);
  }

  return {
    fresh: false,
    operatorState,
  };
}

async function promotionPreviewOperatorStateMessage(page: Page, selectedScope: SelectedProviderScope): Promise<string> {
  await expandWorkflowStage(page, "create-items").catch(() => undefined);
  return promotionPreviewOperatorState(selectedScope, await createItemsStageOperatorText(page));
}

function promotionPreviewHasTerminalOperatorBlocker(stageText: string): boolean {
  return /\bNo promotable observations\b/i.test(stageText) || /\bStale promotion preview\b/i.test(stageText);
}

function promotionPreviewHasNoPromotableBlocker(stageText: string): boolean {
  return /\bNo promotable observations\b/i.test(stageText);
}

async function createItemsStageOperatorText(page: Page): Promise<string> {
  const panel = await createItemsStagePanel(page);
  return panel
    .innerText({ timeout: 2_000 })
    .then(normalizeWhitespace)
    .catch(() => "");
}

async function createItemsStagePanel(page: Page): Promise<Locator> {
  const trigger = page.locator('[data-catalog-import-workflow-stage="create-items"]').first();
  const panelId = await trigger.getAttribute("aria-controls").catch(() => null);
  return panelId ? page.locator(`[id="${cssAttrValue(panelId)}"]`).first() : trigger;
}

function promotionPreviewOperatorState(selectedScope: SelectedProviderScope, stageText: string): string {
  return `operator state for ${selectedScope.providerKey} / ${selectedScope.displayLabel}: ${
    stageText || "Create / update items stage text was not visible"
  }`;
}

async function executePromotionFromFreshPreview(
  page: Page,
  selectedScope: SelectedProviderScope,
  input: Readonly<{ allowOperatorStateFallback?: boolean }> = {},
): Promise<boolean> {
  await expandWorkflowStage(page, "create-items");
  const readiness = await waitForFreshPromotionPreviewOrOperatorBlocker(page, selectedScope, syncTimeoutMs);
  if (!readiness.fresh) {
    const message = `Lorcana downstream smoke cannot execute promotion for ${selectedScope.displayLabel}: ${readiness.operatorState}`;
    if (input.allowOperatorStateFallback) {
      console.log(`[catalog-staging-provider-uat] ${message} Trying promoted-observation reapply fallback.`);
      return false;
    }
    throw new Error(message);
  }

  const createItemsStage = await createItemsStagePanel(page);
  const confirmation = createItemsStage.getByRole("checkbox", { name: /^I confirm this will promote/i }).first();
  await expect(confirmation).toBeEnabled({ timeout: syncTimeoutMs });
  if (!(await confirmation.isChecked().catch(() => false))) {
    await confirmation.check();
    await expect(confirmation).toBeChecked({ timeout: syncTimeoutMs });
  }

  const executeForm = createItemsStage
    .locator(`form[data-catalog-primary-workbench-command="${catalogWorkbenchCommand.promote}"]`)
    .filter({ has: page.getByRole("button", { name: "Create or update Catalog Items" }) })
    .first();
  const executeButton = executeForm.getByRole("button", { name: "Create or update Catalog Items" });
  await expect(executeButton).toBeEnabled({ timeout: syncTimeoutMs });
  await executeButton.click();
  await expectCommandQueued(page);
  return true;
}

async function openCatalogItemsHandoff(page: Page, providerKey: string): Promise<void> {
  await expandWorkflowStage(page, "create-items");
  const handoff = page.getByRole("link", { name: `Open Catalog Items for ${providerKey}` }).first();
  await expect(handoff).toBeVisible({ timeout: sourceOptionTimeoutMs });
  await expect(handoff).toHaveAttribute("href", `/catalog/catalog-items?source=${providerKey}`, {
    timeout: sourceOptionTimeoutMs,
  });
  await handoff.click();
  await page.waitForLoadState("domcontentloaded", { timeout: pageReadyTimeoutMs }).catch(() => undefined);
}

async function expectCatalogItemsProjectionForProvider(
  page: Page,
  result: LorcanaDownstreamSmokeResult,
): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/catalog/catalog-items\\?source=${result.providerKey}`), {
    timeout: pageReadyTimeoutMs,
  });
  await expect(page.getByRole("heading", { name: "Catalog Items", exact: true })).toBeVisible({
    timeout: pageReadyTimeoutMs,
  });

  const deadline = Date.now() + downstreamProjectionTimeoutMs;
  let observedRows: readonly string[] = [];
  while (Date.now() < deadline) {
    await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", { timeout: 30_000 });
    observedRows = await catalogItemProviderRowTexts(page, result.providerKey);
    const projected = observedRows.find((row) => /\b(?:draft|active)\b/i.test(row));
    if (projected) {
      console.log(`[catalog-staging-provider-uat] Lorcana Catalog Items row observed: ${projected}`);
      return;
    }

    await page.waitForTimeout(5_000);
    await page.reload({ waitUntil: "domcontentloaded", timeout: pageReadyTimeoutMs }).catch(() => undefined);
  }

  throw new Error(
    `Catalog Items did not show a ${result.providerKey} draft or active downstream projection after ${
      result.mode
    } for ${result.selectedScope}. Observed provider rows: ${observedRows.join(" | ") || "none"}`,
  );
}

async function catalogItemProviderRowTexts(page: Page, providerKey: string): Promise<readonly string[]> {
  return page
    .getByRole("row")
    .filter({ hasText: providerKey })
    .allInnerTexts()
    .then((rows) => rows.map(normalizeWhitespace).filter(Boolean))
    .catch(() => []);
}

async function waitForSearchParam(page: Page, name: string, timeout: number): Promise<string> {
  const value = await waitForSearchParamOrNull(page, name, timeout);
  if (value) {
    return value;
  }

  throw new Error(`Expected the current operator route to include ${name} before the timeout.`);
}

async function waitForSearchParamOrNull(page: Page, name: string, timeout: number): Promise<string | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = currentSearchParam(page, name);
    if (value) {
      return value;
    }
    if (
      await page
        .getByText("No promotable observations")
        .first()
        .isVisible({ timeout: 250 })
        .catch(() => false)
    ) {
      return null;
    }
    await page.waitForTimeout(500);
  }

  return null;
}

function currentSearchParam(page: Page, name: string): string | null {
  return emptyToNull(new URL(page.url()).searchParams.get(name) ?? "");
}

function currentRouteImportScope(page: Page): string | null {
  return currentSearchParam(page, "importScope") ?? currentSearchParam(page, "filter.importScope");
}

function importJobRowReachedUnsuccessfulTerminal(row: string): boolean {
  return /\bimport job \S+ is (?:failed|cancelled|partial|stale)\b/i.test(row);
}

function importJobRowReachedPartialTerminal(row: string): boolean {
  return /\bimport job \S+ is partial\b/i.test(row);
}

function importJobRowReachedCompletedTerminal(row: string): boolean {
  return /\bimport job \S+ is completed\b/i.test(row);
}

function sourceScopeCommandForms(page: Page, unitKey: string, command: string): Locator {
  return page.locator(
    `form[data-catalog-primary-workbench-command="${command}"][data-catalog-source-scope-unit="${unitKey}"]`,
  );
}

function sourceScopeSyncForms(page: Page, unitKey: string): Locator {
  return sourceScopeCommandForms(page, unitKey, catalogWorkbenchCommand.import).filter({
    has: page.getByRole("button", { name: /^Sync / }),
  });
}

async function selectedSourceScopeSyncForm(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  timeoutMs = sourceOptionTimeoutMs,
): Promise<Locator> {
  const commandForms = sourceScopeSyncForms(page, unitKey);
  const deadline = Date.now() + timeoutMs;
  let observedScopes: readonly string[] = [];

  while (Date.now() < deadline) {
    await expandWorkflowStage(page, "run-sync").catch(() => undefined);
    const count = await commandForms.count().catch(() => 0);
    const observed: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const commandForm = commandForms.nth(index);
      if (!(await commandForm.isVisible().catch(() => false))) {
        continue;
      }
      const candidate = await selectedProviderScopeFromCommandForm(commandForm).catch(() => null);
      if (!candidate) {
        continue;
      }
      observed.push(candidate.displayLabel);
      if (selectedProviderScopeMatchesSelectedScope(candidate, selectedScope)) {
        return commandForm;
      }
    }
    observedScopes = [...new Set(observed)];
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Sync command form for ${unitKey} did not settle on ${selectedScope.displayLabel}. Observed visible command scopes: ${
      observedScopes.join(", ") || "none"
    }.`,
  );
}

async function expectCommandQueued(page: Page): Promise<void> {
  await expect(page.getByText("Command queued").first()).toBeVisible({ timeout: syncTimeoutMs });
  await expect(
    page.getByText("The durable job is queued with this provider, scope, profile, and review context.").first(),
  ).toBeVisible({ timeout: syncTimeoutMs });
}

async function expectCommandQueuedOrActiveImport(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<void> {
  const deadline = Date.now() + syncTimeoutMs;
  let nextExpandAt = Date.now();
  while (Date.now() < deadline) {
    if (
      await page
        .getByText("Command queued")
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      await expectCommandQueued(page);
      return;
    }
    if (await hasVisibleImportJobForSelectedUnit(page, unitKey, selectedScope, 500)) {
      return;
    }
    if (Date.now() >= nextExpandAt) {
      await expandWorkflowStage(page, "run-sync").catch(() => undefined);
      nextExpandAt = Date.now() + 5_000;
    }
    await page.waitForTimeout(500);
  }

  throw new Error(
    `Expected a queued command banner or visible import job row for ${unitKey} and ${selectedScope.displayLabel} before the timeout.`,
  );
}

async function expectCommandQueuedOrSettledNoPromotable(
  page: Page,
  selectedScope: SelectedProviderScope,
): Promise<boolean> {
  if (!providerUatScopeAcceptsSettledNoPromotableCoverage()) {
    await expectCommandQueued(page);
    return true;
  }

  const deadline = Date.now() + syncTimeoutMs;
  while (Date.now() < deadline) {
    if (
      await page
        .getByText("Command queued")
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      await expectCommandQueued(page);
      return true;
    }

    const skipReason = await settledNoPromotableSkipReason(page, selectedScope);
    if (skipReason) {
      console.log(
        `[catalog-staging-provider-uat] No promotable observations after command handoff for ${selectedScope.displayLabel}; treating the settled ${providerUatJourneyScope} scope as covered. ${skipReason}`,
      );
      return false;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    `Expected a queued command banner or no-promotable settled state for ${selectedScope.displayLabel} before the timeout.`,
  );
}

const settledNoPromotableCoverageScopes = new Set<string>([
  "all-provider-regression",
  "lorcana-launch",
  "pokemon-matrix",
  "mtg-matrix",
  "yugioh-matrix",
  "one-piece-matrix",
  "lorcana-matrix",
  "full-matrix-uat",
]);

function providerUatScopeAcceptsSettledNoPromotableCoverage(scope: string = providerUatJourneyScope): boolean {
  return settledNoPromotableCoverageScopes.has(scope);
}

async function settledNoPromotableSkipReason(page: Page, selectedScope: SelectedProviderScope): Promise<string | null> {
  if (!providerUatScopeAcceptsSettledNoPromotableCoverage()) {
    return null;
  }

  const operatorState = await promotionPreviewOperatorStateMessage(page, selectedScope).catch(() => "");
  if (!promotionPreviewHasNoPromotableBlocker(operatorState)) {
    return null;
  }

  return sanitizeSupportSafeEvidence(operatorState);
}

async function hasVisibleImportJobForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  timeout: number,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rows = await visibleImportJobRowTexts(page, unitKey, selectedScope);
    if (rows.length > 0) {
      return true;
    }
    await page.waitForTimeout(250);
  }

  return false;
}

async function hasActiveImportJobForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  timeout: number,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rows = await visibleImportJobRowTexts(page, unitKey, selectedScope);
    if (rows.some((row) => /import job .*(?:queued|running)/i.test(row))) {
      return true;
    }
    await page.waitForTimeout(250);
  }

  return false;
}

async function expectActiveImportJobForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<void> {
  await expect(page.getByText("Import already running", { exact: true }).first()).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    const rows = await visibleImportJobRowTexts(page, unitKey, selectedScope);
    const active = rows.find((row) => /import job .*(?:queued|running)/i.test(row));
    if (active) {
      return;
    }
    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `Selected unit ${unitKey} should have a visible current or covering queued/running import job row for ${selectedScope.displayLabel}.`,
  );
}

async function completedImportJobRowLocatorForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  timeout: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rows = importJobRowsForSelectedUnit(page, unitKey);
    const count = await rows.count();
    const scopeCandidates = selectedProviderScopeActiveJobImportScopes(selectedScope, currentRouteImportScope(page));
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (
        (await row.isVisible().catch(() => false)) &&
        (await importJobRowAttribute(row, "data-catalog-import-job-operator-status")) === "completed" &&
        (await importJobRowMatchesSelectedScope(row, scopeCandidates))
      ) {
        return row;
      }
    }
    await page.waitForTimeout(250);
  }

  return null;
}

async function importJobRowLocatorForStableSummary(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  summary: string,
): Promise<Locator | null> {
  const jobId = importJobIdFromStableSummary(summary);
  if (!jobId) {
    return null;
  }

  const rows = page.locator(
    `[data-catalog-import-job-row="true"][data-catalog-import-job-unit="${cssAttrValue(
      unitKey,
    )}"][data-catalog-import-job-id="${cssAttrValue(jobId)}"]`,
  );
  const scopeCandidates = selectedProviderScopeActiveJobImportScopes(selectedScope, currentRouteImportScope(page));
  const count = await rows.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if ((await row.isVisible().catch(() => false)) && (await importJobRowMatchesSelectedScope(row, scopeCandidates))) {
      return row;
    }
  }

  return null;
}

function importJobIdFromStableSummary(summary: string): string | null {
  return summary.match(/\bimport job (\S+) is\b/i)?.[1] ?? null;
}

function importJobRowsForSelectedUnit(page: Page, unitKey: string): Locator {
  return page.locator(`[data-catalog-import-job-row="true"][data-catalog-import-job-unit="${cssAttrValue(unitKey)}"]`);
}

async function visibleImportJobRowTexts(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<readonly string[]> {
  const rows = importJobRowsForSelectedUnit(page, unitKey);
  const scopeCandidates = selectedProviderScopeActiveJobImportScopes(selectedScope, currentRouteImportScope(page));
  const count = await rows.count().catch(() => 0);
  const visibleRows: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible().catch(() => false))) {
      continue;
    }
    if (!(await importJobRowMatchesSelectedScope(row, scopeCandidates))) {
      continue;
    }
    visibleRows.push(await importJobRowStableSummary(row));
  }

  return [...new Set(visibleRows)];
}

async function importJobRowMatchesSelectedScope(row: Locator, scopeCandidates: readonly string[]): Promise<boolean> {
  const rowScope = await importJobRowAttribute(row, "data-catalog-import-job-scope");
  return Boolean(rowScope && scopeCandidates.includes(comparableImportScope(rowScope)));
}

async function importJobRowStableSummary(row: Locator): Promise<string> {
  const jobId = (await importJobRowAttribute(row, "data-catalog-import-job-id")) || "unknown";
  const provider = (await importJobRowAttribute(row, "data-catalog-import-job-provider")) || "unknown";
  const unit = (await importJobRowAttribute(row, "data-catalog-import-job-unit")) || "unknown";
  const scope = (await importJobRowAttribute(row, "data-catalog-import-job-scope")) || "none";
  const state = (await importJobRowAttribute(row, "data-catalog-import-job-state")) || "unknown";
  const operatorStatus =
    (await importJobRowAttribute(row, "data-catalog-import-job-operator-status")) || state || "unknown";
  const route = (await importJobRowAttribute(row, "data-catalog-import-job-scope-route")) || "unknown";
  return `import job ${jobId} is ${operatorStatus} (state=${state}; provider=${provider}; unit=${unit}; scope=${scope}; route=${route})`;
}

async function importJobRowAttribute(row: Locator, name: string): Promise<string | null> {
  return emptyToNull((await row.getAttribute(name).catch(() => null)) ?? "");
}

function selectedProviderScopeActiveJobImportScopes(
  selectedScope: SelectedProviderScope,
  routeImportScope: string | null = null,
): readonly string[] {
  const candidates = [
    selectedScope.importScope,
    routeImportScope,
    ...selectedProviderScopeCompactJobImportScopeCandidates(selectedScope),
  ]
    .filter((scope): scope is string => Boolean(scope))
    .flatMap(importScopePrefixes)
    .map(comparableImportScope);
  return [...new Set(candidates)];
}

function importScopePrefixes(importScope: string): readonly string[] {
  const segments = importScope.split(":").filter(Boolean);
  return Array.from({ length: segments.length }, (_, index) => segments.slice(0, segments.length - index).join(":"));
}

function selectedProviderScopeCompactJobImportScopeCandidates(selectedScope: SelectedProviderScope): readonly string[] {
  const value = (name: string) => selectedScope.fields.find((field) => field.name === name)?.value;
  const languageSegments = uniqueTruthy([value("languageCode")]);
  const productLineSegments = uniqueTruthy([value("productLineId"), value("productLineName")]);
  const seriesSegments = uniqueTruthy([value("seriesName"), value("seriesId")]);
  const expansionSegments = uniqueTruthy([
    value("expansionName"),
    value("expansionId"),
    value("setName"),
    value("setCode"),
    value("setId"),
  ]);
  return cartesianImportScopes([languageSegments, productLineSegments, seriesSegments, expansionSegments]);
}

function comparableImportScope(value: string): string {
  return value
    .split(":")
    .map((segment) => comparableProviderScopeValue(segment))
    .filter(Boolean)
    .join(":");
}

function cartesianImportScopes(segmentGroups: readonly (readonly string[])[]): readonly string[] {
  return segmentGroups.reduce<readonly string[]>(
    (scopes, segments) => {
      const availableSegments = segments.length > 0 ? segments : [""];
      return scopes.flatMap((scope) => availableSegments.map((segment) => [scope, segment].filter(Boolean).join(":")));
    },
    [""],
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function selectedProviderScopeFromCommandForm(commandForm: Locator): Promise<SelectedProviderScope> {
  const providerKey = await hiddenInputValue(commandForm, "providerKey");
  const importScope = emptyToNull(await hiddenInputValue(commandForm, "importScope"));
  const fields = await selectedProviderScopeFieldsFromCommandForm(commandForm);
  expect(
    fields.length,
    "The shared importer command form should carry the selected source scope fields.",
  ).toBeGreaterThan(0);
  return {
    providerKey,
    importScope,
    fields,
    displayLabel: selectedProviderScopeDisplayLabel(providerKey, importScope, fields),
  };
}

async function hiddenInputValue(form: Locator, name: string): Promise<string> {
  return form.locator(`input[name="${name}"]`).first().inputValue();
}

async function selectedProviderScopeFieldsFromCommandForm(
  commandForm: Locator,
): Promise<readonly SelectedProviderScopeField[]> {
  const fieldNames = [
    "languageCode",
    "productLineId",
    "productLineName",
    "seriesId",
    "seriesName",
    "expansionId",
    "expansionName",
    "setId",
    "setCode",
    "setName",
  ];
  const fields = await Promise.all(
    fieldNames.map(async (name) => ({
      name,
      value: (await optionalHiddenInputValue(commandForm, name)).trim(),
    })),
  );
  return fields.filter((field) => field.value.length > 0);
}

function selectedProviderScopeMatchesJourneySelection(
  selectedScope: SelectedProviderScope,
  selectedChoices: readonly SelectedScopeChoice[],
): boolean {
  const scopeValues = selectedProviderScopeComparableValues(selectedScope);
  return selectedChoices.every((choice) =>
    choice.values.some((value) => scopeValues.has(comparableProviderScopeValue(value))),
  );
}

function selectedProviderScopeMatchesSelectedScope(
  candidate: SelectedProviderScope,
  expected: SelectedProviderScope,
): boolean {
  if (candidate.providerKey !== expected.providerKey) {
    return false;
  }

  if (candidate.importScope || expected.importScope) {
    return Boolean(
      candidate.importScope &&
      expected.importScope &&
      selectedProviderScopeMatchesImportScope(candidate, expected.importScope),
    );
  }

  if (normalizeWhitespace(candidate.displayLabel) === normalizeWhitespace(expected.displayLabel)) {
    return true;
  }

  const candidateValues = selectedProviderScopeComparableValues(candidate);
  const expectedFieldValues = expected.fields.map((field) => comparableProviderScopeValue(field.value)).filter(Boolean);
  return expectedFieldValues.length > 0 && expectedFieldValues.every((value) => candidateValues.has(value));
}

function selectedProviderScopeMatchesImportScope(
  candidate: SelectedProviderScope,
  expectedImportScope: string,
): boolean {
  if (!candidate.importScope) {
    return false;
  }

  const candidateScopes = importPreflightScopeCandidates(candidate.importScope).map(comparableImportScope);
  const expectedScopes = importPreflightScopeCandidates(expectedImportScope).map(comparableImportScope);
  return candidateScopes.some((scope) => expectedScopes.includes(scope));
}

function selectedProviderScopeComparableValues(selectedScope: SelectedProviderScope): ReadonlySet<string> {
  const values = new Set<string>();
  for (const segment of selectedScope.importScope?.split(":") ?? []) {
    addComparableProviderScopeValue(values, segment);
  }
  for (const field of selectedScope.fields) {
    addComparableProviderScopeValue(values, field.value);
  }
  return values;
}

function addComparableProviderScopeValue(values: Set<string>, value: string): void {
  const comparable = comparableProviderScopeValue(value);
  if (comparable) {
    values.add(comparable);
  }
}

function selectedProviderScopeMatchesUnitDomain(selectedScope: SelectedProviderScope, unitKey: string): boolean {
  const unitDomain = normalizedProductDomain(unitKey.split(":")[1] ?? "");
  if (!unitDomain) {
    return true;
  }

  const productLineDomains = selectedScope.fields
    .filter((field) => field.name === "productLineName" || field.name === "productLineId")
    .map((field) => productDomainFromProviderScopeValue(field.value))
    .filter((domain): domain is string => Boolean(domain));
  if (productLineDomains.length === 0) {
    return true;
  }

  return productLineDomains.some((domain) => productDomainsMatch(domain, unitDomain));
}

function productDomainFromProviderScopeValue(value: string): string | null {
  const normalized = normalizedProductDomain(value);
  if (!normalized || /^\d+$/.test(normalized)) {
    return null;
  }
  if (normalized.includes("pokemon")) {
    return "pokemon";
  }
  if (normalized.includes("magic") || normalized.includes("mtg")) {
    return "mtg";
  }
  if (normalized.includes("yugioh")) {
    return "yugioh";
  }

  return normalized;
}

function normalizedProductDomain(value: string): string | null {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized || null;
}

function productDomainsMatch(left: string, right: string): boolean {
  return left === right || left.includes(right) || right.includes(left);
}

function comparableProviderScopeValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function optionalHiddenInputValue(form: Locator, name: string): Promise<string> {
  const input = form.locator(`input[name="${name}"]`).first();
  return (await input.count()) > 0 ? input.inputValue() : "";
}

function selectedProviderScopeDisplayLabel(
  providerKey: string,
  importScope: string | null,
  fields: readonly SelectedProviderScopeField[],
): string {
  return selectedProviderScopeDisplayLabelCandidates(providerKey, importScope, fields)[0] ?? providerKey;
}

function selectedProviderScopeDisplayLabelCandidates(
  providerKey: string,
  importScope: string | null,
  fields: readonly SelectedProviderScopeField[],
): readonly string[] {
  const value = (name: string) => fields.find((field) => field.name === name)?.value;
  const productLineSegments = uniqueTruthy([value("productLineName"), value("productLineId")]);
  const seriesSegments = uniqueTruthy([value("seriesName"), value("seriesId")]);
  const expansionSegments = uniqueTruthy([
    value("expansionName"),
    value("expansionId"),
    value("setName"),
    value("setCode"),
    value("setId"),
  ]);
  const structured = cartesianScopeLabels([
    [providerKey],
    uniqueTruthy([value("languageCode")]),
    productLineSegments,
    seriesSegments,
    expansionSegments,
  ]);
  const importScopeLabel = importScope ? scopeDisplayLabelFromImportScope(providerKey, importScope) : null;
  const candidates = [...structured, importScopeLabel]
    .filter((candidate): candidate is string => Boolean(candidate))
    .sort((left, right) => right.split(" / ").length - left.split(" / ").length);

  return [...new Set(candidates)];
}

function cartesianScopeLabels(segmentGroups: readonly (readonly string[])[]): readonly string[] {
  return segmentGroups.reduce<readonly string[]>(
    (labels, segments) => {
      const availableSegments = segments.length > 0 ? segments : [""];
      return labels.flatMap((label) =>
        availableSegments.map((segment) => [label, segment].filter(Boolean).join(" / ")),
      );
    },
    [""],
  );
}

function uniqueTruthy(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function scopeDisplayLabelFromImportScope(providerKey: string, importScope: string): string {
  return [providerKey, ...importScope.split(":").filter(Boolean)].filter(Boolean).join(" / ");
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function expectImporterVisible(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", {
      name: "Pull provider data, review Source Observations, promote Catalog facts",
    }),
  ).toBeVisible({ timeout: pageReadyTimeoutMs });
}

async function isImporterVisible(page: Page, timeout: number): Promise<boolean> {
  return page
    .getByRole("heading", {
      name: "Pull provider data, review Source Observations, promote Catalog facts",
    })
    .isVisible({ timeout })
    .catch(() => false);
}

async function selectOption(
  select: Locator,
  choice: SelectChoice,
  recoverMissingOptions?: MissingOptionRecovery,
): Promise<void> {
  await expectSelectVisible(select, recoverMissingOptions);

  const option = await waitForOption(select, choice, recoverMissingOptions);
  if (await select.isDisabled()) {
    const currentValue = await select.inputValue();
    if (currentValue === option.value) {
      return;
    }
    throw new Error(
      `Expected disabled select to already use ${option.label} (${option.value}), but current value is ${currentValue}.`,
    );
  }

  await expect(select).toBeEnabled({ timeout: sourceOptionTimeoutMs });
  await select.selectOption({ value: option.value });
}

async function waitForOption(
  select: Locator,
  choice: SelectChoice,
  recoverMissingOptions?: MissingOptionRecovery,
): Promise<{ label: string; value: string }> {
  const labels = choice.labels ?? [];
  const values = choice.values ?? [];
  const deadline = Date.now() + sourceOptionTimeoutMs;
  let nextRecoveryAttemptAt = Date.now() + 5_000;
  const fallbackOptionAllowedAt = Date.now() + 5_000;
  let recoveryAttempts = 0;
  let observedOptions: readonly { label: string; value: string }[] = [];

  while (Date.now() < deadline) {
    observedOptions = await select
      .locator("option")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          label: (node.textContent ?? "").trim(),
          value: (node as HTMLOptionElement).value,
        })),
      )
      .catch(() => []);
    const valueMatch = values.map((value) => observedOptions.find((option) => option.value === value)).find(Boolean);
    if (valueMatch) {
      return valueMatch;
    }
    const labelMatch = labels.map((label) => observedOptions.find((option) => option.label === label)).find(Boolean);
    if (labelMatch) {
      return labelMatch;
    }
    const fallback = choice.fallbackToFirstAvailableOption;
    const fallbackOption =
      fallback && Date.now() >= fallbackOptionAllowedAt && (!recoverMissingOptions || recoveryAttempts > 0)
        ? observedOptions.find((option) => isSelectableFallbackOption(option, fallback))
        : undefined;
    if (fallbackOption) {
      return fallbackOption;
    }

    if (recoverMissingOptions && recoveryAttempts < 3 && Date.now() >= nextRecoveryAttemptAt) {
      recoveryAttempts += 1;
      nextRecoveryAttemptAt = Date.now() + 15_000;
      if (await recoverMissingOptions()) {
        await expectSelectVisible(select, recoverMissingOptions);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Expected select to contain one of: ${[...values, ...labels].join(", ")}. Observed: ${observedOptions
      .map((option) => `${option.label} (${option.value})`)
      .join(", ")}`,
  );
}

async function expectSelectVisible(select: Locator, recoverMissingOptions?: MissingOptionRecovery): Promise<void> {
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    if (await select.isVisible({ timeout: 1_000 }).catch(() => false)) {
      return;
    }

    if (recoverMissingOptions && (await recoverMissingOptions())) {
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await expect(select).toBeVisible({ timeout: 1_000 });
}

function isSelectableFallbackOption(
  option: { label: string; value: string },
  fallback: NonNullable<SelectChoice["fallbackToFirstAvailableOption"]>,
): boolean {
  return (
    option.value.length > 0 &&
    option.label.length > 0 &&
    (!fallback.valuePattern || fallback.valuePattern.test(option.value))
  );
}

async function refreshSourceOptionGroup(page: Page, label: string | RegExp): Promise<boolean> {
  const sourceOptionsPanel = page.locator("[data-catalog-source-options-status]").first();
  if (!(await sourceOptionsPanel.isVisible({ timeout: 1_000 }).catch(() => false))) {
    return false;
  }

  const optionGroup = sourceOptionsPanel
    .locator("[data-source-option-page]")
    .filter({ has: sourceOptionGroupLabel(page, label) })
    .first();
  const refreshTarget = (await optionGroup.isVisible({ timeout: 1_000 }).catch(() => false))
    ? optionGroup
    : sourceOptionsPanel;

  const forceRefresh = refreshTarget.getByRole("button", { name: "Force refresh" }).first();
  if (await forceRefresh.isEnabled().catch(() => false)) {
    await forceRefresh.click();
    await waitForSourceOptionsToSettle(page);
    return true;
  }

  const reload = refreshTarget.getByRole("button", { name: "Reload" }).first();
  if (await reload.isEnabled().catch(() => false)) {
    await reload.click();
    await waitForSourceOptionsToSettle(page);
    return true;
  }

  const refreshAll = sourceOptionsPanel.getByRole("button", { name: "Refresh all" }).first();
  if (await refreshAll.isEnabled().catch(() => false)) {
    await refreshAll.click();
    await waitForSourceOptionsToSettle(page);
    return true;
  }

  return false;
}

async function recoverSourceOptionSelection(page: Page, label: string | RegExp): Promise<boolean> {
  return (await recoverImporterFromAdminError(page)) || refreshSourceOptionGroup(page, label);
}

async function recoverImporterFromAdminError(page: Page): Promise<boolean> {
  const adminError = page.getByRole("heading", { name: "Admin Error" });
  if (!(await adminError.isVisible({ timeout: 1_000 }).catch(() => false))) {
    return false;
  }

  const initialDetail = await adminErrorTechnicalDetail(page);
  const retry = page.getByRole("link", { name: "Retry" }).first();
  if (await retry.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await retry.click();
  } else {
    await page.reload({ waitUntil: "domcontentloaded", timeout: pageReadyTimeoutMs }).catch(() => undefined);
  }

  await page.waitForLoadState("domcontentloaded", { timeout: pageReadyTimeoutMs }).catch(() => undefined);
  if (!(await isImporterVisible(page, 10_000))) {
    const retryDetail = await adminErrorTechnicalDetail(page);
    throw new Error(
      `Catalog importer rendered Admin Error while loading ${supportSafeCurrentPath(page)}. Technical detail: ${
        retryDetail ?? initialDetail ?? "not visible"
      }`,
    );
  }

  await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", { timeout: 30_000 });
  return true;
}

async function adminErrorTechnicalDetail(page: Page): Promise<string | null> {
  if (
    !(await page
      .getByRole("heading", { name: "Admin Error" })
      .isVisible({ timeout: 1_000 })
      .catch(() => false))
  ) {
    return null;
  }

  const details = page
    .locator("details")
    .filter({ has: page.getByText("Technical detail") })
    .first();
  const detailText = await details.textContent({ timeout: 1_000 }).catch(() => null);
  const fallbackText =
    detailText ??
    (await page
      .locator("main")
      .innerText({ timeout: 1_000 })
      .catch(() => null));
  return fallbackText ? sanitizeSupportSafeEvidence(fallbackText) : null;
}

function supportSafeCurrentPath(page: Page): string {
  try {
    const url = new URL(page.url());
    return sanitizeSupportSafeEvidence(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    return "[current route unavailable]";
  }
}

function sourceOptionGroupLabel(page: Page, label: string | RegExp): Locator {
  return typeof label === "string" ? page.getByText(label, { exact: true }) : page.getByText(label);
}

async function waitForSourceOptionsToSettle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: pageReadyTimeoutMs }).catch(() => undefined);
  await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", {
    timeout: pageReadyTimeoutMs,
  });
  await page
    .getByText("Loading source options", { exact: true })
    .waitFor({ state: "hidden", timeout: sourceOptionTimeoutMs })
    .catch(() => undefined);
}
