import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const adminControlPlaneDir = dirname(fileURLToPath(import.meta.url));

// Guard for the P1 command-surface-consolidation acceptance criterion: "No
// JSON.stringify rendered as operator-facing content in the control plane
// (guard/lint check)." The regression this replaces: the merge-candidate
// command preview used to render `JSON.stringify(commandPreview.body)` directly
// in a side sheet. The typed preview (identity, provenance, references,
// proposed facts, human-readable command summaries) is what an operator reads
// now; `JSON.stringify` survives only as plumbing for values that are never
// rendered as visible text — a hidden form input transporting a generated
// command body, and a copy-to-clipboard `value` prop for the raw-payload
// support-case disclosure (`RawCommandPayloadDisclosure`) — neither of which an
// operator reads as on-screen content.
//
// Every occurrence has been reviewed and is transport-only; this allowlist is
// closed by file, not by count, so any NEW file introducing JSON.stringify
// under this directory fails the guard until it is reviewed and added here
// with the same justification.
const ALLOWED_JSON_STRINGIFY_FILES = new Set([
  "import-to-promotion/merge-candidate-review-module.tsx",
  // `providerHintValueForUnit` serializes a provider scope hint into a hidden
  // `providerHints` form input the sync-scope form submits; never rendered.
  "import-to-promotion/catalog-sync-scope-module.tsx",
]);

function collectTsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return collectTsxFiles(fullPath);
    }
    return entry.endsWith(".tsx") && !entry.endsWith(".test.tsx") ? [fullPath] : [];
  });
}

describe("Catalog control plane — no JSON.stringify rendered as operator-facing content", () => {
  it("only allows JSON.stringify in the reviewed transport-only files", () => {
    const files = collectTsxFiles(adminControlPlaneDir);
    expect(files.length).toBeGreaterThan(0);

    const unexpected: string[] = [];
    for (const file of files) {
      const relativePath = relative(adminControlPlaneDir, file).replace(/\\/g, "/");
      const source = readFileSync(file, "utf8");
      if (source.includes("JSON.stringify(") && !ALLOWED_JSON_STRINGIFY_FILES.has(relativePath)) {
        unexpected.push(relativePath);
      }
    }

    expect(
      unexpected,
      `JSON.stringify found in a control-plane component outside the reviewed allowlist: ${unexpected.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the allowlist itself honest — every allowed file still uses JSON.stringify", () => {
    // If a listed file stops using JSON.stringify (e.g. the transport it fed was
    // removed), the entry is stale and should be deleted from the allowlist.
    for (const relativePath of ALLOWED_JSON_STRINGIFY_FILES) {
      const source = readFileSync(join(adminControlPlaneDir, relativePath), "utf8");
      expect(source.includes("JSON.stringify("), `${relativePath} no longer uses JSON.stringify`).toBe(true);
    }
  });

  it("keeps every JSON.stringify use in the allowlisted file scoped to a non-visible value (hidden input / copy value)", () => {
    const source = readFileSync(
      join(adminControlPlaneDir, "import-to-promotion/merge-candidate-review-module.tsx"),
      "utf8",
    );
    const occurrences = source.split("\n").filter((line) => line.includes("JSON.stringify("));
    expect(occurrences.length).toBeGreaterThan(0);
    for (const line of occurrences) {
      // Both known-good uses feed a value, never JSX text content: the hidden
      // input's ternary value, or the CopyButton's `value` prop (built from
      // `rawCommandPayloadFor`, itself a plain function return — never JSX
      // children).
      expect(
        /JSON\.stringify\(actionEntry\.commandPreview\.body\)|JSON\.stringify\(payloads\)/.test(line),
        `Unexpected JSON.stringify shape, review before allowing: ${line.trim()}`,
      ).toBe(true);
    }
  });
});
