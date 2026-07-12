import { describe, expect, it, vi } from "vitest";
import type { SupportReferenceLookupResult, SupportReferenceLookupSource } from "./contracts";
import { resolveSupportReference } from "./runtime";

const orderResult: SupportReferenceLookupResult = {
  contextName: "ordering",
  entityType: "order",
  displayReference: "ORD-E6K7M8N9",
  status: "pending-payment",
  summary: "Order ORD-E6K7M8N9",
  adminHref: "/orders/ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
};

function createSources(overrides: Partial<Record<string, SupportReferenceLookupSource>> = {}) {
  const ordering: SupportReferenceLookupSource = overrides.ordering ?? {
    contextName: "ordering",
    lookupByReference: vi.fn(async () => orderResult),
    lookupById: vi.fn(async () => orderResult),
  };
  const checkout: SupportReferenceLookupSource = overrides.checkout ?? {
    contextName: "checkout",
    lookupByReference: vi.fn(async () => null),
  };

  return [ordering, checkout];
}

describe("resolveSupportReference", () => {
  it("routes a display reference to the matching source's lookupByReference", async () => {
    const sources = createSources();

    const result = await resolveSupportReference(sources, "ORD-E6K7M8N9");

    expect(result).toEqual(orderResult);
    expect(sources[0]!.lookupByReference).toHaveBeenCalledWith("ORD-E6K7M8N9");
  });

  it("routes a raw typed ULID to the matching source's lookupById", async () => {
    const sources = createSources();

    const result = await resolveSupportReference(sources, "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");

    expect(result).toEqual(orderResult);
    expect(sources[0]!.lookupById).toHaveBeenCalledWith("ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");
  });

  it("normalizes forgivingly before routing (trim, uppercase, missing hyphen)", async () => {
    const sources = createSources();

    const result = await resolveSupportReference(sources, "  orde6k7m8n9  ");

    expect(result).toEqual(orderResult);
    expect(sources[0]!.lookupByReference).toHaveBeenCalledWith("ORD-E6K7M8N9");
  });

  it("returns null when the input matches no known prefix", async () => {
    const sources = createSources();

    expect(await resolveSupportReference(sources, "not-a-reference")).toBeNull();
    expect(await resolveSupportReference(sources, "")).toBeNull();
  });

  it("returns null when no source is configured for the routed context", async () => {
    const sources = createSources().filter((source) => source.contextName !== "ordering");

    expect(await resolveSupportReference(sources, "ORD-E6K7M8N9")).toBeNull();
  });

  it("returns null for a typed-id route when the source has no lookupById (e.g. checkout)", async () => {
    // Checkout never appears as a typed-id route today, but this proves the runtime
    // degrades safely rather than throwing if a source omits lookupById.
    const checkoutOnly: SupportReferenceLookupSource = {
      contextName: "ordering",
      lookupByReference: vi.fn(async () => null),
    };

    expect(await resolveSupportReference([checkoutOnly], "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9")).toBeNull();
  });

  it("delegates a CSG-/CS-SL- reference to the checkout source", async () => {
    const checkoutResult: SupportReferenceLookupResult = {
      contextName: "checkout",
      entityType: "buy-checkout-session",
      displayReference: "CSG-CARDVAULT",
      status: "pending",
      summary: "Checkout group CSG-CARDVAULT",
      adminHref: null,
    };
    const checkout: SupportReferenceLookupSource = {
      contextName: "checkout",
      lookupByReference: vi.fn(async () => checkoutResult),
    };
    const sources = createSources({ checkout });

    const result = await resolveSupportReference(sources, "CSG-CARDVAULT");

    expect(result).toEqual(checkoutResult);
    expect(checkout.lookupByReference).toHaveBeenCalledWith("CSG-CARDVAULT");
  });

  it("returns null when the owning context has no record for the reference", async () => {
    const ordering: SupportReferenceLookupSource = {
      contextName: "ordering",
      lookupByReference: vi.fn(async () => null),
      lookupById: vi.fn(async () => null),
    };
    const sources = createSources({ ordering });

    expect(await resolveSupportReference(sources, "ORD-NOTFOUND")).toBeNull();
  });
});
