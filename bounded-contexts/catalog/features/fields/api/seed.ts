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
    description: l10n("The collector number within its expansion (for example 4)"),
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
    key: "set",
    fieldId: catalogSeedIds.fields.set as FieldId,
    name: l10n("Set"),
    description: l10n("The card set the card print or sealed product belongs to"),
    valueType: "reference",
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
    description: l10n("The printed card or parallel variant for a single card"),
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
    key: "ink-color",
    fieldId: catalogSeedIds.fields.inkColor as FieldId,
    name: l10n("Ink Color"),
    description: l10n("The Lorcana ink color printed on a card"),
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "card-type",
    fieldId: catalogSeedIds.fields.cardType as FieldId,
    name: l10n("Card Type"),
    description: l10n("The primary printed card type"),
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "card-classifications",
    fieldId: catalogSeedIds.fields.cardClassifications as FieldId,
    name: l10n("Card Classifications"),
    description: l10n("The printed classifications or subtypes on a card"),
    valueType: "json",
    behavior: { filterable: true, searchable: true, sortable: false },
  },
  {
    key: "card-properties",
    fieldId: catalogSeedIds.fields.cardProperties as FieldId,
    name: l10n("Card Properties"),
    description: l10n("The source properties or franchises represented by a card"),
    valueType: "json",
    behavior: { filterable: true, searchable: true, sortable: false },
  },
  {
    key: "publisher",
    fieldId: catalogSeedIds.fields.publisher as FieldId,
    name: l10n("Publisher"),
    description: l10n("The publisher or manufacturer associated with a catalog item"),
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "set-code",
    fieldId: catalogSeedIds.fields.setCode as FieldId,
    name: l10n("Set Code"),
    description: l10n("The provider or product-line code for a set"),
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "set-name",
    fieldId: catalogSeedIds.fields.setName as FieldId,
    name: l10n("Set Name"),
    description: l10n("The printed or provider set name"),
    valueType: "localized_text",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "set-type",
    fieldId: catalogSeedIds.fields.setType as FieldId,
    name: l10n("Set Type"),
    description: l10n("The set class such as chapter, promo, or special release"),
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
  {
    key: "sealed-product-number",
    fieldId: catalogSeedIds.fields.sealedProductNumber as FieldId,
    name: l10n("Sealed Product Number"),
    description: l10n("The provider or product-line number for a sealed product"),
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "sealed-product-name",
    fieldId: catalogSeedIds.fields.sealedProductName as FieldId,
    name: l10n("Sealed Product Name"),
    description: l10n("The printed or provider name for a sealed product"),
    valueType: "localized_text",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "product-kind",
    fieldId: catalogSeedIds.fields.productKind as FieldId,
    name: l10n("Product Kind"),
    description: l10n("The provider product kind or high-level product classification"),
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "sealed-product-form",
    fieldId: catalogSeedIds.fields.sealedProductForm as FieldId,
    name: l10n("Sealed Product Form"),
    description: l10n("The packaging form for a sealed product"),
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
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
