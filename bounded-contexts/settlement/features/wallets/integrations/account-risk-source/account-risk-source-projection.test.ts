import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import { isTransientProjectionError } from "@chase-sets/event-core/projector";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { isPgRetryableTransientError } from "@chase-sets/event-core-postgres";
import {
  buildSettlementIdentityAccountRiskSourceProjectionHandlers,
  buildSettlementPaymentsAccountRiskSourceProjectionHandlers,
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

const canonicalMoneyCases = [
  { value: "12.34", cents: 1_234 },
  { value: "12", cents: 1_200 },
  { value: "12.3", cents: 1_230 },
  { value: "0.00", cents: 0 },
  { value: "9999999999.99", cents: 999_999_999_999 },
  { value: "  12.34", cents: 1_234 },
  { value: "12.34  ", cents: 1_234 },
  { value: null, cents: 0 },
  { value: undefined, cents: 0 },
] as const;

const malformedMoneyStrings = [
  "12.345",
  "1.0001",
  "12. 34",
  "12.34abc",
  "12.34 USD",
  "$12.34",
  "1e2",
  "1.5e3",
  "-12.34",
  "-0.00",
  "+12.34",
  "10000000000.00",
  "9999999999.991",
  "1,234.56",
  "12,34",
  "0x10",
  "",
  "   ",
  "abc",
  "Infinity",
  "NaN",
] as const;

const malformedNonStringMoneyValues: readonly unknown[] = [
  12.34,
  1_234,
  -12.34,
  0.30000000000000004,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  1_234n,
  -1n,
  true,
  false,
  ["12.34"],
  [12.34],
  ["12.34", "56.78"],
  [],
  { amount: "12.34" },
];

function createMoneyDb() {
  return {
    query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] })),
  };
}

function buildMoneyHandlerCases(db: ReturnType<typeof createMoneyDb>) {
  return [
    {
      handler: buildSettlementReputationAccountRiskSourceProjectionHandlers(db as never)[
        "marketplace.listing.created"
      ]!,
      makeEvent: (value: unknown) =>
        event(
          "marketplace.listing.created",
          { listingId: "lst_money", accountId: "acc_money", priceAmount: value },
          "marketplace.listing-lst_money",
        ),
    },
    {
      handler: buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db as never)["payments.payment-created"]!,
      makeEvent: (value: unknown) =>
        event(
          "payments.payment-created",
          { paymentId: "pay_money", buyerAccountId: "acc_money", amount: value, sellerPayouts: [] },
          "payments.payment-pay_money",
        ),
    },
  ];
}

function velocitySourceInsertCalls(db: ReturnType<typeof createMoneyDb>) {
  return db.query.mock.calls.filter(
    ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO settlement_account_velocity_sources"),
  );
}

async function captureHandlerError(action: () => Promise<void>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
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

  it("risk projection money consolidation preserves canonical cents and the absent-value default", async () => {
    for (const moneyCase of canonicalMoneyCases) {
      for (const caseIndex of [0, 1] as const) {
        const db = createMoneyDb();
        const handlerCase = buildMoneyHandlerCases(db)[caseIndex];

        await handlerCase.handler(handlerCase.makeEvent(moneyCase.value));

        const insertCalls = velocitySourceInsertCalls(db);
        expect(insertCalls).toHaveLength(1);
        expect(insertCalls[0]?.[1]?.[4]).toBe(moneyCase.cents);
      }
    }
  });

  it("risk projection money coercion applies the ruled outcome for every malformed payload shape", async () => {
    for (const value of malformedMoneyStrings) {
      for (const caseIndex of [0, 1] as const) {
        const db = createMoneyDb();
        const handlerCase = buildMoneyHandlerCases(db)[caseIndex];
        const error = await captureHandlerError(() => handlerCase.handler(handlerCase.makeEvent(value)));

        expect(error).toBeInstanceOf(Error);
        expect(isTransientProjectionError(error)).toBe(false);
        expect(isPgRetryableTransientError(error)).toBe(false);
        expect(velocitySourceInsertCalls(db)).toHaveLength(0);
      }
    }
  });

  it("risk projection money coercion rejects non-string payload values", async () => {
    for (const value of malformedNonStringMoneyValues) {
      for (const caseIndex of [0, 1] as const) {
        const db = createMoneyDb();
        const handlerCase = buildMoneyHandlerCases(db)[caseIndex];
        const error = await captureHandlerError(() => handlerCase.handler(handlerCase.makeEvent(value)));

        expect(error).toBeInstanceOf(Error);
        expect(isTransientProjectionError(error)).toBe(false);
        expect(isPgRetryableTransientError(error)).toBe(false);
        expect(velocitySourceInsertCalls(db)).toHaveLength(0);
      }
    }
  });

  it("risk projection money rejection raises a non-transient projection error and persists no velocity source", async () => {
    for (const caseIndex of [0, 1] as const) {
      const db = createMoneyDb();
      const handlerCase = buildMoneyHandlerCases(db)[caseIndex];
      const error = await captureHandlerError(() => handlerCase.handler(handlerCase.makeEvent("-12.34")));

      expect(error).toBeInstanceOf(Error);
      expect(isTransientProjectionError(error)).toBe(false);
      expect(isPgRetryableTransientError(error)).toBe(false);
      expect(velocitySourceInsertCalls(db)).toHaveLength(0);
    }
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

  it("projects event-sourced velocity counters for listing, review, spend, and chargeback windows", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("RETURNING subject_account_id")) {
          return { rows: [] };
        }
        if (sql.includes("SELECT DISTINCT account_id")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const identityHandlers = buildSettlementIdentityAccountRiskSourceProjectionHandlers(db as never);
    const marketplaceHandlers = buildSettlementReputationAccountRiskSourceProjectionHandlers(db as never);
    const paymentsHandlers = buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db as never);

    await identityHandlers["identity.account.created"]!(
      event("identity.account.created", {
        accountId: "acc_reviewer",
        createdAt: "2026-07-06T00:00:00.000Z",
      }),
    );
    await marketplaceHandlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "lst_1",
          accountId: "acc_seller",
          priceAmount: "2600.00",
          priceCurrencyCode: "USD",
        },
        "marketplace.listing-lst_1",
      ),
    );
    await marketplaceHandlers["marketplace.review.submitted"]!(
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
    await paymentsHandlers["payments.payment-created"]!(
      event("payments.payment-created", {
        paymentId: "pay_1",
        buyerAccountId: "acc_buyer",
        amount: "2100.00",
        createdAt: "2026-07-07T00:00:00.000Z",
        sellerPayouts: [{ orderId: "ord_2", sellerAccountId: "acc_seller", sellerPayoutAmount: "1900.00" }],
      }),
    );
    await paymentsHandlers["payments.payment-disputed"]!(
      event("payments.payment-disputed", {
        paymentId: "pay_1",
        providerDisputeId: "dp_1",
        disputedAt: "2026-07-07T00:00:00.000Z",
        sellerPayouts: [{ orderId: "ord_2", sellerAccountId: "acc_seller", sellerPayoutAmount: "1900.00" }],
      }),
    );

    const velocitySourceCalls = db.query.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO settlement_account_velocity_sources"),
    );

    expect(velocitySourceCalls).toContainEqual([
      expect.stringContaining("settlement_account_velocity_sources"),
      [
        "listing-created",
        "lst_1",
        "acc_seller",
        "2026-05-01T00:00:00.000Z",
        260000,
        "USD",
        1,
        null,
        "2026-05-01T00:00:00.000Z",
      ],
    ]);
    // Trailing params are the settlement fraud/velocity policy's compiled launch
    // defaults (see ../../domain/fraud-velocity-policy.ts), stamped onto the SQL
    // as parameters instead of hardcoded interval/threshold literals.
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("review_24h_median_reviewer_age_days"), [
      "acc_seller",
      expect.any(String),
      7, // chargebackReportingWindowDays
      30, // chargebackVelocity.lookbackDays
      24, // newSellerListingVelocity.windowHours
      24, // reviewVelocity.windowHours
      24, // youngBuyerSpendVelocity.windowHours
      2, // chargebackVelocity.minCount
      200, // chargebackVelocity.minRateBps
      30, // newSellerListingVelocity.newAccountAgeDays
      250_000, // newSellerListingVelocity.minValueCents
      5, // reviewVelocity.minCount
      7, // reviewVelocity.maxMedianReviewerAgeDays
      7, // youngBuyerSpendVelocity.newAccountAgeDays
      200_000, // youngBuyerSpendVelocity.minSpendCents
      "USD", // newSellerListingVelocity.minValueCurrencyCode
    ]);
    expect(velocitySourceCalls).toContainEqual([
      expect.stringContaining("settlement_account_velocity_sources"),
      [
        "buyer-payment-created",
        "pay_1",
        "acc_buyer",
        "2026-07-07T00:00:00.000Z",
        210000,
        null,
        null,
        null,
        "2026-05-01T00:00:00.000Z",
      ],
    ]);
    expect(velocitySourceCalls).toContainEqual([
      expect.stringContaining("settlement_account_velocity_sources"),
      [
        "chargeback-received",
        "dp_1:ord_2",
        "acc_seller",
        "2026-07-07T00:00:00.000Z",
        0,
        null,
        null,
        null,
        "2026-05-01T00:00:00.000Z",
      ],
    ]);
  });
});
