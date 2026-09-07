import { describe, expect, it } from "vitest";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { externalChannelSaleEventCodec } from "../domain/codec";
import {
  EXTERNAL_CHANNEL_SALE_COLLISION_MODE,
  EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REF,
  EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION,
  EXTERNAL_CHANNEL_SALE_REASON_CODE,
  externalChannelSaleCanonicalKeyBytes,
  externalChannelSaleStreamId,
  normalizeExternalChannelSaleCommand,
} from "../domain/validation";
import { externalChannelSaleCommandFingerprint } from "./runtime";
import type { RecordExternalChannelSaleCommand } from "./contracts";

const command = (overrides: Partial<RecordExternalChannelSaleCommand> = {}): RecordExternalChannelSaleCommand => ({
  accountId: "acc_seller",
  inventoryItemId: "inv_item",
  storageLocationId: "loc_main",
  saleKey: {
    version: "v1",
    providerKey: "synthetic-provider",
    sellerEnvironmentLineage: "Seller / Production",
    orderLineIdentity: "Order A / Line 1",
  },
  requestedQuantity: 2,
  ...overrides,
});

describe("external-channel-sale-public-contract", () => {
  it("derives deterministic provider-qualified, length-prefixed stream identities", () => {
    const key = command().saleKey;
    expect(externalChannelSaleCanonicalKeyBytes(key).subarray(0, 25).toString()).toBe("ExternalChannelSaleKey/v1");
    expect(externalChannelSaleStreamId(key)).toMatch(/^inventory\.external-channel-sale-v1-[A-Za-z0-9_-]{43}$/);
    expect(externalChannelSaleStreamId(key)).toBe(externalChannelSaleStreamId({ ...key }));
    expect(externalChannelSaleStreamId({ ...key, providerKey: "other-provider" })).not.toBe(
      externalChannelSaleStreamId(key),
    );
    expect(externalChannelSaleStreamId({ ...key, sellerEnvironmentLineage: "ab", orderLineIdentity: "c" })).not.toBe(
      externalChannelSaleStreamId({ ...key, sellerEnvironmentLineage: "a", orderLineIdentity: "bc" }),
    );
  });

  it("preserves opaque case and internal whitespace while rejecting aliases and forbidden input", () => {
    const upper = normalizeExternalChannelSaleCommand(command()).saleKey;
    const lower = normalizeExternalChannelSaleCommand(
      command({ saleKey: { ...command().saleKey, sellerEnvironmentLineage: "seller / production" } }),
    ).saleKey;
    expect(externalChannelSaleStreamId(upper)).not.toBe(externalChannelSaleStreamId(lower));
    expect(
      normalizeExternalChannelSaleCommand(
        command({ saleKey: { ...command().saleKey, orderLineIdentity: "Order  A / Line 1" } }),
      ).saleKey.orderLineIdentity,
    ).toBe("Order  A / Line 1");

    for (const invalid of [
      { ...command().saleKey, providerKey: "TCGPlayer" },
      { ...command().saleKey, providerKey: `a${"b".repeat(64)}` },
      { ...command().saleKey, sellerEnvironmentLineage: " leading" },
      { ...command().saleKey, orderLineIdentity: "trailing " },
      { ...command().saleKey, orderLineIdentity: "e\u0301" },
      { ...command().saleKey, orderLineIdentity: "line\u0000" },
      { ...command().saleKey, orderLineIdentity: "line\uFDD0" },
      { ...command().saleKey, orderLineIdentity: "\uD800" },
      { ...command().saleKey, orderLineIdentity: "é".repeat(129) },
      { ...command().saleKey, orderLineIdentity: "a".repeat(257) },
    ]) {
      expect(() => normalizeExternalChannelSaleCommand(command({ saleKey: invalid as never }))).toThrow(
        InventoryDomainError,
      );
    }
    expect(
      normalizeExternalChannelSaleCommand(
        command({
          saleKey: {
            ...command().saleKey,
            providerKey: `a${"b".repeat(63)}`,
            orderLineIdentity: "é".repeat(128),
          },
        }),
      ).saleKey.orderLineIdentity,
    ).toHaveLength(128);
  });

  it("recursively rejects unknown keys and enforces quantity, reference, money, and pair bounds", () => {
    const unknownTop = { ...command(), fingerprint: "caller-controlled" };
    const unknownNested = { ...command(), saleKey: { ...command().saleKey, providerEventId: "evt_provider" } };
    for (const invalid of [
      unknownTop,
      unknownNested,
      command({ requestedQuantity: 0 }),
      command({ requestedQuantity: 2_147_483_648 }),
      command({ accountId: "a".repeat(129) }),
      command({ connectionAuditReference: "a".repeat(129) }),
      command({ unitPriceAmount: "1.00" }),
      command({ currencyCode: "USD" }),
      command({ unitPriceAmount: "1", currencyCode: "USD" }),
      command({ unitPriceAmount: "10000000000.00", currencyCode: "USD" }),
      command({ unitPriceAmount: "1.00", currencyCode: "usd" }),
    ]) {
      expect(() => normalizeExternalChannelSaleCommand(invalid as RecordExternalChannelSaleCommand)).toThrow(
        InventoryDomainError,
      );
    }
    expect(
      normalizeExternalChannelSaleCommand(
        command({
          requestedQuantity: 2_147_483_647,
          unitPriceAmount: "9999999999.99",
          currencyCode: "USD",
          connectionAuditReference: "a".repeat(128),
        }),
      ),
    ).toMatchObject({ requestedQuantity: 2_147_483_647, unitPriceAmount: "9999999999.99", currencyCode: "USD" });
  });

  it("requires strict timezone-bearing instants and fingerprints their canonical UTC value", () => {
    const normalized = normalizeExternalChannelSaleCommand(
      command({ soldAt: "2026-09-06T21:04:05-05:00", connectionAuditReference: "connection-1" }),
    );
    expect(normalized.soldAt).toBe("2026-09-07T02:04:05.000Z");
    for (const soldAt of [
      "2026-09-06",
      "2026-09-06T21:04:05",
      "2026-02-30T21:04:05Z",
      "2026-09-06T21:04Z",
      "2026-09-06T21:04:05.1234Z",
    ]) {
      expect(() => normalizeExternalChannelSaleCommand(command({ soldAt }))).toThrow(InventoryDomainError);
    }

    const changedAudit = { ...normalized, connectionAuditReference: "connection-2" };
    expect(externalChannelSaleCommandFingerprint(normalized)).toBe(externalChannelSaleCommandFingerprint(changedAudit));
    expect(externalChannelSaleCommandFingerprint(normalized)).not.toBe(
      externalChannelSaleCommandFingerprint({ ...normalized, requestedQuantity: 3 }),
    );
    expect(externalChannelSaleCommandFingerprint(normalized)).not.toBe(
      externalChannelSaleCommandFingerprint({ ...normalized, soldAt: undefined } as never),
    );
  });

  it("rejects unknown event payload fields through the registered codec", () => {
    expect(() =>
      externalChannelSaleEventCodec.decode({
        eventType: "inventory.external-channel-sale.recorded",
        payload: { eventVersion: 1, unexpected: true } as never,
      }),
    ).toThrow(InventoryDomainError);
    expect([
      EXTERNAL_CHANNEL_SALE_COLLISION_MODE,
      EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REF,
      EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION,
      EXTERNAL_CHANNEL_SALE_REASON_CODE,
    ]).toEqual([
      "protect-orders",
      "https://github.com/chase-sets/chase-sets/issues/7354#issuecomment-5381318708",
      1,
      "sold-external-channel",
    ]);
  });
});
