import { describe, expect, it } from "vitest";
import { deriveRequiredFieldKeys, initialDisplayTemplateState } from "../domain/domain";
import { validatePublishedDisplayTemplate } from "./validation";

const template = (overrides: Partial<typeof initialDisplayTemplateState> = {}) => ({
  ...initialDisplayTemplateState,
  id: "dtp_template" as never,
  titleTemplate: "{field.card-name} {reference.expansion.attributes.printed-card-count}",
  status: "draft" as const,
  ...overrides,
});

describe("Display Template authoring validation", () => {
  it("rejects an unknown field token with the token in the diagnostic", async () => {
    await expect(
      validatePublishedDisplayTemplate(db({ fields: [] }), template({ titleTemplate: "{field.not-a-field}" }) as never),
    ).rejects.toThrow("{field.not-a-field}");
  });

  it("rejects an undeclared reference attribute token", async () => {
    await expect(
      validatePublishedDisplayTemplate(
        db({ referenceTypes: [{ key: "expansion", attribute_keys: ["printed-card-count"] }] }),
        template({ titleTemplate: "{reference.expansion.attributes.release-code}" }) as never,
      ),
    ).rejects.toThrow("{reference.expansion.attributes.release-code}");
  });

  it("rejects an inactive reference type", async () => {
    await expect(
      validatePublishedDisplayTemplate(
        db({ referenceTypes: [] }),
        template({ titleTemplate: "{reference.expansion.name}" }) as never,
      ),
    ).rejects.toThrow("{reference.expansion.name}");
  });

  it("derives required field keys from non-optional field and reference tokens", () => {
    expect(
      deriveRequiredFieldKeys(
        "{field.card-name} {reference.expansion.attributes.printed-card-count} [{field.card-variant}]",
        "{field.rarity} [{reference.series.name}]",
      ),
    ).toEqual(["card-name", "expansion", "rarity"]);
  });
});

function db({
  fields = [{ key: "card-name" }],
  referenceTypes = [{ key: "expansion", attribute_keys: ["printed-card-count"] }],
  relationships = [],
}: {
  fields?: Array<{ key: string }>;
  referenceTypes?: Array<{ key: string; attribute_keys: unknown }>;
  relationships?: Array<{ relationship_type: string }>;
}) {
  return {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes("catalog_fields")) return { rows: fields as T[] };
      if (sql.includes("catalog_reference_types")) return { rows: referenceTypes as T[] };
      return { rows: relationships as T[] };
    },
  };
}
