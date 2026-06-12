import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { FieldId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";
import { localizedTextMapFromEnglish, type LocalizedTextMap } from "@chase-sets/localization";

type FieldDef = {
  key: string;
  fieldId: FieldId;
  name: LocalizedTextMap;
  description: LocalizedTextMap;
  valueType: "string" | "number" | "boolean" | "date" | "json" | "localized_text" | "reference";
  behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
};

const fieldDefs: FieldDef[] = [
  {
    key: "card-number",
    fieldId: catalogSeedIds.fields.cardNumber as FieldId,
    name: l10n("Card Number"),
    description: l10n("The card number within its expansion (for example 4/102)"),
    valueType: "string",
    behavior: { filterable: true, searchable: false, sortable: true },
  },
  {
    key: "card-name",
    fieldId: catalogSeedIds.fields.cardName as FieldId,
    name: l10n("Card Name"),
    description: l10n("The printed name of the card"),
    valueType: "localized_text",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "expansion",
    fieldId: catalogSeedIds.fields.expansion as FieldId,
    name: l10n("Expansion"),
    description: l10n("The Pokemon TCG expansion the item belongs to"),
    valueType: "reference",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "rarity",
    fieldId: catalogSeedIds.fields.rarity as FieldId,
    name: l10n("Rarity"),
    description: l10n("The printed rarity classification for a single card"),
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "card-variant",
    fieldId: catalogSeedIds.fields.cardVariant as FieldId,
    name: l10n("Card Variant"),
    description: l10n("The Pokemon TCG print or parallel variant for a single card"),
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "card-illustrator",
    fieldId: catalogSeedIds.fields.cardIllustrator as FieldId,
    name: l10n("Card Illustrator"),
    description: l10n("The artist who illustrated the image on the card"),
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "release-year",
    fieldId: catalogSeedIds.fields.releaseYear as FieldId,
    name: l10n("Release Year"),
    description: l10n("The year the card or product was released"),
    valueType: "number",
    behavior: { filterable: true, searchable: false, sortable: true },
  },
  {
    key: "pack-count",
    fieldId: catalogSeedIds.fields.packCount as FieldId,
    name: l10n("Pack Count"),
    description: l10n("Number of booster packs included in a sealed product"),
    valueType: "number",
    behavior: { filterable: true, searchable: false, sortable: true },
  },
];

export type FieldIds = Record<string, FieldId>;

export async function seedFields(services: CatalogServices): Promise<FieldIds> {
  console.log("Seeding fields...");
  const result: FieldIds = {};

  for (const def of fieldDefs) {
    const streamId = `catalog.field-${def.fieldId}`;
    const existing = await findSeedField(services, def);

    if (!existing) {
      await sendSeedCommand(services.fields.commandHandler, streamId, {
        type: "CreateField",
        fieldId: def.fieldId,
        key: def.key,
        name: def.name,
        description: def.description,
        valueType: def.valueType,
        behavior: def.behavior,
      });

      await sendSeedCommand(services.fields.commandHandler, streamId, {
        type: "ActivateField",
      });
    } else if (existing.status === "draft") {
      await sendSeedCommand(services.fields.commandHandler, streamId, {
        type: "ActivateField",
      });
    } else if (existing.status !== "active") {
      throw new Error(
        `Catalog integration bootstrap requires active field '${def.key}', but found status '${existing.status}'.`,
      );
    }

    result[def.key] = def.fieldId;
    console.log(existing ? `  Field "${def.name.values.en}" reconciled` : `  Field "${def.name.values.en}" created`);
  }

  return result;
}

async function findSeedField(services: CatalogServices, def: FieldDef): Promise<{ status: string } | null> {
  const existing = await services.db.query<{
    field_id: string;
    key: string;
    status: string;
  }>(
    `SELECT field_id, key, status
     FROM catalog_fields
     WHERE field_id = $1 OR key = $2`,
    [def.fieldId, def.key],
  );
  const row = existing.rows.find((field) => field.field_id === def.fieldId && field.key === def.key);

  if (existing.rows.length === 0) {
    return null;
  }

  if (!row || existing.rows.length > 1) {
    throw new Error(`Catalog integration bootstrap field '${def.key}' conflicts with existing field metadata.`);
  }

  return { status: row.status };
}

function l10n(en: string): LocalizedTextMap {
  return localizedTextMapFromEnglish(en);
}
