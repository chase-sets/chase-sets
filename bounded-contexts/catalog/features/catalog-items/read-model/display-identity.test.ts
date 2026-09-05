import { describe, expect, it } from "vitest";
import { resolveAndPersistCatalogItemDisplayIdentity, resolveCatalogItemDisplayIdentity } from "./display-identity";

describe("resolveCatalogItemDisplayIdentity", () => {
  it("uses blueprint templates with field and reference attributes", async () => {
    const db = displayIdentityDb({
      fields: [
        { field_id: "fld_name", key: "card-name" },
        { field_id: "fld_number", key: "card-number" },
        { field_id: "fld_expansion", key: "expansion" },
        { field_id: "fld_rarity", key: "rarity" },
      ],
      references: [
        {
          reference_record_id: "ref_base",
          type_key: "expansion",
          key: "base-set",
          name: "Base Set",
          attributes: { "printed-card-count": 102 },
          relationships: [],
          status: "active",
        },
      ],
      templates: [
        {
          key: "pokemon-single-card-default",
          target_kind: "blueprint",
          target_id: "bpr_pokemon",
          priority: 10,
          title_template: "{field.card-name} {field.card-number}[/{reference.expansion.attributes.printed-card-count}]",
          subtitle_template: "{reference.expansion.name} [{field.card-variant} ]{field.rarity}",
          required_field_keys: ["card-name", "card-number", "expansion", "rarity"],
        },
      ],
    });

    await expect(
      resolveCatalogItemDisplayIdentity(db, {
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: null,
        blueprint_id: "bpr_pokemon",
        category_ids: [],
        field_values: [
          { fieldId: "fld_name", value: { defaultLocale: "en", values: { en: "Charizard" } } },
          { fieldId: "fld_number", value: "4" },
          { fieldId: "fld_expansion", value: { referenceId: "ref_base" } },
          { fieldId: "fld_rarity", value: "Rare Holo" },
        ],
      }),
    ).resolves.toMatchObject({
      title: "Charizard 4/102",
      subtitle: "Base Set Rare Holo",
      templateKey: "pokemon-single-card-default",
    });
  });

  it("omits the optional Pokemon denominator without leaving a trailing separator", async () => {
    const db = displayIdentityDb({
      fields: [
        { field_id: "fld_name", key: "card-name" },
        { field_id: "fld_number", key: "card-number" },
        { field_id: "fld_expansion", key: "expansion" },
        { field_id: "fld_rarity", key: "rarity" },
      ],
      references: [
        {
          reference_record_id: "ref_base",
          type_key: "expansion",
          key: "base-set",
          name: "Base Set",
          attributes: {},
          relationships: [],
          status: "active",
        },
      ],
      templates: [
        {
          key: "pokemon-single-card-default",
          target_kind: "blueprint",
          target_id: "bpr_pokemon",
          priority: 10,
          title_template: "{field.card-name} {field.card-number}[/{reference.expansion.attributes.printed-card-count}]",
          subtitle_template: "{reference.expansion.name} [{field.card-variant} ]{field.rarity}",
          required_field_keys: ["card-name", "card-number", "expansion", "rarity"],
        },
      ],
    });

    await expect(
      resolveCatalogItemDisplayIdentity(db, {
        catalog_item_id: "cat_bulbasaur",
        title: "Bulbasaur",
        subtitle: null,
        blueprint_id: "bpr_pokemon",
        category_ids: [],
        field_values: [
          { fieldId: "fld_name", value: "Bulbasaur" },
          { fieldId: "fld_number", value: "44" },
          { fieldId: "fld_expansion", value: { referenceId: "ref_base" } },
          { fieldId: "fld_rarity", value: "Common" },
        ],
      }),
    ).resolves.toMatchObject({
      title: "Bulbasaur 44",
      subtitle: "Base Set Common",
      templateKey: "pokemon-single-card-default",
      resolutionStatus: "resolved",
      missingTokens: [],
    });
  });

  it("removes empty-token edge separators while preserving meaningful internal punctuation", async () => {
    const db = displayIdentityDb({
      fields: [
        { field_id: "fld_name", key: "card-name" },
        { field_id: "fld_number", key: "card-number" },
        { field_id: "fld_expansion", key: "expansion" },
        { field_id: "fld_rarity", key: "rarity" },
      ],
      references: [
        {
          reference_record_id: "ref_promos",
          type_key: "expansion",
          key: "promos",
          name: "Promos",
          attributes: {},
          relationships: [],
          status: "active",
        },
      ],
      templates: [
        {
          key: "punctuation-card",
          target_kind: "global",
          target_id: null,
          priority: 1,
          title_template:
            "[{field.card-variant}: ]{field.card-name} {field.card-number}[/{reference.expansion.attributes.printed-card-count}]",
          subtitle_template: null,
          required_field_keys: ["card-name", "card-number", "expansion"],
        },
      ],
    });

    await expect(
      resolveCatalogItemDisplayIdentity(db, {
        catalog_item_id: "cat_punctuation",
        title: "Fallback",
        subtitle: null,
        blueprint_id: null,
        category_ids: [],
        field_values: [
          { fieldId: "fld_name", value: "Type: Null" },
          { fieldId: "fld_number", value: "No.006" },
          { fieldId: "fld_expansion", value: { referenceId: "ref_promos" } },
        ],
      }),
    ).resolves.toMatchObject({
      title: "Type: Null No.006",
      templateKey: "punctuation-card",
      resolutionStatus: "resolved",
    });
  });

  it.each([
    {
      templateKey: "magic-card-print-default",
      blueprintId: "bpr_magic",
      name: "Fury Sliver",
      number: "157",
      setName: "Time Spiral",
      variant: null,
      rarity: "Rare",
      expectedSubtitle: "Time Spiral Rare",
    },
    {
      templateKey: "one-piece-card-print-default",
      blueprintId: "bpr_one_piece",
      name: "Monkey.D.Luffy",
      number: "OP01-001",
      setName: "Romance Dawn",
      variant: "Standard Art",
      rarity: "Leader",
      expectedSubtitle: "Romance Dawn Standard Art Leader",
    },
  ])("renders the seeded $templateKey card template", async (testCase) => {
    const db = displayIdentityDb({
      fields: [
        { field_id: "fld_name", key: "card-name" },
        { field_id: "fld_number", key: "card-number" },
        { field_id: "fld_set", key: "set" },
        { field_id: "fld_variant", key: "card-variant" },
        { field_id: "fld_rarity", key: "rarity" },
      ],
      references: [
        {
          reference_record_id: "ref_set",
          type_key: "set",
          key: "set",
          name: testCase.setName,
          attributes: {},
          relationships: [],
          status: "active",
        },
      ],
      templates: [
        {
          key: testCase.templateKey,
          target_kind: "blueprint",
          target_id: testCase.blueprintId,
          priority: 10,
          title_template: "{field.card-name} {field.card-number}",
          subtitle_template: "{reference.set.name} [{field.card-variant} ]{field.rarity}",
          required_field_keys: ["card-name", "card-number", "rarity", "set"],
        },
      ],
    });
    const fieldValues: Array<{ fieldId: string; value: unknown }> = [
      { fieldId: "fld_name", value: testCase.name },
      { fieldId: "fld_number", value: testCase.number },
      { fieldId: "fld_set", value: { referenceId: "ref_set" } },
      { fieldId: "fld_rarity", value: testCase.rarity },
    ];
    if (testCase.variant) {
      fieldValues.push({ fieldId: "fld_variant", value: testCase.variant });
    }

    await expect(
      resolveCatalogItemDisplayIdentity(db, {
        catalog_item_id: `cat_${testCase.templateKey}`,
        title: testCase.name,
        subtitle: null,
        blueprint_id: testCase.blueprintId,
        category_ids: [],
        field_values: fieldValues,
      }),
    ).resolves.toMatchObject({
      title: `${testCase.name} ${testCase.number}`,
      subtitle: testCase.expectedSubtitle,
      templateKey: testCase.templateKey,
      resolutionStatus: "resolved",
    });
  });

  it("preserves strict degradation when a seeded card template is missing rarity", async () => {
    const db = displayIdentityDb({
      fields: [
        { field_id: "fld_name", key: "card-name" },
        { field_id: "fld_number", key: "card-number" },
        { field_id: "fld_set", key: "set" },
      ],
      references: [
        {
          reference_record_id: "ref_set",
          type_key: "set",
          key: "time-spiral",
          name: "Time Spiral",
          attributes: {},
          relationships: [],
          status: "active",
        },
      ],
      templates: [
        {
          key: "magic-card-print-default",
          target_kind: "blueprint",
          target_id: "bpr_magic",
          priority: 10,
          title_template: "{field.card-name} {field.card-number}",
          subtitle_template: "{reference.set.name} [{field.card-variant} ]{field.rarity}",
          required_field_keys: ["card-name", "card-number", "rarity", "set"],
        },
      ],
    });

    await expect(
      resolveCatalogItemDisplayIdentity(db, {
        catalog_item_id: "cat_missing_rarity",
        title: "Fury Sliver",
        subtitle: null,
        blueprint_id: "bpr_magic",
        category_ids: [],
        field_values: [
          { fieldId: "fld_name", value: "Fury Sliver" },
          { fieldId: "fld_number", value: "157" },
          { fieldId: "fld_set", value: { referenceId: "ref_set" } },
        ],
      }),
    ).resolves.toMatchObject({
      title: "Fury Sliver",
      templateKey: null,
      resolutionStatus: "degraded",
      missingTokens: ["rarity"],
    });
  });

  it("resolves Lorcana card display copy from set reference, variant, ink, and rarity fields", async () => {
    const db = displayIdentityDb({
      fields: [
        { field_id: "fld_name", key: "card-name" },
        { field_id: "fld_number", key: "card-number" },
        { field_id: "fld_set", key: "set" },
        { field_id: "fld_variant", key: "card-variant" },
        { field_id: "fld_ink", key: "ink-color" },
        { field_id: "fld_rarity", key: "rarity" },
      ],
      references: [
        {
          reference_record_id: "ref_tfc",
          type_key: "set",
          key: "the-first-chapter",
          name: "The First Chapter",
          attributes: { "set-code": "1", "chapter-number": 1 },
          relationships: [],
          status: "active",
        },
      ],
      templates: [
        {
          key: "lorcana-card-print-default",
          target_kind: "blueprint",
          target_id: "bpr_lorcana",
          priority: 10,
          title_template: "{field.card-name} {field.card-number}",
          subtitle_template: "{reference.set.name} [{field.card-variant} ]{field.ink-color} {field.rarity}",
          required_field_keys: ["card-name", "card-number", "ink-color", "rarity", "set"],
        },
      ],
    });

    await expect(
      resolveCatalogItemDisplayIdentity(db, {
        catalog_item_id: "cat_elsa",
        title: "Elsa - Snow Queen",
        subtitle: null,
        blueprint_id: "bpr_lorcana",
        category_ids: [],
        field_values: [
          { fieldId: "fld_name", value: { defaultLocale: "en", values: { en: "Elsa - Snow Queen" } } },
          { fieldId: "fld_number", value: "41/204" },
          { fieldId: "fld_set", value: { referenceId: "ref_tfc" } },
          { fieldId: "fld_variant", value: "Standard" },
          { fieldId: "fld_ink", value: "Amethyst" },
          { fieldId: "fld_rarity", value: "Super Rare" },
        ],
      }),
    ).resolves.toMatchObject({
      title: "Elsa - Snow Queen 41/204",
      subtitle: "The First Chapter Standard Amethyst Super Rare",
      templateKey: "lorcana-card-print-default",
    });
  });

  it("prefers reference-record templates over blueprint templates for promo exceptions", async () => {
    const db = displayIdentityDb({
      fields: [
        { field_id: "fld_name", key: "card-name" },
        { field_id: "fld_number", key: "card-number" },
        { field_id: "fld_expansion", key: "expansion" },
        { field_id: "fld_rarity", key: "rarity" },
      ],
      references: [
        {
          reference_record_id: "ref_promos",
          type_key: "expansion",
          key: "black-star-promos",
          name: "Black Star Promo",
          attributes: { "printed-card-count": null },
          relationships: [],
          status: "active",
        },
      ],
      templates: [
        {
          key: "pokemon-single-card-default",
          target_kind: "blueprint",
          target_id: "bpr_pokemon",
          priority: 10,
          title_template: "{field.card-name} {field.card-number}[/{reference.expansion.attributes.printed-card-count}]",
          subtitle_template: "{reference.expansion.name} [{field.card-variant} ]{field.rarity}",
          required_field_keys: ["card-name", "card-number", "expansion", "rarity"],
        },
        {
          key: "pokemon-promo-card",
          target_kind: "reference-record",
          target_id: "ref_promos",
          priority: 100,
          title_template: "{field.card-name} {field.card-number}",
          subtitle_template: "{reference.expansion.name} [{field.card-variant} ]{field.rarity}",
          required_field_keys: ["card-name", "card-number", "expansion", "rarity"],
        },
      ],
    });

    await expect(
      resolveCatalogItemDisplayIdentity(db, {
        catalog_item_id: "cat_mewtwo",
        title: "Mewtwo",
        subtitle: null,
        blueprint_id: "bpr_pokemon",
        category_ids: [],
        field_values: [
          { fieldId: "fld_name", value: { defaultLocale: "en", values: { en: "Mewtwo" } } },
          { fieldId: "fld_number", value: "3" },
          { fieldId: "fld_expansion", value: { referenceId: "ref_promos" } },
          { fieldId: "fld_rarity", value: "Promo" },
        ],
      }),
    ).resolves.toMatchObject({
      title: "Mewtwo 3",
      subtitle: "Black Star Promo Promo",
      templateKey: "pokemon-promo-card",
    });
  });

  it("creates stable hash metadata for the resolved identity", async () => {
    const db = displayIdentityDb({
      fields: [{ field_id: "fld_name", key: "card-name" }],
      references: [],
      templates: [
        {
          key: "global-card",
          target_kind: "global",
          target_id: null,
          priority: 1,
          title_template: "{field.card-name}",
          subtitle_template: null,
          required_field_keys: ["card-name"],
        },
      ],
    });
    const item = {
      catalog_item_id: "cat_hash",
      language_code: "EN",
      title: "Fallback",
      subtitle: null,
      blueprint_id: null,
      category_ids: [],
      field_values: [{ fieldId: "fld_name", value: "Hash Card" }],
    };

    const first = await resolveCatalogItemDisplayIdentity(db, item);
    const second = await resolveCatalogItemDisplayIdentity(db, item);

    expect(first).toMatchObject({
      catalogItemId: "cat_hash",
      languageCode: "en",
      title: "Hash Card",
      subtitle: null,
      templateKey: "global-card",
      templateTargetKind: "global",
      templateTargetId: null,
      resolverVersion: 3,
      resolutionStatus: "resolved",
      missingTokens: [],
    });
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.hash).toBe(first.hash);
  });

  it("changes the hash when raw identities change even if rendered text does not", async () => {
    const db = displayIdentityDb({
      fields: [
        { field_id: "fld_a", key: "card-name" },
        { field_id: "fld_b", key: "card-name" },
      ],
      references: [],
      templates: [
        {
          key: "global-card",
          target_kind: "global",
          target_id: null,
          priority: 1,
          title_template: "{item.title}",
          subtitle_template: null,
          required_field_keys: [],
        },
      ],
    });
    const base = {
      catalog_item_id: "cat_hash_identity",
      language_code: "en",
      title: "Same",
      subtitle: null,
      blueprint_id: "bpr_a",
      category_ids: ["ctg_a"],
      field_values: [{ fieldId: "fld_a", value: { referenceId: "ref_a", label: "Same" } }],
    };
    const variants = [
      base,
      { ...base, field_values: [{ fieldId: "fld_b", value: { referenceId: "ref_a", label: "Same" } }] },
      { ...base, field_values: [{ fieldId: "fld_a", value: { referenceId: "ref_b", label: "Same" } }] },
      { ...base, category_ids: ["ctg_b"] },
      { ...base, blueprint_id: "bpr_b" },
    ];
    const hashes = await Promise.all(
      variants.map(async (item) => (await resolveCatalogItemDisplayIdentity(db, item)).hash),
    );

    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("persists resolved identity and reports whether the hash changed", async () => {
    const persistedWrites: unknown[][] = [];
    const db = displayIdentityDb(
      {
        fields: [{ field_id: "fld_name", key: "card-name" }],
        references: [],
        templates: [
          {
            key: "global-card",
            target_kind: "global",
            target_id: null,
            priority: 1,
            title_template: "{field.card-name}",
            subtitle_template: null,
            required_field_keys: ["card-name"],
          },
        ],
      },
      { existingHash: "old-hash", persistedWrites },
    );

    const result = await resolveAndPersistCatalogItemDisplayIdentity(
      db,
      {
        catalog_item_id: "cat_persist",
        language_code: "en",
        title: "Fallback",
        subtitle: null,
        blueprint_id: null,
        category_ids: [],
        field_values: [{ fieldId: "fld_name", value: "Persisted Card" }],
      },
      "2026-06-06T22:00:00.000Z",
    );

    expect(result.changed).toBe(true);
    expect(result.identity.resolutionStatus).toBe("resolved");
    expect(persistedWrites).toHaveLength(1);
    expect(persistedWrites[0]).toEqual([
      "cat_persist",
      "en",
      "Persisted Card",
      null,
      "global-card",
      "global",
      null,
      result.identity.hash,
      3,
      "2026-06-06T22:00:00.000Z",
      "resolved",
      "[]",
    ]);
  });

  it("uses the guarded update RETURNING rows rather than optional rowCount", async () => {
    const data = {
      fields: [] as Array<{ field_id: string; key: string }>,
      references: [] as Array<never>,
      templates: [
        {
          key: "global-card",
          target_kind: "global",
          target_id: null,
          priority: 1,
          title_template: "{item.title}",
          subtitle_template: null,
          required_field_keys: [],
        },
      ],
    };
    const base = displayIdentityDb(data);
    const item = {
      catalog_item_id: "cat_guarded",
      language_code: "en",
      title_i18n: { defaultLocale: "en", values: { en: "Guarded" } },
      title: "Guarded",
      projected_title: "Guarded",
      subtitle_i18n: null,
      subtitle: null,
      projected_subtitle: null,
      blueprint_id: "bpr_card",
      category_ids: [],
      field_values: [],
    };
    const observedFact = {
      catalog_item_id: "cat_guarded",
      language_code: "en",
      title: "Old",
      subtitle: null,
      display_template_key: "global-card",
      display_template_target_kind: "global",
      display_template_target_id: null,
      display_identity_hash: "old-hash",
      resolver_version: 3,
      resolved_at: "2026-09-05T00:00:00.000Z",
      resolution_status: "resolved",
      missing_tokens: [],
    };
    const statements: string[] = [];
    const db = {
      async query<T>(sql: string, params?: readonly unknown[]) {
        statements.push(sql);
        if (sql.includes("UPDATE catalog_item_display_identities AS identity")) {
          return { rows: [{ catalog_item_id: "cat_guarded" }] as T[], rowCount: 0 };
        }
        return base.query<T>(sql, params);
      },
    };

    const won = await resolveAndPersistCatalogItemDisplayIdentity(db, item, "2026-09-05T00:01:00.000Z", {
      guardedBy: { item, fact: observedFact },
    });
    expect(won.persisted).toBe(true);
    expect(statements.find((sql) => sql.includes("UPDATE catalog_item_display_identities"))).toContain("RETURNING");

    const lostRaceDb = {
      async query<T>(sql: string, params?: readonly unknown[]) {
        if (sql.includes("UPDATE catalog_item_display_identities AS identity")) {
          return { rows: [] as T[], rowCount: 1 };
        }
        return base.query<T>(sql, params);
      },
    };
    const lost = await resolveAndPersistCatalogItemDisplayIdentity(lostRaceDb, item, "2026-09-05T00:02:00.000Z", {
      guardedBy: { item, fact: observedFact },
    });
    expect(lost.persisted).toBe(false);
  });

  it("degrades to the bare native title with the no-template sentinel when nothing matches", async () => {
    const db = displayIdentityDb({ fields: [], references: [], templates: [] });

    await expect(
      resolveCatalogItemDisplayIdentity(db, {
        catalog_item_id: "cat_no_template",
        title: "Bare Title",
        subtitle: " Bare Sub ",
        blueprint_id: null,
        category_ids: [],
        field_values: [],
      }),
    ).resolves.toMatchObject({
      title: "Bare Title",
      subtitle: "Bare Sub",
      templateKey: null,
      resolutionStatus: "degraded",
      missingTokens: ["template"],
    });
  });

  it("degrades and reports the unsatisfied required field key when a targeted template misses a field", async () => {
    const db = displayIdentityDb({
      fields: [
        { field_id: "fld_name", key: "card-name" },
        { field_id: "fld_number", key: "card-number" },
      ],
      references: [],
      templates: [
        {
          key: "pokemon-card",
          target_kind: "blueprint",
          target_id: "bpr_pokemon",
          priority: 10,
          title_template: "{field.card-name} {field.card-number}",
          subtitle_template: null,
          required_field_keys: ["card-name", "card-number"],
        },
      ],
    });

    await expect(
      resolveCatalogItemDisplayIdentity(db, {
        catalog_item_id: "cat_missing_field",
        title: "Charizard",
        subtitle: null,
        blueprint_id: "bpr_pokemon",
        category_ids: [],
        field_values: [{ fieldId: "fld_name", value: "Charizard" }],
      }),
    ).resolves.toMatchObject({
      title: "Charizard",
      templateKey: null,
      resolutionStatus: "degraded",
      missingTokens: ["card-number"],
    });
  });

  it("degrades and reports the empty non-optional token when a matched template renders one blank", async () => {
    const db = displayIdentityDb({
      fields: [
        { field_id: "fld_name", key: "card-name" },
        { field_id: "fld_number", key: "card-number" },
      ],
      references: [],
      templates: [
        {
          key: "global-card",
          target_kind: "global",
          target_id: null,
          priority: 1,
          // card-number is non-optional in the title but not a declared required key,
          // so the template is chosen yet the token renders blank.
          title_template: "{field.card-name} {field.card-number}",
          subtitle_template: null,
          required_field_keys: ["card-name"],
        },
      ],
    });

    await expect(
      resolveCatalogItemDisplayIdentity(db, {
        catalog_item_id: "cat_blank_token",
        title: "Charizard",
        subtitle: null,
        blueprint_id: null,
        category_ids: [],
        field_values: [{ fieldId: "fld_name", value: "Charizard" }],
      }),
    ).resolves.toMatchObject({
      title: "Charizard",
      templateKey: "global-card",
      resolutionStatus: "degraded",
      missingTokens: ["field.card-number"],
    });
  });

  it("stays resolved with no missing tokens when the subtitle is empty but the title is complete", async () => {
    const db = displayIdentityDb({
      fields: [{ field_id: "fld_name", key: "card-name" }],
      references: [],
      templates: [
        {
          key: "global-card",
          target_kind: "global",
          target_id: null,
          priority: 1,
          title_template: "{field.card-name}",
          subtitle_template: "{field.rarity}",
          required_field_keys: ["card-name"],
        },
      ],
    });

    await expect(
      resolveCatalogItemDisplayIdentity(db, {
        catalog_item_id: "cat_empty_subtitle",
        title: "Fallback",
        subtitle: null,
        blueprint_id: null,
        category_ids: [],
        field_values: [{ fieldId: "fld_name", value: "Pikachu" }],
      }),
    ).resolves.toMatchObject({
      title: "Pikachu",
      subtitle: null,
      templateKey: "global-card",
      resolutionStatus: "resolved",
      missingTokens: [],
    });
  });

  function japaneseCard() {
    return {
      catalog_item_id: "cat_sabonea",
      language_code: "en",
      title: "サボネア",
      subtitle: null,
      blueprint_id: null,
      category_ids: [],
      field_values: [
        { fieldId: "fld_name", value: "サボネア" },
        { fieldId: "fld_expansion", value: { referenceId: "ref_set" } },
      ],
    };
  }

  const japaneseCardData: Parameters<typeof displayIdentityDb>[0] = {
    fields: [
      { field_id: "fld_name", key: "card-name" },
      { field_id: "fld_expansion", key: "expansion" },
    ],
    references: [
      {
        reference_record_id: "ref_set",
        type_key: "expansion",
        key: "triplet-beat",
        name: "トリプレットビート",
        attributes: {},
        relationships: [],
        status: "active",
      },
    ],
    templates: [
      {
        key: "global-card",
        target_kind: "global",
        target_id: null,
        priority: 1,
        title_template: "{field.card-name}",
        subtitle_template: "{reference.expansion.name}",
        required_field_keys: ["card-name"],
      },
    ],
  };

  it("English-locale display shows the accepted English name with the native name as secondary", async () => {
    const db = displayIdentityDb({
      ...japaneseCardData,
      itemAliases: [englishAlias()],
    });

    await expect(resolveCatalogItemDisplayIdentity(db, japaneseCard())).resolves.toMatchObject({
      languageCode: "en",
      title: "Cacnea (サボネア)",
    });
  });

  it("applies the same locale/confidence policy to Reference Record (set/series) display", async () => {
    const db = displayIdentityDb({
      ...japaneseCardData,
      itemAliases: [englishAlias()],
      referenceAliasesById: {
        ref_set: [
          englishAlias({
            alias_text: "Triplet Beat",
            normalized_alias_text: "triplet beat",
            alias_type: "set-equivalent",
            confidence: "exact",
          }),
        ],
      },
    });

    await expect(resolveCatalogItemDisplayIdentity(db, japaneseCard())).resolves.toMatchObject({
      title: "Cacnea (サボネア)",
      subtitle: "Triplet Beat (トリプレットビート)",
    });
  });

  it("never promotes a generated or species alias to the primary display name", async () => {
    const db = displayIdentityDb({
      ...japaneseCardData,
      itemAliases: [
        englishAlias({ alias_text: "Cactus", alias_type: "species-name", confidence: "exact" }),
        englishAlias({ alias_text: "Cacnea (gen)", alias_type: "generated-translation", confidence: "exact" }),
      ],
    });

    // Neither qualifies, so the native provider name stays the primary display.
    await expect(resolveCatalogItemDisplayIdentity(db, japaneseCard())).resolves.toMatchObject({
      title: "サボネア",
    });
  });

  it("leaves native-locale display unchanged (no English alias applied)", async () => {
    const db = displayIdentityDb({
      ...japaneseCardData,
      itemAliases: [englishAlias()],
    });

    // A non-English resolved locale must not surface the English alias.
    await expect(
      resolveCatalogItemDisplayIdentity(db, { ...japaneseCard(), language_code: "ja" }),
    ).resolves.toMatchObject({
      languageCode: "ja",
      title: "サボネア",
    });
  });

  it("republishes only when the display-relevant alias changes (idempotent)", async () => {
    const withAlias = displayIdentityDb({ ...japaneseCardData, itemAliases: [englishAlias()] });
    const sameAliasAgain = displayIdentityDb({ ...japaneseCardData, itemAliases: [englishAlias()] });
    const differentAlias = displayIdentityDb({
      ...japaneseCardData,
      itemAliases: [englishAlias({ alias_text: "Cactus Pokemon", normalized_alias_text: "cactus pokemon" })],
    });
    const nonDisplayAliasAdded = displayIdentityDb({
      ...japaneseCardData,
      itemAliases: [
        englishAlias(),
        englishAlias({ alias_text: "cacnea", alias_type: "species-name", confidence: "candidate" }),
      ],
    });

    const base = await resolveCatalogItemDisplayIdentity(withAlias, japaneseCard());
    const stable = await resolveCatalogItemDisplayIdentity(sameAliasAgain, japaneseCard());
    const changed = await resolveCatalogItemDisplayIdentity(differentAlias, japaneseCard());
    const unaffected = await resolveCatalogItemDisplayIdentity(nonDisplayAliasAdded, japaneseCard());

    // Re-resolving the same display-relevant evidence is stable.
    expect(stable.hash).toBe(base.hash);
    // Changing the chosen display alias changes the hash.
    expect(changed.hash).not.toBe(base.hash);
    // Adding a non-display alias (species/low-confidence) does not change display.
    expect(unaffected.hash).toBe(base.hash);
  });
});

type AliasRow = {
  alias_text: string;
  normalized_alias_text: string;
  alias_language_code: string;
  alias_type: string;
  confidence: string;
};

function displayIdentityDb(
  data: {
    fields: Array<{ field_id: string; key: string }>;
    references: Array<{
      reference_record_id: string;
      type_key: string;
      key: string;
      name: string;
      attributes: Record<string, unknown>;
      relationships: unknown[];
      status: string;
    }>;
    templates: Array<{
      key: string;
      target_kind: string;
      target_id: string | null;
      priority: number;
      title_template: string;
      subtitle_template: string | null;
      required_field_keys: unknown;
    }>;
    itemAliases?: AliasRow[];
    referenceAliasesById?: Record<string, AliasRow[]>;
  },
  options: { existingHash?: string; persistedWrites?: unknown[][] } = {},
) {
  return {
    async query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes("FROM catalog_item_display_identities")) {
        return {
          rows: options.existingHash ? ([{ display_identity_hash: options.existingHash }] as T[]) : [],
        };
      }

      if (sql.includes("INSERT INTO catalog_item_display_identities")) {
        options.persistedWrites?.push([...(params ?? [])]);
        return { rows: [] };
      }

      if (sql.includes("FROM catalog_fields")) {
        const ids = Array.isArray(params?.[0]) ? params[0] : [];
        return { rows: data.fields.filter((field) => ids.includes(field.field_id)) as T[] };
      }

      if (sql.includes("FROM catalog_display_templates")) {
        return { rows: data.templates as T[] };
      }

      if (sql.includes("FROM catalog_item_aliases")) {
        return { rows: (data.itemAliases ?? []) as T[] };
      }

      if (sql.includes("FROM catalog_reference_record_aliases")) {
        const referenceRecordId = String(params?.[0] ?? "");
        return { rows: ((data.referenceAliasesById ?? {})[referenceRecordId] ?? []) as T[] };
      }

      if (sql.includes("FROM catalog_reference_records")) {
        const ids = Array.isArray(params?.[0]) ? params[0] : [];
        return { rows: data.references.filter((reference) => ids.includes(reference.reference_record_id)) as T[] };
      }

      return { rows: [] };
    },
  };
}

function englishAlias(overrides: Partial<AliasRow> = {}): AliasRow {
  return {
    alias_text: "Cacnea",
    normalized_alias_text: "cacnea",
    alias_language_code: "en",
    alias_type: "official-equivalent",
    confidence: "high",
    ...overrides,
  };
}
