import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { orderingOrderSchemaMigrations, orderingOrderSchemaSql } from "../read-model/schema";

const source = readFileSync(new URL("./evidence-window-source-release.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
const claims = readFileSync(new URL("./order-source-claims.ts", import.meta.url), "utf8");
const limits = readFileSync(new URL("./purchase-limits.ts", import.meta.url), "utf8");
const capacity = readFileSync(new URL("./order-capacity.ts", import.meta.url), "utf8");
const recoveryRoute = readFileSync(
  new URL("../../../../../infrastructure/platform-runtime/evidence-window-source-recovery.ts", import.meta.url),
  "utf8",
);

function containsOrderIdInControl(value: unknown) {
  return /\bord_[A-Za-z0-9_-]+\b/.test(JSON.stringify(value));
}

function forbiddenDependency(value: string) {
  return /(?:fetch\s*\(|providerGateway\.|liveness\s*\(|checkHealth\s*\(|phaseCheckpoint|releaseObligation)/i.test(
    value,
  );
}

function hasReleaseWriters(values: Readonly<{ claims: string; limits: string; source: string }>) {
  return (
    /UPDATE ordering_listing_purchase_limit_claims/.test(values.limits) &&
    /DELETE FROM ordering_listing_purchase_limit_claims/.test(values.limits) &&
    /DELETE FROM ordering_order_source_claims/.test(values.claims) &&
    /usage_residue_upper_bound_units\s*=\s*CASE WHEN status = 'pending' THEN quantity ELSE NULL END/.test(values.source)
  );
}

function hasGuardedRecoveryPredicate(value: string) {
  const update = value.slice(
    value.indexOf("UPDATE ordering_listing_purchase_limit_claims"),
    value.indexOf("RETURNING listing_id", value.indexOf("UPDATE ordering_listing_purchase_limit_claims")),
  );
  return [
    "source_type = $1",
    "source_reference_id = $2",
    "buyer_account_id = $3",
    "status IN ('pending', 'claimed')",
  ].every((predicate) => update.includes(predicate));
}

function retainsRootUntilSellerConvergence(value: string) {
  const release = value.slice(value.indexOf("export async function releaseEvidenceWindowSource"));
  return (
    release.includes("facts.capacityClaims.map((claim) => claim.seller_account_id)") &&
    release.indexOf("for (const sellerId of sellers) await actions.reconcileSeller(sellerId)") <
      release.indexOf("DELETE FROM ordering_order_source_claims")
  );
}

describe("Ordering source recovery contract inventory", () => {
  it("AC-02 keeps Order ids out of control columns/reports and detects a planted output marker", () => {
    const table = orderingOrderSchemaSql.match(
      /CREATE TABLE IF NOT EXISTS ordering_evidence_window_sources \(([\s\S]*?)\n\);/,
    )?.[1];
    expect(table).toBeDefined();
    expect(table).not.toMatch(/\border_ids?\b/);
    expect(containsOrderIdInControl({ outcome: "discharged", surfaces: { orderStreams: "not-created" } })).toBe(false);
    expect(containsOrderIdInControl({ outcome: "discharged", planted: "ord_planted_marker" })).toBe(true);
  });

  it("AC-11 keeps the closed source path provider/liveness/runner-free and detects a planted call", () => {
    for (const value of [source, claims, limits, capacity, recoveryRoute])
      expect(forbiddenDependency(value)).toBe(false);
    expect(forbiddenDependency(`${source}\nfetch('https://provider.example')`)).toBe(true);
    expect(runtime).toContain("bindEvidenceWindowSource");
    expect(
      runtime.slice(runtime.indexOf("const sourceReaders ="), runtime.indexOf("const createOrdersFromPlan =")),
    ).not.toMatch(/fetch\s*\(|providerGateway\.|checkHealth\s*\(/);
    expect(source).not.toContain("phase:");
  });

  it("AC-14 inventories current UPDATE/DELETE and recovery provenance, rejecting a missing writer mutant", () => {
    expect(hasReleaseWriters({ claims, limits, source })).toBe(true);
    expect(
      hasReleaseWriters({
        claims: claims.replace("DELETE FROM ordering_order_source_claims", "SELECT 1"),
        limits,
        source,
      }),
    ).toBe(false);
    expect(hasGuardedRecoveryPredicate(source)).toBe(true);
    expect(hasGuardedRecoveryPredicate(source.replace("AND status IN ('pending', 'claimed')", "AND TRUE"))).toBe(false);
    const updateStart = source.indexOf("UPDATE ordering_listing_purchase_limit_claims");
    expect(
      hasGuardedRecoveryPredicate(
        source.slice(0, updateStart) + source.slice(updateStart).replace("AND buyer_account_id = $3", "AND TRUE"),
      ),
    ).toBe(false);
    expect(
      hasReleaseWriters({
        claims,
        limits,
        source: source.replace("THEN quantity ELSE NULL END", "THEN NULL ELSE NULL END"),
      }),
    ).toBe(false);
    const migration = orderingOrderSchemaMigrations.find(
      (item) => item.migrationId === "20260926_ordering_evidence_window_sources",
    );
    expect(migration?.statements[0]).toContain("ADD COLUMN IF NOT EXISTS usage_residue_upper_bound_units");
    expect(migration?.statements[0]).toContain("ordering_purchase_limit_usage_residue_bound_check");
  });

  it("AC-13 retains every observed seller through root-last discharge and rejects flipped-only/early-delete mutants", () => {
    expect(retainsRootUntilSellerConvergence(source)).toBe(true);
    expect(
      retainsRootUntilSellerConvergence(
        source.replaceAll(
          "facts.capacityClaims.map((claim) => claim.seller_account_id)",
          "facts.capacityClaims.filter((claim) => claim.status === 'claimed').map((claim) => claim.seller_account_id)",
        ),
      ),
    ).toBe(false);
    expect(
      retainsRootUntilSellerConvergence(
        source.replace(
          "for (const sellerId of sellers) await actions.reconcileSeller(sellerId);",
          "DELETE FROM ordering_order_source_claims; for (const sellerId of sellers) await actions.reconcileSeller(sellerId);",
        ),
      ),
    ).toBe(false);
  });
});
