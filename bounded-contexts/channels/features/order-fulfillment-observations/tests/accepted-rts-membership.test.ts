import { describe, expect, it, vi } from "vitest";
import {
  acceptedReadyToShipInputByteLimit,
  acceptedReadyToShipReferenceLimit,
  assertAcceptedReadyToShipQuery,
  translateOrderStatus,
  type AcceptedReadyToShipQuery,
} from "../domain/contracts";
import { readAcceptedReadyToShipMembership } from "../api/runtime";
import { createChannelsServicesForTest } from "../../../tests/channels-services-test-support";

const valid = { connectionId: "connection-1", orderReferences: ["synthetic-order"] };

describe("accepted-rts-membership", () => {
  it("exposes the same bounded owner reader through Channels composition", async () => {
    const services = createChannelsServicesForTest();
    expect(
      await services.fulfillmentObservations.readAcceptedReadyToShipMembership({ ...valid, orderReferences: [] }),
    ).toEqual([]);
  });

  it("accepts empty and largest reference-count inputs without truncating a nonempty result", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ order_reference: "synthetic-order" }] });
    expect(await readAcceptedReadyToShipMembership({ query }, { ...valid, orderReferences: [] })).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    const orderReferences = Array.from({ length: acceptedReadyToShipReferenceLimit }, (_, index) => `order-${index}`);
    expect(await readAcceptedReadyToShipMembership({ query }, { ...valid, orderReferences })).toEqual([
      "synthetic-order",
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toEqual([valid.connectionId, orderReferences]);
  });

  it.each([
    null,
    {},
    [],
    { ...valid, extra: true },
    { ...valid, connectionId: "" },
    { ...valid, connectionId: { value: "connection-1" } },
    { ...valid, orderReferences: "synthetic-order" },
    { ...valid, orderReferences: ["ok", { value: "nested" }] },
    { ...valid, orderReferences: ["ok", ["nested"]] },
    { ...valid, orderReferences: ["ok", null] },
    { ...valid, orderReferences: ["ok", 12] },
    { ...valid, orderReferences: ["ok", ""] },
    { ...valid, orderReferences: ["ok", " "] },
    { ...valid, orderReferences: ["ok", "bad\u0000"] },
    { ...valid, orderReferences: ["ok", "x".repeat(129)] },
    { ...valid, orderReferences: ["same", "same"] },
    { ...valid, orderReferences: new Array(2) },
    {
      ...valid,
      orderReferences: Array.from({ length: acceptedReadyToShipReferenceLimit + 1 }, (_, i) => `order-${i}`),
    },
  ])("rejects a closed/deep/reference-bound violation before SQL: %j", async (input) => {
    const query = vi.fn();
    await expect(readAcceptedReadyToShipMembership({ query }, input as AcceptedReadyToShipQuery)).rejects.toThrow(
      "invalid-schema",
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("bounds total UTF-8 bytes at the exact cap, not JavaScript character count", () => {
    const input = {
      connectionId: "connection-1",
      orderReferences: Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, "0")}${"界".repeat(85)}`),
    };
    const bytes = () => new TextEncoder().encode(JSON.stringify(input)).byteLength;
    while (bytes() < acceptedReadyToShipInputByteLimit) {
      const index = input.orderReferences.findIndex((reference) => reference.length < 128);
      input.orderReferences[index] += "a";
    }
    expect(bytes()).toBe(acceptedReadyToShipInputByteLimit);
    expect(() => assertAcceptedReadyToShipQuery(input)).not.toThrow();
    input.orderReferences[999] += "a";
    expect(() => assertAcceptedReadyToShipQuery(input)).toThrow("invalid-schema");
  });

  it("pins both captured RTS surfaces and the lossy active translation discriminator", () => {
    // Synthetic inputs using only the #7793 captured list/detail vocabulary.
    for (const surface of ["list", "detail"] as const)
      expect(translateOrderStatus({ surface, value: "Ready to Ship" })).toBe("active");
    for (const value of ["Shipped - In Transit", "Shipped - Delivered", "Completed - Paid"])
      expect(translateOrderStatus({ surface: "list", value })).toBe("active");
    expect(() => translateOrderStatus({ surface: "detail", value: "Shipped - In Transit" })).toThrow(
      "unsupported-order-status",
    );
  });
});
