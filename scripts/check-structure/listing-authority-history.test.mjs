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

function canonicalFoldViolations(text) {
  const file = ts.createSourceFile("resource.ts", text, ts.ScriptTarget.Latest, true);
  let read;
  let empty;
  function find(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "read") read = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "empty") empty = node;
    ts.forEachChild(node, find);
  }
  find(file);
  if (!read?.body) return ["missing canonical resource reader"];
  const compact = (node) => node.getText(file).replace(/\s/g, "");
  const declarations = [];
  const assignments = [];
  const loops = [];
  const returns = [];
  const forbidden = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignments.push(node);
    if (ts.isForOfStatement(node)) loops.push(node);
    if (ts.isReturnStatement(node)) returns.push(node);
    if (ts.isCallExpression(node) && /(?:loadLatest|readStream|readCompleteStream)$/.test(compact(node.expression)))
      forbidden.push(node);
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) forbidden.push(node);
    ts.forEachChild(node, visit);
  }
  visit(read.body);
  const journal = declarations.find(
    (node) => compact(node.initializer ?? node) === "awaitreadAuthorityJournal(store,streamId)",
  );
  const binds =
    journal && ts.isObjectBindingPattern(journal.name) && journal.name.elements.map((element) => compact(element));
  const state = declarations.find((node) => compact(node.name) === "state");
  const canonicalLoop = loops.find(
    (node) => compact(node.expression) === "events" && compact(node.statement) === "{state=fold(state,event);}",
  );
  const semanticAssignments = assignments.filter((node) =>
    /^(state|version|events)(?:\.|\[|$)/.test(compact(node.left)),
  );
  const result = returns[0] && compact(returns[0]);
  if (
    !empty?.initializer ||
    !ts.isArrowFunction(empty.initializer) ||
    compact(empty.initializer.body) !== "({pending:null,grants:[]})" ||
    !binds?.includes("events") ||
    !binds.includes("version") ||
    !binds.includes("histories") ||
    compact(state?.initializer ?? read) !== "empty()" ||
    !canonicalLoop ||
    semanticAssignments.length !== 1 ||
    compact(semanticAssignments[0]) !== "state=fold(state,event)" ||
    declarations.some((node) => compact(node.name) === "version") ||
    forbidden.length ||
    returns.length !== 1 ||
    returns[0] !== read.body.statements.at(-1) ||
    !result.includes("version,pending:state.pending,grants:newMap(state.grants.map(")
  )
    return ["resource authority must fold the complete returned canonical history from empty state"];
  return [];
}

describe("retained-authority structural guard", () => {
  it("canonical fold provenance: only returned canonical events establish membership, closure and version", () => {
    expect(canonicalFoldViolations(source("./listing-authority-resource.ts"))).toEqual([]);
  });

  it("negative control: r11 discarded history plus witness-authorized snapshot fails canonical provenance", () => {
    const original = source("./listing-authority-resource.ts");
    const start = original.indexOf("  async function read(streamId: string) {");
    const end = original.indexOf("  async function append(", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // The r11 authority shortcut, not a missing-call mutant: the journal call
    // remains, but its events are discarded and matching witness hashes admit cache state.
    const regressed = `  async function read(streamId: string) {
      await readAuthorityJournal(store, streamId);
      let state = empty();
      let version = 0;
      const snapshot = await deps.snapshots?.loadLatest(streamId);
      if (snapshot?.schemaVersion === 1 && snapshot.streamId === streamId && snapshot.streamVersion > 0) {
        const candidate = snapshot.state as ResourceState;
        const [anchor, proof] = await Promise.all([
          store.readStream({ streamId, fromVersion: snapshot.streamVersion, limit: 1 }),
          store.readStream({ streamId: integrityStream(streamId), fromVersion: snapshot.streamVersion, limit: 1 }),
        ]);
        if (anchor[0]?.streamVersion === snapshot.streamVersion && proof[0]?.streamVersion === snapshot.streamVersion &&
          proof[0].eventType === prefix + '.history-witness' && proof[0].payload.eventHash === eventHash(anchor[0]) &&
          proof[0].payload.stateHash === stateHash(candidate)) {
          state = candidate;
          version = snapshot.streamVersion;
        }
      }
      const events = await readCompleteStream(store, { streamId, fromVersion: version + 1 });
      for (const event of events) { state = fold(state, event); version = event.streamVersion; }
      return { streamId, version, pending: state.pending, grants: new Map(state.grants.map((grant) => [grant.reservationId, grant])) };
    }
`;
    const mutant = original.slice(0, start) + regressed + original.slice(end);
    expect(mutant).toContain("await readAuthorityJournal(store, streamId)");
    expect(canonicalFoldViolations(mutant)).toEqual([
      "resource authority must fold the complete returned canonical history from empty state",
    ]);
    expect(() => expect(canonicalFoldViolations(mutant)).toEqual([])).toThrow();
  });

  it("negative controls: a cache seed or a skipped canonical prefix fails even with a retained journal binding", () => {
    const original = source("./listing-authority-resource.ts");
    for (const mutant of [
      original.replace("let state = empty();", "let state = (await deps.snapshots.loadLatest(streamId)).state;"),
      original.replace("for (const event of events)", "for (const event of events.slice(1))"),
    ])
      expect(canonicalFoldViolations(mutant)).not.toEqual([]);
  });
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
