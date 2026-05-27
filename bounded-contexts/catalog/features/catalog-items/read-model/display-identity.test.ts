import { describe, expect, it } from "vitest";
import { resolveCatalogItemDisplayIdentity } from "./display-identity";

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
          key: "pokemon-card",
          target_kind: "blueprint",
          target_id: "bpr_pokemon",
          priority: 10,
          title_template: "{field.card-name} {field.card-number}/{reference.expansion.attributes.printed-card-count}",
          subtitle_template: "{reference.expansion.name} {field.rarity}",
          required_field_keys: ["card-name", "card-number", "expansion"],
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
      templateKey: "pokemon-card",
    });
  });

  it("prefers reference-record templates over blueprint templates for promo exceptions", async () => {
    const db = displayIdentityDb({
      fields: [
        { field_id: "fld_name", key: "card-name" },
        { field_id: "fld_number", key: "card-number" },
        { field_id: "fld_expansion", key: "expansion" },
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
          key: "pokemon-card",
          target_kind: "blueprint",
          target_id: "bpr_pokemon",
          priority: 10,
          title_template: "{field.card-name} {field.card-number}/{reference.expansion.attributes.printed-card-count}",
          subtitle_template: "{reference.expansion.name}",
          required_field_keys: ["card-name", "card-number", "expansion"],
        },
        {
          key: "pokemon-promo",
          target_kind: "reference-record",
          target_id: "ref_promos",
          priority: 100,
          title_template: "{field.card-name} {field.card-number}",
          subtitle_template: "{reference.expansion.name}",
          required_field_keys: ["card-name", "card-number", "expansion"],
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
        ],
      }),
    ).resolves.toMatchObject({
      title: "Mewtwo 3",
      subtitle: "Black Star Promo",
      templateKey: "pokemon-promo",
    });
  });
});

function displayIdentityDb(data: {
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
}) {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes("FROM catalog_fields")) {
        const ids = Array.isArray(params?.[0]) ? params[0] : [];
        return { rows: data.fields.filter((field) => ids.includes(field.field_id)) as T[] };
      }

      if (sql.includes("FROM catalog_display_templates")) {
        return { rows: data.templates as T[] };
      }

      if (sql.includes("FROM catalog_reference_records")) {
        const ids = Array.isArray(params?.[0]) ? params[0] : [];
        return { rows: data.references.filter((reference) => ids.includes(reference.reference_record_id)) as T[] };
      }

      return { rows: [] };
    },
  };
}
