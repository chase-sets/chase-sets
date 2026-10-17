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

  it("recursively rejects unknown keys and enforces quantity, reference, money, and currency bounds", () => {
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
      command({ shippingCollectedAmount: "1.00" }),
      command({ channelFeeAmount: "1.00" }),
      command({ unitPriceAmount: "1", currencyCode: "USD" }),
      command({ shippingCollectedAmount: "125", currencyCode: "USD" }),
      command({ channelFeeAmount: "-1.00", currencyCode: "USD" }),
      command({ shippingCollectedAmount: "1e5", currencyCode: "USD" }),
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
    expect(normalizeExternalChannelSaleCommand(command({ currencyCode: "USD" }))).toMatchObject({
      currencyCode: "USD",
    });
    const normalizedLineMoney = normalizeExternalChannelSaleCommand(
      command({
        unitPriceAmount: "12.34",
        shippingCollectedAmount: "3.50",
        channelFeeAmount: "1.25",
        currencyCode: "USD",
        soldAt: "2026-09-06T21:04:05-05:00",
        connectionAuditReference: "connection-a",
      }),
    );
    expect(normalizedLineMoney).toMatchObject({
      shippingCollectedAmount: "3.50",
      channelFeeAmount: "1.25",
      currencyCode: "USD",
    });
    expect(Object.keys(normalizedLineMoney)).toEqual([
      "accountId",
      "inventoryItemId",
      "storageLocationId",
      "saleKey",
      "requestedQuantity",
      "unitPriceAmount",
      "currencyCode",
      "soldAt",
      "shippingCollectedAmount",
      "channelFeeAmount",
      "connectionAuditReference",
    ]);
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

  it("preserves existing fingerprints and adds each line amount as an independent present-only fact", () => {
    const unpriced = normalizeExternalChannelSaleCommand(command());
    const priced = normalizeExternalChannelSaleCommand(
      command({
        unitPriceAmount: "12.34",
        currencyCode: "USD",
        soldAt: "2026-09-06T21:04:05-05:00",
      }),
    );
    expect(externalChannelSaleCommandFingerprint(unpriced)).toBe(
      "286715d368e8974255238323cb54e79ea19fb63730ee431b5de2e131c2e8c56c",
    );
    expect(externalChannelSaleCommandFingerprint(priced)).toBe(
      "501faf2b69ec910ce010fdd38e69d76f4003cb306ba828c728fde33c2c5bbcbe",
    );

    const shipping = externalChannelSaleCommandFingerprint({ ...priced, shippingCollectedAmount: "4.00" });
    const fee = externalChannelSaleCommandFingerprint({ ...priced, channelFeeAmount: "2.00" });
    const both = externalChannelSaleCommandFingerprint({
      ...priced,
      shippingCollectedAmount: "4.00",
      channelFeeAmount: "2.00",
    });
    const zeroShipping = externalChannelSaleCommandFingerprint({ ...priced, shippingCollectedAmount: "0.00" });
    const zeroFee = externalChannelSaleCommandFingerprint({ ...priced, channelFeeAmount: "0.00" });
    expect({ shipping, fee, both, zeroShipping, zeroFee }).toEqual({
      shipping: "5db4a8cc2ceabcca08e0f77482563eaf3cbaae859f2ac4fd90a014034108286d",
      fee: "f6141c6164839123c97fde15acff02906525175afea9575750654f6ad579a521",
      both: "abe7302a94f3ebcacf50238142f6abe3f6e7817eb78a9bcc67b7beae2fced267",
      zeroShipping: "cb50627e9973fe6c8a274c434e467728639b78ff851e2e571488b3c20b93a458",
      zeroFee: "06005089fac20aaf21b8dad7767cc37791a6698b85e5ac8125cbe6be0637039c",
    });
  });

  it("accepts the complete money-bearing v1 event and rejects closed-schema violations through the codec", () => {
    const saleKey = command().saleKey;
    const saleStreamId = externalChannelSaleStreamId(saleKey);
    const payload = {
      eventVersion: 1,
      saleKey,
      commandFingerprint: "a".repeat(64),
      accountId: "acc_seller",
      inventoryItemId: "inv_item",
      storageLocationId: "loc_main",
      requestedQuantity: 2,
      unitPriceAmount: "12.34",
      currencyCode: "USD",
      soldAt: "2026-09-07T02:04:05.000Z",
      shippingCollectedAmount: "4.00",
      channelFeeAmount: "2.00",
      connectionAuditReference: "connection-a",
      collisionMode: EXTERNAL_CHANNEL_SALE_COLLISION_MODE,
      collisionPolicyRef: EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REF,
      collisionPolicyRevision: EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION,
      reasonCode: EXTERNAL_CHANNEL_SALE_REASON_CODE,
      result: {
        saleKey,
        saleStreamId,
        saleEventId: "evt_sale",
        accountId: "acc_seller",
        inventoryItemId: "inv_item",
        storageLocationId: "loc_main",
        requestedQuantity: 2,
        appliedQuantity: 2,
        refusedQuantity: 0,
        protectedOrderIds: [],
        collisionPolicyRef: EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REF,
        collisionPolicyRevision: EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION,
        inventoryAdjustmentEventId: "evt_adjustment",
        saleShortfallKey: null,
        committedAt: "2026-09-07T02:05:00.000Z",
      },
    } as const;
    const decoded = externalChannelSaleEventCodec.decode({
      eventType: "inventory.external-channel-sale.recorded",
      payload,
    });
    expect(Object.keys(decoded.data)).toEqual([
      "eventVersion",
      "saleKey",
      "commandFingerprint",
      "accountId",
      "inventoryItemId",
      "storageLocationId",
      "requestedQuantity",
      "unitPriceAmount",
      "currencyCode",
      "soldAt",
      "shippingCollectedAmount",
      "channelFeeAmount",
      "connectionAuditReference",
      "collisionMode",
      "collisionPolicyRef",
      "collisionPolicyRevision",
      "reasonCode",
      "result",
    ]);

    const { currencyCode: _currencyCode, ...withoutCurrency } = payload;
    const invalidPayloads = [
      { ...payload, unexpected: true },
      { ...payload, saleKey: { ...payload.saleKey, unexpected: true } },
      { ...payload, result: { ...payload.result, unexpected: true } },
      { ...payload, shippingCollectedAmount: "125" },
      withoutCurrency,
      { ...payload, result: { ...payload.result, protectedOrderIds: [1] } },
      { ...payload, result: { ...payload.result, appliedQuantity: 2_147_483_648 } },
      { ...payload, result: { ...payload.result, committedAt: "2026-09-07" } },
    ];
    expect(_currencyCode).toBe("USD");
    for (const invalid of invalidPayloads) {
      expect(() =>
        externalChannelSaleEventCodec.decode({
          eventType: "inventory.external-channel-sale.recorded",
          payload: invalid as never,
        }),
      ).toThrow(InventoryDomainError);
    }

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
