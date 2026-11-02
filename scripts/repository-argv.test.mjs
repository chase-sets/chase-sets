import { describe, expect, it } from "vitest";
import { GITHUB_REPOSITORY, withGithubRepository } from "./lib/github-repository.mjs";

describe("GitHub repository pinning", () => {
  it("adds the explicit Chase Sets repository selector", () => {
    expect(withGithubRepository(["secret", "set", "NAME"])).toEqual([
      "secret",
      "set",
      "NAME",
      "--repo",
      GITHUB_REPOSITORY,
    ]);
  });

  it("fails closed when a candidate argv loses its repository selector", () => {
    const candidate = withGithubRepository(["secret", "set", "NAME"]);
    const missingSelectorMutant = candidate.filter(
      (argument) => argument !== "--repo" && argument !== GITHUB_REPOSITORY,
    );
    expect(missingSelectorMutant).not.toContain("--repo");
    expect(missingSelectorMutant).not.toContain(GITHUB_REPOSITORY);
    expect(candidate).toContain("--repo");
    expect(candidate).toContain(GITHUB_REPOSITORY);
  });
});
