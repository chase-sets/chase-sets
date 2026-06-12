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
    ["expansion", activeField(catalogSeedIds.fields.expansion, "expansion")],
    ["rarity", activeField(catalogSeedIds.fields.rarity, "rarity")],
    ["card-variant", activeField(catalogSeedIds.fields.cardVariant, "card-variant")],
    ["card-illustrator", activeField(catalogSeedIds.fields.cardIllustrator, "card-illustrator")],
    ["release-year", activeField(catalogSeedIds.fields.releaseYear, "release-year")],
    ["pack-count", activeField(catalogSeedIds.fields.packCount, "pack-count")],
  ]);

  for (const key of input.missingKeys ?? []) {
    existingFields.delete(key);
  }

  const commands: { streamId: string; type: string; key: string | undefined }[] = [];
  const services = {
    db: {
      query: async <T>(_sql: string, values: readonly unknown[]) => {
        const fieldId = String(values[0]);
        const key = String(values[1]);
        const row =
          existingFields.get(key) ?? Array.from(existingFields.values()).find((field) => field.field_id === fieldId);

        return {
          rowCount: row ? 1 : 0,
          rows: (row ? [row] : []) as T[],
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
