import { describe, expect, it } from "vitest";
import { collisionFixtureVector, deriveCollisionProjection } from "./collision-path.mts";
import { RouteCensusError } from "./errors.mts";
import { loadTargetHonoAuthority } from "./target-authority.mts";
import { repoRoot } from "./test-support.mjs";

describe("target-derived collision path vector", () => {
  it("executes every mount, optional, custom, wildcard, trailing, and malformed vector", async () => {
    const authority = await loadTargetHonoAuthority(repoRoot);
    expect(authority.packageVersion).toBe("4.12.18");
    expect(authority.moduleRealpath.toLowerCase()).toContain(repoRoot.toLowerCase());
    expect(authority.helperExports).toEqual(["mergePath", "checkOptionalParameter", "splitRoutingPath", "getPattern"]);
    const projections = new Map();
    for (const vector of collisionFixtureVector.cases) {
      if ("error" in vector) {
        expect(
          () => deriveCollisionProjection(vector.mountPath, vector.rawPath, authority.helpers),
          vector.id,
        ).toThrowError(expect.objectContaining({ code: vector.error }));
      } else {
        const actual = deriveCollisionProjection(vector.mountPath, vector.rawPath, authority.helpers);
        expect(actual.combinedPath, vector.id).toBe(vector.combinedPath);
        expect(actual.collisionShape, vector.id).toEqual(vector.collisionShape);
        expect(actual.acceptedPathProjections, vector.id).toEqual(vector.acceptedPathProjections);
        projections.set(vector.id, actual.collisionShape);
      }
    }
    for (const relation of collisionFixtureVector.relations) {
      const equal = JSON.stringify(projections.get(relation.left)) === JSON.stringify(projections.get(relation.right));
      expect(equal, relation.id).toBe(relation.result === "collide");
    }
    expect(projections.get("mounted-root-r0313")).toEqual(["/api/customer-feedback"]);
  });

  it("fails unknown colon-leading grammar by construction", async () => {
    const authority = await loadTargetHonoAuthority(repoRoot);
    expect(() => deriveCollisionProjection("/", "/:{nope", authority.helpers)).toThrowError(RouteCensusError);
  });
});
