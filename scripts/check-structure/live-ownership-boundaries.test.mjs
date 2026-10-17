import { describe, expect, it } from "vitest";
import { findAuthOwnershipViolations, findDeployableBoundaryViolation } from "./run.mjs";

describe("Auth ownership", () => {
  const nouns = ["authentication", "session-journey", "account-selection"];

  it.each(nouns)("rejects missing %s ownership", (missing) => {
    expect(
      findAuthOwnershipViolations({ contextName: "auth", ownedNouns: nouns.filter((noun) => noun !== missing) }),
    ).toEqual([`Auth must own ${missing}`]);
  });

  it("rejects absent ownership metadata", () => {
    expect(findAuthOwnershipViolations({ contextName: "auth" })).toEqual(nouns.map((noun) => `Auth must own ${noun}`));
  });

  it("accepts Auth's owned nouns and does not impose them on other contexts", () => {
    expect(findAuthOwnershipViolations({ contextName: "auth", ownedNouns: nouns })).toEqual([]);
    expect(findAuthOwnershipViolations({ contextName: "identity", ownedNouns: ["account"] })).toEqual([]);
  });
});

describe("thin deployable boundaries", () => {
  it.each([
    ["deployables/marketplace/app/api.server.ts", "", "deployables must not define local business API helpers"],
    [
      "deployables/platform-api/src/stack.ts",
      "",
      "API deployables must not keep hand-written stack composition modules",
    ],
    [
      "deployables/platform-api/src/seed-stack.ts",
      "",
      "API deployables must not keep hand-written seed stack composition modules",
    ],
    [
      "deployables/marketplace/app/routes/cart.test.tsx",
      'import { cart } from "@chase-sets/checkout/client";',
      "deployable tests must not depend on bounded-context client surfaces",
    ],
  ])("rejects %s", (file, content, diagnostic) => {
    expect(findDeployableBoundaryViolation(file, content)).toBe(diagnostic);
  });

  it.each([
    ["bounded-contexts/checkout/features/cart/api/api.server.ts", ""],
    [
      "bounded-contexts/checkout/features/cart/tests/cart.test.ts",
      'import { cart } from "@chase-sets/checkout/client";',
    ],
    ["deployables/platform-api/src/main.ts", 'import { module } from "@chase-sets/checkout";'],
    ["deployables/marketplace/app/routes/cart.test.tsx", 'import { loader } from "./cart";'],
  ])("accepts the live boundary shape %s", (file, content) => {
    expect(findDeployableBoundaryViolation(file, content)).toBeNull();
  });
});
