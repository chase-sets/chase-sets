import { describe, expect, it, vi } from "vitest";
import { componentRoutes } from "./route";
import type { ComponentServices } from "./runtime";

describe("component metadata revision route", () => {
  it("ignores legacy rule arrays and preserves the snapshot rules", async () => {
    const commandHandler = vi.fn(async ({ command }: { command: unknown }) => ({
      version: 2,
      state: {
        id: "cmp_01M66M1AC783BZKNJ5C2FWCNR3",
        key: "base-v2",
        name: { defaultLocale: "en", values: { en: "Base V2" } },
        description: { defaultLocale: "en", values: { en: "Updated" } },
        status: "draft",
        fieldRules: [{ fieldId: "fld_01M66M1AC783BZKNJ5C2FWCNR3", required: true }],
        dimensionRules: [
          { dimensionId: "dim_01M66M1AC783BZKNJ5C2FWCNR3", required: true, allowedOptionIds: [], appliesWhen: [] },
        ],
      },
      newEvents: [
        {
          type: "catalog.component.revised",
          data: {
            key: "base-v2",
            name: { defaultLocale: "en", values: { en: "Base V2" } },
            description: { defaultLocale: "en", values: { en: "Updated" } },
          },
        },
      ],
      storedEvents: [],
      receivedCommand: command,
    }));
    const app = componentRoutes({ commandHandler } as unknown as ComponentServices, {} as never);

    const response = await app.fetch(
      new Request("http://catalog.test/cmp_01M66M1AC783BZKNJ5C2FWCNR3", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "base-v2",
          name: { defaultLocale: "en", values: { en: "Base V2" } },
          description: { defaultLocale: "en", values: { en: "Updated" } },
          fieldRules: [],
          dimensionRules: [],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "cmp_01M66M1AC783BZKNJ5C2FWCNR3",
      snapshot: {
        fieldRules: [{ fieldId: "fld_01M66M1AC783BZKNJ5C2FWCNR3", required: true }],
        dimensionRules: [{ dimensionId: "dim_01M66M1AC783BZKNJ5C2FWCNR3", required: true }],
      },
    });
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "catalog.component-cmp_01M66M1AC783BZKNJ5C2FWCNR3",
        command: expect.objectContaining({ type: "ReviseComponent" }),
      }),
    );
    const command = commandHandler.mock.calls[0]?.[0].command as Record<string, unknown>;
    expect(command).toEqual(
      expect.objectContaining({ key: "base-v2", name: expect.any(Object), description: expect.any(Object) }),
    );
    expect(command).not.toHaveProperty("fieldRules");
    expect(command).not.toHaveProperty("dimensionRules");
  });
});
