import { describe, expect, it, vi } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { seedDimensions } from "./seed";

describe("seedDimensions", () => {
  it("reconciles a partially created exact stream without sending CreateDimension twice", async () => {
    const form = catalogSeedIds.dimensions.form;
    const formStreamId = `catalog.dimension-${form.dimensionId}`;
    const query = vi.fn(async (_sql: string, [streamId]: readonly unknown[]) => ({
      rows:
        streamId === formStreamId
          ? [
              {
                event_type: "catalog.dimension.created",
                payload: {
                  dimensionId: form.dimensionId,
                  key: "form",
                  name: localizedTextMapFromEnglish("Form"),
                  description: localizedTextMapFromEnglish("Whether the collectible is raw or professionally graded."),
                  valueKind: "unordered",
                },
              },
            ]
          : [],
    }));
    const commandHandler = vi.fn(async () => ({ version: 1, state: {} }));
    const services = {
      db: { query },
      dimensions: { commandHandler },
    } as unknown as CatalogServices;

    await seedDimensions(services);

    const formCommands = commandHandler.mock.calls
      .map(([input]) => input)
      .filter((input) => input.streamId === formStreamId)
      .map((input) => input.command.type);
    expect(formCommands).toEqual(["AddOption", "AddOption", "ActivateDimension"]);
    expect(formCommands).not.toContain("CreateDimension");
  });
});
