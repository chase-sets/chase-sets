import type { ProviderUsageSnapshot } from "../../provider-adapters/provider-adapter";
import { SCRYDEX_USAGE_FRESH_WITHIN_SECONDS } from "./adapter";

// Support-safe record of one credential-safe Scrydex usage read, captured at the
// Admin preflight instant. The schema is closed: only redacted balance counts,
// states, timestamps, and diagnostic codes are allowed, so credentials, account
// identifiers, endpoint URLs, pricing, and raw provider payloads cannot be recorded.
// A capture never authorizes a paid import; it only informs operator confirmation.
export type ScrydexUsageTestModeFixture = Readonly<{
  schemaVersion: "scrydex-usage-test-mode-fixture-v1";
  providerKey: "scrydex";
  observedAt: string | null;
  attemptState: ProviderUsageSnapshot["attemptState"];
  lagCategory: ProviderUsageSnapshot["lagCategory"];
  providerUpdatedAt: string | null;
  creditUnit: "credits";
  creditState: ProviderUsageSnapshot["creditState"];
  totalCredits: number | null;
  remainingCredits: number | null;
  usedCredits: number | null;
  diagnosticCode: string | null;
  operatorConfirmation: "required";
  importAuthorization: "none";
}>;

export type ScrydexUsageLaunchGate = Readonly<{
  decision: "refused" | "operator-confirmation-required";
  reasons: readonly ScrydexUsageLaunchGateRefusal[];
  importAuthorization: "none";
}>;

export type ScrydexUsageLaunchGateRefusal =
  | "usage-not-checked"
  | "usage-stale"
  | "allowance-unreported"
  | "balance-unreported"
  | "credits-exhausted";

const fixtureKeys = [
  "schemaVersion",
  "providerKey",
  "observedAt",
  "attemptState",
  "lagCategory",
  "providerUpdatedAt",
  "creditUnit",
  "creditState",
  "totalCredits",
  "remainingCredits",
  "usedCredits",
  "diagnosticCode",
  "operatorConfirmation",
  "importAuthorization",
] as const satisfies readonly (keyof ScrydexUsageTestModeFixture)[];

const attemptStates = ["checked", "unavailable", "not-configured"] as const;
const lagCategories = ["within-provider-window", "beyond-provider-window", "documented-window", "unobserved"] as const;
const creditStates = ["available", "low", "exhausted", "unknown"] as const;

export function scrydexUsageTestModeFixture(snapshot: ProviderUsageSnapshot): ScrydexUsageTestModeFixture {
  return parseScrydexUsageTestModeFixture({
    schemaVersion: "scrydex-usage-test-mode-fixture-v1",
    providerKey: "scrydex",
    observedAt: snapshot.observedAt,
    attemptState: snapshot.attemptState,
    lagCategory: snapshot.lagCategory,
    providerUpdatedAt: snapshot.providerUpdatedAt,
    creditUnit: snapshot.creditUnit,
    creditState: snapshot.creditState,
    totalCredits: snapshot.totalCredits,
    remainingCredits: snapshot.remainingCredits,
    usedCredits: snapshot.usedCredits,
    diagnosticCode: snapshot.diagnosticCode,
    operatorConfirmation: "required",
    importAuthorization: "none",
  });
}

export function parseScrydexUsageTestModeFixture(value: unknown): ScrydexUsageTestModeFixture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Scrydex usage fixture must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== [...fixtureKeys].sort().join(",")) {
    throw new Error(`Scrydex usage fixture keys must be exactly: ${fixtureKeys.join(", ")}.`);
  }

  return {
    schemaVersion: literal(record, "schemaVersion", "scrydex-usage-test-mode-fixture-v1"),
    providerKey: literal(record, "providerKey", "scrydex"),
    observedAt: nullableTimestamp(record, "observedAt"),
    attemptState: oneOf(record, "attemptState", attemptStates),
    lagCategory: oneOf(record, "lagCategory", lagCategories),
    providerUpdatedAt: nullableTimestamp(record, "providerUpdatedAt"),
    creditUnit: literal(record, "creditUnit", "credits"),
    creditState: oneOf(record, "creditState", creditStates),
    totalCredits: nullableCount(record, "totalCredits"),
    remainingCredits: nullableCount(record, "remainingCredits"),
    usedCredits: nullableCount(record, "usedCredits"),
    diagnosticCode: nullableDiagnosticCode(record, "diagnosticCode"),
    operatorConfirmation: literal(record, "operatorConfirmation", "required"),
    importAuthorization: literal(record, "importAuthorization", "none"),
  };
}

// The launch gate never authorizes an import. A fresh, checked capture with both a
// reported balance and a reported allowance only becomes eligible for explicit
// operator confirmation; anything stale, unchecked, unreported, or exhausted refuses.
export function evaluateScrydexUsageLaunchGate(
  fixture: ScrydexUsageTestModeFixture,
  now: Date,
): ScrydexUsageLaunchGate {
  const reasons: ScrydexUsageLaunchGateRefusal[] = [];
  if (fixture.attemptState !== "checked" || fixture.observedAt === null) {
    reasons.push("usage-not-checked");
  } else {
    const ageSeconds = (now.getTime() - Date.parse(fixture.observedAt)) / 1000;
    if (!(ageSeconds >= 0 && ageSeconds <= SCRYDEX_USAGE_FRESH_WITHIN_SECONDS)) reasons.push("usage-stale");
  }
  if (fixture.totalCredits === null) reasons.push("allowance-unreported");
  if (fixture.remainingCredits === null) reasons.push("balance-unreported");
  // The numeric balance decides exhaustion, so a contradictory credit state cannot admit it.
  if (fixture.creditState === "exhausted" || (fixture.remainingCredits !== null && fixture.remainingCredits <= 0)) {
    reasons.push("credits-exhausted");
  }

  return {
    decision: reasons.length === 0 ? "operator-confirmation-required" : "refused",
    reasons,
    importAuthorization: "none",
  };
}

function literal<T extends string>(record: Record<string, unknown>, key: string, expected: T): T {
  if (record[key] !== expected) throw new Error(`Scrydex usage fixture ${key} must be "${expected}".`);
  return expected;
}

function oneOf<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = record[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Scrydex usage fixture ${key} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function nullableTimestamp(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`Scrydex usage fixture ${key} must be null or an ISO-8601 UTC timestamp.`);
  }
  return value;
}

function nullableCount(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Scrydex usage fixture ${key} must be null or a non-negative safe integer.`);
  }
  return value;
}

function nullableDiagnosticCode(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(`Scrydex usage fixture ${key} must be null or a kebab-case diagnostic code.`);
  }
  return value;
}
