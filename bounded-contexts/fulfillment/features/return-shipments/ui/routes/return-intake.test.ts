import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockApi, mockRequireActor } = vi.hoisted(() => ({
  mockApi: {
    uploadReturnIntakeEvidence: vi.fn(),
    completeReturnIntake: vi.fn(),
    recordUnidentifiedReturnPackage: vi.fn(),
    reconcileUnidentifiedReturnPackage: vi.fn(),
    correctReturnIntake: vi.fn(),
  },
  mockRequireActor: vi.fn(),
}));

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  requireActorFromAuthApi: mockRequireActor,
}));

vi.mock("../../api/request-client", () => ({
  FulfillmentApiError: class extends Error {},
  createReturnIntakeRequestClient: () => mockApi,
}));

import { action } from "./return-intake";

// The receipt instant the form's local date-time field sends.
const RECEIVED_AT = "2026-11-20T20:05:00.000Z";

function formRequest(values: Record<string, string>) {
  return new Request("https://admin.chasesets.test/commerce/return-intake?facilityId=fac_east", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ facilityId: "fac_east", expectedVersion: "3", ...values }).toString(),
  });
}

async function location(values: Record<string, string>) {
  const response = (await action({
    request: formRequest(values),
    params: {},
    context: undefined,
  } as never)) as Response;
  expect(response.status).toBe(302);
  return response.headers.get("Location");
}

describe("Return Intake route action", () => {
  beforeEach(() => {
    mockRequireActor.mockResolvedValue({ accountId: "acc_ops", permissions: ["return-intake.manage"] });
    for (const write of Object.values(mockApi)) write.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns every write to the station admin-web serves under Commerce", async () => {
    expect(await location({ intent: "complete", returnShipmentId: "rsh_1", receivedAt: RECEIVED_AT })).toBe(
      "/commerce/return-intake?facilityId=fac_east&result=completed",
    );
    expect(await location({ intent: "unidentified", receivedAt: RECEIVED_AT })).toBe(
      "/commerce/return-intake?facilityId=fac_east&result=unidentified",
    );
    expect(await location({ intent: "reconcile", unidentifiedPackageId: "rup_1", returnShipmentId: "rsh_1" })).toBe(
      "/commerce/return-intake?facilityId=fac_east&result=reconciled",
    );
    expect(await location({ intent: "correct", returnShipmentId: "rsh_1", reason: "Wrong seal" })).toBe(
      "/commerce/return-intake?facilityId=fac_east&result=corrected",
    );
  });

  it("says a repeated completion was a duplicate", async () => {
    mockApi.completeReturnIntake.mockResolvedValue({ duplicate: true });

    expect(await location({ intent: "complete", returnShipmentId: "rsh_1", receivedAt: RECEIVED_AT })).toBe(
      "/commerce/return-intake?facilityId=fac_east&result=duplicate",
    );
  });
});
