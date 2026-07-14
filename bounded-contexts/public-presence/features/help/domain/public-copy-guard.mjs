const launchLanguagePatterns = [
  /\b(future|intended|planned|expected)\b/i,
  /will be published/i,
  /production promotion approval/i,
];

const agentCommercePatterns = [
  /\bUCP\b/i,
  /\bAP2\b/i,
  /\bagentic\b/i,
  /\bAI agent\b/i,
  /\bagent[-\s]?commerce\b/i,
  /\bagent checkout\b/i,
  /\bautonomous payment\b/i,
  /\bheadless checkout\b/i,
  /\bheadless completion\b/i,
  /\bpayment handler\b/i,
  /\bShared Payment Token\b/i,
  /\bSPT\b/i,
];

const patternsByGuard = {
  "launch-language": launchLanguagePatterns,
  "agent-commerce": agentCommercePatterns,
};

export function findPublicCopyViolations({ corpus, copy, guard }) {
  const patterns = patternsByGuard[guard];
  if (!patterns) throw new Error(`Unknown public-copy guard '${guard}'.`);
  if (corpus === "developer") return [];
  if (corpus !== "consumer") throw new Error(`Unknown public-copy corpus '${corpus}'.`);
  return patterns.filter((pattern) => pattern.test(copy)).map((pattern) => pattern.source);
}

export function assertPublicCopyGuard(input) {
  const violations = findPublicCopyViolations(input);
  if (violations.length > 0) {
    throw new Error(`${input.corpus} ${input.guard} copy violations: ${violations.join(", ")}`);
  }
}
