import { catalogSeedIds } from "../../../support/seed-support/ids";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { FieldId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";
import { localizedTextMapFromEnglish, type LocalizedTextMap } from "@chase-sets/localization";

type FieldDef = {
  key: string;
  fieldId: FieldId;
  name: LocalizedTextMap;
  description: LocalizedTextMap;
  valueType: "string" | "number" | "boolean" | "date" | "json" | "localized_text";
  behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
};

const fieldDefs: FieldDef[] = [
  {
    key: "card-number",
    fieldId: catalogSeedIds.fields.cardNumber as FieldId,
    name: l10n("Card Number"),
    description: l10n("The card number within its set (for example 4/102)"),
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
    key: "set-name",
    fieldId: catalogSeedIds.fields.setName as FieldId,
    name: l10n("Set Name"),
    description: l10n("The expansion set or product line the item belongs to"),
    valueType: "string",
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
    key: "artist",
    fieldId: catalogSeedIds.fields.artist as FieldId,
    name: l10n("Artist"),
    description: l10n("The illustrator of the card"),
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
    console.log(`  Field "${def.name.values.en}" created`);
  }

  return result;
}

function l10n(en: string): LocalizedTextMap {
  return localizedTextMapFromEnglish(en);
}
