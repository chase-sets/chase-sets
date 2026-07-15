import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { FulfillmentApiEnv } from "../../../api";
import { createReturnIntakeRoutes } from "./route";
import type { FulfillmentReturnShipmentServices } from "./runtime";

function services(overrides: Record<string, unknown> = {}): FulfillmentReturnShipmentServices {
  return {
    listFacilityIntakeQueue: vi.fn(async () => []),
    listUnidentifiedPackages: vi.fn(async () => []),
    getIntakeMetrics: vi.fn(async () => ({ delivered_not_intaken_count: 0 })),
    resolveForIntake: vi.fn(async () => ({ outcome: "not-found" })),
    getReturnShipmentVersion: vi.fn(async () => 1),
    getEvidenceReference: vi.fn(async () => null),
    getEvidence: vi.fn(async () => null),
    verifyEvidence: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as FulfillmentReturnShipmentServices;
}

function appWithActor(service: ReturnType<typeof services>, permissions: readonly string[]) {
  const app = new Hono<FulfillmentApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_1",
      tenantId: "tnt_1",
      userId: "usr_operator",
      accountId: "acc_platform",
      membershipId: "mbr_1",
      roleKey: "fulfillment",
      permissions,
    });
    c.set("context", {
      tenantId: "tnt_1" as never,
      audit: { performedByUserId: "usr_operator" as never, forAccountId: "acc_platform" as never },
    });
    await next();
  });
  app.route("/operations/return-intake", createReturnIntakeRoutes(service));
  return app;
}

describe("return intake API authorization", () => {
  it("rejects an operator without the dedicated permission", async () => {
    const response = await appWithActor(services(), ["fulfillment.manage"]).request(
      "/operations/return-intake?facilityId=fac_east",
    );
    expect(response.status).toBe(403);
  });

  it("scopes queue reads to the requested facility", async () => {
    const service = services();
    const response = await appWithActor(service, ["return-intake.view"]).request(
      "/operations/return-intake?facilityId=fac_east",
    );
    expect(response.status).toBe(200);
    expect(service.listFacilityIntakeQueue).toHaveBeenCalledWith("fac_east");
    expect(service.listUnidentifiedPackages).toHaveBeenCalledWith("fac_east");
  });

  it("does not mutate a Return Shipment expected at another facility", async () => {
    const completeFacilityIntake = vi.fn();
    const service = services({ completeFacilityIntake });
    const response = await appWithActor(service, ["return-intake.manage"]).request(
      "/operations/return-intake/rsh_1/complete",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facilityId: "fac_west" }),
      },
    );
    expect(response.status).toBe(404);
    expect(completeFacilityIntake).not.toHaveBeenCalled();
  });

  it("stops serving evidence at the retention boundary", async () => {
    const getEvidence = vi.fn();
    const service = services({
      getEvidence,
      getEvidenceReference: vi.fn(async () => ({
        attachment_id: "rie_1",
        storage_key: "private/key.jpg",
        content_type: "image/jpeg",
        retention_until: "2020-01-01T00:00:00.000Z",
      })),
    });
    const response = await appWithActor(service, ["return-intake.view"]).request(
      "/operations/return-intake/evidence/rie_1?facilityId=fac_east",
    );
    expect(response.status).toBe(410);
    expect(getEvidence).not.toHaveBeenCalled();
  });

  it("serves retained evidence only through a facility-scoped private response", async () => {
    const getEvidenceReference = vi.fn(async () => ({
      attachment_id: "rie_1",
      storage_key: "return-intake/fac_east/rie_1/hash.jpg",
      content_type: "image/jpeg",
      retention_until: "2099-01-01T00:00:00.000Z",
    }));
    const service = services({
      getEvidenceReference,
      getEvidence: vi.fn(async () => ({ body: new Uint8Array([0xff, 0xd8, 0xff]), contentType: "image/jpeg" })),
    });
    const response = await appWithActor(service, ["return-intake.view"]).request(
      "/operations/return-intake/evidence/rie_1?facilityId=fac_east",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(getEvidenceReference).toHaveBeenCalledWith("rie_1", "fac_east");
  });
});
