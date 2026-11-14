import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { repoRoot } from "../lib/repo.mjs";

const roots = ["bounded-contexts/", "contracts/", "infrastructure/", "deployables/", "packages/"];
export function ownerWriterSources() {
  return Object.fromEntries(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split(/\r?\n/u)
      .filter(
        (file) =>
          roots.some((root) => file.startsWith(root)) &&
          /\.[cm]?tsx?$/u.test(file) &&
          !/(?:\.(?:test|spec|stories)|[.-]test-support)\.[cm]?tsx?$/u.test(file) &&
          !/(?:^|\/)(?:tests|__tests__|fixtures|__fixtures__|node_modules)\//u.test(file) &&
          !/\.d\.ts$/u.test(file),
      )
      .map((file) => [file, readFileSync(path.join(repoRoot, file), "utf8")]),
  );
}

function owner(node) {
  const names = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) names.unshift(parent.name.text);
    else if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && parent.parent?.name)
      names.unshift(parent.parent.name.getText());
  }
  return names.join(" > ") || "<module>";
}

/** Tracks stream/event expressions into append/handler/SQL sinks, not file-name vocabulary. */
export function discoverOwnerWriters(sources) {
  const sites = [];
  for (const [file, text] of Object.entries(sources)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const bindings = new Map();
    const bind = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        bindings.set(node.name.text, node.initializer);
      ts.forEachChild(node, bind);
    };
    bind(source);
    const constants = new WeakMap();
    function constantText(node, seen = new Set()) {
      if (!node || seen.has(node)) return "";
      if (constants.has(node)) return constants.get(node);
      const next = new Set(seen).add(node);
      let value = "";
      if (ts.isStringLiteralLike(node)) value = node.text;
      else if (ts.isIdentifier(node)) value = constantText(bindings.get(node.text), next);
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
        value = constantText(node.left, next) + constantText(node.right, next);
      else if (ts.isTemplateExpression(node))
        value =
          node.head.text +
          node.templateSpans.map((span) => constantText(span.expression, next) + span.literal.text).join("");
      constants.set(node, value);
      return value;
    }
    const flows = new WeakMap();
    function flow(node, seen = new Set()) {
      if (!node || seen.has(node)) return "";
      if (flows.has(node)) return flows.get(node);
      seen.add(node);
      let result = `${node.getText(source)} ${constantText(node)}`;
      if (ts.isIdentifier(node) && bindings.has(node.text)) result += ` ${flow(bindings.get(node.text), seen)}`;
      ts.forEachChild(node, (child) => {
        result += ` ${flow(child, seen)}`;
      });
      result = result.trim();
      flows.set(node, result);
      return result;
    }
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        const query = flow(node.expression);
        const sink =
          /(?:^|[.\s])(?:appendToStreams?(?:InTransaction|Independently)?|append|commandHandler|createAggregateCommandHandler)!?$/u.test(
            query,
          );
        const statement = /(?:^|[.\s])query$/u.test(query) ? flow(node.arguments[0]) : "";
        const sql =
          /(?:^|[.\s])query$/u.test(query) &&
          /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|COPY|TRUNCATE)\b/iu.test(statement) &&
          /\bevent_store_(?:events|streams)\b/iu.test(statement);
        if (sink || sql) {
          const data = flow(node);
          const kinds = ["account", "user", "membership"].filter((kind) =>
            new RegExp(
              `identity\\.${kind}[-.]|\\b${kind}s\\.commandHandler|\\b${kind[0].toUpperCase()}${kind.slice(1)}(?:Event|Command|State)\\b`,
              "u",
            ).test(data),
          );
          // Dynamic Identity sinks are deliberately UNKNOWN until explicitly classified.
          if (kinds.length || file.startsWith("bounded-contexts/identity/")) {
            const symbol = owner(node);
            const sinkName = sql ? "event-store SQL" : callee;
            const ordinal =
              sites.filter((site) => site.file === file && site.symbol === symbol && site.sink === sinkName).length + 1;
            sites.push({ file, symbol, sink: sinkName, ordinal, keys: kinds });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function enrollmentErrors(sites, manifest) {
  const identity = ({ file, symbol, sink, ordinal, keys }) => JSON.stringify([file, symbol, sink, ordinal, keys]);
  const errors = [];
  for (const site of sites) {
    const row = manifest.writers.find((candidate) => identity(candidate) === identity(site));
    if (!row) errors.push(`UNKNOWN writer ${identity(site)}`);
    else if (row.disposition === "enrolled" && !row.enrollment) errors.push(`unenrolled writer ${identity(site)}`);
    else if (row.disposition === "excluded" && (!row.sourceSymbol || !row.foldTest))
      errors.push(`unproven exclusion ${identity(site)}`);
    else if (!["enrolled", "excluded"].includes(row.disposition)) errors.push(`UNKNOWN disposition ${identity(site)}`);
  }
  for (const row of manifest.writers)
    if (!sites.some((site) => identity(site) === identity(row))) errors.push(`stale writer ${identity(row)}`);
  return errors;
}
