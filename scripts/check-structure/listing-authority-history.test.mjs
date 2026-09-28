import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";

function source(name) {
  return readFileSync(new URL(`../../infrastructure/platform-runtime/${name}`, import.meta.url), "utf8");
}

function journalViolations(text) {
  const file = ts.createSourceFile("journal.ts", text, ts.ScriptTarget.Latest, true);
  const read = file.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "readAuthorityJournal",
  );
  if (!read?.body) return ["missing retained-history reader"];
  const returns = [];
  function visit(node) {
    if (node !== read && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  }
  visit(read);
  const last = read.body.statements.at(-1);
  const errors = [];
  if (returns.length !== 1 || returns[0] !== last) errors.push("history cannot return fresh before witness validation");
  const lengthComparisons = [];
  function comparisons(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      lengthComparisons.push(node.getText(file).replace(/\s/g, ""));
    ts.forEachChild(node, comparisons);
  }
  comparisons(read);
  for (const retained of ["integrity", "registration"])
    if (!lengthComparisons.includes(`events!.length!==${retained}!.length`))
      errors.push(`missing ${retained} history check`);
  return errors;
}

describe("retained-authority structural guard", () => {
  it("all journal reads validate both independent histories before returning even an empty record", () => {
    expect(journalViolations(source("./listing-authority-journal.ts"))).toEqual([]);
  });

  it("negative control: an empty-means-fresh read fails the same structural harness", () => {
    const original = source("./listing-authority-journal.ts");
    const anchor = "const [events, integrity, registration] = histories;";
    expect(original).toContain(anchor);
    const mutant = original.replace(
      anchor,
      `${anchor}\nif (!events!.length && !integrity!.length) return { events: [], version: 0, histories };`,
    );
    expect(journalViolations(mutant)).toEqual(["history cannot return fresh before witness validation"]);
    expect(() => expect(journalViolations(mutant)).toEqual([])).toThrow();
  });

  it("negative control: dropping the registration comparison fails the harness", () => {
    const original = source("./listing-authority-journal.ts");
    const mutant = original.replace("events!.length !== registration!.length", "false");
    expect(mutant).not.toBe(original);
    expect(journalViolations(mutant)).toContain("missing registration history check");
  });

  it("protocol record readers and final writers use the retained journal, not raw empty-history admission", () => {
    const state = source("./listing-authority-state.ts");
    expect(state).toContain("readAuthorityJournal(store, streamId)");
    expect(state).not.toContain("readCompleteStream");
    const fence = source("./listing-authority-fence.ts");
    expect(fence).toContain("return prepareAuthorityAppend(store,");
    expect(fence).not.toContain("store.appendToStream(");
    expect(fence).not.toContain("store.appendToStreams(");
    const writer = source("./listing-authority-writer.ts");
    expect(writer).toContain("readAuthorityJournal(raw, writeStream(writeId))");
    expect(writer).not.toContain("raw.appendToStream(");
    const resource = source("./listing-authority-resource.ts");
    expect(resource).toContain("await readAuthorityJournal(store, streamId)");
    expect(resource).toContain("store.appendToStreams(await prepareAuthorityAppends(store, appends))");
  });
});
