import { describe, expect, it } from "vitest";
import {
  findBusinessConstantNameViolations,
  findBusinessLiteralGuardViolations,
  findIntervalLiteralViolations,
  findMoneyComparisonViolations,
  isBusinessLiteralGuardedFile,
} from "./business-literal-guard.mjs";
import { businessLiteralAllowlist } from "./business-literal-allowlist.mjs";

describe("business literal guard", () => {
  it("guards only bounded-context .ts source, excluding tests", () => {
    expect(
      isBusinessLiteralGuardedFile("bounded-contexts/settlement/features/payouts/read-model/queries.ts", ".ts"),
    ).toBe(true);
    expect(isBusinessLiteralGuardedFile("bounded-contexts/settlement/features/payouts/queries.test.ts", ".ts")).toBe(
      false,
    );
    expect(isBusinessLiteralGuardedFile("deployables/platform-api/src/x.ts", ".ts")).toBe(false);
    expect(isBusinessLiteralGuardedFile("scripts/check-structure/run.mjs", ".mjs")).toBe(false);
    expect(isBusinessLiteralGuardedFile("bounded-contexts/settlement/features/payouts/read-model/x.tsx", ".tsx")).toBe(
      false,
    );
  });

  it("catches a seeded fixture INTERVAL literal violation (AC1)", () => {
    const seededFixture = `
      export async function staleClearanceWindow(db: PgQueryable) {
        return db.query(
          "SELECT * FROM settlement_wallet_holds WHERE created_at < NOW() - INTERVAL '2 days'",
        );
      }
    `;

    const violations = findIntervalLiteralViolations({
      relativeFile: "bounded-contexts/settlement/features/wallets/read-model/fixture-queries.ts",
      content: seededFixture,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toBe("INTERVAL '2 days'");
    expect(violations[0].message).toContain("infrastructure/platform-policy/define-policy.ts");
  });

  it("catches a seeded fixture money-comparison literal violation (AC1)", () => {
    const seededFixture = `
      const sql = "SELECT * FROM marketplace_listing_pages WHERE listing_price_amount_cents >= 25000";
    `;

    const violations = findMoneyComparisonViolations({
      relativeFile: "bounded-contexts/marketplace/features/listings/read-model/fixture-queries.ts",
      content: seededFixture,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toBe("listing_price_amount_cents >= 25000");
  });

  it("catches a seeded fixture business-constant-name violation (AC1)", () => {
    const seededFixture = `export const FIXTURE_AUTO_UNLIST_THRESHOLD = 3;`;

    const violations = findBusinessConstantNameViolations({
      relativeFile: "bounded-contexts/marketplace/features/reports/domain/fixture-domain.ts",
      content: seededFixture,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toBe("FIXTURE_AUTO_UNLIST_THRESHOLD");
  });

  it("does not flag minute/second INTERVAL units (established operational retry vocabulary)", () => {
    const operationalRetry = `
      return "AND status = 'requested' AND updated_at < NOW() - INTERVAL '15 minutes'";
    `;

    expect(
      findIntervalLiteralViolations({
        relativeFile: "bounded-contexts/settlement/features/payouts/read-model/queries.ts",
        content: operationalRetry,
      }),
    ).toEqual([]);
  });

  it("does not flag retention-policy.ts / retention-sweep.ts (governed by retention-sweep-coverage.mjs instead)", () => {
    const retentionSql = `predicateSql: "candidate.completed_at < now() - interval '90 days'",`;

    expect(
      findIntervalLiteralViolations({
        relativeFile: "bounded-contexts/inventory/support/runtime-support/retention-policy.ts",
        content: retentionSql,
      }),
    ).toEqual([]);
    expect(
      findIntervalLiteralViolations({
        relativeFile: "infrastructure/platform-runtime/retention-sweep.ts",
        content: retentionSql,
      }),
    ).toEqual([]);
  });

  it("does not flag ordinary camelCase TS numeric comparisons outside SQL strings", () => {
    const tsGuard = `
      const atOrAboveAskCount = data.items.filter((item) => item.offer_to_listing_price_bps >= 10000).length;
      if (checkoutFeeCents <= 0 || totalCents <= 0) { return; }
    `;

    expect(
      findMoneyComparisonViolations({
        relativeFile: "bounded-contexts/marketplace/features/offers/ui/offer-match-list-page.tsx",
        content: tsGuard,
      }),
    ).toEqual([]);
  });

  it("does not flag the policy-owning file's own schema bounds (definePolicy single source)", () => {
    const policyOwningFile = `
      import { definePolicy } from "@chase-sets/platform-policy/define-policy";
      export const MIN_SUPPORT_DEADLINE_HOURS = 4;
      export const MAX_SUPPORT_DEADLINE_HOURS = 336;
      export const supportDeadlinePolicy = definePolicy({
        policyKey: "platform-operations.support-deadlines",
        contextName: "platform-operations",
        schemaSummary: "per-flow-type deadline hours",
        defaultValue: {},
        decodeValue: (raw) => raw,
      });
    `;

    expect(
      findBusinessConstantNameViolations({
        relativeFile:
          "bounded-contexts/platform-operations/features/support-requests/domain/support-deadline-policy.ts",
        content: policyOwningFile,
      }),
    ).toEqual([]);
  });

  it("does not flag constants outside feature domain/api directories", () => {
    const readModelConstant = `export const DISCOVERY_SIMILAR_ITEMS_DEFAULT_LIMIT = 8;`;

    expect(
      findBusinessConstantNameViolations({
        relativeFile: "bounded-contexts/discovery/features/search/read-model/similar-items.ts",
        content: readModelConstant,
      }),
    ).toEqual([]);
  });

  it("passes clean on the current repo tree's known reviewed exceptions (allowlist honored)", () => {
    for (const entry of businessLiteralAllowlist) {
      if (!entry.pattern) {
        continue;
      }
      const violations = findBusinessLiteralGuardViolations({
        relativeFile: entry.file,
        content: `"${entry.pattern}"`,
      });
      expect(violations).toEqual([]);
    }
  });

  it("still catches a new violation in an otherwise snippet-allowlisted file", () => {
    const newLiteralAlongsideAllowlistedOne = `
      const staleWindow = "AND updated_at > NOW() - INTERVAL '7 days'";
      const clearanceWindow = "AND created_at < NOW() - INTERVAL '3 days'";
    `;

    const violations = findIntervalLiteralViolations({
      relativeFile: "bounded-contexts/settlement/features/payouts/read-model/queries.ts",
      content: newLiteralAlongsideAllowlistedOne,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toBe("INTERVAL '3 days'");
  });

  it("whole-file allowlist entries suppress all violation kinds in that file", () => {
    const fraudHeuristicFixture = `
      function velocityFlagsSql() {
        return \`CASE WHEN listing_24h_value_cents >= 250000 AND occurred_at >= now() - interval '30 days' THEN TRUE END\`;
      }
    `;

    expect(
      findBusinessLiteralGuardViolations({
        relativeFile:
          "bounded-contexts/settlement/features/wallets/integrations/account-risk-source/account-risk-source-projection.ts",
        content: fraudHeuristicFixture,
      }),
    ).toEqual([]);
  });
});
