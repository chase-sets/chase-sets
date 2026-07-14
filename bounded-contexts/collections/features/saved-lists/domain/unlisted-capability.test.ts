import { describe, expect, it } from "vitest";
import type { SavedListCommandId, SavedListId } from "./contracts";
import { createSavedListCapabilityService, savedListCapabilityVerifierMatches } from "./unlisted-capability";

describe("Saved List unlisted capabilities", () => {
  it("issues replayable 256-bit secrets while persisting only one-way verifiers", () => {
    const service = createSavedListCapabilityService({
      activeKeyId: "primary",
      keys: [{ id: "primary", secret: "a".repeat(32) }],
    });
    const input = {
      listId: "svl_capability" as SavedListId,
      commandId: "slc_rotate" as SavedListCommandId,
    };
    const first = service.mint(input);
    const retry = service.reissue({ ...input, keyId: first.keyId });

    expect(first.secret).toMatch(/^sl1\.primary\.[A-Za-z0-9_-]{43}$/);
    expect(retry).toBe(first.secret);
    expect(first.verifier).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.verifier).not.toContain(first.secret);
    expect(service.verifierFor(first.secret)).toBe(first.verifier);
    expect(savedListCapabilityVerifierMatches(service.verifierFor(first.secret), first.verifier)).toBe(true);
  });
});
