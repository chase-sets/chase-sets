import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { validateMcpModuleRegistrations } from "@chase-sets/platform-runtime/mcp";
import { flattenAvailableMcpTools, mcpServiceCatalog } from "@chase-sets/platform-runtime/mcp-contracts";
import { contextManifest } from "../../../index";
import { createFulfillmentReturnIntakeMcpHandlers } from "./mcp";
import type { FulfillmentReturnShipmentServices } from "./runtime";

const names = [
  "fulfillment.complete-return-intake",
  "fulfillment.correct-return-intake",
  "fulfillment.get-return-intake-queue",
  "fulfillment.reconcile-unidentified-return-package",
  "fulfillment.record-unidentified-return-package",
  "fulfillment.resolve-return-intake",
];

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
  it("registers exactly the six operator return-intake tools in the catalog, manifest and handlers", () => {
    const handlers = createFulfillmentReturnIntakeMcpHandlers(services());
    expect(
      flattenAvailableMcpTools()
        .filter((tool) => tool.serviceId === "fulfillment" && tool.permissionBoundary.scope === "operator")
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(names);
    expect(contextManifest.agentCoverage["return-intake"]?.tools).toEqual(names);
    expect(Object.keys(handlers.toolHandlers).sort()).toEqual(names);

    const registration = {
      contextName: "fulfillment",
      capabilities: { tools: names.map((name) => ({ name, ownerSlice: "return-shipments" })) },
      handlers,
    };
    const service = mcpServiceCatalog.find((entry) => entry.serviceId === "fulfillment")!;
    const ownedCatalog = [
      { ...service, tools: service.tools.filter((tool) => names.includes(tool.name)), resources: [] },
    ];
    expect(validateMcpModuleRegistrations([registration], ownedCatalog)).toEqual([]);
    for (const omitted of names) {
      const toolHandlers = { ...registration.handlers.toolHandlers };
      delete toolHandlers[omitted];
      expect(
        validateMcpModuleRegistrations([{ ...registration, handlers: { toolHandlers } }], ownedCatalog).join("\n"),
      ).toContain(omitted);
    }
  });

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

  it("corrects intake through the resolved shipment command with facility and operator attribution", async () => {
    const fake = services();
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.correct-return-intake"]?.(
        request({
          facilityId: "fac_east",
          returnShipmentId: "rsh_01",
          correctionId: "cor_01",
          reason: "Re-label package",
          owner: "ops",
          nextAction: "Reprint label",
          custodyIdentifier: "cust_1",
        }),
      ),
    ).resolves.toMatchObject({ returnShipmentId: "rsh_01", version: 4 });
    expect(fake.resolveForIntake).toHaveBeenCalledWith("rsh_01", "fac_east");
    expect(fake.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "fulfillment.return-shipment-rsh_01",
        context: expect.objectContaining({
          audit: { performedByUserId: "usr_operator", forAccountId: "acc_platform" },
        }),
        command: expect.objectContaining({
          type: "CorrectReturnShipmentFacilityIntake",
          correction: expect.objectContaining({ correctionId: "cor_01" }),
        }),
      }),
    );
  });

  it("records an unidentified package through evidence verification and the attributed command", async () => {
    const fake = services();
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.record-unidentified-return-package"]?.(
        request({
          facilityId: "fac_east",
          unidentifiedPackageId: "urp_01",
          stationId: "station_1",
          receivedAt: "2026-10-16T12:00:00.000Z",
          packageCondition: "intact",
          sealCondition: "intact",
          evidence: [],
          custodyIdentifier: "cust_1",
          owner: "ops",
          nextAction: "Identify package",
        }),
      ),
    ).resolves.toMatchObject({ unidentifiedPackageId: "urp_01", version: 2 });
    expect(fake.verifyEvidence).toHaveBeenCalledWith("fac_east", []);
    expect(fake.unidentifiedPackageCommandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "fulfillment.unidentified-return-package-urp_01",
        context: expect.objectContaining({
          audit: { performedByUserId: "usr_operator", forAccountId: "acc_platform" },
        }),
        command: expect.objectContaining({
          type: "RecordUnidentifiedReturnPackage",
          facilityId: "fac_east",
          unidentifiedPackageId: "urp_01",
        }),
      }),
    );
  });

  it("reconciles an unidentified package through facility-bound resolution and attribution", async () => {
    const fake = services();
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.reconcile-unidentified-return-package"]?.(
        request({
          unidentifiedPackageId: "urp_01",
          returnShipmentId: "rsh_01",
          reason: "Matched to return shipment",
        }),
      ),
    ).resolves.toMatchObject({ unidentifiedPackageId: "urp_01", returnShipmentId: "rsh_01", version: 2 });
    expect(fake.getUnidentifiedPackage).toHaveBeenCalledWith("urp_01");
    expect(fake.resolveForIntake).toHaveBeenCalledWith("rsh_01", "fac_east");
    expect(fake.unidentifiedPackageCommandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "fulfillment.unidentified-return-package-urp_01",
        context: expect.objectContaining({
          audit: { performedByUserId: "usr_operator", forAccountId: "acc_platform" },
        }),
        command: expect.objectContaining({
          type: "ReconcileUnidentifiedReturnPackage",
          returnShipmentId: "rsh_01",
        }),
      }),
    );
  });

  it.each([
    "fulfillment.complete-return-intake",
    "fulfillment.correct-return-intake",
    "fulfillment.record-unidentified-return-package",
    "fulfillment.reconcile-unidentified-return-package",
  ])("rejects %s without return-intake.manage", async (toolName) => {
    const fake = services();
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers[toolName]?.(request({}, { ...operator, permissions: ["return-intake.view"] })),
    ).rejects.toThrow("Missing required permission: return-intake.manage.");
    expect(fake.resolveForIntake).not.toHaveBeenCalled();
    expect(fake.verifyEvidence).not.toHaveBeenCalled();
    expect(fake.completeFacilityIntake).not.toHaveBeenCalled();
    expect(fake.commandHandler).not.toHaveBeenCalled();
    expect(fake.unidentifiedPackageCommandHandler).not.toHaveBeenCalled();
  });

  it("rejects a null actor before any write service call", async () => {
    const fake = services();
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(handlers.toolHandlers["fulfillment.complete-return-intake"]?.(request({}, null))).rejects.toThrow(
      "An authenticated operator is required.",
    );
    expect(fake.resolveForIntake).not.toHaveBeenCalled();
    expect(fake.verifyEvidence).not.toHaveBeenCalled();
    expect(fake.completeFacilityIntake).not.toHaveBeenCalled();
  });

  it("returns an unresolved resolve result without reading its version", async () => {
    const fake = services({ resolveForIntake: vi.fn(async () => ({ outcome: "not-found" as const })) });
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.resolve-return-intake"]?.(
        request({ facilityId: "fac_east", identifier: "rsh_01" }),
      ),
    ).resolves.toEqual({ outcome: "not-found" });
    expect(fake.getReturnShipmentVersion).not.toHaveBeenCalled();
  });

  it("rejects complete for a shipment not expected at the facility before effects", async () => {
    const fake = services({ resolveForIntake: vi.fn(async () => ({ outcome: "not-found" as const })) });
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.complete-return-intake"]?.(
        request({ facilityId: "fac_east", returnShipmentId: "rsh_01" }),
      ),
    ).rejects.toThrow("Return shipment is not expected at this facility.");
    expect(fake.verifyEvidence).not.toHaveBeenCalled();
    expect(fake.completeFacilityIntake).not.toHaveBeenCalled();
  });

  it("does not complete intake when evidence verification fails", async () => {
    const fake = services({
      verifyEvidence: vi.fn(async () => {
        throw new Error("evidence failed");
      }),
    });
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.complete-return-intake"]?.(
        request({ facilityId: "fac_east", returnShipmentId: "rsh_01", evidence: [] }),
      ),
    ).rejects.toThrow("evidence failed");
    expect(fake.completeFacilityIntake).not.toHaveBeenCalled();
  });

  it("rejects correction for an unresolved shipment before its command", async () => {
    const fake = services({ resolveForIntake: vi.fn(async () => ({ outcome: "not-found" as const })) });
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.correct-return-intake"]?.(
        request({ facilityId: "fac_east", returnShipmentId: "rsh_01" }),
      ),
    ).rejects.toThrow("Return shipment was not found.");
    expect(fake.commandHandler).not.toHaveBeenCalled();
  });

  it("does not record an unidentified package when evidence verification fails", async () => {
    const fake = services({
      verifyEvidence: vi.fn(async () => {
        throw new Error("evidence failed");
      }),
    });
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.record-unidentified-return-package"]?.(
        request({ facilityId: "fac_east", unidentifiedPackageId: "urp_01", evidence: [] }),
      ),
    ).rejects.toThrow("evidence failed");
    expect(fake.unidentifiedPackageCommandHandler).not.toHaveBeenCalled();
  });

  it("rejects reconciliation for an unknown unidentified package before resolution", async () => {
    const fake = services({ getUnidentifiedPackage: vi.fn(async () => null) });
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.reconcile-unidentified-return-package"]?.(
        request({ unidentifiedPackageId: "urp_01", returnShipmentId: "rsh_01" }),
      ),
    ).rejects.toThrow("Unidentified package was not found.");
    expect(fake.resolveForIntake).not.toHaveBeenCalled();
    expect(fake.unidentifiedPackageCommandHandler).not.toHaveBeenCalled();
  });

  it("rejects reconciliation when the shipment is not expected at the package facility", async () => {
    const fake = services({ resolveForIntake: vi.fn(async () => ({ outcome: "not-found" as const })) });
    const handlers = createFulfillmentReturnIntakeMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["fulfillment.reconcile-unidentified-return-package"]?.(
        request({ unidentifiedPackageId: "urp_01", returnShipmentId: "rsh_01" }),
      ),
    ).rejects.toThrow("Return shipment is not expected at this facility.");
    expect(fake.unidentifiedPackageCommandHandler).not.toHaveBeenCalled();
  });
});
