import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import {
  findGradedItemDetailsTextUses,
  findGradedItemDetailsTextViolations,
  gradedItemDetailsGlossaryHeading,
  gradedItemDetailsGlossaryPath,
  gradedItemDetailsTextExceptions,
  isGradedItemDetailsTextGuardedFile,
} from "./graded-item-details-text.mjs";

const readerFile = "bounded-contexts/ordering/features/orders/domain/domain.ts";
const registryLinkFile = "bounded-contexts/discovery/features/item-detail/ui/commerce/purchase-section.tsx";
const cohortWindowFile =
  "bounded-contexts/platform-operations/features/seller-compliance-cohorts/domain/cohort-window.ts";
const schemaFile = "contracts/primitives/graded-card-snapshot.ts";

function readRepoFile(relativeFile) {
  return readFileSync(path.join(repoRoot, relativeFile), "utf8").replaceAll("\r\n", "\n");
}

function usesIn(content) {
  return findGradedItemDetailsTextUses(content).map(({ line, use, field }) => `${line} ${use} ${field}`);
}

function kindsIn(content) {
  return [...new Set(findGradedItemDetailsTextUses(content).map(({ use, field }) => `${use} ${field}`))];
}

function violationsIn(relativeFile, content) {
  return findGradedItemDetailsTextViolations({ relativeFile, content });
}

function glossaryEntry(relativeFile, heading) {
  const lines = readRepoFile(relativeFile).split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) {
    return null;
  }
  const length = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
  return lines.slice(start + 1, length === -1 ? undefined : start + 1 + length);
}

function schemaDocComment() {
  const source = readRepoFile(schemaFile);
  const end = source.indexOf("\nexport const gradedCardSnapshotSchema = ");
  const start = source.lastIndexOf("/**", end);
  return source
    .slice(start, end)
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\/\*\*|\*\/|\*)\s?/, ""));
}

function bullets(lines) {
  return lines.filter((line) => line.startsWith("- "));
}

describe("graded item details text guard", () => {
  it("guards TypeScript sources in bounded contexts, contracts, deployables and infrastructure", () => {
    expect(isGradedItemDetailsTextGuardedFile(readerFile, ".ts")).toBe(true);
    expect(isGradedItemDetailsTextGuardedFile(registryLinkFile, ".tsx")).toBe(true);
    expect(isGradedItemDetailsTextGuardedFile(schemaFile, ".ts")).toBe(true);
    expect(isGradedItemDetailsTextGuardedFile("deployables/platform-api/src/listing-target-authority.ts", ".ts")).toBe(
      true,
    );
    expect(isGradedItemDetailsTextGuardedFile("infrastructure/platform-runtime/http.ts", ".ts")).toBe(true);
  });

  it("skips other roots and extensions, test files, tests folders and the Inventory item slice", () => {
    expect(isGradedItemDetailsTextGuardedFile("packages/design-system/src/components/ui/marketplace.tsx", ".tsx")).toBe(
      false,
    );
    expect(isGradedItemDetailsTextGuardedFile("scripts/check-structure/graded-item-details-text.mjs", ".mjs")).toBe(
      false,
    );
    expect(isGradedItemDetailsTextGuardedFile("bounded-contexts/inventory/GLOSSARY.md", ".md")).toBe(false);
    expect(
      isGradedItemDetailsTextGuardedFile("bounded-contexts/ordering/features/orders/domain/domain.mjs", ".mjs"),
    ).toBe(false);
    expect(
      isGradedItemDetailsTextGuardedFile("bounded-contexts/ordering/features/orders/domain/domain.test.ts", ".ts"),
    ).toBe(false);
    expect(
      isGradedItemDetailsTextGuardedFile("bounded-contexts/discovery/features/item-detail/ui/page.test.tsx", ".tsx"),
    ).toBe(false);
    expect(isGradedItemDetailsTextGuardedFile("bounded-contexts/marketplace/tests/support/listings.ts", ".ts")).toBe(
      false,
    );
    expect(isGradedItemDetailsTextGuardedFile("deployables/platform-api/__tests__/support/listings.ts", ".ts")).toBe(
      false,
    );
    expect(
      isGradedItemDetailsTextGuardedFile("bounded-contexts/inventory/features/inventory-items/api/runtime.ts", ".ts"),
    ).toBe(false);
    expect(
      isGradedItemDetailsTextGuardedFile("bounded-contexts/inventory/features/imports/domain/domain.ts", ".ts"),
    ).toBe(true);
  });

  it("reports comparisons of the grading company text", () => {
    expect(usesIn('if (gradedCard.gradingCompany === "PSA") {}')).toEqual(["1 compares gradingCompany"]);
    expect(usesIn('if (listing.gradedCard?.gradingCompany !== "PSA") {}')).toEqual(["1 compares gradingCompany"]);
    expect(usesIn('if (gradingCompany == "PSA") {}')).toEqual(["1 compares gradingCompany"]);
    expect(usesIn('if (gradingCompany != "PSA") {}')).toEqual(["1 compares gradingCompany"]);
    expect(usesIn('if ("PSA" === line.gradedCard.gradingCompany) {}')).toEqual(["1 compares gradingCompany"]);
    expect(usesIn('const isPsa = gradedCard.gradingCompany.trim().toUpperCase() === "PSA";')).toEqual([
      "1 compares gradingCompany",
    ]);
    expect(usesIn("const same =\n  left.gradedCard.gradingCompany\n  === right.gradedCard.gradingCompany;")).toEqual([
      "2 compares gradingCompany",
      "3 compares gradingCompany",
    ]);
  });

  it("reports comparisons of the grade text on a graded receiver", () => {
    expect(usesIn('if (gradedCard.grade === "10") {}')).toEqual(["1 compares grade"]);
    expect(usesIn('if (item.gradedCard?.grade !== "10") {}')).toEqual(["1 compares grade"]);
    expect(usesIn('if ("10" === graded.grade) {}')).toEqual(["1 compares grade"]);
    expect(usesIn('if (gradedCardDetails!.grade.trim() == "10") {}')).toEqual(["1 compares grade"]);
  });

  it("reports a switch on the text", () => {
    expect(usesIn("switch (gradedCard.gradingCompany) {}")).toEqual(["1 switches on gradingCompany"]);
    expect(usesIn("switch (gradedCard.gradingCompany.trim().toUpperCase()) {}")).toEqual([
      "1 switches on gradingCompany",
    ]);
    expect(usesIn("switch (order.line.gradedCard.grade) {}")).toEqual(["1 switches on grade"]);
  });

  it("reports string tests that take the text as an argument or as the receiver", () => {
    for (const method of ["includes", "has", "startsWith", "endsWith", "match", "test"]) {
      expect(usesIn(`const known = candidates.${method}(gradedCard.gradingCompany);`)).toEqual([
        "1 string-tests gradingCompany",
      ]);
      expect(usesIn(`const known = candidates.${method}(listing.gradedCard.grade);`)).toEqual(["1 string-tests grade"]);
      expect(usesIn(`const known = gradedCard.gradingCompany.${method}(candidate);`)).toEqual([
        "1 string-tests gradingCompany",
      ]);
    }
    expect(usesIn('const isPsa = gradedCard.gradingCompany.trim().toUpperCase().startsWith("PSA");')).toEqual([
      "1 string-tests gradingCompany",
    ]);
    expect(usesIn("const isTen = /^10/.test(gradedCard?.grade);")).toEqual(["1 string-tests grade"]);
  });

  it("names the Graded Item Details entry and the line in each violation", () => {
    const violations = violationsIn(
      readerFile,
      'const line = order.line;\nif (line.gradedCard.gradingCompany === "PSA" && line.gradedCard.grade === "10") {}\n',
    );

    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("line 2 compares the gradingCompany text of gradedCard");
    expect(violations[1]).toContain("line 2 compares the grade text of gradedCard");
    for (const violation of violations) {
      expect(violation).toContain(`the ${gradedItemDetailsGlossaryHeading} entry in ${gradedItemDetailsGlossaryPath}`);
    }
  });

  it("does not report presence checks, type checks, display or copying", () => {
    const allowed = `
      if (gradedCard !== null) {}
      if (listing.gradedCard === null || listing.gradedCard === undefined) {}
      const isGraded = Boolean(line.gradedCard);
      if (typeof value.gradingCompany !== "string" || typeof value.gradedCard.grade !== "string") {}
      const label = \`\${gradedCard.gradingCompany} \${gradedCard.grade}\`;
      const copy = { gradingCompany: gradedCard.gradingCompany, grade: gradedCard.grade };
      const key = [gradedCard.gradingCompany.trim(), gradedCard.grade.trim()].join(":");
      if (first.dimensionId === vocabulary.gradingCompanyDimensionId) {}
      if (review.grade === "A" || gradedCard.gradeLabel === "Gem Mint") {}
      assert(gradingCompany.length > 0, "Graded cards require a grading company.");
      const schema = z.object({ gradingCompany: z.string(), grade: z.string() });
    `;

    expect(usesIn(allowed)).toEqual([]);
    expect(violationsIn(readerFile, allowed)).toEqual([]);
  });

  it("reports direct uses only", () => {
    expect(usesIn('const { grade } = gradedCard;\nif (grade === "10") {}')).toEqual([]);
    expect(usesIn('const company = gradedCard.gradingCompany;\nif (company === "PSA") {}')).toEqual([]);
  });
});

describe("graded item details text exceptions", () => {
  it("records exactly the registry link and the cohort company match", () => {
    expect(gradedItemDetailsTextExceptions).toEqual([registryLinkFile, cohortWindowFile]);
  });

  it("allows each recorded exception while its current content still matches", () => {
    expect(kindsIn(readRepoFile(registryLinkFile))).toEqual(["switches on gradingCompany"]);
    expect(kindsIn(readRepoFile(cohortWindowFile))).toEqual(["compares gradingCompany"]);

    for (const relativeFile of gradedItemDetailsTextExceptions) {
      expect(isGradedItemDetailsTextGuardedFile(relativeFile, path.extname(relativeFile))).toBe(true);
      expect(violationsIn(relativeFile, readRepoFile(relativeFile))).toEqual([]);
    }
  });

  it("reports the same content in a file that is not a recorded exception", () => {
    expect(violationsIn(readerFile, readRepoFile(registryLinkFile))).not.toEqual([]);
    expect(violationsIn(readerFile, readRepoFile(cohortWindowFile))).not.toEqual([]);
  });

  it("reports a recorded exception without a match as stale", () => {
    for (const relativeFile of gradedItemDetailsTextExceptions) {
      const violations = violationsIn(relativeFile, "const isGraded = gradedCard !== null;\n");

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("is a recorded exception");
      expect(violations[0]).toContain("remove it from gradedItemDetailsTextExceptions");
      expect(violations[0]).toContain(
        `the ${gradedItemDetailsGlossaryHeading} entry in ${gradedItemDetailsGlossaryPath}`,
      );
    }
  });
});

describe("graded item details rule", () => {
  const entry = glossaryEntry(gradedItemDetailsGlossaryPath, gradedItemDetailsGlossaryHeading);
  const rule = [
    "- Presence of `gradedCard` is the published classification of graded stock, and readers may branch on presence.",
    "- `certificationNumber`, `population` and `conditionDescriptors` are evidence about one item.",
    "- `gradingCompany` and `grade` are display copies of the selected Options' labels, written only by Inventory from the selection.",
    "- No code validates `gradingCompany` or `grade` against a code table, and no new code branches on their text.",
  ];

  it("is the Graded Item Details entry of Inventory's glossary, placed after Inventory Item", () => {
    expect(gradedItemDetailsGlossaryPath).toBe("bounded-contexts/inventory/GLOSSARY.md");
    expect(entry).not.toBeNull();

    const headings = readRepoFile(gradedItemDetailsGlossaryPath)
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings[headings.indexOf("## Graded Item Details") - 1]).toBe("## Inventory Item");
    expect(headings.filter((heading) => heading === "## Graded Item Details")).toHaveLength(1);
  });

  it("states the rule and both recorded exceptions", () => {
    expect(bullets(entry).slice(0, rule.length)).toEqual(rule);
    expect(bullets(entry).slice(rule.length)).toEqual([
      `- The registry link \`switch\` in Discovery's \`${registryLinkFile}\`.`,
      `- The company match of \`sellerComplianceCohortPolicy\` in Platform Operations' \`${cohortWindowFile}\`.`,
    ]);
    expect(entry).toContain("Channels' mapping keys stay because they match operator-reviewed mappings.");
  });

  it("is stated in the same words on gradedCardSnapshotSchema", () => {
    const comment = schemaDocComment();

    expect(bullets(comment)).toEqual(bullets(entry));
    expect(comment).toContain("Channels' mapping keys stay because they match operator-reviewed mappings.");
    expect(comment.join(" ")).toContain(
      `the ${gradedItemDetailsGlossaryHeading} entry in \`${gradedItemDetailsGlossaryPath}\``,
    );
    expect(usesIn(readRepoFile(schemaFile))).toEqual([]);
  });

  it("is pointed to, not defined again, under Listing in Marketplace's glossary", () => {
    const listing = glossaryEntry("bounded-contexts/marketplace/GLOSSARY.md", "Listing");

    expect(listing.filter((line) => line.includes("(../inventory/GLOSSARY.md#graded-item-details)"))).toHaveLength(1);
    expect(glossaryEntry("bounded-contexts/marketplace/GLOSSARY.md", gradedItemDetailsGlossaryHeading)).toBeNull();
  });

  it("is enforced by the structure check's file walk", () => {
    const runSource = readRepoFile("scripts/check-structure/run.mjs");

    expect(runSource).toContain('from "./graded-item-details-text.mjs"');
    expect(runSource).toContain("if (isGradedItemDetailsTextGuardedFile(normalizedFile, extension)) {");
    expect(runSource).toContain("for (const message of findGradedItemDetailsTextViolations({");
  });
});
