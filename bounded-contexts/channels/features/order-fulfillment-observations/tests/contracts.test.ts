import { describe, expect, it } from "vitest";
import {
  assertFulfillmentObservation,
  composeChannelOrderFulfillmentInbound,
  translateOrderShippingType,
  translateOrderStatus,
} from "../domain/contracts";
import { composeChannelOrderFulfillmentReference } from "../domain/fulfillment-reference";
import { assertConnectorInbound } from "../../connector-feed/domain/transport";
import { connectorPolicyDefaults } from "../../connector-feed/domain/policy";
import { fulfillmentFixture } from "./fixtures";

describe("channel-order-shipping-option-total", () => {
  const captured = [
    [{ surface: "list", value: "Standard" }, "standard"],
    [{ surface: "list", value: "Expedited" }, "expedited"],
    [{ surface: "detail", value: "Standard (7-10 days)" }, "standard"],
  ] as const;
  it.each(captured)("maps the exact captured surface %j", (key, expected) =>
    expect(translateOrderShippingType(key)).toBe(expected),
  );
  it("kills the captured Expedited omission mutant", () => {
    const mutant = (input: Parameters<typeof translateOrderShippingType>[0]) => {
      if (input.value === "Expedited") throw new Error("omitted-captured-key");
      return translateOrderShippingType(input);
    };
    const complete = (mapper: typeof translateOrderShippingType) =>
      captured.every(([input, expected]) => mapper(input) === expected);
    expect(complete(translateOrderShippingType)).toBe(true);
    expect(() => complete(mutant)).toThrow("omitted-captured-key");
  });
  it.each(["International", "priority", "Standard (7-10 days)", "unknown"])(
    "refuses uncaptured list key %s",
    (value) => {
      expect(() => translateOrderShippingType({ surface: "list", value })).toThrow("unsupported-shipping-type");
    },
  );
  it("never conflates detail/list or invents refund vocabulary", () => {
    expect(() => translateOrderShippingType({ surface: "detail", value: "Standard" })).toThrow();
    for (const value of ["Completed - Paid", "Ready to Ship", "Shipped - In Transit", "Shipped - Delivered"])
      expect(translateOrderStatus({ surface: "list", value })).toBe("active");
    expect(translateOrderStatus({ surface: "list", value: "Canceled" })).toBe("cancelled");
    expect(translateOrderStatus({ surface: "detail", value: "Ready to Ship" })).toBe("active");
    for (const value of ["Canceled", "Shipped - Delivered", "refunded"])
      expect(() => translateOrderStatus({ surface: "detail", value })).toThrow("unsupported-order-status");
  });
});
describe("channel-order-observation-closed-schema", () => {
  const good = fulfillmentFixture();
  it("admits qualified USD and stable canonical content, not raw tuple wire spelling", async () => {
    expect(() => assertFulfillmentObservation(good)).not.toThrow();
    const envelope = await composeChannelOrderFulfillmentInbound(good);
    expect(envelope.externalReference).toMatch(/^tcf\.v1:[a-f0-9]{64}$/);
    expect(await composeChannelOrderFulfillmentInbound(structuredClone(good))).toEqual(envelope);
    expect(() => assertConnectorInbound(envelope, connectorPolicyDefaults)).not.toThrow();
    expect(() =>
      assertConnectorInbound(
        {
          ...envelope,
          externalReference: JSON.stringify(["channel-order-fulfillment/v1", good.externalOrderReference, "digest"]),
        },
        connectorPolicyDefaults,
      ),
    ).toThrow();
    expect(await composeChannelOrderFulfillmentReference(good.externalOrderReference, "digest")).not.toBe(
      envelope.externalReference,
    );
    expect(
      (
        await composeChannelOrderFulfillmentInbound({
          ...good,
          providerOrderStatus: { surface: "list", value: "Canceled" },
        })
      ).externalReference,
    ).not.toBe(envelope.externalReference);
  });
  it.each([
    { ...good, currency: undefined },
    { ...good, currency: { code: "USD" } },
    { ...good, currency: { code: "EUR", provenance: "tcgplayer-constant" } },
    { ...good, currency: { ...good.currency, extra: true } },
    { ...good, shipTo: { ...good.shipTo, email: "synthetic@example.invalid" } },
    { ...good, shipTo: { ...good.shipTo, line1: "" } },
    { ...good, lines: [{ ...good.lines[0], extra: 1 }] },
    { ...good, providerShippingType: { ...good.providerShippingType, extra: true } },
    { ...good, productAmount: "NaN" },
    { ...good, shippingAmount: "-1.00" },
    { ...good, orderedAt: "2026-10-08T12:00:00" },
    { ...good, orderedAt: "2026-10-08T12:00:00+25:00" },
    { ...good, orderedAt: "2026-02-30T12:00:00Z" },
    { ...good, orderedAt: "2026-10-08T24:00:00Z" },
    { ...good, version: 2 },
    { ...good, refunds: [] },
  ])("rejects a malformed nested or outer value without leaking it", (candidate) => {
    expect(() => assertFulfillmentObservation(candidate)).toThrow("invalid-schema");
  });
  it("keeps status-only recursively closed and free of PII, money and lines", async () => {
    const status = {
      version: 1 as const,
      variant: "status-only" as const,
      providerKey: "tcgplayer" as const,
      externalOrderReference: good.externalOrderReference,
      providerOrderStatus: { surface: "list" as const, value: "Canceled" },
      revision: "synthetic-revision",
    };
    expect(() => assertFulfillmentObservation(status)).not.toThrow();
    for (const field of ["shipTo", "lines", "productAmount", "currency"])
      expect(() => assertFulfillmentObservation({ ...status, [field]: good[field as keyof typeof good] })).toThrow();
    expect((await composeChannelOrderFulfillmentInbound(status)).externalReference).not.toBe(
      (await composeChannelOrderFulfillmentInbound(good)).externalReference,
    );
  });
});
