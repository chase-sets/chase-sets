import { describe, expect, it, vi } from "vitest";
import { LISTING_EVIDENCE_LAUNCH_POLICY_VALUE } from "../domain/policy";
import { seedListingEvidencePolicy } from "./seed";

describe("Listing Evidence Policy seed gate", () => {
  it("installs the representative launch policy when the projection is mounted and empty", async () => {
    const createPolicyDocument = vi.fn(async () => ({ documentId: "pol_seed", version: 1 }));
    await seedListingEvidencePolicy({
      db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never,
      policies: { createPolicyDocument } as never,
    });

    expect(createPolicyDocument).toHaveBeenCalledWith(
      expect.objectContaining({ policyKey: "marketplace.listing-evidence" }),
      expect.objectContaining({ value: LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, status: "active" }),
      expect.any(Object),
    );
  });

  it("does nothing before mounting or when an active version already exists", async () => {
    const createPolicyDocument = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await seedListingEvidencePolicy({
      db: { query: vi.fn(async () => ({ rows: [{ exists: 1 }], rowCount: 1 })) } as never,
      policies: { createPolicyDocument } as never,
    });
    await seedListingEvidencePolicy({
      db: { query: vi.fn(async () => Promise.reject(new Error("projection unavailable"))) } as never,
      policies: { createPolicyDocument } as never,
    });

    expect(createPolicyDocument).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("until its policy projection is mounted"));
    log.mockRestore();
  });
});
