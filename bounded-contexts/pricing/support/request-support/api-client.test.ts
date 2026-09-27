import { describe, expect, it, vi } from "vitest";
import { createPricingApiClient, PricingApiError, pricingValidationMessages } from "./api-client";

describe("Pricing authoring client", () => {
  it("authoring prerequisites use the account route without selectors and preserve empty facts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ listingCurrencyCodes: [], hasCostBasis: false }),
    );
    const api = createPricingApiClient({ baseUrl: "https://synthetic.test", fetch });
    expect(await api.getRepricingAuthoringPrerequisites()).toMatchObject({
      listingCurrencyCodes: [],
      hasCostBasis: false,
    });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://synthetic.test/account/repricing-policies/authoring-prerequisites",
    );
    fetch.mockResolvedValueOnce(Response.json({ error: { code: "not_found" } }, { status: 404 }));
    await expect(api.getRepricingAuthoringPrerequisites()).rejects.toMatchObject({ status: 404 });
  });
  it("domain validation details survive the client and code-only errors do not become raw UI text", async () => {
    const message = "A repricing policy must define at least one rule.";
    const body = { error: { code: "validation_failed", message: "Invalid policy command.", details: [{ message }] } };
    const api = createPricingApiClient({
      baseUrl: "https://synthetic.test",
      fetch: async () => Response.json(body, { status: 400 }),
    });
    try {
      await api.reviseRepricingPolicy("rpp_synthetic", {
        name: "Synthetic",
        scope: { kind: "all-listings" },
        rules: [],
        maxChangesPerDay: 250,
      });
      expect.fail("must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(PricingApiError);
      expect((error as PricingApiError).body).toEqual(body);
      expect(pricingValidationMessages(error)).toEqual([message]);
    }
    for (const error of [
      new Error("internal-sentinel"),
      new PricingApiError(400, { error: { code: "validation_failed", message: "internal-sentinel" } }),
      new PricingApiError(500, body),
    ]) {
      expect(pricingValidationMessages(error)).toEqual([]);
    }
  });
});
