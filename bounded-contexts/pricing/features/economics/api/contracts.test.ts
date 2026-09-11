import { describe, expect, it } from "vitest";
import {
  parseAuthenticatedClearAllEconomicsOverridesRequest,
  parseAuthenticatedClearEconomicsOverrideRequest,
  parseAuthenticatedResolveEconomicsRequest,
  parseAuthenticatedSetEconomicsOverrideRequest,
} from "./contracts";

const input = {
  scope: { kind: "native-marketplace" },
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
    {
      ...input,
      scope: {
        kind: "channel-connection",
        connectionId: "synthetic-connection-1",
        providerKey: "synthetic-forged-provider",
      },
    },
  ])("rejects forged or duplicate identity coordinates before injection %#", (candidate) => {
    expect(() => parseAuthenticatedResolveEconomicsRequest(candidate, "synthetic-owner-account")).toThrow(
      /invalid shape/,
    );
  });
});

describe("authenticated Economics override requests", () => {
  it("retains the scope discriminant when a valid Channel ID matches the native literal", () => {
    const common = {
      currency: "usd",
      expectedVersion: 0,
      factName: "turnaroundDays",
      value: 14,
      setAt: "2026-09-07T06:01:00Z",
    } as const;
    const native = parseAuthenticatedSetEconomicsOverrideRequest(
      { ...common, scope: { kind: "native-marketplace" } },
      "synthetic-owner-account",
    );
    const channel = parseAuthenticatedSetEconomicsOverrideRequest(
      { ...common, scope: { kind: "channel-connection", connectionId: "native-marketplace" } },
      "synthetic-owner-account",
    );

    expect(native.key.scopeKey).toBe("native-marketplace");
    expect(channel.key.scopeKey).toBe("channel-connection:native-marketplace");
    expect(channel.key).not.toEqual(native.key);
  });

  it("injects account identity and closes set, clear, and clear-all shapes", () => {
    const subject = {
      scope: { kind: "channel-connection", connectionId: "synthetic-connection-1" },
      currency: "usd",
      expectedVersion: 2,
    };
    expect(
      parseAuthenticatedSetEconomicsOverrideRequest(
        { ...subject, factName: "turnaroundDays", value: 14, setAt: "2026-09-07T06:01:00Z" },
        "synthetic-owner-account",
      ),
    ).toMatchObject({
      key: {
        accountId: "synthetic-owner-account",
        scopeKey: `channel-connection:${subject.scope.connectionId}`,
        currency: "usd",
      },
      command: { type: "SetEconomicsFactOverride", expectedVersion: 2, factName: "turnaroundDays", value: 14 },
    });
    expect(
      parseAuthenticatedClearEconomicsOverrideRequest(
        { ...subject, factName: "turnaroundDays", clearedAt: "2026-09-07T06:02:00Z" },
        "synthetic-owner-account",
      ).command.type,
    ).toBe("ClearEconomicsFactOverride");
    expect(
      parseAuthenticatedClearAllEconomicsOverridesRequest(
        { ...subject, clearedAt: "2026-09-07T06:03:00Z" },
        "synthetic-owner-account",
      ).command.type,
    ).toBe("ClearAllEconomicsFactOverrides");
  });

  it.each([
    {
      accountId: "synthetic-forged",
      scope: { kind: "channel-connection", connectionId: "synthetic-connection-1" },
      currency: "usd",
      expectedVersion: 0,
      factName: "turnaroundDays",
      value: 1,
      setAt: "2026-09-07T06:01:00Z",
    },
    {
      providerKey: "synthetic-forged",
      scope: { kind: "channel-connection", connectionId: "synthetic-connection-1" },
      currency: "usd",
      expectedVersion: 0,
      factName: "turnaroundDays",
      value: 1,
      setAt: "2026-09-07T06:01:00Z",
    },
    {
      scope: { kind: "channel-connection", connectionId: "synthetic-connection-1" },
      currency: "usd",
      expectedVersion: 0,
      factName: "turnaroundDayz",
      value: 1,
      setAt: "2026-09-07T06:01:00Z",
    },
  ])("rejects forged identity coordinates and near-miss fact names %#", (candidate) => {
    expect(() => parseAuthenticatedSetEconomicsOverrideRequest(candidate, "synthetic-owner-account")).toThrow();
  });
});
