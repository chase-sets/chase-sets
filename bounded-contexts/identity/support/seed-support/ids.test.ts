import { demoIdentitySeedIds as contractDemoIds, identitySeedIds as contractIds } from "@chase-sets/identity-seed";
import { describe, expect, it } from "vitest";
import { demoIdentitySeedIds, identitySeedIds } from "./ids";

describe("Identity seed compatibility surface", () => {
  it("re-exports the canonical identity seed contract", () => {
    expect(identitySeedIds).toBe(contractIds);
    expect(demoIdentitySeedIds).toBe(contractDemoIds);
  });
});
