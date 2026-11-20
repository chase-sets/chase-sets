import { describe, expect, it, vi } from "vitest";

vi.mock("../../features/listing-evidence-policy/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../features/listing-evidence-policy/api/client")>();
  return {
    ...actual,
    createListingEvidencePolicyDraft: vi.fn(async () => ({})),
    rejectListingEvidencePolicyDraft: vi.fn(async () => ({})),
    createListingEvidencePolicyRollbackDraft: vi.fn(async () => ({})),
    activateListingEvidencePolicyDraft: vi.fn(async () => ({})),
  };
});

const { action } = await import("./listing-evidence-policy");

function post(fields: Record<string, string>) {
  return action({
    request: new Request("https://admin.test/platform/listing-evidence-policy", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    params: {},
    context: {},
  } as never);
}

describe("Listing Evidence Policy writes", () => {
  it.each([
    ["create-draft", { policyName: "Graded slabs", rules: "[]" }],
    ["reject", { policyId: "lep_1" }],
    ["rollback", { policyId: "lep_1" }],
    [
      "activate",
      {
        policyId: "lep_1",
        impactAcknowledged: "yes",
        effectiveFrom: "2026-11-20T00:00:00.000Z",
        impactAcknowledgmentHash: "sha256:abc",
      },
    ],
  ])("%s returns the operator to the page in admin-web's Platform section", async (intent, fields) => {
    const response = await post({ intent, ...fields });
    expect(response).toBeInstanceOf(Response);
    const location = new URL((response as Response).headers.get("Location") ?? "", "https://admin.test");
    expect(location.pathname).toBe("/platform/listing-evidence-policy");
  });
});
