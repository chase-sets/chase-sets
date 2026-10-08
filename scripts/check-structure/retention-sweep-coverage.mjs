import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

const terminalStatePattern = /'(?:sent|failed|expired|released|resolved|ignored|succeeded|cancelled|completed)'/;
const insertOnlyNamePattern =
  /(?:_events|_runs|_audit|_idempotency|_outbox|_snapshots|_claims|_tokens|_states|_cache)$/;
const timestampPattern =
  /\b(?:created_at|updated_at|received_at|completed_at|recorded_at|expires_at|stale_until|released_at)\b/;
const requiredKnownTables = new Map([
  ["notification_outbox", "infrastructure/notification-outbox/index.ts"],
  ["checkout_session_pages", "bounded-contexts/checkout/features/sessions/read-model/schema.ts"],
  ["payments_provider_idempotency_keys", "bounded-contexts/payments/features/payments/read-model/schema.ts"],
  ["settlement_provider_idempotency_keys", "bounded-contexts/settlement/features/payouts/read-model/schema.ts"],
  [
    "channel_connector_inbound_events",
    "bounded-contexts/channels/features/connector-feed/read-model/inbound-schema.ts",
  ],
  [
    "channel_connector_inbound_payloads",
    "bounded-contexts/channels/features/connector-feed/read-model/inbound-schema.ts",
  ],
]);
// Payload tables whose coverage is proven only by a sweep the owning module
// mounts: a lexical mention, an unmounted declaration or an exemption fails.
const requiredMountedSweepTables = new Map([
  ["channel_connector_inbound_payloads", "bounded-contexts/channels/index.ts"],
]);

// These tables already have a purpose-built cleanup path or are durable
// records whose deletion needs a separate accounting/security decision.
export const retentionCoverageExemptions = new Map([
  ["event_store_events", "Canonical event ledgers are permanent and are never age-swept."],
  [
    "channel_connector_inbound_events",
    "Channels-owned non-PII connector admission identity: the dedupe key keeping a re-post inert after payload expiry, and the order/cursor/horizon #7795 consumes. Payload bytes live only in channel_connector_inbound_payloads, which a mounted sweep deletes and which is never exempt.",
  ],
  [
    "evidence_window",
    "Durable single-open lifecycle record governed by registration: closed only by expected-version close or expired-replacement retirement; never age-swept and has no reaper.",
  ],
  [
    "evidence_window_provider_write",
    "Durable bounded provider-write identities and unresolved reconciliation evidence must survive window expiry; replay deadlines revoke sending, not record retention. #8226 excludes cleanup and background liveness; never age-swept.",
  ],
  [
    "event_store_aggregate_snapshots",
    "Bounded one-row-per-stream load-time cache (m113: aggregate snapshots in event-core), not unbounded history; rows are replaced in place and already cascade-deleted with their event_store_streams row via ON DELETE CASCADE.",
  ],
  ["payments_work_claims", "Claim rows are mutable coordination state, not append-only history."],
  ["settlement_work_claims", "Claim rows are mutable coordination state, not append-only history."],
  ["platform_control_lease_fencing_tokens", "Monotonic fencing tokens must survive lease row cleanup."],
  ["platform_control_leases", "Lease acquisition already deletes expired lease rows."],
  [
    "channel_reconciliation_state",
    "Durable one-row-per-connection current state is updated in place and must survive between scheduled runs; historical runs live in the event ledger and bounded metrics table.",
  ],
  ["platform_post_write_tokens", "The post-write token store prunes expired rows on store access."],
  ["platform_projection_checkpoint_readiness", "The scheduled work-signal cleanup runner owns this table."],
  ["platform_projection_checkpoint_waiters", "The scheduled work-signal cleanup runner owns this table."],
  ["platform_projection_wake_intents", "The scheduled work-signal cleanup runner owns this table."],
  ["platform_realtime_stream_leases", "The realtime stream limiter cleans expired leases on admission/release."],
  [
    "catalog_tcgplayer_automation_domain_rate_limit_leases",
    "The Catalog TCGplayer shared-budget admission statement reclaims expired leases and release removes settled leases; this coordination table is not age-swept.",
  ],
  ["platform_ucp_agent_profiles", "Agent profile expiry is authorization state, not disposable request history."],
  ["platform_ucp_idempotency_records", "The UCP idempotency store has its own expiry pruning path."],
  [
    "pricing_market_state_snapshots",
    "Daily market-state history is product data retained forever, like the Trades Tape it derives from (#4303); never age-swept (#4305).",
  ],
  [
    "pricing_external_listing_snapshots",
    "Provider listing snapshots are permanent typed market evidence whose immutable capture provenance must remain available to Demand Curve replay; never age-swept (#7704).",
  ],
  [
    "pricing_repricing_dry_runs",
    "Completed dry runs remain valid indefinitely by exact body hash with no clock or expiry; run records and durable consumed_at evidence must survive for once-only consumption (#7904, comment 5646248607). Never age-swept.",
  ],
  [
    "platform_operations_gmv_reconciliation_runs",
    "Tape-vs-ledger reconciliation results are a permanent ops audit trail over forever-retained source data; never age-swept.",
  ],
  [
    "catalog_scope_sync_state",
    "Durable per-(scope, provider-unit) current-state read model, upserted in place on every job-lifecycle transition — not disposable event/job history. Mirrors catalog_provider_scope_mappings (also a permanent current-state table); never age-swept.",
  ],
]);

export async function validateRetentionSweepCoverage({ repoRoot }) {
  const sourceFiles = await listSourceFiles(repoRoot);
  const policyFiles = sourceFiles.filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    return normalized.endsWith("retention-policy.ts") || normalized.endsWith("platform-runtime/retention-sweep.ts");
  });
  const policySource = (await Promise.all(policyFiles.map((file) => readFile(file, "utf8")))).join("\n");
  const relativeSourceFiles = new Set(sourceFiles.map((file) => relative(repoRoot, file)));
  const candidates = new Map([...requiredKnownTables].filter(([, sourceFile]) => relativeSourceFiles.has(sourceFile)));

  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*?)\);/gs)) {
      const [, tableName, body] = match;
      const hasExpiry = /\bexpires_at\b/.test(body);
      const hasTerminalState = /\b(?:status|state)\s+text\b/.test(body) && terminalStatePattern.test(body);
      const looksInsertOnly = insertOnlyNamePattern.test(tableName) && timestampPattern.test(body);
      if (hasExpiry || hasTerminalState || looksInsertOnly) {
        candidates.set(tableName, relative(repoRoot, file));
      }
    }
  }

  const violations = [];
  for (const [tableName, file] of [...candidates].sort(([left], [right]) => left.localeCompare(right))) {
    const moduleFile = requiredMountedSweepTables.get(tableName);
    if (moduleFile) {
      if (retentionCoverageExemptions.has(tableName) || !(await hasMountedSweep(repoRoot, moduleFile, tableName))) {
        violations.push(
          `${file}: retention candidate '${tableName}' requires a sweep mounted by ${moduleFile} module.retentionSweeps; a lexical mention, unmounted declaration or exemption does not count.`,
        );
      }
      continue;
    }
    if (retentionCoverageExemptions.has(tableName)) {
      continue;
    }
    if (!new RegExp(`(?:^|[^a-zA-Z0-9_])${escapeRegExp(tableName)}(?:$|[^a-zA-Z0-9_])`).test(policySource)) {
      violations.push(
        `${file}: retention candidate '${tableName}' has no shared retention-sweep registration or explicit exemption.`,
      );
    }
  }

  return { violations };
}

// Binds coverage to the sweep objects reachable from the module's mounted
// export. Only the concrete declaration forms below are understood; any other
// shape is unresolved and does not count as coverage.
async function hasMountedSweep(repoRoot, moduleFile, tableName) {
  const modulePath = path.join(repoRoot, moduleFile);
  const moduleSource = parseSource(modulePath, await readOptional(modulePath));
  const mounted = moduleSource && mountedSweepIdentifiers(moduleSource);
  if (!mounted) {
    return false;
  }
  const imports = namedImports(moduleSource);
  for (const identifier of mounted) {
    const imported = imports.get(identifier);
    if (!imported?.specifier.endsWith("/retention-policy")) {
      continue;
    }
    const policyPath = path.join(path.dirname(modulePath), `${imported.specifier}.ts`);
    const policySource = parseSource(policyPath, await readOptional(policyPath));
    const declarations = policySource && topLevelDeclarations(policySource);
    const initializer = declarations?.exportedConsts.get(imported.name);
    const sweeps = initializer ? sweepObjects(initializer, declarations, 0) : null;
    if (sweeps?.some((sweep) => hasLiteralProperty(sweep, "tableName", tableName))) {
      return true;
    }
  }
  return false;
}

function parseSource(file, text) {
  return text === null ? null : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

// `retentionSweeps: x` or `retentionSweeps: [...x, ...y]` on `export const
// module = {...}` or `= define(...)({...})`; [] when unmounted, null when unsupported.
function mountedSweepIdentifiers(source) {
  const moduleDeclaration = source.statements
    .filter((statement) => ts.isVariableStatement(statement) && isExported(statement))
    .flatMap((statement) => statement.declarationList.declarations)
    .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "module");
  const initializer = moduleDeclaration?.initializer;
  const moduleObject =
    initializer && ts.isCallExpression(initializer) && initializer.arguments.length === 1
      ? initializer.arguments[0]
      : initializer;
  if (!moduleObject || !ts.isObjectLiteralExpression(moduleObject)) {
    return null;
  }
  const properties = moduleObject.properties.filter((property) => propertyName(property) === "retentionSweeps");
  if (properties.length === 0) {
    return [];
  }
  const [property] = properties;
  if (properties.length > 1 || !ts.isPropertyAssignment(property)) {
    return null;
  }
  const value = property.initializer;
  if (ts.isIdentifier(value)) {
    return [value.text];
  }
  if (
    ts.isArrayLiteralExpression(value) &&
    value.elements.every((element) => ts.isSpreadElement(element) && ts.isIdentifier(element.expression))
  ) {
    return value.elements.map((element) => element.expression.text);
  }
  return null;
}

function namedImports(source) {
  const imports = new Map();
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings) || statement.importClause.isTypeOnly) {
      continue;
    }
    for (const element of bindings.elements) {
      if (!element.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier)) {
        imports.set(element.name.text, {
          name: (element.propertyName ?? element.name).text,
          specifier: statement.moduleSpecifier.text,
        });
      }
    }
  }
  return imports;
}

function topLevelDeclarations(source) {
  const exportedConsts = new Map();
  const functions = new Map();
  for (const statement of source.statements) {
    if (
      ts.isVariableStatement(statement) &&
      isExported(statement) &&
      statement.declarationList.flags & ts.NodeFlags.Const
    ) {
      for (const { name, initializer } of statement.declarationList.declarations) {
        if (ts.isIdentifier(name) && initializer) {
          exportedConsts.set(name.text, exportedConsts.has(name.text) ? null : initializer);
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      functions.set(statement.name.text, functions.has(statement.name.text) ? null : statement);
    }
  }
  return { exportedConsts, functions };
}

// Object literals an expression yields as sweeps: an array of object literals,
// a zero-argument same-file builder, or `.map(arrow)` returning one object.
function sweepObjects(expression, declarations, depth) {
  if (depth > 4) {
    return null;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.every(ts.isObjectLiteralExpression) ? [...expression.elements] : null;
  }
  if (!ts.isCallExpression(expression)) {
    return null;
  }
  const callee = expression.expression;
  if (ts.isIdentifier(callee) && expression.arguments.length === 0) {
    const returned = singleReturnExpression(declarations.functions.get(callee.text)?.body);
    return returned ? sweepObjects(returned, declarations, depth + 1) : null;
  }
  const [mapper] = expression.arguments;
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "map" &&
    expression.arguments.length === 1 &&
    ts.isArrowFunction(mapper)
  ) {
    let result = ts.isBlock(mapper.body) ? singleReturnExpression(mapper.body) : mapper.body;
    while (result && ts.isParenthesizedExpression(result)) {
      result = result.expression;
    }
    return result && ts.isObjectLiteralExpression(result) ? [result] : null;
  }
  return null;
}

function singleReturnExpression(block) {
  if (!block) {
    return null;
  }
  const returns = [];
  const visit = (node) =>
    ts.forEachChild(node, (child) => {
      if (ts.isReturnStatement(child)) {
        returns.push(child);
      }
      if (!ts.isFunctionLike(child)) {
        visit(child);
      }
    });
  visit(block);
  return returns.length === 1 && returns[0].parent === block ? (returns[0].expression ?? null) : null;
}

function hasLiteralProperty(object, key, value) {
  return object.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyName(property) === key &&
      (ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)) &&
      property.initializer.text === value,
  );
}

function propertyName(property) {
  return property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text
    : null;
}

function isExported(statement) {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

async function readOptional(file) {
  try {
    await access(file);
  } catch {
    return null;
  }
  return readFile(file, "utf8");
}

async function listSourceFiles(repoRoot) {
  const files = [];
  for (const rootName of ["bounded-contexts", "infrastructure"]) {
    await walk(path.join(repoRoot, rootName), files);
  }
  return files.filter((file) => {
    const relativePath = relative(repoRoot, file);
    const isHistoricalSqlFixture = file.endsWith(".sql") && relativePath.includes("/tests/fixtures/");
    return /\.(?:ts|sql)$/.test(file) && !isHistoricalSqlFixture;
  });
}

async function walk(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, files);
    } else {
      files.push(entryPath);
    }
  }
}

function relative(repoRoot, file) {
  return path.relative(repoRoot, file).replaceAll("\\", "/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
