import { loadConfig } from "./config";
import { createPool } from "./infrastructure/postgres";
import {
  createCatalogServices,
  type CatalogServices,
} from "./infrastructure/wiring";
import { createId } from "../../../contracts/primitives/typed-ids";
import type {
  TenantId,
  UserId,
  AccountId,
} from "../../../contracts/primitives/typed-ids";
import type { EventStoreContext } from "../../../contracts/event-core/storage";
import type {
  DimensionId,
  ChoiceId,
  FieldId,
  ComponentId,
  BlueprintId,
  CategoryId,
  CatalogItemId,
} from "../../../bounded-contexts/catalog/ids";

const seedContext: EventStoreContext = {
  tenantId: createId("tnt") as TenantId,
  audit: {
    performedByUserId: createId("usr") as UserId,
    forAccountId: createId("acc") as AccountId,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DimensionChoiceDef = {
  code: string;
  label: string;
  numericValue?: number;
};

type DimensionDef = {
  key: string;
  name: string;
  description: string;
  choices: DimensionChoiceDef[];
};

type FieldDef = {
  key: string;
  name: string;
  description: string;
  valueType: "string" | "number" | "boolean" | "date" | "json";
  behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
};

async function sendCommand(
  handler: (input: {
    streamId: string;
    command: unknown;
    context: EventStoreContext;
  }) => Promise<unknown>,
  streamId: string,
  command: unknown,
) {
  return handler({ streamId, command, context: seedContext });
}

// ---------------------------------------------------------------------------
// Phase 1: Dimensions
// ---------------------------------------------------------------------------

const dimensionDefs: DimensionDef[] = [
  {
    key: "condition",
    name: "Condition",
    description: "Physical condition of a raw (ungraded) card",
    choices: [
      { code: "mint", label: "Mint" },
      { code: "near-mint", label: "Near Mint" },
      { code: "lightly-played", label: "Lightly Played" },
      { code: "moderately-played", label: "Moderately Played" },
      { code: "heavily-played", label: "Heavily Played" },
      { code: "damaged", label: "Damaged" },
    ],
  },
  {
    key: "grading-company",
    name: "Grading Company",
    description:
      "Professional grading service that authenticated and graded the card",
    choices: [
      { code: "psa", label: "PSA" },
      { code: "bgs", label: "BGS/Beckett" },
      { code: "cgc", label: "CGC" },
      { code: "sgc", label: "SGC" },
      { code: "ace", label: "ACE" },
      { code: "tag", label: "TAG" },
    ],
  },
  {
    key: "grade",
    name: "Grade",
    description: "Numeric grade assigned by a professional grading company",
    choices: [
      { code: "pristine-10", label: "Pristine 10", numericValue: 10.5 },
      { code: "gem-mint-10", label: "Gem Mint 10", numericValue: 10 },
      { code: "mint-9.5", label: "Mint 9.5", numericValue: 9.5 },
      { code: "mint-9", label: "Mint 9", numericValue: 9 },
      { code: "nm-mt-8.5", label: "NM-MT 8.5", numericValue: 8.5 },
      { code: "nm-mt-8", label: "NM-MT 8", numericValue: 8 },
      { code: "nm-7", label: "NM 7", numericValue: 7 },
      { code: "ex-6", label: "EX 6", numericValue: 6 },
      { code: "ex-5", label: "EX 5", numericValue: 5 },
      { code: "vg-4", label: "VG 4", numericValue: 4 },
      { code: "good-3", label: "Good 3", numericValue: 3 },
      { code: "good-2", label: "Good 2", numericValue: 2 },
      { code: "poor-1", label: "Poor 1", numericValue: 1 },
    ],
  },
  {
    key: "pokemon-set",
    name: "Pokemon Set",
    description: "The expansion set the card belongs to",
    choices: [
      { code: "base-set", label: "Base Set" },
      { code: "jungle", label: "Jungle" },
      { code: "fossil", label: "Fossil" },
      { code: "team-rocket", label: "Team Rocket" },
      { code: "gym-heroes", label: "Gym Heroes" },
      { code: "gym-challenge", label: "Gym Challenge" },
      { code: "neo-genesis", label: "Neo Genesis" },
      { code: "neo-discovery", label: "Neo Discovery" },
      { code: "neo-revelation", label: "Neo Revelation" },
      { code: "neo-destiny", label: "Neo Destiny" },
      { code: "legendary-collection", label: "Legendary Collection" },
      { code: "expedition", label: "Expedition" },
      { code: "aquapolis", label: "Aquapolis" },
      { code: "skyridge", label: "Skyridge" },
      { code: "scarlet-violet", label: "Scarlet & Violet" },
      { code: "paldea-evolved", label: "Paldea Evolved" },
      { code: "obsidian-flames", label: "Obsidian Flames" },
      { code: "pokemon-151", label: "151" },
      { code: "paradox-rift", label: "Paradox Rift" },
      { code: "temporal-forces", label: "Temporal Forces" },
      { code: "twilight-masquerade", label: "Twilight Masquerade" },
      { code: "shrouded-fable", label: "Shrouded Fable" },
      { code: "stellar-crown", label: "Stellar Crown" },
      { code: "surging-sparks", label: "Surging Sparks" },
      { code: "prismatic-evolutions", label: "Prismatic Evolutions" },
    ],
  },
  {
    key: "rarity",
    name: "Rarity",
    description: "Card rarity classification",
    choices: [
      { code: "common", label: "Common" },
      { code: "uncommon", label: "Uncommon" },
      { code: "rare", label: "Rare" },
      { code: "holo-rare", label: "Holo Rare" },
      { code: "reverse-holo", label: "Reverse Holo" },
      { code: "ultra-rare", label: "Ultra Rare" },
      { code: "secret-rare", label: "Secret Rare" },
      { code: "illustration-rare", label: "Illustration Rare" },
      { code: "special-illustration-rare", label: "Special Illustration Rare" },
      { code: "hyper-rare", label: "Hyper Rare" },
      { code: "gold-star", label: "Gold Star" },
      { code: "first-edition", label: "1st Edition" },
    ],
  },
  {
    key: "language",
    name: "Language",
    description: "The language the card is printed in",
    choices: [
      { code: "en", label: "English" },
      { code: "ja", label: "Japanese" },
      { code: "ko", label: "Korean" },
      { code: "zh", label: "Chinese" },
      { code: "fr", label: "French" },
      { code: "de", label: "German" },
      { code: "es", label: "Spanish" },
      { code: "it", label: "Italian" },
      { code: "pt", label: "Portuguese" },
    ],
  },
];

type DimensionIds = Record<
  string,
  { dimensionId: DimensionId; choiceIds: Record<string, ChoiceId> }
>;

async function seedDimensions(
  services: CatalogServices,
): Promise<DimensionIds> {
  console.log("Seeding dimensions...");
  const result: DimensionIds = {};

  for (const def of dimensionDefs) {
    const dimensionId = createId("dim") as DimensionId;
    const streamId = `catalog.dimension-${dimensionId}`;
    const choiceIds: Record<string, ChoiceId> = {};

    await sendCommand(services.dimensionHandler, streamId, {
      type: "CreateDimension",
      dimensionId,
      key: def.key,
      name: def.name,
      description: def.description,
    });

    for (const choice of def.choices) {
      const choiceId = createId("chc") as ChoiceId;
      choiceIds[choice.code] = choiceId;

      await sendCommand(services.dimensionHandler, streamId, {
        type: "AddChoice",
        choiceId,
        code: choice.code,
        labels: [{ locale: "en", value: choice.label }],
        numericValue: choice.numericValue ?? null,
      });
    }

    await sendCommand(services.dimensionHandler, streamId, {
      type: "ActivateDimension",
    });

    result[def.key] = { dimensionId, choiceIds };
    console.log(
      `  Dimension "${def.name}" created with ${def.choices.length} choices`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 2: Fields
// ---------------------------------------------------------------------------

const fieldDefs: FieldDef[] = [
  {
    key: "card-number",
    name: "Card Number",
    description: "The card number within its set (e.g., 4/102)",
    valueType: "string",
    behavior: { filterable: true, searchable: false, sortable: true },
  },
  {
    key: "card-name",
    name: "Card Name",
    description: "The name of the Pokemon or card",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "artist",
    name: "Artist",
    description: "The illustrator of the card",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "year-printed",
    name: "Year Printed",
    description: "The year the card was printed",
    valueType: "number",
    behavior: { filterable: true, searchable: false, sortable: true },
  },
  {
    key: "cert-number",
    name: "Certification Number",
    description: "The grading company certification number",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: false },
  },
  {
    key: "pop-count",
    name: "Population Count",
    description: "Number of cards graded at this level by the grading company",
    valueType: "number",
    behavior: { filterable: true, searchable: false, sortable: true },
  },
];

type FieldIds = Record<string, FieldId>;

async function seedFields(services: CatalogServices): Promise<FieldIds> {
  console.log("Seeding fields...");
  const result: FieldIds = {};

  for (const def of fieldDefs) {
    const fieldId = createId("fld") as FieldId;
    const streamId = `catalog.field-${fieldId}`;

    await sendCommand(services.fieldHandler, streamId, {
      type: "CreateField",
      fieldId,
      key: def.key,
      name: def.name,
      description: def.description,
      valueType: def.valueType,
      behavior: def.behavior,
    });

    await sendCommand(services.fieldHandler, streamId, {
      type: "ActivateField",
    });

    result[def.key] = fieldId;
    console.log(`  Field "${def.name}" created`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 3: Components
// ---------------------------------------------------------------------------

type ComponentIds = Record<string, ComponentId>;

async function seedComponents(
  services: CatalogServices,
  dimensions: DimensionIds,
  fields: FieldIds,
): Promise<ComponentIds> {
  console.log("Seeding components...");
  const result: ComponentIds = {};

  // Base Card Info
  {
    const componentId = createId("cmp") as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    await sendCommand(services.componentHandler, streamId, {
      type: "CreateComponent",
      componentId,
      key: "base-card-info",
      name: "Base Card Info",
      description: "Core card identification fields and dimensions",
    });

    for (const [fieldKey, required] of [
      ["card-number", true],
      ["card-name", true],
      ["artist", false],
      ["year-printed", false],
    ] as const) {
      await sendCommand(services.componentHandler, streamId, {
        type: "AddFieldRuleToComponent",
        fieldId: fields[fieldKey],
        required,
      });
    }

    for (const dimKey of ["pokemon-set", "rarity", "language"] as const) {
      const dim = dimensions[dimKey];
      await sendCommand(services.componentHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: dim.dimensionId,
        required: true,
        allowedChoiceIds: Object.values(dim.choiceIds),
      });
    }

    await sendCommand(services.componentHandler, streamId, {
      type: "ActivateComponent",
    });

    result["base-card-info"] = componentId;
    console.log('  Component "Base Card Info" created');
  }

  // Card Condition
  {
    const componentId = createId("cmp") as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    await sendCommand(services.componentHandler, streamId, {
      type: "CreateComponent",
      componentId,
      key: "card-condition",
      name: "Card Condition",
      description: "Physical condition assessment for raw cards",
    });

    const dim = dimensions["condition"];
    await sendCommand(services.componentHandler, streamId, {
      type: "AddDimensionRuleToComponent",
      dimensionId: dim.dimensionId,
      required: true,
      allowedChoiceIds: Object.values(dim.choiceIds),
    });

    await sendCommand(services.componentHandler, streamId, {
      type: "ActivateComponent",
    });

    result["card-condition"] = componentId;
    console.log('  Component "Card Condition" created');
  }

  // Card Grading
  {
    const componentId = createId("cmp") as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    await sendCommand(services.componentHandler, streamId, {
      type: "CreateComponent",
      componentId,
      key: "card-grading",
      name: "Card Grading",
      description: "Professional grading information for graded cards",
    });

    for (const [fieldKey, required] of [
      ["cert-number", false],
      ["pop-count", false],
    ] as const) {
      await sendCommand(services.componentHandler, streamId, {
        type: "AddFieldRuleToComponent",
        fieldId: fields[fieldKey],
        required,
      });
    }

    for (const dimKey of ["grading-company", "grade"] as const) {
      const dim = dimensions[dimKey];
      await sendCommand(services.componentHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: dim.dimensionId,
        required: true,
        allowedChoiceIds: Object.values(dim.choiceIds),
      });
    }

    await sendCommand(services.componentHandler, streamId, {
      type: "ActivateComponent",
    });

    result["card-grading"] = componentId;
    console.log('  Component "Card Grading" created');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 4: Blueprints
// ---------------------------------------------------------------------------

type BlueprintIds = Record<string, BlueprintId>;

async function seedBlueprints(
  services: CatalogServices,
  components: ComponentIds,
  dimensions: DimensionIds,
  fields: FieldIds,
): Promise<BlueprintIds> {
  console.log("Seeding blueprints...");
  const result: BlueprintIds = {};

  // Raw Pokemon Card
  {
    const blueprintId = createId("bpr") as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;

    await sendCommand(services.blueprintHandler, streamId, {
      type: "CreateBlueprint",
      blueprintId,
      key: "raw-pokemon-card",
      name: "Raw Pokemon Card",
      description:
        "Template for ungraded Pokemon trading cards assessed by condition",
    });

    for (const compKey of ["base-card-info", "card-condition"] as const) {
      await sendCommand(services.blueprintHandler, streamId, {
        type: "AttachComponentToBlueprint",
        componentId: components[compKey],
      });
    }

    await sendCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintFields",
      fieldRules: [
        { fieldId: fields["card-number"], required: true },
        { fieldId: fields["card-name"], required: true },
        { fieldId: fields["artist"], required: false },
        { fieldId: fields["year-printed"], required: false },
      ],
    });

    const rawDimKeys = [
      "pokemon-set",
      "rarity",
      "language",
      "condition",
    ] as const;

    await sendCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintDimensions",
      dimensionRules: rawDimKeys.map((dimKey) => {
        const dim = dimensions[dimKey];
        return {
          dimensionId: dim.dimensionId,
          required: true,
          allowedChoiceIds: Object.values(dim.choiceIds),
        };
      }),
    });

    await sendCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintVersionRules",
      canonicalDimensionOrder: rawDimKeys.map((k) => dimensions[k].dimensionId),
    });

    await sendCommand(services.blueprintHandler, streamId, {
      type: "PublishBlueprint",
    });

    result["raw-pokemon-card"] = blueprintId;
    console.log('  Blueprint "Raw Pokemon Card" created and published');
  }

  // Graded Pokemon Card
  {
    const blueprintId = createId("bpr") as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;

    await sendCommand(services.blueprintHandler, streamId, {
      type: "CreateBlueprint",
      blueprintId,
      key: "graded-pokemon-card",
      name: "Graded Pokemon Card",
      description: "Template for professionally graded Pokemon trading cards",
    });

    for (const compKey of ["base-card-info", "card-grading"] as const) {
      await sendCommand(services.blueprintHandler, streamId, {
        type: "AttachComponentToBlueprint",
        componentId: components[compKey],
      });
    }

    await sendCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintFields",
      fieldRules: [
        { fieldId: fields["card-number"], required: true },
        { fieldId: fields["card-name"], required: true },
        { fieldId: fields["artist"], required: false },
        { fieldId: fields["year-printed"], required: false },
        { fieldId: fields["cert-number"], required: false },
        { fieldId: fields["pop-count"], required: false },
      ],
    });

    const gradedDimKeys = [
      "pokemon-set",
      "rarity",
      "language",
      "grading-company",
      "grade",
    ] as const;

    await sendCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintDimensions",
      dimensionRules: gradedDimKeys.map((dimKey) => {
        const dim = dimensions[dimKey];
        return {
          dimensionId: dim.dimensionId,
          required: true,
          allowedChoiceIds: Object.values(dim.choiceIds),
        };
      }),
    });

    await sendCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintVersionRules",
      canonicalDimensionOrder: gradedDimKeys.map(
        (k) => dimensions[k].dimensionId,
      ),
    });

    await sendCommand(services.blueprintHandler, streamId, {
      type: "PublishBlueprint",
    });

    result["graded-pokemon-card"] = blueprintId;
    console.log('  Blueprint "Graded Pokemon Card" created and published');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 5: Categories
// ---------------------------------------------------------------------------

type CategoryIds = Record<string, CategoryId>;

async function seedCategories(services: CatalogServices): Promise<CategoryIds> {
  console.log("Seeding categories...");
  const result: CategoryIds = {};

  async function createCategory(
    key: string,
    name: string,
    description: string,
    parentKey?: string,
    displayOrder?: number,
  ): Promise<void> {
    const categoryId = createId("ctg") as CategoryId;
    const streamId = `catalog.category-${categoryId}`;

    await sendCommand(services.categoryHandler, streamId, {
      type: "CreateCategory",
      categoryId,
      key,
      name,
      description,
      parentCategoryId: parentKey ? result[parentKey] : undefined,
      displayOrder: displayOrder ?? 0,
    });

    await sendCommand(services.categoryHandler, streamId, {
      type: "PublishCategory",
    });

    result[key] = categoryId;
  }

  // Root
  await createCategory(
    "pokemon-tcg",
    "Pokemon TCG",
    "Pokemon Trading Card Game",
  );

  // By Generation
  await createCategory(
    "by-generation",
    "By Generation",
    "Cards organized by Pokemon generation",
    "pokemon-tcg",
    0,
  );
  const generations = [
    ["gen-1", "Generation I"],
    ["gen-2", "Generation II"],
    ["gen-3", "Generation III"],
    ["gen-4", "Generation IV"],
    ["gen-5", "Generation V"],
    ["gen-6", "Generation VI"],
    ["gen-7", "Generation VII"],
    ["gen-8", "Generation VIII"],
    ["gen-9", "Generation IX"],
  ] as const;
  for (let i = 0; i < generations.length; i++) {
    await createCategory(
      generations[i][0],
      generations[i][1],
      `${generations[i][1]} Pokemon cards`,
      "by-generation",
      i,
    );
  }

  // By Type
  await createCategory(
    "by-type",
    "By Type",
    "Cards organized by Pokemon type",
    "pokemon-tcg",
    1,
  );
  const types = [
    "Fire",
    "Water",
    "Grass",
    "Electric",
    "Psychic",
    "Fighting",
    "Dark",
    "Metal",
    "Dragon",
    "Fairy",
    "Normal",
    "Colorless",
  ] as const;
  for (let i = 0; i < types.length; i++) {
    const key = types[i].toLowerCase();
    await createCategory(
      key,
      types[i],
      `${types[i]} type Pokemon cards`,
      "by-type",
      i,
    );
  }

  // Trainer & Energy
  await createCategory(
    "trainer-cards",
    "Trainer Cards",
    "Trainer, Supporter, and Stadium cards",
    "pokemon-tcg",
    2,
  );
  await createCategory(
    "energy-cards",
    "Energy Cards",
    "Basic and Special Energy cards",
    "pokemon-tcg",
    3,
  );

  console.log(`  ${Object.keys(result).length} categories created`);
  return result;
}

// ---------------------------------------------------------------------------
// Phase 6: Catalog Items
// ---------------------------------------------------------------------------

async function seedCatalogItems(
  services: CatalogServices,
  blueprints: BlueprintIds,
  fields: FieldIds,
  categories: CategoryIds,
): Promise<void> {
  console.log("Seeding catalog items...");

  const requiredFieldIds = [fields["card-number"], fields["card-name"]];

  type ItemDef = {
    title: string;
    subtitle: string;
    description: string;
    blueprintKey: string;
    fieldValues: [string, string | number][];
    categoryKeys: string[];
    tags: string[];
  };

  const items: ItemDef[] = [
    {
      title: "Charizard - Base Set 4/102",
      subtitle: "Holo Rare - Near Mint",
      description:
        "The iconic Base Set Charizard, one of the most sought-after Pokemon cards ever printed. Features the Fire Spin attack and stunning holographic artwork by Mitsuhiro Arita.",
      blueprintKey: "raw-pokemon-card",
      fieldValues: [
        ["card-number", "4/102"],
        ["card-name", "Charizard"],
        ["artist", "Mitsuhiro Arita"],
        ["year-printed", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "gen-1", "fire"],
      tags: ["charizard", "base-set", "holo", "vintage"],
    },
    {
      title: "Charizard - Base Set 4/102 PSA 10",
      subtitle: "Gem Mint - PSA Graded",
      description:
        "A PSA Gem Mint 10 graded Base Set Charizard. The highest grade achievable, representing perfect centering, corners, edges, and surface.",
      blueprintKey: "graded-pokemon-card",
      fieldValues: [
        ["card-number", "4/102"],
        ["card-name", "Charizard"],
        ["artist", "Mitsuhiro Arita"],
        ["year-printed", 1999],
        ["cert-number", "10234567"],
        ["pop-count", 122],
      ],
      categoryKeys: ["pokemon-tcg", "gen-1", "fire"],
      tags: ["charizard", "base-set", "psa-10", "graded", "vintage"],
    },
    {
      title: "Pikachu - Jungle 60/64",
      subtitle: "Common - Near Mint",
      description:
        "A charming Pikachu from the Jungle expansion set, featuring artwork by Kagemaru Himeno. A classic collectible from the early days of the Pokemon TCG.",
      blueprintKey: "raw-pokemon-card",
      fieldValues: [
        ["card-number", "60/64"],
        ["card-name", "Pikachu"],
        ["artist", "Kagemaru Himeno"],
        ["year-printed", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "gen-1", "electric"],
      tags: ["pikachu", "jungle", "vintage"],
    },
    {
      title: "Lugia - Neo Genesis 9/111 BGS 9.5",
      subtitle: "Gem Mint - BGS Graded",
      description:
        "A BGS 9.5 Gem Mint graded Lugia from Neo Genesis. One of the most valuable Generation II era cards, featuring Hironobu Yoshida's legendary artwork.",
      blueprintKey: "graded-pokemon-card",
      fieldValues: [
        ["card-number", "9/111"],
        ["card-name", "Lugia"],
        ["artist", "Hironobu Yoshida"],
        ["year-printed", 2000],
        ["cert-number", "BGS87654321"],
        ["pop-count", 45],
      ],
      categoryKeys: ["pokemon-tcg", "gen-2", "psychic"],
      tags: ["lugia", "neo-genesis", "graded", "vintage"],
    },
    {
      title: "Pikachu - Prismatic Evolutions 025",
      subtitle: "Illustration Rare - Near Mint",
      description:
        "A stunning Illustration Rare Pikachu from the modern Prismatic Evolutions set, showcasing Ryuta Fuse's vibrant artwork in the latest Scarlet & Violet era.",
      blueprintKey: "raw-pokemon-card",
      fieldValues: [
        ["card-number", "025"],
        ["card-name", "Pikachu"],
        ["artist", "Ryuta Fuse"],
        ["year-printed", 2025],
      ],
      categoryKeys: ["pokemon-tcg", "gen-9", "electric"],
      tags: ["pikachu", "prismatic-evolutions", "modern"],
    },
  ];

  for (const item of items) {
    const itemId = createId("cat") as CatalogItemId;
    const streamId = `catalog.item-${itemId}`;

    await sendCommand(services.catalogItemHandler, streamId, {
      type: "CreateItem",
      itemId,
      title: item.title,
      subtitle: item.subtitle,
      description: item.description,
    });

    await sendCommand(services.catalogItemHandler, streamId, {
      type: "AssignBlueprintToItem",
      blueprintId: blueprints[item.blueprintKey],
    });

    for (const [fieldKey, value] of item.fieldValues) {
      await sendCommand(services.catalogItemHandler, streamId, {
        type: "SetItemFieldValue",
        fieldId: fields[fieldKey],
        value,
      });
    }

    for (const catKey of item.categoryKeys) {
      await sendCommand(services.catalogItemHandler, streamId, {
        type: "AssignItemToCategory",
        categoryId: categories[catKey],
      });
    }

    await sendCommand(services.catalogItemHandler, streamId, {
      type: "SetItemTags",
      tags: item.tags,
    });

    await sendCommand(services.catalogItemHandler, streamId, {
      type: "PublishItem",
      blueprintIsActive: true,
      requiredFieldIds,
    });

    console.log(`  Item "${item.title}" created and published`);
  }
}

// ---------------------------------------------------------------------------
// Phase 7: Drain Projectors
// ---------------------------------------------------------------------------

async function drainProjectors(services: CatalogServices): Promise<void> {
  console.log("Running projectors...");
  let totalProcessed: number;
  do {
    totalProcessed = 0;
    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      totalProcessed += result.processed;
    }
  } while (totalProcessed > 0);
  console.log("All projections up to date.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const services = createCatalogServices(pool);

  try {
    const existing = await services.db.query(
      "SELECT COUNT(*) FROM catalog_dimensions",
    );
    if (Number(existing.rows[0].count) > 0) {
      console.log("Catalog already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet — proceed with seeding
  }

  console.log("Starting Pokemon TCG seed...\n");

  const [dimensions, fields] = await Promise.all([
    seedDimensions(services),
    seedFields(services),
  ]);

  const components = await seedComponents(services, dimensions, fields);
  const blueprints = await seedBlueprints(
    services,
    components,
    dimensions,
    fields,
  );
  const categories = await seedCategories(services);
  await seedCatalogItems(services, blueprints, fields, categories);
  await drainProjectors(services);

  console.log("\nSeed complete!");
  await (pool as unknown as { end: () => Promise<void> }).end();
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
