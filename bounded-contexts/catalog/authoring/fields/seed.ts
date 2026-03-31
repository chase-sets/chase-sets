import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogServices } from "../services";
import type { FieldId } from "../../ids";
import { sendSeedCommand } from "../seed-support";

type FieldDef = {
  key: string;
  name: string;
  description: string;
  valueType: "string" | "number" | "boolean" | "date" | "json";
  behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
};

const fieldDefs: FieldDef[] = [
  {
    key: "card-number",
    name: "Card Number",
    description: "The card number within its set (for example 4/102)",
    valueType: "string",
    behavior: { filterable: true, searchable: false, sortable: true },
  },
  {
    key: "card-name",
    name: "Card Name",
    description: "The printed name of the card",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "set-name",
    name: "Set Name",
    description: "The expansion set or product line the item belongs to",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "rarity",
    name: "Rarity",
    description: "The printed rarity classification for a single card",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  },
  {
    key: "language",
    name: "Language",
    description: "The language the item is printed in",
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
    key: "release-year",
    name: "Release Year",
    description: "The year the card or product was released",
    valueType: "number",
    behavior: { filterable: true, searchable: false, sortable: true },
  },
  {
    key: "pack-count",
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
    const fieldId = createId("fld") as FieldId;
    const streamId = `catalog.field-${fieldId}`;

    await sendSeedCommand(services.fields.commandHandler, streamId, {
      type: "CreateField",
      fieldId,
      key: def.key,
      name: def.name,
      description: def.description,
      valueType: def.valueType,
      behavior: def.behavior,
    });

    await sendSeedCommand(services.fields.commandHandler, streamId, {
      type: "ActivateField",
    });

    result[def.key] = fieldId;
    console.log(`  Field "${def.name}" created`);
  }

  return result;
}
