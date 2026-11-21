import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockActivate, mockRequireActor } = vi.hoisted(() => ({ mockActivate: vi.fn(), mockRequireActor: vi.fn() }));

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  requireActorFromAuthApi: mockRequireActor,
}));

vi.mock("../../features/listing-evidence-policy/api/client", () => ({
  ListingEvidencePolicyRequestError: class extends Error {},
  activateListingEvidencePolicyDraft: mockActivate,
  createListingEvidencePolicyDraft: vi.fn(),
  createListingEvidencePolicyRollbackDraft: vi.fn(),
  loadListingEvidencePolicyOverview: vi.fn(),
  loadListingEvidencePolicySelectors: vi.fn(),
  rejectListingEvidencePolicyDraft: vi.fn(),
  validateListingEvidencePolicyDraft: vi.fn(),
}));

import { action } from "./listing-evidence-policy";

async function activate(values: Record<string, string>) {
  const request = new Request("https://admin.chasesets.test/listing-evidence-policy", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      intent: "activate",
      policyId: "pol_draft",
      impactAcknowledged: "yes",
      impactAcknowledgmentHash: "sha256:impact",
      ...values,
    }).toString(),
  });
  return action({ request, params: {}, context: undefined } as never);
}

describe("Listing Evidence Policy activation times", () => {
  beforeEach(() => {
    mockRequireActor.mockResolvedValue({ accountId: "acc_ops", permissions: ["listing-evidence-policy.activate"] });
    mockActivate.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("activates at the instants the operator's browser read", async () => {
    await activate({
      effectiveFromLocal: "2026-11-01T09:00",
      effectiveFrom: "2026-11-01T14:00:00.000Z",
      effectiveUntilLocal: "",
      effectiveUntil: "",
    });

    expect(mockActivate).toHaveBeenCalledWith(expect.anything(), "pol_draft", {
      effectiveFrom: "2026-11-01T14:00:00.000Z",
      effectiveUntil: null,
      impactAcknowledgmentHash: "sha256:impact",
    });
  });

  it.each([
    ["a start with no zone", { effectiveFrom: "2026-11-01T09:00" }],
    ["a typed start the browser could not read", { effectiveFromLocal: "2026-03-08T02:30", effectiveFrom: "" }],
    ["an end with no zone", { effectiveFrom: "2026-11-01T14:00:00.000Z", effectiveUntil: "2026-12-01T09:00" }],
  ])("refuses %s instead of reading it in the server's zone", async (_case, values) => {
    const result = await activate(values);

    expect(result).toEqual({
      validation: null,
      error: "Enter each effective time as a date and time. The policy was not activated.",
    });
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it("still asks for a start", async () => {
    const result = await activate({ effectiveFromLocal: "", effectiveFrom: "" });

    expect(result).toMatchObject({ validation: null });
    expect(mockActivate).not.toHaveBeenCalled();
  });
});
