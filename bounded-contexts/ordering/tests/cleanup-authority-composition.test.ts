import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertOrderingInventoryCleanupAuthorityCapability } from "../features/orders/api/cleanup-authority";
import { createOrderingServices } from "../support/runtime-support/services";

/**
 * AC-10 (Ordering side): the capability is required, both variants are
 * explicit, and Ordering's own seed callers state `not-mounted` rather than
 * leaving the nonoptional port undefined.
 */

function readOrderingSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function unusablePool() {
  const fail = () => {
    throw new Error("The Ordering cleanup-authority composition test must not touch a database pool.");
  };
  return { query: fail, connect: fail } as never;
}

describe("cleanup-authority-inventory-host-capability", () => {
  it("refuses an undefined, malformed, or incomplete capability", () => {
    expect(() => assertOrderingInventoryCleanupAuthorityCapability(undefined)).toThrowError(
      /inventoryCleanupAuthority host capability/,
    );
    expect(() => assertOrderingInventoryCleanupAuthorityCapability({ kind: "unknown" } as never)).toThrowError(
      /must be 'available' or 'not-mounted'/,
    );
    expect(() =>
      assertOrderingInventoryCleanupAuthorityCapability({ kind: "available", port: {} } as never),
    ).toThrowError(/must supply a complete port/);
  });

  it("accepts both explicit variants unchanged", () => {
    const notMounted = { kind: "not-mounted" } as const;
    expect(assertOrderingInventoryCleanupAuthorityCapability(notMounted)).toBe(notMounted);

    const available = {
      kind: "available",
      port: {
        readReservationAuthority: async () => ({
          kind: "unavailable" as const,
          reservationRequestId: "rsv_1",
          detail: "reservation-stream-missing",
        }),
        readHoldAuthority: async () => ({
          kind: "unavailable" as const,
          holdId: "hld_1",
          detail: "hold-stream-missing",
        }),
        lookupOrderHoldIds: async () => ({ kind: "lookup" as const, holdIds: [] }),
      },
    } as const;
    expect(assertOrderingInventoryCleanupAuthorityCapability(available)).toBe(available);
  });

  it("fails service construction before any pool use when the capability is absent", () => {
    expect(() => createOrderingServices(unusablePool(), undefined as never)).toThrowError(
      /inventoryCleanupAuthority host capability/,
    );
  });

  it("states the explicit variant at both Ordering seed constructors", () => {
    const seedSource = readOrderingSource("support/runtime-support/seed.ts");
    const constructorCalls = seedSource.match(/createOrderingServices\(pool[^)]*\)/g) ?? [];

    expect(constructorCalls).toHaveLength(2);
    for (const call of constructorCalls) {
      expect({ call, explicit: call.includes('inventoryCleanupAuthority: { kind: "not-mounted" }') }).toEqual({
        call,
        explicit: true,
      });
    }
    // No caller may fall back to a bare pool-only construction.
    expect(seedSource).not.toMatch(/createOrderingServices\(pool\)/);
  });
});
