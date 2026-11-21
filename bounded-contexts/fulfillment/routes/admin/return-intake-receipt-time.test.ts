import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockApi, mockRequireActor } = vi.hoisted(() => ({
  mockApi: {
    uploadReturnIntakeEvidence: vi.fn(),
    completeReturnIntake: vi.fn(),
    recordUnidentifiedReturnPackage: vi.fn(),
  },
  mockRequireActor: vi.fn(),
}));

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  requireActorFromAuthApi: mockRequireActor,
}));

vi.mock("../../support/request-support/api-client", () => ({
  FulfillmentApiError: class extends Error {},
  createFulfillmentRequestApiClient: () => mockApi,
}));

import { action } from "./return-intake";

async function post(values: Record<string, string>) {
  const request = new Request("https://admin.chasesets.test/commerce/return-intake?facilityId=fac_east", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ facilityId: "fac_east", expectedVersion: "3", ...values }).toString(),
  });
  return action({ request, params: {}, context: undefined } as never);
}

describe("Return Intake receipt time", () => {
  beforeEach(() => {
    mockRequireActor.mockResolvedValue({ accountId: "acc_ops", permissions: ["return-intake.manage"] });
    for (const write of Object.values(mockApi)) write.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("records the instant the browser read in the operator's zone", async () => {
    await post({ intent: "complete", returnShipmentId: "rsh_1", receivedAt: "2026-10-30T19:05:00.000Z" });
    await post({ intent: "unidentified", receivedAt: "2026-10-30T19:05:00.000Z" });

    expect(mockApi.completeReturnIntake).toHaveBeenCalledWith(
      "rsh_1",
      expect.objectContaining({ receivedAt: "2026-10-30T19:05:00.000Z" }),
    );
    expect(mockApi.recordUnidentifiedReturnPackage).toHaveBeenCalledWith(
      expect.objectContaining({ receivedAt: "2026-10-30T19:05:00.000Z" }),
    );
  });

  it.each([
    ["a wall-clock time with no zone", { receivedAt: "2026-10-30T14:05" }],
    ["a time it cannot read", { receivedAt: "tomorrow" }],
    ["no time", {}],
  ])("refuses %s instead of reading it in the server's zone or recording now", async (_case, values) => {
    for (const intent of ["complete", "unidentified"]) {
      const result = await post({ intent, returnShipmentId: "rsh_1", ...values });

      expect(result).toEqual({ error: "Enter the receipt time as a date and time. Nothing was recorded." });
    }
    expect(mockApi.uploadReturnIntakeEvidence).not.toHaveBeenCalled();
    expect(mockApi.completeReturnIntake).not.toHaveBeenCalled();
    expect(mockApi.recordUnidentifiedReturnPackage).not.toHaveBeenCalled();
  });
});
