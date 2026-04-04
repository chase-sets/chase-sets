import { catalogSeedIds } from "../../seed-support/ids";
import type { CatalogServices } from "../services";
import type { FieldId } from "../../ids";
import { sendSeedCommand } from "../seed-support/context";

type FieldDef = {
  key: string;
  fieldId: FieldId;
  name: string;
  description: string;
  valueType: "string" | "number" | "boolean" | "date" | "json";
  behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
};

const fieldDefs: FieldDef[] = [
  {
    key: "card-number",
    fieldId: catalogSeedIds.fields.cardNumber as FieldId,
    name: "Card Number",
    description: "The card number within its set (for example 4/102)",
    valueType: "string",
    behavior: { filterable: true, searchable: false, sortable: true },
  },
  {
    key: "card-name",
    fieldId: catalogSeedIds.fields.cardName as FieldId,
    name: "Card Name",
    description: "The printed name of the card",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "set-name",
    fieldId: catalogSeedIds.fields.setName as FieldId,
    name: "Set Name",
    description: "The expansion set or product line the item belongs to",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "rarity",
    fieldId: catalogSeedIds.fields.rarity as FieldId,
    name: "Rarity",
    description: "The printed rarity classification for a single card",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "language",
    fieldId: catalogSeedIds.fields.language as FieldId,
    name: "Language",
    description: "The language the item is printed in",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "artist",
    fieldId: catalogSeedIds.fields.artist as FieldId,
    name: "Artist",
    description: "The illustrator of the card",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "release-year",
    fieldId: catalogSeedIds.fields.releaseYear as FieldId,
    name: "Release Year",
    description: "The year the card or product was released",
    valueType: "number",
    behavior: { filterable: true, searchable: false, sortable: true },
  },
  {
    key: "pack-count",
    fieldId: catalogSeedIds.fields.packCount as FieldId,
    name: "Pack Count",
    description: "Number of booster packs included in a sealed product",
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

    result[def.key] = def.fieldId;
    console.log(`  Field "${def.name}" created`);
  }

  return result;
}



