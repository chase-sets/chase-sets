const REQUIRED_DIMENSIONS = ["Correctness", "Simplicity", "Elegance", "Performance", "Footprint"];
const REQUIRED_FIELDS = [
  "Dimensions passed",
  "Edits per dimension",
  "Enforcement pairs checked",
  "Reproduction and results",
  "Unverifiable assumptions",
];

export const MAX_SELF_REVIEW_SECTION_BYTES = 2048;

export function extractSelfReviewSection(skill) {
  const match = /### Self-review snippet[\s\S]*?```markdown\r?\n([\s\S]*?)\r?\n```/.exec(skill);
  return match?.[1] ?? "";
}

export function selfReviewSectionErrors(section) {
  const errors = [];
  if (!section.startsWith("## Self-review\n")) errors.push("missing heading");
  if (Buffer.byteLength(section, "utf8") > MAX_SELF_REVIEW_SECTION_BYTES) errors.push("section exceeds 2048 bytes");

  for (const field of REQUIRED_FIELDS) {
    const match = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(section);
    if (!match) errors.push(`missing required field: ${field}`);
  }

  const dimensions = /^Dimensions passed:\s*(.+)$/m.exec(section)?.[1] ?? "";
  for (const dimension of REQUIRED_DIMENSIONS) {
    if (!dimensions.includes(dimension)) errors.push(`missing required dimension: ${dimension}`);
  }
  return errors;
}
