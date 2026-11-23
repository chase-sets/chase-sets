import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  buildSettlementIdentityAccountRiskSourceProjectionHandlers,
  buildSettlementPaymentsAccountRiskSourceProjectionHandlers,
  buildSettlementPayoutReviewHoldProjectionHandlers,
  buildSettlementReputationAccountRiskSourceProjectionHandlers,
} from "./account-risk-source-projection";
import authorityMatrix from "./authority-matrix.fixture.json" with { type: "json" };
import {
  settlementAccountRiskSourceSchemaMigrations,
  settlementAccountRiskSourceSchemaSql,
} from "./account-risk-source-schema";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

function sqlStrings(file: string, content: string): string[] {
  if (file.endsWith(".sql")) return [content];
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const strings: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      strings.push(node.head.text + node.templateSpans.map((span) => `dynamic_column${span.literal.text}`).join(""));
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return strings;
}

function riskWrites(sources: ReadonlyMap<string, string>) {
  return [...sources].flatMap(([file, content]) =>
    sqlStrings(file, content).flatMap((sql) =>
      sql
        .split(";")
        .filter((statement) =>
          /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|COPY)\s+(?:ONLY\s+)?(?:[\w"]+\.)?"?settlement_account_risk_sources"?\b/i.test(
            statement,
          ),
        )
        .map((statement) => ({ file, sql: statement.trim() })),
    ),
  );
}

function topLevelParts(sql: string, separator: string) {
  const tokens = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\$\d+|[A-Za-z_][\w$]*|\d+|[^\s]/g) ?? [];
  const parts: string[] = [];
  let depth = 0;
  let current: string[] = [];
  for (const token of tokens) {
    if (token === "(") depth++;
    if (token === ")") depth--;
    if (depth === 0 && token.toUpperCase() === separator) {
      parts.push(current.join(" "));
      current = [];
    } else current.push(token);
  }
  parts.push(current.join(" "));
  return parts;
}

function revisionViolation(sql: string): string | null {
  const insert = sql.match(/^INSERT\s+INTO\s+settlement_account_risk_sources\s*\(([^)]+)\)([\s\S]*)$/i);
  const atomic = /\brevision\s*=\s*settlement_account_risk_sources\.revision\s*\+\s*1\s*(?:,|WHERE\b|$)/i;
  if (!insert)
    return /^UPDATE\s+settlement_account_risk_sources\b/i.test(sql) && atomic.test(sql) ? null : "unrevisioned write";
  const columns = insert[1]!.split(",").map((column) => column.trim());
  const revisionIndex = columns.indexOf("revision");
  if (revisionIndex < 0) return "missing insert revision";
  const body = insert[2]!;
  const values = body.match(/^\s*VALUES\s*\(([^)]+)\)/i);
  const select = values ? null : topLevelParts(body, "SELECT")[1];
  const expressions = values
    ? topLevelParts(values[1]!, ",")
    : select
      ? topLevelParts(topLevelParts(select, "FROM")[0]!, ",")
      : [];
  if (expressions[revisionIndex]?.trim() !== "1") return "insert revision is not one";
  const conflict = body.split(/ON\s+CONFLICT[\s\S]*?DO\s+UPDATE\s+SET/i)[1];
  return conflict && atomic.test(conflict) ? null : "non-atomic conflict revision";
}

function inventoryViolations(sources: ReadonlyMap<string, string>) {
  const legacy = new Set(authorityMatrix.legacyNormalization.flatMap((entry) => entry.statements));
  return riskWrites(sources).flatMap(({ file, sql }) => {
    if (file === authorityMatrix.legacySchemaFile && legacy.delete(sql)) return [];
    const registered = authorityMatrix.writers.some((writer) => writer.file === file);
    const violation = revisionViolation(sql);
    return registered && !violation ? [] : [`${file}: ${violation ?? "unregistered writer"}`];
  });
}

function event(type: string, data: Record<string, unknown>, streamId = "identity.account-acc_seller"): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_1",
    streamId,
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_seller" },
    timing: { occurredAt: "2026-05-01T00:00:00.000Z", recordedAt: "2026-05-01T00:00:00.000Z" },
  });
}

const projectionFile = authorityMatrix.writers[0]!.file;

const velocityStorage =
  /settlement_account_velocity_sources|velocity_alert_flags|chargeback_(?:7d|30d)_|listing_24h_|review_24h_|buyer_(?:order|spend)_24h_/;

function createRecordingDb() {
  return {
    query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] })),
  };
}

describe("settlement account risk source projection", () => {
  it("requires every account-risk writer to publish an atomic revision", () => {
    const discovered = execFileSync(
      "git",
      [
        "grep",
        "--untracked",
        "--exclude-standard",
        "-l",
        "-I",
        "settlement_account_risk_sources",
        "--",
        "bounded-contexts",
        "contracts",
        "deployables",
        "infrastructure",
        "packages",
        "scripts",
      ],
      { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    )
      .trim()
      .split(/\r?\n/)
      .filter(
        (file) =>
          /\.(?:[cm]?[jt]sx?|sql)$/.test(file) &&
          !/\.(?:test|spec|fixture)\./.test(file) &&
          !/(?:^|\/)(?:tests|__tests__|dist|build)\//.test(file),
      );
    const sources = new Map(discovered.map((file) => [file, readFileSync(path.join(repoRoot, file), "utf8")]));
    expect(inventoryViolations(sources)).toEqual([]);
    const writes = riskWrites(sources);
    for (const writer of authorityMatrix.writers) {
      expect(writes.filter((write) => write.file === writer.file)).toHaveLength(writer.count);
    }
  });

  it("classifies only exact immutable legacy normalization before revision introduction", () => {
    const migrations = settlementAccountRiskSourceSchemaMigrations;
    const revisionIndex = migrations.findIndex(
      (migration) => migration.migrationId === authorityMatrix.revisionMigration,
    );
    expect(revisionIndex).toBeGreaterThan(0);
    expect(settlementAccountRiskSourceSchemaSql).not.toMatch(
      /ALTER TABLE settlement_account_risk_sources\s+ADD COLUMN IF NOT EXISTS revision/,
    );
    for (const legacy of authorityMatrix.legacyNormalization) {
      const index = migrations.findIndex((migration) => migration.migrationId === legacy.migrationId);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(revisionIndex);
      expect(
        migrations[index]!.statements.filter((sql) => /^UPDATE settlement_account_risk_sources\b/.test(sql)),
      ).toEqual(legacy.statements);
    }
  });

  it("does not exempt a legacy statement copied into a new schema migration", () => {
    const sql = authorityMatrix.legacyNormalization[0]!.statements[0]!;
    const source = `const migrations = [
      { migrationId: "legacy", statements: [\`${sql}\`] },
      { migrationId: "future", statements: [\`${sql}\`] }
    ];`;
    expect(inventoryViolations(new Map([[authorityMatrix.legacySchemaFile, source]]))).toHaveLength(1);
  });

  it.each([
    [
      "new writer file",
      "bounded-contexts/settlement/features/wallets/integrations/new-writer.ts",
      "INSERT INTO settlement_account_risk_sources (account_id, revision) VALUES ($1, 1) ON CONFLICT (account_id) DO UPDATE SET revision = settlement_account_risk_sources.revision + 1",
    ],
    [
      "plain UPDATE",
      authorityMatrix.writers[0]!.file,
      "UPDATE settlement_account_risk_sources SET trusted_seller = true WHERE account_id = $1",
    ],
    [
      "missing insert revision",
      authorityMatrix.writers[0]!.file,
      "INSERT INTO settlement_account_risk_sources (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
    ],
    [
      "wrong revision slot",
      authorityMatrix.writers[0]!.file,
      "INSERT INTO settlement_account_risk_sources (account_id, revision, stripe_fraud_signal_count) VALUES ($1, 0, 1) ON CONFLICT (account_id) DO UPDATE SET revision = settlement_account_risk_sources.revision + 1",
    ],
    [
      "non-atomic counter",
      authorityMatrix.writers[0]!.file,
      "UPDATE settlement_account_risk_sources SET revision = $2 WHERE account_id = $1",
    ],
    [
      "future hold writer",
      authorityMatrix.writers[0]!.file,
      "UPDATE settlement_account_risk_sources SET payout_review_hold = true WHERE account_id = $1",
    ],
    [
      "future schema backfill",
      "bounded-contexts/settlement/features/wallets/integrations/account-risk-source/account-risk-source-schema.ts",
      "UPDATE settlement_account_risk_sources SET trusted_seller = false",
    ],
  ])("discovers and rejects %s through the same source scan", (_name, file, sql) => {
    expect(inventoryViolations(new Map([[file, `db.query(\`${sql}\`);`]]))).toHaveLength(1);
  });

  it("handles only the retained risk source events and none of the velocity-only events", () => {
    const db = createRecordingDb();
    expect(Object.keys(buildSettlementIdentityAccountRiskSourceProjectionHandlers(db as never)).sort()).toEqual([
      "identity.account.badge-assigned",
      "identity.account.badge-removed",
      "identity.account.created",
      "identity.shipping-address.added",
      "identity.shipping-address.archived",
      "identity.shipping-address.updated",
    ]);
    expect(Object.keys(buildSettlementReputationAccountRiskSourceProjectionHandlers(db as never)).sort()).toEqual([
      "marketplace.review-hold.extended",
      "marketplace.review-hold.placed",
      "marketplace.review-hold.reduced",
      "marketplace.review-hold.released",
      "marketplace.review-hold.terminal-recorded",
      "marketplace.review-scoring.disposition-projected.v1",
      "marketplace.review.revealed",
      "marketplace.review.submitted",
      "marketplace.review.updated",
      "marketplace.review.withdrawn",
    ]);
    expect(Object.keys(buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db as never)).sort()).toEqual([
      "payments.checkout-affordances-published",
      "payments.payment-fraud-review-closed",
      "payments.payment-fraud-review-opened",
      "payments.payment-fraud-warning-received",
    ]);
    expect(Object.keys(buildSettlementPayoutReviewHoldProjectionHandlers(db as never)).sort()).toEqual([
      "settlement.payout-review-hold.placed",
      "settlement.payout-review-hold.released",
    ]);
  });

  it("issues no velocity statement when an account is created or a review is submitted", async () => {
    const db = createRecordingDb();
    await buildSettlementIdentityAccountRiskSourceProjectionHandlers(db as never)["identity.account.created"]!(
      event("identity.account.created", { accountId: "acc_reviewer", createdAt: "2026-07-06T00:00:00.000Z" }),
    );
    await buildSettlementReputationAccountRiskSourceProjectionHandlers(db as never)["marketplace.review.submitted"]!(
      event(
        "marketplace.review.submitted",
        {
          reviewId: "rev_2",
          orderId: "ord_2",
          authorAccountId: "acc_reviewer",
          subjectAccountId: "acc_seller",
          authorRole: "buyer",
          rating: 5,
          submittedAt: "2026-07-07T00:00:00.000Z",
        },
        "marketplace.review-rev_2",
      ),
    );

    const statements = db.query.mock.calls.map(([sql]) => sql);
    expect(statements).toHaveLength(3);
    for (const sql of statements) expect(sql).not.toMatch(velocityStorage);
    expect(readFileSync(path.join(repoRoot, projectionFile), "utf8")).not.toMatch(velocityStorage);
  });

  it("projects the account creation time once and keeps the first recorded value", async () => {
    const db = createRecordingDb();
    const handlers = buildSettlementIdentityAccountRiskSourceProjectionHandlers(db as never);

    await handlers["identity.account.created"]!(
      event("identity.account.created", { accountId: "acc_seller", createdAt: "2026-04-30T00:00:00.000Z" }),
    );
    await handlers["identity.account.created"]!(event("identity.account.created", { accountId: "acc_buyer" }));

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "account_created_at = COALESCE(settlement_account_risk_sources.account_created_at, EXCLUDED.account_created_at)",
      ),
      ["acc_seller", "2026-04-30T00:00:00.000Z"],
    );
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("account_created_at"), [
      "acc_buyer",
      "2026-05-01T00:00:00.000Z",
    ]);
  });

  it("ignores frozen manual payout review badge assignments and removals", async () => {
    const query = vi.fn();
    const handlers = buildSettlementIdentityAccountRiskSourceProjectionHandlers({ query });
    for (const type of ["identity.account.badge-assigned", "identity.account.badge-removed"]) {
      await handlers[type]!(event(type, { badgeKey: "manual-payout-review" }));
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("projects trusted seller badges and reputation reviews into payout release inputs", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("RETURNING subject_account_id")) {
          return { rows: [{ subject_account_id: "acc_seller" }] };
        }
        return { rows: [] };
      }),
    };
    const identityHandlers = buildSettlementIdentityAccountRiskSourceProjectionHandlers(db as never);
    const reputationHandlers = buildSettlementReputationAccountRiskSourceProjectionHandlers(db as never);

    await identityHandlers["identity.account.badge-assigned"]!(
      event("identity.account.badge-assigned", { badgeKey: "trusted-seller" }),
    );
    await reputationHandlers["marketplace.review.submitted"]!(
      event(
        "marketplace.review.submitted",
        {
          reviewId: "rev_1",
          orderId: "ord_1",
          subjectAccountId: "acc_seller",
          authorRole: "buyer",
          rating: 5,
          submittedAt: "2026-05-03T00:00:00.000Z",
        },
        "marketplace.review-rev_1",
      ),
    );

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("trusted_seller"), [
      "acc_seller",
      true,
      "2026-05-01T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO settlement_account_review_sources"),
      [
        "rev_1",
        "ord_1",
        "acc_seller",
        "buyer",
        5,
        "2026-05-03T00:00:00.000Z",
        "included",
        "normal-completion",
        "resolution-aware-v1",
        "[]",
        null,
      ],
    );
    expect(db.query).toHaveBeenNthCalledWith(3, expect.stringContaining("review_count"), [
      "acc_seller",
      "2026-05-03T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(3, expect.stringContaining("author_role = 'buyer'"), [
      "acc_seller",
      "2026-05-03T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(3, expect.stringContaining("average_rating"), [
      "acc_seller",
      "2026-05-03T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it("projects Stripe fraud signals into buyer risk sources", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db as never);

    await handlers["payments.payment-fraud-warning-received"]!(
      event("payments.payment-fraud-warning-received", {
        buyerAccountId: "acc_buyer",
        receivedAt: "2026-07-06T12:05:00.000Z",
      }),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("stripe_fraud_signal_count"), [
      "acc_buyer",
      "2026-07-06T12:05:00.000Z",
    ]);
  });

  it("projects Stripe fraud review openings and closings into buyer risk sources", async () => {
    const db = createRecordingDb();
    const handlers = buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db as never);

    await handlers["payments.payment-fraud-review-opened"]!(
      event("payments.payment-fraud-review-opened", {
        buyerAccountId: "acc_buyer",
        openedAt: "2026-07-06T12:05:00.000Z",
      }),
    );
    await handlers["payments.payment-fraud-review-closed"]!(
      event("payments.payment-fraud-review-closed", {
        buyerAccountId: "acc_buyer",
        outcome: "approved",
        closedAt: "2026-07-06T13:05:00.000Z",
      }),
    );

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "stripe_review_open_count = settlement_account_risk_sources.stripe_review_open_count + 1",
      ),
      ["acc_buyer", "2026-07-06T12:05:00.000Z"],
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "stripe_review_open_count = GREATEST(0, settlement_account_risk_sources.stripe_review_open_count - 1)",
      ),
      ["acc_buyer", false, "2026-07-06T13:05:00.000Z"],
    );
  });

  it("projects placed and released Payout Review Holds with their stream version", async () => {
    const db = createRecordingDb();
    const handlers = buildSettlementPayoutReviewHoldProjectionHandlers(db as never);
    const holdEvent = (type: string, streamVersion: number) =>
      buildTransportEvent(
        type,
        { accountId: "acc_seller" },
        {
          id: `evt_hold_${streamVersion}`,
          streamId: "settlement.payout-review-hold-acc_seller",
          streamVersion,
          tenantId: "tnt_test",
          audit: { performedByUserId: "usr_test", forAccountId: "acc_seller" },
          timing: { occurredAt: "2026-05-01T00:00:00.000Z", recordedAt: "2026-05-01T00:00:00.000Z" },
        },
      );

    await handlers["settlement.payout-review-hold.placed"]!(holdEvent("settlement.payout-review-hold.placed", 1));
    await handlers["settlement.payout-review-hold.released"]!(holdEvent("settlement.payout-review-hold.released", 2));

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("payout_review_hold"), [
      "acc_seller",
      true,
      1,
      "2026-05-01T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("payout_review_hold"), [
      "acc_seller",
      false,
      2,
      "2026-05-01T00:00:00.000Z",
    ]);
  });

  it("projects shared payment instrument clusters into account risk sources", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT DISTINCT account_id")) {
          return { rows: [{ account_id: "acc_buyer" }, { account_id: "acc_linked" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db as never);

    await handlers["payments.checkout-affordances-published"]!(
      event(
        "payments.checkout-affordances-published",
        {
          accountId: "acc_buyer",
          savedCheckoutInstruments: [
            {
              instrumentId: "sci_card",
              instrumentRiskClusterKey: "instrument:shared",
              readiness: "ready",
            },
          ],
          publishedAt: "2026-07-07T13:05:00.000Z",
        },
        "payments.checkout-affordances-acc_buyer",
      ),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("settlement_account_instrument_risk_sources"), [
      "acc_buyer",
      "sci_card",
      "instrument:shared",
      true,
      "2026-07-07T13:05:00.000Z",
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("shared_instrument_cluster_count"), [
      "acc_linked",
      "2026-07-07T13:05:00.000Z",
    ]);
  });

  it("projects shared shipping address clusters into account risk sources", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT DISTINCT account_id")) {
          return { rows: [{ account_id: "acc_buyer" }, { account_id: "acc_linked" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildSettlementIdentityAccountRiskSourceProjectionHandlers(db as never);

    await handlers["identity.shipping-address.added"]!(
      event("identity.shipping-address.added", {
        accountId: "acc_buyer",
        shippingAddressId: "adr_1",
        address: {
          name: "Buyer",
          company: null,
          line1: "10 Main St",
          line2: null,
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
          phone: null,
          email: null,
        },
        addedAt: "2026-07-07T14:05:00.000Z",
      }),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("settlement_account_address_risk_sources"), [
      "acc_buyer",
      "adr_1",
      "us|78701|tx|austin|10 main st|",
      "2026-07-07T14:05:00.000Z",
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("shared_address_cluster_count"), [
      "acc_linked",
      "2026-07-07T14:05:00.000Z",
    ]);
  });
});
