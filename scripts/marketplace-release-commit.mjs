const RELEASE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

export function validateReleaseCommit(label, value, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} releaseCommit is required.`);
    return;
  }
  if (!RELEASE_COMMIT_PATTERN.test(value.trim())) {
    errors.push(`${label} releaseCommit must be a 40-character Git commit SHA.`);
  }
}
