import { afterEach, describe, expect, it, vi } from "vitest";
import { ListingEvidencePolicyRequestError, validateListingEvidencePolicyDraft } from "./client";

const request = () => new Request("https://admin.test/platform/listing-evidence-policy", { method: "POST" });

afterEach(() => vi.unstubAllGlobals());

describe("validateListingEvidencePolicyDraft", () => {
  it("answers an invalid draft's 422 as its validation, diagnostics included", async () => {
    const invalid = {
      documentId: "pol_draft",
      version: 2,
      valid: false,
      diagnostics: [{ path: "rules[0].minimumPhotoCount", code: "minimum", message: "Must be at least 1." }],
      policyHash: "sha256:draft",
      semanticDiff: { addedRuleIds: [], changedRuleIds: [], removedRuleIds: [] },
      impactPreview: { impactedListingCount: 0, sample: [], previewHash: "sha256:impact" },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(invalid, { status: 422 }));
    vi.stubGlobal("fetch", fetch);

    await expect(validateListingEvidencePolicyDraft(request(), "pol_draft")).resolves.toEqual(invalid);
    expect(String(fetch.mock.calls[0]![0])).toMatch(/\/drafts\/pol_draft\/validate$/);
  });

  it("still refuses any other failure with the API's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ error: { code: "validation_failed", message: "Draft is not validatable." } }, { status: 400 }),
      ),
    );

    const answer = validateListingEvidencePolicyDraft(request(), "pol_draft");
    await expect(answer).rejects.toBeInstanceOf(ListingEvidencePolicyRequestError);
    await expect(answer).rejects.toThrow("Draft is not validatable.");
  });
});
