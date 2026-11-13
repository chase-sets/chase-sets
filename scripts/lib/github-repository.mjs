// Pin production GitHub CLI calls so checkout remotes cannot change targets.
export const GITHUB_REPOSITORY = "chase-sets/chase-sets";

export function withGithubRepository(args) {
  return [...args, "--repo", GITHUB_REPOSITORY];
}
