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

export type FieldIds = Record<string, FieldId>;

export async function seedFields(services: CatalogServices): Promise<FieldIds> {
  console.log("Seeding fields...");
  const result: FieldIds = {};

  for (const def of fieldDefs) {
    const fieldId = createId("fld") as FieldId;
    const streamId = `catalog.field-${fieldId}`;

    await sendSeedCommand(services.fieldHandler, streamId, {
      type: "CreateField",
      fieldId,
      key: def.key,
      name: def.name,
      description: def.description,
      valueType: def.valueType,
      behavior: def.behavior,
    });

    await sendSeedCommand(services.fieldHandler, streamId, {
      type: "ActivateField",
    });

    result[def.key] = fieldId;
    console.log(`  Field "${def.name}" created`);
  }

  return result;
}



