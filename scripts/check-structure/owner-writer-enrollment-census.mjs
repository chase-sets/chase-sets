import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { repoRoot } from "../lib/repo.mjs";

const roots = ["bounded-contexts/", "contracts/", "infrastructure/", "deployables/", "packages/"];
const sinkNames = new Set([
  "appendToStream",
  "appendToStreams",
  "appendToStreamInTransaction",
  "appendToStreamsInTransaction",
  "appendToStreamIndependently",
  "appendToStreamsIndependently",
  "append",
  "commandHandler",
  "createAggregateCommandHandler",
  "query",
  "receiptQuery",
  "connectChannel",
  "activateChannelConnection",
  "pauseChannelConnection",
  "resumeChannelConnection",
  "disconnectChannelConnection",
  "upsertRow",
  "updateRow",
  "transitionStatus",
  "expired",
]);
const possibleSink =
  /\b(?:appendToStreams?(?:InTransaction|Independently)?|append|commandHandler|createAggregateCommandHandler|query|receiptQuery|upsertRow|updateRow|transitionStatus|expired|connectChannel|(?:activate|pause|resume|disconnect)ChannelConnection)\b|\[\s*[^\s\]]/u;
const ownerPatterns = ["account", "user", "membership"].map((kind) => [
  kind,
  new RegExp(
    `identity\\.${kind}[-.]|\\b${kind}s\\.commandHandler|\\b${kind[0].toUpperCase()}${kind.slice(1)}(?:Event|Command|State)\\b`,
    "u",
  ),
]);
ownerPatterns.push([
  "session",
  /auth\.session[-.]|\bsessions\.commandHandler|\bSession(?:Event|Command|State)\b|\b(?:StartSession|RevokeSession|ExpireSession|SwitchSessionAccount)\b|sessionEventCodec|toSessionStreamId|identity_session_tokens|identity_sessions/u,
]);
ownerPatterns.push([
  "connection",
  /channels\.connection[-.]|\bChannelConnection(?:Event|Command|State)\b|channelConnectionEventCodec|\b(?:[Cc]onnectChannel|[Aa]ctivateChannelConnection|[Pp]auseChannelConnection|[Rr]esumeChannelConnection|[Dd]isconnectChannelConnection)\b/u,
]);
export function ownerWriterSourcePaths() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
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
    );
}

export function ownerWriterSources(files = ownerWriterSourcePaths()) {
  return Object.fromEntries(files.map((file) => [file, readFileSync(path.join(repoRoot, file), "utf8")]));
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
    if (!possibleSink.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const bindings = new Map();
    const calls = [];
    const bind = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        bindings.set(node.name.text, node.initializer);
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, bind);
    };
    bind(source);
    const constants = new WeakMap();
    function constantText(node, seen = new Set()) {
      if (!node || seen.has(node)) return "";
      if (constants.has(node)) return constants.get(node);
      if (ts.isStringLiteralLike(node)) return node.text;
      if (!ts.isIdentifier(node) && !ts.isBinaryExpression(node) && !ts.isTemplateExpression(node)) return "";
      const next = new Set(seen).add(node);
      let value = "";
      if (ts.isIdentifier(node)) value = constantText(bindings.get(node.text), next);
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
      let result = constantText(node);
      if (ts.isIdentifier(node)) {
        result += ` ${node.text}`;
        if (bindings.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))
          result += ` ${flow(bindings.get(node.text), seen)}`;
      } else if (ts.isPropertyAccessExpression(node)) result += ` ${node.getText(source)}`;
      ts.forEachChild(node, (child) => {
        result += ` ${flow(child, seen)}`;
      });
      result = result.trim();
      flows.set(node, result);
      return result;
    }
    function resolveSink(node, seen = new Set()) {
      if (!node || seen.has(node)) return undefined;
      seen.add(node);
      if (ts.isPropertyAccessExpression(node))
        return sinkNames.has(node.name.text) ? { name: node.name.text, target: node.getText(source) } : undefined;
      if (ts.isIdentifier(node))
        return sinkNames.has(node.text)
          ? { name: node.text, target: node.text }
          : resolveSink(bindings.get(node.text), seen);
      if (ts.isElementAccessExpression(node)) {
        const name = constantText(node.argumentExpression);
        return sinkNames.has(name) ? { name, target: node.getText(source) } : undefined;
      }
      if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
        return resolveSink(node.expression, seen);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "bind"
      )
        return resolveSink(node.expression.expression, seen);
      return undefined;
    }
    for (const node of calls) {
      const resolved = resolveSink(node.expression);
      if (!resolved) continue;
      const querySink = ["query", "receiptQuery"].includes(resolved.name);
      const sink = !querySink;
      const statement = querySink
        ? `${flow(node.arguments[0])} ${ts.isIdentifier(node.expression) ? flow(node.arguments[1]) : ""}`
        : "";
      const delegationSql =
        querySink &&
        /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|COPY|TRUNCATE(?:\s+TABLE)?)\s+(?:[a-z_][a-z_0-9]*\.)?"?identity_linked_platform_authorizations"?\b/iu.test(
          statement,
        );
      const sessionSql =
        querySink &&
        /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|COPY|TRUNCATE(?:\s+TABLE)?)\s+(?:[a-z_][a-z_0-9]*\.)?"?identity_session(?:_tokens|s)"?\b/iu.test(
          statement,
        );
      const connectionSql =
        querySink &&
        /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|COPY|TRUNCATE(?:\s+TABLE)?)\s+(?:[a-z_][a-z_0-9]*\.)?"?(?:channel_connections|channel_connection_(?:health|attention)|channels_connection_credentials|channels_ebay_account_deletion_receipts|channels_ebay_credential_refresh(?:_outcomes)?)"?\b/iu.test(
          statement,
        );
      const sql =
        delegationSql ||
        sessionSql ||
        connectionSql ||
        (querySink &&
          /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|COPY|TRUNCATE(?:\s+TABLE)?)\s+(?:[a-z_][a-z_0-9]*\.)?"?event_store_(?:events|streams)"?\b/iu.test(
            statement,
          ));
      if (sink || sql) {
        const callee = node.expression.getText(source);
        const data = `${callee} ${resolved.target} ${node.arguments.map((arg) => flow(arg)).join(" ")}`;
        const kinds = ownerPatterns.filter(([, pattern]) => pattern.test(data)).map(([kind]) => kind);
        if (delegationSql) kinds.push("delegation");
        if (sessionSql && !kinds.includes("session")) kinds.push("session");
        if (connectionSql && !kinds.includes("connection")) kinds.push("connection");
        if (
          ["upsertRow", "updateRow", "transitionStatus", "expired"].includes(resolved.name) &&
          !kinds.includes("session") &&
          !kinds.includes("connection")
        )
          continue;
        // Dynamic Identity sinks are deliberately UNKNOWN until explicitly classified.
        if (
          kinds.length ||
          file.startsWith("bounded-contexts/identity/") ||
          file.startsWith("bounded-contexts/auth/") ||
          file.startsWith("bounded-contexts/channels/")
        ) {
          const symbol = owner(node);
          const sinkName = delegationSql
            ? "delegation SQL"
            : sessionSql
              ? "session SQL"
              : connectionSql
                ? "connection SQL"
                : sql
                  ? "event-store SQL"
                  : callee;
          const ordinal =
            sites.filter((site) => site.file === file && site.symbol === symbol && site.sink === sinkName).length + 1;
          sites.push({ file, symbol, sink: sinkName, ordinal, keys: kinds });
        }
      }
    }
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
