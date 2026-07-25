import { describe, expect, it } from "vitest";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { seedFields } from "./seed";

describe("field seed", () => {
  it("reconciles a missing card variant field when older integration structure already exists", async () => {
    const harness = createSeedFieldsHarness({
      missingKeys: new Set(["card-variant"]),
    });

    const ids = await seedFields(harness.services);

    expect(ids["card-variant"]).toBe(catalogSeedIds.fields.cardVariant);
    expect(harness.commands).toEqual([
      {
        streamId: `catalog.field-${catalogSeedIds.fields.cardVariant}`,
        type: "CreateField",
        key: "card-variant",
      },
      {
        streamId: `catalog.field-${catalogSeedIds.fields.cardVariant}`,
        type: "ActivateField",
        key: undefined,
      },
    ]);
  });

  it("reconciles the Magic set field when older Pokemon integration structure already exists", async () => {
    const harness = createSeedFieldsHarness({
      missingKeys: new Set(["set"]),
    });

    const ids = await seedFields(harness.services);

    expect(ids.set).toBe(catalogSeedIds.fields.set);
    expect(harness.commands).toEqual([
      {
        streamId: `catalog.field-${catalogSeedIds.fields.set}`,
        type: "CreateField",
        key: "set",
      },
      {
        streamId: `catalog.field-${catalogSeedIds.fields.set}`,
        type: "ActivateField",
        key: undefined,
      },
    ]);
  });

  it("reconciles Lorcana descriptive and sealed product fields additively", async () => {
    const missingKeys = new Set([
      "ink-color",
      "card-type",
      "card-classifications",
      "card-properties",
      "sealed-product-form",
    ]);
    const harness = createSeedFieldsHarness({ missingKeys });

    const ids = await seedFields(harness.services);

    expect(ids["ink-color"]).toBe(catalogSeedIds.fields.inkColor);
    expect(ids["card-type"]).toBe(catalogSeedIds.fields.cardType);
    expect(ids["card-classifications"]).toBe(catalogSeedIds.fields.cardClassifications);
    expect(ids["card-properties"]).toBe(catalogSeedIds.fields.cardProperties);
    expect(ids["sealed-product-form"]).toBe(catalogSeedIds.fields.sealedProductForm);
    expect(harness.commands.filter((command) => command.type === "CreateField").map((command) => command.key)).toEqual([
      "ink-color",
      "card-type",
      "card-classifications",
      "card-properties",
      "sealed-product-form",
    ]);
  });

  it("does not recreate active integration fields", async () => {
    const harness = createSeedFieldsHarness();

    await seedFields(harness.services);

    expect(harness.commands).toEqual([]);
  });
});

function createSeedFieldsHarness(input: { missingKeys?: Set<string> } = {}) {
  const existingFields = new Map<string, { field_id: string; key: string; status: string }>([
    ["card-number", activeField(catalogSeedIds.fields.cardNumber, "card-number")],
    ["card-name", activeField(catalogSeedIds.fields.cardName, "card-name")],
    ["set", activeField(catalogSeedIds.fields.set, "set")],
    ["expansion", activeField(catalogSeedIds.fields.expansion, "expansion")],
    ["rarity", activeField(catalogSeedIds.fields.rarity, "rarity")],
    ["card-variant", activeField(catalogSeedIds.fields.cardVariant, "card-variant")],
    ["card-illustrator", activeField(catalogSeedIds.fields.cardIllustrator, "card-illustrator")],
    ["ink-color", activeField(catalogSeedIds.fields.inkColor, "ink-color")],
    ["card-type", activeField(catalogSeedIds.fields.cardType, "card-type")],
    ["card-classifications", activeField(catalogSeedIds.fields.cardClassifications, "card-classifications")],
    ["card-properties", activeField(catalogSeedIds.fields.cardProperties, "card-properties")],
    ["publisher", activeField(catalogSeedIds.fields.publisher, "publisher")],
    ["set-code", activeField(catalogSeedIds.fields.setCode, "set-code")],
    ["set-name", activeField(catalogSeedIds.fields.setName, "set-name")],
    ["set-type", activeField(catalogSeedIds.fields.setType, "set-type")],
    ["release-year", activeField(catalogSeedIds.fields.releaseYear, "release-year")],
    ["pack-count", activeField(catalogSeedIds.fields.packCount, "pack-count")],
    ["sealed-product-number", activeField(catalogSeedIds.fields.sealedProductNumber, "sealed-product-number")],
    ["sealed-product-name", activeField(catalogSeedIds.fields.sealedProductName, "sealed-product-name")],
    ["product-kind", activeField(catalogSeedIds.fields.productKind, "product-kind")],
    ["sealed-product-form", activeField(catalogSeedIds.fields.sealedProductForm, "sealed-product-form")],
  ]);

  for (const key of input.missingKeys ?? []) {
    existingFields.delete(key);
  }

  const commands: { streamId: string; type: string; key: string | undefined }[] = [];
  const services = {
    db: {
      query: async <T>(_sql: string, values: readonly unknown[]) => {
        const expectedStreamId = String(values[0]);
        const expectedKey = String(values[2]);
        const rows = Array.from(existingFields.values())
          .filter((field) => `catalog.field-${field.field_id}` === expectedStreamId || field.key === expectedKey)
          .flatMap((field) => [
            {
              stream_id: `catalog.field-${field.field_id}`,
              stream_version: 1,
              event_type: "catalog.field.created",
              payload: {
                fieldId: field.field_id,
                key: field.key,
                name: { defaultLocale: "en", values: { en: field.key } },
                description: { defaultLocale: "en", values: { en: "" } },
                valueType: "string",
                behavior: { filterable: false, searchable: false, sortable: false },
              },
            },
            {
              stream_id: `catalog.field-${field.field_id}`,
              stream_version: 2,
              event_type: "catalog.field.activated",
              payload: {},
            },
          ]);

        return {
          rowCount: rows.length,
          rows: rows as T[],
        };
      },
    },
    fields: {
      commandHandler: async ({
        streamId,
        command,
      }: {
        streamId: string;
        command: { type: string; fieldId?: string; key?: string };
      }) => {
        commands.push({ streamId, type: command.type, key: command.key });
        if (command.type === "CreateField" && command.fieldId && command.key) {
          existingFields.set(command.key, {
            field_id: command.fieldId,
            key: command.key,
            status: "draft",
          });
        }
        if (command.type === "ActivateField") {
          const field = Array.from(existingFields.values()).find((entry) => streamId.endsWith(entry.field_id));
          if (field) {
            field.status = "active";
          }
        }
      },
    },
  } as unknown as CatalogServices;

  return { commands, services };
}

function activeField(field_id: string, key: string) {
  return { field_id, key, status: "active" };
}
