import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createFulfillmentReturnIntakeMcpHandlers } from "./mcp";
import type { FulfillmentReturnShipmentServices } from "./runtime";

const operator = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_operator",
  accountId: "acc_platform",
  membershipId: "mem_1",
  roleKey: "platform-admin",
  permissions: ["return-intake.view", "return-intake.manage"],
} satisfies ResolvedActor;

function request(arguments_: Record<string, unknown>, actor_: ResolvedActor | null = operator) {
  return {
    actor: actor_,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: { protocolVersion: "2025-06-18", stateless: false, clientInfo: null, clientCapabilities: null },
  };
}

function services(overrides: Record<string, unknown> = {}) {
  return {
    listFacilityIntakeQueue: vi.fn(async () => [{ return_shipment_id: "rsh_01" }]),
    listUnidentifiedPackages: vi.fn(async () => []),
    getIntakeMetrics: vi.fn(async () => ({ delivered_not_intaken_count: 1 })),
    resolveForIntake: vi.fn(async () => ({
      outcome: "resolved" as const,
      shipment: { return_shipment_id: "rsh_01", remedy_id: "rmd_01" },
    })),
    getReturnShipmentVersion: vi.fn(async () => 3),
    verifyEvidence: vi.fn(async () => undefined),
    completeFacilityIntake: vi.fn(async () => ({ version: 4, state: { facilityIntake: {} }, newEvents: [] })),
    commandHandler: vi.fn(async () => ({ version: 4 })),
    streamIdFor: vi.fn((id: string) => `fulfillment.return-shipment-${id}`),
    getUnidentifiedPackage: vi.fn(async () => ({ facility_id: "fac_east" })),
    unidentifiedPackageCommandHandler: vi.fn(async () => ({ version: 2 })),
    ...overrides,
  } as unknown as FulfillmentReturnShipmentServices;
}

describe("return-intake MCP source-call contract coverage", () => {
  it("reads the facility queue with the source route's three bounded calls", async () => {
    const fake = services();
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.get-return-intake-queue"]?.(request({ facilityId: "fac_east" })),
    ).resolves.toMatchObject({ facilityId: "fac_east", items: [{ return_shipment_id: "rsh_01" }] });
    expect(fake.listFacilityIntakeQueue).toHaveBeenCalledWith("fac_east");
    expect(fake.listUnidentifiedPackages).toHaveBeenCalledWith("fac_east");
    expect(fake.getIntakeMetrics).toHaveBeenCalledWith("fac_east");
  });

  it("resolves a return and carries the aggregate version before a write", async () => {
    const fake = services();
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.resolve-return-intake"]?.(
        request({ facilityId: "fac_east", identifier: "rsh_01" }),
      ),
    ).resolves.toMatchObject({ outcome: "resolved", version: 3 });
    expect(fake.resolveForIntake).toHaveBeenCalledWith("rsh_01", "fac_east");
  });

  it("rejects unauthorized actors before any queue read", async () => {
    const fake = services();
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.get-return-intake-queue"]?.(
        request({ facilityId: "fac_east" }, { ...operator, permissions: [] }),
      ),
    ).rejects.toThrow("Missing required permission: return-intake.view.");
    expect(fake.listFacilityIntakeQueue).not.toHaveBeenCalled();
  });

  it("completes intake through the aggregate command with operator attribution and stable idempotency", async () => {
    const fake = services();
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await handlers.toolHandlers["fulfillment.complete-return-intake"]?.(
      request({
        facilityId: "fac_east",
        returnShipmentId: "rsh_01",
        stationId: "station_1",
        receivedAt: "2026-10-16T12:00:00.000Z",
        packageCondition: "intact",
        sealCondition: "intact",
        evidence: [],
        discrepancies: [],
        disposition: "completed",
        custodyIdentifier: "cust_1",
        idempotencyKey: "idem_1",
      }),
    );
    expect(fake.completeFacilityIntake).toHaveBeenCalledWith(expect.objectContaining({ returnShipmentId: "rsh_01" }));
    expect(fake.completeFacilityIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          audit: { performedByUserId: "usr_operator", forAccountId: "acc_platform" },
        }),
      }),
    );
  });
});
