import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";

const root = new URL("../../../../../../", import.meta.url);
const accountFile =
  "bounded-contexts/settlement/features/wallets/integrations/account-risk-source/account-risk-source-schema.ts";
const compositionFile = "bounded-contexts/settlement/support/runtime-support/schema.ts";
const source = (file: string) => readFileSync(new URL(file, root), "utf8").replace(/\r\n/g, "\n");
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const candidate = source(accountFile);
const revisionId = "20261104_settlement_account_risk_source_revision";
const holdId = "20261120_settlement_payout_review_hold";
const guardId = "20261120_settlement_payout_review_hold_fallback_guard";
const guardIdName = "settlementPayoutReviewHoldFallbackGuardMigrationId";
const guardIdDeclaration = `export const ${guardIdName} =\n  "${guardId}";\n\n`;
const revisionSql =
  "ALTER TABLE settlement_account_risk_sources\n  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0";
const holdSql = [
  "ALTER TABLE settlement_account_risk_sources\n  ADD COLUMN IF NOT EXISTS payout_review_hold boolean NOT NULL DEFAULT false",
  "ALTER TABLE settlement_account_risk_sources\n  ADD COLUMN IF NOT EXISTS payout_review_hold_stream_version bigint NOT NULL DEFAULT 0",
];
const holdSchemaHash = "e14971b090396ba9e002eb8b099c67ae150742f0e535c34b43f7589635b8cecc";
const candidateHash = "e95ccc53aea76f9b7a823067400ab9fc831a2e066db5d176772f690055b459c4";
const revisionSchemaHash = "1c3b950dad3bced9199589e975c399b63ce4564c91c36021f1e2531f87bc3ecb";
const historicalHash = "30dbe2198e434cf97aac8f932e1d9ca27a90a10ef1413240a736e4bfad14bcdb";
const stoppedHash = "3ef21801aa37729c7fe72cfe48375a770305bcb7c54fc7db8fb6874eb0aa7f3f";
const dropId = "20261123_settlement_drop_account_velocity_storage";
const velocityColumns = [
  "chargeback_7d_count",
  "chargeback_30d_count",
  "chargeback_30d_rate_bps",
  "listing_24h_count",
  "listing_24h_value_cents",
  "review_24h_count",
  "review_24h_median_reviewer_age_days",
  "buyer_order_24h_count",
  "buyer_spend_24h_cents",
  "velocity_alert_flags",
];
const dropSql = [
  "SET lock_timeout = '5s'",
  "DROP TABLE IF EXISTS settlement_account_velocity_sources",
  `ALTER TABLE settlement_account_risk_sources\n${velocityColumns.map((column) => `  DROP COLUMN IF EXISTS ${column}`).join(",\n")}`,
];
const velocityStorage =
  /settlement_account_velocity_sources|velocity_alert_flags|chargeback_(?:7d|30d)_|(?:listing|review|buyer_order|buyer_spend)_24h_/;
const migrationIds = [
  "20260720_settlement_account_linkage_clusters",
  "20260720_settlement_account_linkage_closer_cursor",
  "20260715_settlement_review_scoring_disposition",
  "20260706_settlement_payments_fraud_risk_sources",
  "20260707_settlement_linked_account_risk_sources",
  "20260711_settlement_account_review_sources_reveal",
  revisionId,
  holdId,
  guardId,
  dropId,
];

// Fixed Settlement lifecycle evidence at abb4857e, plus the Settlement hold projection wiring in index.ts and the
// unlogged projection migration without the dropped velocity source table, and the policy document stream version
// column with its ledger, which index.ts spreads last.
// Full source pins include imports, exports, every executable member and opaque expressions.
const composedSources = {
  "bounded-contexts/settlement/index.ts": "c5c8f0fec3c66f4c69372e88b89eb49af2f1eef54e6a046c63d07bd54b41fcf1",
  "bounded-contexts/settlement/support/runtime-support/schema.ts":
    "2274e4327827a68c647aa383821fe93b6157dadfceba961918ebbe3fe88ca7be",
  "bounded-contexts/settlement/support/runtime-support/unlogged-projection-migrations.ts":
    "56108e18c26ef81dd582536493c83cdbec04befc41751cddb08e88d64f9f155b",
  "bounded-contexts/settlement/support/runtime-support/retention-policy.ts":
    "26eeeb90a1a35cc56857dc8f2ab5bcc7cfdf9fd5a080b3e27ed9a861023e9380",
  "bounded-contexts/settlement/features/wallets/read-model/schema.ts":
    "92ebd2e79e8db4eab53b591782abbd6b53ce1648fffda74b4e8b781650e01ef6",
  "bounded-contexts/settlement/features/wallets/read-model/wallet-adjustment-schema.ts":
    "824578ded8157062918cab45d3d456f61f819ec6337df52979ce647f6311eb7d",
  "bounded-contexts/settlement/features/wallets/integrations/payment-source/payment-source-schema.ts":
    "98c6672ec7b1a1449b4941a65a8005e3af207b265049d8b79f74ae763a4bd9ad",
  "bounded-contexts/settlement/features/wallets/integrations/support-source/support-source-schema.ts":
    "c7f5fcccfc261efb1d802cd3a9921e3810e89c00d1d86b828b6bc813e96b62a3",
  "bounded-contexts/settlement/features/wallets/integrations/fulfillment-source/fulfillment-source-schema.ts":
    "15f6b3b7c3aff46a42bb4459d1d2ae73f9d5a36152ba525d529253f260542c16",
  "bounded-contexts/settlement/features/payouts/read-model/schema.ts":
    "55064be7987bdae63d430edaea12bd7c84f2c31114c70a52a94a4c100208f78a",
  "bounded-contexts/settlement/features/protection-coverage/read-model/protection-coverage-schema.ts":
    "693b5e058c44298c2f5ebd27ee2fa908bff15e3c2722196bc51cbcc5f393cb59",
  "bounded-contexts/settlement/features/liability-allocation/read-model/liability-allocation-schema.ts":
    "cefa38d290c93a4f58fe0f998eb0a07b0010d1d80623ee7b69283836923150d2",
  "bounded-contexts/settlement/features/liability-reconciliation/read-model/liability-reconciliation.ts":
    "a26c692a86936b80f95347e6039a7ca7ebece7433ba3fe10a54bdb35a2946658",
  "bounded-contexts/settlement/features/payout-readiness/read-model/schema.ts":
    "18c137e6be5fcd9492b53deb24631ad64542e1126e96acbc1e7a928ff8b2ddc2",
  "infrastructure/event-core-postgres/index.ts": "f573ef2f50ac4717ea37bf8098b92a3e4ece6c8405a4c794af0592a2c9111924",
  "infrastructure/event-core-postgres/schema.ts": "8fb05cb27f304dc5c43b0992f3b3ad1e98e2891407d15abec8139c63048551dc",
  "infrastructure/notification-outbox/index.ts": "24ff5dd032a3c3fa6b2b91efb97ec06e4a73e28bb1e615de9a771a90c8b1e537",
  "infrastructure/platform-policy/schema.ts": "144796507d5469fb3a2fece7a539081cecd200a8708b509362f00d801cc95be7",
  "infrastructure/platform-runtime/durable-job-store.ts":
    "fcabac808d63a9b9fb7f6218a62eba3979a4e48808f20fb33cec1f63e442c8e4",
  "infrastructure/platform-runtime/durable-job-work-units.ts":
    "15a95d797c8138ff20098e331cba58448d7efdc4c6158eec610e229ba73899e8",
  "infrastructure/bounded-context-runtime/schema.ts":
    "2eaaf3d28eaf69c7f8f7323aa17cc05af533ff8ac00f66e1a8a9373804c2e016",
} as const;

function declarations(text: string) {
  const file = ts.createSourceFile(accountFile, text, ts.ScriptTarget.Latest, true);
  const variables = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations);
  const boot = variables.find(
    (node) => node.name.getText(file) === "settlementAccountRiskSourceSchemaSql",
  )?.initializer;
  const ledger = variables.find(
    (node) => node.name.getText(file) === "settlementAccountRiskSourceSchemaMigrations",
  )?.initializer;
  const array = ledger && ts.isAsExpression(ledger) ? ledger.expression : ledger;
  if (!boot || !ts.isNoSubstitutionTemplateLiteral(boot) || !array || !ts.isArrayLiteralExpression(array)) return null;
  return { file, boot, array };
}

function property(object: ts.Node, name: string) {
  return ts.isObjectLiteralExpression(object)
    ? object.properties.find(
        (entry): entry is ts.PropertyAssignment => ts.isPropertyAssignment(entry) && entry.name.getText() === name,
      )?.initializer
    : undefined;
}

function sourceBeforeMigration(text: string, migrationId: string) {
  const parsed = declarations(text);
  const next = parsed?.array.elements[migrationIds.indexOf(migrationId)];
  return next ? `${text.slice(0, next.getFullStart()).replace(guardIdDeclaration, "")}\n] as const;\n` : "";
}

function hasExactSql(entry: ts.Node, expected: readonly string[], file: ts.SourceFile) {
  const statements = property(entry, "statements");
  return (
    !!statements &&
    ts.isArrayLiteralExpression(statements) &&
    statements.elements.length === expected.length &&
    statements.elements.every(
      (statement, index) =>
        ts.isNoSubstitutionTemplateLiteral(statement) &&
        statement.text === expected[index] &&
        statement.getText(file).slice(1, -1) === expected[index],
    )
  );
}

type Obligation = "identity" | "prefix" | "order" | "add" | "boot" | "drop" | "closed";
function violations(text: string, bypass?: Obligation) {
  const failures: string[] = [];
  const checkObligation = (key: Obligation, valid: boolean) => {
    if (key !== bypass && !valid) failures.push(key);
  };
  checkObligation("identity", digest(text) === candidateHash);
  const parsed = declarations(text);
  if (!parsed) return [...failures, "opaque-source"];
  const { file, boot, array } = parsed;
  checkObligation(
    "prefix",
    digest(sourceBeforeMigration(text, revisionId)) === historicalHash &&
      digest(sourceBeforeMigration(text, holdId)) === revisionSchemaHash &&
      digest(sourceBeforeMigration(text, guardId)) === holdSchemaHash,
  );
  const ids = array.elements.map((entry) => property(entry, "migrationId"));
  checkObligation(
    "order",
    JSON.stringify(
      ids.map((id) => {
        if (id && ts.isStringLiteral(id)) return id.text;
        return id?.getText(file) === guardIdName && text.includes(guardIdDeclaration) ? guardId : null;
      }),
    ) === JSON.stringify(migrationIds),
  );
  const revision = array.elements[migrationIds.indexOf(revisionId)];
  const hold = array.elements[migrationIds.indexOf(holdId)];
  const guard = array.elements[migrationIds.indexOf(guardId)];
  const drop = array.elements[migrationIds.indexOf(dropId)];
  checkObligation(
    "add",
    !!revision && !!hold && hasExactSql(revision, [revisionSql], file) && hasExactSql(hold, holdSql, file),
  );
  checkObligation(
    "boot",
    !/\b(?:revision|payout_review_hold|payout_review_hold_stream_version)\b/.test(boot.text) &&
      !velocityStorage.test(boot.text) &&
      boot.getText(file).slice(1, -1) === boot.text,
  );
  checkObligation(
    "drop",
    !!drop &&
      hasExactSql(drop, dropSql, file) &&
      array.elements.every((entry) => entry === drop || !velocityStorage.test(entry.getText(file))),
  );
  checkObligation(
    "closed",
    file.statements.length === 4 &&
      [revision, hold, guard, drop].every(
        (entry) =>
          !!entry &&
          ts.isObjectLiteralExpression(entry) &&
          JSON.stringify(entry.properties.map((property) => property.name?.getText(file))) ===
            JSON.stringify(["migrationId", "description", "statements"]),
      ),
  );
  return failures;
}

function compositionViolations(sources: ReadonlyMap<string, string>) {
  return Object.entries(composedSources).flatMap(([file, hash]) =>
    digest(sources.get(file) ?? "") === hash ? [] : [file],
  );
}

describe("Settlement ledger-only schema contract", () => {
  it("risk-source schema keeps manual_payout_review for the previous fleet", () => {
    const { boot, array, file } = declarations(candidate)!;
    const guard = array.elements[migrationIds.indexOf(guardId)]!;
    expect(boot.text).toContain("manual_payout_review boolean NOT NULL DEFAULT false");
    expect(guard.getText(file)).toContain("WHERE manual_payout_review AND payout_review_hold_stream_version = 0");
    expect(candidate).not.toMatch(
      /\b(?:ADD|DROP|RENAME|ALTER)\s+COLUMN\s+(?:IF (?:NOT )?EXISTS\s+)?manual_payout_review\b/i,
    );
  });
  it("pins the complete immutable prefix, boot bytes, ordered migration members and raw/cooked ADD", () => {
    expect(violations(candidate)).toEqual([]);
    const parsed = declarations(candidate)!;
    let literalCount = 0;
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        expect(node.getText(parsed.file).slice(1, -1), `raw/cooked ${node.pos}`).toBe(node.text);
        literalCount++;
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed.file);
    expect(literalCount).toBe(63);
    console.info(
      `SETTLEMENT_SCHEMA_INVENTORY ${JSON.stringify({ sourceFiles: Object.keys(composedSources).length + 1, accountMigrations: parsed.array.elements.length, literalCount, ids: migrationIds })}`,
    );
  });

  it("pins all production boot and ledger siblings, imported SQL factories, module wiring and bootstrap ordering", () => {
    const sources = new Map(Object.keys(composedSources).map((file) => [file, source(file)]));
    expect(compositionViolations(sources)).toEqual([]);
    for (const [file, text] of sources) {
      const changed = new Map(sources).set(file, `${text}\nexport const opaqueSibling = sideEffect();\n`);
      expect(compositionViolations(changed), file).toEqual([file]);
    }
    for (const text of [
      source(compositionFile).replace(
        "  settlementAccountRiskSourceSchemaSql,",
        "  opaque(),\n  settlementAccountRiskSourceSchemaSql,",
      ),
      source(compositionFile).replace(
        "  ...settlementAccountRiskSourceSchemaMigrations,",
        "  ...settlementAccountRiskSourceSchemaMigrations,\n  { migrationId: 'later', dataStep: opaque },",
      ),
      source(compositionFile).replace("  ...settlementPayoutSchemaMigrations,", ""),
    ])
      expect(compositionViolations(new Map(sources).set(compositionFile, text))).toEqual([compositionFile]);
  });

  it("rejects the exact stopped-head fresh-CREATE revision through the fixed boot obligation", () => {
    const baseSource = sourceBeforeMigration(candidate, revisionId);
    const stopped = sourceBeforeMigration(candidate, holdId).replace(
      "  account_id text PRIMARY KEY,",
      "  account_id text PRIMARY KEY,\n  revision bigint NOT NULL DEFAULT 0,",
    );
    expect(digest(baseSource)).toBe(historicalHash);
    expect(digest(stopped)).toBe(stoppedHash);
    expect(violations(stopped)).toContain("boot");
  });

  it.each([
    ["wrong type", "revision bigint NOT NULL DEFAULT 0", "revision text NOT NULL DEFAULT 0"],
    ["nullable", "revision bigint NOT NULL DEFAULT 0", "revision bigint NULL DEFAULT 0"],
    ["wrong default", "revision bigint NOT NULL DEFAULT 0", "revision bigint NOT NULL DEFAULT 1"],
    ["missing default", "revision bigint NOT NULL DEFAULT 0", "revision bigint NOT NULL"],
    ["non-idempotent", "ADD COLUMN IF NOT EXISTS revision", "ADD COLUMN revision"],
    ["incomplete ADD", "revision bigint NOT NULL DEFAULT 0", "revision"],
    [
      "trailing drop",
      "revision bigint NOT NULL DEFAULT 0",
      "revision bigint NOT NULL DEFAULT 0; DROP TABLE settlement_account_risk_sources",
    ],
    [
      "trailing state",
      "revision bigint NOT NULL DEFAULT 0",
      "revision bigint NOT NULL DEFAULT 0; ALTER TABLE settlement_account_risk_sources ALTER COLUMN revision DROP NOT NULL",
    ],
    ["raw/cooked escape", "revision bigint NOT NULL DEFAULT 0", "revision bigint NOT NULL DEFAULT \\x30"],
  ])("rejects complete-ADD/state mutant %s even with source-identity obligation bypassed", (_name, before, after) => {
    const mutant = candidate.replace(before, after);
    expect(mutant).not.toBe(candidate);
    expect(violations(mutant, "identity")).toContain("add");
    expect(violations(mutant, "add")).toContain("identity");
    expect(sourceBeforeMigration(mutant, revisionId)).toBe(sourceBeforeMigration(candidate, revisionId));
  });

  it("refuses hold columns in bootstrap SQL even with source identity bypassed", () => {
    const mutant = candidate.replace(
      "  account_id text PRIMARY KEY,",
      "  account_id text PRIMARY KEY,\n  payout_review_hold boolean NOT NULL DEFAULT false,",
    );
    expect(violations(mutant, "identity")).toContain("boot");
  });

  it.each([
    [
      "settlement_account_velocity_sources",
      "CREATE TABLE IF NOT EXISTS settlement_account_velocity_sources (source_id text PRIMARY KEY);",
    ],
    ...velocityColumns.map((column) => [
      column,
      `ALTER TABLE settlement_account_risk_sources\n  ADD COLUMN IF NOT EXISTS ${column} integer NULL;`,
    ]),
  ])("refuses %s in bootstrap SQL even with source identity bypassed", (_name, statement) => {
    const mutant = candidate.replace("\n`;\n", `\n\n${statement}\n\`;\n`);
    expect(mutant).not.toBe(candidate);
    expect(violations(mutant, "identity")).toContain("boot");
  });

  it("names velocity storage in the drop migration and in no other boot or ledger source", () => {
    const { array, file } = declarations(candidate)!;
    const drop = array.elements[migrationIds.indexOf(dropId)]!;
    expect(array.elements.at(-1)).toBe(drop);
    expect(candidate.replace(drop.getText(file), "")).not.toMatch(velocityStorage);
    for (const sibling of Object.keys(composedSources)) expect(source(sibling), sibling).not.toMatch(velocityStorage);
  });

  it.each([
    ["missing lock timeout", "      `SET lock_timeout = '5s'`,\n      `DROP TABLE", "      `DROP TABLE"],
    [
      "unguarded table drop",
      "DROP TABLE IF EXISTS settlement_account_velocity_sources",
      "DROP TABLE settlement_account_velocity_sources",
    ],
    ["unguarded column drop", "DROP COLUMN IF EXISTS velocity_alert_flags", "DROP COLUMN velocity_alert_flags"],
    ["retained column", ",\n  DROP COLUMN IF EXISTS velocity_alert_flags", ""],
    [
      "widened drop",
      "DROP COLUMN IF EXISTS velocity_alert_flags",
      "DROP COLUMN IF EXISTS velocity_alert_flags,\n  DROP COLUMN IF EXISTS review_count",
    ],
    [
      "cascading drop",
      "DROP TABLE IF EXISTS settlement_account_velocity_sources",
      "DROP TABLE IF EXISTS settlement_account_velocity_sources CASCADE",
    ],
    [
      "older statement that still names the table",
      "`ALTER TABLE settlement_account_review_sources ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL`,",
      "`ALTER TABLE settlement_account_review_sources ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL`,\n      `ALTER TABLE IF EXISTS settlement_account_velocity_sources ADD COLUMN IF NOT EXISTS amount_currency_code text NULL`,",
    ],
  ])("refuses drop mutant %s even with source identity bypassed", (_name, before, after) => {
    const mutant = candidate.replace(before, after);
    expect(mutant).not.toBe(candidate);
    expect(violations(mutant, "identity")).toContain("drop");
    expect(violations(mutant, "drop")).toContain("identity");
  });

  it("refuses the drop ahead of an existing migration through the pinned order", () => {
    const parsed = declarations(candidate)!;
    const guard = parsed.array.elements[migrationIds.indexOf(guardId)]!;
    const drop = parsed.array.elements[migrationIds.indexOf(dropId)]!;
    const mutant =
      candidate.slice(0, guard.getStart()) +
      drop.getText() +
      candidate.slice(guard.end, drop.getStart()) +
      guard.getText() +
      candidate.slice(drop.end);
    expect(violations(mutant, "identity")).toContain("order");
  });

  it("refuses a missing hold statement or a changed default without relying on the full-source hash", () => {
    for (const mutant of [
      candidate.replace(`      \`${holdSql[1]}\`,\n`, ""),
      candidate.replace(
        "payout_review_hold boolean NOT NULL DEFAULT false",
        "payout_review_hold boolean NOT NULL DEFAULT true",
      ),
    ]) {
      expect(mutant).not.toBe(candidate);
      expect(violations(mutant, "identity")).toContain("add");
      expect(sourceBeforeMigration(mutant, holdId)).toBe(sourceBeforeMigration(candidate, holdId));
    }
  });

  it.each([
    [
      "opaque boot without target tokens",
      "export const settlementAccountRiskSourceSchemaSql = `",
      "export const settlementAccountRiskSourceSchemaSql = opaque() + `",
    ],
    ["opaque historical prefix", "`SET lock_timeout = '5s'`", "opaque()"],
    ["prefix expression without target tokens", "`SET lock_timeout = '5s'`", "(() => opaque())()"],
    [
      "later statement",
      "revision bigint NOT NULL DEFAULT 0`,",
      "revision bigint NOT NULL DEFAULT 0`,\n      `SELECT opaque()`,",
    ],
    [
      "dataStep member",
      'Introduce the publication revision after immutable legacy normalization; existing rows start at zero.",',
      'Introduce the publication revision after immutable legacy normalization; existing rows start at zero.",\n    dataStep: opaque,',
    ],
    [
      "unknown member",
      'Introduce the publication revision after immutable legacy normalization; existing rows start at zero.",',
      'Introduce the publication revision after immutable legacy normalization; existing rows start at zero.",\n    future: opaque(),',
    ],
    ["new export", "] as const;", "] as const;\nexport const later = opaque();"],
    ["new sibling", "] as const;", "] as const;\nconst sibling = { statements: [opaque()] };"],
    ["removed suffix", "     AND revealed_at IS NULL", ""],
    [
      "later DDL",
      "revision bigint NOT NULL DEFAULT 0`,",
      "revision bigint NOT NULL DEFAULT 0`,\n      `ALTER TABLE settlement_account_risk_sources DROP COLUMN revision`,",
    ],
  ])("refuses source/member/expression mutant %s", (_name, before, after) => {
    const mutant = candidate.replace(before, after);
    expect(mutant).not.toBe(candidate);
    expect(violations(mutant, "identity").length).toBeGreaterThan(0);
    expect(violations(mutant, "prefix")).toContain("identity");
  });

  it("rejects reordered normalizers independently of either prefix or full-source identity", () => {
    const parsed = declarations(candidate)!;
    const first = parsed.array.elements[0]!;
    const second = parsed.array.elements[1]!;
    const mutant =
      candidate.slice(0, first.getStart()) +
      second.getText() +
      candidate.slice(first.end, second.getStart()) +
      first.getText() +
      candidate.slice(second.end);
    expect(violations(mutant, "identity")).toContain("order");
    expect(violations(mutant, "prefix")).toContain("order");
  });
});
