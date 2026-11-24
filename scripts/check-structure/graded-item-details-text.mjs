// Keeps code from branching on the text of Graded Item Details.
//
// `gradingCompany` and `grade` in the `gradedCard` snapshot are display copies
// of the selected Options' labels. Readers may branch on presence of
// `gradedCard`, never on that text. The rule and its recorded exceptions are
// the Graded Item Details entry in bounded-contexts/inventory/GLOSSARY.md.
//
// This is a text scan, not a syntax-tree check. It reports direct uses only: a
// value copied into another variable first is not caught, and a matching
// comment or string literal is.

export const gradedItemDetailsGlossaryPath = "bounded-contexts/inventory/GLOSSARY.md";
export const gradedItemDetailsGlossaryHeading = "Graded Item Details";

const gradedItemDetailsTextGuardExtensions = new Set([".ts", ".tsx"]);
const gradedItemDetailsTextGuardRoots = ["bounded-contexts/", "contracts/", "deployables/", "infrastructure/"];

// Inventory's item slice is the only writer of the text. It derives both
// fields from the selection and compares a supplied copy with it.
const gradedItemDetailsWriterRoot = "bounded-contexts/inventory/features/inventory-items/";

// Recorded exceptions. A listed file that no longer matches is reported as
// stale, so this list can only shrink.
export const gradedItemDetailsTextExceptions = [
  "bounded-contexts/discovery/features/item-detail/ui/commerce/purchase-section.tsx",
  "bounded-contexts/platform-operations/features/seller-compliance-cohorts/domain/cohort-window.ts",
];

const receiverChain = String.raw`(?:(?:[\w$]+|\([^()]*\))[?!]?\s*\.\s*)*`;
// A `typeof` test asks whether the field is a string, not what it says.
const text = String.raw`(?<text>(?<!\btypeof\s+(?:[\w$]+[?!]?\.)*)(?:\bgradingCompany\b|\bgraded\w*[?!]?\.grade\b))`;
const derivedText = String.raw`(?:\s*\??\.\s*[\w$]+|\s*\([^()]*\)|!)*`;
const comparison = String.raw`(?:===|!==|==|!=)`;
const stringTest = String.raw`\.\s*(?:includes|has|startsWith|endsWith|match|test)\s*\(`;

const gradedItemDetailsTextUsePatterns = [
  { use: "compares", pattern: new RegExp(`${text}${derivedText}\\s*${comparison}`, "dg") },
  { use: "compares", pattern: new RegExp(`${comparison}\\s*${receiverChain}${text}`, "dg") },
  { use: "switches on", pattern: new RegExp(`\\bswitch\\s*\\(\\s*${receiverChain}${text}`, "dg") },
  { use: "string-tests", pattern: new RegExp(`${text}${derivedText}\\s*\\??${stringTest}`, "dg") },
  { use: "string-tests", pattern: new RegExp(`${stringTest}\\s*${receiverChain}${text}`, "dg") },
];

function isTestFile(relativeFile) {
  return (
    relativeFile.includes("/tests/") ||
    relativeFile.includes("/__tests__/") ||
    relativeFile.endsWith(".test.ts") ||
    relativeFile.endsWith(".test.tsx")
  );
}

export function isGradedItemDetailsTextGuardedFile(relativeFile, extension) {
  return (
    gradedItemDetailsTextGuardExtensions.has(extension) &&
    gradedItemDetailsTextGuardRoots.some((root) => relativeFile.startsWith(root)) &&
    !relativeFile.startsWith(gradedItemDetailsWriterRoot) &&
    !isTestFile(relativeFile)
  );
}

export function findGradedItemDetailsTextUses(content) {
  const uses = new Map();

  for (const { use, pattern } of gradedItemDetailsTextUsePatterns) {
    for (const match of content.matchAll(pattern)) {
      const [start, end] = match.indices.groups.text;
      const line = content.slice(0, start).split("\n").length;
      const field = content.slice(start, end).endsWith("gradingCompany") ? "gradingCompany" : "grade";
      uses.set(`${line}:${use}:${field}`, { line, use, field });
    }
  }

  return [...uses.values()].sort((left, right) => left.line - right.line);
}

export function findGradedItemDetailsTextViolations({ relativeFile, content }) {
  const uses = findGradedItemDetailsTextUses(content);
  const entry = `the ${gradedItemDetailsGlossaryHeading} entry in ${gradedItemDetailsGlossaryPath}`;

  if (gradedItemDetailsTextExceptions.includes(relativeFile)) {
    return uses.length > 0
      ? []
      : [
          `is a recorded exception to ${entry} but no longer compares, switches on or string-tests gradingCompany or grade text; remove it from gradedItemDetailsTextExceptions`,
        ];
  }

  return uses.map(
    ({ line, use, field }) =>
      `line ${line} ${use} the ${field} text of gradedCard; it is a display copy of the selected Option's label, so branch on presence of gradedCard instead (see ${entry})`,
  );
}
