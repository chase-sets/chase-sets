import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import {
  findBootSchemaLedgerConvergenceViolations,
  findBootSchemaRetainedUpgradeViolations,
} from "../../../../../../scripts/check-structure/boot-schema-ddl-discipline.mjs";

const root = new URL("../../../../../../", import.meta.url);
const accountFile =
  "bounded-contexts/settlement/features/wallets/integrations/account-risk-source/account-risk-source-schema.ts";
const compositionFile = "bounded-contexts/settlement/support/runtime-support/schema.ts";
const source = (file: string) => readFileSync(new URL(file, root), "utf8").replace(/\r\n/g, "\n");
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const candidate = source(accountFile);
const revisionId = "20261104_settlement_account_risk_source_revision";
const revisionSql =
  "ALTER TABLE settlement_account_risk_sources\n  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0";
const candidateHash = "47c64402367e57c6f9bca8fc4aafcc7483aee1849e71ad2cce5ee12d7e4e36b5";
const historicalHash = "a1de72122075c49e538ddf87e471c3ca29e3fb3775bd17a84041a5f49d24e610";
const stoppedHash = "c0d4c4dfd3a81a360336334e3f7f7ffb397bad3ebca065b1b43039bddec877ea";
const migrationIds = [
  "20260907_settlement_listing_risk_currency",
  "20260720_settlement_account_linkage_clusters",
  "20260720_settlement_account_linkage_closer_cursor",
  "20260715_settlement_review_scoring_disposition",
  "20260706_settlement_payments_fraud_risk_sources",
  "20260707_settlement_linked_account_risk_sources",
  "20260707_settlement_account_velocity_risk_sources",
  "20260711_settlement_account_review_sources_reveal",
  revisionId,
];

// Fixed Settlement lifecycle evidence at abb4857e, not SQL eligibility inference or a guard exemption.
// Full source pins include imports, exports, every executable member and opaque expressions.
const composedSources = {
  "bounded-contexts/settlement/index.ts": "3204e9b1b2e6e44f6bf91ae073af4f3ff23d2581a81f88b34b323a79cf0ee683",
  "bounded-contexts/settlement/support/runtime-support/schema.ts":
    "2274e4327827a68c647aa383821fe93b6157dadfceba961918ebbe3fe88ca7be",
  "bounded-contexts/settlement/support/runtime-support/unlogged-projection-migrations.ts":
    "ed378de547da902d0bd329158adf9d7de733941ea875dfe5190bdee9987defa2",
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
  "infrastructure/event-core-postgres/index.ts": "9c6ca8816c5caf4ffa519f90e4dd36efc35c2acd5fde4238032f1e6a4abcbd41",
  "infrastructure/event-core-postgres/schema.ts": "859f765c43198b40d005134b96f821b5e90a335f02a521d4018144b3efddcaf4",
  "infrastructure/notification-outbox/index.ts": "24ff5dd032a3c3fa6b2b91efb97ec06e4a73e28bb1e615de9a771a90c8b1e537",
  "infrastructure/platform-policy/schema.ts": "dd1923a1b8ebd4d8e562e5f9198655f01569c5c145441f682a3edd0af92e46b2",
  "infrastructure/platform-runtime/durable-job-store.ts":
    "2c7678d007db36b623d8b244d206fd8990ff871617acdb190c35f4efdee5c7a0",
  "infrastructure/platform-runtime/durable-job-work-units.ts":
    "15a95d797c8138ff20098e331cba58448d7efdc4c6158eec610e229ba73899e8",
  "infrastructure/bounded-context-runtime/schema.ts":
    "3cf19fd7fc077eecc6d44586893efae11f421f91b6d042003979d975d1875a70",
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

function historicalSource(text: string) {
  const parsed = declarations(text);
  const last = parsed?.array.elements.at(-1);
  return last ? `${text.slice(0, last.getFullStart())}\n] as const;\n` : "";
}

type Obligation = "identity" | "prefix" | "order" | "add" | "boot" | "closed";
function violations(text: string, bypass?: Obligation) {
  const failures: string[] = [];
  const require = (key: Obligation, valid: boolean) => {
    if (key !== bypass && !valid) failures.push(key);
  };
  require("identity", digest(text) === candidateHash);
  const parsed = declarations(text);
  if (!parsed) return [...failures, "opaque-source"];
  const { file, boot, array } = parsed;
  require("prefix", digest(historicalSource(text)) === historicalHash);
  const ids = array.elements.map((entry) => property(entry, "migrationId"));
  require("order", JSON.stringify(ids.map((id) => (id && ts.isStringLiteral(id) ? id.text : null))) ===
    JSON.stringify(migrationIds));
  const last = array.elements.at(-1)!;
  const statements = property(last, "statements");
  const add =
    statements && ts.isArrayLiteralExpression(statements) && statements.elements.length === 1
      ? statements.elements[0]
      : undefined;
  require("add", !!add &&
    ts.isNoSubstitutionTemplateLiteral(add) &&
    add.text === revisionSql &&
    add.getText(file).slice(1, -1) === revisionSql);
  require("boot", !/\brevision\b/.test(boot.text) && boot.getText(file).slice(1, -1) === boot.text);
  require("closed", file.statements.length === 3 &&
    ts.isObjectLiteralExpression(last) &&
    JSON.stringify(last.properties.map((entry) => entry.name?.getText(file))) ===
      JSON.stringify(["migrationId", "description", "statements"]));
  return failures;
}

function compositionViolations(sources: ReadonlyMap<string, string>) {
  return Object.entries(composedSources).flatMap(([file, hash]) =>
    digest(sources.get(file) ?? "") === hash ? [] : [file],
  );
}

describe("Settlement ledger-only schema contract", () => {
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
    expect(literalCount).toBeGreaterThan(70);
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

  it("preserves ordinary R99 candidate acceptance and the exact stopped-head fresh-CREATE refusal", () => {
    const baseSource = historicalSource(candidate);
    const stopped = candidate.replace(
      "  account_id text PRIMARY KEY,",
      "  account_id text PRIMARY KEY,\n  revision bigint NOT NULL DEFAULT 0,",
    );
    expect(digest(baseSource)).toBe(historicalHash);
    expect(digest(stopped)).toBe(stoppedHash);
    expect(violations(stopped)).toContain("boot");
    for (const currentSource of [candidate, stopped]) {
      expect(findBootSchemaLedgerConvergenceViolations({ baseSource, currentSource })).toEqual([]);
      const refused = findBootSchemaRetainedUpgradeViolations({ baseSource, currentSource });
      expect(refused.map((entry: { columnName: string }) => entry.columnName)).toEqual(
        currentSource === stopped ? ["revision"] : [],
      );
      console.info(
        `SETTLEMENT_R99_CONTROL ${currentSource === stopped ? "stopped-77ea12e" : "candidate"} refusals=${refused.length}`,
      );
    }
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
    expect(historicalSource(mutant)).toBe(historicalSource(candidate));
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
