import type { YgojsonSetData, YgojsonSealedProductData } from "./ygojson/adapter";

function tcgdexProofFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  const response = tcgdexProofResponses[url];
  if (!response) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  return Promise.resolve(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const tcgdexProofResponses: Readonly<Record<string, unknown>> = {
  "https://api.tcgdex.net/v2/en/sets/swsh3": {
    id: "swsh3",
    name: "Darkness Ablaze",
    releaseDate: "2020-08-14",
    serie: {
      id: "swsh",
      name: "Sword & Shield",
    },
    cardCount: {
      total: 201,
      official: 189,
      reverse: 155,
    },
    cards: [{ id: "swsh3-136", localId: "136", name: "Furret" }],
  },
  "https://api.tcgdex.net/v2/en/cards/swsh3-136": {
    id: "swsh3-136",
    localId: "136",
    name: "Furret",
    category: "Pokemon",
    illustrator: "tetsuya koizumi",
    rarity: "Uncommon",
    updated: "2026-05-15T00:00:00.000Z",
    image: "https://assets.tcgdex.net/en/swsh/swsh3/136",
    set: {
      id: "swsh3",
      name: "Darkness Ablaze",
    },
  },
};

function mtgjsonValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = mtgjsonValidationResponses[String(input)];
  if (!response) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  return Promise.resolve(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const mtgjsonValidationResponses: Readonly<Record<string, unknown>> = {
  "https://mtgjson.com/api/v5/SetList.json": {
    meta: { date: "2026-06-05", version: "5.3.0+20260605" },
    data: [
      {
        code: "TSP",
        name: "Time Spiral",
        releaseDate: "2006-10-06",
        totalSetSize: 301,
        type: "expansion",
      },
    ],
  },
  "https://mtgjson.com/api/v5/TSP.json": {
    meta: { date: "2026-06-05", version: "5.3.0+20260605" },
    data: {
      code: "TSP",
      name: "Time Spiral",
      releaseDate: "2006-10-06",
      totalSetSize: 301,
      cards: [
        {
          uuid: "13fd9d47-9aa7-5f7c-8f47-fury-sliver",
          name: "Fury Sliver",
          number: "157",
          rarity: "uncommon",
          layout: "normal",
          type: "Creature - Sliver",
          identifiers: {
            scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
          },
          finishes: ["foil", "nonfoil"],
        },
      ],
    },
  },
};

function lorcanajsonValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = lorcanajsonValidationResponses[String(input)];
  if (!response) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  return Promise.resolve(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const lorcanajsonValidationResponses: Readonly<Record<string, unknown>> = {
  "https://lorcanajson.org/files/current/en/allCards.json": {
    metadata: {
      formatVersion: "2.3.2",
      generatedOn: "2026-05-26T19:11:58",
      language: "en",
    },
    sets: {
      "1": {
        id: "1",
        code: "1",
        name: "The First Chapter",
        releaseDate: "2023-08-18",
        type: "expansion",
        number: 1,
      },
    },
    cards: [
      {
        id: "1-041",
        fullName: "Elsa - Snow Queen",
        number: "41",
        setCode: "1",
        rarity: "Super Rare",
        type: "Storyborn Hero Queen",
        color: "Amethyst",
        images: {
          full: "https://images.lorcanajson.org/cards/en/1/041.webp",
          thumbnail: "https://images.lorcanajson.org/cards/en/1/041-small.webp",
        },
        externalLinks: { tcgPlayerId: "1005010" },
      },
    ],
  },
  "https://lorcanajson.org/files/current/en/sets/setdata.1.json": {
    metadata: {
      formatVersion: "2.3.2",
      generatedOn: "2026-05-26T19:11:58",
      language: "en",
    },
    code: "1",
    name: "The First Chapter",
    releaseDate: "2023-08-18",
    cards: [
      {
        id: "1-041",
        fullName: "Elsa - Snow Queen",
        number: "41",
        setCode: "1",
        rarity: "Super Rare",
        type: "Storyborn Hero Queen",
        color: "Amethyst",
        images: {
          full: "https://images.lorcanajson.org/cards/en/1/041.webp",
          thumbnail: "https://images.lorcanajson.org/cards/en/1/041-small.webp",
        },
        externalLinks: { tcgPlayerId: "1005010" },
      },
    ],
  },
};

function lorcastValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = lorcastValidationResponses[String(input)];
  if (!response) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  return Promise.resolve(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const lorcastValidationResponses: Readonly<Record<string, unknown>> = {
  "https://api.lorcast.com/v0/sets": {
    results: [
      {
        id: "set_7ecb0e0c71af496a9e0110e23824e0a5",
        name: "The First Chapter",
        code: "1",
        released_at: "2023-08-18",
        prereleased_at: "2023-08-18",
      },
    ],
  },
  "https://api.lorcast.com/v0/sets/1": {
    id: "set_7ecb0e0c71af496a9e0110e23824e0a5",
    name: "The First Chapter",
    code: "1",
    released_at: "2023-08-18T00:00:00.000Z",
    prereleased_at: "2023-08-18T00:00:00.000Z",
  },
  "https://api.lorcast.com/v0/sets/1/cards": [
    {
      id: "crd_elsa_snow_queen_1_041",
      name: "Elsa - Snow Queen",
      version: null,
      released_at: "2023-08-18",
      image_uris: {
        digital: {
          small: "https://cards.lorcast.io/card/digital/small/crd_elsa_snow_queen_1_041.avif",
          normal: "https://cards.lorcast.io/card/digital/normal/crd_elsa_snow_queen_1_041.avif",
          large: "https://cards.lorcast.io/card/digital/large/crd_elsa_snow_queen_1_041.avif",
        },
      },
      ink: "Amethyst",
      type: ["Character"],
      rarity: "Super_rare",
      collector_number: "41",
      lang: "en",
      tcgplayer_id: 1005010,
      set: {
        id: "set_7ecb0e0c71af496a9e0110e23824e0a5",
        code: "1",
        name: "The First Chapter",
      },
    },
  ],
};

function scryfallValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = scryfallValidationResponses[String(input)];
  if (!response) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  return Promise.resolve(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const scryfallValidationCard = {
  object: "card",
  id: "0000579f-7b35-4ed3-b44c-db2a538066fe",
  oracle_id: "44623693-51d6-49ad-8cd7-140505caf02f",
  name: "Fury Sliver",
  lang: "en",
  released_at: "2006-10-06",
  uri: "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe",
  scryfall_uri: "https://scryfall.com/card/tsp/157/fury-sliver?utm_source=api",
  layout: "normal",
  image_status: "highres_scan",
  image_uris: {
    normal: "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
    png: "https://cards.scryfall.io/png/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.png",
  },
  mana_cost: "{5}{R}",
  type_line: "Creature - Sliver",
  oracle_text: "All Sliver creatures have double strike.",
  set: "tsp",
  set_name: "Time Spiral",
  collector_number: "157",
  rarity: "uncommon",
  finishes: ["nonfoil", "foil"],
  artist: "Pete Venters",
  tcgplayer_id: 14240,
  prices: { usd: "0.53", usd_foil: "2.60" },
};

const scryfallValidationResponses: Readonly<Record<string, unknown>> = {
  "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe": scryfallValidationCard,
  "https://api.scryfall.com/cards/search?q=!%22Fury%20Sliver%22&unique=prints": {
    object: "list",
    has_more: false,
    data: [scryfallValidationCard],
  },
  "https://api.scryfall.com/cards/search?q=set%3ATSP&unique=prints": {
    object: "list",
    has_more: false,
    data: [scryfallValidationCard],
  },
  "https://api.scryfall.com/cards/search?q=set%3Atsp&unique=prints": {
    object: "list",
    has_more: false,
    data: [scryfallValidationCard],
  },
  "https://api.scryfall.com/sets": {
    object: "list",
    has_more: false,
    data: [
      {
        object: "set",
        id: "c1d109bc-ffd8-428f-8d7d-3f8d7e648046",
        code: "tsp",
        name: "Time Spiral",
        set_type: "expansion",
        released_at: "2006-10-06",
        card_count: 301,
        digital: false,
      },
    ],
  },
  "https://api.scryfall.com/bulk-data": {
    object: "list",
    has_more: false,
    data: [
      {
        object: "bulk_data",
        type: "default_cards",
        name: "Default Cards",
        updated_at: "2026-06-08T09:13:03.704+00:00",
        download_uri: "https://data.scryfall.io/default-cards/default-cards-20260608091303.json",
        content_type: "application/json",
        content_encoding: "gzip",
      },
    ],
  },
};

function ygoprodeckValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = ygoprodeckValidationResponses[String(input)];
  if (!response) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  return Promise.resolve(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const ygoprodeckValidationCard = {
  id: 46986414,
  name: "Dark Magician",
  type: "Normal Monster",
  frameType: "normal",
  desc: "The ultimate wizard in terms of attack and defense.",
  race: "Spellcaster",
  attribute: "DARK",
  archetype: "Dark Magician",
  card_sets: [
    {
      set_name: "Starter Deck: Yugi",
      set_code: "SDY-006",
      set_rarity: "Ultra Rare",
      set_rarity_code: "(UR)",
      set_price: "3.21",
    },
  ],
  card_images: [
    {
      id: 46986414,
      image_url: "https://images.ygoprodeck.com/images/cards/46986414.jpg",
      image_url_small: "https://images.ygoprodeck.com/images/cards_small/46986414.jpg",
      image_url_cropped: "https://images.ygoprodeck.com/images/cards_cropped/46986414.jpg",
    },
  ],
  card_prices: [
    {
      cardmarket_price: "0.10",
      tcgplayer_price: "0.25",
      ebay_price: "0.99",
      amazon_price: "1.50",
      coolstuffinc_price: "0.49",
    },
  ],
};

const ygoprodeckValidationResponses: Readonly<Record<string, unknown>> = {
  "https://db.ygoprodeck.com/api/v7/cardsets.php": [
    {
      set_name: "Starter Deck: Yugi",
      set_code: "SDY",
      num_of_cards: 50,
      tcg_date: "2002-03-29",
    },
  ],
  "https://db.ygoprodeck.com/api/v7/cardinfo.php?cardset=Starter+Deck%3A+Yugi": {
    data: [ygoprodeckValidationCard],
  },
  "https://db.ygoprodeck.com/api/v7/cardinfo.php?name=Dark+Magician": {
    data: [ygoprodeckValidationCard],
  },
  "https://db.ygoprodeck.com/api/v7/cardinfo.php?id=46986414": {
    data: [ygoprodeckValidationCard],
  },
};

function ygojsonValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = ygojsonValidationResponses[String(input)];
  if (!response) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  return Promise.resolve(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const ygojsonValidationSet = {
  id: "11111111-1111-4111-8111-111111111111",
  name: { en: "Legend of Blue Eyes White Dragon" },
  locales: {
    en: {
      language: "en",
      date: "2002-03-08",
      image: "https://ms.yugipedia.com//placeholder/LOB-EN.png",
      externalIDs: { dbIDs: [100000001] },
    },
  },
  contents: [
    {
      locales: ["en"],
      formats: ["tcg"],
      editions: ["unlimited"],
      cards: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          card: "44444444-4444-4444-8444-444444444444",
          suffix: "LOB-001",
          rarity: "ultra",
        },
      ],
    },
  ],
  externalIDs: {
    yugipedia: {
      id: 12345,
      name: "Legend of Blue Eyes White Dragon",
    },
  },
} as const satisfies YgojsonSetData;

const ygojsonValidationSealedProduct = {
  id: "22222222-2222-4222-8222-222222222222",
  name: { en: "Legend of Blue Eyes White Dragon Booster Box" },
  boxOf: [ygojsonValidationSet.id],
  locales: {
    en: {
      language: "en",
      date: "2002-03-08",
      externalIDs: { dbIDs: [100000002] },
    },
  },
  contents: [
    {
      locales: ["en"],
      packs: [{ set: ygojsonValidationSet.id, qty: 24 }],
    },
  ],
  externalIDs: {
    yugipedia: {
      id: 67890,
      name: "Legend of Blue Eyes White Dragon Booster Box",
    },
  },
} as const satisfies YgojsonSealedProductData;

const ygojsonValidationResponses: Readonly<Record<string, unknown>> = {
  "https://raw.githubusercontent.com/iconmaster5326/YGOJSON/v1/aggregate/sets.json": [ygojsonValidationSet],
  "https://raw.githubusercontent.com/iconmaster5326/YGOJSON/v1/aggregate/sealedProducts.json": [
    ygojsonValidationSealedProduct,
  ],
  [`https://raw.githubusercontent.com/iconmaster5326/YGOJSON/v1/individual/sets/${ygojsonValidationSet.id}.json`]:
    ygojsonValidationSet,
  [`https://raw.githubusercontent.com/iconmaster5326/YGOJSON/v1/individual/sealedProducts/${ygojsonValidationSealedProduct.id}.json`]:
    ygojsonValidationSealedProduct,
};

export const ygojsonValidationSetId = ygojsonValidationSet.id;
export const ygojsonValidationSealedProductId = ygojsonValidationSealedProduct.id;

// This inventory is closed: no caller can register a fetch implementation.
export const catalogFixtureTransports = Object.freeze({
  tcgdex: tcgdexProofFetch,
  mtgjson: mtgjsonValidationFetch,
  lorcanajson: lorcanajsonValidationFetch,
  lorcast: lorcastValidationFetch,
  scryfall: scryfallValidationFetch,
  ygoprodeck: ygoprodeckValidationFetch,
  ygojson: ygojsonValidationFetch,
});

const fixtureTransports = new Set<typeof fetch>(Object.values(catalogFixtureTransports));

export function isCatalogFixtureTransport(transport: typeof fetch): boolean {
  return transport !== globalThis.fetch && fixtureTransports.has(transport);
}

// Even a supplied fixture identity is an ordinary transport in a production adapter.
export function catalogProductionTransport(transport: typeof fetch): typeof fetch {
  return (...args) => transport(...args);
}
