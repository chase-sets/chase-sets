import { describe, expect, it } from "vitest";
import { GITHUB_REPOSITORY, withGithubRepository } from "./lib/github-repository.mjs";

describe("GitHub repository pinning", () => {
  const assertPinned = (args) => {
    expect(args).toContain("--repo");
    expect(args).toContain(GITHUB_REPOSITORY);
  };

  it("adds the explicit Chase Sets repository selector", () => {
    const candidate = withGithubRepository(["secret", "set", "NAME"]);
    expect(candidate).toEqual(["secret", "set", "NAME", "--repo", GITHUB_REPOSITORY]);
    assertPinned(candidate);
  });

  it("fails closed when a candidate argv loses its repository selector", () => {
    const candidate = withGithubRepository(["secret", "set", "NAME"]);
    const missingSelectorMutant = candidate.filter(
      (argument) => argument !== "--repo" && argument !== GITHUB_REPOSITORY,
    );
    expect(() => assertPinned(missingSelectorMutant)).toThrow();
    assertPinned(candidate);
  });
});
