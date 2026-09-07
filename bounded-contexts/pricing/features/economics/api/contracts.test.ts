import { describe, expect, it } from "vitest";
import { parseAuthenticatedResolveEconomicsRequest } from "./contracts";

const input = {
  connectionId: "synthetic-connection-1",
  catalogItemId: "synthetic-catalog-item",
  inventoryItemId: "synthetic-inventory-item",
  marketUnitPrice: { amount: "100.00", currency: "usd" },
  quantity: 1,
  effectiveAt: "2026-09-07T06:00:00Z",
};

describe("authenticated Economics request", () => {
  it("injects the authenticated account as the only account authority", () => {
    expect(parseAuthenticatedResolveEconomicsRequest(input, "synthetic-owner-account")).toEqual({
      accountId: "synthetic-owner-account",
      ...input,
    });
  });

  it.each([
    { ...input, accountId: "synthetic-forged-account" },
    { ...input, providerKey: "synthetic-forged-provider" },
    { ...input, environment: "production" },
    { ...input, channel: { accountId: "synthetic-forged-account" } },
  ])("rejects forged or duplicate identity coordinates before injection %#", (candidate) => {
    expect(() => parseAuthenticatedResolveEconomicsRequest(candidate, "synthetic-owner-account")).toThrow(
      /invalid shape/,
    );
  });
});
