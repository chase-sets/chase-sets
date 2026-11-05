import { demoIdentitySeedIds as contractDemoIds, identitySeedIds as contractIds } from "@chase-sets/identity-seed";
import { describe, expect, it } from "vitest";
import { demoIdentitySeedIds, identitySeedIds } from "./ids";

describe("Identity seed compatibility surface", () => {
  it("re-exports the canonical identity seed contract", () => {
    expect(identitySeedIds).toBe(contractIds);
    expect(demoIdentitySeedIds).toBe(contractDemoIds);
  });
});
// Never-merged hosted probe for W3 enrollment selection; this PR is closed unmerged.
