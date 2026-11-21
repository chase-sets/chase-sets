import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateRevision } = vi.hoisted(() => ({ mockCreateRevision: vi.fn() }));

vi.mock("../../support/request-support/policy-console-client", () => ({
  PolicyConsoleValidationError: class extends Error {},
  createPolicyConsoleRevision: mockCreateRevision,
  loadPolicyConsoleDocument: vi.fn(),
  loadPolicyConsoleOverview: vi.fn(),
}));

import { action } from "./policy-console-detail";

async function post(values: Record<string, string>) {
  const request = new Request("https://admin.chasesets.test/platform/policy-console/settlement.clearance-window", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "create-revision", value: "{}", status: "active", ...values }).toString(),
  });
  return action({ request, params: { policyKey: "settlement.clearance-window" }, context: undefined } as never);
}

describe("Policy Console revision effective times", () => {
  beforeEach(() => {
    mockCreateRevision.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("schedules the instants the operator's browser read", async () => {
    const response = (await post({
      effectiveFromLocal: "2026-11-01T09:00",
      effectiveFrom: "2026-11-01T14:00:00.000Z",
      effectiveUntilLocal: "2026-12-01T09:00",
      effectiveUntil: "2026-12-01T15:00:00.000Z",
    })) as Response;

    expect(response.status).toBe(302);
    expect(mockCreateRevision).toHaveBeenCalledWith(
      expect.anything(),
      "settlement.clearance-window",
      expect.objectContaining({
        effectiveFrom: "2026-11-01T14:00:00.000Z",
        effectiveUntil: "2026-12-01T15:00:00.000Z",
      }),
    );
  });

  it("applies a blank start now and leaves a blank end open", async () => {
    await post({ effectiveFromLocal: "", effectiveFrom: "", effectiveUntilLocal: "", effectiveUntil: "" });

    const sent = mockCreateRevision.mock.calls[0]![2] as { effectiveFrom: string; effectiveUntil: string | null };
    expect(Math.abs(Date.parse(sent.effectiveFrom) - Date.now())).toBeLessThan(60_000);
    expect(sent.effectiveUntil).toBeNull();
  });

  it.each([
    ["a start with no zone", { effectiveFrom: "2026-11-01T09:00" }],
    ["a typed start the browser could not read", { effectiveFromLocal: "2026-03-08T02:30", effectiveFrom: "" }],
    ["an end with no zone", { effectiveUntil: "2026-12-01T09:00" }],
  ])("refuses %s instead of reading it in the server's zone", async (_case, values) => {
    const result = await post(values);

    expect(result).toEqual({
      error: "Enter each effective time as a date and time, or leave it blank. Nothing was saved.",
    });
    expect(mockCreateRevision).not.toHaveBeenCalled();
  });
});
