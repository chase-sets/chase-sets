import { readFile } from "node:fs/promises";
import path from "node:path";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";
import { repoRoot } from "./lib/repo.mjs";

const fulfillmentRoot = path.join(repoRoot, "bounded-contexts", "fulfillment");
const checkedExtensions = new Set([".json", ".ts", ".tsx"]);
const forbiddenPatterns = [
  "@chase-sets/easypost-postage",
  "@chase-sets/postage-labels-testing",
  "api.easypost.com",
];
const violations = [];

for (const filePath of await collectFiles(fulfillmentRoot, {
  extensions: checkedExtensions,
  skippedDirectories: defaultSkippedDirectories,
})) {
  const contents = await readFile(filePath, "utf8");
  for (const pattern of forbiddenPatterns) {
    if (contents.includes(pattern)) {
      violations.push({ filePath, pattern });
    }
  }
}

if (violations.length > 0) {
  console.error("Postage provider implementations must stay outside fulfillment.");
  for (const violation of violations) {
    console.error(
      `- ${path.relative(repoRoot, violation.filePath)} contains ${JSON.stringify(
        violation.pattern,
      )}`,
    );
  }
  process.exit(1);
}

console.log("Postage adapter boundaries are clean.");
