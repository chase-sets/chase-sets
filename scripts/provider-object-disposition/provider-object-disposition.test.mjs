import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RESULT_DIGEST_DOMAIN_PREFIX,
  canonicalizeProviderObjectDisposition,
  computeResultDigest,
  sortKeysByCodeUnit,
} from "./canonicalize-provider-object-disposition.mjs";
import {
  ACCOUNT_SESSION_AUTHORITY_POINTER,
  CLASS_ORDER,
  FAILURE_CODES,
  OPTION_B_CLASS_TABLE,
  PROVIDER_MODE_AUTHORITY_NOTE,
  REFUSAL_CODES,
  SCENARIO_FIXTURES,
  containsForbiddenProviderMarker,
  parseRawDocumentBytes,
  qualifiesForPublicationV1,
  validateProviderObjectDisposition,
  validateProviderObjectDispositionBytes,
} from "./validate-provider-object-disposition.mjs";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("./provider-object-disposition-v1.schema.json", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("./provider-object-disposition-option-b.fixture.json", import.meta.url));
const GLOSSARY_PATH = fileURLToPath(new URL("../../bounded-contexts/payments/GLOSSARY.md", import.meta.url));

const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const FIXTURE_RAW = readFileSync(FIXTURE_PATH, "utf8");

function clone(doc) {
  return structuredClone(doc);
}

function withFreshDigest(doc) {
  return { ...doc, resultDigest: computeResultDigest(doc) };
}

function toBytes(doc, { bom = false, trailingNewline = false, rawTextOverride } = {}) {
  const json = rawTextOverride ?? JSON.stringify(doc);
  const suffix = trailingNewline ? "\n" : "";
  const body = Buffer.from(json + suffix, "utf8");
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

function patchClass(doc, className, patch) {
  const index = CLASS_ORDER.indexOf(className);
  const next = clone(doc);
  next.classes[index] = { ...next.classes[index], ...patch };
  return next;
}

function rowFor(className) {
  return OPTION_B_CLASS_TABLE[CLASS_ORDER.indexOf(className)];
}

const VALID_SUCCESS = SCENARIO_FIXTURES.success;
const VALID_PRE_NETWORK_REFUSAL = SCENARIO_FIXTURES.preNetworkRefusal;
const VALID_POST_NETWORK_FAILURE = SCENARIO_FIXTURES.postNetworkFailureLaterNotAttempted;
const VALID_CLEANUP_FAILURE = SCENARIO_FIXTURES.partialEffectCompleteCleanup;

describe("enforces v1 raw-byte and recursive closure", () => {
  it("accepts only the exact byte grammar and names every refusal by key/path or byte rule", () => {
    // Valid document.
    const validBytes = toBytes(VALID_SUCCESS);
    const validResult = validateProviderObjectDispositionBytes(validBytes);
    expect(validResult.ok, JSON.stringify(validResult.errors)).toBe(true);

    // Unknown top-level key.
    const unknownTopLevel = { ...clone(VALID_SUCCESS), unexpectedField: "x" };
    const unknownTopLevelResult = validateProviderObjectDispositionBytes(toBytes(unknownTopLevel));
    expect(unknownTopLevelResult.ok).toBe(false);
    expect(unknownTopLevelResult.errors).toContainEqual(
      expect.objectContaining({ code: "TOP_LEVEL_KEY_UNKNOWN", path: "$.unexpectedField" }),
    );

    // Unknown nested key.
    const unknownNested = patchClass(VALID_SUCCESS, "captured-payment-intent", { unexpectedField: "x" });
    const unknownNestedResult = validateProviderObjectDispositionBytes(toBytes(unknownNested));
    expect(unknownNestedResult.ok).toBe(false);
    expect(unknownNestedResult.errors.some((e) => e.code === "CLASS_ENTRY_KEY_UNKNOWN")).toBe(true);

    // Duplicate raw key at the top level — cannot be built via a JS object,
    // so splice the raw text directly.
    const rawText = JSON.stringify(VALID_SUCCESS);
    const duplicated = rawText.replace(
      '"version":"provider-object-disposition/v1"',
      '"version":"provider-object-disposition/v1","version":"provider-object-disposition/v1"',
    );
    expect(duplicated).not.toBe(rawText);
    const duplicateResult = validateProviderObjectDispositionBytes(toBytes(null, { rawTextOverride: duplicated }));
    expect(duplicateResult.ok).toBe(false);
    expect(duplicateResult.errors).toContainEqual(expect.objectContaining({ code: "MALFORMED_JSON_OR_DUPLICATE_KEY" }));

    // Missing nullable key (observedCount, which is null on a not-attempted entry).
    const missingNullable = clone(VALID_PRE_NETWORK_REFUSAL);
    delete missingNullable.classes[0].observedCount;
    const missingNullableResult = validateProviderObjectDispositionBytes(toBytes(missingNullable));
    expect(missingNullableResult.ok).toBe(false);
    expect(missingNullableResult.errors).toContainEqual(
      expect.objectContaining({ code: "CLASS_ENTRY_KEY_MISSING", path: "$.classes[0].observedCount" }),
    );

    // BOM.
    const bomResult = validateProviderObjectDispositionBytes(toBytes(VALID_SUCCESS, { bom: true }));
    expect(bomResult.ok).toBe(false);
    expect(bomResult.errors).toContainEqual(expect.objectContaining({ code: "BOM_PRESENT" }));

    // Trailing newline.
    const trailingNewlineResult = validateProviderObjectDispositionBytes(
      toBytes(VALID_SUCCESS, { trailingNewline: true }),
    );
    expect(trailingNewlineResult.ok).toBe(false);
    expect(trailingNewlineResult.errors).toContainEqual(expect.objectContaining({ code: "TRAILING_NEWLINE" }));

    // Omission mutant: parsing without duplicate detection would silently
    // last-wins the duplicate key above and report the document valid.
    const naiveParse = JSON.parse(duplicated);
    expect(naiveParse.version).toBe("provider-object-disposition/v1");
  });
});

describe("represents each disposition variant exactly once", () => {
  it("has one valid instance per variant, none accepted by two variants, and exact null/ordinal behavior", () => {
    const perVariant = [
      ["success", VALID_SUCCESS],
      ["pre-network-refusal", VALID_PRE_NETWORK_REFUSAL],
      ["post-network-failure", VALID_POST_NETWORK_FAILURE],
      ["cleanup-failure", VALID_CLEANUP_FAILURE],
    ];
    for (const [variant, doc] of perVariant) {
      expect(doc.variant).toBe(variant);
      const result = validateProviderObjectDisposition(doc);
      expect(result.ok, `${variant}: ${JSON.stringify(result.errors)}`).toBe(true);
    }

    // Variant-only keys on another variant refuse.
    const successWithRefusal = { ...clone(VALID_SUCCESS), refusal: "invalid-input" };
    expect(validateProviderObjectDisposition(successWithRefusal).ok).toBe(false);
    const successWithFailure = { ...clone(VALID_SUCCESS), failure: "transport-failure" };
    expect(validateProviderObjectDisposition(successWithFailure).ok).toBe(false);
    const successWithOrdinal = { ...clone(VALID_SUCCESS), lastCompletedPrecedenceOrdinal: null };
    expect(validateProviderObjectDisposition(successWithOrdinal).ok).toBe(false);
    const refusalWithFailure = { ...clone(VALID_PRE_NETWORK_REFUSAL), failure: "transport-failure" };
    expect(validateProviderObjectDisposition(refusalWithFailure).ok).toBe(false);
    const cleanupWithOrdinal = { ...clone(VALID_CLEANUP_FAILURE), lastCompletedPrecedenceOrdinal: 1 };
    expect(validateProviderObjectDisposition(cleanupWithOrdinal).ok).toBe(false);

    // Omit refusal on pre-network-refusal.
    const missingRefusal = clone(VALID_PRE_NETWORK_REFUSAL);
    delete missingRefusal.refusal;
    const missingRefusalResult = validateProviderObjectDisposition(missingRefusal);
    expect(missingRefusalResult.ok).toBe(false);
    expect(missingRefusalResult.errors).toContainEqual(
      expect.objectContaining({ code: "VARIANT_KEY_MISSING", path: "$.refusal" }),
    );

    // Flatten-into-one-optional-record mutant: post-network-failure without
    // its required failure/lastCompletedPrecedenceOrdinal keys.
    const flattened = clone(VALID_POST_NETWORK_FAILURE);
    delete flattened.failure;
    delete flattened.lastCompletedPrecedenceOrdinal;
    const flattenedResult = validateProviderObjectDisposition(flattened);
    expect(flattenedResult.ok).toBe(false);
    expect(flattenedResult.errors.some((e) => e.code === "VARIANT_KEY_MISSING")).toBe(true);

    // Inconsistent last-completed ordinal.
    const wrongOrdinal = withFreshDigest({ ...clone(VALID_POST_NETWORK_FAILURE), lastCompletedPrecedenceOrdinal: 6 });
    const wrongOrdinalResult = validateProviderObjectDisposition(wrongOrdinal);
    expect(wrongOrdinalResult.ok).toBe(false);
    expect(wrongOrdinalResult.errors).toContainEqual(
      expect.objectContaining({ code: "N1_LAST_COMPLETED_PRECEDENCE_ORDINAL_MISMATCH" }),
    );

    // Exact null behavior: a post-network-failure document with one
    // attempted-but-ambiguous class and zero completions must declare
    // lastCompletedPrecedenceOrdinal: null (N1 still requires at least one
    // attempted class, so all-six-not-attempted is not a valid instance of
    // this variant — that shape belongs to pre-network-refusal instead).
    let oneAttemptZeroCompletions = clone(VALID_POST_NETWORK_FAILURE);
    for (const className of CLASS_ORDER) {
      oneAttemptZeroCompletions = patchClass(oneAttemptZeroCompletions, className, {
        state: "not-attempted",
        observedCount: null,
        enumerationComplete: false,
        correlationSource: "not-applicable",
        dispositionStartedAt: null,
        dispositionCompletedAt: null,
      });
    }
    oneAttemptZeroCompletions = patchClass(oneAttemptZeroCompletions, "uncaptured-payment-intent", {
      state: "unknown",
      correlationSource: "creation-time-record",
      dispositionStartedAt: "2026-08-01T00:00:10Z",
    });
    oneAttemptZeroCompletions.lastCompletedPrecedenceOrdinal = null;
    oneAttemptZeroCompletions = withFreshDigest(oneAttemptZeroCompletions);
    const zeroCompletionResult = validateProviderObjectDisposition(oneAttemptZeroCompletions);
    expect(zeroCompletionResult.ok, JSON.stringify(zeroCompletionResult.errors)).toBe(true);
  });
});

describe("pins Decision 6728 Option B by class", () => {
  it("validates the baseline and refuses every one-field mutation naming its class and invariant B4", () => {
    expect(validateProviderObjectDisposition(VALID_SUCCESS).ok).toBe(true);

    for (const className of CLASS_ORDER) {
      const row = rowFor(className);

      const budgetMutant = withFreshDigest(
        patchClass(VALID_SUCCESS, className, { declaredBudget: row.declaredBudget + 5 }),
      );
      const budgetResult = validateProviderObjectDisposition(budgetMutant);
      expect(budgetResult.ok, `${className} budget mutant`).toBe(false);
      expect(budgetResult.errors).toContainEqual(
        expect.objectContaining({ code: "B4_BUDGET_TABLE_OVERRIDE", class: className }),
      );

      const scopeMutant = withFreshDigest(patchClass(VALID_SUCCESS, className, { budgetScope: "unbounded" }));
      const scopeResult = validateProviderObjectDisposition(scopeMutant);
      expect(scopeResult.ok, `${className} scope mutant`).toBe(false);
      expect(scopeResult.errors).toContainEqual(
        expect.objectContaining({ code: "B4_BUDGET_SCOPE_OVERRIDE", class: className }),
      );

      const precedenceMutant = withFreshDigest(
        patchClass(VALID_SUCCESS, className, {
          precedenceOrdinal: row.precedenceOrdinal === 6 ? 1 : row.precedenceOrdinal + 1,
        }),
      );
      const precedenceResult = validateProviderObjectDisposition(precedenceMutant);
      expect(precedenceResult.ok, `${className} precedence mutant`).toBe(false);
      expect(precedenceResult.errors).toContainEqual(
        expect.objectContaining({ code: "B4_PRECEDENCE_TABLE_OVERRIDE", class: className }),
      );

      // Success-state mutant: force an off-table state where the class has one.
      const alternateState = row.permittedStates.find((state) => !row.successStates.includes(state));
      if (alternateState) {
        const stateMutant = withFreshDigest(patchClass(VALID_SUCCESS, className, { state: alternateState }));
        const stateResult = validateProviderObjectDisposition(stateMutant);
        expect(stateResult.ok, `${className} success-state mutant`).toBe(false);
        expect(stateResult.errors).toContainEqual(
          expect.objectContaining({ code: "B3_NON_SUCCESS_STATE_IN_SUCCESS_VARIANT", class: className }),
        );
      }
    }

    // Omission mutant: restore class-6 budget to 0, or claim self-expiry, or
    // add a probe digest — none are representable.
    const zeroBudget = withFreshDigest(patchClass(VALID_SUCCESS, "stripe-account-session", { declaredBudget: 0 }));
    expect(validateProviderObjectDisposition(zeroBudget).ok).toBe(false);

    const selfExpiring = withFreshDigest(
      patchClass(VALID_SUCCESS, "stripe-account-session", { state: "self-expiring-proven" }),
    );
    const selfExpiringResult = validateProviderObjectDisposition(selfExpiring);
    expect(selfExpiringResult.ok).toBe(false);
    expect(selfExpiringResult.errors).toContainEqual(
      expect.objectContaining({ code: "STATE_NOT_PERMITTED_FOR_CLASS", class: "stripe-account-session" }),
    );

    const probeDigest = withFreshDigest(
      patchClass(VALID_SUCCESS, "stripe-account-session", { probeReceiptDigest: "a".repeat(64) }),
    );
    const probeDigestResult = validateProviderObjectDisposition(probeDigest);
    expect(probeDigestResult.ok).toBe(false);
    expect(probeDigestResult.errors.some((e) => e.code === "CLASS_ENTRY_KEY_UNKNOWN")).toBe(true);
  });
});

describe("requires the exact ten class keys", () => {
  const REQUIRED_KEYS = [
    "class",
    "state",
    "declaredBudget",
    "budgetScope",
    "observedCount",
    "enumerationComplete",
    "correlationSource",
    "precedenceOrdinal",
    "dispositionStartedAt",
    "dispositionCompletedAt",
  ];

  it("accepts a complete entry and refuses each single-key omission and the eleventh-key addition", () => {
    expect(validateProviderObjectDisposition(VALID_SUCCESS).ok).toBe(true);
    expect(Object.keys(VALID_SUCCESS.classes[0]).sort()).toEqual([...REQUIRED_KEYS].sort());

    for (const key of REQUIRED_KEYS) {
      const doc = clone(VALID_SUCCESS);
      delete doc.classes[0][key];
      const result = validateProviderObjectDisposition(doc);
      expect(result.ok, `omitting ${key}`).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "CLASS_ENTRY_KEY_MISSING", path: `$.classes[0].${key}` }),
      );
    }

    const eleventh = withFreshDigest(patchClass(VALID_SUCCESS, "captured-payment-intent", { extraKey: true }));
    const eleventhResult = validateProviderObjectDisposition(eleventh);
    expect(eleventhResult.ok).toBe(false);
    expect(eleventhResult.errors).toContainEqual(
      expect.objectContaining({ code: "CLASS_ENTRY_KEY_UNKNOWN", path: "$.classes[0].extraKey" }),
    );
  });
});

describe("separates unknown not-attempted and not-created", () => {
  it("keeps null/count/completeness/correlation rules distinct per shape and only not-created satisfies class 4's zero budget", () => {
    // Began-then-ambiguous unknown.
    expect(validateProviderObjectDisposition(VALID_POST_NETWORK_FAILURE).ok).toBe(true);
    const unknownEntry = VALID_POST_NETWORK_FAILURE.classes[CLASS_ORDER.indexOf("captured-payment-intent")];
    expect(unknownEntry.state).toBe("unknown");
    expect(unknownEntry.observedCount).toBeNull();
    expect(unknownEntry.dispositionStartedAt).not.toBeNull();
    expect(unknownEntry.dispositionCompletedAt).toBeNull();

    // Never-began not-attempted, all six pre-network rows.
    expect(validateProviderObjectDisposition(VALID_PRE_NETWORK_REFUSAL).ok).toBe(true);
    for (const entry of VALID_PRE_NETWORK_REFUSAL.classes) {
      expect(entry.state).toBe("not-attempted");
      expect(entry.observedCount).toBeNull();
      expect(entry.enumerationComplete).toBe(false);
      expect(entry.correlationSource).toBe("not-applicable");
      expect(entry.dispositionStartedAt).toBeNull();
      expect(entry.dispositionCompletedAt).toBeNull();
    }

    // Reconciled-zero not-created.
    const notCreatedEntry = VALID_SUCCESS.classes[CLASS_ORDER.indexOf("stripe-checkout-session")];
    expect(notCreatedEntry.state).toBe("not-created");
    expect(notCreatedEntry.observedCount).toBe(0);
    expect(notCreatedEntry.enumerationComplete).toBe(true);

    // Mutant: coerce null to zero on a not-attempted entry.
    const coerced = withFreshDigest(
      patchClass(VALID_PRE_NETWORK_REFUSAL, "captured-payment-intent", { observedCount: 0 }),
    );
    const coercedResult = validateProviderObjectDisposition(coerced);
    expect(coercedResult.ok).toBe(false);
    expect(coercedResult.errors).toContainEqual(expect.objectContaining({ code: "NOT_ATTEMPTED_COUNT_NOT_NULL" }));

    // Mutant: map a pre-network not-attempted row to unknown.
    const remapped = withFreshDigest(
      patchClass(VALID_PRE_NETWORK_REFUSAL, "captured-payment-intent", {
        state: "unknown",
        correlationSource: "not-applicable",
      }),
    );
    const remappedResult = validateProviderObjectDisposition(remapped);
    expect(remappedResult.ok).toBe(false);
    expect(remappedResult.errors).toContainEqual(expect.objectContaining({ code: "R1_ATTEMPT_BEGAN_BEFORE_REFUSAL" }));

    // Mutant: make not-created budget-ineligible by inflating its count.
    const inflated = withFreshDigest(patchClass(VALID_SUCCESS, "stripe-checkout-session", { observedCount: 1 }));
    const inflatedResult = validateProviderObjectDisposition(inflated);
    expect(inflatedResult.ok).toBe(false);
    expect(inflatedResult.errors).toContainEqual(expect.objectContaining({ code: "NOT_CREATED_COUNT_NOT_ZERO" }));
  });
});

describe("enforces time and cleanup precedence", () => {
  it("accepts valid offset instants and refuses each invalid timing or precedence case with its own invariant", () => {
    expect(validateProviderObjectDisposition(VALID_SUCCESS).ok).toBe(true);

    const dateOnly = withFreshDigest({ ...clone(VALID_SUCCESS), startedAt: "2026-08-01" });
    expect(validateProviderObjectDisposition(dateOnly).ok).toBe(false);
    expect(validateProviderObjectDisposition(dateOnly).errors).toContainEqual(
      expect.objectContaining({ code: "STARTED_AT_INVALID" }),
    );

    const offsetLess = withFreshDigest({ ...clone(VALID_SUCCESS), startedAt: "2026-08-01T00:00:00" });
    expect(validateProviderObjectDisposition(offsetLess).ok).toBe(false);

    const nonCalendar = withFreshDigest({ ...clone(VALID_SUCCESS), startedAt: "2026-02-30T00:00:00Z" });
    expect(validateProviderObjectDisposition(nonCalendar).ok).toBe(false);

    const afterFinished = withFreshDigest(
      patchClass(VALID_SUCCESS, "stripe-customer", { dispositionCompletedAt: "2026-08-01T00:20:00Z" }),
    );
    const afterFinishedResult = validateProviderObjectDisposition(afterFinished);
    expect(afterFinishedResult.ok).toBe(false);
    expect(afterFinishedResult.errors).toContainEqual(
      expect.objectContaining({ code: "NESTED_INSTANT_OUT_OF_WINDOW" }),
    );

    const elapsedOver = withFreshDigest({ ...clone(VALID_PRE_NETWORK_REFUSAL), finishedAt: "2026-08-02T00:00:01Z" });
    const elapsedOverResult = validateProviderObjectDisposition(elapsedOver);
    expect(elapsedOverResult.ok).toBe(false);
    expect(elapsedOverResult.errors).toContainEqual(expect.objectContaining({ code: "WINDOW_ELAPSED_EXCEEDS_MAX" }));

    const completionBeforeStart = withFreshDigest(
      patchClass(VALID_SUCCESS, "stripe-customer", { dispositionCompletedAt: "2026-08-01T00:00:59Z" }),
    );
    const completionBeforeStartResult = validateProviderObjectDisposition(completionBeforeStart);
    expect(completionBeforeStartResult.ok).toBe(false);
    expect(completionBeforeStartResult.errors).toContainEqual(
      expect.objectContaining({ code: "DISPOSITION_COMPLETED_BEFORE_START" }),
    );

    const wrongPrecedence = withFreshDigest(
      patchClass(VALID_SUCCESS, "uncaptured-payment-intent", { precedenceOrdinal: 5 }),
    );
    expect(validateProviderObjectDisposition(wrongPrecedence).ok).toBe(false);

    const duplicatePrecedence = withFreshDigest(
      patchClass(VALID_SUCCESS, "setup-intent", {
        precedenceOrdinal: rowFor("uncaptured-payment-intent").precedenceOrdinal,
      }),
    );
    expect(validateProviderObjectDisposition(duplicatePrecedence).ok).toBe(false);

    // Reversed completion: swap two completion instants so ordinal 1 finishes after ordinal 2.
    const reversed = clone(VALID_SUCCESS);
    const ord1Index = CLASS_ORDER.indexOf("uncaptured-payment-intent");
    const ord2Index = CLASS_ORDER.indexOf("setup-intent");
    const ord1Completed = reversed.classes[ord1Index].dispositionCompletedAt;
    const ord2Completed = reversed.classes[ord2Index].dispositionCompletedAt;
    reversed.classes[ord1Index].dispositionCompletedAt = ord2Completed;
    reversed.classes[ord2Index].dispositionCompletedAt = ord1Completed;
    const reversedDigested = withFreshDigest(reversed);
    const reversedResult = validateProviderObjectDisposition(reversedDigested);
    expect(reversedResult.ok).toBe(false);
    expect(reversedResult.errors).toContainEqual(expect.objectContaining({ code: "P1_PRECEDENCE_ORDER_VIOLATION" }));

    // Omission mutant: comparing only ordinals (not completion instants) would miss the reversed-completion case.
    expect(reversed.classes[ord1Index].precedenceOrdinal).toBeLessThan(reversed.classes[ord2Index].precedenceOrdinal);
  });
});

describe("enforces every Option B residue budget", () => {
  it("passes exact-budget success, refuses overage unless labeled budget-exceeded, and never treats unknown as overage", () => {
    expect(validateProviderObjectDisposition(VALID_SUCCESS).ok).toBe(true);

    for (const className of CLASS_ORDER) {
      const row = rowFor(className);
      if (className === "stripe-checkout-session") {
        // Class 4's only decided state (not-created) pins count to exactly
        // 0 == its budget; overage is structurally unrepresentable.
        const attemptOverage = withFreshDigest(patchClass(VALID_CLEANUP_FAILURE, className, { observedCount: 1 }));
        const attemptResult = validateProviderObjectDisposition(attemptOverage);
        expect(attemptResult.ok, `${className} cannot overage`).toBe(false);
        expect(attemptResult.errors).toContainEqual(expect.objectContaining({ code: "NOT_CREATED_COUNT_NOT_ZERO" }));
        continue;
      }

      const overBudget = row.declaredBudget + 1;
      const overageDoc = withFreshDigest({
        ...patchClass(VALID_CLEANUP_FAILURE, className, { observedCount: overBudget }),
        failure: "budget-exceeded",
      });
      const overageResult = validateProviderObjectDisposition(overageDoc);
      expect(
        overageResult.ok,
        `${className} over-by-one cleanup-failure: ${JSON.stringify(overageResult.errors)}`,
      ).toBe(true);

      // The identical overage labeled success fails.
      const overageAsSuccess = withFreshDigest({ ...clone(overageDoc), variant: "success", failure: undefined });
      delete overageAsSuccess.failure;
      const overageAsSuccessResult = validateProviderObjectDisposition(overageAsSuccess);
      expect(overageAsSuccessResult.ok, `${className} overage cannot be success`).toBe(false);

      // Overage without the budget-exceeded failure code refuses.
      const overageWrongFailure = withFreshDigest({
        ...patchClass(VALID_CLEANUP_FAILURE, className, { observedCount: overBudget }),
        failure: "cleanup-incomplete",
      });
      const overageWrongFailureResult = validateProviderObjectDisposition(overageWrongFailure);
      expect(overageWrongFailureResult.ok, `${className} overage requires budget-exceeded`).toBe(false);
      expect(overageWrongFailureResult.errors).toContainEqual(
        expect.objectContaining({ code: "K1_OVERAGE_REQUIRES_BUDGET_EXCEEDED_FAILURE" }),
      );
    }

    // Incomplete enumeration / unknown never masquerades as overage evidence.
    expect(validateProviderObjectDisposition(SCENARIO_FIXTURES.cleanupFailureAtPrecedenceBoundary).ok).toBe(true);
    expect(SCENARIO_FIXTURES.cleanupFailureAtPrecedenceBoundary.failure).not.toBe("budget-exceeded");

    // Mutant: coerce unknown's null count to zero.
    const unknownZero = withFreshDigest(
      patchClass(SCENARIO_FIXTURES.cleanupFailureAtPrecedenceBoundary, "stripe-account-session", { observedCount: 0 }),
    );
    const unknownZeroResult = validateProviderObjectDisposition(unknownZero);
    expect(unknownZeroResult.ok).toBe(false);
    expect(unknownZeroResult.errors).toContainEqual(expect.objectContaining({ code: "UNKNOWN_COUNT_NOT_NULL" }));

    // Mutant: apply B1 to a non-success variant — cleanup-failure may
    // legitimately carry overage (already proven above); confirm the
    // known-over-budget fixture validates without a false B1 refusal.
    const knownOverBudget = SCENARIO_FIXTURES.cleanupFailureOverBudget;
    expect(
      validateProviderObjectDisposition(knownOverBudget).ok,
      JSON.stringify(validateProviderObjectDisposition(knownOverBudget).errors),
    ).toBe(true);

    // Mutant: accept caller budget 3 for class 6.
    const callerBudget3 = withFreshDigest(patchClass(VALID_SUCCESS, "stripe-account-session", { declaredBudget: 3 }));
    expect(validateProviderObjectDisposition(callerBudget3).ok).toBe(false);

    // Fixed-scope override.
    const scopeOverride = withFreshDigest(
      patchClass(VALID_SUCCESS, "stripe-account-session", { budgetScope: "per-window" }),
    );
    expect(validateProviderObjectDisposition(scopeOverride).ok).toBe(false);
  });
});

describe("pins Account Session residue authority", () => {
  it("keeps class 6 creation-time-only, budget 2, with no self-expiry or probe field", () => {
    for (const count of [0, 1, 2]) {
      const doc = withFreshDigest(patchClass(VALID_SUCCESS, "stripe-account-session", { observedCount: count }));
      const result = validateProviderObjectDisposition(doc);
      expect(result.ok, `count ${count}: ${JSON.stringify(result.errors)}`).toBe(true);
    }

    const crossCheck = withFreshDigest(
      patchClass(VALID_SUCCESS, "stripe-account-session", {
        correlationSource: "creation-time-record-plus-provider-cross-check",
      }),
    );
    const crossCheckResult = validateProviderObjectDisposition(crossCheck);
    expect(crossCheckResult.ok).toBe(false);
    expect(crossCheckResult.errors).toContainEqual(
      expect.objectContaining({ code: "DECIDED_CORRELATION_INVALID", class: "stripe-account-session" }),
    );

    const countThree = withFreshDigest(patchClass(VALID_SUCCESS, "stripe-account-session", { observedCount: 3 }));
    const countThreeResult = validateProviderObjectDisposition(countThree);
    expect(countThreeResult.ok).toBe(false);
    expect(countThreeResult.errors).toContainEqual(
      expect.objectContaining({ code: "B1_BUDGET_EXCEEDED_IN_SUCCESS", class: "stripe-account-session" }),
    );

    const selfExpiry = withFreshDigest(
      patchClass(VALID_SUCCESS, "stripe-account-session", { state: "self-expiring-proven" }),
    );
    expect(validateProviderObjectDisposition(selfExpiry).ok).toBe(false);

    const probeDigest = withFreshDigest(
      patchClass(VALID_SUCCESS, "stripe-account-session", { probeReceiptDigest: "a".repeat(64) }),
    );
    expect(validateProviderObjectDisposition(probeDigest).ok).toBe(false);

    // Omission mutant / source assertion: no schema path can assert
    // self-expiry or a provider-enumeration branch for class 6.
    expect(ACCOUNT_SESSION_AUTHORITY_POINTER).toBe("infrastructure/stripe-connect/index.ts:907");
    const validatorSource = readFileSync(
      fileURLToPath(new URL("./validate-provider-object-disposition.mjs", import.meta.url)),
      "utf8",
    );
    expect(validatorSource).toContain("infrastructure/stripe-connect/index.ts:907");
    expect(validatorSource).not.toMatch(/self-expiring-proven/);
  });
});

describe("canonicalizes and digests v1 deterministically", () => {
  it("produces byte-for-byte golden equality and uses the fixed domain prefix", () => {
    expect(RESULT_DIGEST_DOMAIN_PREFIX).toBe("provider-object-disposition/v1\n");

    const docA = VALID_SUCCESS;
    const docB = Object.fromEntries(Object.entries(clone(VALID_SUCCESS)).reverse());
    expect(canonicalizeProviderObjectDisposition(docA).equals(canonicalizeProviderObjectDisposition(docB))).toBe(true);
    expect(computeResultDigest(docA)).toBe(computeResultDigest(docB));

    const changed = clone(VALID_SUCCESS);
    changed.windowId = "00000000000000000000000000000000".slice(0, 32);
    expect(computeResultDigest(changed)).not.toBe(computeResultDigest(VALID_SUCCESS));

    // BOM / trailing newline still refuse at this layer too.
    expect(validateProviderObjectDispositionBytes(toBytes(VALID_SUCCESS, { bom: true })).ok).toBe(false);
    expect(validateProviderObjectDispositionBytes(toBytes(VALID_SUCCESS, { trailingNewline: true })).ok).toBe(false);

    // Digest computed without blanking resultDigest refuses.
    const broken = clone(VALID_SUCCESS);
    const brokenBytes = Buffer.from(JSON.stringify(sortKeysByCodeUnit(broken)), "utf8");
    const brokenDigest = createHash("sha256")
      .update(Buffer.from(RESULT_DIGEST_DOMAIN_PREFIX, "utf8"))
      .update(brokenBytes)
      .digest("hex");
    broken.resultDigest = brokenDigest;
    const brokenResult = validateProviderObjectDisposition(broken);
    expect(brokenResult.ok).toBe(false);
    expect(brokenResult.errors).toContainEqual(expect.objectContaining({ code: "RESULT_DIGEST_MISMATCH" }));
  });
});

describe("rejects identifier and diagnostic channels", () => {
  it("refuses every provider-shaped or diagnostic marker and proves the detector actually fires", () => {
    const markers = [
      "pi_SYNTHETIC_6733",
      "seti_SYNTHETIC_6733",
      "cs_SYNTHETIC_6733",
      "cus_SYNTHETIC_6733",
      "acct_SYNTHETIC_6733",
      "Exception: SYNTHETIC_6733 boom",
      "client_secret_SYNTHETIC_6733",
    ];
    for (const marker of markers) {
      expect(containsForbiddenProviderMarker(marker), marker).toBe(true);
      const doc = { ...clone(VALID_SUCCESS), windowId: marker };
      const result = validateProviderObjectDisposition(doc);
      expect(result.ok, marker).toBe(false);
      expect(result.errors.some((e) => e.code === "FORBIDDEN_PROVIDER_MARKER")).toBe(true);
    }

    // Detector negative control: a benign enum value never trips it.
    expect(containsForbiddenProviderMarker("cancelled")).toBe(false);
    expect(containsForbiddenProviderMarker("creation-time-record")).toBe(false);

    // Shape audit (source assertion): every string-typed schema property
    // must declare enum/const/pattern/format — no unconstrained free-text
    // field can exist for a marker to hide in.
    const violations = [];
    const auditStringFieldsClosed = (node, path) => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => auditStringFieldsClosed(item, `${path}[${i}]`));
        return;
      }
      const typeIsString = node.type === "string" || (Array.isArray(node.type) && node.type.includes("string"));
      if (typeIsString && !("enum" in node) && !("const" in node) && !("pattern" in node) && !("format" in node)) {
        violations.push(path);
      }
      for (const [key, value] of Object.entries(node)) {
        auditStringFieldsClosed(value, `${path}.${key}`);
      }
    };
    auditStringFieldsClosed(SCHEMA, "$");
    expect(violations).toEqual([]);
  });
});

describe("derives the Option B terminal fixture once", () => {
  it("has exactly six ordered rows, validates every scenario, and is the sole source of the class table", () => {
    const fixture = JSON.parse(FIXTURE_RAW);
    expect(fixture.classTable.map((row) => row.class)).toEqual([
      "captured-payment-intent",
      "uncaptured-payment-intent",
      "setup-intent",
      "stripe-checkout-session",
      "stripe-customer",
      "stripe-account-session",
    ]);
    expect(fixture.classTable).toHaveLength(6);

    const scenarioNames = Object.keys(fixture.scenarios);
    expect(scenarioNames).toEqual([
      "success",
      "preNetworkRefusal",
      "partialEffectCompleteCleanup",
      "ambiguousUnknown",
      "postNetworkFailureLaterNotAttempted",
      "cleanupFailureAtPrecedenceBoundary",
      "cleanupFailureOverBudget",
    ]);
    for (const [name, doc] of Object.entries(fixture.scenarios)) {
      const result = validateProviderObjectDisposition(doc);
      expect(result.ok, `${name}: ${JSON.stringify(result.errors)}`).toBe(true);
    }

    // No residueUnknown field or pre-selection option row anywhere in the fixture.
    expect(FIXTURE_RAW).not.toContain("residueUnknown");
    expect(FIXTURE_RAW).not.toContain("self-expiring");
    expect(FIXTURE_RAW).not.toContain("probeReceiptDigest");

    // Source census: no .mjs file in this directory hardcodes a second copy
    // of the class table (a distinctive budgetScope literal that only the
    // fixture may declare).
    const mjsFiles = readdirSync(DIR).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
    let occurrences = 0;
    for (const file of mjsFiles) {
      const source = readFileSync(`${DIR}${file}`, "utf8");
      if (source.includes("per-confirmation-window")) occurrences += 1;
    }
    expect(occurrences).toBe(0);
  });
});

describe("qualifies only complete v1 payloads", () => {
  it("requires validator success plus a correct digest before a payload counts as publishable", () => {
    const validResult = qualifiesForPublicationV1(toBytes(VALID_SUCCESS));
    expect(validResult.ok, JSON.stringify(validResult.errors)).toBe(true);

    // Schema-only directory / missing payload.
    expect(qualifiesForPublicationV1(undefined).ok).toBe(false);
    expect(qualifiesForPublicationV1(null).ok).toBe(false);
    expect(qualifiesForPublicationV1(Buffer.alloc(0)).ok).toBe(false);

    // Malformed payload.
    const malformedResult = qualifiesForPublicationV1(Buffer.from("{not json", "utf8"));
    expect(malformedResult.ok).toBe(false);

    // Predecessor-with-fabricated-fields: a stale pre-Decision shape cannot
    // be upgraded into v1 by adding fields v1 never declared.
    const predecessor = withFreshDigest({
      ...clone(VALID_SUCCESS),
      classes: clone(VALID_SUCCESS).classes.map((entry, index) =>
        index === CLASS_ORDER.indexOf("stripe-account-session") ? { ...entry, residueUnknown: false } : entry,
      ),
    });
    const predecessorResult = qualifiesForPublicationV1(toBytes(predecessor));
    expect(predecessorResult.ok).toBe(false);
  });
});

describe("uses Payments disposition terms", () => {
  it("registers the four #6733 terms and distinguishes Stripe Checkout Session from the product checkout session", () => {
    const glossary = readFileSync(GLOSSARY_PATH, "utf8");
    for (const heading of [
      "## Provider Object Class",
      "## Provider Object Disposition",
      "## Residue Budget",
      "## Disposition Terminal",
      "## Stripe Checkout Session",
    ]) {
      expect(glossary.split(heading)).toHaveLength(2);
    }
    // Preserved terms.
    expect(glossary).toContain("## Provider Customer");
    expect(glossary).toContain("## Payment Intent");
    // Distinguishes the product checkout session from the Stripe object.
    expect(glossary).toContain("product checkout session");
    expect(glossary).toContain("`cs_`");
  });
});

describe("requires authoritative Stripe test mode", () => {
  it("qualifies only the authority-bound test value and never infers it", () => {
    expect(validateProviderObjectDisposition(VALID_SUCCESS).ok).toBe(true);
    expect(PROVIDER_MODE_AUTHORITY_NOTE).toContain("#6726");
    expect(PROVIDER_MODE_AUTHORITY_NOTE).toContain("#6734");

    const missingMode = clone(VALID_SUCCESS);
    delete missingMode.providerMode;
    const missingModeResult = validateProviderObjectDisposition(missingMode);
    expect(missingModeResult.ok).toBe(false);
    expect(missingModeResult.errors).toContainEqual(
      expect.objectContaining({ code: "TOP_LEVEL_KEY_MISSING", path: "$.providerMode" }),
    );

    for (const badValue of ["live", "unknown", "", "TEST"]) {
      const doc = withFreshDigest({ ...clone(VALID_SUCCESS), providerMode: badValue });
      const result = validateProviderObjectDisposition(doc);
      expect(result.ok, `providerMode ${badValue}`).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "PROVIDER_MODE_NOT_AUTHORITATIVE_TEST" }));
    }

    // Omission mutant: infer test mode from a staging deploymentEnvironment.
    const stagingNoMode = clone(VALID_SUCCESS);
    stagingNoMode.deploymentEnvironment = "staging";
    delete stagingNoMode.providerMode;
    const stagingResult = validateProviderObjectDisposition(stagingNoMode);
    expect(stagingResult.ok).toBe(false);
    expect(stagingResult.errors.some((e) => e.code === "TOP_LEVEL_KEY_MISSING" && e.path === "$.providerMode")).toBe(
      true,
    );
  });
});

describe("provider-object-disposition/v1 shared fixture and refusal/failure vocabularies", () => {
  it("keeps the closed refusal and failure code sets exactly as specified", () => {
    expect([...REFUSAL_CODES].sort()).toEqual(
      ["invalid-input", "production-environment", "authority-unavailable", "journal-unavailable"].sort(),
    );
    expect([...FAILURE_CODES].sort()).toEqual(
      [
        "transport-failure",
        "provider-rejected",
        "provider-response-invalid",
        "correlation-discrepancy",
        "enumeration-incomplete",
        "budget-exceeded",
        "cleanup-incomplete",
      ].sort(),
    );
  });

  it("rejects raw bytes that are not even parseable JSON", () => {
    const result = parseRawDocumentBytes(Buffer.from("not json at all", "utf8"));
    expect(result.ok).toBe(false);
  });
});
